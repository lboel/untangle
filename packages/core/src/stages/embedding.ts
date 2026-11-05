/**
 * Stufe 6 des Indexlaufs (spec.md §11.1 `embedding`).
 *
 * DER INHALTSADRESSIERTE ZWISCHENSPEICHER SITZT HIER, nicht im Anbieter
 * (spec.md §9.4). Grund: der Schluessel ist
 * `embedding_profile_id + SHA256(prepared_text)` und damit voellig unabhaengig
 * davon, WER einbettet. Sitzt der Speicher hier, wirkt er fuer jeden Anbieter
 * gleich — und der zweite Lauf ueber unveraenderte Dateien rechnet auch dann
 * nichts neu, wenn eine Datei zwar neu ist, ihr Text aber schon einmal
 * eingebettet wurde (verschobener Code, kopierte Datei).
 *
 * E4 AN DER SCHAERFSTEN STELLE DES PRODUKTS: Faellt der Einbetter aus, wirft
 * diese Stufe `EMBEDDING_UNAVAILABLE`. Sie liefert NIEMALS einen leeren oder
 * teilweisen Stapel zurueck, denn ein leerer Stapel ist fuer den Laeufer ein
 * erfolgreich verarbeiteter Stapel — der Lauf endete dann mit „fertig" und
 * einem leeren Index. Genau dieser Fehler wurde in Welle 4 in `query` gefunden.
 * Dasselbe gilt fuer eine falsche Vektorlaenge: ein Vektor, der nicht in die
 * Sammlung passt, ist `EMBEDDING_DIMENSION_MISMATCH`, kein uebersprungener
 * Punkt.
 */
import { UntangleError, type EmbeddingProvider, type PortCallOptions } from "@untangle-code/domain";
import type {
  AnalyzedFileV1,
  EmbeddedBatchV1,
  EmbeddedPointV1,
  EmbeddingStage,
  PlannedFileV1,
} from "@untangle-code/jobs";

import type { EmbeddingCacheLike } from "../types.js";

export interface EmbeddingStageDeps {
  embedder: EmbeddingProvider;
  cache?: EmbeddingCacheLike | undefined;
  embeddingProfileId: string;
  dimensions: number;
  counts: { cacheHits: number; computed: number; truncated: number };
}

interface Pending {
  fileId: string;
  pointId: string;
  text: string;
  payload: Record<string, unknown> | undefined;
}

export function createEmbeddingStage(deps: EmbeddingStageDeps): EmbeddingStage {
  return {
    async embedBatch(batch: AnalyzedFileV1[], options?: PortCallOptions): Promise<EmbeddedBatchV1> {
      const files: PlannedFileV1[] = batch.map((analyzed) => analyzed.file);
      const pending = collectPending(batch);

      if (pending.length === 0) {
        return { files, points: [], cacheHits: 0, truncatedCount: 0, estimatedBytes: 0 };
      }

      const vectors = new Array<number[] | null>(pending.length).fill(null);
      const truncatedFlags = new Array<boolean>(pending.length).fill(false);
      let cacheHits = 0;

      if (deps.cache !== undefined) {
        for (let index = 0; index < pending.length; index++) {
          const item = pending[index] as Pending;
          let hit: number[] | null = null;
          try {
            hit = await deps.cache.get(deps.embeddingProfileId, item.text, options);
          } catch (error) {
            // Ein kaputter Zwischenspeicher darf den Lauf nicht kosten — aber
            // er darf auch nicht so tun, als sei nichts gewesen. Der Fehler
            // wird zur Neuberechnung, und nur dazu.
            hit = null;
            if (isCancellation(error)) throw error;
          }
          if (hit !== null) {
            vectors[index] = hit;
            cacheHits++;
          }
        }
      }

      const missIndexes = findMissingVectorIndexes(vectors);

      if (missIndexes.length === 0) {
        return finalizeEmbeddedBatch(deps, files, pending, vectors, truncatedFlags, cacheHits);
      }

      const texts = missIndexes.map((index) => (pending[index] as Pending).text);
      let result;
      try {
        result = await deps.embedder.embedDocuments(texts, options);
      } catch (error) {
        if (isCancellation(error)) throw error;
        throw new UntangleError(
          "EMBEDDING_UNAVAILABLE",
          `The embedder returned no result for ${String(texts.length)} texts: ${messageOf(error)}`,
          {
            retryable: true,
            operation: "index.embed",
            cause: error,
            context: { textCount: texts.length },
          },
        );
      }

      if (result.vectors.length !== texts.length) {
        throw new UntangleError(
          "EMBEDDING_UNAVAILABLE",
          `The embedder returned ${String(result.vectors.length)} vectors for ${String(texts.length)} texts.`,
          { retryable: false, operation: "index.embed" },
        );
      }

      for (let position = 0; position < missIndexes.length; position++) {
        const index = missIndexes[position] as number;
        const vector = result.vectors[position] as number[];
        assertVectorDimensions(vector, deps.dimensions);
        vectors[index] = vector;
        truncatedFlags[index] = result.truncated[position] === true;
        if (deps.cache === undefined) continue;
        try {
          await deps.cache.set(
            deps.embeddingProfileId,
            (pending[index] as Pending).text,
            vector,
            options,
          );
        } catch (error) {
          if (isCancellation(error)) throw error;
          // A failed cache write only requires recomputation on the next run.
        }
      }
      deps.counts.computed += missIndexes.length;

      return finalizeEmbeddedBatch(deps, files, pending, vectors, truncatedFlags, cacheHits);
    },
  };
}

function collectPending(batch: readonly AnalyzedFileV1[]): Pending[] {
  const pending: Pending[] = [];
  for (const analyzed of batch) {
    for (const prepared of analyzed.preparedTexts) {
      pending.push({
        fileId: analyzed.file.fileId,
        pointId: prepared.pointId,
        text: prepared.text,
        payload: prepared.payload,
      });
    }
  }
  return pending;
}

function findMissingVectorIndexes(vectors: readonly (number[] | null)[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < vectors.length; index++) {
    if (vectors[index] === null) indexes.push(index);
  }
  return indexes;
}

function assertVectorDimensions(vector: number[], dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new UntangleError(
      "EMBEDDING_DIMENSION_MISMATCH",
      `The embedder returned a vector with length ${String(vector.length)}, ` +
        `the collection expects ${String(dimensions)}.`,
      { retryable: false, operation: "index.embed" },
    );
  }
}

function finalizeEmbeddedBatch(
  deps: EmbeddingStageDeps,
  files: PlannedFileV1[],
  pending: readonly Pending[],
  vectors: readonly (number[] | null)[],
  truncatedFlags: readonly boolean[],
  cacheHits: number,
): EmbeddedBatchV1 {
  const points: EmbeddedPointV1[] = [];
  let estimatedBytes = 0;
  let truncatedCount = 0;
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index] as Pending;
    const vector = vectors[index] ?? null;
    if (vector === null) {
      // Keep this guard so malformed port results cannot silently lose points.
      throw new UntangleError(
        "EMBEDDING_UNAVAILABLE",
        `No vector exists for chunk "${item.pointId}".`,
        { retryable: false, operation: "index.embed" },
      );
    }
    const truncated = truncatedFlags[index] === true;
    if (truncated) truncatedCount++;
    const payload = item.payload;
    if (payload !== undefined) payload["embedding_truncated"] = truncated;
    points.push({
      pointId: item.pointId,
      fileId: item.fileId,
      vector,
      ...(payload === undefined ? {} : { payload }),
    });
    estimatedBytes += vector.length * 8 + item.text.length * 2;
  }

  deps.counts.cacheHits += cacheHits;
  deps.counts.truncated += truncatedCount;

  return { files, points, cacheHits, truncatedCount, estimatedBytes };
}

function isCancellation(error: unknown): boolean {
  return (
    (error instanceof UntangleError && error.code === "JOB_CANCELLED") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
