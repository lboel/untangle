/**
 * Context artifact contracts (spec.md §19; architecture.md §20).
 */
import type { SourceRange } from "./common.js";

/** Context artifact type (spec.md §19.1). */
export type ContextArtifactType =
  | "auto"
  | "sql"
  | "openapi"
  | "asyncapi"
  | "protobuf"
  | "markdown"
  | "terraform"
  | "kubernetes"
  | "text";

/** Context artifact configuration (spec.md §19.1) — exact spec shape. */
export interface ContextArtifactConfig {
  /** Unique per project (spec.md §19.2). */
  name: string;
  /** File or directory path. */
  path: string;
  description: string;
  type?: ContextArtifactType;
  include?: string[];
  exclude?: string[];
}

/**
 * One readable document of an artifact (architecture.md §20; shapes of
 * document/chunk/link are Untangle decisions — the architecture names the
 * types without fields).
 */
export interface ArtifactDocument {
  /** Owning artifact name from {@link ContextArtifactConfig}. */
  artifactName: string;
  /** Effective type after `auto` detection. */
  type: Exclude<ContextArtifactType, "auto">;
  /** "/"-normalized path relative to the workspace root. */
  path: string;
  /** SHA-256 of `content`; staleness = config hash + content hash (spec.md §19.2). */
  contentHash: string;
  /** Full raw content — must be preserved (spec.md §19.2). */
  content: string;
  language?: string;
}

/** A semantic section of an artifact document (architecture.md §20). */
export interface ArtifactChunk {
  chunkId: string;
  artifactName: string;
  /** Semantic kind, e.g. "sql_table", "openapi_operation", "markdown_section", "text_window". */
  kind: string;
  /** Human-readable section title when the format provides one. */
  title?: string;
  /** Source range within the owning document — must be preserved (spec.md §19.2). */
  range: SourceRange;
  content: string;
  contentHash: string;
}

/**
 * A link from an artifact chunk to a code entity, e.g. an OpenAPI operation
 * to a controller symbol. Unsafe links are marked heuristic
 * (architecture.md §20).
 */
export interface ArtifactLink {
  fromChunkId: string;
  targetKind: "symbol" | "file" | "artifact_chunk";
  /** Resolved target id when known. */
  targetId?: string;
  /** Target name as written in the artifact, e.g. an operationId or table name. */
  targetName: string;
  heuristic: boolean;
  /** Confidence in [0, 1]. */
  confidence: number;
  note?: string;
}
