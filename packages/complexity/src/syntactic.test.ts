import { describe, expect, it } from "vitest";

import { computeSyntactic } from "./syntactic.js";
import {
  decision,
  emptyFacts,
  ir,
  nestingEvent,
  nodeKind,
  range,
} from "./test-support/builders.js";

const SCOPE = "sym1";

describe("computeSyntactic", () => {
  it("hand-computed: ast_node_count/ast_max_depth/ast_avg_depth from node-kind facts", () => {
    const facts = emptyFacts();
    facts.nodeKinds = [
      nodeKind("function_declaration", 0, SCOPE),
      nodeKind("if_statement", 1, SCOPE),
      nodeKind("call_expression", 2, SCOPE),
      nodeKind("identifier", 3, SCOPE),
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["ast_node_count"]).toBe(4);
    expect(result.metrics["ast_max_depth"]).toBe(3);
    expect(result.metrics["ast_avg_depth"]).toBeCloseTo((0 + 1 + 2 + 3) / 4, 10);
  });

  it("classifies statement/expression/declaration counts from node-kind names", () => {
    const facts = emptyFacts();
    facts.nodeKinds = [
      nodeKind("if_statement", 0, SCOPE),
      nodeKind("expression_statement", 1, SCOPE),
      nodeKind("call_expression", 1, SCOPE),
      nodeKind("variable_declaration", 1, SCOPE),
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["statement_count"]).toBe(2);
    expect(result.metrics["expression_count"]).toBe(1);
    expect(result.metrics["declaration_count"]).toBe(1);
  });

  it("computes ast_nodes_per_sloc against the supplied sloc (from StructuralCalculator)", () => {
    const facts = emptyFacts();
    facts.nodeKinds = [
      nodeKind("a", 0, SCOPE),
      nodeKind("b", 0, SCOPE),
      nodeKind("c", 0, SCOPE),
      nodeKind("d", 0, SCOPE),
    ];

    const result = computeSyntactic(facts, 2);

    expect(result.metrics["ast_nodes_per_sloc"]).toBe(2); // 4 nodes / 2 sloc
  });

  it("guards ast_nodes_per_sloc against sloc=0", () => {
    const facts = emptyFacts();
    facts.nodeKinds = [nodeKind("a", 0, SCOPE)];
    const result = computeSyntactic(facts, 0);
    expect(result.metrics["ast_nodes_per_sloc"]).toBe(1); // 1 / max(0,1)
  });

  it("counts lambda_count from nestingEvents and pattern_match_count from decisions directly", () => {
    const facts = emptyFacts();
    facts.nestingEvents = [
      nestingEvent({ construct: "lambda", range: range(1, 1), symbolScopeId: SCOPE }),
      nestingEvent({ construct: "lambda", range: range(2, 2), symbolScopeId: SCOPE }),
      nestingEvent({ construct: "if", range: range(3, 3), symbolScopeId: SCOPE }),
    ];
    facts.decisions = [
      decision({ kind: "pattern_alternative", range: range(4, 4), symbolScopeId: SCOPE }),
      decision({ kind: "pattern_alternative", range: range(5, 5), symbolScopeId: SCOPE }),
      decision({ kind: "if", range: range(6, 6), symbolScopeId: SCOPE }),
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["lambda_count"]).toBe(2);
    expect(result.metrics["pattern_match_count"]).toBe(2);
  });

  it("deduplicates control_flow_node_count when a catch is reported as both a decision and a nesting event", () => {
    const sameRange = range(1, 1);
    const facts = emptyFacts();
    facts.decisions = [decision({ kind: "catch", range: sameRange, symbolScopeId: SCOPE })];
    facts.nestingEvents = [
      nestingEvent({ construct: "catch", range: sameRange, symbolScopeId: SCOPE }),
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["control_flow_node_count"]).toBe(1);
    expect(result.metrics["exception_construct_count"]).toBe(1);
  });

  it("counts parse_error_node_count/missing_node_count from parseDiagnostics", () => {
    const facts = emptyFacts();
    facts.parseDiagnostics = [
      { severity: "error", kind: "error_node", message: "", range: range(1, 1) },
      { severity: "warning", kind: "missing_node", message: "", range: range(2, 2) },
      { severity: "warning", kind: "missing_node", message: "", range: range(3, 3) },
      { severity: "warning", kind: "other", message: "", range: range(4, 4) },
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["parse_error_node_count"]).toBe(1);
    expect(result.metrics["missing_node_count"]).toBe(2);
  });

  it("computes node_kind_entropy over the node-kind frequency distribution (hand-computed)", () => {
    const facts = emptyFacts();
    // 2x "a", 2x "b" -> uniform 2-outcome distribution -> 1 bit
    facts.nodeKinds = [
      nodeKind("a", 0, SCOPE),
      nodeKind("a", 1, SCOPE),
      nodeKind("b", 0, SCOPE),
      nodeKind("b", 1, SCOPE),
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["node_kind_entropy"]).toBeCloseTo(1, 10);
  });

  it("omits branching-factor metrics without any structure source, and falls back to the IR when nodeKinds are empty", () => {
    const facts = emptyFacts();
    const withoutAnySource = computeSyntactic(facts, 10);
    expect(withoutAnySource.metrics["ast_branching_factor_avg"]).toBeUndefined();
    expect(withoutAnySource.metrics["ast_branching_factor_max"]).toBeUndefined();

    // root -> 2 children, each a leaf (0 children) -> branchCounts = [2, 0, 0] -> avg = 2/3, max = 2
    const root = ir("symbol", range(1, 3), SCOPE, {
      children: [ir("statement", range(1, 1), SCOPE, {}), ir("statement", range(2, 2), SCOPE, {})],
    });
    const withIr = computeSyntactic(facts, 10, root);
    expect(withIr.metrics["ast_branching_factor_max"]).toBe(2);
    expect(withIr.metrics["ast_branching_factor_avg"]).toBeCloseTo(2 / 3, 10);
  });

  it("hand-computed: reconstructs branching factors exactly from the DFS pre-order depth sequence", () => {
    // Pre-order forest:
    //   n0 (depth 1)
    //     n1 (depth 2)
    //     n2 (depth 2)
    //       n3 (depth 3)
    //   n4 (depth 1)
    // child counts: n0 -> 2, n1 -> 0, n2 -> 1, n3 -> 0, n4 -> 0
    // avg = 3/5, max = 2
    const facts = emptyFacts();
    facts.nodeKinds = [
      nodeKind("a", 1, SCOPE),
      nodeKind("b", 2, SCOPE),
      nodeKind("c", 2, SCOPE),
      nodeKind("d", 3, SCOPE),
      nodeKind("e", 1, SCOPE),
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["ast_branching_factor_avg"]).toBeCloseTo(3 / 5, 10);
    expect(result.metrics["ast_branching_factor_max"]).toBe(2);
  });

  it("prefers the exact nodeKinds reconstruction over a supplied (sparse) IR", () => {
    // Single node with no children per nodeKinds; the IR would claim max 2.
    const facts = emptyFacts();
    facts.nodeKinds = [nodeKind("a", 1, SCOPE)];
    const sparseIr = ir("symbol", range(1, 3), SCOPE, {
      children: [ir("statement", range(1, 1), SCOPE, {}), ir("statement", range(2, 2), SCOPE, {})],
    });

    const result = computeSyntactic(facts, 10, sparseIr);

    expect(result.metrics["ast_branching_factor_avg"]).toBe(0);
    expect(result.metrics["ast_branching_factor_max"]).toBe(0);
  });

  it("handles scope-filtered pre-order fragments: subtree roots with missing outer ancestors become forest roots", () => {
    // A symbol scope's facts start below the (filtered-out) scope-opening
    // node: depths 3,4,4,3 — two roots at depth 3, the first with two children.
    const facts = emptyFacts();
    facts.nodeKinds = [
      nodeKind("a", 3, SCOPE),
      nodeKind("b", 4, SCOPE),
      nodeKind("c", 4, SCOPE),
      nodeKind("d", 3, SCOPE),
    ];

    const result = computeSyntactic(facts, 10);

    expect(result.metrics["ast_branching_factor_avg"]).toBeCloseTo(2 / 4, 10);
    expect(result.metrics["ast_branching_factor_max"]).toBe(2);
  });
});
