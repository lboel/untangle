import { describe, expect, it } from "vitest";

import {
  QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
  decideResultRelevance,
  maximumCandidateIdfCoverage,
  resolveRelevancePolicy,
  resolveRelevancePolicyBinding,
  selectFixedRelevanceEvidencePool,
  satisfiesNonSymbolRelevancePolicy,
} from "./relevance.js";

function denseEnvelope(
  top: number,
  reference: number,
  lexicalText = "alpha beta gamma",
  exactSymbolMatch = false,
) {
  return Array.from({ length: 50 }, (_, index) => ({
    denseScore: top - ((top - reference) * index) / 49,
    lexicalText,
    exactSymbolMatch,
  }));
}

describe("decideResultRelevance", () => {
  it("requires dense absolute, dense relative and candidate-IDF evidence together", () => {
    const accepted = decideResultRelevance(
      "alpha beta gamma",
      denseEnvelope(0.6, 0.4),
      QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
    );
    const missingCoverage = decideResultRelevance(
      "alpha beta gamma",
      denseEnvelope(0.6, 0.4, "unrelated repository text"),
      QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
    );
    expect(accepted).toMatchObject({
      status: "accepted",
      basis: "dense_absolute_relative_and_candidate_idf_coverage",
    });
    expect(missingCoverage).toMatchObject({
      status: "rejected",
      basis: "insufficient_evidence",
      candidateIdfCoverage: 0,
    });
  });

  it("does not invent a rank-50 spread or abstain when fewer scores were observed", () => {
    const decision = decideResultRelevance(
      "alpha beta",
      denseEnvelope(0.8, 0.2).slice(0, 30),
      QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
    );
    expect(decision).toMatchObject({
      status: "not_evaluated",
      basis: "dense_reference_unavailable",
      denseScoresObserved: 30,
      deepestDenseRankObserved: 30,
    });
    expect(decision.denseReferenceRankObserved).toBeUndefined();
    expect(decision.denseReferenceScore).toBeUndefined();
    expect(decision.denseSpread).toBeUndefined();
  });

  it("accepts a direct exact symbol even without the dense reference rank", () => {
    const decision = decideResultRelevance(
      "compareCodepoints",
      [{ denseScore: 0.1, lexicalText: "", exactSymbolMatch: true }],
      QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
    );
    expect(decision).toMatchObject({ status: "accepted", basis: "exact_symbol" });
  });
});

describe("measured qwen relevance envelope", () => {
  it("retains all 22 measured answerable questions under the conjunction", () => {
    // dense1, spread(1,50), idfRaw from the verifier/signals run.
    const measured = [
      [0.7432, 0.1607, 1],
      [0.6946, 0.1625, 1],
      [0.8194, 0.2148, 1],
      [0.7319, 0.1787, 1],
      [0.8188, 0.2932, 1],
      [0.6391, 0.1525, 0.3452],
      [0.4988, 0.1059, 0.494],
      [0.6585, 0.1418, 0.6618],
      [0.7388, 0.1941, 0.6213],
      [0.6876, 0.2243, 0.5082],
      [0.7115, 0.2015, 0.6889],
      [0.6238, 0.1278, 0.5981],
      [0.727, 0.163, 0.7631],
      [0.6939, 0.1292, 0.6883],
      [0.7604, 0.1317, 0.4019],
      [0.6784, 0.1717, 0.7586],
      [0.606, 0.1268, 0.7054],
      [0.8292, 0.3167, 0.5333],
      [0.6363, 0.1457, 0.652],
      [0.7541, 0.3352, 0.4968],
      [0.5536, 0.1301, 0.3533],
      [0.4579, 0.0805, 0.3446],
    ] as const;
    for (const [topDenseScore, denseSpread, candidateIdfCoverage] of measured) {
      expect(
        satisfiesNonSymbolRelevancePolicy(
          { topDenseScore, denseSpread, candidateIdfCoverage },
          QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        ),
        `${topDenseScore} / ${denseSpread} / ${candidateIdfCoverage}`,
      ).toBe(true);
    }
  });

  it("retains seven separately measured German prose truths under the same policy", () => {
    // g-corroborated plus six policy holdouts, measured against the standing
    // index. The limiting signals are reconciliation spread (0.0668625) and
    // configuration-array coverage (0.2982667), not a copied main-catalog row.
    const measured = [
      ["g-corroborated", 0.527062, 0.06996146, 0.59330879],
      ["g-policy-arrays", 0.594266, 0.13671566, 0.29826669],
      ["g-policy-extension-manifest", 0.7212806, 0.12435403, 0.37880268],
      ["g-policy-parser-cursor", 0.8389874, 0.2754999, 0.50951136],
      ["g-policy-rust", 0.5969717, 0.1192245, 0.39865643],
      ["g-policy-file-graph", 0.66424567, 0.17221057, 0.37474053],
      ["g-policy-reconciliation", 0.5875141, 0.0668625, 0.66448581],
    ] as const;
    for (const [id, topDenseScore, denseSpread, candidateIdfCoverage] of measured) {
      expect(
        satisfiesNonSymbolRelevancePolicy(
          { topDenseScore, denseSpread, candidateIdfCoverage },
          QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        ),
        `${id}: ${topDenseScore} / ${denseSpread} / ${candidateIdfCoverage}`,
      ).toBe(true);
    }
  });

  it("places calibrated boundaries between the limiting truths and clear negatives", () => {
    const policy = QWEN3_EMBEDDING_06B_RELEVANCE_POLICY;
    expect(0.0668625 - policy.minimumDenseSpread).toBeGreaterThan(0.005);
    expect(policy.minimumDenseSpread - 0.05555734).toBeGreaterThan(0.005);
    expect(0.29826669 - policy.minimumCandidateIdfCoverage).toBeGreaterThan(0.007);
    expect(policy.minimumCandidateIdfCoverage - 0.28482208).toBeGreaterThan(0.006);

    expect(
      satisfiesNonSymbolRelevancePolicy(
        { topDenseScore: 0.527062, denseSpread: 0.06996146, candidateIdfCoverage: 0.59330879 },
        policy,
      ),
    ).toBe(true);
    expect(
      satisfiesNonSymbolRelevancePolicy(
        { topDenseScore: 0.4714784, denseSpread: 0.06908035, candidateIdfCoverage: 0.28482208 },
        policy,
      ),
    ).toBe(false);
  });

  it("rejects 11/14 measured negatives and names the three compositional limits", () => {
    const measured = [
      ["n1", 0.4715, 0.0691, 0.2848],
      ["x-cobol", 0.5194, 0.1514, 0.1675],
      ["x-face", 0.3638, 0.0521, 0.1192],
      ["x-quantum", 0.4838, 0.0776, 0.1202],
      ["x-swift", 0.4908, 0.058, 0.1383],
      ["x-sap", 0.4185, 0.0337, 0.2667],
      ["x-mars", 0.3922, 0.0617, 0.4363],
      ["x-pg", 0.4868, 0.0675, 0.111],
      ["x-dnssec", 0.517, 0.0884, 0.2097],
      ["x-hipaa", 0.4303, 0.0614, 0.0307],
      ["x-bc-config", 0.5965, 0.0747, 0.2823],
      ["x-bc-fingerprint", 0.6882, 0.178, 0.4099],
      ["x-generic-en", 0.5375, 0.0803, 0.3543],
      ["x-generic-de", 0.636, 0.1066, 0.4277],
    ] as const;
    const accepted = measured
      .filter(([, topDenseScore, denseSpread, candidateIdfCoverage]) =>
        satisfiesNonSymbolRelevancePolicy(
          { topDenseScore, denseSpread, candidateIdfCoverage },
          QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        ),
      )
      .map(([id]) => id);
    expect(accepted).toEqual(["x-bc-fingerprint", "x-generic-en", "x-generic-de"]);
  });

  it("rejects when any one of the three required measurements is weak", () => {
    expect(
      satisfiesNonSymbolRelevancePolicy(
        { topDenseScore: 0.44, denseSpread: 0.2, candidateIdfCoverage: 1 },
        QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
      ),
    ).toBe(false);
    expect(
      satisfiesNonSymbolRelevancePolicy(
        { topDenseScore: 0.8, denseSpread: 0.06, candidateIdfCoverage: 1 },
        QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
      ),
    ).toBe(false);
    expect(
      satisfiesNonSymbolRelevancePolicy(
        { topDenseScore: 0.8, denseSpread: 0.2, candidateIdfCoverage: 0.29 },
        QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
      ),
    ).toBe(false);
  });
});

describe("maximumCandidateIdfCoverage", () => {
  it("uses all normalized query terms and the verifier's candidate-pool IDF formula", () => {
    const result = maximumCandidateIdfCoverage("how alpha beta", [
      "alpha beta",
      "alpha",
      "unrelated",
    ]);
    const idf = (df: number) => Math.log(1 + (3 - df + 0.5) / (df + 0.5));
    expect(result.queryTerms).toEqual(["how", "alpha", "beta"]);
    expect(result.coverage).toBeCloseTo((idf(2) + idf(1)) / (idf(0) + idf(2) + idf(1)));
  });

  it("requires term coverage in one candidate rather than unioning documents", () => {
    const split = maximumCandidateIdfCoverage("alpha beta", ["alpha", "beta"]);
    const together = maximumCandidateIdfCoverage("alpha beta", ["alpha beta", "unrelated"]);
    expect(split.coverage).toBeCloseTo(0.5);
    expect(together.coverage).toBe(1);
  });
});

describe("selectFixedRelevanceEvidencePool", () => {
  it("is invariant for retrieval limits 50, 80 and 200", () => {
    const dense = Array.from({ length: 200 }, (_, index) => `d-${index}`);
    const sparse = Array.from({ length: 200 }, (_, index) => `s-${index}`);
    const eligible = new Set([...dense, ...sparse]);
    const selections = [50, 80, 200].map((retrievalLimit) =>
      selectFixedRelevanceEvidencePool(
        [
          { branch: "dense", candidateIds: dense.slice(0, retrievalLimit) },
          { branch: "sparse", candidateIds: sparse.slice(0, retrievalLimit) },
        ],
        eligible,
        50,
      ),
    );
    expect(selections[1]).toEqual(selections[0]);
    expect(selections[2]).toEqual(selections[0]);
    expect(selections[0]?.candidateIds).toHaveLength(100);
    expect(selections[0]?.denseCandidateIds).toHaveLength(50);
  });

  it("filters residual-invalid prefix candidates without replacing them from below the boundary", () => {
    const dense = Array.from({ length: 80 }, (_, index) => `d-${index}`);
    const sparse = Array.from({ length: 80 }, (_, index) => `s-${index}`);
    const eligible = new Set([...dense, ...sparse]);
    eligible.delete("d-10");
    eligible.delete("s-20");
    const selection = selectFixedRelevanceEvidencePool(
      [
        { branch: "dense", candidateIds: dense },
        { branch: "sparse", candidateIds: sparse },
      ],
      eligible,
      50,
    );
    expect(selection.denseCandidateIds).toHaveLength(49);
    expect(selection.candidateIds).toHaveLength(98);
    expect(selection.candidateIds).not.toContain("d-10");
    expect(selection.candidateIds).not.toContain("s-20");
    expect(selection.candidateIds).not.toContain("d-50");
    expect(selection.candidateIds).not.toContain("s-50");
  });
});

describe("relevance policy validation", () => {
  it("allows calibrated overrides and an explicit opt-out", () => {
    expect(
      resolveRelevancePolicy({
        ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        minimumDenseSpread: 0.1,
      }),
    ).toMatchObject({ minimumDenseSpread: 0.1 });
    expect(resolveRelevancePolicy(false)).toBe(false);
    expect(resolveRelevancePolicy(undefined)).toBe(false);
  });

  it("validates the policy and its workspace/collection binding", () => {
    expect(
      resolveRelevancePolicyBinding({
        workspaceId: " workspace-a ",
        collection: " code-v1 ",
        policy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
      }),
    ).toMatchObject({ workspaceId: "workspace-a", collection: "code-v1" });
    expect(() =>
      resolveRelevancePolicy({
        ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        minimumCandidateIdfCoverage: 2,
      }),
    ).toThrow(/minimumCandidateIdfCoverage/u);
    expect(() =>
      resolveRelevancePolicyBinding({
        workspaceId: "",
        collection: "code-v1",
        policy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
      }),
    ).toThrow(/workspaceId/u);
  });
});
