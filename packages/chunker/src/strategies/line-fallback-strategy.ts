/**
 * Line fallback strategy (spec.md §8.3 step 9): used whole-file when parsing
 * failed or produced no usable regions. Splits the file into fixed-size,
 * overlapping line windows so a retrieval hit still carries some
 * surrounding context despite the missing AST structure. Any individual
 * window that is still too large for the token budget (e.g. one very long
 * line) is defensively re-split at a safe byte boundary.
 */
import type { SourceRange } from "@untangle-code/domain";

import { rangeForByteSpan } from "../byte-text.js";
import {
  type BuildContext,
  contentOf,
  emitChunk,
  estimateTokensWithHeader,
  type HeaderMeta,
} from "../context.js";
import { chunkedEntry } from "../coverage.js";
import { splitByTokenBoundary } from "../split.js";

import type { StrategyResult } from "./ast-chunk-strategy.js";

const NO_HEADER: Pick<HeaderMeta, "symbolFqn" | "signature"> = { signature: "fallback_lines" };

/**
 * Computes the ordered, overlapping line windows covering `[1, totalLines]`.
 * `step = linesPerChunk - overlapLines` (clamped to at least 1 to guarantee
 * termination); the last window is extended to the final line.
 */
function computeLineWindows(
  totalLines: number,
  linesPerChunk: number,
  overlapLines: number,
): [number, number][] {
  const chunkSize = Math.max(1, linesPerChunk);
  const overlap = Math.min(Math.max(0, overlapLines), chunkSize - 1);
  const step = Math.max(1, chunkSize - overlap);
  const windows: [number, number][] = [];
  let start = 1;
  while (start <= totalLines) {
    const end = Math.min(totalLines, start + chunkSize - 1);
    windows.push([start, end]);
    if (end >= totalLines) {
      break;
    }
    start += step;
  }
  return windows;
}

export function runLineFallbackStrategy(ctx: BuildContext): StrategyResult {
  const result: StrategyResult = { drafts: [], coverage: [] };
  const totalLines = ctx.lineIndex.lineStarts.length;
  const windows = computeLineWindows(
    totalLines,
    ctx.config.lineFallback.linesPerChunk,
    ctx.config.lineFallback.overlapLines,
  );

  for (const [startLine, endLine] of windows) {
    const startByte = ctx.lineIndex.lineStarts[startLine - 1]!;
    const endByte =
      endLine < totalLines ? ctx.lineIndex.lineStarts[endLine]! : ctx.lineIndex.buffer.length;
    if (endByte <= startByte) {
      // Degenerate trailing "line" produced when the file ends in a newline
      // (an empty line index entry with nothing after it) — zero bytes, so
      // there is nothing to cover and nothing to chunk.
      continue;
    }
    const range: SourceRange = { startLine, endLine, startByte, endByte };
    const content = contentOf(ctx, range);
    if (estimateTokensWithHeader(ctx, content, NO_HEADER) <= ctx.config.maxTokensPerChunk) {
      const draft = emitChunk(ctx, {
        range,
        content,
        scopeId: ctx.identity.fileId,
        chunkKind: "fallback_lines",
        header: {
          signature: "fallback_lines",
          metricsScope: "chunk",
          metricsScopeId: ctx.identity.fileId,
        },
      });
      result.drafts.push(draft);
      result.coverage.push(chunkedEntry(draft.range, draft.chunkId));
    } else {
      for (const piece of splitByTokenBoundary(ctx, range, NO_HEADER)) {
        const pieceContent = contentOf(ctx, piece);
        const rangeWithLines = rangeForByteSpan(ctx.lineIndex, piece.startByte, piece.endByte);
        const draft = emitChunk(ctx, {
          range: rangeWithLines,
          content: pieceContent,
          scopeId: ctx.identity.fileId,
          chunkKind: "fallback_lines",
          header: {
            signature: "fallback_lines",
            metricsScope: "chunk",
            metricsScopeId: ctx.identity.fileId,
          },
        });
        result.drafts.push(draft);
        result.coverage.push(chunkedEntry(draft.range, draft.chunkId));
      }
    }
  }
  return result;
}
