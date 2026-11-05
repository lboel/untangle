import { setTimeout as delay } from "node:timers/promises";

import type { LockHandle, LockProvider, LockRecordV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { withRenewingLease } from "./renewing-lease.js";

function record(key: string): LockRecordV1 {
  return {
    key,
    pid: 1,
    processInstanceId: "process-a",
    host: "test",
    acquiredAt: "2025-01-01T00:00:00.000Z",
    leaseExpiresAt: "2025-01-01T00:00:00.030Z",
  };
}

function providerFor(handle: LockHandle): LockProvider {
  return {
    acquire: async () => handle,
    tryAcquire: async () => handle,
    inspect: async () => handle.record,
  };
}

describe("renewing publication lease", () => {
  it("renews slow storage without overlapping and performs a final ownership check", async () => {
    let activeRenewals = 0;
    let maximumActiveRenewals = 0;
    let renewalCalls = 0;
    let released = false;
    let announceFirstRenewal = (): void => undefined;
    let releaseFirstRenewal = (): void => undefined;
    const firstRenewalStarted = new Promise<void>((resolve) => {
      announceFirstRenewal = resolve;
    });
    const firstRenewalMayFinish = new Promise<void>((resolve) => {
      releaseFirstRenewal = resolve;
    });
    const key = "index-state:test";
    const handle: LockHandle = {
      key,
      record: record(key),
      renew: async () => {
        renewalCalls += 1;
        activeRenewals += 1;
        maximumActiveRenewals = Math.max(maximumActiveRenewals, activeRenewals);
        if (renewalCalls === 1) {
          announceFirstRenewal();
          await firstRenewalMayFinish;
        }
        activeRenewals -= 1;
      },
      release: async () => {
        released = true;
      },
    };

    const result = await withRenewingLease({
      lockProvider: providerFor(handle),
      key,
      leaseMs: 15,
      waitMs: 10,
      operation: async (guard) => {
        await firstRenewalStarted;
        const guardedCommit = guard.assertOwnership();
        // Keep the heartbeat renewal in flight beyond the nominal lease. The
        // explicit guard must queue, never overlap it.
        await delay(20);
        releaseFirstRenewal();
        await guardedCommit;
        return "published";
      },
    });

    expect(result).toBe("published");
    // Heartbeat, pre-publication guard, final ownership renewal.
    expect(renewalCalls).toBe(3);
    expect(maximumActiveRenewals).toBe(1);
    expect(released).toBe(true);
  });

  it("prevents publication after ownership loss and still releases its stale handle", async () => {
    let committed = false;
    let released = false;
    let renewalCalls = 0;
    let announceRenewal = (): void => undefined;
    const renewalAttempted = new Promise<void>((resolve) => {
      announceRenewal = resolve;
    });
    const key = "index-state:lost";
    const ownershipLoss = new Error("lease owner changed");
    const handle: LockHandle = {
      key,
      record: record(key),
      renew: async () => {
        renewalCalls += 1;
        announceRenewal();
        throw ownershipLoss;
      },
      release: async () => {
        released = true;
      },
    };

    await expect(
      withRenewingLease({
        lockProvider: providerFor(handle),
        key,
        leaseMs: 15,
        waitMs: 10,
        operation: async (guard) => {
          await renewalAttempted;
          await guard.assertOwnership();
          committed = true;
        },
      }),
    ).rejects.toBe(ownershipLoss);

    expect(renewalCalls).toBeGreaterThan(0);
    expect(committed).toBe(false);
    expect(released).toBe(true);
  });
});
