/**
 * Facts scoping and byte/line utilities shared by every calculator
 * (architecture.md §15.1). Every calculator is scope-agnostic: it operates on
 * whatever `ComplexityFacts` it is handed. `selectSymbolFacts` is how a
 * caller narrows file-level facts down to one symbol's facts before calling
 * a calculator for `scope: "symbol"`; passing the file's facts unfiltered is
 * how a caller computes `scope: "file"`.
 */
import type { ComplexityFacts, SourceRange } from "@untangle-code/domain";

function byScope<T extends { symbolScopeId: string }>(
  items: readonly T[],
  symbolScopeId: string,
): T[] {
  return items.filter((item) => item.symbolScopeId === symbolScopeId);
}

/** True iff `inner` lies fully inside `outer` (byte-interval containment, both inclusive/exclusive per domain convention). */
export function containsRange(outer: SourceRange, inner: SourceRange): boolean {
  return outer.startByte <= inner.startByte && inner.endByte <= outer.endByte;
}

/** True iff `outer` strictly contains `inner` (contains, but is not the identical range). */
export function strictlyContainsRange(outer: SourceRange, inner: SourceRange): boolean {
  if (!containsRange(outer, inner)) return false;
  return outer.startByte !== inner.startByte || outer.endByte !== inner.endByte;
}

/** Stable identity key for deduplicating facts that reference the same source span. */
export function rangeKey(range: SourceRange): string {
  return `${range.startByte}:${range.endByte}`;
}

/**
 * Narrows file-level `ComplexityFacts` to the facts belonging to one symbol
 * scope. Fact kinds that carry `symbolScopeId` (decisions, nestingEvents,
 * operators, operands, nodeKinds, identifiers, literals) are filtered by
 * exact id match — a symbol's own facts are attributed directly to it, never
 * inherited from nested named symbols, which get their own `SymbolScopeFact`
 * and their own facts (architecture.md §15.1; Untangle decision, see
 * README "Entscheidungen" #1). `comments` and `parseDiagnostics` carry no
 * `symbolScopeId` and are instead filtered by byte-range containment inside
 * the symbol's own range.
 *
 * Returns empty fact arrays (rather than throwing) when `symbolScopeId` is
 * not present in `facts.symbolScopes` — a caller passing a stale id gets an
 * empty-but-valid `ComplexityFacts`, not a crash.
 */
export function selectSymbolFacts(facts: ComplexityFacts, symbolScopeId: string): ComplexityFacts {
  const symbolScope = facts.symbolScopes.find((s) => s.symbolScopeId === symbolScopeId);
  const range = symbolScope?.range;
  return {
    symbolScopes: facts.symbolScopes.filter((s) => s.symbolScopeId === symbolScopeId),
    decisions: byScope(facts.decisions, symbolScopeId),
    nestingEvents: byScope(facts.nestingEvents, symbolScopeId),
    operators: byScope(facts.operators, symbolScopeId),
    operands: byScope(facts.operands, symbolScopeId),
    nodeKinds: byScope(facts.nodeKinds, symbolScopeId),
    comments: range ? facts.comments.filter((r) => containsRange(range, r)) : [],
    identifiers: byScope(facts.identifiers, symbolScopeId),
    literals: byScope(facts.literals, symbolScopeId),
    parseDiagnostics: range
      ? facts.parseDiagnostics.filter((d) => containsRange(range, d.range))
      : [],
  };
}

/** Slices `sourceText` by a byte-offset `SourceRange` (UTF-8, per domain convention). */
export function sliceByRange(sourceText: string, range: SourceRange): string {
  const buf = Buffer.from(sourceText, "utf8");
  return buf.subarray(range.startByte, range.endByte).toString("utf8");
}

/** Splits text into physical lines, normalizing CRLF/CR to LF first. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}
