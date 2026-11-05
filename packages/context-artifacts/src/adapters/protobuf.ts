/**
 * Protobuf adapter (architecture.md §20: "Messages, Services, RPCs").
 *
 * Brace-depth line scanning (no full grammar needed): a top-level
 * (depth-0) `message Foo {` or `service Foo {` opens a block that runs to
 * its matching `}`. Nested `message`s inside another message are part of
 * the parent's content (not chunked separately — a deliberate scope limit,
 * see README "Entscheidungen"; their bytes are still fully present in the
 * parent chunk's content, so nothing is silently dropped). Inside a
 * `service` block, each `rpc Name(...) returns (...);` additionally gets
 * its own finer-grained chunk — intentionally OVERLAPPING the enclosing
 * service chunk's range, so a search hit on one RPC's name returns a tight
 * chunk while a hit on shared service-level comments/options still returns
 * full context.
 *
 * The brace counter is string/comment-aware (WP-81 review finding: a `{` or
 * `}` inside a string default value, e.g. `[default = "{"]`, or inside a
 * `//`/`/* *\/` comment, must never move the depth counter — a naive raw
 * count desyncs PERMANENTLY on such a line, degrading "runs to EOF" and
 * silently swallowing every following top-level block). `scanLine` below
 * carries string/block-comment state across lines through ONE continuous
 * scan (a single shared `ScanState`, not a fresh one per block) — depth is
 * tracked exactly once per line, not once in this function and again in a
 * separate look-ahead, so there is only one source of truth for "are we
 * inside a string/comment right now" across the whole file.
 */
import type {
  ArtifactAdapter,
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ArtifactLink,
} from "@untangle-code/domain";

import type { DelimiterScanOptions } from "../text/delimiter-balance.js";
import { describeDelimiterImbalances, findDelimiterImbalances } from "../text/delimiter-balance.js";
import { buildLineIndex, splitLines } from "../text/line-index.js";

import type { ChunkDraft, ChunkPlausibilityCheck, SkipLedgerReporter } from "./shared.js";
import { buildChunks, buildChunksReportingSkips, buildDocuments } from "./shared.js";

const PROTO_EXTENSION = /\.proto$/i;
const MESSAGE_RE = /^\s*message\s+([\w.]+)\s*\{/;
const SERVICE_RE = /^\s*service\s+([\w.]+)\s*\{/;
const RPC_RE = /^\s*rpc\s+(\w+)\s*\(/;

/** Cross-line scanner state: which of a string literal / block comment (if any) the scan is currently inside. */
interface ScanState {
  inSingle: boolean;
  inDouble: boolean;
  inBlockComment: boolean;
}

/**
 * Net brace delta for one line, skipping `'...'`/`"..."` string literals
 * (with `\`-escapes) and `//`/`/* *\/` comments, so a brace character
 * inside either never affects depth. `state` is mutated in place for
 * anything that spans past this line's end (an unterminated string or an
 * open block comment) — the NEXT call for the following line continues
 * from exactly that state, which is what makes the counter immune to
 * per-line resets.
 */
function scanLine(line: string, state: ScanState): number {
  let delta = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (c === "*" && next === "/") {
        state.inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (state.inSingle) {
      if (c === "\\") {
        i += 1;
      } else if (c === "'") {
        state.inSingle = false;
      }
      continue;
    }
    if (state.inDouble) {
      if (c === "\\") {
        i += 1;
      } else if (c === '"') {
        state.inDouble = false;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      break; // line comment: rest of the line is never code, and cannot itself open a block comment
    }
    if (c === "/" && next === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === "'") {
      state.inSingle = true;
      continue;
    }
    if (c === '"') {
      state.inDouble = true;
      continue;
    }
    if (c === "{") delta += 1;
    else if (c === "}") delta -= 1;
  }
  return delta;
}

/**
 * Letzte Zeile einer `rpc`-Deklaration.
 *
 * Zwei Formen: die Kurzform endet an ihrem `;` (das bei mehrzeiliger
 * Signatur erst auf einer späteren Zeile steht), die Langform an der
 * schließenden `}` ihres Optionsrumpfs. WP-118: bisher wurde nur die erste
 * Form erkannt, also endete `rpc A(X) returns (Y) {` schon an der ersten
 * `;` IM RUMPF — mitten im Konstrukt, mit fehlender schließender Klammer,
 * und ohne Ledger-Eintrag, weil die Range des Service-Chunks alles
 * abdeckte. Der Klammerstand wird deshalb mitgezählt.
 */
function findRpcEnd(lines: string[], startIndex: number, hardLimit: number): number {
  const state: ScanState = { inSingle: false, inDouble: false, inBlockComment: false };
  let depth = 0;
  for (let i = startIndex; i < hardLimit; i += 1) {
    const line = lines[i] ?? "";
    const depthBefore = depth;
    depth += scanLine(line, state);
    if (depthBefore > 0 && depth === 0) return i + 1; // Optionsrumpf geschlossen
    if (depthBefore === 0 && depth === 0 && (line.includes(";") || line.includes("}")))
      return i + 1;
  }
  return hardLimit;
}

/** Pushes `pending`'s finished draft (and, for a service, its nested RPC drafts scanned from its now-final range) into `drafts`. */
function finalizePendingBlock(
  drafts: ChunkDraft[],
  lines: string[],
  pending: { kind: "protobuf_message" | "protobuf_service"; title: string; startLine: number },
  endLine: number,
): void {
  drafts.push({ kind: pending.kind, startLine: pending.startLine, endLine, title: pending.title });
  if (pending.kind !== "protobuf_service") return;
  for (let j = pending.startLine - 1; j < endLine; j += 1) {
    const rpc = RPC_RE.exec(lines[j] ?? "");
    if (rpc) {
      const rpcEnd = findRpcEnd(lines, j, endLine);
      drafts.push({
        kind: "protobuf_rpc",
        startLine: j + 1,
        endLine: rpcEnd,
        title: `${pending.title}.${rpc[1]!}`,
      });
    }
  }
}

function protobufDrafts(lines: string[]): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  const state: ScanState = { inSingle: false, inDouble: false, inBlockComment: false };
  let depth = 0;
  let pending:
    { kind: "protobuf_message" | "protobuf_service"; title: string; startLine: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (depth === 0 && pending === undefined) {
      const message = MESSAGE_RE.exec(line);
      const service = SERVICE_RE.exec(line);
      if (message) {
        pending = { kind: "protobuf_message", title: message[1]!, startLine: i + 1 };
      } else if (service) {
        pending = { kind: "protobuf_service", title: service[1]!, startLine: i + 1 };
      }
    }
    depth += scanLine(line, state);
    if (pending !== undefined && depth === 0) {
      finalizePendingBlock(drafts, lines, pending, i + 1);
      pending = undefined;
    }
  }
  if (pending !== undefined) {
    // Unterminated top-level block (malformed source, or a still-open
    // string/comment at EOF): degrade to "runs to EOF" rather than
    // dropping it — never silently, see the module doc.
    finalizePendingBlock(drafts, lines, pending, Math.max(lines.length, pending.startLine));
  }
  return drafts;
}

/**
 * Trennzeichen-Konventionen für die Plausibilitätsprüfung (WP-118).
 * Zeichenketten dürfen keine Zeile überschreiten — ein Anführungszeichen,
 * das bis zum Zeilenende offen bleibt, ist in Protobuf bereits ein Befund.
 */
const PROTOBUF_SCAN_OPTIONS: DelimiterScanOptions = {
  quotes: [
    { open: "'", close: "'", backslashEscapes: true, doubledEscapes: false, spansLines: false },
    { open: '"', close: '"', backslashEscapes: true, doubledEscapes: false, spansLines: false },
  ],
  brackets: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: "[", close: "]" },
  ],
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/" },
};

/**
 * WP-118 (dieselbe Blindstelle wie in `sql.ts`): der Blockzähler dieses
 * Adapters degradiert einen unabgeschlossenen Top-Level-Block zu „läuft
 * bis Dateiende". Die Byte-Abdeckung bleibt dabei lückenlos, der Chunk ist
 * weder leer noch überlappend — der Ledger sah also NICHTS, obwohl der
 * Blockzähler nachweislich aus dem Tritt geraten war. Ein Fragment mit
 * offener Klammer, offener Zeichenkette oder offenem Kommentar ist jetzt
 * ein Befund.
 */
const checkProtobufPlausibility: ChunkPlausibilityCheck = (chunk) => {
  const imbalances = findDelimiterImbalances(chunk.content, PROTOBUF_SCAN_OPTIONS);
  return imbalances.length === 0 ? undefined : describeDelimiterImbalances(imbalances);
};

function messageName(chunk: ArtifactChunk): string | undefined {
  return chunk.kind === "protobuf_service" ? chunk.title : undefined;
}

export interface ProtobufAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createProtobufAdapter(options: ProtobufAdapterOptions = {}): ArtifactAdapter {
  return {
    supports(type: string, path: string): boolean {
      return type === "protobuf" || (type === "auto" && PROTO_EXTENSION.test(path));
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "protobuf");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      const { lines } = splitLines(document.content);
      const index = buildLineIndex(document.content);
      return buildChunksReportingSkips(
        document,
        index,
        protobufDrafts(lines),
        options.onSkipLedgerGap,
        checkProtobufPlausibility,
      );
    },

    /**
     * Heuristic (architecture.md §20): a gRPC service `FooService` often
     * backs a generated/handwritten server symbol named `FooServiceServer`
     * or `FooServiceImpl`. Both are offered as separate low-confidence
     * hints — this is a naming guess, not a resolved reference.
     */
    links(document: ArtifactDocument): ArtifactLink[] {
      const { lines } = splitLines(document.content);
      const index = buildLineIndex(document.content);
      const chunks = buildChunks(document, index, protobufDrafts(lines));
      const links: ArtifactLink[] = [];
      for (const chunk of chunks) {
        const name = messageName(chunk);
        if (name === undefined) continue;
        for (const suffix of ["Server", "Impl"]) {
          links.push({
            fromChunkId: chunk.chunkId,
            targetKind: "symbol",
            targetName: `${name}${suffix}`,
            heuristic: true,
            confidence: 0.3,
            note: `naming-convention guess: gRPC service "${name}" → generated/handwritten server symbol`,
          });
        }
      }
      return links;
    },
  };
}
