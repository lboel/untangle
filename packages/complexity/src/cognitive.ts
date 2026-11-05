/**
 * CognitiveCalculator, algorithm id `untangle-cognitive-v1` (spec.md §16.4,
 * architecture.md §15.3).
 *
 * Traverses a `ComplexityIRNode` subtree (rooted at a `"symbol"` node) with
 * an explicit depth-tracking stack, exactly as architecture.md §15.3
 * prescribes ("current symbol, nesting depth, logical sequence state,
 * recursion state"). Every contribution is `base + nestingPenalty = total`,
 * and `value` is defined as `sum(contributions[].total)` — so the
 * "sum of contributions equals the total" invariant (required by the work
 * order) holds *by construction*; `assertCognitiveInvariant` is the
 * belt-and-suspenders runtime guard the work order also asks for, exercised
 * both indirectly (every golden test) and directly (a deliberately corrupted
 * contribution list in cognitive.test.ts).
 *
 * REQUIRED INPUT CONTRACT (Untangle decision — architecture.md §15.3 leaves
 * the exact IR shape for if/else-if/else chains unspecified; see README
 * "Entscheidungen" #2 for the full rationale): a language adapter/IR builder
 * feeding this calculator MUST represent an `if` / `else if` / `else` chain
 * as a flat run of *sibling* IR nodes (one per branch) under the same
 * parent, each carrying its own consequent block as `children` — never as
 * the raw AST's nested "alternate" shape. This is what makes "`else if` gets
 * no full new nesting increment" fall out of the traversal for free: siblings
 * share the same ambient depth, so an `else if` scores exactly what its
 * originating `if` scores, never more.
 *
 * Nesting rules (this calculator's own, documented decisions):
 * - A node contributes when it carries a `decision` fact, or is itself kind
 *   `"logical_sequence"` (a pre-grouped `&&`/`||` run) or `"recursion_marker"`.
 * - `base` is always 1. `nestingPenalty` is the ambient depth *before*
 *   entering the node (0 for a top-level construct), except recursion, whose
 *   penalty is always 0 (recursion is flagged flatly, not nesting-scaled —
 *   spec.md §16.4 only says it "KANN einen Beitrag erzeugen").
 * - A node with `nestingBoundary: true` increments depth by exactly 1 for
 *   its own children (this covers `if`/`else_if`/loops/`catch`/`ternary`/
 *   `switch`/`case`/lambdas alike — lambdas use this same mechanism for the
 *   "documented nesting context" spec.md §16.4 asks for). `logical_sequence`
 *   and `recursion_marker` nodes are not nesting boundaries.
 * - Decisions that share a `logicalGroupId` (an independent `&&`/`||` group
 *   spanning multiple facts) contribute once, at the first occurrence
 *   encountered during traversal — mirrors the cyclomatic-extended grouping
 *   rule in cyclomatic.ts.
 */
import type { CognitiveContributionV1, ComplexityIRNode } from "@untangle-code/domain";

import type { CognitiveResult } from "./types.js";

interface WalkState {
  depth: number;
}

function contributionKind(node: ComplexityIRNode): string {
  if (node.decision) return node.decision.kind;
  if (node.kind === "recursion_marker") return "recursion";
  return node.kind;
}

function isContributing(node: ComplexityIRNode): boolean {
  return (
    node.decision != null || node.kind === "logical_sequence" || node.kind === "recursion_marker"
  );
}

function walk(
  node: ComplexityIRNode,
  state: WalkState,
  contributions: CognitiveContributionV1[],
  seenGroups: Set<string>,
): void {
  if (isContributing(node)) {
    const groupId = node.decision?.logicalGroupId;
    const isDuplicateGroupMember = groupId != null && seenGroups.has(groupId);
    if (groupId != null) {
      seenGroups.add(groupId);
    }
    if (!isDuplicateGroupMember) {
      const base = 1;
      const nestingPenalty = node.kind === "recursion_marker" ? 0 : state.depth;
      contributions.push({
        line: node.range.startLine,
        kind: contributionKind(node),
        base,
        nestingPenalty,
        total: base + nestingPenalty,
      });
    }
  }

  const childDepth = node.nestingBoundary === true ? state.depth + 1 : state.depth;
  for (const child of node.children) {
    walk(child, { depth: childDepth }, contributions, seenGroups);
  }
}

/**
 * @param symbolRoot The `ComplexityIRNode` (kind `"symbol"`) rooting the
 *   symbol's own subtree; traversal starts at depth 0.
 * @param algorithm Caller-supplied algorithm id — pass domain's
 *   `COGNITIVE_ALGORITHM_ID` in production; kept as a plain parameter (not
 *   hardcoded) so this stays a pure function of its inputs.
 */
export function computeCognitive(symbolRoot: ComplexityIRNode, algorithm: string): CognitiveResult {
  const contributions: CognitiveContributionV1[] = [];
  walk(symbolRoot, { depth: 0 }, contributions, new Set<string>());
  const value = contributions.reduce((sum, c) => sum + c.total, 0);
  assertCognitiveInvariant(contributions, value);
  return { value, algorithm, contributions };
}

/**
 * Throws when `sum(contributions[].total) !== total`. `computeCognitive`
 * cannot actually violate this (value is defined as that very sum), but the
 * work order asks for an explicit, independently-testable guard — this is
 * also the function a caller re-assembling a snapshot from stored
 * contributions should re-run to catch data corruption.
 */
export function assertCognitiveInvariant(
  contributions: readonly CognitiveContributionV1[],
  total: number,
): void {
  const sum = contributions.reduce((s, c) => s + c.total, 0);
  if (sum !== total) {
    throw new Error(
      `cognitive complexity invariant violated: sum(contributions.total)=${sum} does not equal total=${total}`,
    );
  }
}
