/**
 * In-memory `LockProvider` (architecture.md §21.1–§21.2). Stale detection is
 * lease-expiry based, never PID existence alone — an expired lease can
 * always be stolen by the next `tryAcquire`/`acquire`, matching the "no
 * PID-reuse trap" requirement.
 */
import type {
  Clock,
  LockHandle,
  LockProvider,
  LockRecordV1,
  PortCallOptions,
  Random,
} from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";

import { abortedRejection } from "./abort.js";
import { SystemClock } from "./clock.js";

const DEFAULT_LEASE_MS = 30_000;
const POLL_INTERVAL_MS = 10;

/**
 * Real-time reference for `acquire()`'s retry-loop bound ONLY (see the
 * comment inside `acquire()`) — a fixed internal instance, never the
 * caller-injected `Clock` this class is constructed with. Going through
 * `SystemClock` here, rather than `Date.now()` directly, is what keeps this
 * file free of raw `Date.now()`/`Math.random()` calls (BUILD_PLAN global
 * determinism rule) — the one narrow, documented exception to that rule
 * lives entirely inside `SystemClock` itself.
 */
const REALTIME = new SystemClock();

function isExpired(record: LockRecordV1, nowEpochMs: number): boolean {
  return Date.parse(record.leaseExpiresAt) <= nowEpochMs;
}

export class InMemoryLockProvider implements LockProvider {
  private readonly locks = new Map<string, LockRecordV1>();

  public constructor(
    private readonly clock: Clock,
    private readonly random: Random,
  ) {}

  private buildRecord(key: string, leaseMs: number): LockRecordV1 {
    const nowMs = this.clock.nowEpochMs();
    return {
      key,
      pid: process.pid,
      processInstanceId: this.random.uuid(),
      host: "testkit-in-memory",
      acquiredAt: this.clock.nowIso(),
      leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
    };
  }

  private makeHandle(record: LockRecordV1, leaseMs: number): LockHandle {
    let current = record;
    return {
      get key() {
        return current.key;
      },
      get record() {
        return current;
      },
      // `async` is deliberate: `LockHandle.renew()` is documented to reject
      // its returned Promise, never to throw synchronously (same reasoning
      // as `InMemoryVectorStore`'s `requireCollection`-based methods).
      renew: async (options?: PortCallOptions): Promise<void> => {
        if (options?.signal?.aborted) {
          throw new UntangleError("JOB_CANCELLED", `Lock renew for "${current.key}" was aborted`, {
            operation: "lock_renew",
            context: { key: current.key },
          });
        }
        const holder = this.locks.get(current.key);
        if (!holder || holder.processInstanceId !== current.processInstanceId) {
          throw new UntangleError("LOCK_HELD", `Lock "${current.key}" was lost before renew`, {
            operation: "lock_renew",
            context: { key: current.key },
          });
        }
        const renewed = this.buildRecord(current.key, leaseMs);
        this.locks.set(current.key, renewed);
        current = renewed;
      },
      release: (): Promise<void> => {
        const holder = this.locks.get(current.key);
        if (holder && holder.processInstanceId === current.processInstanceId) {
          this.locks.delete(current.key);
        }
        return Promise.resolve();
      },
    };
  }

  public tryAcquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number },
  ): Promise<LockHandle | null> {
    const aborted = abortedRejection<LockHandle | null>(options, "lock_try_acquire");
    if (aborted) {
      return aborted;
    }
    const existing = this.locks.get(key);
    if (existing && !isExpired(existing, this.clock.nowEpochMs())) {
      return Promise.resolve(null);
    }
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const record = this.buildRecord(key, leaseMs);
    this.locks.set(key, record);
    return Promise.resolve(this.makeHandle(record, leaseMs));
  }

  public async acquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number; waitMs?: number },
  ): Promise<LockHandle> {
    const waitMs = options?.waitMs ?? 0;
    // The retry loop below polls with a REAL `setTimeout`, so the give-up
    // bound MUST be measured against real elapsed wall-clock time, never
    // against the injected `Clock`. A previous version computed the
    // deadline as `this.clock.nowEpochMs() + waitMs` — harmless with a real
    // clock, but every test in this package injects a `FakeClock`, which by
    // design never advances on its own. Against a lock that is held and
    // whose lease has not expired, that deadline was never reached no
    // matter how much real time passed, so `acquire()` retried forever in
    // real time: a genuine hang, not just a documentation caveat (see
    // README "Entscheidungen"). Lease *expiry* is still evaluated purely
    // through the injected Clock (`tryAcquire` → `isExpired`), so callers
    // keep full, deterministic control over when a lease looks expired —
    // only the "how long do we keep retrying" bound now uses real time,
    // matching how the polling itself actually spends time.
    const startedAtRealMs = REALTIME.nowEpochMs();
    for (;;) {
      const handle = await this.tryAcquire(key, options);
      if (handle) {
        return handle;
      }
      const elapsedRealMs = REALTIME.nowEpochMs() - startedAtRealMs;
      if (elapsedRealMs >= waitMs) {
        throw new UntangleError("LOCK_HELD", `Lock "${key}" is held`, {
          operation: "lock_acquire",
          retryable: true,
          context: { key },
        });
      }
      if (options?.signal?.aborted) {
        throw new UntangleError("JOB_CANCELLED", `Lock acquire for "${key}" was aborted`, {
          operation: "lock_acquire",
          context: { key },
        });
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_INTERVAL_MS, waitMs - elapsedRealMs)),
      );
    }
  }

  public inspect(key: string, options?: PortCallOptions): Promise<LockRecordV1 | null> {
    const aborted = abortedRejection<LockRecordV1 | null>(options, "lock_inspect");
    if (aborted) {
      return aborted;
    }
    const existing = this.locks.get(key);
    if (!existing || isExpired(existing, this.clock.nowEpochMs())) {
      return Promise.resolve(null);
    }
    return Promise.resolve(existing);
  }
}
