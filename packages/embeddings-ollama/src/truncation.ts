/**
 * Truncation guard (spec.md §9.3).
 *
 * Ollama's `/api/embed` truncates silently to the model's context window by
 * default (`truncate: true`) and does not report, per input, whether
 * truncation actually happened. The chunker (a separate package) is already
 * responsible for keeping prepared text within budget in the normal case;
 * this guard exists purely to catch the exceptional case where it did not
 * and flag the resulting point honestly rather than silently accepting a
 * vector computed from a truncated text (vision.md 8.4 "no silent data
 * loss").
 *
 * Detection is a conservative, offline token estimate compared against the
 * configured `contextLength` — the same trade-off `@untangle-code/chunker`
 * makes for its own budget checks (over-estimating real BPE token counts is
 * far safer than under-estimating, which would hide a real truncation).
 * The estimator is intentionally duplicated rather than imported: chunker
 * uses it to fit a budget ahead of time, this module uses it to flag a
 * budget miss after the fact, and importing chunker here would add a
 * runtime dependency between packages that otherwise have no reason to
 * know about each other (rule 3 spirit).
 */

/** Conservative average characters per token — deliberately lower than the ~4 real average. */
const CHARS_PER_TOKEN = 3;

/** Estimates a conservative (over-)approximation of `text`'s token count. */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * True when `text`'s estimated token count exceeds `contextLength` — the
 * point at which Ollama's provider-side truncation actually applies.
 */
export function wouldProviderTruncate(text: string, contextLength: number): boolean {
  return estimateTokenCount(text) > contextLength;
}
