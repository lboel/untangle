/**
 * Helpers shared by every concrete format adapter in `src/adapters/`.
 */
import type {
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ContextArtifactType,
} from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";

import {
  buildArtifactSkipLedger,
  defaultSkipLedgerReporter,
  type ChunkPlausibilityCheck,
  type SkipLedgerReporter,
} from "../coverage.js";
import { buildArtifactChunkId } from "../ids.js";
import type { LineIndex } from "../text/line-index.js";
import { rangeForLines, sliceBytes, sliceLines } from "../text/line-index.js";

export type { ChunkPlausibilityCheck, SkipLedgerReporter } from "../coverage.js";

/** Builds one `ArtifactDocument` per file in `input.files` (spec.md §19.2: files AND directories). */
export function buildDocuments(
  input: ArtifactInput,
  type: Exclude<ContextArtifactType, "auto">,
  language?: string,
): ArtifactDocument[] {
  return input.files.map((file) => {
    const document: ArtifactDocument = {
      artifactName: input.config.name,
      type,
      path: file.path,
      contentHash: file.contentHash,
      content: file.content,
    };
    return language === undefined ? document : { ...document, language };
  });
}

export interface ChunkDraft {
  kind: string;
  startLine: number;
  endLine: number;
  title?: string;
  /**
   * Optional exact byte range, used instead of `rangeForLines(index,
   * startLine, endLine)` when a draft's true boundary does not land on a
   * whole-line boundary — e.g. two SQL statements sharing one physical
   * line, each needing its own non-overlapping byte span within that one
   * line. `startLine`/`endLine` are still required (and still used for the
   * chunk's `range.startLine`/`endLine`) so every draft has a human-facing
   * line reference even when its bytes are sub-line-precise. Omitted by
   * every adapter that only ever splits on whole lines (the common case).
   */
  startByte?: number;
  endByte?: number;
}

/**
 * Turns line-range drafts into fully-formed `ArtifactChunk`s: computes
 * `range` (via `index`, or the draft's own `startByte`/`endByte` when
 * given), byte-exact `content` (a slice of the SAME buffer `index` was
 * built from — never a re-encoded copy, so content is always byte-identical
 * to the source, spec.md §19.2), `contentHash`, and a deterministic
 * `chunkId` (ordinal = position in `drafts`).
 */
export function buildChunks(
  document: ArtifactDocument,
  index: LineIndex,
  drafts: ChunkDraft[],
): ArtifactChunk[] {
  return drafts.map((draft, ordinal) => {
    const hasExactBytes = draft.startByte !== undefined && draft.endByte !== undefined;
    const range = hasExactBytes
      ? {
          startLine: draft.startLine,
          endLine: draft.endLine,
          startByte: draft.startByte!,
          endByte: draft.endByte!,
        }
      : rangeForLines(index, draft.startLine, draft.endLine);
    const content = hasExactBytes
      ? sliceBytes(index, draft.startByte!, draft.endByte!)
      : sliceLines(index, draft.startLine, draft.endLine);
    const chunk: ArtifactChunk = {
      chunkId: buildArtifactChunkId({
        artifactName: document.artifactName,
        documentPath: document.path,
        kind: draft.kind,
        ordinal,
      }),
      artifactName: document.artifactName,
      kind: draft.kind,
      range,
      content,
      contentHash: sha256Hex(content),
    };
    return draft.title === undefined ? chunk : { ...chunk, title: draft.title };
  });
}

/** A single chunk spanning the whole document, used for parse-error degrades and the text fallback's single-window case. */
export function wholeDocumentDraft(kind: string, index: LineIndex, title?: string): ChunkDraft {
  const draft: ChunkDraft = { kind, startLine: 1, endLine: Math.max(index.lineCount, 1) };
  return title === undefined ? draft : { ...draft, title };
}

/**
 * `buildChunks`, plus BUILD_PLAN §12 E4: `buildArtifactSkipLedger()` must
 * never be a "Bringschuld" (an obligation a caller has to remember) —
 * every format adapter's `chunk()` calls this instead of `buildChunks`
 * directly, so a loss becomes visible in the SAME call that produces
 * chunks, with zero extra action from whoever calls `adapter.chunk()`.
 *
 * `checkPlausibility` (optional, WP-118) reicht die formatspezifische
 * Plausibilitätsprüfung des Adapters an den Ledger durch: ein Fragment,
 * das MITTEN DURCH ein Konstrukt geschnitten wurde, ist auch dann ein
 * Befund, wenn die Byte-Abdeckung lückenlos ist. Siehe
 * `coverage.ts::ChunkPlausibilityCheck` und `text/delimiter-balance.ts`.
 *
 * Only entries beyond plain `"whitespace_or_comment"` are reported —
 * `"unclassified_content"` and `"semantic_loss"` are the two reasons that
 * indicate a real problem (see coverage.ts's module doc); a benign gap
 * between two well-formed sections is expected and stays silent here too,
 * exactly as it does for a caller who inspects the ledger directly.
 *
 * `report` defaults to `defaultSkipLedgerReporter` (a single stderr line
 * per finding) but every `create*Adapter()` factory accepts an
 * `onSkipLedgerGap` override — inject a real structured logger, a test
 * spy, or a no-op, without this package depending on any particular
 * logging implementation.
 */
export function buildChunksReportingSkips(
  document: ArtifactDocument,
  index: LineIndex,
  drafts: ChunkDraft[],
  report: SkipLedgerReporter = defaultSkipLedgerReporter,
  checkPlausibility?: ChunkPlausibilityCheck,
): ArtifactChunk[] {
  const chunks = buildChunks(document, index, drafts);
  const options = checkPlausibility === undefined ? {} : { checkPlausibility };
  const actionable = buildArtifactSkipLedger(document, chunks, options).filter(
    (entry) => entry.reason !== "whitespace_or_comment",
  );
  if (actionable.length > 0) {
    report(actionable, document);
  }
  return chunks;
}
