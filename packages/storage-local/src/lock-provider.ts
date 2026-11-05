/**
 * File-based `LockProvider` (architecture.md §21.1–§21.2; docs/BUILD_PLAN.md
 * WP-12 acceptance criteria).
 *
 * One lock = one directory named `sha256(key)` under the configured locks
 * root, containing a single `record.json`. `FileSystemPort.mkdir` without
 * `recursive` is the exclusivity primitive: Node's `mkdir` atomically fails
 * with `EEXIST` when the directory already exists, so "did I just create the
 * directory" is a genuine, OS-atomic exclusive-acquire test — no separate
 * locking mechanism is layered on top of it.
 *
 * Stale-lease takeover (an expired holder's lock being stolen) is NOT fully
 * race-free across processes with plain directory operations — see README
 * "Entscheidungen" for the exact, documented race window and why it is an
 * acceptable MVP tradeoff (architecture.md §21.2 explicitly scopes file
 * locks to MVP; "Remote Team Mode" gets a real distributed lease). What IS
 * fully race-free, because it needs no takeover step at all, is contention
 * over a lock nobody holds yet — the common case, and the one this file's
 * own "two providers race for the same lock" test exercises.
 *
 * `record.json` itself is written temp-file-then-rename (mirroring
 * `checkpoint-store.ts`'s "every write is temp-file-then-rename" in this
 * same package) — never by a direct `writeFile` onto the live path. A
 * reader can therefore never observe a half-written record: the file on
 * disk is always either the previous good record or the fully-formed new
 * one, whether the write is happening on the initial `tryAcquire()` or on
 * `renew()`. Before this, a reader racing a writer could see a torn record,
 * fail to parse it, and — because "corrupt" was treated as immediately
 * takeover-eligible — steal a lock that was still validly held (WP-80).
 * See `DEFAULT_CORRUPT_GRACE_MS`'s doc comment and README "Entscheidungen"
 * for how a *genuinely* corrupt record (external tampering, disk fault —
 * atomic rename rules out "caught mid-write") is now handled instead.
 */
import * as os from "node:os";
import * as nodePath from "node:path";

import type {
  Clock,
  FileSystemPort,
  LockHandle,
  LockProvider,
  LockRecordV1,
  PortCallOptions,
  Random,
} from "@untangle-code/domain";
import { sha256Hex, UntangleError } from "@untangle-code/domain";

import { assertNotAborted } from "./abort.js";
import { isAlreadyExistsError, isNotFoundError } from "./fs-errors.js";
import { realNowEpochMs } from "./real-time.js";

const DEFAULT_LEASE_MS = 30_000;
const POLL_INTERVAL_MS = 20;
const RECORD_FILE_NAME = "record.json";
/** Bounds the stale-takeover retry loop so pathological contention returns
 * "held" rather than spinning forever. */
const MAX_TAKEOVER_ATTEMPTS = 16;
/**
 * How long a `record.json` that fails to parse must sit untouched (by
 * mtime) before this provider will treat it as takeover-eligible.
 *
 * Every `record.json` write is now temp-file-then-rename (see the file doc
 * comment), so a reader can no longer see a half-written record — the file
 * on disk is always either the previous good record or the new one, never
 * a torn mix of both. That removes the one legitimate reason the old code
 * had for treating "corrupt" as an automatic, immediate takeover signal.
 * What remains, once "caught mid-write" is off the table, is a genuinely
 * unparsable file: a manual edit, a disk fault, a record written by some
 * future/incompatible format. That is an error condition, not a routine
 * lifecycle state — and unlike an expired lease (which carries its own
 * trustworthy `leaseExpiresAt`), a corrupt record carries no information at
 * all about how long ago it stopped being valid. Immediately stealing it
 * would repeat exactly the WP-80 mistake (treating "I can't explain this" as
 * "safe to take"), just with a different root cause.
 *
 * The chosen policy (documented in README "Entscheidungen"): require a
 * conservative grace period — much longer than any expected lease or write
 * latency — to pass since the file's own last-modified time before a corrupt
 * record becomes takeover-eligible, exactly like an expired lease. Until
 * then `tryAcquire()` treats it like a held lock (returns `null`), never
 * throwing and never stealing. This self-heals without an operator having
 * to intervene, while giving any in-flight (however slow) legitimate write
 * — or a human investigating — a wide window to land or act first.
 */
const DEFAULT_CORRUPT_GRACE_MS = 5 * 60_000;

/**
 * On-disk shape: the exact public `LockRecordV1` plus a diagnostic field
 * architecture.md §21.2 also asks the record to carry ("Startzeit" — process
 * start time). It is NOT part of domain's `LockRecordV1` (that shape is
 * pinned by the port contract and never used for staleness — see the file
 * doc comment: lease expiry alone decides staleness), so it never appears on
 * `LockHandle.record`; it exists purely for a human or another tool
 * inspecting `record.json` on disk to see which OS process wrote it.
 */
interface PersistedLockRecord extends LockRecordV1 {
  processStartedAtEpochMs: number;
}

type RecordReadState =
  | { kind: "absent" }
  /** `mtimeEpochMs` backs the corruption grace period — see
   * `DEFAULT_CORRUPT_GRACE_MS`'s doc comment. */
  | { kind: "corrupt"; mtimeEpochMs: number }
  | { kind: "valid"; record: PersistedLockRecord };

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toPublicRecord(record: PersistedLockRecord): LockRecordV1 {
  return {
    key: record.key,
    pid: record.pid,
    processInstanceId: record.processInstanceId,
    host: record.host,
    acquiredAt: record.acquiredAt,
    leaseExpiresAt: record.leaseExpiresAt,
  };
}

/** File-based `LockProvider` rooted at one `locks/` directory. */
export class FileLockProvider implements LockProvider {
  private readonly host: string;
  /** Set once `locksDir` is known to exist, to skip a redundant `mkdir` on
   * every `tryAcquire()` call — real disk I/O is not free, and the lease
   * contract tests run with tight (double-digit millisecond) timing
   * margins that a spurious extra round trip can eat into. */
  private locksDirEnsured = false;
  private readonly corruptGraceMs: number;

  public constructor(
    private readonly fs: FileSystemPort,
    private readonly locksDir: string,
    private readonly clock: Clock,
    private readonly random: Random,
    host?: string,
    /** Overrides `DEFAULT_CORRUPT_GRACE_MS` — exposed mainly so tests can
     * exercise the grace-period boundary without a real multi-minute wait. */
    corruptGraceMs?: number,
  ) {
    this.host = host ?? os.hostname();
    this.corruptGraceMs = corruptGraceMs ?? DEFAULT_CORRUPT_GRACE_MS;
  }

  private lockDirFor(key: string): string {
    return nodePath.join(this.locksDir, sha256Hex(key));
  }

  private recordPathFor(lockDir: string): string {
    return nodePath.join(lockDir, RECORD_FILE_NAME);
  }

  private isExpired(record: LockRecordV1, nowEpochMs: number): boolean {
    return Date.parse(record.leaseExpiresAt) <= nowEpochMs;
  }

  private buildRecord(key: string, leaseMs: number): PersistedLockRecord {
    const nowMs = this.clock.nowEpochMs();
    return {
      key,
      pid: process.pid,
      processInstanceId: this.random.uuid(),
      host: this.host,
      acquiredAt: this.clock.nowIso(),
      leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
      processStartedAtEpochMs: Math.round(nowMs - process.uptime() * 1000),
    };
  }

  /**
   * Reads the current state of a lock directory:
   * - `"absent"` — the directory (or its `record.json`) does not exist yet,
   *   INCLUDING the tiny window where a concurrent winner's `mkdir` has
   *   landed but its `record.json` write has not — that window is treated as
   *   "busy", never as stale, so it can never be mistaken for a takeover
   *   opportunity (that would break exclusivity for the very case the
   *   directory-mkdir primitive exists to make airtight);
   * - `"corrupt"` — `record.json` exists but does not parse. Because every
   *   write goes through temp-file-then-rename (see the file doc comment),
   *   this can no longer be an in-flight write caught mid-write — it is a
   *   genuine anomaly. The caller still has to check `mtimeEpochMs` against
   *   the corruption grace period before treating it as takeover-eligible
   *   (see `DEFAULT_CORRUPT_GRACE_MS`) — corrupt is NOT auto-stale;
   * - `"valid"` — a well-formed record, which the caller still has to check
   *   for lease expiry itself.
   */
  private async readRecordState(
    lockDir: string,
    options?: PortCallOptions,
  ): Promise<RecordReadState> {
    const recordPath = this.recordPathFor(lockDir);
    let text: string;
    try {
      text = await this.fs.readTextFile(recordPath, options);
    } catch (error) {
      if (isNotFoundError(error)) {
        return { kind: "absent" };
      }
      throw error;
    }
    try {
      return { kind: "valid", record: JSON.parse(text) as PersistedLockRecord };
    } catch {
      // `record.json` exists (the readTextFile above succeeded) but does not
      // parse — stat it for the corruption-grace-period check. A `null`
      // stat here means a concurrent takeover removed it between our read
      // and this stat; fall back to "now" so that race resolves toward
      // "not yet eligible" rather than throwing on a missing file.
      const stat = await this.fs.stat(recordPath, options);
      return { kind: "corrupt", mtimeEpochMs: stat?.mtimeEpochMs ?? this.clock.nowEpochMs() };
    }
  }

  private isCorruptGraceElapsed(mtimeEpochMs: number, nowEpochMs: number): boolean {
    return nowEpochMs - mtimeEpochMs >= this.corruptGraceMs;
  }

  /**
   * Writes `record.json` atomically — temp file, then a single `rename` onto
   * the live path — mirroring `checkpoint-store.ts`'s `writeAtomic` in this
   * same package. Used by both the initial `tryAcquire()` write and every
   * `renew()`, so a reader can never observe a half-written record (WP-80).
   */
  private async writeRecordAtomic(
    lockDir: string,
    record: PersistedLockRecord,
    options?: PortCallOptions,
  ): Promise<void> {
    const finalPath = this.recordPathFor(lockDir);
    const tempPath = `${finalPath}.${this.random.uuid()}.tmp`;
    await this.fs.writeFile(tempPath, encode(JSON.stringify(record)), options);
    await this.fs.rename(tempPath, finalPath, options);
  }

  private makeHandle(lockDir: string, record: PersistedLockRecord, leaseMs: number): LockHandle {
    let current = record;
    return {
      get key() {
        return current.key;
      },
      get record() {
        return toPublicRecord(current);
      },
      renew: async (options?: PortCallOptions): Promise<void> => {
        assertNotAborted(options, "lock_renew");
        const state = await this.readRecordState(lockDir, options);
        if (
          state.kind !== "valid" ||
          state.record.processInstanceId !== current.processInstanceId
        ) {
          throw new UntangleError("LOCK_HELD", `Lock "${current.key}" was lost before renew`, {
            operation: "lock_renew",
            context: { key: current.key },
          });
        }
        const renewed = this.buildRecord(current.key, leaseMs);
        await this.writeRecordAtomic(lockDir, renewed, options);
        current = renewed;
      },
      release: async (): Promise<void> => {
        const state = await this.readRecordState(lockDir);
        if (
          state.kind === "valid" &&
          state.record.processInstanceId === current.processInstanceId
        ) {
          await this.fs.remove(lockDir, { recursive: true });
        }
        // Otherwise: this handle already lost the lock to another holder —
        // a safe no-op, never removing the new holder's directory.
      },
    };
  }

  public async tryAcquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number },
  ): Promise<LockHandle | null> {
    assertNotAborted(options, "lock_try_acquire");
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const lockDir = this.lockDirFor(key);
    const mkdirOptions = options?.signal ? { signal: options.signal } : undefined;

    // Lets this provider be used before any explicit `ensureStateDirLayout()`
    // call (e.g. in a focused unit test) — but only paid once per instance
    // (see `locksDirEnsured`'s doc comment).
    if (!this.locksDirEnsured) {
      await this.fs.mkdir(this.locksDir, { recursive: true, ...mkdirOptions });
      this.locksDirEnsured = true;
    }

    for (let attempt = 0; attempt < MAX_TAKEOVER_ATTEMPTS; attempt += 1) {
      assertNotAborted(options, "lock_try_acquire");
      try {
        await this.fs.mkdir(lockDir, mkdirOptions);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
        const state = await this.readRecordState(lockDir, options);
        if (state.kind === "absent") {
          // Someone else's mkdir landed but their record.json has not yet —
          // busy, not stale. Report "held" rather than racing to remove a
          // directory that is mid-creation by its legitimate owner.
          return null;
        }
        if (state.kind === "valid" && !this.isExpired(state.record, this.clock.nowEpochMs())) {
          return null; // genuinely held
        }
        if (
          state.kind === "corrupt" &&
          !this.isCorruptGraceElapsed(state.mtimeEpochMs, this.clock.nowEpochMs())
        ) {
          // Unparsable, but too recently modified to trust as abandoned —
          // could still be a legitimate (if unusually slow) in-flight write,
          // or fresh external damage nobody has had a chance to react to
          // yet. Treat exactly like "genuinely held": never steal it before
          // the corruption grace period elapses (see
          // `DEFAULT_CORRUPT_GRACE_MS`; this is the WP-80 fix).
          return null;
        }
        // Either a really-expired lease, or a record.json that has stayed
        // unparsable for longer than the corruption grace period: attempt
        // takeover by removing the stale directory, then race for mkdir
        // again from the top of the loop.
        try {
          await this.fs.remove(lockDir, { recursive: true, ...mkdirOptions });
        } catch (removeError) {
          if (!isNotFoundError(removeError)) {
            throw removeError;
          }
          // Someone else already removed it — loop back and race for mkdir.
        }
        continue;
      }
      // Our mkdir won: we are the exclusive owner of a brand-new directory.
      const record = this.buildRecord(key, leaseMs);
      await this.writeRecordAtomic(lockDir, record, options);
      return this.makeHandle(lockDir, record, leaseMs);
    }
    return null;
  }

  public async acquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number; waitMs?: number },
  ): Promise<LockHandle> {
    const waitMs = options?.waitMs ?? 0;
    // Bounded by REAL elapsed time, not the injected `Clock` — see
    // `real-time.ts` for why (mirrors `InMemoryLockProvider`'s identical
    // reasoning in `@untangle-code/testkit`).
    const startedAtRealMs = realNowEpochMs();
    for (;;) {
      const handle = await this.tryAcquire(key, options);
      if (handle) {
        return handle;
      }
      const elapsedRealMs = realNowEpochMs() - startedAtRealMs;
      if (elapsedRealMs >= waitMs) {
        throw new UntangleError("LOCK_HELD", `Lock "${key}" is held`, {
          operation: "lock_acquire",
          retryable: true,
          context: { key },
        });
      }
      assertNotAborted(options, "lock_acquire");
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_INTERVAL_MS, waitMs - elapsedRealMs)),
      );
    }
  }

  public async inspect(key: string, options?: PortCallOptions): Promise<LockRecordV1 | null> {
    assertNotAborted(options, "lock_inspect");
    const state = await this.readRecordState(this.lockDirFor(key), options);
    if (state.kind !== "valid" || this.isExpired(state.record, this.clock.nowEpochMs())) {
      return null;
    }
    return toPublicRecord(state.record);
  }
}
