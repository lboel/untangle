/**
 * Metrics registry (spec.md §23.3): exactly the internal counters the core
 * engine SHOULD expose. No external exporter — `snapshot()` returns a plain
 * object, which callers may print, log, or serve however they like.
 *
 * spec.md §23.3 calls all eleven names "Zähler" (counters), but three of
 * them are not cumulative counts by nature:
 * - `search_latency_ms` is a distribution of per-search durations, not a
 *   single number — modeled as a histogram.
 * - `resolved_import_ratio`/`resolved_call_ratio` are point-in-time ratios
 *   (resolved / total at last computation), which a monotonic counter
 *   cannot represent without lying about "cumulative" — modeled as gauges
 *   the caller sets to the latest computed value.
 *
 * The other eight are genuinely cumulative and are modeled as counters.
 * This is a WP-04-local decision (README "Entscheidungen") — the set of
 * names is exactly spec.md §23.3's eleven, not open for extension by name.
 */

/** Cumulative counters (spec.md §23.3). */
export const COUNTER_NAMES = [
  "files_scanned",
  "files_changed",
  "chunks_created",
  "embeddings_requested",
  "embedding_cache_hits",
  "qdrant_upsert_bytes",
  "parse_failures",
  "watcher_reconciliations",
] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];

/** Latency distributions (spec.md §23.3). */
export const HISTOGRAM_NAMES = ["search_latency_ms"] as const;
export type HistogramName = (typeof HISTOGRAM_NAMES)[number];

/** Point-in-time ratios (spec.md §23.3). */
export const RATIO_NAMES = ["resolved_import_ratio", "resolved_call_ratio"] as const;
export type RatioName = (typeof RATIO_NAMES)[number];

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshotV1 {
  counters: Record<CounterName, number>;
  histograms: Record<HistogramName, HistogramSnapshot>;
  ratios: Record<RatioName, number | null>;
}

const EMPTY_HISTOGRAM: HistogramSnapshot = {
  count: 0,
  sum: 0,
  min: 0,
  max: 0,
  avg: 0,
  p50: 0,
  p95: 0,
  p99: 0,
};

/** Summarizes raw samples into a {@link HistogramSnapshot}. Pure, no state. */
export function summarizeHistogram(samples: readonly number[]): HistogramSnapshot {
  if (samples.length === 0) {
    return EMPTY_HISTOGRAM;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    sum,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

/** In-process registry for exactly the eleven counters of spec.md §23.3. */
export class MetricsRegistry {
  private readonly counters: Record<CounterName, number>;
  private readonly samples: Record<HistogramName, number[]>;
  private readonly ratios: Record<RatioName, number | null>;

  public constructor() {
    this.counters = fromNames(COUNTER_NAMES, () => 0);
    this.samples = fromNames(HISTOGRAM_NAMES, () => [] as number[]);
    this.ratios = fromNames(RATIO_NAMES, () => null);
  }

  /** Increments a counter by `delta` (default 1). `delta` must be finite and >= 0. */
  public incrementCounter(name: CounterName, delta = 1): void {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError(`counter delta must be a finite, non-negative number, got ${delta}`);
    }
    this.counters[name] += delta;
  }

  /** Records one observed latency (milliseconds) for a histogram. */
  public observeHistogram(name: HistogramName, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) {
      throw new RangeError(`histogram value must be a finite, non-negative number, got ${valueMs}`);
    }
    this.samples[name].push(valueMs);
  }

  /** Sets the latest value of a ratio gauge. `null` clears it back to "unknown". */
  public setRatio(name: RatioName, value: number | null): void {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new RangeError(`ratio must be null or within [0, 1], got ${value}`);
    }
    this.ratios[name] = value;
  }

  /** Point-in-time snapshot as a plain object — no external exporter. */
  public snapshot(): MetricsSnapshotV1 {
    return {
      counters: { ...this.counters },
      histograms: fromNames(HISTOGRAM_NAMES, (name) => summarizeHistogram(this.samples[name])),
      ratios: { ...this.ratios },
    };
  }

  /** Resets every counter, histogram and ratio back to its initial state. */
  public reset(): void {
    for (const name of COUNTER_NAMES) {
      this.counters[name] = 0;
    }
    for (const name of HISTOGRAM_NAMES) {
      this.samples[name] = [];
    }
    for (const name of RATIO_NAMES) {
      this.ratios[name] = null;
    }
  }
}

function fromNames<Name extends string, Value>(
  names: readonly Name[],
  init: (name: Name) => Value,
): Record<Name, Value> {
  return Object.fromEntries(names.map((name) => [name, init(name)])) as Record<Name, Value>;
}
