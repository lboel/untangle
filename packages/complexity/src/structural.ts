/**
 * StructuralCalculator (spec.md §16.5).
 *
 * Facts-derivable metrics are computed directly from `ComplexityFacts` (plus
 * `sourceText`/`scopeRange` for the line-based ones). Coupling and API-surface
 * metrics (`fan_in`, `fan_out`, `import_in_degree`, `import_out_degree`,
 * `afferent_coupling`, `efferent_coupling`, `instability`,
 * `inheritance_depth`, `public_api_count`) need whole-repository graph/export
 * knowledge this facts-only package does not have — per the work order they
 * are accepted as `StructuralExternalInput` and are only ever present in the
 * output when the caller actually supplies them; they are never defaulted or
 * guessed (see README "Entscheidungen" #4 for `instability`'s one derived
 * exception).
 *
 * `parameter_count`, `return_count` and `exit_point_count` use a best-effort
 * node-kind classifier (see `node-kind-heuristics.ts`) since `SymbolScopeFact`
 * carries no structured parameter list — see README "Entscheidungen" #5 and
 * `openIssues`.
 */
import type { ComplexityFacts, SourceRange } from "@untangle-code/domain";

import { classifyNodeKind } from "./node-kind-heuristics.js";
import { strictlyContainsRange } from "./scope.js";
import { classifyLines } from "./text-lines.js";
import type { MetricsResult, StructuralExternalInput } from "./types.js";

const FUNCTION_KINDS = new Set(["function", "arrow_function", "function_expression"]);
const METHOD_KINDS = new Set(["method", "constructor"]);
const CLASS_KINDS = new Set(["class"]);
const INTERFACE_KINDS = new Set(["interface"]);

function countByScopeKind(facts: ComplexityFacts, kinds: Set<string>): number {
  return facts.symbolScopes.filter((s) => kinds.has(s.kind.toLowerCase())).length;
}

/** Interval-nesting depth of `target` among `pool`: 1 + number of other ranges in `pool` that strictly contain it. */
function nestingDepthOf(target: SourceRange, pool: readonly SourceRange[]): number {
  let depth = 1;
  for (const other of pool) {
    if (other === target) continue;
    if (strictlyContainsRange(other, target)) depth++;
  }
  return depth;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * @param facts Facts already narrowed to the target scope (see `selectSymbolFacts`).
 * @param sourceText Full original file content (UTF-8) — needed because
 *   `SourceRange` byte offsets are file-absolute.
 * @param scopeRange The scope's own range (a `SymbolScopeFact.range` for
 *   `scope: "symbol"`, or the whole-file range for `scope: "file"`).
 */
export function computeStructural(
  facts: ComplexityFacts,
  sourceText: string,
  scopeRange: SourceRange,
  external: StructuralExternalInput = {},
  algorithmVersion = "untangle-structural-v1",
): MetricsResult {
  const { physicalLoc, commentLines, docLines, blankLines } = classifyLines(
    sourceText,
    scopeRange,
    facts.comments,
  );
  const sloc = Math.max(physicalLoc - blankLines.size - commentLines.size, 0);

  const nonContinuationNesting = facts.nestingEvents
    .filter((n) => !n.continuation)
    .map((n) => n.range);
  const nestingDepths = nonContinuationNesting.map((range) =>
    nestingDepthOf(range, nonContinuationNesting),
  );

  let parameterCount = 0;
  let returnCount = 0;
  let exitPointCount = 0;
  for (const node of facts.nodeKinds) {
    const classified = classifyNodeKind(node.kind);
    if (classified === "parameter") parameterCount++;
    if (classified === "return") {
      returnCount++;
      exitPointCount++;
    }
    if (classified === "exit") exitPointCount++;
  }

  const metrics: Record<string, number> = {
    physical_loc: physicalLoc,
    sloc,
    blank_lines: blankLines.size,
    comment_lines: commentLines.size,
    doc_lines: docLines.size,
    function_count: countByScopeKind(facts, FUNCTION_KINDS),
    method_count: countByScopeKind(facts, METHOD_KINDS),
    class_count: countByScopeKind(facts, CLASS_KINDS),
    interface_count: countByScopeKind(facts, INTERFACE_KINDS),
    parameter_count: parameterCount,
    return_count: returnCount,
    exit_point_count: exitPointCount,
    max_nesting: nestingDepths.length > 0 ? Math.max(...nestingDepths) : 0,
    avg_nesting: mean(nestingDepths),
  };

  if (external.fanIn !== undefined) metrics["fan_in"] = external.fanIn;
  if (external.fanOut !== undefined) metrics["fan_out"] = external.fanOut;
  if (external.importInDegree !== undefined) metrics["import_in_degree"] = external.importInDegree;
  if (external.importOutDegree !== undefined)
    metrics["import_out_degree"] = external.importOutDegree;
  if (external.afferentCoupling !== undefined)
    metrics["afferent_coupling"] = external.afferentCoupling;
  if (external.efferentCoupling !== undefined)
    metrics["efferent_coupling"] = external.efferentCoupling;
  if (external.inheritanceDepth !== undefined)
    metrics["inheritance_depth"] = external.inheritanceDepth;
  if (external.publicApiCount !== undefined) metrics["public_api_count"] = external.publicApiCount;

  if (external.instability !== undefined) {
    metrics["instability"] = external.instability;
  } else if (external.afferentCoupling !== undefined && external.efferentCoupling !== undefined) {
    const denom = external.afferentCoupling + external.efferentCoupling;
    if (denom > 0) {
      metrics["instability"] = external.efferentCoupling / denom;
    }
  }

  return { metrics, algorithmVersion };
}
