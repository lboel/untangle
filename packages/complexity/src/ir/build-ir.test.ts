import type { ComplexityIRNode, RawCall } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { computeCognitive } from "../cognitive.js";
import {
  decision,
  emptyFacts,
  nestingEvent,
  range,
  symbolScope,
} from "../test-support/builders.js";

import { buildSymbolIR } from "./build-ir.js";

const FILE = "file-1";
const SYM = "sym-1";
const ALGORITHM = "untangle-cognitive-v1";

function factsWithSymbol() {
  const facts = emptyFacts();
  facts.symbolScopes = [
    symbolScope({ symbolScopeId: FILE, range: range(1, 40), kind: "file", name: "" }),
    symbolScope({ symbolScopeId: SYM, range: range(1, 30), parentScopeId: FILE }),
  ];
  return facts;
}

function kinds(nodes: readonly ComplexityIRNode[]): string[] {
  return nodes.map((n) => n.kind);
}

describe("buildSymbolIR", () => {
  it("returns undefined for an unknown symbol scope id", () => {
    expect(buildSymbolIR(factsWithSymbol(), "no-such-scope")).toBeUndefined();
  });

  it("roots a symbol scope as a non-boundary 'symbol' node and the file scope as 'root'", () => {
    const facts = factsWithSymbol();
    const symbolRoot = buildSymbolIR(facts, SYM);
    expect(symbolRoot).toMatchObject({ kind: "symbol", symbolScopeId: SYM, children: [] });
    expect(symbolRoot?.nestingBoundary).toBeUndefined();
    expect(buildSymbolIR(facts, FILE)?.kind).toBe("root");
  });

  it("merges the DecisionFact and NestingFact of one AST node into a single boundary node", () => {
    const facts = factsWithSymbol();
    const ifRange = range(2, 5);
    facts.decisions = [decision({ kind: "if", range: ifRange, symbolScopeId: SYM })];
    facts.nestingEvents = [nestingEvent({ construct: "if", range: ifRange, symbolScopeId: SYM })];

    const root = buildSymbolIR(facts, SYM) as ComplexityIRNode;

    expect(root.children).toHaveLength(1);
    const ifNode = root.children[0] as ComplexityIRNode;
    expect(ifNode.kind).toBe("decision");
    expect(ifNode.nestingBoundary).toBe(true);
    expect(ifNode.decision?.kind).toBe("if");
  });

  it("flattens an if / else-if / else-if chain to siblings although else-if ranges nest inside the if range", () => {
    // Raw AST alternate shape: elseIf2 range inside elseIf1 range inside if range.
    const facts = factsWithSymbol();
    const ifRange = range(2, 14);
    const elseIf1Range = range(6, 14);
    const elseIf2Range = range(10, 14);
    facts.decisions = [
      decision({ kind: "if", range: ifRange, symbolScopeId: SYM }),
      decision({ kind: "else_if", range: elseIf1Range, symbolScopeId: SYM }),
      decision({ kind: "else_if", range: elseIf2Range, symbolScopeId: SYM }),
    ];
    facts.nestingEvents = [
      nestingEvent({ construct: "if", range: ifRange, symbolScopeId: SYM }),
      nestingEvent({
        construct: "if",
        range: elseIf1Range,
        symbolScopeId: SYM,
        continuation: true,
      }),
      nestingEvent({
        construct: "if",
        range: elseIf2Range,
        symbolScopeId: SYM,
        continuation: true,
      }),
    ];

    const root = buildSymbolIR(facts, SYM) as ComplexityIRNode;

    // Contract (cognitive.ts "REQUIRED INPUT CONTRACT"): flat sibling run.
    expect(root.children.map((n) => n.decision?.kind)).toEqual(["if", "else_if", "else_if"]);
    const result = computeCognitive(root, ALGORITHM);
    // All chain members share ambient depth 0 — no extra nesting increment.
    expect(result.contributions.map((c) => c.nestingPenalty)).toEqual([0, 0, 0]);
    expect(result.value).toBe(3);
  });

  it("keeps a genuinely nested if (inside another if's body) nested, and flattens only its own chain", () => {
    const facts = factsWithSymbol();
    const outerIfRange = range(2, 20);
    const innerIfRange = range(4, 12); // inside the outer if's BODY
    const innerElseIfRange = range(8, 12); // continuation of the INNER if
    facts.decisions = [
      decision({ kind: "if", range: outerIfRange, symbolScopeId: SYM }),
      decision({ kind: "if", range: innerIfRange, symbolScopeId: SYM }),
      decision({ kind: "else_if", range: innerElseIfRange, symbolScopeId: SYM }),
    ];
    facts.nestingEvents = [
      nestingEvent({ construct: "if", range: outerIfRange, symbolScopeId: SYM }),
      nestingEvent({ construct: "if", range: innerIfRange, symbolScopeId: SYM }),
      nestingEvent({
        construct: "if",
        range: innerElseIfRange,
        symbolScopeId: SYM,
        continuation: true,
      }),
    ];

    const root = buildSymbolIR(facts, SYM) as ComplexityIRNode;

    expect(root.children).toHaveLength(1); // only the outer if at top level
    const outerIf = root.children[0] as ComplexityIRNode;
    // Inner chain: flattened to siblings OF EACH OTHER, but still inside the outer if.
    expect(outerIf.children.map((n) => n.decision?.kind)).toEqual(["if", "else_if"]);

    const result = computeCognitive(root, ALGORITHM);
    expect(result.contributions.map((c) => c.nestingPenalty)).toEqual([0, 1, 1]);
  });

  it("hoists a logical group out of its guard's condition to the guard's own ambient depth", () => {
    // if (a && b) { ... } — the && range nests inside the if range, but the
    // group must score at the if's ambient depth (golden convention in
    // cognitive.test.ts), so it becomes a sibling placed before the if.
    const facts = factsWithSymbol();
    const ifRange = range(2, 6);
    const andRange = range(2, 2);
    facts.decisions = [
      decision({ kind: "if", range: ifRange, symbolScopeId: SYM }),
      decision({
        kind: "logical_and",
        range: andRange,
        symbolScopeId: SYM,
        countsForClassic: false,
        logicalGroupId: "g1",
      }),
    ];
    facts.nestingEvents = [nestingEvent({ construct: "if", range: ifRange, symbolScopeId: SYM })];

    const root = buildSymbolIR(facts, SYM) as ComplexityIRNode;

    expect(kinds(root.children)).toEqual(["logical_sequence", "decision"]);
    const result = computeCognitive(root, ALGORITHM);
    expect(result.contributions).toEqual([
      { line: 2, kind: "logical_and", base: 1, nestingPenalty: 0, total: 1 },
      { line: 2, kind: "if", base: 1, nestingPenalty: 0, total: 1 },
    ]);
  });

  it("includes descendant lambda scopes as nesting boundaries carrying their own facts", () => {
    const facts = factsWithSymbol();
    const lambdaScopeId = "sym-1-lambda";
    const lambdaRange = range(5, 9);
    const innerIfRange = range(6, 8);
    facts.symbolScopes.push(
      symbolScope({
        symbolScopeId: lambdaScopeId,
        range: lambdaRange,
        parentScopeId: SYM,
        kind: "function",
        name: "<anonymous>",
      }),
    );
    // The adapter emits the lambda nesting event in the ENCLOSING scope...
    facts.nestingEvents = [
      nestingEvent({ construct: "lambda", range: lambdaRange, symbolScopeId: SYM }),
      // ...and the lambda's own control flow in the LAMBDA's scope.
      nestingEvent({ construct: "if", range: innerIfRange, symbolScopeId: lambdaScopeId }),
    ];
    facts.decisions = [decision({ kind: "if", range: innerIfRange, symbolScopeId: lambdaScopeId })];

    const root = buildSymbolIR(facts, SYM) as ComplexityIRNode;

    expect(root.children).toHaveLength(1); // deduplicated: ONE lambda node, not two
    const lambda = root.children[0] as ComplexityIRNode;
    expect(lambda.kind).toBe("lambda");
    expect(lambda.nestingBoundary).toBe(true);
    expect(kinds(lambda.children)).toEqual(["decision"]);

    const result = computeCognitive(root, ALGORITHM);
    // The lambda itself contributes nothing; the if inside it is one level deep.
    expect(result.contributions).toEqual([
      { line: 6, kind: "if", base: 1, nestingPenalty: 1, total: 1 + 1 },
    ]);
  });

  it("marks direct self-recursion when calls are supplied, flat regardless of nesting", () => {
    const facts = factsWithSymbol();
    const scope = facts.symbolScopes[1];
    if (scope) scope.name = "walk";
    const loopRange = range(2, 10);
    facts.decisions = [decision({ kind: "loop", range: loopRange, symbolScopeId: SYM })];
    facts.nestingEvents = [
      nestingEvent({ construct: "loop", range: loopRange, symbolScopeId: SYM }),
    ];
    const calls: RawCall[] = [
      { calleeName: "walk", callerScopeId: SYM, range: range(5, 5) }, // recursive
      { calleeName: "other", callerScopeId: SYM, range: range(6, 6) }, // not recursive
      { calleeName: "walk", callerScopeId: SYM, qualifier: "helper", range: range(7, 7) }, // qualified away
    ];

    const withCalls = buildSymbolIR(facts, SYM, { calls }) as ComplexityIRNode;
    const result = computeCognitive(withCalls, ALGORITHM);
    expect(result.contributions).toEqual([
      { line: 2, kind: "loop", base: 1, nestingPenalty: 0, total: 1 },
      { line: 5, kind: "recursion", base: 1, nestingPenalty: 0, total: 1 },
    ]);

    // Without calls, recursion is simply not marked (spec.md §16.4: KANN).
    const withoutCalls = buildSymbolIR(facts, SYM) as ComplexityIRNode;
    expect(computeCognitive(withoutCalls, ALGORITHM).value).toBe(1);
  });

  it("models a switch head as a non-contributing boundary and cases as contributing boundaries", () => {
    const facts = factsWithSymbol();
    const switchRange = range(2, 12);
    const case1Range = range(3, 5);
    const case2Range = range(6, 8);
    facts.nestingEvents = [
      nestingEvent({ construct: "switch", range: switchRange, symbolScopeId: SYM }),
    ];
    facts.decisions = [
      decision({ kind: "case", range: case1Range, symbolScopeId: SYM }),
      decision({ kind: "case", range: case2Range, symbolScopeId: SYM }),
    ];

    const root = buildSymbolIR(facts, SYM) as ComplexityIRNode;

    const switchNode = root.children[0] as ComplexityIRNode;
    expect(switchNode.kind).toBe("switch");
    expect(kinds(switchNode.children)).toEqual(["case", "case"]);
    const result = computeCognitive(root, ALGORITHM);
    expect(result.contributions.map((c) => c.total)).toEqual([2, 2]); // 1 + depth 1 each
  });
});
