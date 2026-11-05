/**
 * Top-level chunking entry point (spec.md §8.3): picks a strategy, runs it,
 * and — regardless of which strategy ran — guarantees the lossless coverage
 * invariant (spec.md §8.4) before returning: any residual gap is filled with
 * `fallback_lines` chunks, then the result is validated one last time and
 * `ANALYSIS_INCOMPLETE` is thrown if that somehow still fails (defense in
 * depth; a correct strategy should never leave a gap).
 */
import { classifyTextFormat, validateCoverage } from "@untangle-code/domain";
import type { CodeChunkDraft, CoverageEntry, SourceRange } from "@untangle-code/domain";

import { resolveChunkerConfig } from "./config.js";
import { contentOf, createBuildContext, emitChunk } from "./context.js";
import { assertLosslessCoverage, assertTruthfulLedger, chunkedEntry } from "./coverage.js";
import { detectMinifiedContent } from "./minified-detection.js";
import { splitByTokenBoundary } from "./split.js";
import { runAstChunkStrategy } from "./strategies/ast-chunk-strategy.js";
import { runLineFallbackStrategy } from "./strategies/line-fallback-strategy.js";
import { runMinifiedStrategy } from "./strategies/minified-strategy.js";
import type { ChunkDegradation, ChunkFileParams, ChunkFileResult } from "./types.js";

const GAP_HEADER = { signature: "fallback_lines" } as const;

/** Fills any residual byte gap with `fallback_lines` chunks (defense in depth for every strategy). */
function fillGaps(
  ctx: ReturnType<typeof createBuildContext>,
  drafts: CodeChunkDraft[],
  coverage: CoverageEntry[],
): void {
  const gaps = validateCoverage(coverage, ctx.fileRange).gaps;
  for (const gap of gaps) {
    const range: SourceRange = { ...gap, startLine: -1, endLine: -1 };
    for (const piece of splitByTokenBoundary(ctx, range, GAP_HEADER)) {
      const draft = emitChunk(ctx, {
        range: piece,
        content: contentOf(ctx, piece),
        scopeId: ctx.identity.fileId,
        chunkKind: "fallback_lines",
        header: {
          signature: "fallback_lines",
          metricsScope: "chunk",
          metricsScopeId: ctx.identity.fileId,
        },
      });
      drafts.push(draft);
      coverage.push(chunkedEntry(draft.range, draft.chunkId));
    }
  }
}

/**
 * Chunks one file per spec.md §8.3: minified detection takes priority over
 * AST chunking (a minified file may still parse "successfully" but produces
 * no meaningful symbol structure), then a failed/empty parse falls back to
 * line windows, and otherwise the AST strategy runs (README "Entscheidungen"
 * documents this ordering as an Untangle decision — the spec numbers 9/10
 * as trailing fallback steps without fixing their relative priority).
 */
export function chunkFile(params: ChunkFileParams): ChunkFileResult {
  const config = resolveChunkerConfig(params.config);
  const ctx = createBuildContext(
    params.identity,
    params.content,
    config,
    params.parseResult.parseQuality,
  );

  const isMinified =
    params.isMinified ??
    detectMinifiedContent(
      params.content,
      config.minifiedDetection,
      classifyTextFormat(params.identity.filePath),
    );
  const hasUsableAst = params.parseResult.parseQuality !== "failed" && params.regions.length > 0;

  let drafts: CodeChunkDraft[];
  let coverage: CoverageEntry[];
  let strategy: ChunkFileResult["strategy"];
  // E4 (WP-165): jede Abweichung von der AST-Strategie bekommt hier einen
  // benannten Grund. Ohne ihn ist die Abstufung unsichtbar -- die Bytes sind
  // lueckenlos erfasst, `parseQuality` kann `"complete"` lauten, und trotzdem
  // hat kein Chunk eine Symbolzuordnung.
  const degradations: ChunkDegradation[] = [];

  if (isMinified) {
    const result = runMinifiedStrategy(ctx);
    drafts = result.drafts;
    coverage = result.coverage;
    strategy = "minified";
    degradations.push({
      reason: "minified_content",
      strategy: "minified",
      detail: `content was classified as minified (${
        params.isMinified === undefined ? "auto-detected" : "declared by the caller"
      }), so it was cut into byte windows; no symbol association exists for this file`,
    });
  } else if (!hasUsableAst) {
    const result = runLineFallbackStrategy(ctx);
    drafts = result.drafts;
    coverage = result.coverage;
    strategy = "line_fallback";
    degradations.push(
      params.parseResult.parseQuality === "failed"
        ? {
            reason: "parse_failed",
            strategy: "line_fallback",
            detail: `the parse failed (${String(
              params.parseResult.errorNodeCount,
            )} error node(s), ${String(
              params.parseResult.missingNodeCount,
            )} missing node(s)), so the file was cut into line windows; no symbol association exists for this file`,
          }
        : {
            reason: "ast_regions_missing",
            strategy: "line_fallback",
            detail: `the parse reported "${params.parseResult.parseQuality}" but the language adapter delivered no chunk regions, so the file was cut into line windows; no symbol association exists for this file although the parse claims success`,
          },
    );
  } else {
    const result = runAstChunkStrategy(ctx, params.regions, params.symbols);
    drafts = result.drafts;
    coverage = result.coverage;
    strategy = "ast";
  }

  fillGaps(ctx, drafts, coverage);
  // Two-sided machine check (spec.md §8.4): the ledger must be COMPLETE
  // (assertLosslessCoverage) and every claim in it must be TRUE
  // (assertTruthfulLedger) — a synthesized chunk may never stand in for
  // bytes its content does not literally carry.
  assertTruthfulLedger(ctx.lineIndex, drafts, coverage, params.identity.filePath);
  assertLosslessCoverage(coverage, ctx.fileRange, params.identity.filePath);

  return {
    drafts,
    coverage,
    strategy,
    parseQuality: params.parseResult.parseQuality,
    degradations,
  };
}
