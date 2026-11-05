import type { SourceRange } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { computeStructural } from "./structural.js";
import { emptyFacts, nestingEvent, nodeKind, symbolScope } from "./test-support/builders.js";

// ASCII-only fixture so byte offsets equal character (UTF-16 code unit) indices,
// which keeps this golden case hand-verifiable without a UTF-8 detour
// (byte-vs-character handling has its own dedicated test below).
const SOURCE = ["function add(a, b) {", "  // returns sum", "  return a + b;", "}"].join("\n");

function lineStart(lineNo: number): number {
  const lines = SOURCE.split("\n");
  let offset = 0;
  for (let i = 0; i < lineNo - 1; i++) offset += (lines[i]?.length ?? 0) + 1; // + "\n"
  return offset;
}

function rangeOfLine(lineNo: number, text: string): SourceRange {
  const start = lineStart(lineNo) + (SOURCE.split("\n")[lineNo - 1]?.indexOf(text) ?? 0);
  return { startLine: lineNo, endLine: lineNo, startByte: start, endByte: start + text.length };
}

const FILE_RANGE: SourceRange = { startLine: 1, endLine: 4, startByte: 0, endByte: SOURCE.length };
const SCOPE = "sym1";

describe("computeStructural", () => {
  it("hand-computed: physical_loc, sloc, comment_lines, blank_lines for a 4-line function with one full-line comment", () => {
    const facts = emptyFacts();
    facts.symbolScopes = [
      symbolScope({ symbolScopeId: SCOPE, range: FILE_RANGE, kind: "function" }),
    ];
    facts.comments = [rangeOfLine(2, "// returns sum")];

    const result = computeStructural(facts, SOURCE, FILE_RANGE);

    expect(result.metrics["physical_loc"]).toBe(4);
    expect(result.metrics["blank_lines"]).toBe(0);
    expect(result.metrics["comment_lines"]).toBe(1);
    expect(result.metrics["doc_lines"]).toBe(0);
    // sloc = physical_loc - blank_lines - comment_lines = 4 - 0 - 1 = 3
    expect(result.metrics["sloc"]).toBe(3);
  });

  it("counts function/method/class/interface scopes by SymbolScopeFact.kind", () => {
    const facts = emptyFacts();
    facts.symbolScopes = [
      symbolScope({ symbolScopeId: "f1", range: FILE_RANGE, kind: "function" }),
      symbolScope({ symbolScopeId: "m1", range: FILE_RANGE, kind: "method" }),
      symbolScope({ symbolScopeId: "c1", range: FILE_RANGE, kind: "class" }),
      symbolScope({ symbolScopeId: "i1", range: FILE_RANGE, kind: "interface" }),
    ];

    const result = computeStructural(facts, SOURCE, FILE_RANGE);

    expect(result.metrics["function_count"]).toBe(1);
    expect(result.metrics["method_count"]).toBe(1);
    expect(result.metrics["class_count"]).toBe(1);
    expect(result.metrics["interface_count"]).toBe(1);
  });

  it("derives parameter_count/return_count/exit_point_count from node-kind facts", () => {
    const facts = emptyFacts();
    facts.nodeKinds = [
      nodeKind("required_parameter", 1, SCOPE),
      nodeKind("required_parameter", 1, SCOPE),
      nodeKind("return_statement", 2, SCOPE),
    ];

    const result = computeStructural(facts, SOURCE, FILE_RANGE);

    expect(result.metrics["parameter_count"]).toBe(2);
    expect(result.metrics["return_count"]).toBe(1);
    expect(result.metrics["exit_point_count"]).toBe(1);
  });

  it("computes max_nesting/avg_nesting from non-continuation nesting facts (interval containment)", () => {
    const facts = emptyFacts();
    const outer = rangeOfLine(1, "function add(a, b) {");
    const outerWide: SourceRange = { ...outer, endByte: outer.endByte + 100 };
    const inner = rangeOfLine(3, "return a + b;");
    facts.nestingEvents = [
      nestingEvent({ construct: "if", range: outerWide, symbolScopeId: SCOPE }),
      nestingEvent({ construct: "loop", range: inner, symbolScopeId: SCOPE }),
      // continuation (else-if) must NOT add an extra nesting level
      nestingEvent({ construct: "if", range: inner, symbolScopeId: SCOPE, continuation: true }),
    ];

    const result = computeStructural(facts, SOURCE, FILE_RANGE);

    // inner is strictly inside outerWide -> depth 2; outerWide itself -> depth 1
    expect(result.metrics["max_nesting"]).toBe(2);
    expect(result.metrics["avg_nesting"]).toBe(1.5);
  });

  it("never invents coupling metrics that were not supplied", () => {
    const result = computeStructural(emptyFacts(), SOURCE, FILE_RANGE, {});
    expect(result.metrics["fan_in"]).toBeUndefined();
    expect(result.metrics["fan_out"]).toBeUndefined();
    expect(result.metrics["instability"]).toBeUndefined();
    expect(result.metrics["public_api_count"]).toBeUndefined();
  });

  it("passes through supplied coupling metrics and derives instability from afferent/efferent", () => {
    const result = computeStructural(emptyFacts(), SOURCE, FILE_RANGE, {
      fanIn: 3,
      fanOut: 2,
      afferentCoupling: 5,
      efferentCoupling: 2,
      importInDegree: 4,
      importOutDegree: 1,
      inheritanceDepth: 2,
      publicApiCount: 6,
    });

    expect(result.metrics["fan_in"]).toBe(3);
    expect(result.metrics["fan_out"]).toBe(2);
    expect(result.metrics["import_in_degree"]).toBe(4);
    expect(result.metrics["import_out_degree"]).toBe(1);
    expect(result.metrics["inheritance_depth"]).toBe(2);
    expect(result.metrics["public_api_count"]).toBe(6);
    // instability = efferent / (afferent + efferent) = 2 / 7
    expect(result.metrics["instability"]).toBeCloseTo(2 / 7, 10);
  });

  it("uses an explicitly supplied instability as-is, without recomputing it", () => {
    const result = computeStructural(emptyFacts(), SOURCE, FILE_RANGE, {
      afferentCoupling: 5,
      efferentCoupling: 2,
      instability: 0.5,
    });
    expect(result.metrics["instability"]).toBe(0.5);
  });
});
