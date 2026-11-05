/**
 * Skip ledger (docs/BUILD_PLAN.md §12 E4: "KEIN stilles Ueberspringen von
 * Inhalt — Skip-Ledger mit Grund").
 *
 * `ArtifactChunk`/`ArtifactAdapter` (architecture.md §20, frozen in
 * `@untangle-code/domain`) carry no ledger field of their own — chunk
 * ranges are the only signal a caller has about what was turned into a
 * searchable chunk. `buildArtifactSkipLedger()` is this package's answer to
 * E4 within that contract: given a document and the chunks an adapter
 * produced for it, it finds every byte range NOT covered by any chunk and
 * returns it as a labeled entry, so a caller (indexer/CLI) can log or
 * surface "artifact X, bytes N..M were not turned into a chunk, because
 * Y" — visibly, with a reason, never silently.
 *
 * A gap is not automatically a defect: whitespace between two SQL
 * statements, or a comment line between two Terraform blocks, is expected
 * and labeled `"whitespace_or_comment"`. A gap that still contains
 * non-trivial content is labeled `"unclassified_content"` — a signal that
 * an adapter's section boundaries missed something real.
 *
 * Byte coverage alone is BLIND to one real defect class (found in review of
 * WP-81): an adapter can produce chunks whose union of byte ranges looks
 * complete while a real section's identity was still lost — e.g. two SQL
 * statements sharing one physical line, where a broken span computation
 * attributed BOTH statements' bytes to the first statement's chunk and then
 * emitted a second, byte-EMPTY chunk for the one that lost its own range.
 * That second chunk carries no gap (there are no uncovered bytes left to
 * report) yet is definitive proof that the adapter detected a section
 * boundary and then failed to capture anything for it — a section was
 * found, not classified.
 *
 * This module cannot re-parse an arbitrary format to notice that kind of
 * loss (coverage.ts is intentionally format-agnostic — it only ever sees
 * `ArtifactChunk[]`, never an adapter's own grammar). What it CAN check,
 * generically and with zero false positives, is the structural invariant
 * every legitimate chunk must satisfy: a non-empty, non-inverted byte range
 * (`range.endByte > range.startByte`), and — when two chunks claim the
 * EXACT same byte range — agreement on what that range even is (same
 * `kind`+`title`; protobuf's intentionally nested service/RPC overlap never
 * trips this, since an RPC's range is a strict sub-range of its service's,
 * never byte-identical to it). Either violation is reported as
 * `"semantic_loss"`: content IS covered by some chunk, but a section the
 * adapter itself tried to carve out was not actually captured or was
 * captured twice with conflicting identities.
 *
 * WP-118 fand die dritte Blindstelle derselben Familie: nichts fehlt,
 * nichts ist leer, nichts überlappt — aber ein Fragment ist MITTEN DURCH
 * ein Konstrukt geschnitten (die SQL-Zerlegung zerriss ein Statement an
 * einem Semikolon INNERHALB einer Zeichenkette). Das kann dieses Modul
 * nicht selbst erkennen, weil ihm dafür die Konventionen des Formats
 * fehlen. Es nimmt sie deshalb als Rückruf entgegen:
 * `buildArtifactSkipLedger(document, chunks, { checkPlausibility })`
 * meldet jedes so beanstandete Fragment als `"implausible_fragment"`.
 * Die Adapter reichen ihre eigene Prüfung über
 * `adapters/shared.ts::buildChunksReportingSkips` herein, damit auch das
 * keine Bringschuld des Aufrufers wird (E4).
 */
import type { ArtifactChunk, ArtifactDocument, SourceRange } from "@untangle-code/domain";

import { buildLineIndex, lineNumberForByte, type LineIndex } from "./text/line-index.js";

export type ArtifactSkipReason =
  "whitespace_or_comment" | "unclassified_content" | "semantic_loss" | "implausible_fragment";

export interface ArtifactSkipLedgerEntry {
  artifactName: string;
  /** "/"-normalized document path. */
  path: string;
  range: SourceRange;
  reason: ArtifactSkipReason;
  /** First 200 chars of the skipped content, for a human reviewing the ledger. */
  contentPreview: string;
}

/**
 * Callback invoked with the actionable (non-`"whitespace_or_comment"`)
 * entries of a document's skip ledger, from the NORMAL `chunk()` path (see
 * `adapters/shared.ts`'s `buildChunksReportingSkips` — every built-in
 * adapter's `chunk()` goes through it, so this fires without a caller ever
 * having to call `buildArtifactSkipLedger` separately, BUILD_PLAN §12 E4).
 */
export type SkipLedgerReporter = (
  entries: readonly ArtifactSkipLedgerEntry[],
  document: ArtifactDocument,
) => void;

/**
 * Default `SkipLedgerReporter`: one JSON-lines-shaped warning per entry on
 * `stderr`. Deliberately dependency-free (no `@untangle-code/observability`
 * `Logger` — that requires an injected `Clock` and isn't available to a
 * bare `create*Adapter()` factory call) so a loss is visible out of the box;
 * a caller with a real structured logger passes its own `onSkipLedgerGap`
 * to any `create*Adapter()`/`createArtifactAdapterRegistry()` instead.
 */
export const defaultSkipLedgerReporter: SkipLedgerReporter = (entries, document) => {
  for (const entry of entries) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        event: "context_artifact_skip_ledger_gap",
        artifactName: document.artifactName,
        path: entry.path,
        range: entry.range,
        reason: entry.reason,
        contentPreview: entry.contentPreview,
      })}\n`,
    );
  }
};

const PREVIEW_LENGTH = 200;

/**
 * Strips full-line `#`/`--`/`//` comments and any `/* *\/` block comment
 * (which may itself span several lines — stripped whole, before the
 * per-line check, precisely so a gap that is JUST a multi-line block
 * comment — e.g. between two Terraform resources — is recognized as
 * benign) so a comment-only gap is classified `"whitespace_or_comment"`,
 * never `"unclassified_content"`.
 */
function isWhitespaceOrCommentOnly(text: string): boolean {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlockComments.split("\n").every((line) => /^\s*(#.*|--.*|\/\/.*)?\s*$/.test(line));
}

function classify(content: string): ArtifactSkipReason {
  return isWhitespaceOrCommentOnly(content) ? "whitespace_or_comment" : "unclassified_content";
}

/**
 * Prüft EIN fertiges Fragment auf Sinnhaftigkeit und liefert bei einem
 * Befund den Begründungstext, sonst `undefined` (WP-118).
 *
 * Byte-Abdeckung beantwortet nur „fehlt etwas?"; sie ist blind dafür, ob
 * ein Fragment an einer sinnvollen Stelle endet. Genau diese zweite Frage
 * kann `coverage.ts` nicht selbst beantworten — sie braucht die
 * Konventionen des jeweiligen Formats. Der zuständige Adapter reicht sie
 * deshalb als Funktion herein (`adapters/sql.ts`, `adapters/protobuf.ts`,
 * `adapters/terraform.ts` nutzen dafür `text/delimiter-balance.ts`),
 * während dieses Modul format-agnostisch bleibt.
 */
export type ChunkPlausibilityCheck = (chunk: ArtifactChunk) => string | undefined;

export interface ArtifactSkipLedgerOptions {
  /** Siehe {@link ChunkPlausibilityCheck}. Ohne diese Option verhält sich der Ledger wie vor WP-118. */
  readonly checkPlausibility?: ChunkPlausibilityCheck;
}

/**
 * Finds every byte range of `document.content` not covered by any of
 * `chunks`' ranges and returns one labeled ledger entry per gap.
 *
 * Overlapping/out-of-order chunk ranges (e.g. Protobuf's intentionally
 * overlapping service/RPC chunks, see the protobuf adapter's
 * "Entscheidungen" entry) are handled correctly: ranges are merged before
 * gaps are computed, so an RPC chunk nested inside its service chunk never
 * produces a spurious gap either side of it.
 */
export function buildArtifactSkipLedger(
  document: ArtifactDocument,
  chunks: readonly ArtifactChunk[],
  options: ArtifactSkipLedgerOptions = {},
): ArtifactSkipLedgerEntry[] {
  const index = buildLineIndex(document.content);
  const buffer = index.buffer;
  const totalBytes = buffer.length;

  const semanticLossEntries = findSemanticLossEntries(document, index, chunks);
  const plausibilityEntries = findImplausibleFragmentEntries(
    document,
    chunks,
    options.checkPlausibility,
  );

  if (totalBytes === 0) {
    return [...semanticLossEntries, ...plausibilityEntries];
  }

  const sortedSpans = chunks
    .map((chunk): [number, number] => [chunk.range.startByte, chunk.range.endByte])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const [start, end] of sortedSpans) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const gapEntries: ArtifactSkipLedgerEntry[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      gapEntries.push(buildEntry(document, index, cursor, start));
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < totalBytes) {
    gapEntries.push(buildEntry(document, index, cursor, totalBytes));
  }

  // Byte gaps first (in document order), semantic-loss findings after — both
  // are real E4-relevant findings, but a gap is "content with no chunk at
  // all" while semantic loss is "a chunk exists but its own identity is
  // broken", a useful distinction for a human scanning the ledger.
  return [...gapEntries, ...semanticLossEntries, ...plausibilityEntries];
}

/**
 * Baut je Chunk, den `check` als unplausibel meldet, einen Ledger-Eintrag
 * mit Grund `"implausible_fragment"`. Ohne `check` ist das Ergebnis leer —
 * ein Aufrufer, der `buildArtifactSkipLedger` direkt und ohne Optionen
 * benutzt, sieht exakt dasselbe Verhalten wie vor WP-118.
 */
function findImplausibleFragmentEntries(
  document: ArtifactDocument,
  chunks: readonly ArtifactChunk[],
  check: ChunkPlausibilityCheck | undefined,
): ArtifactSkipLedgerEntry[] {
  if (check === undefined) return [];
  const entries: ArtifactSkipLedgerEntry[] = [];
  for (const chunk of chunks) {
    const detail = check(chunk);
    if (detail === undefined) continue;
    entries.push({
      artifactName: document.artifactName,
      path: document.path,
      range: chunk.range,
      reason: "implausible_fragment",
      contentPreview: `${detail} (kind="${chunk.kind}" title=${
        chunk.title === undefined ? "(none)" : JSON.stringify(chunk.title)
      })`.slice(0, PREVIEW_LENGTH),
    });
  }
  return entries;
}

function buildEntry(
  document: ArtifactDocument,
  index: LineIndex,
  startByte: number,
  endByte: number,
): ArtifactSkipLedgerEntry {
  const gapContent = index.buffer.toString("utf8", startByte, endByte);
  const startLine = lineNumberForByte(index, startByte);
  const endLine = endByte > startByte ? lineNumberForByte(index, endByte - 1) : startLine;
  return {
    artifactName: document.artifactName,
    path: document.path,
    range: { startLine, endLine, startByte, endByte },
    reason: classify(gapContent),
    contentPreview: gapContent.slice(0, PREVIEW_LENGTH),
  };
}

/**
 * See the module doc's "Byte coverage alone is BLIND..." note: finds chunks
 * that violate the structural invariant every legitimate `ArtifactChunk`
 * must satisfy, independent of any particular format's grammar.
 *
 * 1. A chunk whose own range is empty or inverted (`endByte <= startByte`)
 *    — an adapter tried to carve out a section and captured zero bytes for
 *    it. `chunk.content`/`contentHash` are trusted as the preview source
 *    here (not re-sliced from `document`) precisely because the chunk's own
 *    declared range cannot be trusted to slice anything meaningful.
 * 2. Two (or more) chunks that claim the EXACT same byte range but disagree
 *    on `kind`/`title` — the same bytes were classified twice, differently.
 *    Deliberately exact-range-only: a legitimately nested overlap (e.g. a
 *    Protobuf RPC inside its service) never has an identical range to its
 *    parent, so this never fires on that intentional case.
 */
function findSemanticLossEntries(
  document: ArtifactDocument,
  index: LineIndex,
  chunks: readonly ArtifactChunk[],
): ArtifactSkipLedgerEntry[] {
  const entries: ArtifactSkipLedgerEntry[] = [];

  for (const chunk of chunks) {
    if (chunk.range.endByte > chunk.range.startByte) continue;
    entries.push({
      artifactName: document.artifactName,
      path: document.path,
      range: chunk.range,
      reason: "semantic_loss",
      contentPreview: `degenerate chunk: kind="${chunk.kind}" title=${
        chunk.title === undefined ? "(none)" : JSON.stringify(chunk.title)
      } produced an empty/inverted range [${chunk.range.startByte}, ${chunk.range.endByte}) — a section boundary was found but no content was captured for it`.slice(
        0,
        PREVIEW_LENGTH,
      ),
    });
  }

  const byRange = new Map<string, ArtifactChunk[]>();
  for (const chunk of chunks) {
    if (chunk.range.endByte <= chunk.range.startByte) continue; // already reported above
    const key = `${chunk.range.startByte}:${chunk.range.endByte}`;
    const group = byRange.get(key);
    if (group) {
      group.push(chunk);
    } else {
      byRange.set(key, [chunk]);
    }
  }
  for (const group of byRange.values()) {
    if (group.length < 2) continue;
    const identities = new Set(group.map((chunk) => `${chunk.kind} ${chunk.title ?? ""}`));
    if (identities.size < 2) continue; // same range, same identity: not a conflict
    const first = group[0]!;
    const startLine = lineNumberForByte(index, first.range.startByte);
    const endLine =
      first.range.endByte > first.range.startByte
        ? lineNumberForByte(index, first.range.endByte - 1)
        : startLine;
    entries.push({
      artifactName: document.artifactName,
      path: document.path,
      range: { startLine, endLine, startByte: first.range.startByte, endByte: first.range.endByte },
      reason: "semantic_loss",
      contentPreview:
        `conflicting classification: ${group.length} chunks share byte range [${first.range.startByte}, ${
          first.range.endByte
        }) with different identities: ${group.map((chunk) => `kind="${chunk.kind}" title=${chunk.title ?? "(none)"}`).join(" vs. ")}`.slice(
          0,
          PREVIEW_LENGTH,
        ),
    });
  }

  return entries;
}
