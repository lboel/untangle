/**
 * Generic text fallback adapter (spec.md §19.2 "sicherer Text-Fallback";
 * architecture.md §22.2 "Parserfehler degradieren auf Textanalyse").
 *
 * `supports()` matches everything the registry hasn't already routed to a
 * more specific adapter — it is always registered LAST, as the registry's
 * catch-all, so no file is ever left unindexable just because its format
 * has no dedicated adapter (rule 4 / E4: nothing is silently skipped, it
 * is degraded to fixed-size line windows instead).
 *
 * Windows are contiguous and non-overlapping, covering the ENTIRE file —
 * `buildArtifactSkipLedger` reports zero gaps for a text-fallback document,
 * by construction.
 */
import type {
  ArtifactAdapter,
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ArtifactLink,
} from "@untangle-code/domain";

import { buildLineIndex } from "../text/line-index.js";

import type { ChunkDraft, SkipLedgerReporter } from "./shared.js";
import { buildChunksReportingSkips, buildDocuments } from "./shared.js";

/** Lines per window — generous enough to keep a chunk's content meaningfully self-contained, small enough to stay embeddable. */
export const TEXT_WINDOW_LINES = 200;

function windowDrafts(lineCount: number): ChunkDraft[] {
  const total = Math.max(lineCount, 1);
  const drafts: ChunkDraft[] = [];
  for (let start = 1; start <= total; start += TEXT_WINDOW_LINES) {
    const end = Math.min(start + TEXT_WINDOW_LINES - 1, total);
    drafts.push({ kind: "text_window", startLine: start, endLine: end });
  }
  return drafts;
}

export interface TextFallbackAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. Never actually fires here: windows are gapless by construction (see module doc). */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createTextFallbackAdapter(
  options: TextFallbackAdapterOptions = {},
): ArtifactAdapter {
  return {
    supports(): boolean {
      return true; // catch-all; the registry only reaches this adapter once nothing else claimed the file.
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "text");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      const index = buildLineIndex(document.content);
      return buildChunksReportingSkips(
        document,
        index,
        windowDrafts(index.lineCount),
        options.onSkipLedgerGap,
      );
    },

    links(): ArtifactLink[] {
      return [];
    },
  };
}
