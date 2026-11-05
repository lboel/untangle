/**
 * Profiling collector for `--profile` (architecture.md §24.3): stage
 * timings via the injected `Clock`, file counts, cache hit rates, embedding
 * and Qdrant latency/bytes, a parser/language breakdown, and the process
 * memory high water mark.
 *
 * Stage timing uses `Clock` exclusively (BUILD_PLAN determinism rule).
 * The memory high water mark is the one place this module reads real
 * process state (`process.memoryUsage()`), because that is exactly what
 * architecture.md §24.3 asks for — it is not a timing or randomness
 * decision, just a resource-usage sample.
 */
import type { Clock } from "@untangle-code/domain";

import { type HistogramSnapshot, summarizeHistogram } from "./metrics.js";

export interface StageTimingV1 {
  stage: string;
  startedAtIso: string;
  endedAtIso: string;
  durationMs: number;
}

export interface CacheHitRateV1 {
  hits: number;
  misses: number;
  /** `hits / (hits + misses)`, or `null` when there were no accesses at all. */
  rate: number | null;
}

export interface ParserBreakdownEntryV1 {
  files: number;
  failures: number;
}

export interface ProfileReportV1 {
  stages: StageTimingV1[];
  fileCounts: Record<string, number>;
  cacheHitRates: Record<string, CacheHitRateV1>;
  embeddingLatencyMs: HistogramSnapshot;
  qdrantLatencyMs: HistogramSnapshot;
  qdrantBytes: number;
  parserBreakdown: Record<string, ParserBreakdownEntryV1>;
  memoryHighWaterMarkBytes: number;
}

export interface StageHandle {
  /** Ends the stage. Idempotent — a second call is a no-op. */
  end(): void;
}

interface CacheCounters {
  hits: number;
  misses: number;
}

/** Reads the process's current resident set size. Isolated for testability. */
export function sampleMemoryBytes(): number {
  return process.memoryUsage().rss;
}

/** Collects one `--profile` run's worth of measurements. */
export class ProfileCollector {
  private readonly clock: Clock;
  private readonly readMemoryBytes: () => number;
  private readonly stages: StageTimingV1[] = [];
  private readonly fileCounts: Record<string, number> = {};
  private readonly cacheCounters: Record<string, CacheCounters> = {};
  private readonly embeddingLatencies: number[] = [];
  private readonly qdrantLatencies: number[] = [];
  private readonly parserBreakdown: Record<string, ParserBreakdownEntryV1> = {};
  private qdrantBytesTotal = 0;
  private memoryHighWaterMarkBytes: number;

  public constructor(deps: { clock: Clock; readMemoryBytes?: () => number }) {
    this.clock = deps.clock;
    this.readMemoryBytes = deps.readMemoryBytes ?? sampleMemoryBytes;
    this.memoryHighWaterMarkBytes = this.readMemoryBytes();
  }

  /** Starts timing `stage`. Returns a handle whose `end()` records the duration. */
  public beginStage(stage: string): StageHandle {
    const startedAtIso = this.clock.nowIso();
    const startedAtMs = this.clock.nowEpochMs();
    this.sampleMemory();
    let ended = false;
    return {
      end: (): void => {
        if (ended) {
          return;
        }
        ended = true;
        const endedAtMs = this.clock.nowEpochMs();
        this.stages.push({
          stage,
          startedAtIso,
          endedAtIso: this.clock.nowIso(),
          durationMs: endedAtMs - startedAtMs,
        });
        this.sampleMemory();
      },
    };
  }

  public recordFileCount(category: string, delta = 1): void {
    this.fileCounts[category] = (this.fileCounts[category] ?? 0) + delta;
  }

  public recordCacheAccess(name: string, hit: boolean): void {
    const counters = this.cacheCounters[name] ?? { hits: 0, misses: 0 };
    if (hit) {
      counters.hits += 1;
    } else {
      counters.misses += 1;
    }
    this.cacheCounters[name] = counters;
  }

  public recordEmbeddingLatency(ms: number): void {
    this.embeddingLatencies.push(ms);
    this.sampleMemory();
  }

  public recordQdrantLatency(ms: number): void {
    this.qdrantLatencies.push(ms);
    this.sampleMemory();
  }

  public addQdrantBytes(bytes: number): void {
    this.qdrantBytesTotal += bytes;
  }

  public recordParserOutcome(language: string, outcome: "success" | "failure"): void {
    const entry = this.parserBreakdown[language] ?? { files: 0, failures: 0 };
    entry.files += 1;
    if (outcome === "failure") {
      entry.failures += 1;
    }
    this.parserBreakdown[language] = entry;
  }

  /** Re-samples the memory high water mark on demand (also sampled automatically around stages/latencies). */
  public sampleMemory(): void {
    const current = this.readMemoryBytes();
    if (current > this.memoryHighWaterMarkBytes) {
      this.memoryHighWaterMarkBytes = current;
    }
  }

  public snapshot(): ProfileReportV1 {
    const cacheHitRates: Record<string, CacheHitRateV1> = {};
    for (const [name, counters] of Object.entries(this.cacheCounters)) {
      const total = counters.hits + counters.misses;
      cacheHitRates[name] = {
        hits: counters.hits,
        misses: counters.misses,
        rate: total === 0 ? null : counters.hits / total,
      };
    }
    return {
      stages: [...this.stages],
      fileCounts: { ...this.fileCounts },
      cacheHitRates,
      embeddingLatencyMs: summarizeHistogram(this.embeddingLatencies),
      qdrantLatencyMs: summarizeHistogram(this.qdrantLatencies),
      qdrantBytes: this.qdrantBytesTotal,
      parserBreakdown: { ...this.parserBreakdown },
      memoryHighWaterMarkBytes: this.memoryHighWaterMarkBytes,
    };
  }
}
