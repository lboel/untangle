import type { ComplexityIRNode } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { assertCognitiveInvariant, computeCognitive } from "./cognitive.js";
import { decision, ir, range } from "./test-support/builders.js";

const SCOPE = "sym1";
const ALGORITHM = "untangle-cognitive-v1";

describe("computeCognitive", () => {
  it("scores a flat if with no nesting as base(1) + nesting(0) = 1", () => {
    const root = ir("symbol", range(1, 3), SCOPE, {
      children: [
        ir("decision", range(1, 3), SCOPE, {
          decision: decision({ kind: "if", range: range(1, 3), symbolScopeId: SCOPE }),
          nestingBoundary: true,
        }),
      ],
    });

    const result = computeCognitive(root, ALGORITHM);

    expect(result.value).toBe(1);
    expect(result.contributions).toEqual([
      { line: 1, kind: "if", base: 1, nestingPenalty: 0, total: 1 },
    ]);
  });

  it("gives a nested if the ambient depth as its nesting penalty", () => {
    // if (a) { if (b) { ... } }
    const innerIf = ir("decision", range(2, 2), SCOPE, {
      decision: decision({ kind: "if", range: range(2, 2), symbolScopeId: SCOPE }),
      nestingBoundary: true,
    });
    const outerIf = ir("decision", range(1, 3), SCOPE, {
      decision: decision({ kind: "if", range: range(1, 3), symbolScopeId: SCOPE }),
      nestingBoundary: true,
      children: [ir("block", range(2, 2), SCOPE, { children: [innerIf] })],
    });
    const root = ir("symbol", range(1, 3), SCOPE, { children: [outerIf] });

    const result = computeCognitive(root, ALGORITHM);

    // outer: base 1 + nesting 0 = 1; inner: base 1 + nesting 1 = 2 -> total 3
    expect(result.value).toBe(3);
    expect(result.contributions).toEqual([
      { line: 1, kind: "if", base: 1, nestingPenalty: 0, total: 1 },
      { line: 2, kind: "if", base: 1, nestingPenalty: 1, total: 2 },
    ]);
  });

  it("does not give an else-if chain member a deeper nesting penalty than its originating if (sibling representation)", () => {
    // if (a) {} else if (b) {}  — both siblings under the same parent block.
    const ifNode = ir("decision", range(1, 1), SCOPE, {
      decision: decision({ kind: "if", range: range(1, 1), symbolScopeId: SCOPE }),
      nestingBoundary: true,
    });
    const elseIfNode = ir("decision", range(2, 2), SCOPE, {
      decision: decision({ kind: "else_if", range: range(2, 2), symbolScopeId: SCOPE }),
      nestingBoundary: true,
    });
    const outerLoop = ir("loop", range(1, 3), SCOPE, {
      decision: decision({ kind: "loop", range: range(1, 3), symbolScopeId: SCOPE }),
      nestingBoundary: true,
      children: [ir("block", range(1, 3), SCOPE, { children: [ifNode, elseIfNode] })],
    });
    const root = ir("symbol", range(1, 3), SCOPE, { children: [outerLoop] });

    const result = computeCognitive(root, ALGORITHM);

    const [loopContribution, ifContribution, elseIfContribution] = result.contributions;
    expect(loopContribution).toEqual({
      line: 1,
      kind: "loop",
      base: 1,
      nestingPenalty: 0,
      total: 1,
    });
    // Both branches are inside the loop (ambient depth 1) and score identically —
    // the else-if does NOT receive an additional nesting increment.
    expect(ifContribution).toEqual({ line: 1, kind: "if", base: 1, nestingPenalty: 1, total: 2 });
    expect(elseIfContribution).toEqual({
      line: 2,
      kind: "else_if",
      base: 1,
      nestingPenalty: 1,
      total: 2,
    });
    expect(result.value).toBe(5);
  });

  it("counts an independent logical-operator group once, not once per operand fact", () => {
    // Two facts (e.g. two `&&` operators) sharing one `logicalGroupId` — the
    // adapter emits one fact per operator, but they form ONE independent group.
    const group = "grp-1";
    const first = ir("logical_sequence", range(1, 1), SCOPE, {
      decision: decision({
        kind: "logical_and",
        range: range(1, 1),
        symbolScopeId: SCOPE,
        logicalGroupId: group,
        countsForExtended: true,
        countsForClassic: false,
      }),
    });
    const second = ir("logical_sequence", range(1, 1), SCOPE, {
      decision: decision({
        kind: "logical_and",
        range: range(1, 1),
        symbolScopeId: SCOPE,
        logicalGroupId: group,
        countsForExtended: true,
        countsForClassic: false,
      }),
    });
    const root = ir("symbol", range(1, 1), SCOPE, { children: [first, second] });

    const result = computeCognitive(root, ALGORITHM);

    expect(result.contributions).toHaveLength(1);
    expect(result.value).toBe(1);
  });

  it("gives recursion a flat +1 regardless of ambient nesting depth", () => {
    const recursionMarker = ir("recursion_marker", range(3, 3), SCOPE, {});
    const nestedInLoop = ir("loop", range(1, 4), SCOPE, {
      nestingBoundary: true,
      children: [ir("block", range(2, 3), SCOPE, { children: [recursionMarker] })],
    });
    const root = ir("symbol", range(1, 4), SCOPE, { children: [nestedInLoop] });

    const result = computeCognitive(root, ALGORITHM);

    expect(result.contributions).toEqual([
      { line: 3, kind: "recursion", base: 1, nestingPenalty: 0, total: 1 },
    ]);
    expect(result.value).toBe(1);
  });

  it("gives a lambda body its own nesting context without the lambda itself contributing", () => {
    const innerIf = ir("decision", range(2, 2), SCOPE, {
      decision: decision({ kind: "if", range: range(2, 2), symbolScopeId: SCOPE }),
      nestingBoundary: true,
    });
    const lambda = ir("lambda", range(1, 3), SCOPE, {
      nestingBoundary: true,
      children: [ir("block", range(2, 2), SCOPE, { children: [innerIf] })],
    });
    const root = ir("symbol", range(1, 3), SCOPE, { children: [lambda] });

    const result = computeCognitive(root, ALGORITHM);

    expect(result.contributions).toEqual([
      { line: 2, kind: "if", base: 1, nestingPenalty: 1, total: 2 },
    ]);
  });

  describe("golden case: triple nesting, else-if chain, logical operator sequence, and a lambda", () => {
    // Hand-computed source (line numbers matter, byte offsets are irrelevant here):
    //
    //  1  function processItems(items) {
    //  2    for (const item of items) {                      // loop        depth 0 -> 1+0=1
    //  3      if (item.active) {                              // if          depth 1 -> 1+1=2
    //  4        if (item.type === 'a' && item.ready) {        // && (group)  depth 2 -> 1+2=3
    //                                                          // if          depth 2 -> 1+2=3
    //  5          doA(item);
    //  6        } else if (item.type === 'b') {                // else_if     depth 2 -> 1+2=3
    //  7          const handler = (x) => x.value > 0 ? 1 : -1; // ternary     depth 4 -> 1+4=5 (inside lambda, depth 3 -> 4)
    //  8          handler(item);
    //  9        }
    // 10      }
    // 11    }
    // 12  }
    //
    // Expected total: 1 + 2 + 3 + 3 + 3 + 5 = 17
    function buildTree(): ComplexityIRNode {
      const andGroup = ir("logical_sequence", range(4, 4), SCOPE, {
        decision: decision({
          kind: "logical_and",
          range: range(4, 4),
          symbolScopeId: SCOPE,
          logicalGroupId: "and-group-1",
          countsForClassic: false,
          countsForExtended: true,
        }),
      });
      const ifInner = ir("decision", range(4, 6), SCOPE, {
        decision: decision({ kind: "if", range: range(4, 4), symbolScopeId: SCOPE }),
        nestingBoundary: true,
        children: [
          ir("block", range(5, 5), SCOPE, { children: [ir("statement", range(5, 5), SCOPE, {})] }),
        ],
      });
      const ternary = ir("ternary", range(7, 7), SCOPE, {
        decision: decision({ kind: "ternary", range: range(7, 7), symbolScopeId: SCOPE }),
        nestingBoundary: true,
      });
      const lambda = ir("lambda", range(7, 7), SCOPE, {
        nestingBoundary: true,
        children: [ir("block", range(7, 7), SCOPE, { children: [ternary] })],
      });
      const elseIf = ir("decision", range(6, 9), SCOPE, {
        decision: decision({ kind: "else_if", range: range(6, 6), symbolScopeId: SCOPE }),
        nestingBoundary: true,
        children: [
          ir("block", range(7, 8), SCOPE, {
            children: [lambda, ir("statement", range(8, 8), SCOPE, {})],
          }),
        ],
      });
      const outerIfBody = ir("block", range(4, 9), SCOPE, {
        children: [andGroup, ifInner, elseIf],
      });
      const outerIf = ir("decision", range(3, 10), SCOPE, {
        decision: decision({ kind: "if", range: range(3, 3), symbolScopeId: SCOPE }),
        nestingBoundary: true,
        children: [outerIfBody],
      });
      const loopBody = ir("block", range(3, 10), SCOPE, { children: [outerIf] });
      const loop = ir("loop", range(2, 11), SCOPE, {
        decision: decision({ kind: "loop", range: range(2, 2), symbolScopeId: SCOPE }),
        nestingBoundary: true,
        children: [loopBody],
      });
      return ir("symbol", range(1, 12), SCOPE, { children: [loop] });
    }

    it("matches the hand-computed total and full contribution list", () => {
      const result = computeCognitive(buildTree(), ALGORITHM);

      expect(result.algorithm).toBe(ALGORITHM);
      expect(result.contributions).toEqual([
        { line: 2, kind: "loop", base: 1, nestingPenalty: 0, total: 1 },
        { line: 3, kind: "if", base: 1, nestingPenalty: 1, total: 2 },
        { line: 4, kind: "logical_and", base: 1, nestingPenalty: 2, total: 3 },
        { line: 4, kind: "if", base: 1, nestingPenalty: 2, total: 3 },
        { line: 6, kind: "else_if", base: 1, nestingPenalty: 2, total: 3 },
        { line: 7, kind: "ternary", base: 1, nestingPenalty: 4, total: 5 },
      ]);
      expect(result.value).toBe(17);
    });

    it("satisfies sum(contributions.total) === total for the golden case", () => {
      const result = computeCognitive(buildTree(), ALGORITHM);
      const sum = result.contributions.reduce((s, c) => s + c.total, 0);
      expect(sum).toBe(result.value);
    });
  });

  it("throws when the sum-of-contributions invariant is violated (corrupted input)", () => {
    const corrupted = [
      { line: 1, kind: "if", base: 1, nestingPenalty: 0, total: 1 },
      { line: 2, kind: "if", base: 1, nestingPenalty: 1, total: 2 },
    ];
    expect(() => assertCognitiveInvariant(corrupted, 999)).toThrow(/invariant violated/);
    expect(() => assertCognitiveInvariant(corrupted, 3)).not.toThrow();
  });
});
