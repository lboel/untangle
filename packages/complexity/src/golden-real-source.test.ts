/**
 * Golden tests over REAL TypeScript and JavaScript source text, parsed by
 * the actual language adapters (no hand-built facts, no hand-built IR).
 * They pin down concrete cyclomatic AND cognitive VALUES with hand-computed
 * expectations and full contribution lists — this is the end-to-end proof
 * that the ComplexityFacts -> ComplexityIRNode bridge (`buildSymbolIR`)
 * fulfills `computeCognitive`'s input contract on real code, that
 * `ast_branching_factor_avg`/`_max` are computed for real files, and that
 * the persisted snapshot carries the maintainability formula and the
 * structured cognitive contributions (spec.md §16.4, §16.8, §16.9).
 *
 * Every expected number below is derived by hand in the comments next to
 * the fixture source.
 */
import type { ComplexityFacts, LanguageAdapter, RawCall, SourceFile } from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import { createJavaScriptAdapter, createTypeScriptAdapter } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { assembleComplexitySnapshot } from "./assemble.js";
import { computeCognitive } from "./cognitive.js";
import { computeCyclomatic } from "./cyclomatic.js";
import { buildSymbolIR } from "./ir/build-ir.js";
import { MAINTAINABILITY_FORMULA, computeMaintainability } from "./maintainability.js";
import { selectSymbolFacts } from "./scope.js";
import { computeSyntactic } from "./syntactic.js";

const ALGORITHM = "untangle-cognitive-v1";
const METRICS_VERSION = "untangle-metrics-v1";

interface Analyzed {
  facts: ComplexityFacts;
  calls: RawCall[];
}

function analyze(adapter: LanguageAdapter, languageId: string, content: string): Analyzed {
  const source: SourceFile = {
    fileId: `file-${languageId}`,
    repoId: "repo-golden",
    refId: "repo-golden:main",
    path: languageId === "typescript" ? "src/fixture.ts" : "src/fixture.js",
    languageId,
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const parseResult = adapter.parse(source);
  expect(parseResult.parseQuality).toBe("complete");
  const ast = parseResult.ast;
  if (ast === null) throw new Error("unexpected null AST for a complete parse");
  return { facts: adapter.computeComplexity(ast), calls: adapter.extractCalls(ast) };
}

function scopeIdByName(facts: ComplexityFacts, name: string): string {
  const scope = facts.symbolScopes.find((s) => s.name === name);
  if (scope === undefined) throw new Error(`no symbol scope named ${name}`);
  return scope.symbolScopeId;
}

// ---------------------------------------------------------------------------
// TypeScript golden: triple nesting, else-if chain, logical-AND sequence,
// and a lambda with a ternary — the mandatory case of the work order.
// ---------------------------------------------------------------------------

// Line-by-line cognitive expectation (untangle-cognitive-v1):
//   line 3  loop        depth 0 -> 1+0 = 1
//   line 4  if          depth 1 -> 1+1 = 2
//   line 5  logical_and depth 2 -> 1+2 = 3   (condition group of the line-5 if)
//   line 5  if          depth 2 -> 1+2 = 3
//   line 7  else_if     depth 2 -> 1+2 = 3   (sibling of the line-5 if: NO extra nesting)
//   line 8  ternary     depth 4 -> 1+4 = 5   (boundaries above it: loop -> if(4)
//                                             -> else_if(7) -> lambda = depth 4)
//   total 17
const TS_SOURCE = [
  "export function processItems(items: number[]): number {", // 1
  "  let total = 0;", //                                         2
  "  for (const item of items) {", //                            3
  "    if (item !== 0) {", //                                    4
  "      if (item > 10 && item < 100) {", //                     5
  "        total += item;", //                                   6
  "      } else if (item < 0) {", //                             7
  "        const scale = (x: number) => (x > -5 ? 1 : 2);", //   8
  "        total -= scale(item);", //                            9
  "      }", //                                                 10
  "    }", //                                                   11
  "  }", //                                                     12
  "  return total;", //                                         13
  "}", //                                                       14
  "",
].join("\n");

describe("golden: real TypeScript source end to end", () => {
  const { facts, calls } = analyze(createTypeScriptAdapter(), "typescript", TS_SOURCE);
  const symbolId = scopeIdByName(facts, "processItems");

  it("computes the hand-computed cognitive value 17 with the full contribution list", () => {
    const root = buildSymbolIR(facts, symbolId, { calls });
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("unreachable");

    const result = computeCognitive(root, ALGORITHM);

    expect(result.contributions).toEqual([
      { line: 3, kind: "loop", base: 1, nestingPenalty: 0, total: 1 },
      { line: 4, kind: "if", base: 1, nestingPenalty: 1, total: 2 },
      { line: 5, kind: "logical_and", base: 1, nestingPenalty: 2, total: 3 },
      { line: 5, kind: "if", base: 1, nestingPenalty: 2, total: 3 },
      { line: 7, kind: "else_if", base: 1, nestingPenalty: 2, total: 3 },
      { line: 8, kind: "ternary", base: 1, nestingPenalty: 4, total: 5 },
    ]);
    expect(result.value).toBe(17);
  });

  it("satisfies sum(contributions.total) === total on real source", () => {
    const root = buildSymbolIR(facts, symbolId, { calls });
    if (root === undefined) throw new Error("unreachable");
    const result = computeCognitive(root, ALGORITHM);
    const sum = result.contributions.reduce((s, c) => s + c.total, 0);
    expect(sum).toBe(result.value);
  });

  it("computes hand-computed cyclomatic values: classic 5, extended 6 for the function", () => {
    // Own facts only (the arrow's ternary belongs to the arrow's own scope):
    // classic  = 1 (base) + loop + if + if + else_if           = 5
    // extended = classic + one independent && group            = 6
    const symbolFacts = selectSymbolFacts(facts, symbolId);
    const result = computeCyclomatic(symbolFacts, 1, METRICS_VERSION);

    expect(result.classic).toBe(5);
    expect(result.extended).toBe(6);
    expect(
      result.contributions.map((c) => ({ line: c.line, kind: c.kind, value: c.value })),
    ).toEqual([
      { line: 1, kind: "base", value: 1 },
      { line: 3, kind: "loop", value: 1 },
      { line: 4, kind: "if", value: 1 },
      { line: 5, kind: "if", value: 1 },
      { line: 5, kind: "logical_and", value: 1 },
      { line: 7, kind: "else_if", value: 1 },
    ]);
  });

  it("scores the lambda's own scope separately: cyclomatic classic 2 (base + ternary)", () => {
    const lambdaId = scopeIdByName(facts, "scale");
    const result = computeCyclomatic(selectSymbolFacts(facts, lambdaId), 8, METRICS_VERSION);
    expect(result.classic).toBe(2);
    expect(result.extended).toBe(2);
  });

  it("computes ast_branching_factor_avg/max for the real file without any IR argument", () => {
    const syntactic = computeSyntactic(facts, 13);
    const avg = syntactic.metrics["ast_branching_factor_avg"];
    const max = syntactic.metrics["ast_branching_factor_max"];
    expect(avg).toBeDefined();
    expect(max).toBeDefined();
    // Exact values depend on the grammar's node shapes; the structural sanity
    // bounds below are grammar-stable: a pre-order forest has avg < 1
    // (sum of child counts = nodes minus roots) and this fixture certainly
    // contains a node with >= 3 children (e.g. the function body block).
    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(1);
    expect(max).toBeGreaterThanOrEqual(3);
  });

  it("persists structured cognitive contributions and the maintainability formula in the snapshot", () => {
    const root = buildSymbolIR(facts, symbolId, { calls });
    if (root === undefined) throw new Error("unreachable");
    const cognitive = computeCognitive(root, ALGORITHM);
    const symbolFacts = selectSymbolFacts(facts, symbolId);
    const cyclomatic = computeCyclomatic(symbolFacts, 1, METRICS_VERSION);
    const syntactic = computeSyntactic(facts, 13);
    const maintainability = computeMaintainability({
      halsteadVolume: 250,
      cyclomaticClassic: cyclomatic.classic,
      sloc: 13,
    });

    const snapshot = assembleComplexitySnapshot(
      {
        snapshotId: "snap-golden-ts",
        scope: "symbol",
        scopeId: symbolId,
        repoId: "repo-golden",
        refId: "repo-golden:main",
        metricsVersion: METRICS_VERSION,
        measuredAt: "2026-01-01T00:00:00.000Z",
        parseQuality: "complete",
      },
      {
        cyclomatic,
        cognitive,
        structural: { sloc: 13 },
        textual: {},
        syntactic: syntactic.metrics,
        halstead: { volume: 250 },
        maintainability,
      },
    );

    // spec.md §16.4: every persisted contribution carries base and nesting share.
    expect(snapshot.cognitive.contributors).toEqual(cognitive.contributions);
    expect(
      snapshot.cognitive.contributors.every(
        (c) => typeof c.base === "number" && typeof c.nestingPenalty === "number",
      ),
    ).toBe(true);
    // spec.md §16.9: the formula used MUST be output explicitly.
    expect(snapshot.maintainabilityFormula).toBe(MAINTAINABILITY_FORMULA);
    expect(snapshot.syntactic["ast_branching_factor_avg"]).toBeDefined();
    expect(snapshot.syntactic["ast_branching_factor_max"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript golden: switch/case, logical-OR sequence in a ternary condition,
// loop, catch, and direct recursion.
// ---------------------------------------------------------------------------

// Cognitive expectation (untangle-cognitive-v1; the switch head is a
// non-contributing boundary, each case contributes at depth 1 — documented in
// build-ir.ts / cognitive.ts):
//   line 3  case        depth 1 -> 1+1 = 2
//   line 5  case        depth 1 -> 1+1 = 2
//   line 6  logical_or  depth 2 -> 1+2 = 3   (condition group of the ternary)
//   line 6  ternary     depth 2 -> 1+2 = 3
//   line 11 loop        depth 0 -> 1+0 = 1
//   line 14 catch       depth 0 -> 1+0 = 1
//   line 15 recursion   flat    -> 1+0 = 1
//   total 13
const JS_SOURCE = [
  "function classify(value, attempts) {", //                       1
  "  switch (value.kind) {", //                                    2
  "    case 'alpha':", //                                          3
  "      return 1;", //                                            4
  "    case 'beta':", //                                           5
  "      return value.flag || value.fallback ? 2 : 3;", //         6
  "    default:", //                                               7
  "      break;", //                                               8
  "  }", //                                                        9
  "  try {", //                                                   10
  "    while (attempts > 0) {", //                                11
  "      attempts -= 1;", //                                      12
  "    }", //                                                     13
  "  } catch (error) {", //                                       14
  "    return classify(value, attempts - 1);", //                 15
  "  }", //                                                       16
  "  return 0;", //                                               17
  "}", //                                                         18
  "",
].join("\n");

describe("golden: real JavaScript source end to end", () => {
  const { facts, calls } = analyze(createJavaScriptAdapter(), "javascript", JS_SOURCE);
  const symbolId = scopeIdByName(facts, "classify");

  it("computes the hand-computed cognitive value 13 with the full contribution list", () => {
    const root = buildSymbolIR(facts, symbolId, { calls });
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("unreachable");

    const result = computeCognitive(root, ALGORITHM);

    expect(result.contributions).toEqual([
      { line: 3, kind: "case", base: 1, nestingPenalty: 1, total: 2 },
      { line: 5, kind: "case", base: 1, nestingPenalty: 1, total: 2 },
      { line: 6, kind: "logical_or", base: 1, nestingPenalty: 2, total: 3 },
      { line: 6, kind: "ternary", base: 1, nestingPenalty: 2, total: 3 },
      { line: 11, kind: "loop", base: 1, nestingPenalty: 0, total: 1 },
      { line: 14, kind: "catch", base: 1, nestingPenalty: 0, total: 1 },
      { line: 15, kind: "recursion", base: 1, nestingPenalty: 0, total: 1 },
    ]);
    expect(result.value).toBe(13);

    const sum = result.contributions.reduce((s, c) => s + c.total, 0);
    expect(sum).toBe(result.value);
  });

  it("computes hand-computed cyclomatic values: classic 6, extended 7", () => {
    // classic  = 1 (base) + case + case + ternary + loop + catch = 6
    // extended = classic + one independent || group              = 7
    const result = computeCyclomatic(selectSymbolFacts(facts, symbolId), 1, METRICS_VERSION);
    expect(result.classic).toBe(6);
    expect(result.extended).toBe(7);
  });

  it("computes ast_branching_factor_avg/max for the real JavaScript file", () => {
    const syntactic = computeSyntactic(facts, 17);
    expect(syntactic.metrics["ast_branching_factor_avg"]).toBeGreaterThan(0);
    expect(syntactic.metrics["ast_branching_factor_max"]).toBeGreaterThanOrEqual(3);
  });
});
