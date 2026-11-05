import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns an empty array for an empty input without calling fn", async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], 3, async () => {
      calls += 1;
      return calls;
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("preserves output order regardless of completion order", async () => {
    const delaysMs = [30, 10, 20, 0];
    const result = await mapWithConcurrency(delaysMs, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("propagates a rejection from fn", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) {
          throw new Error("boom");
        }
        return item;
      }),
    ).rejects.toThrow("boom");
  });
});
