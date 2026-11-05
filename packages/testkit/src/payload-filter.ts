/**
 * Payload-filter matcher for `InMemoryVectorStore`. Generic over any payload
 * key, so it covers every keyword/numeric field listed in spec.md §10.4
 * (`point_type`, `workspace_id`, …, `risk_score`, `changed_at_epoch_ms`)
 * without hard-coding the field list.
 */
import type { FieldCondition, PayloadFilter } from "@untangle-code/domain";

function matchesCondition(payload: Record<string, unknown>, condition: FieldCondition): boolean {
  const actual = payload[condition.field];
  if ("match" in condition) {
    if ("eq" in condition.match) {
      return actual === condition.match.eq;
    }
    return condition.match.in.includes(actual as never);
  }
  if (typeof actual !== "number") {
    return false;
  }
  const { gt, gte, lt, lte } = condition.range;
  if (gt !== undefined && !(actual > gt)) return false;
  if (gte !== undefined && !(actual >= gte)) return false;
  if (lt !== undefined && !(actual < lt)) return false;
  if (lte !== undefined && !(actual <= lte)) return false;
  return true;
}

/**
 * Evaluates a `PayloadFilter` against one point's payload. Semantics mirror
 * Qdrant: `must` (AND, all conditions match), `mustNot` (AND, none match),
 * `should` (OR, at least one matches when the clause is non-empty) — the
 * three clauses themselves combine with AND. An absent/undefined filter
 * matches everything.
 */
export function matchesPayloadFilter(
  payload: Record<string, unknown>,
  filter?: PayloadFilter,
): boolean {
  if (!filter) {
    return true;
  }
  if (filter.must && !filter.must.every((condition) => matchesCondition(payload, condition))) {
    return false;
  }
  if (filter.mustNot && filter.mustNot.some((condition) => matchesCondition(payload, condition))) {
    return false;
  }
  if (filter.should && filter.should.length > 0) {
    if (!filter.should.some((condition) => matchesCondition(payload, condition))) {
      return false;
    }
  }
  return true;
}
