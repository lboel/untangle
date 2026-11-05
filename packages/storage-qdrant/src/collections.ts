/**
 * Collection naming (spec.md §10.1, architecture.md §11.1) and payload-index
 * provisioning (spec.md §10.4).
 */
import type {
  CollectionSpecV1,
  EmbeddingProfile,
  PayloadIndexSpecV1,
  PortCallOptions,
  VectorStore,
} from "@untangle-code/domain";
import { buildEmbeddingProfileId, embeddingProfileShortId } from "@untangle-code/domain";

import { assertValidCollectionPrefix } from "./config.js";

/** `{prefix}code_{profile_short_id}_v1` (spec.md §10.1). */
export function codeCollectionName(prefix: string, profileShortId: string): string {
  assertValidCollectionPrefix(prefix);
  return `${prefix}code_${profileShortId}_v1`;
}

/** `{prefix}context_{profile_short_id}_v1` (spec.md §10.1). */
export function contextCollectionName(prefix: string, profileShortId: string): string {
  assertValidCollectionPrefix(prefix);
  return `${prefix}context_${profileShortId}_v1`;
}

/** `{prefix}changes_{profile_short_id}_v1` (spec.md §10.1). */
export function changesCollectionName(prefix: string, profileShortId: string): string {
  assertValidCollectionPrefix(prefix);
  return `${prefix}changes_${profileShortId}_v1`;
}

/** `{prefix}metadata_v1` (spec.md §10.1). */
export function metadataCollectionName(prefix: string): string {
  assertValidCollectionPrefix(prefix);
  return `${prefix}metadata_v1`;
}

/** `{prefix}complexity_history_v1` (spec.md §10.1). */
export function complexityHistoryCollectionName(prefix: string): string {
  assertValidCollectionPrefix(prefix);
  return `${prefix}complexity_history_v1`;
}

/** `{prefix}graph_files_v1` / `{prefix}graph_indices_v1` / `{prefix}graph_meta_v1`. */
export function graphCollectionName(
  prefix: string,
  collection: "graph_files" | "graph_indices" | "graph_meta",
): string {
  assertValidCollectionPrefix(prefix);
  return `${prefix}${collection}_v1`;
}

/** Keyword payload indexes that MUST exist on code collections (spec.md §10.4). */
export const CODE_KEYWORD_INDEX_FIELDS: readonly string[] = [
  "point_type",
  "workspace_id",
  "repo_id",
  "ref_id",
  "file_id",
  "file_path",
  "language",
  "parse_quality",
  "symbol_id",
  "symbol_name",
  "symbol_fqn",
  "symbol_kind",
  "chunk_kind",
  "content_hash",
  "embedding_profile_id",
];

/** Numeric payload indexes for code collections (spec.md §10.4). */
export const CODE_NUMERIC_INDEXES: readonly PayloadIndexSpecV1[] = [
  { field: "cyclomatic_classic", type: "integer" },
  { field: "cyclomatic_extended", type: "integer" },
  { field: "cognitive", type: "integer" },
  { field: "max_nesting", type: "integer" },
  { field: "sloc", type: "integer" },
  { field: "halstead_volume", type: "float" },
  { field: "maintainability_index", type: "float" },
  { field: "risk_score", type: "float" },
  { field: "changed_at_epoch_ms", type: "integer" },
];

/** The complete payload-index set of a code collection (spec.md §10.4). */
export const CODE_PAYLOAD_INDEXES: readonly PayloadIndexSpecV1[] = [
  ...CODE_KEYWORD_INDEX_FIELDS.map((field): PayloadIndexSpecV1 => ({ field, type: "keyword" })),
  ...CODE_NUMERIC_INDEXES,
];

/**
 * Collection spec of a code collection (spec.md §10.2): dense vector sized
 * from the embedding profile with Cosine distance, a "bm25" sparse vector
 * with IDF modifier, payload on disk.
 */
export function codeCollectionSpec(name: string, profile: EmbeddingProfile): CollectionSpecV1 {
  return {
    name,
    denseDimensions: profile.dimensions,
    denseDistance: "Cosine",
    sparseBm25: true,
    onDiskPayload: true,
  };
}

/**
 * Provisions the code collection of one embedding profile: name per
 * spec.md §10.1, schema per §10.2, ALL payload indexes per §10.4 (missing
 * indexes are created, never silently skipped — enforced by
 * `QdrantVectorStore.ensurePayloadIndexes`).
 */
export async function provisionCodeCollection(
  store: VectorStore,
  input: { prefix: string; profile: EmbeddingProfile },
  options?: PortCallOptions,
): Promise<{ collection: string; profileId: string }> {
  const profileId = buildEmbeddingProfileId(input.profile);
  const collection = codeCollectionName(input.prefix, embeddingProfileShortId(profileId));
  await store.ensureCollection(codeCollectionSpec(collection, input.profile), options);
  await store.ensurePayloadIndexes(collection, [...CODE_PAYLOAD_INDEXES], options);
  return { collection, profileId };
}
