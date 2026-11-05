/**
 * HalsteadCalculator (spec.md §16.7). Formulas exactly as specified,
 * including the `max(n, 1)` / `max(n2, 1)` guards against log(0)/div-by-0 on
 * an empty scope.
 *
 * Accepts the domain `HalsteadTokens` shape ({operators, operands}); a full
 * `ComplexityFacts` is also accepted as-is since it structurally satisfies
 * that shape.
 */
import type { HalsteadTokens } from "@untangle-code/domain";

import type { HalsteadResult } from "./types.js";

function log2(x: number): number {
  return Math.log(x) / Math.LN2;
}

export interface HalsteadOptions {
  /**
   * Also compute Time (`effort / 18`, Halstead's Stroud-number heuristic) and
   * Estimated Bugs (`volume / 3000`) — spec.md §16.7 requires both to be
   * explicitly labeled as estimates when present, hence the separate
   * `estimates` field on `HalsteadResult` rather than folding them into
   * `metrics`.
   */
  includeEstimates?: boolean;
}

export function computeHalstead(
  tokens: HalsteadTokens,
  options: HalsteadOptions = {},
  algorithmVersion = "untangle-halstead-v1",
): HalsteadResult {
  const N1 = tokens.operators.length;
  const N2 = tokens.operands.length;
  const n1 = new Set(tokens.operators.map((t) => t.text)).size;
  const n2 = new Set(tokens.operands.map((t) => t.text)).size;
  const n = n1 + n2;
  const N = N1 + N2;
  const volume = N * log2(Math.max(n, 1));
  const difficulty = (n1 / 2) * (N2 / Math.max(n2, 1));
  const effort = difficulty * volume;

  const metrics: Record<string, number> = { n1, n2, N1, N2, n, N, volume, difficulty, effort };

  const result: HalsteadResult = { metrics, algorithmVersion };
  if (options.includeEstimates) {
    result.estimates = {
      timeSeconds: effort / 18,
      estimatedBugs: volume / 3000,
    };
  }
  return result;
}
