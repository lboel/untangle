/**
 * @untangle-code/testkit — deterministic, network-free test infrastructure for
 * Untangle:
 *
 * - in-memory implementations of every `@untangle-code/domain` port needed
 *   for fast unit tests (Clock, Random, LoggerPort, VectorStore,
 *   MetadataStore, GraphStore, LockProvider, FileSystemPort, GitPort);
 * - a deterministic `EmbeddingProvider` (architecture.md §27.2);
 * - port-contract suites (`src/contracts/`) written once against the
 *   `domain` port signatures and runnable, unchanged, against real
 *   Qdrant/Ollama/filesystem/git adapters;
 * - a `FixtureBuilder` plus generators for the spec.md §27.2 mandatory
 *   fixtures, materializing real multi-repo workspaces on disk;
 * - retrieval-benchmark evaluation (`RetrievalCase`, `evaluate()`,
 *   spec.md §27.3: Recall@5, Recall@10, MRR, Repository-Diversity);
 * - a golden-JSON assertion helper with an `UNTANGLE_UPDATE_GOLDEN=1`
 *   update mode;
 * - the small pieces of retrieval math the in-memory `VectorStore` needs to
 *   behave like the real Qdrant-backed one (BM25 sparse scoring, RRF
 *   fusion, dense vector math, payload-filter matching).
 *
 * No network, no Docker, no Ollama required — see README.md "Entscheidungen"
 * for what is (and, just as importantly, is deliberately not) covered.
 * This module is the ONLY public export of the package.
 */

// Vector math (cosine similarity, L2 norm/normalize) for dense ranking.
export * from "./math.js";

// Okapi BM25 sparse scoring over hashed token sets.
export * from "./bm25.js";

// Reciprocal Rank Fusion for combining dense/sparse ranked lists.
export * from "./rrf.js";

// Qdrant-style payload-filter matching (must/mustNot/should).
export * from "./payload-filter.js";

// Deterministic EmbeddingProvider (architecture.md §27.2).
export * from "./embedder.js";

// Golden-JSON assertions (spec.md §27.1).
export * from "./golden.js";

// In-memory port implementations.
export * from "./in-memory/clock.js";
export * from "./in-memory/random.js";
export * from "./in-memory/logger.js";
export * from "./in-memory/lock-provider.js";
export * from "./in-memory/vector-store.js";
export * from "./in-memory/metadata-store.js";
export * from "./in-memory/graph-store.js";
export * from "./in-memory/file-system.js";
export * from "./in-memory/git-provider.js";

// Port-contract suites (spec.md §27.1 "Port contract tests").
export * from "./contracts/vector-store.contract.js";
export * from "./contracts/metadata-store.contract.js";
export * from "./contracts/graph-store.contract.js";
export * from "./contracts/lock-provider.contract.js";
export * from "./contracts/file-system.contract.js";
export * from "./contracts/embedding-provider.contract.js";

// Fixture builder and generators (spec.md §27.2).
export * from "./fixtures/types.js";
export * from "./fixtures/fixture-builder.js";
export * from "./fixtures/generators/index.js";

// Retrieval-benchmark evaluation (spec.md §27.3).
export * from "./retrieval/types.js";
export * from "./retrieval/evaluate.js";

// E4-Absicherung: Ehrlichkeit unter Beschaedigung (WP-165).
export * from "./honesty/finding.js";
export * from "./honesty/completeness.js";
export * from "./honesty/damage.js";
export * from "./honesty/assert-honest.js";
