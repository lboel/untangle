import { describe, expect, it } from "vitest";

import { mapConcurrent } from "./concurrency.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe("mapConcurrent", () => {
  it("processes every item and preserves the produced values (order-agnostic)", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await collect(mapConcurrent(items, 2, async (n) => n * 2));
    expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
  });

  it("never runs more than `concurrency` workers at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    const results = await collect(
      mapConcurrent(items, 3, async (n) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return n;
      }),
    );

    expect(results).toHaveLength(12);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("works over an async-iterable source, not just a plain array", async () => {
    async function* source(): AsyncGenerator<number> {
      yield 1;
      yield 2;
      yield 3;
    }
    const results = await collect(mapConcurrent(source(), 2, async (n) => n + 100));
    expect(results.sort((a, b) => a - b)).toEqual([101, 102, 103]);
  });

  it("handles an empty source", async () => {
    const results = await collect(mapConcurrent([] as number[], 4, async (n) => n));
    expect(results).toEqual([]);
  });

  it("stops and rejects once the AbortSignal fires before any work starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(mapConcurrent([1, 2, 3], 2, async (n) => n, controller.signal)),
    ).rejects.toThrow();
  });

  it("stops yielding once the AbortSignal fires mid-stream", async () => {
    const controller = new AbortController();
    const items = [1, 2, 3, 4, 5, 6];
    const results: number[] = [];

    await expect(
      (async () => {
        for await (const value of mapConcurrent(items, 1, async (n) => n, controller.signal)) {
          results.push(value);
          if (results.length === 1) {
            // Abort strictly *after* the first value was already handed to
            // the consumer, so the outcome is deterministic: the generator
            // must reject on its next resumption instead of continuing.
            controller.abort();
          }
        }
      })(),
    ).rejects.toThrow();

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeLessThan(items.length);
  });
});
