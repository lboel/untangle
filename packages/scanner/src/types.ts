/**
 * Scanner-local contracts (spec.md §6.1–§6.3, §12.1; architecture.md §6.4).
 *
 * `ScannedFileV1` is a WP-05-local type, not an import from
 * `@untangle-code/domain` — see README, "Entscheidungen" (Entscheidung 1)
 * for the full reasoning. In short: docs/BUILD_PLAN.md §3's Contract-Register
 * (the authoritative, exhaustive list of what MUST live in domain) requires
 * `FileManifestV1` for a file's tracked analysis state but does not register
 * a raw pre-analysis scan output shape at all; the name deliberately avoids
 * "FileSnapshot" (architecture.md §6.1's informal domain-entity name for
 * this concept) so it cannot be mistaken for that domain contract by name
 * alone. Downstream packages (parser-registry, chunker) consume it
 * positionally, not by importing domain types for it.
 */
import type { FileSystemPort, PortCallOptions } from "@untangle-code/domain";

/** Coarse text-encoding guess from a byte sample (BOM + byte-range heuristics). */
export type TextEncodingGuess = "utf8" | "utf16le" | "utf16be" | "ascii" | "unknown";

/** How a file's language id was determined. */
export type LanguageDetectionSource = "extension" | "content" | "unknown";

/** Why a discovered path was excluded from the yielded candidate stream. */
export type ExclusionReason =
  | "security"
  | "config-exclude"
  | "untangleignore"
  | "gitignore"
  | "default-exclude"
  | "binary"
  | "size-limit"
  | "symlink-cycle"
  | "symlink-escape"
  | "unreadable";

/**
 * One file discovered and accepted for downstream analysis (spec.md §12.1
 * comparison fields: path, size, mtime as hint, hash as source of truth).
 */
export interface ScannedFileV1 {
  /** "/"-normalized path relative to the scanned repository root. */
  relativePath: string;
  /** Absolute path to read content from (post symlink resolution). */
  absolutePath: string;
  sizeBytes: number;
  /** Fast change hint only — never authoritative (spec.md §12.1). */
  mtimeEpochMs: number;
  /** SHA-256 hex of the raw file content; sole "unchanged" authority. */
  contentHash: string;
  languageId: string;
  languageDetectedBy: LanguageDetectionSource;
  isMinified: boolean;
  encoding: TextEncodingGuess;
  hasBom: boolean;
}

/** One path the scanner decided not to yield, with its reason. */
export interface ScanSkipV1 {
  relativePath: string;
  reason: ExclusionReason;
  detail?: string;
}

/**
 * Pluggable content hasher (spec.md §12.1 hash pipeline).
 *
 * `FileSystemPort` (domain) exposes only whole-buffer reads, so the default,
 * port-based implementation cannot avoid materializing a file's bytes. A
 * Node-specific streaming implementation is provided from `./node-fs` for
 * callers that want to hash large files without buffering them fully — see
 * README, "Entscheidungen".
 */
export interface ContentHasher {
  hashFile(absolutePath: string, sizeBytes: number, options?: PortCallOptions): Promise<string>;
}

export interface IgnoreConfig {
  /** RepositoryConfig.include (spec.md §4.3) — overrides default excludes only. */
  configInclude?: readonly string[];
  /** RepositoryConfig.exclude (spec.md §4.3) — layer 2, spec.md §6.2. */
  configExclude?: readonly string[];
  /** File name searched for at every directory level. Default ".untangleignore". */
  untangleIgnoreFileName?: string;
  /** File name searched for at every directory level. Default ".gitignore". */
  gitIgnoreFileName?: string;
  /** Extra patterns appended to the overridable default-exclude layer. */
  additionalDefaultExcludes?: readonly string[];
}

export interface IgnoreDecision {
  ignored: boolean;
  reason?: ExclusionReason;
}

export interface BinaryClassification {
  isBinary: boolean;
  hasNullByte: boolean;
  nonPrintableRatio: number;
  encoding: TextEncodingGuess;
  hasBom: boolean;
}

export interface ScanOptions {
  fs: FileSystemPort;
  /** Workspace roots for `assertWithinWorkspace` (architecture.md §23.1). */
  roots: readonly string[];
  /** Absolute path to the repository directory to scan. */
  repoRoot: string;
  ignore?: IgnoreConfig;
  /** Reject before a full read via `stat` (spec.md §6.1). Default 5 MiB. */
  maxFileSizeBytes?: number;
  /** Bytes inspected for binary/minified/language-content classification. Default 8 KiB. */
  sampleBytes?: number;
  /** Bounded parallelism for the per-file processing stage. Default 8. */
  concurrency?: number;
  /** Non-printable-byte ratio above which a sample is classified binary. Default 0.3. */
  nonPrintableThreshold?: number;
  hasher?: ContentHasher;
  onSkip?: (skip: ScanSkipV1) => void;
  signal?: AbortSignal;
}
