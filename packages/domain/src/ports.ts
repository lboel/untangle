/**
 * Hexagonal ports (architecture.md §2.1, §7.1, §16.2, §19.1, §20, §21;
 * spec.md §22).
 *
 * Pure interfaces — no implementation lives in domain. Adapters implement
 * these for Qdrant, Ollama, git CLI, the Node file system, file locks etc.
 * Every long-running method accepts an optional `AbortSignal` via its
 * trailing options parameter (spec.md §22: public APIs MUST support abort
 * signals). Cancellation surfaces as `UntangleError` with code
 * `JOB_CANCELLED`.
 *
 * Method sets and request/result shapes beyond the port NAMES are fixed here
 * as Untangle decisions (the architecture names the ports without methods) —
 * see README "Entscheidungen". Later changes must be additive (BUILD_PLAN §3).
 */
import type { LanguageAdapter, RawImport } from "./analysis.js";
import type {
  ArtifactChunk,
  ArtifactDocument,
  ArtifactLink,
  ContextArtifactConfig,
} from "./types/artifact.js";
import type { SupportLevel } from "./types/common.js";
import type { EmbeddingProfile } from "./types/embedding.js";
import type { FileManifestV1 } from "./types/file.js";
import type { IndexCheckpointV1 } from "./types/job.js";
import type { RefRecord, WorkspaceRecord } from "./types/workspace.js";

/** Common trailing options of potentially long-running port methods. */
export interface PortCallOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// VectorStore (architecture.md §6.9, §11; spec.md §10)
// ---------------------------------------------------------------------------

/** Values allowed in payload filter conditions. */
export type PayloadScalar = string | number | boolean;

/** Field match condition. `in` matches any of the listed values. */
export type FieldCondition =
  | { field: string; match: { eq: PayloadScalar } }
  | { field: string; match: { in: PayloadScalar[] } }
  | { field: string; range: { gt?: number; gte?: number; lt?: number; lte?: number } };

/** Boolean payload filter (subset of Qdrant filter semantics, adapter-mapped). */
export interface PayloadFilter {
  must?: FieldCondition[];
  should?: FieldCondition[];
  mustNot?: FieldCondition[];
}

/** Sparse vector in index/value form (BM25 term weights, spec.md §10.2). */
export interface SparseVectorV1 {
  indices: number[];
  values: number[];
}

/** A point to upsert. Payload keys are snake_case per stored schema. */
export interface VectorPointV1 {
  id: string;
  dense?: number[];
  sparse?: SparseVectorV1;
  payload: Record<string, unknown>;
}

/** Collection provisioning spec (spec.md §10.2). */
export interface CollectionSpecV1 {
  name: string;
  denseDimensions: number;
  denseDistance: "Cosine" | "Dot" | "Euclid";
  /** Provision a "bm25" sparse vector with IDF modifier where supported. */
  sparseBm25: boolean;
  onDiskPayload: boolean;
}

/** Payload index to provision (spec.md §10.4). */
export interface PayloadIndexSpecV1 {
  field: string;
  type: "keyword" | "integer" | "float" | "bool";
}

/** Hybrid query request (spec.md §13.2 steps 5–7). */
export interface HybridQueryV1 {
  dense?: number[];
  sparse?: SparseVectorV1;
  filter?: PayloadFilter;
  /** Final result limit after fusion. */
  limit: number;
  /** Per-branch prefetch candidate limit. */
  candidateLimit?: number;
  /** Fusion method; only RRF in v1 and only within one collection (spec.md §13.4). */
  fusion?: "rrf";
  withPayload: boolean;
}

/** A scored query hit. */
export interface ScoredPointV1 {
  id: string;
  /** Fused (RRF) or single-branch score, comparable only within one collection. */
  score: number;
  denseScore?: number;
  sparseRank?: number;
  payload?: Record<string, unknown>;
}

/** One page of a scroll read. */
export interface ScrollPageV1 {
  points: VectorPointV1[];
  /** Opaque cursor; absent when exhausted. */
  nextOffset?: string;
}

export interface ScrollRequestV1 {
  filter?: PayloadFilter;
  limit: number;
  offset?: string;
  withVectors?: boolean;
}

/**
 * Vector store port (architecture.md §2.1).
 *
 * Contract highlights (tested by the testkit contract suite):
 * - upserts are idempotent (spec.md §10.5);
 * - adapters enforce point-count AND byte budgets, splitting or rejecting
 *   oversized points with `POINT_TOO_LARGE` — never dropping silently;
 * - read/status methods never create collections as a side effect
 *   (architecture.md §11.5).
 */
export interface VectorStore {
  /** Optional adapter identity for backend-specific failure diagnostics. */
  readonly backend?: "lancedb" | "qdrant";
  collectionExists(name: string, options?: PortCallOptions): Promise<boolean>;
  ensureCollection(spec: CollectionSpecV1, options?: PortCallOptions): Promise<void>;
  ensurePayloadIndexes(
    collection: string,
    indexes: PayloadIndexSpecV1[],
    options?: PortCallOptions,
  ): Promise<void>;
  upsert(
    collection: string,
    points: VectorPointV1[],
    options?: PortCallOptions,
  ): Promise<{ upsertedCount: number }>;
  deleteByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<void>;
  hybridQuery(
    collection: string,
    query: HybridQueryV1,
    options?: PortCallOptions,
  ): Promise<ScoredPointV1[]>;
  retrieve(
    collection: string,
    ids: string[],
    options?: PortCallOptions & { withVectors?: boolean },
  ): Promise<VectorPointV1[]>;
  scroll(
    collection: string,
    request: ScrollRequestV1,
    options?: PortCallOptions,
  ): Promise<ScrollPageV1>;
  countByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// MetadataStore (architecture.md §11.5)
// ---------------------------------------------------------------------------

/**
 * Metadata store port. Reads that only check status must not create the
 * backing collection as a side effect (architecture.md §11.5). "Not found"
 * is returned as `null`, never conflated with infrastructure errors
 * (spec.md §25.2).
 */
export interface MetadataStore {
  getWorkspace(workspaceId: string, options?: PortCallOptions): Promise<WorkspaceRecord | null>;
  putWorkspace(record: WorkspaceRecord, options?: PortCallOptions): Promise<void>;

  getRefRecord(refId: string, options?: PortCallOptions): Promise<RefRecord | null>;
  putRefRecord(record: RefRecord, options?: PortCallOptions): Promise<void>;
  listRefRecords(repoId: string, options?: PortCallOptions): Promise<RefRecord[]>;

  getFileManifest(fileId: string, options?: PortCallOptions): Promise<FileManifestV1 | null>;
  listFileManifests(refId: string, options?: PortCallOptions): Promise<FileManifestV1[]>;
  putFileManifests(manifests: FileManifestV1[], options?: PortCallOptions): Promise<void>;
  deleteFileManifests(fileIds: string[], options?: PortCallOptions): Promise<void>;

  getEmbeddingProfile(
    profileId: string,
    options?: PortCallOptions,
  ): Promise<EmbeddingProfile | null>;
  putEmbeddingProfile(
    profileId: string,
    profile: EmbeddingProfile,
    options?: PortCallOptions,
  ): Promise<void>;

  getCheckpoint(jobId: string, options?: PortCallOptions): Promise<IndexCheckpointV1 | null>;
  putCheckpoint(checkpoint: IndexCheckpointV1, options?: PortCallOptions): Promise<void>;
  getLatestCheckpoint(
    repoId: string,
    refId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null>;

  /**
   * Generic versioned record access for record kinds introduced after v1
   * (additive evolution, BUILD_PLAN §3). `kind` is a stable snake_case name.
   */
  getRecord(
    kind: string,
    id: string,
    options?: PortCallOptions,
  ): Promise<Record<string, unknown> | null>;
  putRecord(
    kind: string,
    id: string,
    record: Record<string, unknown>,
    options?: PortCallOptions,
  ): Promise<void>;
  listRecords(
    kind: string,
    filter?: Record<string, string>,
    options?: PortCallOptions,
  ): Promise<Record<string, unknown>[]>;
  deleteRecord(kind: string, id: string, options?: PortCallOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// GraphStore (architecture.md §6.11, §11.6, §11.7)
// ---------------------------------------------------------------------------

/** Logical graph collection (architecture.md §11.6). */
export type GraphCollection = "graph_files" | "graph_indices" | "graph_meta";

/**
 * One logical graph shard. Adapters split large shards into multipart points
 * (`part_index`/`part_count`/`write_id`/checksum) transparently; readers only
 * ever see a complete, checksum-verified shard or an error — never a partial
 * one (architecture.md §11.7).
 */
export interface GraphShardV1 {
  logicalShardId: string;
  collection: GraphCollection;
  generationId: string;
  /** Write transaction id; all parts of one write share it. */
  writeId: string;
  payload: Record<string, unknown>;
}

export interface GraphStore {
  writeShards(shards: GraphShardV1[], options?: PortCallOptions): Promise<void>;
  /**
   * Returns the shard, or null when absent. Throws `GRAPH_INCOMPLETE` when a
   * multipart shard is inconsistent — inconsistency is an error, not empty
   * data (architecture.md §22.2).
   */
  readShard(
    collection: GraphCollection,
    logicalShardId: string,
    options?: PortCallOptions & { generationId?: string },
  ): Promise<GraphShardV1 | null>;
  listShardIds(
    collection: GraphCollection,
    options?: PortCallOptions & { generationId?: string },
  ): Promise<string[]>;
  deleteShards(
    collection: GraphCollection,
    logicalShardIds: string[],
    options?: PortCallOptions,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// EmbeddingProvider (architecture.md §6.8; spec.md §9)
// ---------------------------------------------------------------------------

/** Result of the readiness sequence (spec.md §9.1). */
export interface EmbeddingReadinessV1 {
  /** Effective endpoint with secrets redacted. */
  endpoint: string;
  model: string;
  dimensions: number;
  /** ISO-8601 probe timestamp (via Clock). */
  probedAt: string;
}

/** Result of one document batch embed. */
export interface EmbeddingBatchResultV1 {
  /** One vector per input text, in input order. */
  vectors: number[][];
  /** True where provider-side truncation actually occurred (spec.md §9.3). */
  truncated: boolean[];
}

export interface EmbeddingProvider {
  /** The effective, validated profile this provider embeds with. */
  readonly profile: EmbeddingProfile;
  /** `buildEmbeddingProfileId(profile)`. */
  readonly profileId: string;
  /** Runs the readiness sequence of spec.md §9.1; idempotent. */
  ensureReady(options?: PortCallOptions): Promise<EmbeddingReadinessV1>;
  /** Embeds prepared DOCUMENT texts (documentPrefix already applied by caller). */
  embedDocuments(
    preparedTexts: string[],
    options?: PortCallOptions,
  ): Promise<EmbeddingBatchResultV1>;
  /** Embeds one prepared QUERY text. */
  embedQuery(preparedText: string, options?: PortCallOptions): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// ParserRegistry (architecture.md §6.5)
// ---------------------------------------------------------------------------

export interface ParserRegistry {
  listAdapters(): LanguageAdapter[];
  /** Null when the language is not registered — callers map to PARSER_UNAVAILABLE. */
  getAdapterByLanguage(languageId: string): LanguageAdapter | null;
  /**
   * Resolves by extension, then optionally by content probe for
   * extensionless files (spec.md §6.1).
   */
  getAdapterForPath(path: string, contentSample?: string): LanguageAdapter | null;
  supportLevelOf(languageId: string): SupportLevel | null;
}

// ---------------------------------------------------------------------------
// FileSystemPort (architecture.md §2.1, §23.1)
// ---------------------------------------------------------------------------

export interface FileStatV1 {
  path: string;
  sizeBytes: number;
  mtimeEpochMs: number;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface DirEntryV1 {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface FileWriteOptions extends PortCallOptions {
  /** POSIX creation mode; adapters without mode support may ignore it. */
  mode?: number;
}

/**
 * File system port. Adapters are responsible for the symlink-aware part of
 * the path sandbox (canonical resolution via `realPath`, then re-check with
 * `assertWithinWorkspace`, architecture.md §23.1).
 */
export interface FileSystemPort {
  /** Null when the path does not exist. */
  stat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null>;
  /** Stat without following a final symlink. */
  lstat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null>;
  readFile(path: string, options?: PortCallOptions): Promise<Uint8Array>;
  readTextFile(path: string, options?: PortCallOptions): Promise<string>;
  readDir(path: string, options?: PortCallOptions): Promise<DirEntryV1[]>;
  /** Canonical path with all symlinks resolved. */
  realPath(path: string, options?: PortCallOptions): Promise<string>;
  writeFile(path: string, data: Uint8Array, options?: FileWriteOptions): Promise<void>;
  mkdir(path: string, options?: PortCallOptions & { recursive?: boolean }): Promise<void>;
  /** Atomic rename — basis of the temp+rename checkpoint pattern. */
  rename(from: string, to: string, options?: PortCallOptions): Promise<void>;
  remove(path: string, options?: PortCallOptions & { recursive?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// GitPort / RevisionProvider (architecture.md §2.1, §19.1)
// ---------------------------------------------------------------------------

/** A revision descriptor for change analysis (spec.md §17.1). */
export type Revision =
  | { kind: "commit"; sha: string }
  | { kind: "ref"; name: string }
  | { kind: "index" }
  | { kind: "working_tree" }
  | { kind: "generation"; generationId: string };

/** One changed file between two revisions. */
export interface FileChangeV1 {
  changeKind: "added" | "modified" | "deleted" | "renamed";
  /** Absent for "added". */
  oldPath?: string;
  /** Absent for "deleted". */
  newPath?: string;
  /** Rename similarity in [0, 1] when the provider reports one. */
  similarity?: number;
}

/** Low-level git access port (architecture.md §2.1 "GitProvider"). */
export interface GitPort {
  isRepository(repoPath: string, options?: PortCallOptions): Promise<boolean>;
  /** Null when the revision cannot be resolved. */
  resolveCommit(
    repoPath: string,
    revision: Revision,
    options?: PortCallOptions,
  ): Promise<string | null>;
  currentBranch(repoPath: string, options?: PortCallOptions): Promise<string | null>;
  listChangedFiles(
    repoPath: string,
    base: Revision,
    head: Revision,
    options?: PortCallOptions,
  ): Promise<FileChangeV1[]>;
  /** Null when the file does not exist at that revision. */
  readFileAtRevision(
    repoPath: string,
    revision: Revision,
    relativePath: string,
    options?: PortCallOptions,
  ): Promise<Uint8Array | null>;
  listTrackedFiles(
    repoPath: string,
    revision: Revision,
    options?: PortCallOptions,
  ): Promise<string[]>;
  remoteUrls(repoPath: string, options?: PortCallOptions): Promise<string[]>;
}

/**
 * Revision provider for the change engine (architecture.md §19.1) — bound to
 * one repository. Implementations: git CLI, filesystem+git base, stored
 * index generations.
 */
export interface RevisionProvider {
  listChangedFiles(
    base: Revision,
    head: Revision,
    options?: PortCallOptions,
  ): Promise<FileChangeV1[]>;
  /** Null when the file does not exist at that revision. */
  readFile(
    revision: Revision,
    relativePath: string,
    options?: PortCallOptions,
  ): Promise<Uint8Array | null>;
  resolveCommit(revision: Revision, options?: PortCallOptions): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// LockProvider (architecture.md §21.1–§21.2)
// ---------------------------------------------------------------------------

/** Persisted lock record (architecture.md §21.2). */
export interface LockRecordV1 {
  /** Lock key, e.g. "repo:<repo_id>:<ref_id>:index" (architecture.md §21.1). */
  key: string;
  pid: number;
  /**
   * Random per-process instance id — stale detection must not rely on PID
   * existence alone (PID reuse, architecture.md §21.2).
   */
  processInstanceId: string;
  host: string;
  /** ISO-8601 (via Clock). */
  acquiredAt: string;
  leaseExpiresAt: string;
}

export interface LockHandle {
  readonly key: string;
  readonly record: LockRecordV1;
  /** Extends the lease. */
  renew(options?: PortCallOptions): Promise<void>;
  release(): Promise<void>;
}

export interface LockProvider {
  /**
   * Acquires the lock or throws `UntangleError` with code `LOCK_HELD` after
   * `waitMs` (default 0: fail fast).
   */
  acquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number; waitMs?: number },
  ): Promise<LockHandle>;
  /** Null instead of throwing when the lock is held. */
  tryAcquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number },
  ): Promise<LockHandle | null>;
  /** Current holder record, or null when free. */
  inspect(key: string, options?: PortCallOptions): Promise<LockRecordV1 | null>;
}

// ---------------------------------------------------------------------------
// Clock / Random (determinism, BUILD_PLAN global rules)
// ---------------------------------------------------------------------------

/** Time source port — the only legal source of "now" in domain/analysis logic. */
export interface Clock {
  nowEpochMs(): number;
  /** ISO-8601 UTC timestamp of now. */
  nowIso(): string;
}

/** Randomness port — the only legal source of randomness in domain/analysis logic. */
export interface Random {
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  bytes(length: number): Uint8Array;
  /** Random UUIDv4 (write ids, process instance ids). */
  uuid(): string;
}

// ---------------------------------------------------------------------------
// LoggerPort (architecture.md §24.2)
// ---------------------------------------------------------------------------

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** Structured log event (architecture.md §24.2) — exact shape. */
export interface LogEvent {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  requestId?: string;
  jobId?: string;
  context?: Record<string, unknown>;
}

export interface LoggerPort {
  log(event: LogEvent): void;
  /** Returns a logger that merges `bindings` into every event. */
  child(bindings: {
    component?: string;
    requestId?: string;
    jobId?: string;
    context?: Record<string, unknown>;
  }): LoggerPort;
}

// ---------------------------------------------------------------------------
// CheckpointStorePort (architecture.md §6.14, §13.3)
// ---------------------------------------------------------------------------

export interface CheckpointStorePort {
  /** Persists atomically (temp + rename or equivalent). */
  save(checkpoint: IndexCheckpointV1, options?: PortCallOptions): Promise<void>;
  load(jobId: string, options?: PortCallOptions): Promise<IndexCheckpointV1 | null>;
  loadLatest(
    repoId: string,
    refId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null>;
  delete(jobId: string, options?: PortCallOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// ImportResolver (architecture.md §16.2)
// ---------------------------------------------------------------------------

/** Context available to import resolvers. */
export interface ResolveContext {
  workspaceId: string;
  repoId: string;
  refId: string;
  /** "/"-normalized repo-relative path of the importing file. */
  importerPath: string;
  importerLanguageId: string;
  /** Configured aliases (spec.md §4.3 packageAliases). */
  packageAliases?: Record<string, string>;
  /** Cross-repo package catalog: package name → owning repo/module (architecture.md §16.3). */
  workspacePackages?: Record<string, { repoId: string; moduleRoot: string }>;
}

/**
 * Resolution result. `unresolved` is a visible state, never a guessed edge
 * (spec.md §14.3, BUILD_PLAN R5).
 */
export type ResolveResultV1 =
  | {
      status: "resolved";
      targetRepoId: string;
      /** "/"-normalized repo-relative path of the resolved file. */
      targetPath: string;
      crossRepo: boolean;
    }
  | { status: "external"; packageName: string }
  | { status: "unresolved"; reason: string };

export interface ImportResolver {
  supports(context: ResolveContext): boolean;
  resolve(
    raw: RawImport,
    context: ResolveContext,
    options?: PortCallOptions,
  ): Promise<ResolveResultV1>;
}

// ---------------------------------------------------------------------------
// ArtifactAdapter (architecture.md §20)
// ---------------------------------------------------------------------------

/** Input to an artifact adapter: the configured artifact plus its loaded files. */
export interface ArtifactInput {
  config: ContextArtifactConfig;
  files: {
    /** "/"-normalized path relative to the workspace root. */
    path: string;
    content: string;
    contentHash: string;
  }[];
}

/**
 * Context artifact adapter (architecture.md §20) — exact shape.
 * Unknown formats fall back to a safe text adapter; unsafe links are marked
 * heuristic.
 */
export interface ArtifactAdapter {
  supports(type: string, path: string): boolean;
  read(input: ArtifactInput, options?: PortCallOptions): Promise<ArtifactDocument[]>;
  chunk(document: ArtifactDocument): ArtifactChunk[];
  links?(document: ArtifactDocument): ArtifactLink[];
}
