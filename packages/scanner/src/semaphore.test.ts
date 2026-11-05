import { describe, expect, it } from "vitest";

import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("allows up to `concurrency` acquisitions without waiting", async () => {
    const semaphore = new Semaphore(2);
    expect(semaphore.availableCount).toBe(2);
    await semaphore.acquire();
    expect(semaphore.availableCount).toBe(1);
    await semaphore.acquire();
    expect(semaphore.availableCount).toBe(0);
  });

  it("queues an acquisition beyond the limit until a release happens", async () => {
    const semaphore = new Semaphore(1);
    const release1 = await semaphore.acquire();

    let acquired2 = false;
    const pending = semaphore.acquire().then((release) => {
      acquired2 = true;
      return release;
    });

    // Give the microtask queue a chance to run; the second acquire must
    // still be pending because the first slot has not been released.
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired2).toBe(false);

    release1();
    const release2 = await pending;
    expect(acquired2).toBe(true);
    release2();
    expect(semaphore.availableCount).toBe(1);
  });

  it("never lets more than `concurrency` workers run at once", async () => {
    const concurrency = 3;
    const semaphore = new Semaphore(concurrency);
    let active = 0;
    let maxActive = 0;

    async function work(): Promise<void> {
      const release = await semaphore.acquire();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      release();
    }

    await Promise.all(Array.from({ length: 10 }, () => work()));
    expect(maxActive).toBeLessThanOrEqual(concurrency);
  });

  it("rejects a non-positive-integer concurrency", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(-1)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });
});
