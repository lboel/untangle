import { validateScoreBreakdown } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import type { FusionResult } from "./fusion.js";
import type { ScoringContext } from "./scoring.js";
import {
  COMPLEXITY_REFERENCE_COGNITIVE,
  MAX_BOOST_SHARE,
  assembleScoreBreakdown,
  clampBoosts,
  complexityModifierRawValue,
  recencyDecay,
} from "./scoring.js";
import { candidateFixture, payloadFixture } from "./testing/candidates.js";

const fusion: FusionResult = {
  id: "chunk-1",
  rrf: 0.03,
  normalized: 0.8,
  ranks: { dense: 1, lexical: 2 },
};

function context(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    queryText: "charge",
    weights: {
      exactSymbol: 0.15,
      exactPath: 0.1,
      repoPriority: 0.05,
      graphProximity: 0.1,
      recency: 0.05,
      duplicatePenalty: 0.2,
    },
    complexityBias: "none",
    repoPriorities: {},
    graphProximity: new Map(),
    recencyHalfLifeDays: 30,
    ...overrides,
  };
}

describe("assembleScoreBreakdown", () => {
  it("always carries exactly one base_hybrid and passes the domain validation", () => {
    const breakdown = assembleScoreBreakdown(candidateFixture(), fusion, context());
    const validation = validateScoreBreakdown(breakdown);
    expect(validation.issues).toEqual([]);
    expect(breakdown.components.filter((c) => c.kind === "base_hybrid")).toHaveLength(1);
  });

  it("final is exactly the sum of the contributions", () => {
    const breakdown = assembleScoreBreakdown(
      candidateFixture({ symbol_name: "charge" }),
      fusion,
      context(),
    );
    const sum = breakdown.components.reduce((total, c) => total + c.contribution, 0);
    expect(breakdown.final).toBeCloseTo(sum, 12);
  });

  it("adds an exact_symbol_boost with an evidence string", () => {
    const breakdown = assembleScoreBreakdown(
      candidateFixture({ symbol_name: "charge" }),
      fusion,
      context(),
    );
    const boost = breakdown.components.find((c) => c.kind === "exact_symbol_boost");
    expect(boost?.rawValue).toBe(1);
    expect(boost?.evidence).toContain("charge");
  });

  it("omits a component entirely rather than emitting a zero one", () => {
    const breakdown = assembleScoreBreakdown(
      candidateFixture({ symbol_name: "unrelated", file_path: "src/z.ts" }),
      fusion,
      context(),
    );
    expect(breakdown.components.map((c) => c.kind)).toEqual(["base_hybrid"]);
  });

  it("adds an exact_path_boost for a path segment hit", () => {
    const breakdown = assembleScoreBreakdown(
      candidateFixture({ file_path: "src/charge/index.ts" }),
      fusion,
      context(),
    );
    expect(breakdown.components.find((c) => c.kind === "exact_path_boost")?.rawValue).toBe(0.75);
  });

  it("adds a repo_priority_boost only for a configured repository", () => {
    const withPriority = assembleScoreBreakdown(
      candidateFixture(),
      fusion,
      context({ repoPriorities: { "repo-a": 0.5 } }),
    );
    expect(withPriority.components.some((c) => c.kind === "repo_priority_boost")).toBe(true);
    const without = assembleScoreBreakdown(candidateFixture(), fusion, context());
    expect(without.components.some((c) => c.kind === "repo_priority_boost")).toBe(false);
  });

  it("adds a graph_proximity_boost from the injected lookup", () => {
    const breakdown = assembleScoreBreakdown(
      candidateFixture({ symbol_id: "sym-1" }),
      fusion,
      context({ graphProximity: new Map([["sym-1", 0.4]]) }),
    );
    expect(breakdown.components.find((c) => c.kind === "graph_proximity_boost")?.rawValue).toBe(
      0.4,
    );
  });

  it("adds a recency_boost only when the payload carries a change timestamp AND a clock is wired", () => {
    const candidate = candidateFixture({}, {}, { changed_at_epoch_ms: 1_000 });
    const withClock = assembleScoreBreakdown(candidate, fusion, context({ nowEpochMs: 1_000 }));
    expect(withClock.components.find((c) => c.kind === "recency_boost")?.rawValue).toBe(1);
    const withoutClock = assembleScoreBreakdown(candidate, fusion, context());
    expect(withoutClock.components.some((c) => c.kind === "recency_boost")).toBe(false);
  });

  it("keeps the complexity modifier out of the default ranking", () => {
    const breakdown = assembleScoreBreakdown(
      candidateFixture({ cognitive: 30 }),
      fusion,
      context(),
    );
    expect(breakdown.components.some((c) => c.kind === "complexity_modifier")).toBe(false);
  });

  it("adds a signed complexity_modifier when the request asks for it", () => {
    const simple = assembleScoreBreakdown(
      candidateFixture({ cognitive: 0 }),
      fusion,
      context({ complexityBias: "prefer-simple" }),
    );
    expect(simple.components.find((c) => c.kind === "complexity_modifier")?.rawValue).toBe(1);
    const complex = assembleScoreBreakdown(
      candidateFixture({ cognitive: COMPLEXITY_REFERENCE_COGNITIVE }),
      fusion,
      context({ complexityBias: "prefer-simple" }),
    );
    expect(complex.components.find((c) => c.kind === "complexity_modifier")?.rawValue).toBe(-1);
  });

  it("records a duplicate_penalty as a negative contribution", () => {
    const breakdown = assembleScoreBreakdown(candidateFixture(), fusion, context(), 0.5);
    const penalty = breakdown.components.find((c) => c.kind === "duplicate_penalty");
    expect(penalty?.contribution).toBeLessThan(0);
  });

  it("exposes the per-branch inputs so the fusion can be recomputed", () => {
    const candidate = candidateFixture(
      {},
      { denseScore: 0.9, denseRank: 1, lexicalScore: 3.2, lexicalRank: 2, symbolRank: 1 },
    );
    const breakdown = assembleScoreBreakdown(candidate, fusion, context());
    expect(breakdown.inputs).toMatchObject({
      dense: 0.9,
      denseRank: 1,
      lexicalScore: 3.2,
      lexicalRank: 2,
      sparseRank: 2,
      symbolRank: 1,
      rrf: 0.03,
    });
  });

  it("clamps boosts so they never outweigh the base score, and says so", () => {
    const breakdown = assembleScoreBreakdown(
      candidateFixture({ symbol_name: "charge", file_path: "charge" }),
      { ...fusion, normalized: 0.01 },
      context({
        weights: {
          exactSymbol: 5,
          exactPath: 5,
          repoPriority: 0,
          graphProximity: 0,
          recency: 0,
          duplicatePenalty: 0,
        },
      }),
    );
    expect(breakdown.clamped).toBe(true);
    expect(breakdown.clampReason).toContain("spec.md §13.3");
    const validation = validateScoreBreakdown(breakdown);
    expect(validation.issues).toEqual([]);
    expect(validation.baseShare).toBeGreaterThanOrEqual(1 / (1 + MAX_BOOST_SHARE) - 1e-9);
  });
});

describe("clampBoosts", () => {
  it("leaves boosts within budget untouched", () => {
    const base = { kind: "base_hybrid" as const, rawValue: 1, weight: 1, contribution: 1 };
    const boosts = [
      { kind: "exact_path_boost" as const, rawValue: 1, weight: 0.1, contribution: 0.1 },
    ];
    const result = clampBoosts(base, boosts);
    expect(result.clamped).toBe(false);
    expect(result.boosts).toEqual(boosts);
  });

  it("scales the WEIGHT, so contribution = rawValue * weight stays true", () => {
    const base = { kind: "base_hybrid" as const, rawValue: 0.1, weight: 1, contribution: 0.1 };
    const boosts = [
      { kind: "exact_symbol_boost" as const, rawValue: 1, weight: 1, contribution: 1 },
    ];
    const result = clampBoosts(base, boosts);
    expect(result.clamped).toBe(true);
    const boost = result.boosts[0];
    expect(boost?.contribution).toBeCloseTo((boost?.rawValue ?? 0) * (boost?.weight ?? 0), 12);
  });

  it("does not divide by zero when there are no boosts", () => {
    const base = { kind: "base_hybrid" as const, rawValue: 0, weight: 1, contribution: 0 };
    expect(clampBoosts(base, []).clamped).toBe(false);
  });
});

describe("recencyDecay", () => {
  it("is 1 for something that just changed", () => {
    expect(recencyDecay(0, 30)).toBe(1);
  });

  it("is 0.5 after exactly one half-life", () => {
    expect(recencyDecay(30 * 24 * 60 * 60 * 1000, 30)).toBeCloseTo(0.5, 12);
  });

  it("is 0 for a non-positive half-life instead of NaN", () => {
    expect(recencyDecay(1000, 0)).toBe(0);
  });
});

describe("complexityModifierRawValue", () => {
  it("is null without a bias or without a measured value", () => {
    expect(complexityModifierRawValue(payloadFixture({ cognitive: 10 }), "none")).toBeNull();
    expect(complexityModifierRawValue(payloadFixture(), "prefer-simple")).toBeNull();
  });

  it("is symmetric between the two biases", () => {
    const payload = payloadFixture({ cognitive: 10 });
    const simple = complexityModifierRawValue(payload, "prefer-simple") ?? 0;
    const complex = complexityModifierRawValue(payload, "prefer-complex") ?? 0;
    expect(simple).toBeCloseTo(-complex, 12);
  });

  it("saturates beyond the reference value", () => {
    expect(
      complexityModifierRawValue(
        payloadFixture({ cognitive: COMPLEXITY_REFERENCE_COGNITIVE * 10 }),
        "prefer-simple",
      ),
    ).toBe(-1);
  });
});
