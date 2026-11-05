import { describe, expect, it } from "vitest";

import { FakeClock, SystemClock } from "./clock.js";

describe("FakeClock", () => {
  it("starts at epoch 0 by default", () => {
    expect(new FakeClock().nowEpochMs()).toBe(0);
  });

  it("starts at a given epoch millisecond value", () => {
    expect(new FakeClock(1_000).nowEpochMs()).toBe(1_000);
  });

  it("never advances on its own between reads", () => {
    const clock = new FakeClock(500);
    expect(clock.nowEpochMs()).toBe(500);
    expect(clock.nowEpochMs()).toBe(500);
  });

  it("advances forward by a positive delta", () => {
    const clock = new FakeClock(0);
    clock.advance(1_000);
    expect(clock.nowEpochMs()).toBe(1_000);
  });

  it("advances backward by a negative delta", () => {
    const clock = new FakeClock(1_000);
    clock.advance(-400);
    expect(clock.nowEpochMs()).toBe(600);
  });

  it("set() jumps to an absolute epoch value", () => {
    const clock = new FakeClock(0);
    clock.set(42);
    expect(clock.nowEpochMs()).toBe(42);
  });

  it("nowIso() renders the current epoch as ISO-8601", () => {
    const clock = new FakeClock(0);
    expect(clock.nowIso()).toBe(new Date(0).toISOString());
  });
});

describe("SystemClock", () => {
  it("nowEpochMs() tracks real wall-clock time, advancing on its own", async () => {
    const clock = new SystemClock();
    const first = clock.nowEpochMs();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(clock.nowEpochMs()).toBeGreaterThanOrEqual(first);
  });

  it("nowIso() renders a valid ISO-8601 timestamp consistent with nowEpochMs()", () => {
    const clock = new SystemClock();
    const beforeEpochMs = clock.nowEpochMs();
    const iso = clock.nowIso();
    const afterEpochMs = clock.nowEpochMs();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const parsed = Date.parse(iso);
    expect(parsed).toBeGreaterThanOrEqual(beforeEpochMs);
    expect(parsed).toBeLessThanOrEqual(afterEpochMs);
  });
});
