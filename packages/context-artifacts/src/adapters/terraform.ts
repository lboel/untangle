/**
 * Terraform/HCL adapter (architecture.md §20: "Ressourcen, Module,
 * Variablen").
 *
 * Same brace-depth line scanning approach as the Protobuf adapter: a
 * top-level `resource "type" "name" {`, `data "type" "name" {`, `module
 * "name" {`, `variable "name" {`, `output "name" {`, `provider "name" {`,
 * or `locals {` block runs to its matching `}`. Whitespace/comments
 * between blocks are not chunked — `buildArtifactSkipLedger` surfaces
 * those gaps with reason `"whitespace_or_comment"`, never silently.
 *
 * The brace counter skips `"..."` string literals, `#`/`//`/`/* *\/`
 * comments and heredoc bodies (`<<EOT` … `EOT`, WP-118) (WP-81 review, same defect class as the Protobuf adapter's own
 * fix: a `{`/`}` inside a multi-line `/* *\/` comment must never move the
 * depth counter, or it desyncs permanently and "runs to EOF", silently
 * swallowing every following top-level block). `scanLine` carries the
 * open-block-comment state across lines through one continuous scan — the
 * SAME scan that finds block boundaries, not a separate look-ahead with its
 * own independent counter, so there is exactly one source of truth for "is
 * this brace really code right now".
 *
 * KNOWN, UNFIXED gap in the same defect class (documented, not silent):
 * `BLOCK_PATTERNS` match against a full physical LINE (`^\s*keyword...`), so
 * two block openers sharing one physical line (`resource "a" "b" {} module
 * "m" {}`) — valid but extremely unidiomatic HCL that `terraform fmt` would
 * never produce — only detects the first; the second's bytes still land
 * inside the first block's `content` (nothing is dropped from the document,
 * only mis-titled), rather than getting its own chunk. Fixing this fully
 * would need the same byte-precise, sub-line splitting the SQL adapter now
 * uses for multiple statements per line; left as an open issue given how
 * rare well-formed HCL makes this shape.
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
import { buildChunksReportingSkips, buildDocuments } from "./shared.js";

const TERRAFORM_EXTENSION = /\.(tf|tf\.json|hcl)$/i;

interface BlockPattern {
  kind: string;
  re: RegExp;
  title: (match: RegExpExecArray) => string;
}

const BLOCK_PATTERNS: BlockPattern[] = [
  {
    kind: "terraform_resource",
    re: /^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/,
    title: (m) => `${m[1]!}.${m[2]!}`,
  },
  {
    kind: "terraform_data",
    re: /^\s*data\s+"([^"]+)"\s+"([^"]+)"\s*\{/,
    title: (m) => `${m[1]!}.${m[2]!}`,
  },
  { kind: "terraform_module", re: /^\s*module\s+"([^"]+)"\s*\{/, title: (m) => m[1]! },
  { kind: "terraform_variable", re: /^\s*variable\s+"([^"]+)"\s*\{/, title: (m) => m[1]! },
  { kind: "terraform_output", re: /^\s*output\s+"([^"]+)"\s*\{/, title: (m) => m[1]! },
  { kind: "terraform_provider", re: /^\s*provider\s+"([^"]+)"\s*\{/, title: (m) => m[1]! },
  { kind: "terraform_locals", re: /^\s*locals\s*\{/, title: () => "locals" },
];

/**
 * Öffner eines Heredocs (`<<EOT` / `<<-EOT`); die Gruppe ist die Endmarke.
 * Sticky, damit er an einer Position geprüft werden kann, ohne die Zeile zu
 * kopieren.
 */
const HEREDOC_OPEN = /<<-?([A-Za-z_][A-Za-z0-9_]*)/y;

/** Cross-line scanner state: whether the scan is currently inside an open `/* *\/` block comment or heredoc. */
interface ScanState {
  inBlockComment: boolean;
  /** Endmarke des offenen Heredocs, sonst `undefined`. */
  heredocTag: string | undefined;
}

/**
 * Net brace delta for one line, skipping `"..."` string literals and
 * `#`/`//`/`/* *\/` comments. `state.inBlockComment` is mutated for a
 * comment that is still open at the end of this line — the next call for
 * the following line continues from exactly that state. String state is
 * NOT carried across lines: an HCL double-quoted string cannot contain a
 * literal newline (only `\n` escapes), so it is always fully open and
 * closed within one physical line.
 */
function scanLine(line: string, state: ScanState): number {
  // WP-118: Ein Heredoc ist ROHTEXT. Ein `{` in einem eingebetteten
  // Shell-Skript (`user_data = <<-EOT ... EOT`) hat den Klammerzähler
  // bisher dauerhaft verschoben — der laufende Block „lief bis Dateiende"
  // und verschluckte jeden folgenden Top-Level-Block, bei lückenloser
  // Byte-Abdeckung und damit ohne einen einzigen Ledger-Eintrag. Genau
  // dieselbe Blindstelle wie die des SQL-Zerlegers, nur mit anderem
  // Auslöser.
  if (state.heredocTag !== undefined) {
    if (line.trim() === state.heredocTag) state.heredocTag = undefined;
    return 0;
  }
  let delta = 0;
  let inDouble = false;
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
    if (inDouble) {
      if (c === '"' && line[i - 1] !== "\\") inDouble = false;
      continue;
    }
    if (c === "#" || (c === "/" && next === "/")) break; // line comment: rest of the line is never code
    if (c === "/" && next === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "<" && next === "<") {
      HEREDOC_OPEN.lastIndex = i;
      const heredoc = HEREDOC_OPEN.exec(line);
      if (heredoc !== null) {
        state.heredocTag = heredoc[1]!;
        return delta; // alles hinter dem Öffner gehört zum Heredoc-Inhalt
      }
    }
    if (c === "{") delta += 1;
    else if (c === "}") delta -= 1;
  }
  return delta;
}

function terraformDrafts(lines: string[]): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  const state: ScanState = { inBlockComment: false, heredocTag: undefined };
  let depth = 0;
  let pending: { kind: string; title: string; startLine: number } | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (
      depth === 0 &&
      pending === undefined &&
      !state.inBlockComment &&
      state.heredocTag === undefined
    ) {
      for (const pattern of BLOCK_PATTERNS) {
        const match = pattern.re.exec(line);
        if (match) {
          pending = { kind: pattern.kind, title: pattern.title(match), startLine: i + 1 };
          break;
        }
      }
    }
    depth += scanLine(line, state);
    if (pending !== undefined && depth === 0) {
      drafts.push({
        kind: pending.kind,
        startLine: pending.startLine,
        endLine: i + 1,
        title: pending.title,
      });
      pending = undefined;
    }
  }
  if (pending !== undefined) {
    // Unterminated top-level block (malformed source, or a still-open
    // block comment at EOF): degrade to "runs to EOF" rather than dropping
    // it — never silently, see the module doc.
    drafts.push({
      kind: pending.kind,
      startLine: pending.startLine,
      endLine: Math.max(lines.length, pending.startLine),
      title: pending.title,
    });
  }
  return drafts;
}

/**
 * Trennzeichen-Konventionen für die Plausibilitätsprüfung (WP-118).
 * Heredocs (`<<EOF` / `<<-EOF`) sind Rohtext: eingebettete Skripte
 * enthalten regelmäßig unpaarige Klammern und Anführungszeichen, die kein
 * Befund sind. Der Prüfer überliest sie deshalb vollständig — und meldet
 * dafür ein Heredoc, dessen Endmarke im Fragment fehlt.
 */
const TERRAFORM_SCAN_OPTIONS: DelimiterScanOptions = {
  quotes: [
    { open: '"', close: '"', backslashEscapes: true, doubledEscapes: false, spansLines: false },
  ],
  brackets: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: "[", close: "]" },
  ],
  lineComments: ["#", "//"],
  blockComment: { open: "/*", close: "*/" },
  heredocs: "hcl",
};

/**
 * WP-118 (dieselbe Blindstelle wie in `sql.ts`): ein unabgeschlossener
 * Top-Level-Block wurde bisher still zu „läuft bis Dateiende" degradiert —
 * lückenlose Byte-Abdeckung, kein leerer Chunk, also kein Ledger-Eintrag,
 * obwohl der Klammerzähler nachweislich aus dem Tritt war. Dasselbe gilt
 * für ein Heredoc, dessen `{` den Zähler verschoben hat (der Zähler dieses
 * Adapters kennt Heredocs nicht). Beides ist jetzt ein sichtbarer Befund.
 */
const checkTerraformPlausibility: ChunkPlausibilityCheck = (chunk) => {
  const imbalances = findDelimiterImbalances(chunk.content, TERRAFORM_SCAN_OPTIONS);
  return imbalances.length === 0 ? undefined : describeDelimiterImbalances(imbalances);
};

export interface TerraformAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createTerraformAdapter(options: TerraformAdapterOptions = {}): ArtifactAdapter {
  return {
    supports(type: string, path: string): boolean {
      return type === "terraform" || (type === "auto" && TERRAFORM_EXTENSION.test(path));
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "terraform");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      const { lines } = splitLines(document.content);
      const index = buildLineIndex(document.content);
      return buildChunksReportingSkips(
        document,
        index,
        terraformDrafts(lines),
        options.onSkipLedgerGap,
        checkTerraformPlausibility,
      );
    },

    links(): ArtifactLink[] {
      return [];
    },
  };
}
