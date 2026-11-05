import { describe, expect, it } from "vitest";

import { reciprocalRankFusion } from "./rrf.js";

describe("reciprocalRankFusion", () => {
  it("ranks an id first in both branches highest", () => {
    const scores = reciprocalRankFusion([
      ["a", "b", "c"],
      ["a", "c", "b"],
    ]);
    const ranked = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ranked[0]).toBe("a");
  });

  it("does not penalize an id absent from one branch beyond not ranking there", () => {
    const onlyDense = reciprocalRankFusion([["a", "b"], []]);
    const bothBranches = reciprocalRankFusion([
      ["a", "b"],
      ["a", "b"],
    ]);
    // "a" contributes from the dense branch identically in both cases; the
    // fused branch simply adds an extra contribution rather than penalizing.
    expect(onlyDense.get("a")).toBeLessThan(bothBranches.get("a")!);
  });

  it("uses the conventional k=60 default", () => {
    const scores = reciprocalRankFusion([["a"]]);
    expect(scores.get("a")).toBeCloseTo(1 / 61, 10);
  });

  it("respects a custom smoothing constant k", () => {
    const scores = reciprocalRankFusion([["a"]], { k: 0 });
    expect(scores.get("a")).toBeCloseTo(1, 10);
  });

  it("returns an empty map for no ranked lists", () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
  });
});
