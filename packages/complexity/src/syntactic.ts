/**
 * SyntacticCalculator (spec.md §16.8).
 *
 * `ast_node_count`/`ast_max_depth`/`ast_avg_depth`/`node_kind_entropy` and the
 * construct counters are derived straight from `ComplexityFacts.nodeKinds`
 * (each entry already carries its own AST depth) and the other typed fact
 * arrays.
 *
 * `ast_branching_factor_avg`/`ast_branching_factor_max` (spec.md §16.8,
 * "Mindestens") are reconstructed EXACTLY from the `nodeKinds` sequence:
 * the adapter's single walk emits one `NodeKindFact` per visited node in
 * DFS PRE-ORDER (that ordering is this calculator's input contract for the
 * two branching keys; `selectSymbolFacts` filtering preserves it), and in a
 * pre-order depth sequence every node's parent is the nearest preceding
 * entry with a smaller depth — so per-node child counts, and from them the
 * branching factors, follow without any parent pointers. This is the real
 * AST branching factor, not an approximation (see README "Entscheidungen"
 * #7); the optional `irRoot` is only used as a fallback when `nodeKinds` is
 * empty (e.g. hand-built IR fixtures), because the sparse control-flow IR
 * would otherwise understate branching.
 */
import type { ComplexityFacts, ComplexityIRNode, NodeKindFact } from "@untangle-code/domain";

import { frequenciesOf, shannonEntropy } from "./entropy.js";
import { classifyNodeKind, isAsyncNodeKind, isExceptionNodeKind } from "./node-kind-heuristics.js";
import { rangeKey } from "./scope.js";
import type { MetricsResult } from "./types.js";

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

interface BranchingStats {
  avg: number;
  max: number;
}

/**
 * Exact per-node child counts from a DFS pre-order depth sequence (see the
 * module doc): a stack of "open" ancestor indices is maintained; each new
 * node closes every open node with depth >= its own, and the remaining top
 * (nearest preceding smaller depth) is its parent. Works on scope-filtered
 * sequences too — a scope's facts form contiguous pre-order fragments whose
 * missing outer ancestors simply make their subtree roots forest roots, and
 * child counts then cover exactly the scope's OWN nodes, consistent with
 * every other metric computed from scope-narrowed facts.
 */
function computeBranchingFromPreorderDepths(nodeKinds: readonly NodeKindFact[]): BranchingStats {
  const childCounts = new Array<number>(nodeKinds.length).fill(0);
  const openAncestors: number[] = [];
  for (let i = 0; i < nodeKinds.length; i += 1) {
    const depth = (nodeKinds[i] as NodeKindFact).depth;
    while (
      openAncestors.length > 0 &&
      (nodeKinds[openAncestors[openAncestors.length - 1] as number] as NodeKindFact).depth >= depth
    ) {
      openAncestors.pop();
    }
    const parentIndex = openAncestors[openAncestors.length - 1];
    if (parentIndex !== undefined) {
      childCounts[parentIndex] = (childCounts[parentIndex] as number) + 1;
    }
    openAncestors.push(i);
  }
  let max = 0;
  for (const count of childCounts) {
    if (count > max) max = count;
  }
  return { avg: mean(childCounts), max };
}

function computeBranching(root: ComplexityIRNode): BranchingStats {
  const branchCounts: number[] = [];
  const stack: ComplexityIRNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    branchCounts.push(node.children.length);
    for (const child of node.children) stack.push(child);
  }
  return {
    avg: mean(branchCounts),
    max: branchCounts.length > 0 ? Math.max(...branchCounts) : 0,
  };
}

/**
 * @param facts Facts already narrowed to the target scope.
 * @param sloc The scope's own SLOC, as computed by `computeStructural` —
 *   passed in rather than recomputed so `ast_nodes_per_sloc` is consistent
 *   with the structural snapshot instead of a second, possibly divergent,
 *   line-scan.
 * @param irRoot Optional IR subtree for the same scope; only used as the
 *   branching-factor source when `facts.nodeKinds` is empty (the pre-order
 *   reconstruction over real node-kind facts is exact and takes precedence).
 */
export function computeSyntactic(
  facts: ComplexityFacts,
  sloc: number,
  irRoot?: ComplexityIRNode,
  algorithmVersion = "untangle-syntactic-v1",
): MetricsResult {
  const depths = facts.nodeKinds.map((n) => n.depth);
  const astNodeCount = facts.nodeKinds.length;

  const controlFlowKeys = new Set<string>();
  for (const d of facts.decisions) controlFlowKeys.add(rangeKey(d.range));
  for (const n of facts.nestingEvents) controlFlowKeys.add(rangeKey(n.range));
  const controlFlowNodeCount = controlFlowKeys.size;

  // Ranged exception constructs (catch clauses) are deduplicated by range,
  // since adapters may emit both a DecisionFact and a NestingFact for the
  // same `catch`. Node-kind-only signals (e.g. a bare `throw_statement`,
  // which carries no dedicated fact type) have no range to dedupe by and are
  // simply counted in addition.
  const exceptionRangeKeys = new Set<string>();
  for (const n of facts.nestingEvents) {
    if (n.construct === "catch") exceptionRangeKeys.add(rangeKey(n.range));
  }
  for (const d of facts.decisions) {
    if (d.kind === "catch") exceptionRangeKeys.add(rangeKey(d.range));
  }
  const throwLikeNodeCount = facts.nodeKinds.filter(
    (n) => isExceptionNodeKind(n.kind) && !n.kind.toLowerCase().includes("catch"),
  ).length;
  const exceptionConstructCount = exceptionRangeKeys.size + throwLikeNodeCount;

  const nodeKindFrequencies = frequenciesOf(facts.nodeKinds, (n) => n.kind);

  const metrics: Record<string, number> = {
    ast_node_count: astNodeCount,
    ast_max_depth: depths.length > 0 ? Math.max(...depths) : 0,
    ast_avg_depth: mean(depths),
    statement_count: facts.nodeKinds.filter((n) => classifyNodeKind(n.kind) === "statement").length,
    expression_count: facts.nodeKinds.filter((n) => classifyNodeKind(n.kind) === "expression")
      .length,
    declaration_count: facts.nodeKinds.filter((n) => classifyNodeKind(n.kind) === "declaration")
      .length,
    control_flow_node_count: controlFlowNodeCount,
    control_flow_density: astNodeCount > 0 ? controlFlowNodeCount / astNodeCount : 0,
    lambda_count: facts.nestingEvents.filter((n) => n.construct === "lambda").length,
    async_construct_count: facts.nodeKinds.filter((n) => isAsyncNodeKind(n.kind)).length,
    exception_construct_count: exceptionConstructCount,
    pattern_match_count: facts.decisions.filter((d) => d.kind === "pattern_alternative").length,
    node_kind_entropy: shannonEntropy(nodeKindFrequencies.values()),
    ast_nodes_per_sloc: astNodeCount / Math.max(sloc, 1),
    parse_error_node_count: facts.parseDiagnostics.filter((d) => d.kind === "error_node").length,
    missing_node_count: facts.parseDiagnostics.filter((d) => d.kind === "missing_node").length,
    // WP-185: DIE ZWEI ZAHLEN OBEN SIND NICHT DIE GANZE WAHRHEIT.
    //
    // `ParseDiagnostic.kind` kennt vier Werte (`error_node`, `missing_node`,
    // `fallback`, `other`). Die beiden Kennzahlen oben zaehlen genau zwei
    // davon — und ein Adapter, dessen Parser keine tree-sitter-Fehlerknoten
    // kennt, meldet seine Syntaxfehler als `"other"`. Gemessen am eigenen
    // Python-Adapter: eine Datei mit `parseQuality: "partial"` und
    // `ParseResult.errorNodeCount: 5` erzeugt fuenf Diagnosen der Art
    // `"other"` — und `parse_error_node_count` stand trotzdem auf 0. Zwei
    // Zeugen desselben Laufs widersprachen einander, und der, der das Haus
    // verlaesst, war der falsche. Wer 0 liest, schliesst auf einen heilen
    // Baum; das ist die Sorte stiller Fehlaussage, die E4 verbietet.
    //
    // Die beiden vorhandenen Kennzahlen bleiben unveraendert — sie bedeuten
    // weiterhin genau, was ihr Name sagt. Ergaenzt werden zwei, die den Rest
    // sichtbar machen, statt ihn unter einer 0 verschwinden zu lassen.
    parse_diagnostic_count: facts.parseDiagnostics.length,
    unclassified_parse_error_count: facts.parseDiagnostics.filter(
      (d) => d.severity === "error" && d.kind !== "error_node" && d.kind !== "missing_node",
    ).length,
  };

  if (facts.nodeKinds.length > 0) {
    const branching = computeBranchingFromPreorderDepths(facts.nodeKinds);
    metrics["ast_branching_factor_avg"] = branching.avg;
    metrics["ast_branching_factor_max"] = branching.max;
  } else if (irRoot) {
    const branching = computeBranching(irRoot);
    metrics["ast_branching_factor_avg"] = branching.avg;
    metrics["ast_branching_factor_max"] = branching.max;
  }

  return { metrics, algorithmVersion };
}
