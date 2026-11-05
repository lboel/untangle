/**
 * Coverage ledger construction (architecture.md §14.1; spec.md §8.4).
 *
 * The validator itself (`validateCoverage`) already lives in
 * `@untangle-code/domain` as a pure function — it is the shared contract
 * every producer must satisfy, so it is not redefined here. This module only
 * builds the ledger entries as chunks are produced, and fills any residual
 * gap the strategies left behind so the lossless invariant always holds
 * before a file's chunking result is returned.
 */
import type { CodeChunkDraft, CoverageEntry, SourceRange } from "@untangle-code/domain";
import { UntangleError, validateCoverage } from "@untangle-code/domain";

import { type LineIndex, sliceBytes } from "./byte-text.js";

/** One "chunked" ledger entry for a single emitted chunk. */
export function chunkedEntry(range: SourceRange, chunkId: string): CoverageEntry {
  return { range, status: "chunked", chunkIds: [chunkId] };
}

/** One "excluded" ledger entry; `reason` is mandatory (spec.md §8.4). */
export function excludedEntry(range: SourceRange, reason: string): CoverageEntry {
  return { range, status: "excluded", exclusionReason: reason };
}

/** The chunk fields `assertTruthfulLedger` needs (a structural subset of `CodeChunkDraft`). */
export type LedgerChunkView = Pick<
  CodeChunkDraft,
  "chunkId" | "chunkKind" | "range" | "content" | "synthesized"
>;

/**
 * Asserts every ledger claim is TRUE, not merely byte-complete
 * (spec.md §8.4; docs/BUILD_PLAN.md E4 — no silent masking of content):
 *
 * - every NON-synthesized chunk's `content` is byte-exactly the source
 *   bytes of its `range` (the `CodeChunkDraft.content` contract), so any
 *   "chunked" entry lying inside such a chunk's range is literally carried;
 * - every "chunked" entry that is only backed by SYNTHESIZED chunks claims
 *   nothing beyond what those chunks literally carry: the claimed range's
 *   text (whitespace-trimmed) must appear verbatim in a claiming chunk's
 *   content;
 * - every `chunkIds` reference resolves to an emitted chunk.
 *
 * A violation is an error (`UntangleError("ANALYSIS_INCOMPLETE")`), never a
 * warning: a ledger entry that claims bytes no chunk content carries would
 * silently mask content exactly as spec.md §8.4 forbids.
 */
export function assertTruthfulLedger(
  lineIndex: LineIndex,
  drafts: readonly LedgerChunkView[],
  entries: readonly CoverageEntry[],
  filePath: string,
): void {
  const violations: string[] = [];
  const byId = new Map<string, LedgerChunkView>();
  for (const draft of drafts) {
    byId.set(draft.chunkId, draft);
  }

  for (const draft of drafts) {
    if (draft.synthesized === true) {
      continue;
    }
    const sourceText = sliceBytes(lineIndex, draft.range.startByte, draft.range.endByte);
    if (draft.content !== sourceText) {
      violations.push(
        `non-synthesized ${draft.chunkKind} chunk ${draft.chunkId} content is not byte-exact for its range ${draft.range.startByte}..${draft.range.endByte}`,
      );
    }
  }

  for (const entry of entries) {
    if (entry.status !== "chunked") {
      continue;
    }
    const claimedTrimmed = sliceBytes(lineIndex, entry.range.startByte, entry.range.endByte).trim();
    let proven = false;
    for (const chunkId of entry.chunkIds ?? []) {
      const draft = byId.get(chunkId);
      if (draft === undefined) {
        violations.push(
          `chunked entry ${entry.range.startByte}..${entry.range.endByte} references unknown chunk ${chunkId}`,
        );
        continue;
      }
      if (draft.synthesized !== true) {
        // Content is byte-exact (checked above), so containment of the
        // claimed byte range in the chunk range proves the claim literally.
        if (
          draft.range.startByte <= entry.range.startByte &&
          entry.range.endByte <= draft.range.endByte
        ) {
          proven = true;
          break;
        }
      } else if (draft.content.includes(claimedTrimmed)) {
        proven = true;
        break;
      }
    }
    if (!proven) {
      violations.push(
        `chunked entry ${entry.range.startByte}..${entry.range.endByte} claims bytes none of its chunks [${(entry.chunkIds ?? []).join(", ")}] literally carries`,
      );
    }
  }

  if (violations.length > 0) {
    throw new UntangleError(
      "ANALYSIS_INCOMPLETE",
      `coverage ledger of "${filePath}" claims content its chunks do not literally carry (spec.md §8.4)`,
      {
        operation: "chunker.assertTruthfulLedger",
        context: { filePath, violations },
      },
    );
  }
}

/**
 * Asserts the lossless invariant holds for `entries` over `fileRange`, or
 * throws `UntangleError("ANALYSIS_INCOMPLETE")` naming the concrete gaps
 * (spec.md §8.4: hard truncation without a follow-up chunk is a bug, not a
 * warning). Every chunking strategy MUST call this before returning.
 */
export function assertLosslessCoverage(
  entries: readonly CoverageEntry[],
  fileRange: SourceRange,
  filePath: string,
): void {
  const result = validateCoverage(entries, fileRange);
  if (!result.complete) {
    throw new UntangleError(
      "ANALYSIS_INCOMPLETE",
      `chunking left the source of "${filePath}" incompletely covered (spec.md §8.4)`,
      {
        operation: "chunker.assertLosslessCoverage",
        context: { filePath, gaps: result.gaps, issues: result.issues },
      },
    );
  }
}
