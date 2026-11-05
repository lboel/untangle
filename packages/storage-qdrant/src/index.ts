/**
 * @untangle-code/storage-qdrant — the Qdrant storage adapter of Untangle
 * (spec.md §10, §13.2–§13.5; architecture.md §11).
 *
 * Implements three domain ports over the Qdrant REST API:
 * - `VectorStore` (`QdrantVectorStore`): provisioning, payload indexes,
 *   byte-/count-budgeted idempotent upserts, hybrid dense+BM25 queries with
 *   in-collection RRF;
 * - `MetadataStore` (`QdrantMetadataStore`): workspace/ref/manifest/
 *   checkpoint/profile records as dummy-vector points;
 * - `GraphStore` (`QdrantGraphStore`): multipart graph shards with
 *   write_id/part_index/part_count/checksum verification.
 *
 * This module is the ONLY public export of the package.
 */

// Adapter configuration (spec.md §4.4).
export * from "./config.js";

// HTTP transport boundary (fetch implementation + test seam).
export * from "./transport.js";

// Collection naming and payload-index provisioning (spec.md §10.1, §10.4).
export * from "./collections.js";

// Client-side BM25 text vectorization (spec.md §10.2, README "Entscheidungen").
export * from "./bm25-text.js";

// Payload filter mapping (domain PayloadFilter → Qdrant wire filter).
export * from "./filter.js";

// Point id mapping (arbitrary string ids → deterministic Qdrant UUIDs).
export * from "./point-id.js";

// Ports.
export * from "./vector-store.js";
export * from "./metadata-store.js";
export * from "./graph-store.js";

// Cross-collection query rule (spec.md §13.4).
export * from "./cross-collection.js";

// RRF (used by the cross-collection merge; exported for reuse).
export * from "./rrf.js";

// Convenience wiring.
export * from "./factory.js";
