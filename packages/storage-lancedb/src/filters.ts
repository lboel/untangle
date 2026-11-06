import { Buffer } from "node:buffer";

import type { FieldCondition, PayloadFilter } from "@untangle-code/domain";

import { invalid } from "./operation.js";

export function validateFilter(filter: PayloadFilter | undefined): void {
  if (filter === undefined) return;
  if (!filter || typeof filter !== "object" || Array.isArray(filter))
    throw invalid("A filter must be an object.");
  for (const conditions of [filter.must, filter.should, filter.mustNot]) {
    if (conditions === undefined) continue;
    if (!Array.isArray(conditions)) throw invalid("Filter clauses must be arrays.");
    for (const condition of conditions) {
      if (!condition || typeof condition.field !== "string" || !condition.field)
        throw invalid("A filter condition needs a field.");
      if ("match" in condition) {
        if (!condition.match || typeof condition.match !== "object")
          throw invalid("A filter match must be an object.");
        const values = "eq" in condition.match ? [condition.match.eq] : condition.match.in;
        if (
          !Array.isArray(values) ||
          values.some(
            (value) =>
              !["string", "number", "boolean"].includes(typeof value) ||
              (typeof value === "number" && !Number.isFinite(value)),
          )
        )
          throw invalid("Filter matches require finite scalar values.");
      } else if (
        !condition.range ||
        typeof condition.range !== "object" ||
        Object.values(condition.range).some((value) => !Number.isFinite(value))
      )
        throw invalid("Filter ranges require finite numbers.");
    }
  }
}

export function fieldValues(payload: Record<string, unknown>, field: string): unknown[] {
  if (Object.hasOwn(payload, field)) {
    const direct = payload[field];
    return Array.isArray(direct) ? direct : [direct];
  }
  let values: unknown[] = [payload];
  for (const part of field.split(".")) {
    values = values.flatMap((value) => {
      const objects = Array.isArray(value) ? value : [value];
      return objects.flatMap((object) =>
        object !== null && typeof object === "object" && Object.hasOwn(object, part)
          ? [(object as Record<string, unknown>)[part]]
          : [],
      );
    });
  }
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function matchesCondition(payload: Record<string, unknown>, condition: FieldCondition): boolean {
  return fieldValues(payload, condition.field).some((actual) => {
    if ("match" in condition)
      return "eq" in condition.match
        ? actual === condition.match.eq
        : condition.match.in.some((value) => value === actual);
    if (typeof actual !== "number" || !Number.isFinite(actual)) return false;
    const { gt, gte, lt, lte } = condition.range;
    return (
      (gt === undefined || actual > gt) &&
      (gte === undefined || actual >= gte) &&
      (lt === undefined || actual < lt) &&
      (lte === undefined || actual <= lte)
    );
  });
}

export function matchesFilter(payload: Record<string, unknown>, filter?: PayloadFilter): boolean {
  return (
    !filter ||
    ((filter.must?.every((condition) => matchesCondition(payload, condition)) ?? true) &&
      !(filter.mustNot?.some((condition) => matchesCondition(payload, condition)) ?? false) &&
      (!filter.should?.length ||
        filter.should.some((condition) => matchesCondition(payload, condition))))
  );
}

export function scalarToken(field: string, value: string | number | boolean): string {
  return JSON.stringify([field, value]);
}

export const MAX_FILTER_TOKEN_BYTES = 4096;

function promotedToken(field: string, value: string | number | boolean): string | null {
  if (
    field.length > MAX_FILTER_TOKEN_BYTES ||
    (typeof value === "string" && value.length > MAX_FILTER_TOKEN_BYTES)
  )
    return null;
  const token = scalarToken(field, value);
  return Buffer.byteLength(token) <= MAX_FILTER_TOKEN_BYTES ? token : null;
}

/** Materialized from the persisted JSON payload, with exactly fieldValues semantics. */
export function filterColumns(payload: Record<string, unknown>): {
  filter_tokens: string[];
  written_at_values: number[];
} {
  const fields = new Set<string>();
  const visit = (value: unknown, prefix: string | undefined) => {
    // Match fieldValues' one-level array traversal. Nested arrays remain
    // objects with own numeric/length properties at the next path segment.
    const objects = Array.isArray(value) ? value : [value];
    for (const object of objects) {
      if (!object || typeof object !== "object") continue;
      for (const key of Object.getOwnPropertyNames(object)) {
        const child = (object as Record<string, unknown>)[key];
        const field = prefix === undefined ? key : prefix + "." + key;
        fields.add(field);
        visit(child, field);
      }
    }
  };
  visit(payload, undefined);
  const tokens = new Set<string>();
  for (const field of fields) {
    for (const value of fieldValues(payload, field)) {
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        const token = promotedToken(field, value);
        if (token !== null) tokens.add(token);
      }
    }
  }
  return {
    filter_tokens: [...tokens],
    written_at_values: fieldValues(payload, "written_at_epoch_ms").filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    ),
  };
}

const quoted = (value: string) => "'" + value.replaceAll("'", "''") + "'";

/** null means use the bounded JS fallback; returned predicates are exact. */
export function nativeFilter(filter: PayloadFilter | undefined): string | null {
  if (!filter) return "TRUE";
  const conditionSql = (condition: FieldCondition): string | null => {
    if ("match" in condition) {
      const values = "eq" in condition.match ? [condition.match.eq] : condition.match.in;
      const tokens = values.map((value) => promotedToken(condition.field, value));
      if (tokens.some((token) => token === null)) return null;
      return values.length
        ? "(" +
            tokens
              .map((token) => `coalesce(array_contains(filter_tokens, ${quoted(token!)}), false)`)
              .join(" OR ") +
            ")"
        : "FALSE";
    }
    if (condition.field !== "written_at_epoch_ms") return null;
    const bounds = (["gt", "gte", "lt", "lte"] as const).flatMap((bound) =>
      condition.range[bound] === undefined ? [] : [[bound, condition.range[bound]!] as const],
    );
    if (bounds.length > 1) return null; // Multiple bounds must match the same array element.
    if (!bounds.length) return "coalesce(array_length(written_at_values) > 0, false)";
    const [bound, value] = bounds[0]!;
    const aggregate = bound.startsWith("lt") ? "array_min" : "array_max";
    const operator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[bound];
    return `coalesce(${aggregate}(written_at_values) ${operator} ${value}, false)`;
  };
  const clauses: string[] = [];
  for (const [kind, conditions] of [
    ["must", filter.must],
    ["should", filter.should],
    ["mustNot", filter.mustNot],
  ] as const) {
    if (!conditions?.length) continue;
    const compiled = conditions.map(conditionSql);
    if (compiled.some((value) => value === null)) return null;
    const joined = "(" + compiled.join(kind === "must" ? " AND " : " OR ") + ")";
    clauses.push(kind === "mustNot" ? "NOT " + joined : joined);
  }
  return clauses.length ? clauses.join(" AND ") : "TRUE";
}
