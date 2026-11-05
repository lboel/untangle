/**
 * Die Verdrahtung: von Ports zu einem lauffaehigen Indexjob.
 *
 * Dieses Modul baut die sieben Stufen dieses Pakets zusammen, reicht sie dem
 * `IndexJobRunner` von `@untangle-code/jobs` und uebersetzt dessen Ereignisse
 * in einen Bericht. Es entscheidet NICHTS ueber Adapter — welcher Einbetter,
 * welcher Speicher, welches Repository steht ausserhalb (in `untangle index`
 * oder in einem Test). Genau deshalb laeuft derselbe Code gegen einen echten
 * Vektorspeicher und gegen einen im Prozess.
 *
 * DER ABSCHLUSS IST EINDEUTIG: Der Ereignisstrom des Laeufers endet mit genau
 * einem Abschlussereignis. Dieses Modul uebernimmt es unveraendert als
 * `outcome`. Es gibt keinen Pfad, auf dem ein Fehlschlag zu „completed" wird —
 * und keinen, auf dem ein Lauf ohne Abschlussereignis als Erfolg gilt (dann
 * lautet das Ergebnis `failed` mit genau dieser Begruendung).
 */
import {
  UntangleError,
  type CheckpointStorePort,
  type EmbeddingProfile,
  type JobEvent,
  type LockProvider,
  type PayloadFilter,
  type PortCallOptions,
  type SparseVectorV1,
} from "@untangle-code/domain";
import { checkpointMatches, IndexJobRunner, type IndexJobStages } from "@untangle-code/jobs";

import { withCancellationTranslation } from "./cancellation.js";
import { AnalysisCollector } from "./collected.js";
import { SkipCollector } from "./ledger.js";
import { createAnalysisStage } from "./stages/analysis.js";
import { createCommitStage } from "./stages/commit.js";
import {
  createDiscoveryStage,
  createDiscoveryState,
  type DiscoveryStateV1,
} from "./stages/discovery.js";
import { createEmbeddingStage } from "./stages/embedding.js";
import { createGraphStage } from "./stages/graphs.js";
import { createInfrastructureStage } from "./stages/infrastructure.js";
import { pruneObsoleteCodePoints } from "./stages/prune-generation.js";
import { createStorageStage } from "./stages/storage.js";
import type {
  IndexCountsV1,
  IndexPortsV1,
  IndexReportV1,
  IndexTargetV1,
  IndexTuningV1,
} from "./types.js";

export interface RunIndexOptions {
  ports: IndexPortsV1;
  target: IndexTargetV1;
  tuning?: IndexTuningV1 | undefined;
  /** Das Einbettungsprofil des Laufs; MUSS zu `ports.embedder.profile` passen. */
  profile: EmbeddingProfile;
  embeddingProfileId: string;
  /** Name der Code-Sammlung (spec.md §10.1). */
  collection: string;
  /** Legt Sammlung und Payload-Indexe an. */
  provisionCollection: (options?: PortCallOptions) => Promise<void>;
  /** Textvektorisierung fuer BM25 (spec.md §10.2). */
  sparseVectorizer: (text: string) => SparseVectorV1;
  /** Basis-URL des Vektorspeichers, nur fuer die Endpunktmeldung. */
  storeUrl: string;
  /** Hash der wirksamen Konfiguration (spec.md §5.1). */
  configHash: string;
  checkpointStore: CheckpointStorePort;
  lockProvider?: LockProvider | undefined;
  /** false rechnet jede Datei neu, auch unveraenderte. Vorgabe true. */
  incremental?: boolean | undefined;
  /** false ignoriert vorhandene Checkpoints. Vorgabe true. */
  resume?: boolean | undefined;
  /** Dateien je Einbettungsstapel (zugleich Checkpoint-Stapel). Vorgabe 8. */
  embedBatchSize?: number | undefined;
  jobId?: string | undefined;
  generationId?: string | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: JobEvent) => void) | undefined;
  /** Persist a durable incomplete marker before the runner may mutate this generation. */
  onGenerationStarted?: ((generationId: string) => Promise<void>) | undefined;
  /** Persist the terminal generation state before the runner releases its repository lock. */
  onGenerationFinished?:
    | ((
        generationId: string,
        outcome: "completed" | "cancelled" | "failed",
        corpusRevisionFingerprint?: string,
      ) => Promise<void>)
    | undefined;
}

/** Die gebauten Stufen samt ihrem gemeinsamen Zustand — fuer Tests einzeln greifbar. */
export interface IndexStagesBundle {
  stages: IndexJobStages;
  ledger: SkipCollector;
  collector: AnalysisCollector;
  discovery: DiscoveryStateV1;
  counts: MutableCounts;
}

interface MutableCounts {
  chunks: number;
  symbols: number;
  analyzed: number;
  points: number;
  cacheHits: number;
  computed: number;
  parseCacheHits: number;
  parseCacheMisses: number;
  chunkCacheHits: number;
  chunkCacheMisses: number;
  metricsCacheHits: number;
  metricsCacheMisses: number;
  truncated: number;
  removed: number;
  fileGraphNodes: number;
  fileGraphEdges: number;
  symbolGraphNodes: number;
  symbolGraphEdges: number;
}

/**
 * Baut alle Stufen. `generationIdHolder` ist eine Funktion, weil die Generation
 * erst der Laeufer festlegt (oder aus einem Checkpoint uebernimmt) — die
 * Graphstufe braucht sie aber beim Bauen noch nicht, nur beim Laufen.
 */
export function createIndexStages(
  options: RunIndexOptions,
  generationIdHolder: () => string,
): IndexStagesBundle {
  const ledger = new SkipCollector();
  const collector = new AnalysisCollector();
  const discovery = createDiscoveryState();
  const counts: MutableCounts = {
    chunks: 0,
    symbols: 0,
    analyzed: 0,
    points: 0,
    cacheHits: 0,
    computed: 0,
    parseCacheHits: 0,
    parseCacheMisses: 0,
    chunkCacheHits: 0,
    chunkCacheMisses: 0,
    metricsCacheHits: 0,
    metricsCacheMisses: 0,
    truncated: 0,
    removed: 0,
    fileGraphNodes: 0,
    fileGraphEdges: 0,
    symbolGraphNodes: 0,
    symbolGraphEdges: 0,
  };
  const tuning = options.tuning ?? {};

  const stages: IndexJobStages = {
    infrastructure: createInfrastructureStage({
      embedder: options.ports.embedder,
      provisionCollection: options.provisionCollection,
      storeUrl: options.storeUrl,
    }),
    discovery: createDiscoveryStage({
      fs: options.ports.fs,
      metadataStore: options.ports.metadataStore,
      target: options.target,
      tuning,
      ledger,
      state: discovery,
      incremental: options.incremental ?? true,
      previousGenerationToReuse: async (callOptions) => {
        if (options.resume === false) return null;
        const checkpoint = await options.checkpointStore.loadLatest(
          options.target.repoId,
          options.target.refId,
          callOptions,
        );
        if (
          checkpoint === null ||
          !checkpointMatches(checkpoint, {
            workspaceId: options.target.workspaceId,
            repoId: options.target.repoId,
            refId: options.target.refId,
            effectiveProfileId: options.embeddingProfileId,
          })
        ) {
          return null;
        }
        return checkpoint.generationId;
      },
    }),
    analysis: createAnalysisStage({
      fs: options.ports.fs,
      parsers: options.ports.parsers,
      target: options.target,
      generationId: generationIdHolder,
      embeddingProfileId: options.embeddingProfileId,
      documentPrefix: tuning.documentPrefix ?? options.profile.documentPrefix,
      maxChunkTokens: tuning.maxChunkTokens,
      ledger,
      collector,
      discovery,
      counts,
      cache: options.ports.analysisCache,
    }),
    embedding: createEmbeddingStage({
      embedder: options.ports.embedder,
      cache: options.ports.embeddingCache,
      embeddingProfileId: options.embeddingProfileId,
      dimensions: options.profile.dimensions,
      counts,
    }),
    storage: createStorageStage({
      vectorStore: options.ports.vectorStore,
      collection: options.collection,
      sparseVectorizer: options.sparseVectorizer,
      counts,
    }),
    graphs: createGraphStage({
      fs: options.ports.fs,
      parsers: options.ports.parsers,
      graphStore: options.ports.graphStore,
      random: options.ports.random,
      target: options.target,
      collector,
      discovery,
      ledger,
      generationId: generationIdHolder,
      counts,
    }),
    commit: createCommitStage({
      metadataStore: options.ports.metadataStore,
      clock: options.ports.clock,
      target: options.target,
      collector,
      discovery,
      profile: options.profile,
      embeddingProfileId: options.embeddingProfileId,
      configHash: options.configHash,
      deletePointsOfFiles: (fileIds, callOptions) =>
        deletePointsOfFiles(options, fileIds, callOptions),
      pruneObsoleteGeneration: (generationId, callOptions) =>
        pruneObsoleteCodePoints(
          {
            vectorStore: options.ports.vectorStore,
            collection: options.collection,
            target: options.target,
            generationId,
          },
          callOptions,
        ),
      counts,
    }),
  };

  return {
    // Die Abbruch-Uebersetzung liegt um ALLE Stufen, nicht in jeder einzeln —
    // sonst fehlte sie an der Stelle, an der sie das naechste Mal gebraucht
    // wird (siehe `cancellation.ts`).
    stages: withCancellationTranslation(stages),
    ledger,
    collector,
    discovery,
    counts,
  };
}

/**
 * Fuehrt einen vollstaendigen Indexlauf aus und liefert den Bericht.
 *
 * Wirft NICHT fuer Fehlschlaege des Jobs — die sind das Ergebnis
 * (`outcome: "failed"` mit Code und Begruendung). Geworfen wird nur, was VOR
 * dem Start schiefgeht (unbrauchbare Optionen).
 */
export async function runIndex(options: RunIndexOptions): Promise<IndexReportV1> {
  let generationId = "";
  const bundle = createIndexStages(options, () => {
    // Der Runner kennt die Generation unmittelbar nach der Resume-Planung.
    // Der Ereignisstrom darf dagegen zeitlich hinter dem Producer liegen:
    // insbesondere ein unveraenderter Lauf kann von `files_discovered` direkt
    // zum Graphaufbau weiterlaufen, bevor der Consumer unten das Ereignis
    // gesehen hat. Die interne Graphstufe darf deshalb nie vom Beobachter-
    // Timing des Streams abhaengen.
    const activeGeneration = runner.status().generationId;
    return activeGeneration === null || activeGeneration === undefined || activeGeneration === ""
      ? generationId
      : activeGeneration;
  });

  const runner = new IndexJobRunner({
    identity: {
      workspaceId: options.target.workspaceId,
      repoId: options.target.repoId,
      refId: options.target.refId,
      effectiveProfileId: options.embeddingProfileId,
    },
    stages: bundle.stages,
    checkpointStore: options.checkpointStore,
    clock: options.ports.clock,
    random: options.ports.random,
    ...(options.ports.logger === undefined ? {} : { logger: options.ports.logger }),
    ...(options.lockProvider === undefined ? {} : { lockProvider: options.lockProvider }),
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    ...(options.generationId === undefined ? {} : { generationId: options.generationId }),
    ...(options.onGenerationStarted === undefined
      ? {}
      : { onGenerationStarted: options.onGenerationStarted }),
    ...(options.onGenerationFinished === undefined
      ? {}
      : { onGenerationFinished: options.onGenerationFinished }),
    embedBatchSize: options.embedBatchSize ?? 8,
    resume: options.resume ?? true,
  });

  let outcome: IndexReportV1["outcome"] | null = null;
  let failure: IndexReportV1["failure"];
  let jobId = "";

  const stream = runner.run(options.signal === undefined ? {} : { signal: options.signal });
  for await (const event of stream) {
    jobId = event.jobId;
    if (event.generationId !== undefined && event.generationId !== "") {
      generationId = event.generationId;
    }
    options.onEvent?.(event);
    if (event.kind === "job_completed") outcome = "completed";
    else if (event.kind === "job_cancelled") outcome = "cancelled";
    else if (event.kind === "job_failed") {
      outcome = "failed";
      failure = { code: event.errorCode, message: event.message, retryable: event.retryable };
    }
  }

  if (outcome === null) {
    // Kann der Laeufer laut Vertrag nicht liefern. Waere es doch so, ist das
    // KEIN Erfolg — ein Lauf ohne Abschluss ist ein Fehlschlag mit Namen.
    outcome = "failed";
    failure = {
      code: "INDEX_INCOMPLETE",
      message: "The event stream ended without a completion event.",
      retryable: false,
    };
  }

  // Die Manifeste der Analyse-Caches werden im Speicher gefuehrt (WP-100);
  // hier bekommen sie ihren einen Schreibvorgang. Schlaegt er fehl, ist das
  // KEIN Fehlschlag des Laufs: der Index steht, nur der naechste Lauf trifft
  // weniger. Der Grund geht deshalb ins Protokoll, nicht in das Ergebnis.
  try {
    await options.ports.analysisCache?.flush?.();
  } catch (error) {
    options.ports.logger?.log({
      timestamp: options.ports.clock.nowIso(),
      level: "warn",
      component: "core.index",
      event: "analysis_cache_flush_failed",
      context: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  const status = runner.status();
  const counts: IndexCountsV1 = {
    filesSeen: bundle.discovery.counts.seen,
    filesPlanned: bundle.discovery.counts.planned,
    filesUnchanged: bundle.discovery.counts.unchanged,
    filesIgnored: bundle.discovery.counts.ignored,
    filesAnalyzed: bundle.counts.analyzed,
    filesRemoved: bundle.counts.removed,
    chunks: bundle.counts.chunks,
    symbols: bundle.counts.symbols,
    points: bundle.counts.points,
    embeddingCacheHits: bundle.counts.cacheHits,
    embeddingsComputed: bundle.counts.computed,
    parseCacheHits: bundle.counts.parseCacheHits,
    parseCacheMisses: bundle.counts.parseCacheMisses,
    chunkCacheHits: bundle.counts.chunkCacheHits,
    chunkCacheMisses: bundle.counts.chunkCacheMisses,
    metricsCacheHits: bundle.counts.metricsCacheHits,
    metricsCacheMisses: bundle.counts.metricsCacheMisses,
    truncated: bundle.counts.truncated,
    fileGraphNodes: bundle.counts.fileGraphNodes,
    fileGraphEdges: bundle.counts.fileGraphEdges,
    symbolGraphNodes: bundle.counts.symbolGraphNodes,
    symbolGraphEdges: bundle.counts.symbolGraphEdges,
  };

  return {
    schemaVersion: 1,
    jobId: jobId === "" ? status.jobId : jobId,
    generationId: generationId === "" ? status.generationId : generationId,
    workspaceId: options.target.workspaceId,
    repoId: options.target.repoId,
    refId: options.target.refId,
    embeddingProfileId: options.embeddingProfileId,
    collection: options.collection,
    outcome,
    counts,
    ...(failure === undefined ? {} : { failure }),
    skipped: bundle.ledger.list(),
    skippedByReason: bundle.ledger.counts,
    skippedByStage: bundle.ledger.countsByStage,
    skippedTruncated: bundle.ledger.truncated,
  };
}

/**
 * Loescht die Punkte entfernter Dateien.
 *
 * In Scheiben, weil ein `in`-Filter mit tausenden Werten sonst die
 * Anfragegrenze des Speichers reisst — und ein zu grosser Filter, der
 * fehlschlaegt, liesse verwaiste Punkte stehen, die weiter als Treffer
 * auftauchen.
 */
async function deletePointsOfFiles(
  options: RunIndexOptions,
  fileIds: readonly string[],
  callOptions?: PortCallOptions,
): Promise<void> {
  const sliceSize = 128;
  for (let start = 0; start < fileIds.length; start += sliceSize) {
    const slice = fileIds.slice(start, start + sliceSize);
    const filter: PayloadFilter = {
      must: [
        { field: "workspace_id", match: { eq: options.target.workspaceId } },
        { field: "ref_id", match: { eq: options.target.refId } },
        { field: "file_id", match: { in: [...slice] } },
      ],
    };
    try {
      await options.ports.vectorStore.deleteByFilter(options.collection, filter, callOptions);
    } catch (error) {
      throw new UntangleError(
        "INDEX_INCOMPLETE",
        `Could not delete points for ${String(slice.length)} removed files: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, operation: "index.commit", cause: error },
      );
    }
  }
}
