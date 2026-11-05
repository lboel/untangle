/**
 * A short local publication lease with the same safety shape as the index
 * job lease: non-overlapping heartbeat renewals plus one final owner-checked
 * renewal before a result becomes observable to the caller.
 */

import type { LockHandle, LockProvider } from "@untangle-code/domain";

export interface RenewingLeaseGuard {
  /** Serializes behind any in-flight heartbeat and proves current ownership. */
  assertOwnership(): Promise<void>;
}

export interface WithRenewingLeaseInput<Result> {
  readonly lockProvider: LockProvider;
  readonly key: string;
  readonly waitMs: number;
  readonly leaseMs: number;
  readonly operation: (guard: RenewingLeaseGuard) => Promise<Result>;
}

interface LeaseHeartbeat extends RenewingLeaseGuard {
  readonly failure: unknown | undefined;
  stop(): Promise<void>;
  stopAndAssertOwnership(): Promise<void>;
}

/**
 * Holds a renewable lease around one operation.
 *
 * The operation must call `guard.assertOwnership()` immediately before every
 * irreversible publication boundary. Heartbeat failure is sticky: all later
 * guards reject, and a final renewal is required before success is returned.
 */
export async function withRenewingLease<Result>(
  input: WithRenewingLeaseInput<Result>,
): Promise<Result> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 3) {
    throw new RangeError("leaseMs must be a safe integer >= 3");
  }
  const lock = await input.lockProvider.acquire(input.key, {
    leaseMs: input.leaseMs,
    waitMs: input.waitMs,
  });
  const heartbeat = startHeartbeat(lock, input.leaseMs);
  try {
    let result: Result;
    try {
      result = await input.operation(heartbeat);
    } catch (error) {
      await heartbeat.stop();
      throw heartbeat.failure ?? error;
    }
    await heartbeat.stopAndAssertOwnership();
    return result;
  } finally {
    await heartbeat.stop();
    await lock.release();
  }
}

/** Never overlaps `LockHandle.renew()`, even when storage is slower than the interval. */
function startHeartbeat(lock: LockHandle, leaseMs: number): LeaseHeartbeat {
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let renewalTail: Promise<void> = Promise.resolve();
  let failure: unknown | undefined;

  const renewExclusively = (): Promise<void> => {
    const renewal = renewalTail.then(async () => {
      if (failure !== undefined) throw failure;
      try {
        await lock.renew();
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    // Keep the serialization tail fulfilled; callers still receive the real
    // rejecting promise above, while a later guard can report sticky failure.
    renewalTail = renewal.catch(() => undefined);
    return renewal;
  };

  const schedule = (): void => {
    if (stopped || failure !== undefined) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || failure !== undefined) return;
      void renewExclusively().then(schedule, () => undefined);
    }, intervalMs);
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await renewalTail;
  };

  schedule();
  return {
    get failure() {
      return failure;
    },
    stop,
    assertOwnership: async (): Promise<void> => {
      if (failure !== undefined) throw failure;
      await renewExclusively();
      if (failure !== undefined) throw failure;
    },
    stopAndAssertOwnership: async (): Promise<void> => {
      await stop();
      if (failure !== undefined) throw failure;
      await renewExclusively();
    },
  };
}
