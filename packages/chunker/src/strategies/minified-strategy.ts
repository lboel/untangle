/**
 * Minified strategy (spec.md §8.3 step 10): the file is treated as one
 * opaque blob and split purely at safe token/byte boundaries — there is no
 * useful AST structure to lean on, by definition of "minified" here.
 */
import { rangeForByteSpan, safeUtf8Boundary } from "../byte-text.js";
import { type BuildContext, contentOf, emitChunk, type HeaderMeta } from "../context.js";
import { chunkedEntry } from "../coverage.js";
import { splitByTokenBoundary } from "../split.js";

import type { StrategyResult } from "./ast-chunk-strategy.js";

const HEADER: Pick<HeaderMeta, "symbolFqn" | "signature"> = { signature: "minified_fragment" };

export function runMinifiedStrategy(ctx: BuildContext): StrategyResult {
  const result: StrategyResult = { drafts: [], coverage: [] };
  const pieces = splitByTokenBoundary(ctx, ctx.fileRange, HEADER);
  const overlapBytes = Math.max(0, ctx.config.minifiedStrategy.overlapBytes);

  pieces.forEach((piece, index) => {
    // Configurable trailing overlap: pull this piece's start back into the
    // previous piece's territory for retrieval context. Never before the
    // file start, and never a UTF-8-unsafe cut (architecture.md §14.4).
    // Coverage stays gap-free either way — overlaps are allowed.
    let startByte = piece.startByte;
    if (index > 0 && overlapBytes > 0) {
      startByte = safeUtf8Boundary(
        ctx.lineIndex.buffer,
        Math.max(ctx.fileRange.startByte, piece.startByte - overlapBytes),
      );
    }
    const range = rangeForByteSpan(ctx.lineIndex, startByte, piece.endByte);
    const content = contentOf(ctx, range);
    const draft = emitChunk(ctx, {
      range,
      content,
      scopeId: ctx.identity.fileId,
      chunkKind: "minified_fragment",
      header: {
        signature: "minified_fragment",
        metricsScope: "chunk",
        metricsScopeId: ctx.identity.fileId,
      },
    });
    result.drafts.push(draft);
    result.coverage.push(chunkedEntry(draft.range, draft.chunkId));
  });
  return result;
}
