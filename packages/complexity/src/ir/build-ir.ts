/**
 * IR producer: the bridge `ComplexityFacts` -> `ComplexityIRNode`
 * (architecture.md §6.7, spec.md §16.4).
 *
 * architecture.md §6.7 says "Sprachadapter uebersetzen AST-Nodes in diese
 * IR", but the `LanguageAdapter` port (domain `analysis.ts`) deliberately
 * has no IR method — adapters emit flat, language-neutral `ComplexityFacts`.
 * This module closes that gap INSIDE the complexity package: it rebuilds the
 * `ComplexityIRNode` tree `computeCognitive` (and the branching metrics of
 * `computeSyntactic`) require from the byte-ranges the facts already carry,
 * so no language adapter needs to know the IR shape at all.
 *
 * INPUT CONTRACT (facts, as produced by parser-registry's single walk):
 * - every `DecisionFact`/`NestingFact` range is the source range of the AST
 *   node that caused it; ranges of distinct facts never partially overlap
 *   (they are AST node ranges: equal, disjoint, or fully nested);
 * - an `if`/`loop`/`catch`/`ternary` emits BOTH a `DecisionFact` and a
 *   `NestingFact` with the identical range (they are merged into one IR
 *   node here);
 * - an `else if` is a `DecisionFact` of kind `"else_if"` plus a
 *   `NestingFact` with `continuation: true`, and its range lies INSIDE the
 *   range of the `if` it continues (the raw AST "alternate" shape).
 *
 * OUTPUT CONTRACT (what `computeCognitive` requires — see cognitive.ts):
 * - an `if` / `else if` / `else if` chain becomes a FLAT run of sibling IR
 *   nodes under the parent of the first `if`, NEVER the raw AST's nested
 *   alternate shape. This is what makes "`else if` erhaelt keinen
 *   vollstaendigen neuen Nesting-Aufschlag" (spec.md §16.4) fall out of the
 *   traversal: siblings share the ambient depth. Implemented via the
 *   attachment rule `finalParent(continuationNode) =
 *   finalParent(itsContainmentParent)`, which flattens arbitrarily long
 *   chains while keeping a genuinely nested `if` (inside another `if`'s
 *   BODY) at its deeper level;
 * - each branch keeps its own consequent content as `children` (content
 *   ranges nest inside the branch's own range, so containment placement
 *   already produces that).
 *
 * Documented mapping decisions (Untangle decisions, mirrored in the README):
 * - nesting constructs map to IR kinds: if->"decision", loop->"loop",
 *   catch->"catch", ternary->"ternary", switch->"switch", lambda->"lambda";
 *   all of them are nesting boundaries (`nestingBoundary: true`), matching
 *   the boundary list documented in cognitive.ts;
 * - a `case` decision (no nesting fact of its own) becomes a `"case"` node
 *   that is ALSO a nesting boundary — case bodies are one level deeper than
 *   the switch head, per cognitive.ts's documented boundary list;
 * - logical-operator decisions (`logical_and`/`logical_or`/`short_circuit`)
 *   become non-boundary `"logical_sequence"` nodes carrying their
 *   `DecisionFact` (grouping happens in the consumers via `logicalGroupId`);
 * - CONDITION HOISTING: a logical node whose direct IR parent is a
 *   condition-bearing boundary (`decision`/`loop`/`ternary`/`switch`) is
 *   hoisted to a sibling placed immediately BEFORE that boundary node. This
 *   encodes the untangle-cognitive-v1 convention that a guard's condition
 *   operators score at the guard's own ambient depth (see the golden case in
 *   cognitive.test.ts), and is exact for `switch` (everything nested in a
 *   switch body sits inside a `case` node). For `if`/loops/ternaries it is a
 *   documented approximation: facts carry no condition/body split, so a
 *   logical group written as a DIRECT body statement of the guard (e.g.
 *   `if (x) y = a && b;`) is hoisted too and scores one nesting level lower
 *   than a hypothetical exact split would give. Making this exact needs a
 *   `conditionRange` on `DecisionFact` (or a `bodyRange` on `NestingFact`)
 *   from the adapters — tracked as an open issue, not guessed here;
 * - every descendant symbol scope of the target symbol is included: its
 *   facts participate in the target's IR, and the scope itself becomes a
 *   `"lambda"` boundary node when it is function-like (function / method /
 *   constructor — deduplicated by range against the adapter's own `lambda`
 *   nesting events) or a transparent non-boundary `"block"` node otherwise
 *   (class/interface/enum/namespace/type/property). This is the "documented
 *   nesting context" spec.md §16.4 demands for local functions/lambdas: a
 *   symbol's cognitive value includes the control flow of the lambdas it
 *   defines, one nesting level deeper — while those lambdas still get their
 *   own, separately-scoped snapshot when measured directly;
 * - recursion (spec.md §16.4 "Rekursion wird markiert und KANN einen
 *   Beitrag erzeugen"): when the caller supplies the file's `RawCall`s
 *   (adapters expose them via `extractCalls`, but they are not part of
 *   `ComplexityFacts`), a call site inside the subtree whose unqualified
 *   callee name (or `this.`-qualified name, for methods) equals the name of
 *   its OWN enclosing scope becomes a `"recursion_marker"` node — direct
 *   self-recursion only; mutual recursion needs the call graph and is out of
 *   scope here.
 */
import type {
  ComplexityFacts,
  ComplexityIRNode,
  DecisionFact,
  IRKind,
  RawCall,
  SymbolScopeFact,
} from "@untangle-code/domain";

import { containsRange, rangeKey } from "../scope.js";

export interface BuildSymbolIROptions {
  /**
   * Raw call sites of the same file (from `LanguageAdapter.extractCalls`).
   * When given, direct self-recursion is marked with `"recursion_marker"`
   * nodes; when omitted, no recursion contributions are produced (allowed:
   * spec.md §16.4 makes the recursion contribution optional).
   */
  calls?: readonly RawCall[];
}

const FUNCTION_LIKE_SCOPE_KINDS: ReadonlySet<string> = new Set([
  "function",
  "method",
  "constructor",
]);

const LOGICAL_DECISION_KINDS: ReadonlySet<string> = new Set([
  "logical_and",
  "logical_or",
  "short_circuit",
]);

/** Boundary IR kinds whose head expression (condition) can carry logical groups. */
const CONDITION_BEARING_KINDS: ReadonlySet<IRKind> = new Set([
  "decision",
  "loop",
  "ternary",
  "switch",
]);

function irKindForConstruct(construct: string): IRKind {
  switch (construct) {
    case "if":
      return "decision";
    case "loop":
      return "loop";
    case "catch":
      return "catch";
    case "ternary":
      return "ternary";
    case "switch":
      return "switch";
    case "lambda":
      return "lambda";
    default:
      // Unknown future constructs still nest conservatively (they were
      // emitted as nesting events, so they ARE nesting constructs).
      return "other";
  }
}

interface ProtoNode {
  node: ComplexityIRNode;
  /** From `NestingFact.continuation` — drives the else-if sibling flattening. */
  continuation: boolean;
}

function isLogicalDecisionNode(node: ComplexityIRNode): boolean {
  return (
    node.decision !== undefined &&
    LOGICAL_DECISION_KINDS.has(node.decision.kind) &&
    node.nestingBoundary !== true
  );
}

function isConditionBearingBoundary(node: ComplexityIRNode): boolean {
  return node.nestingBoundary === true && CONDITION_BEARING_KINDS.has(node.kind);
}

/**
 * Condition hoisting (see "CONDITION HOISTING" above): a logical node that
 * is a direct child of a condition-bearing boundary moves up EXACTLY ONE
 * level, inserted immediately before its former parent — that places the
 * group at the guard's own ambient depth (the guard's children sit one
 * boundary deeper than the guard itself). Never more than one level: the
 * sweep for `parent` runs before recursing into its children, so a node
 * hoisted out of a grandchild boundary is not swept again by any ancestor.
 */
function hoistConditionGroups(parent: ComplexityIRNode): void {
  const reordered: ComplexityIRNode[] = [];
  for (const child of parent.children) {
    if (isConditionBearingBoundary(child)) {
      const staying: ComplexityIRNode[] = [];
      for (const grandchild of child.children) {
        if (isLogicalDecisionNode(grandchild)) {
          reordered.push(grandchild);
        } else {
          staying.push(grandchild);
        }
      }
      child.children = staying;
    }
    reordered.push(child);
  }
  parent.children = reordered;
  for (const child of parent.children) {
    hoistConditionGroups(child);
  }
}

function isDirectSelfRecursion(call: RawCall, enclosingScope: SymbolScopeFact): boolean {
  if (enclosingScope.name.length === 0) return false;
  if (call.calleeName !== enclosingScope.name) return false;
  // `foo()` inside function foo, or `this.foo()` inside method foo.
  return call.qualifier === undefined || call.qualifier === "this";
}

/**
 * Builds the `ComplexityIRNode` subtree for one symbol scope (kind
 * `"symbol"`, `nestingBoundary` unset, traversal depth 0 — exactly the root
 * shape `computeCognitive` expects), or the whole-file tree (kind `"root"`)
 * when `symbolScopeId` is the file scope's id.
 *
 * Returns `undefined` when `symbolScopeId` does not exist in
 * `facts.symbolScopes` (mirrors `selectSymbolFacts`' stale-id tolerance).
 *
 * Pass the UNFILTERED file facts, not `selectSymbolFacts` output: the
 * builder selects the symbol's own facts AND its descendant scopes' facts
 * itself (a symbol's lambdas nest into its IR — see the module doc).
 */
export function buildSymbolIR(
  facts: ComplexityFacts,
  symbolScopeId: string,
  options: BuildSymbolIROptions = {},
): ComplexityIRNode | undefined {
  const scopesById = new Map<string, SymbolScopeFact>();
  for (const scope of facts.symbolScopes) scopesById.set(scope.symbolScopeId, scope);
  const targetScope = scopesById.get(symbolScopeId);
  if (targetScope === undefined) return undefined;

  // Target scope plus all transitive descendants (lambdas, local functions,
  // nested classes/methods, ...).
  const childScopesByParent = new Map<string, SymbolScopeFact[]>();
  for (const scope of facts.symbolScopes) {
    if (scope.parentScopeId === undefined) continue;
    const siblings = childScopesByParent.get(scope.parentScopeId) ?? [];
    siblings.push(scope);
    childScopesByParent.set(scope.parentScopeId, siblings);
  }
  const relevantScopeIds = new Set<string>([symbolScopeId]);
  const descendantScopes: SymbolScopeFact[] = [];
  const pending = [symbolScopeId];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const child of childScopesByParent.get(current) ?? []) {
      if (relevantScopeIds.has(child.symbolScopeId)) continue;
      relevantScopeIds.add(child.symbolScopeId);
      descendantScopes.push(child);
      pending.push(child.symbolScopeId);
    }
  }

  // ---- Proto nodes, deduplicated by range (an if/loop/catch/ternary emits
  // a DecisionFact AND a NestingFact for the same AST node). ----
  const protoByRange = new Map<string, ProtoNode>();

  const ensureNode = (
    key: string,
    create: () => ComplexityIRNode,
    continuation: boolean,
  ): ProtoNode => {
    const existing = protoByRange.get(key);
    if (existing !== undefined) return existing;
    const created: ProtoNode = { node: create(), continuation };
    protoByRange.set(key, created);
    return created;
  };

  for (const nesting of facts.nestingEvents) {
    if (!relevantScopeIds.has(nesting.symbolScopeId)) continue;
    ensureNode(
      rangeKey(nesting.range),
      () => ({
        kind: irKindForConstruct(nesting.construct),
        range: nesting.range,
        children: [],
        nestingBoundary: true,
        symbolScopeId: nesting.symbolScopeId,
      }),
      nesting.continuation,
    );
  }

  for (const decision of facts.decisions) {
    if (!relevantScopeIds.has(decision.symbolScopeId)) continue;
    const proto = ensureNode(rangeKey(decision.range), () => decisionOnlyNode(decision), false);
    if (proto.node.decision === undefined) proto.node.decision = decision;
  }

  for (const scope of descendantScopes) {
    const key = rangeKey(scope.range);
    if (FUNCTION_LIKE_SCOPE_KINDS.has(scope.kind)) {
      // Deduplicates against the adapter's own "lambda" nesting event (same
      // AST node, same range) when the enclosing scope was executable.
      ensureNode(
        key,
        () => ({
          kind: "lambda",
          range: scope.range,
          children: [],
          nestingBoundary: true,
          symbolScopeId: scope.symbolScopeId,
        }),
        false,
      );
    } else {
      ensureNode(
        key,
        () => ({
          kind: "block",
          range: scope.range,
          children: [],
          symbolScopeId: scope.symbolScopeId,
        }),
        false,
      );
    }
  }

  for (const call of options.calls ?? []) {
    if (!relevantScopeIds.has(call.callerScopeId)) continue;
    const enclosingScope = scopesById.get(call.callerScopeId);
    if (enclosingScope === undefined) continue;
    if (!isDirectSelfRecursion(call, enclosingScope)) continue;
    ensureNode(
      rangeKey(call.range),
      () => ({
        kind: "recursion_marker",
        range: call.range,
        children: [],
        symbolScopeId: call.callerScopeId,
      }),
      false,
    );
  }

  // ---- Containment placement with else-if sibling flattening. ----
  const root: ComplexityIRNode = {
    kind: targetScope.kind === "file" ? "root" : "symbol",
    range: targetScope.range,
    children: [],
    symbolScopeId,
  };

  const sorted = [...protoByRange.values()].sort(
    (a, b) =>
      a.node.range.startByte - b.node.range.startByte ||
      b.node.range.endByte - a.node.range.endByte,
  );

  const containmentStack: ProtoNode[] = [];
  // The node each proto was ATTACHED to (differs from the containment parent
  // for continuation nodes — that difference IS the flattening).
  const attachedTo = new Map<ProtoNode, ComplexityIRNode>();

  for (const proto of sorted) {
    if (!containsRange(root.range, proto.node.range)) continue; // defensive: stray fact outside the symbol
    while (
      containmentStack.length > 0 &&
      !containsRange(
        (containmentStack[containmentStack.length - 1] as ProtoNode).node.range,
        proto.node.range,
      )
    ) {
      containmentStack.pop();
    }
    const containmentParent = containmentStack[containmentStack.length - 1];
    let parent: ComplexityIRNode;
    if (proto.continuation && containmentParent !== undefined) {
      // finalParent(else_if) = finalParent(the if it continues); the owning
      // if is exactly the containment parent (nothing sits between an
      // if_statement and the if_statement in its else-clause).
      parent = attachedTo.get(containmentParent) ?? root;
    } else {
      parent = containmentParent?.node ?? root;
    }
    parent.children.push(proto.node);
    attachedTo.set(proto, parent);
    containmentStack.push(proto);
  }

  // ---- Condition hoisting (one level; see module doc). ----
  hoistConditionGroups(root);

  return root;
}

function decisionOnlyNode(decision: DecisionFact): ComplexityIRNode {
  if (decision.kind === "case") {
    // Case bodies nest one level below the switch head (cognitive.ts's
    // documented boundary list includes "case").
    return {
      kind: "case",
      range: decision.range,
      children: [],
      nestingBoundary: true,
      decision,
      symbolScopeId: decision.symbolScopeId,
    };
  }
  if (LOGICAL_DECISION_KINDS.has(decision.kind)) {
    return {
      kind: "logical_sequence",
      range: decision.range,
      children: [],
      decision,
      symbolScopeId: decision.symbolScopeId,
    };
  }
  // guard/if/loop/... decisions normally merge with their nesting event by
  // range; a decision kind without one (e.g. "pattern_alternative") becomes
  // a plain non-boundary decision node.
  return {
    kind: "decision",
    range: decision.range,
    children: [],
    decision,
    symbolScopeId: decision.symbolScopeId,
  };
}
