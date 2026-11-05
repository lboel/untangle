/**
 * MaintainabilityCalculator (spec.md §16.9). Exact default formula, no
 * comment bonus (v1 deliberately omits it per spec.md §16.9, for
 * cross-language stability), clamped to [0, 100]. The formula string itself
 * is always returned, as required by the work order.
 */
import type { MaintainabilityResult } from "./types.js";

export const MAINTAINABILITY_FORMULA =
  "MI = clamp((171 - 5.2*ln(max(HalsteadVolume,1)) - 0.23*CyclomaticClassic - 16.2*ln(max(SLOC,1))) * 100 / 171, 0, 100)";

export interface MaintainabilityInput {
  halsteadVolume: number;
  cyclomaticClassic: number;
  sloc: number;
}

export function computeMaintainability(
  input: MaintainabilityInput,
  algorithmVersion = "untangle-maintainability-v1",
): MaintainabilityResult {
  const volumeTerm = Math.log(Math.max(input.halsteadVolume, 1));
  const slocTerm = Math.log(Math.max(input.sloc, 1));
  const raw = 171 - 5.2 * volumeTerm - 0.23 * input.cyclomaticClassic - 16.2 * slocTerm;
  const scaled = (raw * 100) / 171;
  const value = Math.min(100, Math.max(0, scaled));

  return { value, raw, formula: MAINTAINABILITY_FORMULA, algorithmVersion };
}
