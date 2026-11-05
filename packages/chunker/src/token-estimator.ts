/**
 * Conservative, offline token estimator (architecture.md §14.4).
 *
 * There is no network tokenizer call here on purpose (spec.md §24 privacy,
 * and the chunker must run fully offline). The estimate is deliberately
 * biased to OVER-estimate real BPE-style tokenizer counts rather than
 * under-estimate: real code tokenizers average roughly 3.3-4.5 characters
 * per token (identifiers and keywords tokenize efficiently; whitespace and
 * punctuation less so). Dividing by a lower `charsPerToken` than that
 * average guarantees the estimate is usually >= the true count, so a chunk
 * that "fits the budget" here also fits the embedding model's real budget —
 * the failure mode of under-estimating (silently truncated embeddings) is
 * far worse than over-fragmenting slightly.
 */

export interface TokenEstimatorConfig {
  /** Conservative average characters per token; lower over-estimates. */
  charsPerToken: number;
  /** Per-line overhead (in tokens) added for newline/indentation noise. */
  perLineOverheadTokens: number;
}

/** Untangle decision: 3 chars/token (vs. the ~4 real average) plus a small per-line overhead. */
export const DEFAULT_TOKEN_ESTIMATOR_CONFIG: TokenEstimatorConfig = {
  charsPerToken: 3,
  perLineOverheadTokens: 0.25,
};

/**
 * Estimates the token count of `text`. Pure function of its inputs; never
 * touches the network or a real tokenizer vocabulary.
 */
export function estimateTokens(
  text: string,
  config: TokenEstimatorConfig = DEFAULT_TOKEN_ESTIMATOR_CONFIG,
): number {
  if (text.length === 0) {
    return 0;
  }
  let lineCount = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lineCount += 1;
    }
  }
  const raw = text.length / config.charsPerToken + lineCount * config.perLineOverheadTokens;
  return Math.max(1, Math.ceil(raw));
}
