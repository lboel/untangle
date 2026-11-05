import type { Clock } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { ProfileCollector } from "./profiling.js";

class SteppingClock implements Clock {
  private epochMs: number;
  public constructor(
    startEpochMs: number,
    private readonly stepMs: number,
  ) {
    this.epochMs = startEpochMs;
  }
  public nowEpochMs(): number {
    const value = this.epochMs;
    this.epochMs += this.stepMs;
    return value;
  }
  public nowIso(): string {
    return new Date(this.epochMs).toISOString();
  }
}

describe("ProfileCollector", () => {
  it("times a stage using only the injected Clock", () => {
    const clock = new SteppingClock(1000, 250);
    const collector = new ProfileCollector({ clock, readMemoryBytes: () => 0 });

    const handle = collector.beginStage("parse");
    handle.end();

    const report = collector.snapshot();
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0]?.stage).toBe("parse");
    expect(report.stages[0]?.durationMs).toBe(250);
  });

  it("end() is idempotent — a second call does not add a duplicate stage entry", () => {
    const clock = new SteppingClock(0, 10);
    const collector = new ProfileCollector({ clock, readMemoryBytes: () => 0 });

    const handle = collector.beginStage("scan");
    handle.end();
    handle.end();

    expect(collector.snapshot().stages).toHaveLength(1);
  });

  it("tracks file counts by category", () => {
    const collector = new ProfileCollector({
      clock: new SteppingClock(0, 1),
      readMemoryBytes: () => 0,
    });
    collector.recordFileCount("scanned");
    collector.recordFileCount("scanned");
    collector.recordFileCount("changed", 3);

    const report = collector.snapshot();
    expect(report.fileCounts["scanned"]).toBe(2);
    expect(report.fileCounts["changed"]).toBe(3);
  });

  it("computes cache hit rates per named cache, null when unused", () => {
    const collector = new ProfileCollector({
      clock: new SteppingClock(0, 1),
      readMemoryBytes: () => 0,
    });
    collector.recordCacheAccess("embedding", true);
    collector.recordCacheAccess("embedding", true);
    collector.recordCacheAccess("embedding", false);

    const report = collector.snapshot();
    expect(report.cacheHitRates["embedding"]).toEqual({ hits: 2, misses: 1, rate: 2 / 3 });
    expect(report.cacheHitRates["unused"]).toBeUndefined();
  });

  it("summarizes embedding and Qdrant latency, and accumulates Qdrant bytes", () => {
    const collector = new ProfileCollector({
      clock: new SteppingClock(0, 1),
      readMemoryBytes: () => 0,
    });
    collector.recordEmbeddingLatency(5);
    collector.recordEmbeddingLatency(15);
    collector.recordQdrantLatency(100);
    collector.addQdrantBytes(1024);
    collector.addQdrantBytes(512);

    const report = collector.snapshot();
    expect(report.embeddingLatencyMs.count).toBe(2);
    expect(report.embeddingLatencyMs.sum).toBe(20);
    expect(report.qdrantLatencyMs.count).toBe(1);
    expect(report.qdrantBytes).toBe(1536);
  });

  it("breaks parser outcomes down per language", () => {
    const collector = new ProfileCollector({
      clock: new SteppingClock(0, 1),
      readMemoryBytes: () => 0,
    });
    collector.recordParserOutcome("typescript", "success");
    collector.recordParserOutcome("typescript", "failure");
    collector.recordParserOutcome("python", "success");

    const report = collector.snapshot();
    expect(report.parserBreakdown["typescript"]).toEqual({ files: 2, failures: 1 });
    expect(report.parserBreakdown["python"]).toEqual({ files: 1, failures: 0 });
  });

  it("tracks the memory high water mark, never decreasing it", () => {
    const samples = [100, 500, 200, 900, 300];
    let index = 0;
    const collector = new ProfileCollector({
      clock: new SteppingClock(0, 1),
      readMemoryBytes: () => samples[index++] ?? samples[samples.length - 1]!,
    });

    collector.beginStage("a").end();
    collector.recordEmbeddingLatency(1);
    collector.beginStage("b").end();

    expect(collector.snapshot().memoryHighWaterMarkBytes).toBe(900);
  });
});
