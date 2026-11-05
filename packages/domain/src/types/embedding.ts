/**
 * Embedding profile (spec.md §5.7, §9).
 *
 * Exactly these eight fields feed `embedding_profile_id`
 * (`SHA256(canonical_json(profile_fields))`, see `buildEmbeddingProfileId`).
 * Operational settings such as batch size, timeouts or endpoint URLs are
 * deliberately NOT part of the profile: they do not change vector semantics.
 */
export interface EmbeddingProfile {
  /** Embedding provider id, e.g. "ollama" (spec.md §4.5). */
  provider: string;
  /** Model name, e.g. "nomic-embed-text". */
  model: string;
  /** Vector dimensionality; must match the collection schema (spec.md §10.2). */
  dimensions: number;
  /** Prefix prepended to query texts, e.g. "search_query: ". */
  queryPrefix: string;
  /** Prefix prepended to document texts, e.g. "search_document: ". */
  documentPrefix: string;
  /** Whether the file path is included in the prepared document text. */
  includePath: boolean;
  /** Vector normalization option, e.g. "none" or "l2". */
  normalization: string;
  /** Version of the prepared-text format (spec.md §8.6). */
  preparedTextVersion: string;
}
