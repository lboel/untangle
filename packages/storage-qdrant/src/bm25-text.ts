/**
 * Client-side BM25 text vectorization (spec.md §10.2, architecture.md §11.4).
 *
 * Decision (see README "Entscheidungen"): OSS Qdrant does not ship
 * server-side text-to-sparse inference (that is a managed-cloud feature), so
 * the indexer/query pipeline vectorizes text CLIENT-SIDE into raw
 * term-frequency sparse vectors; the IDF weighting itself stays SERVER-SIDE
 * via the sparse vector's `modifier: "idf"` (spec.md §10.2).
 *
 * The tokenizer is shared through the domain package with local reranking and
 * the testkit, so partial identifier queries reach the same lexical term space
 * as indexed code. The testkit remains test infrastructure, never a production
 * dependency. Its hash/vector implementation is checked for parity below.
 */
import { tokenizeIdentifiers, type SparseVectorV1 } from "@untangle-code/domain";

/** Shared full-identifier and component-word bag, identical for documents and queries. */
export function tokenizeForBm25(text: string): string[] {
  return tokenizeIdentifiers(text);
}

/**
 * Deterministic FNV-1a 32-bit hash of a token, folded into a non-negative
 * integer term id below 2^31. Pure arithmetic — stable across processes and
 * platforms, and identical to the testkit's hashing so unit-test corpora and
 * production corpora share one term-id space.
 */
export function hashBm25Token(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7fffffff;
}

/**
 * Turns text into a raw term-frequency sparse vector: one (termId, count)
 * pair per distinct token, sorted by index for deterministic output. Qdrant
 * applies the IDF weighting at query time (`modifier: "idf"`).
 */
export function textToBm25SparseVector(text: string): SparseVectorV1 {
  const counts = new Map<number, number>();
  for (const token of tokenizeForBm25(text)) {
    const index = hashBm25Token(token);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const indices = [...counts.keys()].sort((a, b) => a - b);
  const values = indices.map((index) => counts.get(index) ?? 0);
  return { indices, values };
}
