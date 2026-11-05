import type { ComplexitySnapshotV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { explainSymbol } from "./explain.js";

function snapshot(overrides: Partial<ComplexitySnapshotV1> = {}): ComplexitySnapshotV1 {
  return {
    snapshotId: "snap-1",
    scope: "symbol",
    scopeId: "sym-1",
    repoId: "repo-1",
    refId: "repo-1:main",
    metricsVersion: "untangle-metrics-v1",
    measuredAt: "2026-01-01T00:00:00.000Z",
    parseQuality: "complete",
    cyclomatic: {
      classic: 3,
      extended: 3,
      contributors: [
        { line: 1, kind: "base", value: 1 },
        { line: 5, kind: "if", value: 1 },
        { line: 9, kind: "loop", value: 1 },
      ],
    },
    cognitive: {
      value: 8,
      algorithm: "untangle-cognitive-v1",
      // Structured spec.md §16.4 shape, as the snapshot now persists it.
      contributors: [
        { line: 5, kind: "if", base: 1, nestingPenalty: 1, total: 2 },
        { line: 12, kind: "else_if", base: 1, nestingPenalty: 5, total: 6 },
      ],
    },
    structural: {},
    textual: {},
    syntactic: {},
    halstead: {},
    maintainabilityIndex: 80,
    maintainabilityFormula: "MI = ...",
    ...overrides,
  };
}

describe("explainSymbol", () => {
  it("ranks contributions largest-first across both metrics", () => {
    const entries = explainSymbol(snapshot());

    expect(entries.map((e) => e.value)).toEqual([6, 2, 1, 1]);
    expect(entries[0]).toMatchObject({
      rank: 1,
      metric: "cognitive",
      kind: "else_if",
      line: 12,
      value: 6,
    });
    expect(entries.every((e, i) => e.rank === i + 1)).toBe(true);
  });

  it("excludes the synthetic cyclomatic base contribution from the ranking", () => {
    const entries = explainSymbol(snapshot());
    expect(entries.some((e) => e.kind === "base")).toBe(false);
  });

  it("respects the top limit", () => {
    const entries = explainSymbol(snapshot(), 2);
    expect(entries).toHaveLength(2);
  });

  it("produces a readable text line referencing the line number and value", () => {
    const entries = explainSymbol(snapshot(), 1);
    expect(entries[0]?.text).toContain("line 12");
    expect(entries[0]?.text).toContain("else_if");
    expect(entries[0]?.text).toContain("6");
  });
});
