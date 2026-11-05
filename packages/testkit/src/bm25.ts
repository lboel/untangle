/**
 * A small, self-contained Okapi BM25 implementation over hashed token sets.
 *
 * `SparseVectorV1` (domain `ports.ts`) is index/value pairs, mirroring exactly
 * how Qdrant's `bm25`-modifier sparse vectors work: callers send raw
 * term-frequency vectors (one entry per distinct token, value = count within
 * the text) and the store applies the IDF weighting at query time from
 * corpus-wide statistics. {@link Bm25Index} is that corpus-side state;
 * {@link textToSparseVector} is the client-side tokenizer that turns text
 * into the raw term-frequency vector.
 */
import { tokenizeIdentifiers, type SparseVectorV1 } from "@untangle-code/domain";

/** BM25 term-frequency saturation constant (standard default). */
export const BM25_K1 = 1.2;
/** BM25 length-normalization constant (standard default). */
export const BM25_B = 0.75;

/** Uses the production token space for faithful in-memory sparse retrieval. */
export function tokenize(text: string): string[] {
  return tokenizeIdentifiers(text);
}

/**
 * Deterministic FNV-1a 32-bit hash of a token, folded into a non-negative
 * integer term id. Pure arithmetic — stable across processes and platforms.
 */
export function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Unsigned 32-bit, then folded below 2^31 so it is always a safe, positive
  // array/object index.
  return (hash >>> 0) % 0x7fffffff;
}

/**
 * Turns text into a raw term-frequency sparse vector: one (termId, count)
 * pair per distinct token, sorted by index for deterministic output.
 */
export function textToSparseVector(text: string): SparseVectorV1 {
  const counts = new Map<number, number>();
  for (const token of tokenize(text)) {
    const index = hashToken(token);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const indices = [...counts.keys()].sort((a, b) => a - b);
  const values = indices.map((index) => counts.get(index) ?? 0);
  return { indices, values };
}

/** Sum of term-frequency values — the document/query "length" in tokens. */
export function sparseVectorLength(vector: SparseVectorV1): number {
  return vector.values.reduce((sum, value) => sum + value, 0);
}

/** Looks up the value stored at `index` in a sparse vector (0 when absent). */
function valueAt(vector: SparseVectorV1, index: number): number {
  const position = vector.indices.indexOf(index);
  if (position === -1) {
    return 0;
  }
  return vector.values[position] ?? 0;
}

/**
 * Corpus-side BM25 state for one collection: document frequency per term id,
 * total document count and average document length. Scoring combines this
 * with the query's and a candidate document's raw term-frequency vectors.
 */
export class Bm25Index {
  private readonly documentFrequency = new Map<number, number>();
  private readonly documentLengths = new Map<string, number>();
  /**
   * Each document's own previously-added vector, keyed by id. Needed so the
   * idempotent-upsert path in {@link addDocument} can subtract exactly what
   * this id previously contributed — subtracting the newly-passed vector
   * instead (as a former version of this method did) permanently corrupts
   * `documentFrequency` for every term that appeared only in the old vector:
   * it is never decremented, so it looks forever more frequent than it is
   * (see README "Entscheidungen").
   */
  private readonly documentVectors = new Map<string, SparseVectorV1>();
  private totalLength = 0;

  public constructor(
    private readonly k1: number = BM25_K1,
    private readonly b: number = BM25_B,
  ) {}

  public get documentCount(): number {
    return this.documentLengths.size;
  }

  private get averageDocumentLength(): number {
    return this.documentCount === 0 ? 1 : this.totalLength / this.documentCount;
  }

  /** Registers (or re-registers) a document's term-frequency vector under `id`. */
  public addDocument(id: string, vector: SparseVectorV1): void {
    const previous = this.documentVectors.get(id);
    if (previous !== undefined) {
      // Idempotent upsert: drop the PREVIOUSLY STORED vector's stats for
      // this id first, so re-adding the same id never double-counts
      // (matches VectorStore upsert-by-id semantics, spec.md §10.5). This
      // must use `previous`, never the new `vector` being added right now —
      // see the `documentVectors` doc comment.
      this.removeDocument(id, previous);
    }
    const length = sparseVectorLength(vector);
    this.documentLengths.set(id, length);
    this.documentVectors.set(id, vector);
    this.totalLength += length;
    for (const index of vector.indices) {
      this.documentFrequency.set(index, (this.documentFrequency.get(index) ?? 0) + 1);
    }
  }

  /** Removes a previously added document's contribution to the corpus stats. */
  public removeDocument(id: string, vector: SparseVectorV1): void {
    const length = this.documentLengths.get(id);
    if (length === undefined) {
      return;
    }
    this.documentLengths.delete(id);
    this.documentVectors.delete(id);
    this.totalLength -= length;
    for (const index of vector.indices) {
      const df = this.documentFrequency.get(index) ?? 0;
      if (df <= 1) {
        this.documentFrequency.delete(index);
      } else {
        this.documentFrequency.set(index, df - 1);
      }
    }
  }

  private idf(index: number): number {
    const df = this.documentFrequency.get(index) ?? 0;
    const n = this.documentCount;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Okapi BM25 score of `document` against `query`, using this index's corpus stats. */
  public score(query: SparseVectorV1, document: SparseVectorV1): number {
    const docLength = sparseVectorLength(document);
    const avgdl = this.averageDocumentLength;
    let total = 0;
    for (const index of query.indices) {
      const tf = valueAt(document, index);
      if (tf === 0) {
        continue;
      }
      const numerator = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / avgdl));
      total += this.idf(index) * (numerator / denominator);
    }
    return total;
  }
}
