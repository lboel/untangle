/**
 * Stufe 7 des Indexlaufs (spec.md §11.1 `storing`).
 *
 * Der Punkt bekommt hier seinen SPARSE-Vektor. Er wird NICHT in der
 * Analysestufe mitgeschleppt, sondern aus dem Payload neu gebaut
 * (`file_path`, `symbol_name`, `symbol_fqn`, `content`) — dieselben Felder,
 * aus denen ihn der Chunker gebaut haette. Das spart eine zweite Textkopie je
 * Chunk durch alle Warteschlangen und macht die Ableitung nachpruefbar: was im
 * Punkt steht, ist genau das, woraus der Vektor entstand.
 *
 * `upsert` allein ersetzt nur identische Punkt-IDs. Wenn eine geaenderte Datei
 * weniger Chunks oder andere Symbol-IDs erzeugt, wuerden ihre alten Punkte
 * deshalb weiter gefunden. Ein Storage-Batch ist eine vollstaendige
 * Dateibestaetigung: Vor dem Upsert werden alle bisherigen Punkte seiner
 * Dateien entfernt und danach ausschliesslich die aktuellen Punkte abgelegt.
 * Das bleibt auch fuer Dateien ohne Chunks und bei einem Retry korrekt.
 *
 * Der Adapter teilt zu grosse Stapel selbst auf und lehnt einen einzelnen zu
 * grossen Punkt mit `POINT_TOO_LARGE` ab, statt ihn stumm fallen zu lassen.
 */
import { buildBm25Text } from "@untangle-code/chunker";
import {
  compareCodepoints,
  UntangleError,
  type PayloadFilter,
  type SparseVectorV1,
  type PortCallOptions,
  type VectorPointV1,
  type VectorStore,
} from "@untangle-code/domain";
import type { EmbeddedBatchV1, StorageStage, UpsertConfirmationV1 } from "@untangle-code/jobs";

export interface StorageStageDeps {
  vectorStore: VectorStore;
  collection: string;
  /** Textvektorisierung; in Tests die des testkits, sonst die von storage-qdrant. */
  sparseVectorizer: (text: string) => SparseVectorV1;
  counts: { points: number };
}

export function createStorageStage(deps: StorageStageDeps): StorageStage {
  return {
    async upsertBatch(
      batch: EmbeddedBatchV1,
      options?: PortCallOptions,
    ): Promise<UpsertConfirmationV1> {
      const points: VectorPointV1[] = [];
      const storedPointIdsByFile: Record<string, string[]> = {};

      for (const point of batch.points) {
        const payload = point.payload ?? {};
        const sparse = deps.sparseVectorizer(
          buildBm25Text(
            {
              filePath: stringOf(payload["file_path"]) ?? "",
              ...(stringOf(payload["symbol_name"]) === undefined
                ? {}
                : { symbolName: stringOf(payload["symbol_name"]) }),
              ...(stringOf(payload["symbol_fqn"]) === undefined
                ? {}
                : { symbolFqn: stringOf(payload["symbol_fqn"]) }),
            },
            stringOf(payload["content"]) ?? "",
          ),
        );
        points.push({
          id: point.pointId,
          dense: point.vector,
          ...(sparse.indices.length === 0 ? {} : { sparse }),
          payload,
        });
        (storedPointIdsByFile[point.fileId] ??= []).push(point.pointId);
      }

      for (const ids of Object.values(storedPointIdsByFile)) ids.sort(compareCodepoints);

      // Auch eine Datei OHNE Chunks muss im Ergebnis stehen. Sonst gilt sie dem
      // Laeufer als nicht bestaetigt, und der Lauf kann laut
      // `assertGenerationComplete` nie "completed" werden (E4: keine
      // Vollstaendigkeit behaupten, aber auch keine unerklaerte Unvollstaendigkeit).
      for (const file of batch.files) storedPointIdsByFile[file.fileId] ??= [];

      const serializedBytes = points.reduce(
        (sum, point) => sum + JSON.stringify(point.payload).length,
        0,
      );

      // Der Runner legt jede Datei genau einmal und vollstaendig in einen
      // EmbeddedBatch. Delete-before-upsert macht daraus ein idempotentes
      // Replace: Ein Retry entfernt einen eventuell teilgeschriebenen Versuch
      // und ein erfolgreicher Lauf kann keine pensionierten Chunk- oder
      // Symbol-Punkte derselben Datei zuruecklassen. Die Loeschung muss auch
      // bei `points.length === 0` stattfinden.
      await deletePointsOfFiles(
        deps,
        [...new Set(batch.files.map((file) => file.fileId))].sort(compareCodepoints),
        options,
      );

      if (points.length > 0) {
        const result = await deps.vectorStore.upsert(deps.collection, points, options);
        if (result.upsertedCount !== points.length) {
          throw new UntangleError(
            "INDEX_INCOMPLETE",
            `The store acknowledged ${String(result.upsertedCount)} of ${String(points.length)} points.`,
            { retryable: true, operation: "index.upsert" },
          );
        }
        deps.counts.points += points.length;
      }

      return {
        collection: deps.collection,
        pointCount: points.length,
        serializedBytes,
        storedPointIdsByFile,
      };
    },
  };
}

/** Keep delete filters bounded just like generation-commit cleanup does. */
async function deletePointsOfFiles(
  deps: Pick<StorageStageDeps, "vectorStore" | "collection">,
  fileIds: readonly string[],
  options?: PortCallOptions,
): Promise<void> {
  const sliceSize = 128;
  for (let start = 0; start < fileIds.length; start += sliceSize) {
    const filter: PayloadFilter = {
      must: [{ field: "file_id", match: { in: fileIds.slice(start, start + sliceSize) } }],
    };
    await deps.vectorStore.deleteByFilter(deps.collection, filter, options);
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
