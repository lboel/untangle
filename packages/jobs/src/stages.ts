/**
 * Narrow stage interfaces of the index pipeline (architecture.md §13.1).
 *
 * This package builds the pipeline MECHANICS — state machine, queues,
 * backpressure, checkpoints, resume, cancellation, generation commit. The
 * domain-specific stages (scanner, parser, chunker, embedder, stores) are
 * INJECTED behind these interfaces; `@untangle-code/core` wires the real
 * implementations later, tests wire deterministic fakes from
 * `@untangle-code/testkit` ports.
 *
 * Every method takes trailing `PortCallOptions` and must respect
 * `options.signal` (spec.md §22); the runner additionally only ever acts on
 * results at safe batch boundaries (architecture.md §21.3).
 */
import type { ParseQuality, PortCallOptions } from "@untangle-code/domain";

/** One file the discovery stage planned for (re)indexing. */
export interface PlannedFileV1 {
  fileId: string;
  /** "/"-normalized repo-relative path. */
  filePath: string;
  /** Content hash — source of truth for change detection (spec.md §12.1). */
  contentHash: string;
}

/** Result of the discovery stage (scanner + manifest comparison). */
export interface DiscoveryResultV1 {
  /** Files that need work in this run (changed or new). */
  planned: PlannedFileV1[];
  /**
   * Every currently searchable source file, including unchanged files.
   * This is kept separate from the resume checkpoint manifest: the latter
   * proves confirmed writes, while this snapshot identifies the corpus the
   * completed generation represents.
   */
  corpusManifestHashes: Record<string, string>;
  totalFiles: number;
  unchangedFiles: number;
  ignoredFiles: number;
}

/** Ensures Qdrant/Ollama/collections are ready (spec.md §11.1 stage 2). */
export interface InfrastructureStage {
  ensureReady(options?: PortCallOptions): Promise<{
    /** Effective endpoints with secrets redacted (spec.md §3.2). */
    endpoints: Record<string, string>;
  }>;
}

export interface DiscoveryStage {
  discover(options?: PortCallOptions): Promise<DiscoveryResultV1>;
}

/** One prepared text ready for embedding, keyed by its future point id. */
export interface PreparedTextV1 {
  pointId: string;
  text: string;
  payload?: Record<string, unknown>;
}

/** Parse + chunk + metrics output for one file (stages 4–5 of spec.md §11.1). */
export interface AnalyzedFileV1 {
  file: PlannedFileV1;
  parseQuality: ParseQuality;
  chunkCount: number;
  symbolCount: number;
  preparedTexts: PreparedTextV1[];
  /** Estimated in-memory size — feeds the queue byte budget (§13.2). */
  estimatedBytes: number;
}

export interface AnalysisStage {
  analyze(file: PlannedFileV1, options?: PortCallOptions): Promise<AnalyzedFileV1>;
}

/** One embedded point ready for upsert. */
export interface EmbeddedPointV1 {
  pointId: string;
  fileId: string;
  vector: number[];
  payload?: Record<string, unknown>;
}

/** Result of embedding one file batch. */
export interface EmbeddedBatchV1 {
  files: PlannedFileV1[];
  points: EmbeddedPointV1[];
  cacheHits: number;
  truncatedCount: number;
  /** Estimated in-memory size — feeds the queue byte budget (§13.2). */
  estimatedBytes: number;
}

export interface EmbeddingStage {
  embedBatch(batch: AnalyzedFileV1[], options?: PortCallOptions): Promise<EmbeddedBatchV1>;
}

/**
 * Confirmation of one CONFIRMED upsert. The runner persists a checkpoint
 * only after receiving this (spec.md §10.5) — a storage stage must therefore
 * resolve only once the store acknowledged the write.
 */
export interface UpsertConfirmationV1 {
  collection: string;
  pointCount: number;
  serializedBytes: number;
  /** Confirmed point ids per file id — recorded in the checkpoint (§13.3). */
  storedPointIdsByFile: Record<string, string[]>;
}

export interface StorageStage {
  upsertBatch(batch: EmbeddedBatchV1, options?: PortCallOptions): Promise<UpsertConfirmationV1>;
}

/** Result of building/patching one graph (stage `building_graphs`). */
export interface GraphBuildResultV1 {
  graph: "file" | "symbol";
  nodeCount: number;
  edgeCount: number;
}

export interface GraphStage {
  buildGraphs(options?: PortCallOptions): Promise<GraphBuildResultV1[]>;
}

/** Optional context-artifact indexing (stage `indexing_context`). */
export interface ContextStage {
  indexContext(options?: PortCallOptions): Promise<void>;
}

/** Input the runner hands to the generation commit (architecture.md §13.4). */
export interface GenerationCommitInputV1 {
  jobId: string;
  generationId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  effectiveProfileId: string;
  plannedFileIds: string[];
  confirmedFileIds: string[];
  storedGraphs: string[];
}

export interface GenerationCommitResultV1 {
  /** Must be "completed" for the job to finish as completed (§13.4). */
  metadataStatus: string;
}

export interface GenerationCommitStage {
  commit(
    input: GenerationCommitInputV1,
    options?: PortCallOptions,
  ): Promise<GenerationCommitResultV1>;
}

/** The full injected stage set of one index job. */
export interface IndexJobStages {
  infrastructure: InfrastructureStage;
  discovery: DiscoveryStage;
  analysis: AnalysisStage;
  embedding: EmbeddingStage;
  storage: StorageStage;
  graphs: GraphStage;
  /** Optional — a workspace without context artifacts skips the stage's work. */
  context?: ContextStage;
  commit: GenerationCommitStage;
}
