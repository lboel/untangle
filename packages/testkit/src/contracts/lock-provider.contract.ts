/**
 * Port-contract suite for `LockProvider` (domain `ports.ts`, architecture.md
 * §21.1–§21.2).
 *
 * Lease timestamps use the adapter's injected Clock; polling and waitMs
 * use real elapsed time. A clock-controlled context lets this suite assert
 * exact lease boundaries while actual filesystem I/O and polling continue
 * to run normally. Legacy bare-provider factories remain supported and
 * must use a real clock, since their lease time can only advance by waiting.
 */
import type { LockProvider } from "@untangle-code/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { type FakeClock, SystemClock } from "../in-memory/clock.js";

export interface LockProviderContractContext {
  provider: LockProvider;
  /** The same fresh clock injected into this context's provider. */
  clock: FakeClock;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runLockProviderContract(
  factory: () =>
    | LockProvider
    | LockProviderContractContext
    | Promise<LockProvider | LockProviderContractContext>,
): void {
  describe("LockProvider port contract", () => {
    let provider: LockProvider;
    let clock: FakeClock | undefined;

    beforeEach(async () => {
      const context = await factory();
      if ("provider" in context) {
        provider = context.provider;
        clock = context.clock;
      } else {
        provider = context;
        clock = undefined;
      }
    });

    async function advanceLeaseTime(ms: number): Promise<void> {
      if (clock) clock.advance(ms);
      else await sleep(ms);
    }

    it("tryAcquire grants a free lock and returns a handle for that key", async () => {
      const handle = await provider.tryAcquire("k1");
      expect(handle).not.toBeNull();
      expect(handle?.key).toBe("k1");
    });

    it("tryAcquire returns null for a lock that is already held and unexpired", async () => {
      await provider.tryAcquire("k1", { leaseMs: 60_000 });
      expect(await provider.tryAcquire("k1")).toBeNull();
    });

    it("tryAcquire grants the lock again once the lease has really expired", async () => {
      await provider.tryAcquire("k1", { leaseMs: 20 });
      await advanceLeaseTime(60);
      expect(await provider.tryAcquire("k1")).not.toBeNull();
    }, 5_000);

    it("release() frees the lock for a subsequent tryAcquire", async () => {
      const handle = await provider.tryAcquire("k1");
      await handle?.release();
      expect(await provider.tryAcquire("k1")).not.toBeNull();
    });

    it("release() on a handle that already lost the lock to another holder is a safe no-op", async () => {
      const first = await provider.tryAcquire("k1", { leaseMs: 10 });
      await advanceLeaseTime(40);
      const second = await provider.tryAcquire("k1");
      expect(second).not.toBeNull();
      await first?.release();
      // The second holder's lock must survive the stale first handle's release.
      expect(await provider.inspect("k1")).not.toBeNull();
    }, 5_000);

    it("renew() extends the current holder's lease by another leaseMs from the renewal time", async () => {
      const handle = await provider.tryAcquire("k1", { leaseMs: 100 });
      expect(handle).not.toBeNull();
      await advanceLeaseTime(70);
      const renewedAt = clock?.nowEpochMs();
      await handle?.renew();
      if (renewedAt !== undefined) {
        expect(Date.parse(handle!.record.leaseExpiresAt)).toBe(renewedAt + 100);
      }
      await advanceLeaseTime(70);
      // The original 100ms lease has expired at logical t=140, but renewing
      // at t=70 must keep the lock held until precisely t=170.
      expect(await provider.tryAcquire("k1")).toBeNull();
      if (clock) {
        await advanceLeaseTime(29);
        expect(await provider.inspect("k1")).not.toBeNull();
        expect(await provider.tryAcquire("k1")).toBeNull();
        await advanceLeaseTime(1);
        expect(await provider.inspect("k1")).toBeNull();
        expect(await provider.tryAcquire("k1")).not.toBeNull();
      }
    }, 5_000);

    it("renew() rejects once the lock was lost to another holder", async () => {
      const first = await provider.tryAcquire("k1", { leaseMs: 10 });
      await advanceLeaseTime(40);
      await provider.tryAcquire("k1");
      await expect(first?.renew()).rejects.toBeDefined();
    }, 5_000);

    it("inspect() returns null for an unknown key and for an expired lease", async () => {
      expect(await provider.inspect("never-acquired")).toBeNull();
      await provider.tryAcquire("k1", { leaseMs: 10 });
      await advanceLeaseTime(40);
      expect(await provider.inspect("k1")).toBeNull();
    }, 5_000);

    it("acquire() resolves immediately when the lock is free", async () => {
      const handle = await provider.acquire("k1");
      expect(handle.key).toBe("k1");
    });

    it("acquire() rejects with LOCK_HELD immediately when waitMs is 0 (default) and the lock is held", async () => {
      await provider.tryAcquire("k1", { leaseMs: 60_000 });
      await expect(provider.acquire("k1")).rejects.toMatchObject({ code: "LOCK_HELD" });
    });

    it("acquire() waits and then succeeds once the lease expires within waitMs", async () => {
      await provider.tryAcquire("k1", { leaseMs: 20 });
      const expiry = clock ? setTimeout(() => clock?.advance(20), 20) : undefined;
      try {
        const handle = await provider.acquire("k1", { waitMs: 2_000 });
        expect(handle.key).toBe("k1");
      } finally {
        clearTimeout(expiry);
      }
    }, 5_000);

    it("acquire() gives up with LOCK_HELD after waitMs against a lock that outlives the wait (regression guard: must not hang)", async () => {
      await provider.tryAcquire("k1", { leaseMs: 60_000 });
      const startedAtRealMs = new SystemClock().nowEpochMs();
      await expect(provider.acquire("k1", { waitMs: 50 })).rejects.toMatchObject({
        code: "LOCK_HELD",
      });
      const elapsedRealMs = new SystemClock().nowEpochMs() - startedAtRealMs;
      expect(elapsedRealMs).toBeGreaterThanOrEqual(50);
      expect(elapsedRealMs).toBeLessThan(3_000);
    }, 5_000);

    it("acquire() respects an already-aborted signal", async () => {
      await provider.tryAcquire("k1", { leaseMs: 60_000 });
      const controller = new AbortController();
      controller.abort();
      await expect(
        provider.acquire("k1", { waitMs: 1_000, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    });

    it("acquire() rejects when its signal is aborted while waiting", async () => {
      await provider.tryAcquire("k1", { leaseMs: 60_000 });
      const controller = new AbortController();
      const waiting = provider.acquire("k1", { waitMs: 1_000, signal: controller.signal });
      const rejection = expect(waiting).rejects.toMatchObject({ code: "JOB_CANCELLED" });
      const abort = setTimeout(() => controller.abort(), 20);
      try {
        await rejection;
      } finally {
        clearTimeout(abort);
      }
    });

    it("locks are independent per key", async () => {
      const a = await provider.tryAcquire("a");
      const b = await provider.tryAcquire("b");
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });
  });
}
