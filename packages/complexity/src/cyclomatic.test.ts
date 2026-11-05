import { describe, expect, it } from "vitest";

import { computeCyclomatic } from "./cyclomatic.js";
import { decision, emptyFacts, range } from "./test-support/builders.js";

const SCOPE = "sym1";
const VERSION = "untangle-metrics-v1";

describe("computeCyclomatic", () => {
  it("returns classic=1 for a symbol with no decisions (M = 1 + 0)", () => {
    const result = computeCyclomatic(emptyFacts(), 1, VERSION);
    expect(result.classic).toBe(1);
    expect(result.extended).toBe(1);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]).toMatchObject({ kind: "base", value: 1 });
  });

  it("hand-computed: if, else-if, for, catch, ternary, 2 case arms and a guard all count for classic", () => {
    // M = 1 (base) + 8 decisions = 9
    const facts = emptyFacts();
    facts.decisions = [
      decision({ kind: "if", range: range(2, 2), symbolScopeId: SCOPE }),
      decision({ kind: "else_if", range: range(3, 3), symbolScopeId: SCOPE }),
      decision({ kind: "loop", range: range(4, 4), symbolScopeId: SCOPE }),
      decision({ kind: "catch", range: range(5, 5), symbolScopeId: SCOPE }),
      decision({ kind: "ternary", range: range(6, 6), symbolScopeId: SCOPE }),
      decision({ kind: "case", range: range(7, 7), symbolScopeId: SCOPE }),
      decision({ kind: "case", range: range(8, 8), symbolScopeId: SCOPE }),
      decision({ kind: "guard", range: range(9, 9), symbolScopeId: SCOPE }),
    ];

    const result = computeCyclomatic(facts, 1, VERSION);

    expect(result.classic).toBe(9);
    expect(result.contributions).toHaveLength(9); // base + 8 decisions
  });

  it("adds independent logical-operator groups to extended but not to classic", () => {
    // Same 7 decisions as spec.md §16.2 example, plus one && group of 3 operators
    // (spec.md §16.3): classic stays 1+7=8, extended becomes 8+1=9.
    const facts = emptyFacts();
    facts.decisions = [
      decision({ kind: "if", range: range(2, 2), symbolScopeId: SCOPE }),
      decision({ kind: "loop", range: range(3, 3), symbolScopeId: SCOPE }),
      decision({ kind: "catch", range: range(4, 4), symbolScopeId: SCOPE }),
      decision({ kind: "ternary", range: range(5, 5), symbolScopeId: SCOPE }),
      decision({ kind: "case", range: range(6, 6), symbolScopeId: SCOPE }),
      decision({ kind: "case", range: range(7, 7), symbolScopeId: SCOPE }),
      decision({ kind: "guard", range: range(8, 8), symbolScopeId: SCOPE }),
      decision({
        kind: "logical_and",
        range: range(9, 9),
        symbolScopeId: SCOPE,
        countsForClassic: false,
        countsForExtended: true,
        logicalGroupId: "grp-1",
      }),
      decision({
        kind: "logical_and",
        range: range(9, 9),
        symbolScopeId: SCOPE,
        countsForClassic: false,
        countsForExtended: true,
        logicalGroupId: "grp-1",
      }),
      decision({
        kind: "logical_and",
        range: range(9, 9),
        symbolScopeId: SCOPE,
        countsForClassic: false,
        countsForExtended: true,
        logicalGroupId: "grp-1",
      }),
    ];

    const result = computeCyclomatic(facts, 1, VERSION);

    expect(result.classic).toBe(8);
    expect(result.extended).toBe(9);
    // The 3 grouped facts collapse into a single contribution.
    expect(result.contributions.filter((c) => c.kind === "logical_and")).toHaveLength(1);
  });

  it("counts two independent logical groups as two extended points", () => {
    const facts = emptyFacts();
    facts.decisions = [
      decision({
        kind: "logical_and",
        range: range(2, 2),
        symbolScopeId: SCOPE,
        countsForClassic: false,
        countsForExtended: true,
        logicalGroupId: "grp-1",
      }),
      decision({
        kind: "logical_or",
        range: range(3, 3),
        symbolScopeId: SCOPE,
        countsForClassic: false,
        countsForExtended: true,
        logicalGroupId: "grp-2",
      }),
    ];

    const result = computeCyclomatic(facts, 1, VERSION);

    expect(result.classic).toBe(1);
    expect(result.extended).toBe(3);
  });

  it("ignores a decision fact that counts for neither total", () => {
    const facts = emptyFacts();
    facts.decisions = [
      decision({
        kind: "pattern_alternative",
        range: range(2, 2),
        symbolScopeId: SCOPE,
        countsForClassic: false,
        countsForExtended: false,
      }),
    ];

    const result = computeCyclomatic(facts, 1, VERSION);

    expect(result.classic).toBe(1);
    expect(result.extended).toBe(1);
    expect(result.contributions).toHaveLength(1);
  });

  it("invariant: sum of classic-flagged contribution values equals classic total, same for extended", () => {
    const facts = emptyFacts();
    facts.decisions = [
      decision({ kind: "if", range: range(2, 2), symbolScopeId: SCOPE }),
      decision({
        kind: "logical_and",
        range: range(3, 3),
        symbolScopeId: SCOPE,
        countsForClassic: false,
        countsForExtended: true,
        logicalGroupId: "grp-1",
      }),
    ];

    const result = computeCyclomatic(facts, 1, VERSION);

    const classicSum = result.contributions
      .filter((c) => c.countsForClassic)
      .reduce((s, c) => s + c.value, 0);
    const extendedSum = result.contributions
      .filter((c) => c.countsForExtended)
      .reduce((s, c) => s + c.value, 0);
    expect(classicSum).toBe(result.classic);
    expect(extendedSum).toBe(result.extended);
  });
});
