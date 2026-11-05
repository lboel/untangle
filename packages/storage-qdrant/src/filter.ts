/**
 * Maps the domain `PayloadFilter` (a subset of Qdrant filter semantics,
 * ports.ts) onto the Qdrant REST wire format, so payload filters run
 * DIRECTLY in Qdrant (spec.md §13.2 step 7) instead of client-side.
 */
import type { FieldCondition, PayloadFilter } from "@untangle-code/domain";

/** Qdrant wire condition (subset used by this adapter). */
export interface QdrantWireCondition {
  key: string;
  match?: { value: string | number | boolean } | { any: (string | number | boolean)[] };
  range?: { gt?: number; gte?: number; lt?: number; lte?: number };
}

/** Qdrant wire filter. */
export interface QdrantWireFilter {
  must?: QdrantWireCondition[];
  should?: QdrantWireCondition[];
  must_not?: QdrantWireCondition[];
}

function toWireCondition(condition: FieldCondition): QdrantWireCondition {
  if ("match" in condition) {
    if ("eq" in condition.match) {
      return { key: condition.field, match: { value: condition.match.eq } };
    }
    return { key: condition.field, match: { any: [...condition.match.in] } };
  }
  return { key: condition.field, range: { ...condition.range } };
}

/**
 * Converts a `PayloadFilter` to the wire format. Returns `undefined` for an
 * absent or empty filter (Qdrant treats an omitted filter as match-all).
 */
export function toQdrantFilter(filter?: PayloadFilter): QdrantWireFilter | undefined {
  if (!filter) {
    return undefined;
  }
  const wire: QdrantWireFilter = {};
  if (filter.must && filter.must.length > 0) {
    wire.must = filter.must.map(toWireCondition);
  }
  if (filter.should && filter.should.length > 0) {
    wire.should = filter.should.map(toWireCondition);
  }
  if (filter.mustNot && filter.mustNot.length > 0) {
    wire.must_not = filter.mustNot.map(toWireCondition);
  }
  if (wire.must === undefined && wire.should === undefined && wire.must_not === undefined) {
    return undefined;
  }
  return wire;
}
