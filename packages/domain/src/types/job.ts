/**
 * Job events, stages and checkpoints (architecture.md §2.2, §13.3; spec.md §11).
 */
import type { ErrorCode } from "../errors.js";

import type { ParseQuality } from "./common.js";

/** Full-index state machine stages incl. terminal error states (spec.md §11.1). */
export const INDEX_JOB_STAGES = [
  "queued",
  "preparing_infrastructure",
  "discovering_files",
  "parsing_and_chunking",
  "computing_metrics",
  "embedding",
  "storing",
  "checkpointing",
  "building_graphs",
  "indexing_context",
  "finalizing",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;

export type IndexJobStage = (typeof INDEX_JOB_STAGES)[number];

/**
 * Common fields of every job event. Event field shapes beyond the names in
 * architecture.md §2.2 are Untangle decisions (see README "Entscheidungen").
 */
export interface JobEventBase {
  jobId: string;
  workspaceId: string;
  /** ISO-8601; obtained via the Clock port. */
  occurredAt: string;
  generationId?: string;
}

export interface JobQueuedEvent extends JobEventBase {
  kind: "job_queued";
  /** Operation name, e.g. "index", "update", "portfolio_scan". */
  operation: string;
}

export interface InfrastructureReadyEvent extends JobEventBase {
  kind: "infrastructure_ready";
  /** Effective endpoints with secrets redacted (spec.md §3.2). */
  endpoints: Record<string, string>;
}

export interface FilesDiscoveredEvent extends JobEventBase {
  kind: "files_discovered";
  repoId: string;
  refId: string;
  totalFiles: number;
  changedFiles: number;
  unchangedFiles: number;
  ignoredFiles: number;
}

export interface FileAnalyzedEvent extends JobEventBase {
  kind: "file_analyzed";
  repoId: string;
  refId: string;
  fileId: string;
  filePath: string;
  parseQuality: ParseQuality;
  chunkCount: number;
  symbolCount: number;
}

export interface EmbeddingBatchCompletedEvent extends JobEventBase {
  kind: "embedding_batch_completed";
  batchIndex: number;
  batchSize: number;
  cacheHits: number;
  truncatedCount: number;
}

export interface PointsStoredEvent extends JobEventBase {
  kind: "points_stored";
  collection: string;
  pointCount: number;
  serializedBytes: number;
}

export interface CheckpointSavedEvent extends JobEventBase {
  kind: "checkpoint_saved";
  stage: IndexJobStage;
  completedFileCount: number;
}

export interface GraphUpdatedEvent extends JobEventBase {
  kind: "graph_updated";
  graph: "file" | "symbol";
  nodeCount: number;
  edgeCount: number;
}

export interface JobCompletedEvent extends JobEventBase {
  kind: "job_completed";
  durationMs: number;
}

export interface JobFailedEvent extends JobEventBase {
  kind: "job_failed";
  errorCode: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface JobCancelledEvent extends JobEventBase {
  kind: "job_cancelled";
  /** True when a checkpoint was saved at a safe batch boundary before stopping. */
  checkpointSaved: boolean;
}

/** Typed job event union (architecture.md §2.2). */
export type JobEvent =
  | JobQueuedEvent
  | InfrastructureReadyEvent
  | FilesDiscoveredEvent
  | FileAnalyzedEvent
  | EmbeddingBatchCompletedEvent
  | PointsStoredEvent
  | CheckpointSavedEvent
  | GraphUpdatedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | JobCancelledEvent;

/** Index checkpoint (architecture.md §13.3) — exact shape. */
export interface IndexCheckpointV1 {
  jobId: string;
  generationId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  effectiveProfileId: string;
  completedFiles: string[];
  storedPointIdsByFile: Record<string, string[]>;
  manifestHashes: Record<string, string>;
  stage: string;
  /** ISO-8601; obtained via the Clock port. */
  savedAt: string;
}
