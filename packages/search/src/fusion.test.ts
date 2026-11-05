import { describe, expect, it } from "vitest";

import { DEFAULT_BRANCH_WEIGHTS, RRF_K, fuseRankings, maximumRrf } from "./fusion.js";

describe("fuseRankings", () => {
  it("ranks a document that appears in two branches above one that appears in one", () => {
    const fused = fuseRankings([
      { branch: "dense", rankedIds: ["a", "b"] },
      { branch: "lexical", rankedIds: ["b", "c"] },
    ]);
    expect(fused[0]?.id).toBe("b");
  });

  it("does not penalize an id that is missing from a branch beyond not scoring there", () => {
    const fused = fuseRankings([
      { branch: "dense", rankedIds: ["a"] },
      { branch: "lexical", rankedIds: ["b"] },
    ]);
    const a = fused.find((entry) => entry.id === "a");
    const b = fused.find((entry) => entry.id === "b");
    expect(a?.rrf).toBeCloseTo(b?.rrf ?? 0, 12);
  });

  it("uses the documented k of the RRF paper", () => {
    const fused = fuseRankings([{ branch: "dense", rankedIds: ["a"] }]);
    expect(fused[0]?.rrf).toBeCloseTo(DEFAULT_BRANCH_WEIGHTS.dense / (RRF_K + 1), 12);
  });

  it("weights the symbol branch at half, to avoid double counting with the boost", () => {
    const fused = fuseRankings([
      { branch: "dense", rankedIds: ["a"] },
      { branch: "symbol", rankedIds: ["b"] },
    ]);
    const a = fused.find((entry) => entry.id === "a")?.rrf ?? 0;
    const b = fused.find((entry) => entry.id === "b")?.rrf ?? 0;
    expect(b).toBeCloseTo(a / 2, 12);
  });

  it("normalizes against the theoretical maximum, not the best hit in the list", () => {
    const single = fuseRankings([{ branch: "dense", rankedIds: ["a", "b", "c"] }]);
    // Rang 1 in genau einem Zweig ist das Maximum dieses Zweigs -> 1.0.
    expect(single[0]?.normalized).toBeCloseTo(1, 12);
    const partial = fuseRankings([
      { branch: "dense", rankedIds: ["x"] },
      { branch: "lexical", rankedIds: ["y"] },
    ]);
    // Zwei Zweige, jeder Kandidat nur in einem: der beste Treffer erreicht
    // NICHT 1.0 — genau der Unterschied, den die Findability-Diagnose braucht.
    expect(partial[0]?.normalized).toBeLessThan(1);
  });

  it("records the contributing branch ranks", () => {
    const fused = fuseRankings([
      { branch: "dense", rankedIds: ["a", "b"] },
      { branch: "lexical", rankedIds: ["b"] },
    ]);
    const b = fused.find((entry) => entry.id === "b");
    expect(b?.ranks).toEqual({ dense: 2, lexical: 1 });
  });

  it("breaks ties by codepoint order", () => {
    const fused = fuseRankings([
      { branch: "dense", rankedIds: [] },
      { branch: "lexical", rankedIds: [] },
    ]);
    expect(fused).toEqual([]);
    const tied = fuseRankings([
      { branch: "dense", rankedIds: ["b"] },
      { branch: "lexical", rankedIds: ["a"] },
    ]);
    expect(tied.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("maximumRrf counts every distinct branch exactly once", () => {
    expect(maximumRrf(["dense", "dense", "lexical"], { ...DEFAULT_BRANCH_WEIGHTS })).toBeCloseTo(
      (DEFAULT_BRANCH_WEIGHTS.dense + DEFAULT_BRANCH_WEIGHTS.lexical) / (RRF_K + 1),
      12,
    );
  });
});
