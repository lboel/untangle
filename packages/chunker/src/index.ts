/**
 * @untangle-code/chunker — lossless, token-budgeted AST chunking
 * (spec.md §8, architecture.md §6.6 and §14).
 *
 * The only public export of this package. Consumers pass in what a
 * `LanguageAdapter` (from `@untangle-code/domain`, implemented by
 * `parser-registry`) already produced — `ParseResult`, `AstRegion[]`,
 * `ExtractedSymbol[]` — plus file identity and raw content, and get back
 * `CodeChunkDraft[]` ready for embedding and storage.
 */

// Main entry point (spec.md §8.3)
export { chunkFile } from "./chunker.js";

// Configuration
export {
  DEFAULT_LINE_FALLBACK_CONFIG,
  DEFAULT_MAX_TOKENS_PER_CHUNK,
  DEFAULT_MINIFIED_STRATEGY_CONFIG,
  resolveChunkerConfig,
} from "./config.js";
// E4-Abstufungsledger (WP-165): warum die AST-Strategie nicht lief.
export { CHUNK_DEGRADATION_REASONS } from "./types.js";
export type {
  ChunkDegradation,
  ChunkDegradationReason,
  ChunkerConfig,
  ChunkerConfigInput,
  ChunkFileIdentity,
  ChunkFileParams,
  ChunkFileResult,
  LineFallbackConfig,
  MinifiedStrategyConfig,
} from "./types.js";

// Token estimation (architecture.md §14.4) — exposed so callers can budget
// consistently, e.g. when deciding how many chunks fit a query context.
export { DEFAULT_TOKEN_ESTIMATOR_CONFIG, estimateTokens } from "./token-estimator.js";
export type { TokenEstimatorConfig } from "./token-estimator.js";

// Minified-content detection (spec.md §8.3 step 10) — exposed so a scanner
// can pre-classify files without re-implementing the heuristic.
export { DEFAULT_MINIFIED_DETECTION_CONFIG, detectMinifiedContent } from "./minified-detection.js";
export type { MinifiedDetectionConfig } from "./minified-detection.js";

// Prepared text builder (spec.md §8.6)
export {
  buildBm25Text,
  buildBm25TextForDraft,
  buildPreparedDenseText,
  buildPreparedDenseTextForDraft,
} from "./prepared-text.js";
export type { Bm25TextMeta, PreparedTextContext, PreparedTextMeta } from "./prepared-text.js";

// Coverage ledger helpers (architecture.md §14.1; spec.md §8.4) — the
// validator itself is `validateCoverage` from `@untangle-code/domain`.
export {
  assertLosslessCoverage,
  assertTruthfulLedger,
  chunkedEntry,
  excludedEntry,
} from "./coverage.js";
export type { LedgerChunkView } from "./coverage.js";
