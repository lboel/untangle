import { describe, expect, it } from "vitest";

import { assembleComplexitySnapshot } from "./assemble.js";
import type { CognitiveResult, CyclomaticResult, MaintainabilityResult } from "./types.js";

describe("assembleComplexitySnapshot", () => {
  const context = {
    snapshotId: "snap-1",
    scope: "symbol" as const,
    scopeId: "sym-1",
    repoId: "repo-1",
    refId: "repo-1:main",
    metricsVersion: "untangle-metrics-v1",
    measuredAt: "2026-01-01T00:00:00.000Z",
    parseQuality: "complete" as const,
  };

  const cyclomatic: CyclomaticResult = {
    classic: 2,
    extended: 3,
    algorithmVersion: "untangle-metrics-v1",
    contributions: [
      { line: 1, kind: "base", value: 1, countsForClassic: true, countsForExtended: true },
      { line: 2, kind: "if", value: 1, countsForClassic: true, countsForExtended: true },
      { line: 3, kind: "logical_and", value: 1, countsForClassic: false, countsForExtended: true },
    ],
  };

  const cognitive: CognitiveResult = {
    value: 3,
    algorithm: "untangle-cognitive-v1",
    contributions: [{ line: 2, kind: "if", base: 1, nestingPenalty: 2, total: 3 }],
  };

  const maintainability: MaintainabilityResult = {
    value: 75,
    raw: 128.25,
    formula: "MI = ...",
    algorithmVersion: "untangle-maintainability-v1",
  };

  it("produces a spec-shaped ComplexitySnapshotV1 and strips calculator-internal fields from cyclomatic contributors", () => {
    const snapshot = assembleComplexitySnapshot(context, {
      cyclomatic,
      cognitive,
      structural: { sloc: 10 },
      textual: { token_count: 20 },
      syntactic: { ast_node_count: 30 },
      halstead: { volume: 40 },
      maintainability,
    });

    expect(snapshot.snapshotId).toBe("snap-1");
    expect(snapshot.cyclomatic.classic).toBe(2);
    expect(snapshot.cyclomatic.extended).toBe(3);
    expect(snapshot.cyclomatic.contributors).toEqual([
      { line: 1, kind: "base", value: 1 },
      { line: 2, kind: "if", value: 1 },
      { line: 3, kind: "logical_and", value: 1 },
    ]);
    expect(snapshot.maintainabilityIndex).toBe(75);
    expect(snapshot.maintainabilityFormula).toBe("MI = ...");
    expect(snapshot.structural).toEqual({ sloc: 10 });
  });

  // Replaces the former "maps CognitiveContributionV1 to MetricContribution
  // with base/nestingPenalty preserved in note" test: that test asserted the
  // exact defect spec.md §16.4 forbids — the persisted contribution MUST
  // carry base and nesting share as structured fields, not as free text.
  it("persists cognitive contributions in the full spec.md §16.4 shape (structured base/nestingPenalty)", () => {
    const snapshot = assembleComplexitySnapshot(context, {
      cyclomatic,
      cognitive,
      structural: {},
      textual: {},
      syntactic: {},
      halstead: {},
      maintainability,
    });

    expect(snapshot.cognitive.value).toBe(3);
    expect(snapshot.cognitive.algorithm).toBe("untangle-cognitive-v1");
    expect(snapshot.cognitive.contributors).toEqual([
      { line: 2, kind: "if", base: 1, nestingPenalty: 2, total: 3 },
    ]);
    // Copied, never aliased: mutating the snapshot must not corrupt the
    // calculator result the caller may still hold.
    expect(snapshot.cognitive.contributors[0]).not.toBe(cognitive.contributions[0]);
  });

  it("persists the exact maintainability formula string (spec.md §16.9)", () => {
    const snapshot = assembleComplexitySnapshot(context, {
      cyclomatic,
      cognitive,
      structural: {},
      textual: {},
      syntactic: {},
      halstead: {},
      maintainability,
    });
    expect(snapshot.maintainabilityFormula).toBe(maintainability.formula);
  });

  it("only sets commitSha when the context provides one (exactOptionalPropertyTypes-safe)", () => {
    const withoutCommit = assembleComplexitySnapshot(context, {
      cyclomatic,
      cognitive,
      structural: {},
      textual: {},
      syntactic: {},
      halstead: {},
      maintainability,
    });
    expect("commitSha" in withoutCommit).toBe(false);

    const withCommit = assembleComplexitySnapshot(
      { ...context, commitSha: "abc123" },
      {
        cyclomatic,
        cognitive,
        structural: {},
        textual: {},
        syntactic: {},
        halstead: {},
        maintainability,
      },
    );
    expect(withCommit.commitSha).toBe("abc123");
  });
});
