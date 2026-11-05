import { describe, expect, it } from "vitest";

import { computeMaintainability, MAINTAINABILITY_FORMULA } from "./maintainability.js";

describe("computeMaintainability", () => {
  it("matches a hand-computed value for volume=500, cyclomatic=10, sloc=100", () => {
    // MI_raw = 171 - 5.2*ln(500) - 0.23*10 - 16.2*ln(100)
    //        = 171 - 5.2*6.214608... - 2.3 - 16.2*4.605170...
    //        = 171 - 32.315964... - 2.3 - 74.603762...
    //        = 61.780274...
    // MI = 61.780274... * 100 / 171 = 36.128816...
    const result = computeMaintainability({
      halsteadVolume: 500,
      cyclomaticClassic: 10,
      sloc: 100,
    });
    expect(result.raw).toBeCloseTo(61.7803, 3);
    expect(result.value).toBeCloseTo(36.1288, 3);
    expect(result.formula).toBe(MAINTAINABILITY_FORMULA);
  });

  it("clamps to 0 for a degenerate, extremely complex scope", () => {
    const result = computeMaintainability({
      halsteadVolume: 1_000_000,
      cyclomaticClassic: 5000,
      sloc: 100_000,
    });
    expect(result.value).toBe(0);
    expect(result.raw).toBeLessThan(0);
  });

  it("clamps to 100 (never exceeds it) for a trivial empty scope", () => {
    const result = computeMaintainability({ halsteadVolume: 0, cyclomaticClassic: 0, sloc: 0 });
    // volume -> max(0,1)=1 -> ln(1)=0; sloc -> max(0,1)=1 -> ln(1)=0
    // MI_raw = 171 - 0 - 0 - 0 = 171; MI = 171*100/171 = 100
    expect(result.raw).toBe(171);
    expect(result.value).toBe(100);
  });

  it("applies the max(volume,1) and max(sloc,1) guards for zero inputs", () => {
    const zero = computeMaintainability({ halsteadVolume: 0, cyclomaticClassic: 1, sloc: 0 });
    expect(Number.isFinite(zero.raw)).toBe(true);
    expect(Number.isNaN(zero.raw)).toBe(false);
  });
});
