/**
 * Default chunker configuration and resolution of caller overrides.
 */
import { CHUNKER_VERSION, PARSER_VERSION } from "@untangle-code/domain";

import { DEFAULT_MINIFIED_DETECTION_CONFIG } from "./minified-detection.js";
import { DEFAULT_TOKEN_ESTIMATOR_CONFIG } from "./token-estimator.js";
import type { ChunkerConfig, ChunkerConfigInput } from "./types.js";

/**
 * Untangle decision (README "Entscheidungen"): 800 tokens is the default
 * per-chunk budget — generous enough for a typical method or a small class
 * overview, small enough that four to six chunks fit a model's context
 * alongside a query and other results.
 */
export const DEFAULT_MAX_TOKENS_PER_CHUNK = 800;

export const DEFAULT_LINE_FALLBACK_CONFIG = { linesPerChunk: 60, overlapLines: 8 };
export const DEFAULT_MINIFIED_STRATEGY_CONFIG = { overlapBytes: 0 };

export function resolveChunkerConfig(input: ChunkerConfigInput): ChunkerConfig {
  return {
    chunkerVersion: input.chunkerVersion ?? CHUNKER_VERSION,
    parserVersion: input.parserVersion ?? PARSER_VERSION,
    maxTokensPerChunk: input.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK,
    tokenEstimator: input.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR_CONFIG,
    preparedText: input.preparedText,
    minifiedDetection: input.minifiedDetection ?? DEFAULT_MINIFIED_DETECTION_CONFIG,
    lineFallback: input.lineFallback ?? DEFAULT_LINE_FALLBACK_CONFIG,
    minifiedStrategy: input.minifiedStrategy ?? DEFAULT_MINIFIED_STRATEGY_CONFIG,
  };
}
