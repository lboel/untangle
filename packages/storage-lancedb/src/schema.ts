import { createHash } from "node:crypto";

import type { Table } from "@lancedb/lancedb";
import type { CollectionSpecV1, PayloadIndexSpecV1, VectorPointV1 } from "@untangle-code/domain";
import type { Schema } from "apache-arrow";

import { filterColumns } from "./filters.js";
import { invalid, schemaError } from "./operation.js";

export const CATALOG_TABLE = "untangle_catalog_v1";
const FORMAT_KEY = "untangle.storage.format";

export interface CollectionRecord extends Record<string, unknown> {
  name: string;
  table_name: string;
  spec_json: string;
  indexes_json: string;
  schema_version: number;
}

export interface PointRow extends Record<string, unknown> {
  id: string;
  id_order: string;
  filter_tokens: string[];
  written_at_values: number[];
  payload: string;
  dense: number[] | null;
  sparse_indices: number[] | null;
  sparse_values: number[] | null;
}

export function normalizeSpec(spec: CollectionSpecV1): CollectionSpecV1 {
  if (typeof spec.name !== "string" || !spec.name || spec.name.length > 512)
    throw invalid("A collection name must contain 1..512 characters.");
  if (
    !Number.isInteger(spec.denseDimensions) ||
    spec.denseDimensions < 1 ||
    spec.denseDimensions > 65536
  )
    throw invalid("denseDimensions must be an integer in 1..65536.");
  if (
    !["Cosine", "Dot", "Euclid"].includes(spec.denseDistance) ||
    typeof spec.sparseBm25 !== "boolean" ||
    typeof spec.onDiskPayload !== "boolean"
  )
    throw invalid("Collection vector distance and storage flags are invalid.");
  return {
    name: spec.name,
    denseDimensions: spec.denseDimensions,
    denseDistance: spec.denseDistance,
    sparseBm25: spec.sparseBm25,
    onDiskPayload: spec.onDiskPayload,
  };
}

export function collectionTableName(name: string): string {
  return "vectors_" + createHash("sha256").update(JSON.stringify(name)).digest("hex");
}

export function sqlString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

/** JSON string keys round-trip even lone UTF-16 surrogates and embedded NULs. */
export const storedId = (id: string): string => JSON.stringify(id);

/** ASCII key preserves JavaScript UTF-16 comparison, including lone surrogates. */
export function idOrder(id: string): string {
  let result = "";
  for (let i = 0; i < id.length; i += 1) result += id.charCodeAt(i).toString(16).padStart(4, "0");
  return result;
}

export async function catalogSchema(): Promise<Schema> {
  const a = await import("apache-arrow");
  return new a.Schema(
    [
      new a.Field("name", new a.Utf8(), false),
      new a.Field("table_name", new a.Utf8(), false),
      new a.Field("spec_json", new a.Utf8(), false),
      new a.Field("indexes_json", new a.Utf8(), false),
      new a.Field("schema_version", new a.Int32(), false),
    ],
    new Map([[FORMAT_KEY, "catalog:1"]]),
  );
}

export async function pointSchema(spec: CollectionSpecV1): Promise<Schema> {
  const a = await import("apache-arrow");
  return new a.Schema(
    [
      new a.Field("id", new a.Utf8(), false),
      new a.Field("id_order", new a.Utf8(), false),
      new a.Field("filter_tokens", new a.List(new a.Field("item", new a.Utf8(), false)), false),
      new a.Field(
        "written_at_values",
        new a.List(new a.Field("item", new a.Float64(), false)),
        false,
      ),
      new a.Field("payload", new a.Utf8(), false),
      new a.Field(
        "dense",
        new a.FixedSizeList(spec.denseDimensions, new a.Field("item", new a.Float64(), true)),
        true,
      ),
      new a.Field("sparse_indices", new a.List(new a.Field("item", new a.Uint32(), false)), true),
      new a.Field("sparse_values", new a.List(new a.Field("item", new a.Float64(), false)), true),
    ],
    new Map([
      [FORMAT_KEY, "points:1"],
      ["untangle.collection", JSON.stringify(spec)],
    ]),
  );
}

export async function assertTableSchema(table: Table, wanted: Schema): Promise<void> {
  const actual = await table.schema();
  const fields = (schema: Schema) =>
    schema.fields.map((field) => [field.name, field.type.toString(), field.nullable]);
  if (
    JSON.stringify(fields(actual)) !== JSON.stringify(fields(wanted)) ||
    [...wanted.metadata].some(([key, value]) => actual.metadata.get(key) !== value)
  )
    throw schemaError("Existing Lance table has an incompatible schema or ownership marker.");
}

export function readCollectionRecord(raw: Record<string, unknown>, name: string): CollectionRecord {
  if (
    raw["name"] !== storedId(name) ||
    raw["schema_version"] !== 1 ||
    typeof raw["spec_json"] !== "string" ||
    typeof raw["indexes_json"] !== "string" ||
    raw["table_name"] !== collectionTableName(name)
  )
    throw schemaError("The Lance collection catalog contains an invalid record.", {
      collection: name,
    });
  return raw as unknown as CollectionRecord;
}

export function recordSpec(record: CollectionRecord): CollectionSpecV1 {
  try {
    const spec = normalizeSpec(JSON.parse(record.spec_json) as CollectionSpecV1);
    if (storedId(spec.name) !== record.name) throw new Error("Collection identity differs.");
    return spec;
  } catch (cause) {
    throw schemaError("The stored collection specification is invalid.", {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export function readIndexes(record: CollectionRecord): PayloadIndexSpecV1[] {
  try {
    const value: unknown = JSON.parse(record.indexes_json);
    if (!Array.isArray(value)) throw new Error("Not an array.");
    const names = new Set<string>();
    for (const entry of value) {
      validateIndex(entry as PayloadIndexSpecV1);
      if (names.has((entry as PayloadIndexSpecV1).field)) throw new Error("Duplicate field.");
      names.add((entry as PayloadIndexSpecV1).field);
    }
    return value as PayloadIndexSpecV1[];
  } catch {
    throw schemaError("The stored payload-index catalog is invalid.");
  }
}

export function validateIndex(index: PayloadIndexSpecV1): void {
  if (
    !index ||
    typeof index.field !== "string" ||
    !index.field ||
    !["keyword", "integer", "float", "bool"].includes(index.type)
  )
    throw invalid("A payload index requires a field name and a supported scalar type.");
}

export function encodePoint(point: VectorPointV1, spec: CollectionSpecV1): PointRow {
  if (
    !point ||
    typeof point.id !== "string" ||
    !point.id ||
    !point.payload ||
    typeof point.payload !== "object" ||
    Array.isArray(point.payload)
  )
    throw invalid("A point requires a non-empty string ID and an object payload.");
  if (
    point.dense !== undefined &&
    (!Array.isArray(point.dense) ||
      point.dense.length !== spec.denseDimensions ||
      !point.dense.every(Number.isFinite))
  )
    throw schemaError(
      "Point dense vector does not match the collection dimensions or contains non-finite values.",
      { id: point.id, expectedDimensions: spec.denseDimensions },
    );
  if (point.sparse !== undefined && !spec.sparseBm25)
    throw schemaError("The collection does not declare a sparse vector.", { id: point.id });
  if (point.sparse !== undefined) validateSparse(point.sparse.indices, point.sparse.values);
  let payload: string;
  try {
    payload = JSON.stringify(point.payload);
    const decoded: unknown = JSON.parse(payload);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw invalid("A point payload must serialize to an object.");
  } catch {
    throw invalid("A point payload must be JSON serializable.");
  }
  return {
    id: storedId(point.id),
    id_order: idOrder(point.id),
    ...filterColumns(JSON.parse(payload) as Record<string, unknown>),
    payload,
    dense: point.dense ? [...point.dense] : null,
    sparse_indices: point.sparse ? [...point.sparse.indices] : null,
    sparse_values: point.sparse ? [...point.sparse.values] : null,
  };
}

export function validateSparse(indices: readonly number[], values: readonly number[]): void {
  if (
    !Array.isArray(indices) ||
    !Array.isArray(values) ||
    indices.length !== values.length ||
    indices.some((index) => !Number.isInteger(index) || index < 0 || index > 0xffffffff) ||
    new Set(indices).size !== indices.length ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw invalid(
      "Sparse vectors require unique uint32 indices and matching finite non-negative weights.",
    );
}

export function decodePoint(
  row: Record<string, unknown>,
  vectors: boolean,
  spec?: CollectionSpecV1,
): VectorPointV1 {
  try {
    if (typeof row["id"] !== "string" || typeof row["payload"] !== "string")
      throw new Error("Missing point fields.");
    const id: unknown = JSON.parse(row["id"]);
    const payload: unknown = JSON.parse(row["payload"]);
    if (
      typeof id !== "string" ||
      !id ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      throw new Error("Invalid point identity/payload.");
    const point: VectorPointV1 = { id, payload: payload as Record<string, unknown> };
    if (vectors && row["dense"] != null) point.dense = Array.from(row["dense"] as Iterable<number>);
    if (
      point.dense &&
      (!point.dense.every(Number.isFinite) || (spec && point.dense.length !== spec.denseDimensions))
    )
      throw new Error("Invalid stored dense vector.");
    if (vectors && row["sparse_indices"] != null) {
      point.sparse = {
        indices: Array.from(row["sparse_indices"] as Iterable<number>),
        values: Array.from(row["sparse_values"] as Iterable<number>),
      };
      validateSparse(point.sparse.indices, point.sparse.values);
      if (spec && !spec.sparseBm25) throw new Error("Unexpected stored sparse vector.");
    }
    return point;
  } catch {
    throw schemaError(
      "A persisted Lance point cannot be decoded without losing its identity or vectors.",
    );
  }
}
