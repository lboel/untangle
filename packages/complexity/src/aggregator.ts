/**
 * Aggregator (spec.md §16.10). Aggregates one metric's values across many
 * scopes (a file's symbols, a repo's files, ...).
 *
 * Percentile method (Untangle decision, documented per the work order):
 * linear interpolation between closest ranks, i.e. for a sorted array `s` of
 * length `n` and percentile `p` in [0, 1], `index = p * (n - 1)`,
 * `result = s[floor(index)] + (s[ceil(index)] - s[floor(index)]) * frac(index)`.
 * This is the same convention as NumPy's default `linear` interpolation and
 * Excel's `PERCENTILE.INC`. `median` uses the same formula at `p = 0.5`, so
 * it agrees with `p90`/`p95` on the same interpolation rule rather than using
 * a different odd/even-length special case.
 *
 * Deduplication: entries are deduplicated by `metricsScopeId` (first
 * occurrence wins) before any statistic is computed, per spec.md §16.10
 * ("Doppelte Retrieval-Fragmente MÜSSEN über metrics_scope_id dedupliziert
 * werden").
 */
import type { AggregationEntry, AggregationResult } from "./types.js";

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const index = p * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  if (lower === upper) return lowerValue;
  const fraction = index - lower;
  return lowerValue + (upperValue - lowerValue) * fraction;
}

function dedupeByScopeId(entries: readonly AggregationEntry[]): {
  deduped: AggregationEntry[];
  duplicatesDropped: number;
} {
  const seen = new Set<string>();
  const deduped: AggregationEntry[] = [];
  let duplicatesDropped = 0;
  for (const entry of entries) {
    if (seen.has(entry.metricsScopeId)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(entry.metricsScopeId);
    deduped.push(entry);
  }
  return { deduped, duplicatesDropped };
}

/**
 * @param entries Raw values, one per scope. Duplicate `metricsScopeId`s are
 *   dropped (first occurrence wins) before aggregating.
 * @param thresholds Threshold values; `thresholdCounts` counts entries whose
 *   (deduplicated) value is strictly greater than each threshold, keyed by
 *   the threshold's own decimal string (e.g. `"10"`, `"15.5"`).
 */
export function aggregate(
  entries: readonly AggregationEntry[],
  thresholds: readonly number[] = [],
): AggregationResult {
  const { deduped, duplicatesDropped } = dedupeByScopeId(entries);
  const values = deduped.map((e) => e.value);
  const sorted = [...values].sort((a, b) => a - b);

  const count = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = count > 0 ? sum / count : 0;
  const median = percentile(sorted, 0.5);
  const max = count > 0 ? (sorted[count - 1] as number) : 0;
  const p90 = percentile(sorted, 0.9);
  const p95 = percentile(sorted, 0.95);

  const weighted = deduped.filter((e) => e.sloc !== undefined);
  let slocWeightedMean: number | undefined;
  if (weighted.length > 0) {
    const totalSloc = weighted.reduce((s, e) => s + (e.sloc as number), 0);
    slocWeightedMean =
      totalSloc > 0
        ? weighted.reduce((s, e) => s + e.value * (e.sloc as number), 0) / totalSloc
        : 0;
  }

  const thresholdCounts: Record<string, number> = {};
  for (const threshold of thresholds) {
    thresholdCounts[String(threshold)] = values.filter((v) => v > threshold).length;
  }

  const result: AggregationResult = {
    count,
    sum,
    mean,
    median,
    max,
    p90,
    p95,
    thresholdCounts,
    duplicatesDropped,
  };
  if (slocWeightedMean !== undefined) {
    result.slocWeightedMean = slocWeightedMean;
  }
  return result;
}
