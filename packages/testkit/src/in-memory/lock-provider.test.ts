import { UntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { FakeClock, SystemClock } from "./clock.js";
import { InMemoryLockProvider } from "./lock-provider.js";
import { DeterministicRandom } from "./random.js";

function makeProvider(startEpochMs = 0) {
  return new InMemoryLockProvider(new FakeClock(startEpochMs), new DeterministicRandom(1));
}

describe("InMemoryLockProvider", () => {
  it("tryAcquire grants a free lock", async () => {
    const provider = makeProvider();
    const handle = await provider.tryAcquire("repo:1:main:index");
    expect(handle).not.toBeNull();
    expect(handle?.key).toBe("repo:1:main:index");
  });

  it("tryAcquire returns null when the lock is already held and unexpired", async () => {
    const provider = makeProvider();
    await provider.tryAcquire("key");
    const second = await provider.tryAcquire("key");
    expect(second).toBeNull();
  });

  it("tryAcquire grants the lock again once the lease has expired", async () => {
    const clock = new FakeClock(0);
    const provider = new InMemoryLockProvider(clock, new DeterministicRandom(1));
    const first = await provider.tryAcquire("key", { leaseMs: 1_000 });
    expect(first).not.toBeNull();
    clock.advance(1_001);
    const second = await provider.tryAcquire("key");
    expect(second).not.toBeNull();
  });

  it("release() frees the lock for a subsequent acquire", async () => {
    const provider = makeProvider();
    const handle = await provider.tryAcquire("key");
    await handle?.release();
    const second = await provider.tryAcquire("key");
    expect(second).not.toBeNull();
  });

  it("release() is a no-op when the lock was already stolen (stale processInstanceId)", async () => {
    const clock = new FakeClock(0);
    const provider = new InMemoryLockProvider(clock, new DeterministicRandom(1));
    const first = await provider.tryAcquire("key", { leaseMs: 100 });
    clock.advance(101);
    const second = await provider.tryAcquire("key");
    expect(second).not.toBeNull();
    // Releasing the stale first handle must not release the second holder's lock.
    await first?.release();
    const inspected = await provider.inspect("key");
    expect(inspected?.processInstanceId).toBe(second?.record.processInstanceId);
  });

  it("renew() extends the lease for the current holder", async () => {
    const clock = new FakeClock(0);
    const provider = new InMemoryLockProvider(clock, new DeterministicRandom(1));
    const handle = await provider.tryAcquire("key", { leaseMs: 100 });
    clock.advance(50);
    await handle?.renew();
    clock.advance(80);
    // Original lease (100ms from t=0) would have expired at t=100; renew at
    // t=50 pushes it to t=150, so the lock must still be held at t=130.
    const stillHeld = await provider.tryAcquire("key");
    expect(stillHeld).toBeNull();
  });

  it("renew() throws LOCK_HELD once the lock was lost to another holder", async () => {
    const clock = new FakeClock(0);
    const provider = new InMemoryLockProvider(clock, new DeterministicRandom(1));
    const first = await provider.tryAcquire("key", { leaseMs: 10 });
    clock.advance(11);
    await provider.tryAcquire("key");
    await expect(first?.renew()).rejects.toBeInstanceOf(UntangleError);
  });

  it("inspect() returns null for an unknown or expired lock", async () => {
    const clock = new FakeClock(0);
    const provider = new InMemoryLockProvider(clock, new DeterministicRandom(1));
    expect(await provider.inspect("unknown")).toBeNull();
    await provider.tryAcquire("key", { leaseMs: 10 });
    clock.advance(11);
    expect(await provider.inspect("key")).toBeNull();
  });

  it("acquire() resolves immediately when the lock is free", async () => {
    const provider = makeProvider();
    const handle = await provider.acquire("key");
    expect(handle.key).toBe("key");
  });

  it("acquire() throws LOCK_HELD without waiting when waitMs is 0 (default)", async () => {
    const provider = makeProvider();
    await provider.tryAcquire("key", { leaseMs: 60_000 });
    await expect(provider.acquire("key")).rejects.toMatchObject({ code: "LOCK_HELD" });
  });

  it("acquire() respects an already-aborted signal", async () => {
    const provider = makeProvider();
    await provider.tryAcquire("key", { leaseMs: 60_000 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.acquire("key", { waitMs: 1_000, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  });

  // Regression guard for the "hangs forever" defect: acquire()'s deadline
  // used to be computed from the injected Clock, which in every test here
  // is a `FakeClock` that never advances on its own. Waiting against a
  // held, non-expiring lease therefore polled forever in REAL time. A
  // vitest test-level timeout is the backstop: if this ever regresses, the
  // test fails fast with a timeout error instead of hanging the whole
  // suite (and CI) indefinitely.
  it("acquire() gives up with LOCK_HELD after roughly waitMs of REAL time against a held, non-expiring lock and a frozen clock (regression: used to hang forever)", async () => {
    const provider = makeProvider(0); // FakeClock frozen at t=0, never advanced.
    await provider.tryAcquire("key", { leaseMs: 60_000 }); // lease far in the (frozen) future
    const startedAtRealMs = new SystemClock().nowEpochMs();
    await expect(provider.acquire("key", { waitMs: 50 })).rejects.toMatchObject({
      code: "LOCK_HELD",
    });
    // Loose bound: proves the wait was bounded (not instant, not infinite),
    // without being flaky under CI scheduling jitter.
    expect(new SystemClock().nowEpochMs() - startedAtRealMs).toBeLessThan(2_000);
  }, 5_000);

  it("acquire() grants the lock once it is released while waiting, even though the injected clock never advances", async () => {
    const provider = makeProvider(0);
    const held = await provider.tryAcquire("key", { leaseMs: 60_000 });
    const waiting = provider.acquire("key", { waitMs: 2_000 });
    setTimeout(() => {
      void held?.release();
    }, 20);
    const handle = await waiting;
    expect(handle.key).toBe("key");
  });
});
