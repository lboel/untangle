/**
 * Exponential backoff with full jitter (spec.md §9.2).
 *
 * Jitter is drawn from the injected `Random` port, never `Math.random()`
 * (BUILD_PLAN global rule, enforced repo-wide by `eslint.config.js`'s
 * `no-restricted-syntax`). Delays are executed via an injected {@link
 * SleepFn} so tests can assert the retry schedule without a real wait.
 */
import type { Random } from "@untangle-code/domain";

import type { SleepFn } from "./types.js";

export interface BackoffConfig {
  /** Maximum number of retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * "Full jitter" delay for retry attempt `attempt` (0-based, i.e. the first
 * retry after the initial attempt is `attempt === 0`): uniform random in
 * `[0, min(maxDelayMs, baseDelayMs * 2^attempt)]`.
 */
export function computeBackoffDelayMs(
  attempt: number,
  config: BackoffConfig,
  random: Random,
): number {
  const cap = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
  return Math.round(random.nextFloat() * cap);
}

export interface RetryOptions {
  // `| undefined` spelled out: callers forward an already-optional signal
  // under exactOptionalPropertyTypes.
  signal?: AbortSignal | undefined;
  /** Whether `error` is worth retrying at all; a `false` result stops immediately. */
  isRetryable: (error: unknown) => boolean;
}

/**
 * Runs `fn`, retrying on retryable errors up to `config.maxRetries` times
 * with exponential backoff and jitter (spec.md §9.2). A non-retryable error,
 * or a retryable error that has exhausted its retries, propagates as-is —
 * the caller (the `EmbeddingProvider`) is responsible for turning that into
 * the right `UntangleError` ("repeated permanent errors MUST stop the job in
 * a controlled way", spec.md §9.2).
 *
 * Checks `signal` before every attempt and every sleep so an abort mid-retry
 * surfaces immediately rather than after the next attempt completes.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: BackoffConfig,
  deps: { random: Random; sleep: SleepFn },
  options: RetryOptions,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= config.maxRetries || !options.isRetryable(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, config, deps.random);
      await deps.sleep(delayMs, options.signal);
      attempt += 1;
    }
  }
}
