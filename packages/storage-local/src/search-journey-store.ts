/**
 * Lokale, atomare Search-Journey-Persistenz unter
 * `.untangle/product-complexity/sessions/`.
 *
 * Ein CAS-Revisionstest laeuft zusammen mit dem Schreiben unter demselben
 * pro-Session-Dateilock. So verlieren mehrere lokale Agenten keine Schritte,
 * obwohl sie dieselbe Session in getrennten Prozessen bedienen.
 */
import { Buffer } from "node:buffer";
import path from "node:path";

import {
  UntangleError,
  compareCodepoints,
  searchJourneyValidationIssue,
  type Clock,
  type FileSystemPort,
  type LockHandle,
  type LockProvider,
  type PortCallOptions,
  type Random,
  type SearchJourneyStorePort,
  type SearchJourneyV1,
} from "@untangle-code/domain";

import { assertNotAborted } from "./abort.js";
import { isNotFoundError } from "./fs-errors.js";

export const MAX_SEARCH_JOURNEY_RECORD_BYTES = 32 * 1024 * 1024;
export const MAX_SEARCH_JOURNEY_FILES = 10_000;
export const SEARCH_JOURNEY_LOCK_LEASE_MS = 30_000;
export const SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS = Math.floor(SEARCH_JOURNEY_LOCK_LEASE_MS / 3);
/**
 * Hard aggregate read budget for one report/list snapshot. Four maximum-size
 * sessions fit, so a three-session evidence cohort remains representable,
 * while one call can never intentionally retain the full 10,000-file disk cap.
 */
export const MAX_SEARCH_JOURNEY_LIST_BYTES = 128 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT_KEY = /^[0-9a-f]{64}$/u;

/**
 * Keeps one finite lock lease alive without overlapping renewal calls.
 * Commit preparation pauses the heartbeat, waits for any in-flight renewal
 * and keeps periodic scheduling stopped while the coordinated freshness gate
 * below proves every required lock immediately before an atomic publish.
 */
class RenewingLease {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private failure: unknown;
  private hasFailure = false;
  private committing = false;
  private closed = false;

  public constructor(
    private readonly handle: LockHandle,
    private readonly options: PortCallOptions | undefined,
  ) {
    this.schedule();
  }

  public get key(): string {
    return this.handle.key;
  }

  private schedule(): void {
    if (this.closed || this.committing || this.hasFailure) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.committing || this.hasFailure) return;
      const renewal = this.handle
        .renew(signalOptions(this.options))
        .catch((error: unknown) => {
          this.hasFailure = true;
          this.failure = error;
        })
        .finally(() => {
          if (this.inFlight === renewal) this.inFlight = undefined;
          this.schedule();
        });
      this.inFlight = renewal;
    }, SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS);
  }

  public async prepareForCommit(): Promise<void> {
    this.committing = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    if (this.hasFailure) throw this.failure;
  }

  public async renewForCommit(): Promise<void> {
    await this.prepareForCommit();
    const renewal = this.handle.renew(signalOptions(this.options)).catch((error: unknown) => {
      this.hasFailure = true;
      this.failure = error;
    });
    this.inFlight = renewal;
    await renewal;
    if (this.inFlight === renewal) this.inFlight = undefined;
    if (this.hasFailure) throw this.failure;
  }

  public leaseExpiresAtEpochMs(): number {
    const expiresAt = Date.parse(this.handle.record.leaseExpiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new UntangleError(
        "LOCK_HELD",
        `Lock "${this.handle.key}" has an invalid lease expiry`,
        {
          retryable: true,
          operation: "lock_renew",
          context: { key: this.handle.key, leaseExpiresAt: this.handle.record.leaseExpiresAt },
        },
      );
    }
    return expiresAt;
  }

  public async release(): Promise<void> {
    this.closed = true;
    this.committing = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    await this.handle.release();
  }
}

const MAX_COMMIT_LEASE_RENEWAL_ROUNDS = 8;

/**
 * Stops every heartbeat and establishes one overlapping freshness window for
 * all commit locks. A slow renewal may make an earlier lease stale, so only
 * the stale subset is renewed again until every lease has at least one
 * heartbeat interval left at the same instant. If the windows cannot
 * converge, publication fails closed.
 */
async function verifyLeasesForCommit(
  leases: readonly RenewingLease[],
  clock: Pick<Clock, "nowEpochMs">,
): Promise<void> {
  await Promise.all(leases.map((lease) => lease.prepareForCommit()));
  let renew = [...leases];
  for (let round = 1; round <= MAX_COMMIT_LEASE_RENEWAL_ROUNDS; round += 1) {
    await Promise.all(renew.map((lease) => lease.renewForCommit()));
    const freshnessBoundary = clock.nowEpochMs() + SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS;
    renew = leases.filter((lease) => lease.leaseExpiresAtEpochMs() < freshnessBoundary);
    if (renew.length === 0) return;
  }
  throw new UntangleError(
    "LOCK_HELD",
    "search journey commit locks could not be proven simultaneously fresh",
    {
      retryable: true,
      operation: "search_journey_lock_commit",
      context: {
        keys: leases.map((lease) => lease.key),
        minimumRemainingMs: SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS,
      },
    },
  );
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function signalOptions(options: PortCallOptions | undefined): PortCallOptions | undefined {
  return options?.signal === undefined ? undefined : { signal: options.signal };
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw new UntangleError("SEARCH_SESSION_NOT_FOUND", "invalid search journey session id", {
      operation: "search_journey_store",
      context: { sessionId },
    });
  }
}

interface SearchJourneyReadManifestEntry {
  fileName: string;
  path: string;
  sessionId: string;
  sizeBytes: number;
}

export class LocalSearchJourneyStore implements SearchJourneyStorePort {
  private readonly fingerprintKeyPath: string;

  public constructor(
    private readonly fs: FileSystemPort,
    private readonly sessionsDir: string,
    private readonly random: Random,
    private readonly locks: LockProvider,
    private readonly clock: Pick<Clock, "nowEpochMs">,
  ) {
    this.fingerprintKeyPath = path.join(path.dirname(sessionsDir), "fingerprint.key");
  }

  private pathFor(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  private async read(
    sessionId: string,
    options?: PortCallOptions,
  ): Promise<SearchJourneyV1 | null> {
    const recordPath = this.pathFor(sessionId);
    const recordStat = await this.fs.stat(recordPath, options);
    if (recordStat === null) return null;
    if (recordStat.kind !== "file" || recordStat.sizeBytes > MAX_SEARCH_JOURNEY_RECORD_BYTES) {
      throw new UntangleError("INDEX_INCOMPLETE", `search journey "${sessionId}" is corrupted`, {
        operation: "search_journey_read",
        context: {
          sessionId,
          kind: recordStat.kind,
          sizeBytes: recordStat.sizeBytes,
          maximumBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES,
        },
      });
    }
    let text: string;
    try {
      text = await this.fs.readTextFile(recordPath, options);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
    const actualBytes = Buffer.byteLength(text, "utf8");
    if (actualBytes > MAX_SEARCH_JOURNEY_RECORD_BYTES) {
      throw new UntangleError("INDEX_INCOMPLETE", `search journey "${sessionId}" is corrupted`, {
        operation: "search_journey_read",
        context: {
          sessionId,
          actualBytes,
          maximumBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES,
        },
      });
    }
    return this.parse(sessionId, text, "search_journey_read");
  }

  private parse(sessionId: string, text: string, operation: string): SearchJourneyV1 {
    try {
      const parsed: unknown = JSON.parse(text);
      const issue = searchJourneyValidationIssue(parsed);
      if (issue !== null) throw new Error(issue);
      const validated = parsed as SearchJourneyV1;
      if (validated.sessionId !== sessionId) throw new Error("session id mismatch");
      return validated;
    } catch (error) {
      throw new UntangleError("INDEX_INCOMPLETE", `search journey "${sessionId}" is corrupted`, {
        operation,
        context: { sessionId },
        cause: error,
      });
    }
  }

  /**
   * Liefert den geheimen lokalen HMAC-Schluessel fuer Journey-Fingerprints.
   * Er liegt absichtlich ausserhalb der exportierbaren Session-Datensaetze.
   */
  public async getOrCreateFingerprintKey(options?: PortCallOptions): Promise<Uint8Array> {
    assertNotAborted(options, "search_journey_fingerprint_key");
    await this.fs.mkdir(path.dirname(this.fingerprintKeyPath), {
      recursive: true,
      ...signalOptions(options),
    });
    const lock = await this.locks.acquire("search-journey:fingerprint-key", {
      ...signalOptions(options),
      leaseMs: SEARCH_JOURNEY_LOCK_LEASE_MS,
      waitMs: 5_000,
    });
    const lease = new RenewingLease(lock, options);
    try {
      try {
        const persisted = (await this.fs.readTextFile(this.fingerprintKeyPath, options)).trim();
        if (!FINGERPRINT_KEY.test(persisted)) throw new Error("invalid fingerprint key");
        return decodeHex(persisted);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw new UntangleError(
            "INDEX_INCOMPLETE",
            "search journey fingerprint key is corrupted",
            {
              operation: "search_journey_fingerprint_key",
              cause: error,
            },
          );
        }
      }

      let existingRecordCount = 0;
      try {
        existingRecordCount = (await this.fs.readDir(this.sessionsDir, options)).filter(
          (entry) => entry.kind === "file" && entry.name.endsWith(".json"),
        ).length;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      if (existingRecordCount > 0) {
        throw new UntangleError(
          "INDEX_INCOMPLETE",
          "search journey fingerprint key is missing while session records exist",
          {
            operation: "search_journey_fingerprint_key",
            context: { existingRecordCount },
          },
        );
      }

      const key = this.random.bytes(32);
      const tempPath = `${this.fingerprintKeyPath}.${this.random.uuid()}.tmp`;
      try {
        await this.fs.writeFile(tempPath, encode(hex(key)), {
          ...signalOptions(options),
          mode: 0o600,
        });
        await verifyLeasesForCommit([lease], this.clock);
        await this.fs.rename(tempPath, this.fingerprintKeyPath, options);
        return key.slice();
      } finally {
        // Cleanup deliberately ignores an aborted caller signal: otherwise
        // cancellation could strand unbounded temp bytes outside record limits.
        await this.fs.remove(tempPath).catch(() => undefined);
      }
    } finally {
      await lease.release();
    }
  }

  public async get(sessionId: string, options?: PortCallOptions): Promise<SearchJourneyV1 | null> {
    assertNotAborted(options, "search_journey_get");
    return await this.read(sessionId, options);
  }

  public async put(
    session: SearchJourneyV1,
    options: PortCallOptions & { expectedRevision: number | null },
  ): Promise<void> {
    assertNotAborted(options, "search_journey_put");
    if (options?.expectedRevision === undefined) {
      throw new UntangleError(
        "SEARCH_SESSION_INVALID_STATE",
        "search journey writes require an expected revision",
        { operation: "search_journey_put", context: { sessionId: session.sessionId } },
      );
    }
    assertSessionId(session.sessionId);
    const validationIssue = searchJourneyValidationIssue(session);
    if (validationIssue !== null) {
      throw new UntangleError(
        "SEARCH_SESSION_INVALID_STATE",
        `search journey cannot be persisted: ${validationIssue}`,
        {
          operation: "search_journey_put",
          context: { sessionId: session.sessionId, validationIssue },
        },
      );
    }
    const expected = options.expectedRevision;
    const requiredRevision = expected === null ? 0 : expected + 1;
    if (session.revision !== requiredRevision) {
      throw new UntangleError(
        "SEARCH_SESSION_INVALID_STATE",
        `search journey revision ${String(session.revision)} does not follow expected revision ${String(expected)}`,
        {
          operation: "search_journey_put",
          context: {
            sessionId: session.sessionId,
            expectedRevision: expected,
            suppliedRevision: session.revision,
            requiredRevision,
          },
        },
      );
    }
    const body = JSON.stringify(session);
    const bytes = encode(body);
    if (bytes.byteLength > MAX_SEARCH_JOURNEY_RECORD_BYTES) {
      throw new UntangleError(
        "SEARCH_SESSION_INVALID_STATE",
        `search journey exceeds the ${String(MAX_SEARCH_JOURNEY_RECORD_BYTES)} byte record limit`,
        {
          operation: "search_journey_put",
          context: { sessionId: session.sessionId, byteLength: bytes.byteLength },
        },
      );
    }

    await this.fs.mkdir(this.sessionsDir, { recursive: true, ...signalOptions(options) });
    const creationLock =
      expected === null
        ? await this.locks.acquire("search-journey:create", {
            ...signalOptions(options),
            leaseMs: SEARCH_JOURNEY_LOCK_LEASE_MS,
            waitMs: 5_000,
          })
        : null;
    const creationLease = creationLock === null ? null : new RenewingLease(creationLock, options);
    try {
      const lock = await this.locks.acquire(`search-journey:${session.sessionId}`, {
        ...signalOptions(options),
        leaseMs: SEARCH_JOURNEY_LOCK_LEASE_MS,
        waitMs: 5_000,
      });
      const lease = new RenewingLease(lock, options);
      try {
        const current = await this.read(session.sessionId, options);
        const conflict = expected === null ? current !== null : current?.revision !== expected;
        if (conflict) {
          throw new UntangleError(
            "SEARCH_SESSION_CONFLICT",
            `search journey "${session.sessionId}" changed concurrently`,
            {
              retryable: true,
              operation: "search_journey_put",
              context: {
                sessionId: session.sessionId,
                expectedRevision: expected,
                actualRevision: current?.revision ?? null,
              },
            },
          );
        }
        if (expected === null) {
          const recordCount = (await this.fs.readDir(this.sessionsDir, options)).filter(
            (entry) => entry.kind === "file" && entry.name.endsWith(".json"),
          ).length;
          if (recordCount >= MAX_SEARCH_JOURNEY_FILES) {
            throw new UntangleError(
              "SEARCH_SESSION_INVALID_STATE",
              `search journey store reached its limit of ${String(MAX_SEARCH_JOURNEY_FILES)} records`,
              {
                operation: "search_journey_put",
                context: { recordCount },
              },
            );
          }
        }
        const finalPath = this.pathFor(session.sessionId);
        const tempPath = `${finalPath}.${this.random.uuid()}.tmp`;
        try {
          await this.fs.writeFile(tempPath, bytes, {
            ...signalOptions(options),
            mode: 0o600,
          });
          await verifyLeasesForCommit(
            creationLease === null ? [lease] : [creationLease, lease],
            this.clock,
          );
          await this.fs.rename(tempPath, finalPath, options);
        } finally {
          await this.fs.remove(tempPath).catch(() => undefined);
        }
      } finally {
        await lease.release();
      }
    } finally {
      await creationLease?.release();
    }
  }

  public async list(workspaceId: string, options?: PortCallOptions): Promise<SearchJourneyV1[]> {
    assertNotAborted(options, "search_journey_list");
    try {
      const stat = await this.fs.stat(this.sessionsDir, options);
      if (stat === null) return [];
      const entries = (await this.fs.readDir(this.sessionsDir, options))
        .filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"))
        .sort((left, right) => compareCodepoints(left.name, right.name));
      if (entries.length > MAX_SEARCH_JOURNEY_FILES) {
        throw new UntangleError(
          "SEARCH_SESSION_INVALID_STATE",
          `search journey store contains ${String(entries.length)} records; limit is ${String(MAX_SEARCH_JOURNEY_FILES)}`,
          { operation: "search_journey_list", context: { recordCount: entries.length } },
        );
      }
      const manifest: SearchJourneyReadManifestEntry[] = [];
      let aggregateBytes = 0;
      for (const entry of entries) {
        assertNotAborted(options, "search_journey_list_budget");
        const sessionId = entry.name.slice(0, -".json".length);
        const recordPath = this.pathFor(sessionId);
        const entryStat = await this.fs.stat(recordPath, options);
        if (entryStat === null) {
          throw new UntangleError(
            "SEARCH_SESSION_CONFLICT",
            `search journey record "${entry.name}" disappeared during snapshot preflight`,
            {
              operation: "search_journey_list",
              retryable: true,
              context: { fileName: entry.name, phase: "preflight" },
            },
          );
        }
        if (entryStat.kind !== "file" || entryStat.sizeBytes > MAX_SEARCH_JOURNEY_RECORD_BYTES) {
          throw new UntangleError(
            "INDEX_INCOMPLETE",
            `search journey record "${entry.name}" is corrupted`,
            {
              operation: "search_journey_list",
              context: {
                fileName: entry.name,
                kind: entryStat.kind,
                sizeBytes: entryStat.sizeBytes,
                maximumRecordBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES,
              },
            },
          );
        }
        manifest.push({
          fileName: entry.name,
          path: recordPath,
          sessionId,
          sizeBytes: entryStat.sizeBytes,
        });
        aggregateBytes += entryStat.sizeBytes;
        if (aggregateBytes > MAX_SEARCH_JOURNEY_LIST_BYTES) {
          throw new UntangleError(
            "SEARCH_SESSION_INVALID_STATE",
            `search journey snapshot exceeds the ${String(MAX_SEARCH_JOURNEY_LIST_BYTES)} byte aggregate read limit`,
            {
              operation: "search_journey_list",
              context: {
                recordCount: entries.length,
                aggregateBytes,
                maximumBytes: MAX_SEARCH_JOURNEY_LIST_BYTES,
              },
            },
          );
        }
      }
      const sessions: SearchJourneyV1[] = [];
      let actualAggregateBytes = 0;
      for (const entry of manifest) {
        assertNotAborted(options, "search_journey_list_read");
        let text: string;
        try {
          text = await this.fs.readTextFile(entry.path, options);
        } catch (error) {
          if (isNotFoundError(error)) {
            throw new UntangleError(
              "SEARCH_SESSION_CONFLICT",
              `search journey record "${entry.fileName}" disappeared during snapshot read`,
              {
                operation: "search_journey_list",
                retryable: true,
                context: { fileName: entry.fileName, phase: "read" },
                cause: error,
              },
            );
          }
          throw error;
        }
        const actualBytes = Buffer.byteLength(text, "utf8");
        if (actualBytes > MAX_SEARCH_JOURNEY_RECORD_BYTES) {
          throw new UntangleError(
            "INDEX_INCOMPLETE",
            `search journey record "${entry.fileName}" exceeds its byte limit during snapshot read`,
            {
              operation: "search_journey_list",
              context: {
                fileName: entry.fileName,
                actualBytes,
                maximumRecordBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES,
              },
            },
          );
        }
        actualAggregateBytes += actualBytes;
        if (actualAggregateBytes > MAX_SEARCH_JOURNEY_LIST_BYTES) {
          throw new UntangleError(
            "SEARCH_SESSION_INVALID_STATE",
            `search journey snapshot exceeds the ${String(MAX_SEARCH_JOURNEY_LIST_BYTES)} byte aggregate read limit`,
            {
              operation: "search_journey_list",
              context: {
                recordCount: manifest.length,
                aggregateBytes: actualAggregateBytes,
                maximumBytes: MAX_SEARCH_JOURNEY_LIST_BYTES,
                phase: "read",
              },
            },
          );
        }
        const postReadStat = await this.fs.stat(entry.path, options);
        if (
          postReadStat === null ||
          postReadStat.kind !== "file" ||
          postReadStat.sizeBytes !== entry.sizeBytes ||
          actualBytes !== entry.sizeBytes
        ) {
          throw new UntangleError(
            "SEARCH_SESSION_CONFLICT",
            `search journey record "${entry.fileName}" changed during snapshot read`,
            {
              operation: "search_journey_list",
              retryable: true,
              context: {
                fileName: entry.fileName,
                phase: "post-read",
                expectedBytes: entry.sizeBytes,
                actualBytes,
                observedBytes: postReadStat?.sizeBytes ?? null,
                observedKind: postReadStat?.kind ?? "missing",
              },
            },
          );
        }
        const session = this.parse(entry.sessionId, text, "search_journey_list");
        if (session.workspaceId === workspaceId) sessions.push(session);
      }
      return sessions.sort(
        (left, right) =>
          compareCodepoints(left.createdAt, right.createdAt) ||
          compareCodepoints(left.sessionId, right.sessionId),
      );
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }
}
