/**
 * Deterministic fake stages for the runner tests — network-free, built on
 * the injected-port philosophy of `@untangle-code/testkit`. Excluded from
 * the build (`tsconfig.json` exclude), used only by co-located tests.
 *
 * The fake "vector store" (`storedPoints`) and the call recorders survive
 * across runner instances on purpose: fault-injection tests restart the job
 * against the SAME stores to prove idempotency, exact resume, and that no
 * completed index is silently inconsistent (architecture.md §27.5).
 */
import { UntangleError } from "@untangle-code/domain";

import type {
  AnalyzedFileV1,
  DiscoveryResultV1,
  EmbeddedBatchV1,
  GenerationCommitInputV1,
  GraphBuildResultV1,
  IndexJobStages,
  PlannedFileV1,
} from "./stages.js";

/** Builds `count` planned files with deterministic ids/hashes. */
export function makePlannedFiles(count: number, hashSuffix = "v1"): PlannedFileV1[] {
  return Array.from({ length: count }, (_, index) => ({
    fileId: `file-${String(index).padStart(3, "0")}`,
    filePath: `src/module-${index}.ts`,
    contentHash: `hash-${index}-${hashSuffix}`,
  }));
}

export interface FakeStageWorld {
  stages: IndexJobStages;
  /** Mutable: what discovery reports on the next run. */
  discovery: DiscoveryResultV1;
  /** Recorded per call, across ALL runs. */
  analyzedFileIds: string[];
  embedBatchSizes: number[];
  upsertedFileIds: string[][];
  commitCalls: GenerationCommitInputV1[];
  /** The persistent fake vector store: pointId -> fileId. */
  storedPoints: Map<string, string>;
  /** Metadata status the LAST successful commit produced ("" = none yet). */
  committedStatus: string;
  /** Fault injection hooks — set to a function that throws to inject. */
  faults: {
    beforeUpsert: ((batch: EmbeddedBatchV1) => void) | null;
    beforeCheckpoint: (() => void) | null;
    beforeCommit: (() => void) | null;
  };
  /** Gate that, when set, makes upserts wait until released (backpressure). */
  upsertGate: { wait: () => Promise<void> } | null;
}

export interface FakeStageOptions {
  files?: PlannedFileV1[];
  pointsPerFile?: number;
  graphs?: GraphBuildResultV1[];
  commitStatus?: string;
}

function infrastructureError(message: string): UntangleError {
  return new UntangleError("QDRANT_UNAVAILABLE", message, { retryable: true });
}

/**
 * Creates a full fake stage set. Analysis/embedding/storage are immediate
 * unless a gate or fault is installed. Storage is idempotent: re-upserting
 * a point id overwrites, never duplicates.
 */
export function createFakeWorld(options: FakeStageOptions = {}): FakeStageWorld {
  const files = options.files ?? makePlannedFiles(6);
  const pointsPerFile = options.pointsPerFile ?? 2;
  const graphs: GraphBuildResultV1[] = options.graphs ?? [
    { graph: "file", nodeCount: files.length, edgeCount: files.length - 1 },
    { graph: "symbol", nodeCount: files.length * 3, edgeCount: files.length * 2 },
  ];

  const world: FakeStageWorld = {
    stages: undefined as unknown as IndexJobStages,
    discovery: {
      planned: files,
      corpusManifestHashes: Object.fromEntries(
        files.map((file) => [file.fileId, file.contentHash]),
      ),
      totalFiles: files.length + 2,
      unchangedFiles: 1,
      ignoredFiles: 1,
    },
    analyzedFileIds: [],
    embedBatchSizes: [],
    upsertedFileIds: [],
    commitCalls: [],
    storedPoints: new Map<string, string>(),
    committedStatus: "",
    faults: { beforeUpsert: null, beforeCheckpoint: null, beforeCommit: null },
    upsertGate: null,
  };

  world.stages = {
    infrastructure: {
      ensureReady: async () => ({ endpoints: { vector_store: "http://localhost:16333" } }),
    },
    discovery: {
      discover: async () => ({
        planned: [...world.discovery.planned],
        corpusManifestHashes: { ...world.discovery.corpusManifestHashes },
        totalFiles: world.discovery.totalFiles,
        unchangedFiles: world.discovery.unchangedFiles,
        ignoredFiles: world.discovery.ignoredFiles,
      }),
    },
    analysis: {
      analyze: async (file): Promise<AnalyzedFileV1> => {
        world.analyzedFileIds.push(file.fileId);
        return {
          file,
          parseQuality: "complete",
          chunkCount: pointsPerFile,
          symbolCount: pointsPerFile,
          preparedTexts: Array.from({ length: pointsPerFile }, (_, index) => ({
            pointId: `${file.fileId}:p${index}`,
            text: `prepared text ${index} of ${file.filePath}`,
          })),
          estimatedBytes: 1000,
        };
      },
    },
    embedding: {
      embedBatch: async (batch): Promise<EmbeddedBatchV1> => {
        world.embedBatchSizes.push(batch.length);
        return {
          files: batch.map((analyzed) => analyzed.file),
          points: batch.flatMap((analyzed) =>
            analyzed.preparedTexts.map((text) => ({
              pointId: text.pointId,
              fileId: analyzed.file.fileId,
              vector: [0.1, 0.2, 0.3],
            })),
          ),
          cacheHits: 0,
          truncatedCount: 0,
          estimatedBytes: batch.length * 500,
        };
      },
    },
    storage: {
      upsertBatch: async (batch) => {
        if (world.upsertGate !== null) {
          await world.upsertGate.wait();
        }
        world.faults.beforeUpsert?.(batch);
        const storedPointIdsByFile: Record<string, string[]> = {};
        for (const point of batch.points) {
          // Idempotent by point id — a redo overwrites, never duplicates.
          world.storedPoints.set(point.pointId, point.fileId);
          (storedPointIdsByFile[point.fileId] ??= []).push(point.pointId);
        }
        world.upsertedFileIds.push(batch.files.map((file) => file.fileId));
        return {
          collection: "code_chunks",
          pointCount: batch.points.length,
          serializedBytes: batch.points.length * 128,
          storedPointIdsByFile,
        };
      },
    },
    graphs: {
      buildGraphs: async () => graphs.map((graph) => ({ ...graph })),
    },
    commit: {
      commit: async (input) => {
        world.faults.beforeCommit?.();
        world.commitCalls.push(input);
        const status = options.commitStatus ?? "completed";
        world.committedStatus = status;
        return { metadataStatus: status };
      },
    },
  };

  return world;
}

/** A manually releasable gate for backpressure/cancellation tests. */
export function createGate(): {
  wait: () => Promise<void>;
  release: (count?: number) => void;
  openForever: () => void;
} {
  let open = false;
  let releases = 0;
  let waiters: Array<() => void> = [];
  const drain = (): void => {
    while (waiters.length > 0 && (open || releases > 0)) {
      if (!open) {
        releases -= 1;
      }
      const waiter = waiters.shift();
      waiter?.();
    }
  };
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        drain();
      }),
    release: (count = 1) => {
      releases += count;
      drain();
    },
    openForever: () => {
      open = true;
      drain();
      waiters = [];
    },
  };
}

/** Lets the event loop settle so concurrent pipeline workers can progress. */
export async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Polls `condition` while letting the event loop advance; throws on timeout. */
export async function until(condition: () => boolean, description: string): Promise<void> {
  for (let round = 0; round < 2000; round += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition not reached: ${description}`);
}

export { infrastructureError };
