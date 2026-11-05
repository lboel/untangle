/**
 * File manifest (architecture.md §10.3; spec.md §12.1).
 */
import type { ParseQuality } from "./common.js";

/**
 * Per-file manifest of the last completed analysis. The content hash is the
 * single source of truth for "unchanged" decisions (spec.md §12.1).
 */
export interface FileManifestV1 {
  fileId: string;
  repoId: string;
  refId: string;
  /** "/"-normalized path relative to the repository root. */
  relativePath: string;
  /** SHA-256 of the file content; sole authority for change detection. */
  contentHash: string;
  sizeBytes: number;
  language: string;
  parseQuality: ParseQuality;
  chunkIds: string[];
  symbolIds: string[];
  /** Dedupe scope id for metrics aggregation (spec.md §16.1). */
  metricsScopeId: string;
  parserVersion: string;
  chunkerVersion: string;
  generationId: string;
}
