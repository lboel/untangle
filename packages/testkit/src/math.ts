/**
 * Small, dependency-free vector math shared by the deterministic embedder
 * and the in-memory vector store's dense ranking.
 */

/** Dot product of two equal-length vectors. Shorter operand's length wins (defensive). */
export function dotProduct(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/** Euclidean (L2) norm of a vector. */
export function l2Norm(vector: readonly number[]): number {
  return Math.sqrt(dotProduct(vector, vector));
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector has zero norm
 * (an all-zero embedding has no direction, so "similarity" is undefined —
 * treating it as 0 keeps ranking stable instead of producing `NaN`).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const normA = l2Norm(a);
  const normB = l2Norm(b);
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dotProduct(a, b) / (normA * normB);
}

/** L2-normalizes a vector; an all-zero input is returned unchanged (see {@link cosineSimilarity}). */
export function l2Normalize(vector: readonly number[]): number[] {
  const norm = l2Norm(vector);
  if (norm === 0) {
    return [...vector];
  }
  return vector.map((value) => value / norm);
}
