import { describe, expect, it } from "vitest";

import { aggregate } from "./aggregator.js";

// Hand-computed reference set: 1..10.
// Linear-interpolation percentile: index = p * (n - 1), n = 10 -> index range [0, 9].
const ONE_TO_TEN = Array.from({ length: 10 }, (_, i) => ({
  metricsScopeId: `s${i + 1}`,
  value: i + 1,
}));

describe("aggregate", () => {
  it("computes count/sum/mean/max for a simple set", () => {
    const result = aggregate(ONE_TO_TEN);
    expect(result.count).toBe(10);
    expect(result.sum).toBe(55);
    expect(result.mean).toBe(5.5);
    expect(result.max).toBe(10);
  });

  it("computes median via linear interpolation (hand-computed)", () => {
    // median = p50: index = 0.5 * 9 = 4.5 -> between sorted[4]=5 and sorted[5]=6 -> 5.5
    const result = aggregate(ONE_TO_TEN);
    expect(result.median).toBe(5.5);
  });

  it("computes p90 via linear interpolation (hand-computed)", () => {
    // index = 0.9 * 9 = 8.1 -> between sorted[8]=9 and sorted[9]=10, frac 0.1 -> 9.1
    const result = aggregate(ONE_TO_TEN);
    expect(result.p90).toBeCloseTo(9.1, 10);
  });

  it("computes p95 via linear interpolation (hand-computed)", () => {
    // index = 0.95 * 9 = 8.55 -> between sorted[8]=9 and sorted[9]=10, frac 0.55 -> 9.55
    const result = aggregate(ONE_TO_TEN);
    expect(result.p95).toBeCloseTo(9.55, 10);
  });

  it("matches a known percentile textbook example", () => {
    // Values 1..4 (n=4). p90: index = 0.9 * 3 = 2.7 -> sorted[2]=3, sorted[3]=4, frac .7 -> 3.7
    const entries = [1, 2, 3, 4].map((v, i) => ({ metricsScopeId: `x${i}`, value: v }));
    const result = aggregate(entries);
    expect(result.p90).toBeCloseTo(3.7, 10);
    expect(result.median).toBeCloseTo(2.5, 10); // index 1.5 -> 2 + 0.5*(3-2) = 2.5
  });

  it("deduplicates entries by metricsScopeId, keeping the first occurrence", () => {
    const entries = [
      { metricsScopeId: "dup", value: 100 },
      { metricsScopeId: "dup", value: 999 },
      { metricsScopeId: "unique", value: 5 },
    ];
    const result = aggregate(entries);
    expect(result.count).toBe(2);
    expect(result.sum).toBe(105);
    expect(result.duplicatesDropped).toBe(1);
  });

  it("computes an SLOC-weighted mean only from entries that carry sloc", () => {
    const entries = [
      { metricsScopeId: "a", value: 10, sloc: 100 },
      { metricsScopeId: "b", value: 20, sloc: 300 },
    ];
    // (10*100 + 20*300) / (100+300) = (1000+6000)/400 = 17.5
    const result = aggregate(entries);
    expect(result.slocWeightedMean).toBeCloseTo(17.5, 10);
  });

  it("omits slocWeightedMean when no entry carries sloc", () => {
    const result = aggregate(ONE_TO_TEN);
    expect(result.slocWeightedMean).toBeUndefined();
  });

  it("counts entries strictly greater than each configured threshold", () => {
    const result = aggregate(ONE_TO_TEN, [5, 9]);
    expect(result.thresholdCounts["5"]).toBe(5); // 6,7,8,9,10
    expect(result.thresholdCounts["9"]).toBe(1); // 10
  });

  it("handles an empty entry list without throwing", () => {
    const result = aggregate([]);
    expect(result.count).toBe(0);
    expect(result.sum).toBe(0);
    expect(result.mean).toBe(0);
    expect(result.median).toBe(0);
    expect(result.max).toBe(0);
  });

  it("handles a single entry (percentile degenerates to that value)", () => {
    const result = aggregate([{ metricsScopeId: "only", value: 42 }]);
    expect(result.median).toBe(42);
    expect(result.p90).toBe(42);
    expect(result.p95).toBe(42);
  });
});
