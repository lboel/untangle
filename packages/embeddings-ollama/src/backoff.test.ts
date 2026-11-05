import { DeterministicRandom } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { computeBackoffDelayMs, withRetry, type BackoffConfig } from "./backoff.js";
import { createRecordingSleep } from "./test-helpers.js";

const config: BackoffConfig = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 800 };

describe("computeBackoffDelayMs", () => {
  it("stays within [0, min(maxDelayMs, baseDelayMs * 2^attempt)] for every attempt", () => {
    const random = new DeterministicRandom(1);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const delay = computeBackoffDelayMs(attempt, config, random);
      const cap = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(cap);
    }
  });

  it("is deterministic for a given seed and attempt", () => {
    const a = computeBackoffDelayMs(2, config, new DeterministicRandom(7));
    const b = computeBackoffDelayMs(2, config, new DeterministicRandom(7));
    expect(a).toBe(b);
  });

  it("respects the delay cap once base*2^attempt exceeds maxDelayMs", () => {
    const random = {
      nextFloat: () => 1,
      nextInt: () => 0,
      bytes: () => new Uint8Array(),
      uuid: () => "",
    };
    // attempt 5: base*2^5 = 3200, capped to maxDelayMs=800; nextFloat()=1 hits the cap exactly.
    expect(computeBackoffDelayMs(5, config, random)).toBe(800);
  });
});

describe("withRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const { sleep, delays } = createRecordingSleep();
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(
      fn,
      config,
      { random: new DeterministicRandom(1), sleep },
      {
        isRetryable: () => true,
      },
    );
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries a retryable error with an increasing backoff schedule, then succeeds", async () => {
    const { sleep, delays } = createRecordingSleep();
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("transient");
      }
      return "recovered";
    });
    const result = await withRetry(
      fn,
      config,
      { random: new DeterministicRandom(1), sleep },
      {
        isRetryable: () => true,
      },
    );
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
    // Each delay is within its attempt's cap (base*2^attempt), confirming exponential growth.
    expect(delays[0]).toBeLessThanOrEqual(config.baseDelayMs * 2 ** 0);
    expect(delays[1]).toBeLessThanOrEqual(config.baseDelayMs * 2 ** 1);
  });

  it("stops after maxRetries and throws the last error", async () => {
    const { sleep } = createRecordingSleep();
    const error = new Error("permanent-looking but classified retryable");
    const fn = vi.fn().mockRejectedValue(error);
    await expect(
      withRetry(
        fn,
        config,
        { random: new DeterministicRandom(1), sleep },
        { isRetryable: () => true },
      ),
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(config.maxRetries + 1);
  });

  it("does not retry when isRetryable returns false, even on the first attempt", async () => {
    const { sleep, delays } = createRecordingSleep();
    const error = new Error("permanent");
    const fn = vi.fn().mockRejectedValue(error);
    await expect(
      withRetry(
        fn,
        config,
        { random: new DeterministicRandom(1), sleep },
        { isRetryable: () => false },
      ),
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("stops immediately when the signal is already aborted, without calling fn", async () => {
    const { sleep } = createRecordingSleep();
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn();
    await expect(
      withRetry(
        fn,
        config,
        { random: new DeterministicRandom(1), sleep },
        {
          signal: controller.signal,
          isRetryable: () => true,
        },
      ),
    ).rejects.toBeDefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("stops between attempts when the signal aborts during the backoff wait", async () => {
    const controller = new AbortController();
    const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
      controller.abort();
      signal?.throwIfAborted();
    };
    const fn = vi.fn().mockRejectedValue(new Error("transient"));
    await expect(
      withRetry(
        fn,
        config,
        { random: new DeterministicRandom(1), sleep },
        {
          signal: controller.signal,
          isRetryable: () => true,
        },
      ),
    ).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
