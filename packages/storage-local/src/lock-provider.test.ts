import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Clock,
  DirEntryV1,
  FileStatV1,
  FileSystemPort,
  PortCallOptions,
} from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import {
  DeterministicRandom,
  FakeClock,
  runLockProviderContract,
  SystemClock,
} from "@untangle-code/testkit";
import { afterAll, describe, expect, it } from "vitest";

import { LocalFileSystem } from "./local-file-system.js";
import { FileLockProvider } from "./lock-provider.js";

const createdBases: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeProvider(options?: {
  seed?: number;
  corruptGraceMs?: number;
  clock?: Clock;
}): Promise<{ provider: FileLockProvider; locksDir: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-locks-"));
  createdBases.push(base);
  const locksDir = path.join(base, "locks");
  const fs = new LocalFileSystem([base]);
  // Lease time is injectable; acquire() independently bounds its polling
  // by real elapsed time. File-specific integration cases default to real time.
  return {
    provider: new FileLockProvider(
      fs,
      locksDir,
      options?.clock ?? new SystemClock(),
      new DeterministicRandom(options?.seed ?? 1),
      "test-host",
      options?.corruptGraceMs,
    ),
    locksDir,
  };
}

/**
 * Delegates every `FileSystemPort` call to `inner` unmodified. Subclasses
 * override just the method(s) they need to make adversarial — used below to
 * build the "slow write" / "torn write" doubles the WP-80 regression tests
 * need, without hand-rolling a full fake filesystem for each one.
 */
abstract class DelegatingFileSystem implements FileSystemPort {
  protected constructor(protected readonly inner: FileSystemPort) {}

  public stat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    return this.inner.stat(path, options);
  }

  public lstat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    return this.inner.lstat(path, options);
  }

  public readFile(path: string, options?: PortCallOptions): Promise<Uint8Array> {
    return this.inner.readFile(path, options);
  }

  public readTextFile(path: string, options?: PortCallOptions): Promise<string> {
    return this.inner.readTextFile(path, options);
  }

  public readDir(path: string, options?: PortCallOptions): Promise<DirEntryV1[]> {
    return this.inner.readDir(path, options);
  }

  public realPath(path: string, options?: PortCallOptions): Promise<string> {
    return this.inner.realPath(path, options);
  }

  public writeFile(path: string, data: Uint8Array, options?: PortCallOptions): Promise<void> {
    return this.inner.writeFile(path, data, options);
  }

  public mkdir(path: string, options?: PortCallOptions & { recursive?: boolean }): Promise<void> {
    return this.inner.mkdir(path, options);
  }

  public rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    return this.inner.rename(from, to, options);
  }

  public remove(path: string, options?: PortCallOptions & { recursive?: boolean }): Promise<void> {
    return this.inner.remove(path, options);
  }
}

/**
 * Adversarial double for the WP-80 repro: delays every write to a `*.tmp`
 * path (i.e. the temp file `writeRecordAtomic()` writes before its atomic
 * `rename`) by `delayMs`, simulating a slow disk / slow write without ever
 * touching the live `record.json` path directly.
 */
class SlowTempWriteFileSystem extends DelegatingFileSystem {
  public constructor(
    inner: FileSystemPort,
    private readonly delayMs: number,
  ) {
    super(inner);
  }

  public override async writeFile(
    path: string,
    data: Uint8Array,
    options?: PortCallOptions,
  ): Promise<void> {
    if (path.endsWith(".tmp")) {
      await sleep(this.delayMs);
    }
    return this.inner.writeFile(path, data, options);
  }
}

/**
 * Adversarial double simulating a write that is interrupted partway through
 * — e.g. a process crash or a disk fault mid-write. Only the first half of
 * the intended bytes ever reach the temp file, and the write then rejects,
 * so `writeRecordAtomic()`'s subsequent `rename` is never reached. Proves
 * the live `record.json` path is never touched by a torn write, because
 * nothing ever writes to it directly any more (WP-80 fix).
 *
 * Starts disarmed (`armed = false`) so the initial `tryAcquire()`'s own
 * write can land normally; a test arms it right before the specific write
 * (typically a `renew()`) it wants to sabotage.
 */
class TornTempWriteFileSystem extends DelegatingFileSystem {
  public armed = false;

  public constructor(inner: FileSystemPort) {
    super(inner);
  }

  public override async writeFile(
    path: string,
    data: Uint8Array,
    options?: PortCallOptions,
  ): Promise<void> {
    if (this.armed && path.endsWith(".tmp")) {
      const half = data.subarray(0, Math.floor(data.length / 2));
      await this.inner.writeFile(path, half, options);
      throw new Error("simulated torn write: process crashed mid-write");
    }
    return this.inner.writeFile(path, data, options);
  }
}

afterAll(async () => {
  await Promise.all(createdBases.map((base) => rm(base, { recursive: true, force: true })));
});

runLockProviderContract(async () => {
  const clock = new FakeClock();
  return { provider: (await makeProvider({ clock })).provider, clock };
});

describe("FileLockProvider — deterministic lease clock", () => {
  it("keeps exact renewal boundaries through filesystem writes slower than the lease", async () => {
    const { locksDir } = await makeProvider();
    const base = path.dirname(locksDir);
    const clock = new FakeClock();
    const provider = new FileLockProvider(
      new SlowTempWriteFileSystem(new LocalFileSystem([base]), 150),
      locksDir,
      clock,
      new DeterministicRandom(301),
      "host-slow-disk",
    );
    const handle = await provider.tryAcquire("slow-lease", { leaseMs: 100 });
    expect(handle).not.toBeNull();
    expect(Date.parse(handle!.record.leaseExpiresAt)).toBe(100);
    clock.advance(70);
    await handle!.renew();
    expect(Date.parse(handle!.record.leaseExpiresAt)).toBe(170);
    clock.advance(70);
    expect(await provider.tryAcquire("slow-lease")).toBeNull();
    clock.advance(29);
    expect(await provider.inspect("slow-lease")).not.toBeNull();
    clock.advance(1);
    expect(await provider.inspect("slow-lease")).toBeNull();
    expect(await provider.tryAcquire("slow-lease")).not.toBeNull();
  });
});

describe("FileLockProvider — file-lock specific guarantees", () => {
  it("two provider instances racing for the same fresh lock: exactly one wins", async () => {
    const { locksDir: sharedLocksDir } = await makeProvider();
    const base = path.dirname(sharedLocksDir);
    const fsA = new LocalFileSystem([base]);
    const fsB = new LocalFileSystem([base]);
    const providerA = new FileLockProvider(
      fsA,
      sharedLocksDir,
      new SystemClock(),
      new DeterministicRandom(11),
      "host-a",
    );
    const providerB = new FileLockProvider(
      fsB,
      sharedLocksDir,
      new SystemClock(),
      new DeterministicRandom(22),
      "host-b",
    );

    const [handleA, handleB] = await Promise.all([
      providerA.tryAcquire("shared-key", { leaseMs: 60_000 }),
      providerB.tryAcquire("shared-key", { leaseMs: 60_000 }),
    ]);

    const winners = [handleA, handleB].filter((h) => h !== null);
    expect(winners).toHaveLength(1);
  });

  it("an expired lease from one provider instance is taken over by a different instance", async () => {
    const { locksDir: sharedLocksDir } = await makeProvider();
    const base = path.dirname(sharedLocksDir);
    const providerA = new FileLockProvider(
      new LocalFileSystem([base]),
      sharedLocksDir,
      new SystemClock(),
      new DeterministicRandom(3),
      "host-a",
    );
    const providerB = new FileLockProvider(
      new LocalFileSystem([base]),
      sharedLocksDir,
      new SystemClock(),
      new DeterministicRandom(4),
      "host-b",
    );

    const first = await providerA.tryAcquire("k", { leaseMs: 20 });
    expect(first).not.toBeNull();
    await sleep(80);
    const second = await providerB.tryAcquire("k", { leaseMs: 60_000 });
    expect(second).not.toBeNull();
    expect(second?.record.processInstanceId).not.toBe(first?.record.processInstanceId);
  }, 5_000);

  it(
    "PID reuse does not cause false takeover: an expired lease is stolen even when its " +
      "recorded PID equals the current process's PID (staleness must rely on lease expiry alone)",
    async () => {
      const { provider, locksDir } = await makeProvider();
      const lockDir = path.join(locksDir, lockDirHash("reuse-key"));
      await mkdir(lockDir, { recursive: true });
      const staleRecord = {
        key: "reuse-key",
        pid: process.pid,
        processInstanceId: "00000000-0000-4000-8000-000000000000",
        host: "some-other-host",
        acquiredAt: new Date(0).toISOString(),
        leaseExpiresAt: new Date(0).toISOString(), // already expired
        processStartedAtEpochMs: 0,
      };
      await writeFile(path.join(lockDir, "record.json"), JSON.stringify(staleRecord));

      const handle = await provider.tryAcquire("reuse-key", { leaseMs: 60_000 });
      expect(handle).not.toBeNull();
      expect(handle?.record.processInstanceId).not.toBe(staleRecord.processInstanceId);
    },
  );

  it("a lock directory that exists but has no record.json yet is treated as busy, not stale", async () => {
    const { provider, locksDir } = await makeProvider();
    const lockDir = path.join(locksDir, lockDirHash("busy-key"));
    await mkdir(lockDir, { recursive: true }); // simulate a competitor mid-write, before record.json lands

    const handle = await provider.tryAcquire("busy-key");
    expect(handle).toBeNull();
    // And the directory must survive untouched — it must NOT have been removed.
    await expect(readFile(path.join(lockDir, "record.json"), "utf8")).rejects.toBeDefined();
  });
});

describe("FileLockProvider — WP-80: a live lock can no longer be taken over via a torn/slow write", () => {
  it(
    "a slow write during renew() never lets a concurrent tryAcquire() steal the lock while " +
      "the original lease is still valid",
    async () => {
      const { locksDir } = await makeProvider();
      const base = path.dirname(locksDir);
      const fsA = new SlowTempWriteFileSystem(new LocalFileSystem([base]), 150);
      const fsB = new LocalFileSystem([base]);
      const providerA = new FileLockProvider(
        fsA,
        locksDir,
        new SystemClock(),
        new DeterministicRandom(101),
        "host-a",
      );
      const providerB = new FileLockProvider(
        fsB,
        locksDir,
        new SystemClock(),
        new DeterministicRandom(102),
        "host-b",
      );

      const handleA = await providerA.tryAcquire("wp80-slow", { leaseMs: 5_000 });
      expect(handleA).not.toBeNull();
      const originalInstanceId = handleA?.record.processInstanceId;

      // Start a renew whose temp-file write is deliberately slow — this is
      // the exact window (write in flight, live record.json not yet
      // swapped) in which the pre-fix code could expose a torn record.json.
      const renewPromise = handleA?.renew();

      // While that write is in flight, B must NEVER see anything other than
      // "held" — neither a torn record it could mistake for corrupt, nor an
      // early swap.
      await sleep(30);
      expect(await providerB.tryAcquire("wp80-slow", { leaseMs: 5_000 })).toBeNull();
      await sleep(60);
      expect(await providerB.tryAcquire("wp80-slow", { leaseMs: 5_000 })).toBeNull();

      await renewPromise; // renew must succeed once its (slow) write lands
      expect(handleA?.record.processInstanceId).not.toBe(originalInstanceId);

      // And still held afterwards — the renewed lease is fresh.
      expect(await providerB.tryAcquire("wp80-slow", { leaseMs: 5_000 })).toBeNull();
    },
    5_000,
  );

  it(
    "a write interrupted mid-flight (torn write / simulated crash) during renew() never " +
      "corrupts the live record.json, and never lets another provider take the lock while " +
      "the original lease is still valid",
    async () => {
      const { locksDir } = await makeProvider();
      const base = path.dirname(locksDir);
      const fsA = new TornTempWriteFileSystem(new LocalFileSystem([base]));
      const fsB = new LocalFileSystem([base]);
      const providerA = new FileLockProvider(
        fsA,
        locksDir,
        new SystemClock(),
        new DeterministicRandom(201),
        "host-a",
      );
      const providerB = new FileLockProvider(
        fsB,
        locksDir,
        new SystemClock(),
        new DeterministicRandom(202),
        "host-b",
      );

      const handleA = await providerA.tryAcquire("wp80-torn", { leaseMs: 5_000 });
      expect(handleA).not.toBeNull();

      // Only sabotage the upcoming renew() — the initial acquire above must
      // land normally so there is a genuine, valid original record to
      // protect.
      fsA.armed = true;

      // The write itself is simulated as crashing mid-flight — renew() must
      // fail loudly (never silently report success while leaving a torn
      // record on disk, and never leave the live path touched at all: the
      // rename that would swap it in is never reached).
      await expect(handleA!.renew()).rejects.toThrow();

      // The live record.json must be untouched (still the ORIGINAL, valid
      // record) — proven by B still being correctly refused the lock.
      expect(await providerB.tryAcquire("wp80-torn", { leaseMs: 5_000 })).toBeNull();

      const rawRecord = JSON.parse(
        await readFile(path.join(locksDir, lockDirHash("wp80-torn"), "record.json"), "utf8"),
      ) as { processInstanceId: string };
      expect(rawRecord.processInstanceId).toBe(handleA?.record.processInstanceId);
    },
  );
});

describe("FileLockProvider — WP-80: corrupt record.json is a grace-period takeover, not an immediate one", () => {
  it("a freshly-corrupted record.json is treated like a held lock, not stale, before the grace period elapses", async () => {
    const { provider, locksDir } = await makeProvider({ corruptGraceMs: 200 });
    const lockDir = path.join(locksDir, lockDirHash("corrupt-fresh"));
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "record.json"), "{ not json");

    const handle = await provider.tryAcquire("corrupt-fresh", { leaseMs: 60_000 });
    expect(handle).toBeNull();
    // And the corrupt file must survive untouched — no premature takeover.
    await expect(readFile(path.join(lockDir, "record.json"), "utf8")).resolves.toBe("{ not json");
  });

  it("a record.json that has stayed corrupt past the grace period becomes takeover-eligible", async () => {
    const { provider, locksDir } = await makeProvider({ corruptGraceMs: 50 });
    const lockDir = path.join(locksDir, lockDirHash("corrupt-stale"));
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "record.json"), "{ not json");

    await sleep(150); // past the (short, test-only) corruption grace period

    const handle = await provider.tryAcquire("corrupt-stale", { leaseMs: 60_000 });
    expect(handle).not.toBeNull();
  });
});

// Uses the exact same primitive `FileLockProvider` hashes lock keys with, so
// tests can pre-seed a lock directory's on-disk state directly.
function lockDirHash(key: string): string {
  return sha256Hex(key);
}
