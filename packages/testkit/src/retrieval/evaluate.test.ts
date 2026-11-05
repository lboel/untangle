import { describe, expect, it } from "vitest";

import { evaluate } from "./evaluate.js";
import type { RetrievalCaseResult } from "./types.js";

describe("evaluate", () => {
  // Hand-computed reference values — see the derivation in each `it` block.
  const caseA: RetrievalCaseResult = {
    retrievalCase: { query: "distance between two points", expectedFiles: ["a.ts", "b.ts"] },
    hits: [
      { filePath: "x.ts", repoId: "r1" },
      { filePath: "a.ts", repoId: "r1" }, // rank 2 — first expected hit
      { filePath: "y.ts", repoId: "r2" },
      { filePath: "b.ts", repoId: "r2" }, // rank 4 — second expected hit
      { filePath: "z.ts", repoId: "r3" },
    ],
  };
  // recall@5  = |{a.ts,b.ts} ∩ top5| / 2 = 2/2 = 1
  // recall@10 = same 5 hits (no 6th) = 1
  // MRR       = 1 / rank(a.ts) = 1/2 = 0.5
  // diversity = distinct repoIds among all 5 hits = {r1, r2, r3} = 3
  // forbidden = none configured -> false

  const caseB: RetrievalCaseResult = {
    retrievalCase: {
      query: "the one obscure file",
      expectedFiles: ["only.ts"],
      forbiddenFiles: ["nope3.ts"],
    },
    hits: [
      { filePath: "nope1.ts", repoId: "r1" },
      { filePath: "nope2.ts", repoId: "r1" },
      { filePath: "nope3.ts", repoId: "r1" }, // forbidden file present -> violation
      { filePath: "nope4.ts", repoId: "r1" },
      { filePath: "nope5.ts", repoId: "r1" },
      { filePath: "only.ts", repoId: "r1" }, // rank 6 — outside top 5, inside top 10
    ],
  };
  // recall@5  = only.ts not in top 5 -> 0/1 = 0
  // recall@10 = only.ts in top 10 (rank 6) -> 1/1 = 1
  // MRR       = 1/6
  // diversity = distinct repoIds among top 10 (all 6 hits) = {r1} = 1
  // forbidden = "nope3.ts" is among the hits -> true

  const caseC: RetrievalCaseResult = {
    retrievalCase: { query: "nothing to find here", expectedFiles: [] },
    hits: [],
  };
  // recall@5 = recall@10 = MRR = 1 (vacuously satisfied: nothing was expected)
  // diversity = 0 (no hits, so no repoId at all)
  // forbidden = none configured -> false

  it("computes per-case metrics matching hand-derived values", () => {
    const result = evaluate([caseA, caseB, caseC]);
    expect(result.perCase).toEqual([
      {
        query: "distance between two points",
        recallAt5: 1,
        recallAt10: 1,
        reciprocalRank: 0.5,
        forbiddenFileViolation: false,
        repositoryDiversity: 3,
      },
      {
        query: "the one obscure file",
        recallAt5: 0,
        recallAt10: 1,
        reciprocalRank: 1 / 6,
        forbiddenFileViolation: true,
        repositoryDiversity: 1,
      },
      {
        query: "nothing to find here",
        recallAt5: 1,
        recallAt10: 1,
        reciprocalRank: 1,
        forbiddenFileViolation: false,
        repositoryDiversity: 0,
      },
    ]);
  });

  it("aggregates as the mean of the per-case values (macro-average)", () => {
    const result = evaluate([caseA, caseB, caseC]);
    expect(result.recallAt5).toBeCloseTo((1 + 0 + 1) / 3, 12);
    expect(result.recallAt10).toBeCloseTo((1 + 1 + 1) / 3, 12);
    expect(result.mrr).toBeCloseTo((0.5 + 1 / 6 + 1) / 3, 12);
    expect(result.repositoryDiversity).toBeCloseTo((3 + 1 + 0) / 3, 12);
    expect(result.forbiddenFileViolationCount).toBe(1);
  });

  it("returns all-zero aggregates for an empty result set, never NaN", () => {
    const result = evaluate([]);
    expect(result.recallAt5).toBe(0);
    expect(result.recallAt10).toBe(0);
    expect(result.mrr).toBe(0);
    expect(result.repositoryDiversity).toBe(0);
    expect(result.forbiddenFileViolationCount).toBe(0);
    expect(result.perCase).toEqual([]);
  });

  it("recall@k does not credit a match that is present but outside the window", () => {
    const result = evaluate([
      {
        retrievalCase: { query: "q", expectedFiles: ["deep.ts"] },
        hits: Array.from({ length: 11 }, (_, i) => ({ filePath: `f${i}.ts` })).concat([
          { filePath: "deep.ts" },
        ]),
      },
    ]);
    // "deep.ts" is at rank 12 — outside both windows.
    expect(result.recallAt5).toBe(0);
    expect(result.recallAt10).toBe(0);
    expect(result.mrr).toBe(1 / 12);
  });

  it("a case with zero repoId-carrying hits scores repositoryDiversity 0, not NaN", () => {
    const result = evaluate([
      {
        retrievalCase: { query: "q", expectedFiles: [] },
        hits: [{ filePath: "a.ts" }, { filePath: "b.ts" }],
      },
    ]);
    expect(result.repositoryDiversity).toBe(0);
  });
});
