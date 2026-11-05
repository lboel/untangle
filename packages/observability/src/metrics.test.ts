import { describe, expect, it } from "vitest";

import { COUNTER_NAMES, HISTOGRAM_NAMES, MetricsRegistry, RATIO_NAMES } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("registers exactly the eleven counters/histograms/ratios from spec.md §23.3", () => {
    expect(COUNTER_NAMES).toHaveLength(8);
    expect(HISTOGRAM_NAMES).toHaveLength(1);
    expect(RATIO_NAMES).toHaveLength(2);
    expect(COUNTER_NAMES.length + HISTOGRAM_NAMES.length + RATIO_NAMES.length).toBe(11);
  });

  it("starts every counter at 0 and every ratio at null", () => {
    const registry = new MetricsRegistry();
    const snapshot = registry.snapshot();
    for (const name of COUNTER_NAMES) {
      expect(snapshot.counters[name]).toBe(0);
    }
    for (const name of RATIO_NAMES) {
      expect(snapshot.ratios[name]).toBeNull();
    }
    expect(snapshot.histograms.search_latency_ms.count).toBe(0);
  });

  it("increments counters, defaulting to +1", () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter("files_scanned");
    registry.incrementCounter("files_scanned");
    registry.incrementCounter("chunks_created", 5);

    const snapshot = registry.snapshot();
    expect(snapshot.counters.files_scanned).toBe(2);
    expect(snapshot.counters.chunks_created).toBe(5);
  });

  it("rejects negative or non-finite counter deltas", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.incrementCounter("files_scanned", -1)).toThrow(RangeError);
    expect(() => registry.incrementCounter("files_scanned", Number.NaN)).toThrow(RangeError);
  });

  it("summarizes histogram observations with count/sum/min/max/avg/percentiles", () => {
    const registry = new MetricsRegistry();
    for (const value of [10, 20, 30, 40, 50]) {
      registry.observeHistogram("search_latency_ms", value);
    }

    const histogram = registry.snapshot().histograms.search_latency_ms;
    expect(histogram.count).toBe(5);
    expect(histogram.sum).toBe(150);
    expect(histogram.min).toBe(10);
    expect(histogram.max).toBe(50);
    expect(histogram.avg).toBe(30);
    expect(histogram.p50).toBeGreaterThanOrEqual(20);
  });

  it("sets and clears ratio gauges", () => {
    const registry = new MetricsRegistry();
    registry.setRatio("resolved_import_ratio", 0.75);
    expect(registry.snapshot().ratios.resolved_import_ratio).toBe(0.75);

    registry.setRatio("resolved_import_ratio", null);
    expect(registry.snapshot().ratios.resolved_import_ratio).toBeNull();
  });

  it("rejects ratios outside [0, 1]", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.setRatio("resolved_call_ratio", 1.5)).toThrow(RangeError);
    expect(() => registry.setRatio("resolved_call_ratio", -0.1)).toThrow(RangeError);
  });

  it("snapshot() returns an independent plain object, not a live view", () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter("parse_failures");
    const first = registry.snapshot();
    registry.incrementCounter("parse_failures");

    expect(first.counters.parse_failures).toBe(1);
    expect(registry.snapshot().counters.parse_failures).toBe(2);
  });

  it("reset() zeroes counters/histograms and nulls ratios", () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter("files_scanned", 3);
    registry.observeHistogram("search_latency_ms", 99);
    registry.setRatio("resolved_call_ratio", 0.5);

    registry.reset();

    const snapshot = registry.snapshot();
    expect(snapshot.counters.files_scanned).toBe(0);
    expect(snapshot.histograms.search_latency_ms.count).toBe(0);
    expect(snapshot.ratios.resolved_call_ratio).toBeNull();
  });
});
