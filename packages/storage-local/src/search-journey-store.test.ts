import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  DirEntryV1,
  DynamicSearchComplexityV1,
  FileStatV1,
  LockHandle,
  PortCallOptions,
  SearchJourneyV1,
} from "@untangle-code/domain";
import {
  DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID,
  MAX_SEARCH_JOURNEY_TEXT_LENGTH,
  UntangleError,
  canonicalJson,
  sha256Hex,
} from "@untangle-code/domain";
import { DeterministicRandom, FakeClock, InMemoryLockProvider } from "@untangle-code/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalFileSystem } from "./local-file-system.js";
import {
  MAX_SEARCH_JOURNEY_FILES,
  MAX_SEARCH_JOURNEY_LIST_BYTES,
  MAX_SEARCH_JOURNEY_RECORD_BYTES,
  SEARCH_JOURNEY_LOCK_LEASE_MS,
  SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS,
  LocalSearchJourneyStore,
} from "./search-journey-store.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function session(overrides: Partial<SearchJourneyV1> = {}): SearchJourneyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId: SESSION_ID,
    workspaceId: "ws-a",
    status: "active",
    recordingConsent: "explicit",
    retainText: false,
    goal: { fingerprint: "a".repeat(64) },
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    attempts: [],
    navigation: [],
    ...overrides,
  };
}

const ACCEPTED_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const LATER_ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const RANKING_CONTEXT_FINGERPRINT = "d".repeat(64);
const MEASUREMENT_CONTEXT_ID = sha256Hex(
  canonicalJson({
    rankers: ["ranker-v1"],
    profiles: ["profile-v1\u001fgeneration-v1"],
    rankingContexts: [RANKING_CONTEXT_FINGERPRINT],
    limits: ["10\u001f20"],
  }),
);

function acceptedAssessment(): DynamicSearchComplexityV1 {
  return {
    schemaVersion: 1,
    algorithm: DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID,
    isHeuristic: true,
    searchesToTarget: 1,
    successfulSearchesToTarget: 1,
    failedSearchesToTarget: 0,
    distinctQueryCount: 1,
    queryReformulations: 0,
    acceptedTargetRank: 1,
    reciprocalRank: 1,
    targetWasReturned: true,
    targetFirstReturnedAtSearch: 1,
    targetAcceptedAtSearch: 1,
    selectionLagSearches: 0,
    directHit: true,
    eligibleCandidatesExamined: 1,
    uniqueCandidatesExposed: 1,
    uniqueFilesExposed: 1,
    navigationEventsToTarget: 0,
    observedToolAndFileHops: 1,
    meanCandidateFileDispersion: 0,
    meanCandidateChurn: null,
    candidateLimitHitRate: 0,
    healthyRetrievalRate: 1,
    acceptedTargetScoreMargin: null,
    measurementContextId: MEASUREMENT_CONTEXT_ID,
    measurementContextComplete: true,
    caveats: [],
  };
}

function repeatedTargetAttempt(
  attemptId: string,
  sequence: number,
  clientStep: number,
  observedAt: string,
  queryFingerprint: string,
): SearchJourneyV1["attempts"][number] {
  return {
    attemptId,
    sequence,
    clientStep,
    observationFingerprint: sequence === 1 ? "b".repeat(64) : "e".repeat(64),
    queryFingerprint,
    rankerVersion: "ranker-v1",
    rankingContextFingerprint: RANKING_CONTEXT_FINGERPRINT,
    resultLimit: 10,
    candidateLimit: 20,
    observedAt,
    status: "succeeded",
    warningCodes: [],
    retrievalHealthy: true,
    profiles: [
      {
        embeddingProfileId: "profile-v1",
        indexGenerations: ["generation-v1"],
        retrievalPerformed: true,
        retrieval: {
          branchCandidateCounts: { dense: 1, sparse: 1, symbol: 0 },
          uniqueRetrievedCandidateCount: 1,
          eligibleCandidateCount: 1,
          rankedCandidateCount: 1,
          deduplicatedCandidateCount: 1,
          qualifiedHitCount: 1,
          returnedHitCount: 1,
          uniqueEligibleFileCount: 1,
          uniqueEligibleSymbolCount: 1,
          eligibleFileDispersion: 0,
          topScoreGap: null,
          candidateLimitReached: false,
        },
        candidates: [
          {
            repoId: "repo-a",
            refId: "ref-main",
            filePath: sequence === 1 ? "src/accepted.ts" : "src/later.ts",
            chunkId: "target",
            symbolId: "symbol:target",
            embeddingProfileId: "profile-v1",
            indexGeneration: "generation-v1",
            rank: 1,
            score: sequence === 1 ? 0.94 : 0.72,
          },
        ],
      },
    ],
  };
}

function completedRepeatedTargetSession(): SearchJourneyV1 {
  return session({
    status: "completed",
    updatedAt: "2026-09-06T10:00:03.000Z",
    attempts: [
      repeatedTargetAttempt(ACCEPTED_ATTEMPT_ID, 1, 1, "2026-09-06T10:00:02.000Z", "c".repeat(64)),
      repeatedTargetAttempt(LATER_ATTEMPT_ID, 2, 2, "2026-09-06T10:00:01.000Z", "f".repeat(64)),
    ],
    outcome: {
      kind: "completed",
      completedAt: "2026-09-06T10:00:03.000Z",
      target: { chunkId: "target" },
      acceptedAttemptId: ACCEPTED_ATTEMPT_ID,
      assessment: acceptedAssessment(),
    },
  });
}

class SaturatedFileSystem extends LocalFileSystem {
  public constructor(
    roots: readonly string[],
    private readonly saturatedDirectory: string,
  ) {
    super(roots);
  }

  public override readDir(directory: string, options?: PortCallOptions): Promise<DirEntryV1[]> {
    if (directory !== this.saturatedDirectory) return super.readDir(directory, options);
    return Promise.resolve(
      Array.from({ length: MAX_SEARCH_JOURNEY_FILES }, (_, index) => ({
        name: `${String(index).padStart(5, "0")}.json`,
        path: path.join(directory, `${String(index).padStart(5, "0")}.json`),
        kind: "file" as const,
      })),
    );
  }
}

class OversizedFileSystem extends LocalFileSystem {
  public constructor(
    roots: readonly string[],
    private readonly oversizedPath: string,
  ) {
    super(roots);
  }

  public override stat(file: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    if (file !== this.oversizedPath) return super.stat(file, options);
    return Promise.resolve({
      path: file,
      sizeBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES + 1,
      mtimeEpochMs: 0,
      kind: "file",
    });
  }

  public override readTextFile(file: string, options?: PortCallOptions): Promise<string> {
    if (file === this.oversizedPath) {
      return Promise.reject(new Error("oversized journey must be rejected before it is read"));
    }
    return super.readTextFile(file, options);
  }
}

class ChangedDuringReadFileSystem extends LocalFileSystem {
  public constructor(
    roots: readonly string[],
    private readonly changedPath: string,
  ) {
    super(roots);
  }

  public override async readTextFile(file: string, options?: PortCallOptions): Promise<string> {
    const text = await super.readTextFile(file, options);
    return file === this.changedPath ? `${text} ` : text;
  }
}

class DisappearingDuringReadFileSystem extends LocalFileSystem {
  public constructor(
    roots: readonly string[],
    private readonly disappearingPath: string,
  ) {
    super(roots);
  }

  public override readTextFile(file: string, options?: PortCallOptions): Promise<string> {
    if (file === this.disappearingPath) {
      return Promise.reject(Object.assign(new Error("record disappeared"), { code: "ENOENT" }));
    }
    return super.readTextFile(file, options);
  }
}

class OversizedDuringReadFileSystem extends LocalFileSystem {
  public constructor(
    roots: readonly string[],
    private readonly growingPath: string,
  ) {
    super(roots);
  }

  public override readTextFile(file: string, options?: PortCallOptions): Promise<string> {
    if (file === this.growingPath) {
      return Promise.resolve("x".repeat(MAX_SEARCH_JOURNEY_RECORD_BYTES + 1));
    }
    return super.readTextFile(file, options);
  }
}

class AggregateOversizedFileSystem extends LocalFileSystem {
  private readonly recordNames = Array.from(
    { length: 5 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}.json`,
  );
  private readonly recordBytes = Math.floor(MAX_SEARCH_JOURNEY_LIST_BYTES / 5) + 1;

  public constructor(
    roots: readonly string[],
    private readonly aggregateDirectory: string,
  ) {
    super(roots);
  }

  public override readDir(directory: string, options?: PortCallOptions): Promise<DirEntryV1[]> {
    if (directory !== this.aggregateDirectory) return super.readDir(directory, options);
    return Promise.resolve(
      this.recordNames.map((name) => ({
        name,
        path: path.join(directory, name),
        kind: "file" as const,
      })),
    );
  }

  public override stat(file: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    if (!this.recordNames.some((name) => file === path.join(this.aggregateDirectory, name))) {
      return super.stat(file, options);
    }
    return Promise.resolve({
      path: file,
      sizeBytes: this.recordBytes,
      mtimeEpochMs: 0,
      kind: "file",
    });
  }

  public override readTextFile(file: string, options?: PortCallOptions): Promise<string> {
    if (this.recordNames.some((name) => file === path.join(this.aggregateDirectory, name))) {
      return Promise.reject(new Error("aggregate budget must be rejected before any record read"));
    }
    return super.readTextFile(file, options);
  }
}

class FailingAtomicFileSystem extends LocalFileSystem {
  public constructor(
    roots: readonly string[],
    private readonly failurePoint: "write" | "rename",
  ) {
    super(roots);
  }

  public override async writeFile(
    file: string,
    data: Uint8Array,
    options?: Parameters<LocalFileSystem["writeFile"]>[2],
  ): Promise<void> {
    await super.writeFile(file, data, options);
    if (this.failurePoint === "write" && file.endsWith(".tmp")) {
      throw new Error("injected write failure after creating temp file");
    }
  }

  public override rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    if (this.failurePoint === "rename" && from.endsWith(".tmp")) {
      return Promise.reject(new Error("injected rename failure"));
    }
    return super.rename(from, to, options);
  }
}

class SlowAtomicFileSystem extends LocalFileSystem {
  public readonly writeStarted: Promise<void>;
  private signalWriteStarted: (() => void) | undefined;
  private delayed = false;

  public constructor(
    roots: readonly string[],
    private readonly delayMs: number,
  ) {
    super(roots);
    this.writeStarted = new Promise((resolve) => {
      this.signalWriteStarted = resolve;
    });
  }

  public override async writeFile(
    file: string,
    data: Uint8Array,
    options?: Parameters<LocalFileSystem["writeFile"]>[2],
  ): Promise<void> {
    if (!this.delayed && file.endsWith(".tmp")) {
      this.delayed = true;
      this.signalWriteStarted?.();
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    await super.writeFile(file, data, options);
  }
}

class RejectingRenewLockProvider extends InMemoryLockProvider {
  public override async acquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number; waitMs?: number },
  ): Promise<LockHandle> {
    const handle = await super.acquire(key, options);
    return {
      get key() {
        return handle.key;
      },
      get record() {
        return handle.record;
      },
      renew: () =>
        Promise.reject(
          new UntangleError("LOCK_HELD", `Lock "${key}" was lost before renew`, {
            operation: "lock_renew",
            context: { key },
          }),
        ),
      release: () => handle.release(),
    };
  }
}

class AsymmetricRenewLockProvider extends InMemoryLockProvider {
  public creationRenewals = 0;
  public sessionRenewals = 0;

  public constructor(
    private readonly logicalClock: FakeClock,
    random: DeterministicRandom,
  ) {
    super(logicalClock, random);
  }

  public override async acquire(
    key: string,
    options?: PortCallOptions & { leaseMs?: number; waitMs?: number },
  ): Promise<LockHandle> {
    const handle = await super.acquire(key, options);
    return {
      get key() {
        return handle.key;
      },
      get record() {
        return handle.record;
      },
      renew: async (renewOptions?: PortCallOptions) => {
        if (key === "search-journey:create") {
          this.creationRenewals += 1;
        } else if (key === `search-journey:${SESSION_ID}`) {
          this.sessionRenewals += 1;
          if (this.sessionRenewals === 1) {
            this.logicalClock.advance(SEARCH_JOURNEY_LOCK_LEASE_MS + 1);
          }
        }
        await handle.renew(renewOptions);
      },
      release: () => handle.release(),
    };
  }
}

class BeforeSessionPublishFileSystem extends LocalFileSystem {
  public constructor(
    roots: readonly string[],
    private readonly beforePublish: () => Promise<void>,
  ) {
    super(roots);
  }

  public override async rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    if (to.endsWith(`${SESSION_ID}.json`)) await this.beforePublish();
    await super.rename(from, to, options);
  }
}

describe("LocalSearchJourneyStore", () => {
  let base: string;
  let sessionsDir: string;
  let fs: LocalFileSystem;
  let store: LocalSearchJourneyStore;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-search-journeys-"));
    sessionsDir = path.join(base, ".untangle", "product-complexity", "sessions");
    fs = new LocalFileSystem([base]);
    store = new LocalSearchJourneyStore(
      fs,
      sessionsDir,
      new DeterministicRandom(11),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(12)),
      new FakeClock(0),
    );
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("persists a session across a completely new store instance", async () => {
    const original = session();
    await store.put(original, { expectedRevision: null });

    if (process.platform !== "win32") {
      const recordStat = await stat(path.join(sessionsDir, `${SESSION_ID}.json`));
      expect(recordStat.mode & 0o777).toBe(0o600);
    }

    const reopened = new LocalSearchJourneyStore(
      new LocalFileSystem([base]),
      sessionsDir,
      new DeterministicRandom(21),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(22)),
      new FakeClock(0),
    );
    await expect(reopened.get(SESSION_ID)).resolves.toEqual(original);
    await expect(reopened.list("ws-a")).resolves.toEqual([original]);
    await expect(reopened.list("another-workspace")).resolves.toEqual([]);
  });

  it("round-trips explicit accepted-attempt provenance and still reads its legacy omission", async () => {
    const completed = completedRepeatedTargetSession();
    await store.put(completed, { expectedRevision: null });

    const reopened = new LocalSearchJourneyStore(
      new LocalFileSystem([base]),
      sessionsDir,
      new DeterministicRandom(21),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(22)),
      new FakeClock(0),
    );
    await expect(reopened.get(SESSION_ID)).resolves.toMatchObject({
      status: "completed",
      attempts: [
        { attemptId: ACCEPTED_ATTEMPT_ID, clientStep: 1 },
        { attemptId: LATER_ATTEMPT_ID, clientStep: 2 },
      ],
      outcome: { kind: "completed", acceptedAttemptId: ACCEPTED_ATTEMPT_ID },
    });

    const contradictory = structuredClone(completed);
    contradictory.revision = 1;
    if (contradictory.outcome?.kind !== "completed") {
      throw new Error("expected completed outcome");
    }
    contradictory.outcome.acceptedAttemptId = LATER_ATTEMPT_ID;
    await expect(reopened.put(contradictory, { expectedRevision: 0 })).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      context: { validationIssue: "invalid completed outcome" },
    });

    const legacy = structuredClone(completed);
    legacy.revision = 1;
    if (legacy.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    delete legacy.outcome.acceptedAttemptId;
    await reopened.put(legacy, { expectedRevision: 0 });
    await expect(reopened.get(SESSION_ID)).resolves.toEqual(legacy);
  });

  it("persists one private fingerprint key outside the session records", async () => {
    const first = await store.getOrCreateFingerprintKey();
    const reopened = new LocalSearchJourneyStore(
      new LocalFileSystem([base]),
      sessionsDir,
      new DeterministicRandom(21),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(22)),
      new FakeClock(0),
    );

    await expect(reopened.getOrCreateFingerprintKey()).resolves.toEqual(first);
    expect(first).toHaveLength(32);
    await expect(reopened.list("ws-a")).resolves.toEqual([]);
    if (process.platform !== "win32") {
      const keyStat = await stat(path.join(path.dirname(sessionsDir), "fingerprint.key"));
      expect(keyStat.mode & 0o777).toBe(0o600);
    }
  });

  it.each(["write", "rename"] as const)(
    "cleans fingerprint-key temp bytes after an injected %s failure",
    async (failurePoint) => {
      const failing = new LocalSearchJourneyStore(
        new FailingAtomicFileSystem([base], failurePoint),
        sessionsDir,
        new DeterministicRandom(23),
        new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(24)),
        new FakeClock(0),
      );

      await expect(failing.getOrCreateFingerprintKey()).rejects.toThrow(
        `injected ${failurePoint} failure`,
      );
      const entries = await readdir(path.dirname(sessionsDir));
      expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      await expect(
        fs.stat(path.join(path.dirname(sessionsDir), "fingerprint.key")),
      ).resolves.toBeNull();
    },
  );

  it.each(["write", "rename"] as const)(
    "cleans session temp bytes after an injected %s failure",
    async (failurePoint) => {
      const failing = new LocalSearchJourneyStore(
        new FailingAtomicFileSystem([base], failurePoint),
        sessionsDir,
        new DeterministicRandom(25),
        new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(26)),
        new FakeClock(0),
      );

      await expect(failing.put(session(), { expectedRevision: null })).rejects.toThrow(
        `injected ${failurePoint} failure`,
      );
      const entries = await readdir(sessionsDir);
      expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      await expect(fs.stat(path.join(sessionsDir, `${SESSION_ID}.json`))).resolves.toBeNull();
    },
  );

  it("keeps the create and session leases owned across a logical write longer than 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const clock = new FakeClock(0);
      const locks = new InMemoryLockProvider(clock, new DeterministicRandom(28));
      const slowFileSystem = new SlowAtomicFileSystem([base], 35_000);
      const slowStore = new LocalSearchJourneyStore(
        slowFileSystem,
        sessionsDir,
        new DeterministicRandom(27),
        locks,
        clock,
      );

      const pending = slowStore.put(session(), { expectedRevision: null });
      await slowFileSystem.writeStarted;
      for (let elapsed = 0; elapsed < 30_000; elapsed += SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS) {
        clock.advance(SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS);
      }
      clock.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(
        locks.tryAcquire("search-journey:create", { leaseMs: SEARCH_JOURNEY_LOCK_LEASE_MS }),
      ).resolves.toBeNull();
      await expect(
        locks.tryAcquire(`search-journey:${SESSION_ID}`, {
          leaseMs: SEARCH_JOURNEY_LOCK_LEASE_MS,
        }),
      ).resolves.toBeNull();

      clock.advance(4_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toBeUndefined();
      await expect(slowStore.get(SESSION_ID)).resolves.toEqual(session());
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renews the earlier create lease after an asymmetric session renewal exceeds the lease", async () => {
    const clock = new FakeClock(0);
    const locks = new AsymmetricRenewLockProvider(clock, new DeterministicRandom(52));
    let bothFreshAtPublish = false;
    const checkingFileSystem = new BeforeSessionPublishFileSystem([base], async () => {
      const [creation, perSession] = await Promise.all([
        locks.inspect("search-journey:create"),
        locks.inspect(`search-journey:${SESSION_ID}`),
      ]);
      const freshnessBoundary = clock.nowEpochMs() + SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS;
      bothFreshAtPublish =
        creation !== null &&
        perSession !== null &&
        Date.parse(creation.leaseExpiresAt) >= freshnessBoundary &&
        Date.parse(perSession.leaseExpiresAt) >= freshnessBoundary;
    });
    const boundedStore = new LocalSearchJourneyStore(
      checkingFileSystem,
      sessionsDir,
      new DeterministicRandom(51),
      locks,
      clock,
    );

    await expect(boundedStore.put(session(), { expectedRevision: null })).resolves.toBeUndefined();
    expect(locks.sessionRenewals).toBe(1);
    expect(locks.creationRenewals).toBe(2);
    expect(bothFreshAtPublish).toBe(true);
  });

  it("fails closed and removes session temp bytes when lock ownership is lost before rename", async () => {
    const losingStore = new LocalSearchJourneyStore(
      fs,
      sessionsDir,
      new DeterministicRandom(29),
      new RejectingRenewLockProvider(new FakeClock(0), new DeterministicRandom(30)),
      new FakeClock(0),
    );

    await expect(losingStore.put(session(), { expectedRevision: null })).rejects.toMatchObject({
      code: "LOCK_HELD",
      operation: "lock_renew",
    });
    const entries = await readdir(sessionsDir);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    await expect(fs.stat(path.join(sessionsDir, `${SESSION_ID}.json`))).resolves.toBeNull();
  });

  it("fails closed and removes key temp bytes when lock ownership is lost before rename", async () => {
    const losingStore = new LocalSearchJourneyStore(
      fs,
      sessionsDir,
      new DeterministicRandom(31),
      new RejectingRenewLockProvider(new FakeClock(0), new DeterministicRandom(32)),
      new FakeClock(0),
    );

    await expect(losingStore.getOrCreateFingerprintKey()).rejects.toMatchObject({
      code: "LOCK_HELD",
      operation: "lock_renew",
    });
    const entries = await readdir(path.dirname(sessionsDir));
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    await expect(
      fs.stat(path.join(path.dirname(sessionsDir), "fingerprint.key")),
    ).resolves.toBeNull();
  });

  it("fails closed when the persisted fingerprint key is corrupted", async () => {
    await mkdir(path.dirname(sessionsDir), { recursive: true });
    await writeFile(path.join(path.dirname(sessionsDir), "fingerprint.key"), "not-a-key");

    await expect(store.getOrCreateFingerprintKey()).rejects.toMatchObject({
      code: "INDEX_INCOMPLETE",
      operation: "search_journey_fingerprint_key",
    });
  });

  it("does not rotate a missing fingerprint key while session records exist", async () => {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify(session()));

    await expect(store.getOrCreateFingerprintKey()).rejects.toMatchObject({
      code: "INDEX_INCOMPLETE",
      operation: "search_journey_fingerprint_key",
      context: { existingRecordCount: 1 },
    });
    await expect(
      fs.stat(path.join(path.dirname(sessionsDir), "fingerprint.key")),
    ).resolves.toBeNull();
  });

  it("validates privacy invariants before writing any session bytes", async () => {
    const invalid = session({ goal: { fingerprint: "a".repeat(64), text: "private goal" } });

    await expect(store.put(invalid, { expectedRevision: null })).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      operation: "search_journey_put",
      context: { validationIssue: "text retention violates consent" },
    });
    await expect(fs.stat(path.join(sessionsDir, `${SESSION_ID}.json`))).resolves.toBeNull();
  });

  it("rejects oversized retained text before writing any session bytes", async () => {
    const invalid = session({
      retainText: true,
      goal: {
        fingerprint: "a".repeat(64),
        text: "g".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH + 1),
      },
    });

    await expect(store.put(invalid, { expectedRevision: null })).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      operation: "search_journey_put",
      context: { validationIssue: "invalid goal" },
    });
    await expect(fs.stat(path.join(sessionsDir, `${SESSION_ID}.json`))).resolves.toBeNull();
  });

  it("rejects raw text in a fingerprint slot before writing any session bytes", async () => {
    const invalid = session({ goal: { fingerprint: "private profile-card goal" } });

    await expect(store.put(invalid, { expectedRevision: null })).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      operation: "search_journey_put",
      context: { validationIssue: "invalid goal" },
    });
    await expect(fs.stat(path.join(sessionsDir, `${SESSION_ID}.json`))).resolves.toBeNull();
  });

  it("rejects a stale compare-and-swap revision and keeps the winning update", async () => {
    await store.put(session(), { expectedRevision: null });
    const left = await store.get(SESSION_ID);
    const right = await store.get(SESSION_ID);
    if (left === null || right === null) throw new Error("expected persisted session");

    const winner: SearchJourneyV1 = {
      ...left,
      revision: 1,
      updatedAt: "2026-09-06T10:00:01.000Z",
    };
    const stale: SearchJourneyV1 = {
      ...right,
      revision: 1,
      updatedAt: "2026-09-06T10:00:02.000Z",
    };
    await store.put(winner, { expectedRevision: 0 });
    await expect(store.put(stale, { expectedRevision: 0 })).rejects.toMatchObject({
      code: "SEARCH_SESSION_CONFLICT",
      retryable: true,
      context: {
        sessionId: SESSION_ID,
        expectedRevision: 0,
        actualRevision: 1,
      },
    });
    await expect(store.get(SESSION_ID)).resolves.toEqual(winner);
  });

  it("treats expectedRevision null as create-only", async () => {
    await store.put(session(), { expectedRevision: null });
    await expect(store.put(session(), { expectedRevision: null })).rejects.toMatchObject({
      code: "SEARCH_SESSION_CONFLICT",
    });
  });

  it("rejects a blind write without an expected revision", async () => {
    await expect(
      (store.put as unknown as (value: SearchJourneyV1) => Promise<void>)(session()),
    ).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      operation: "search_journey_put",
    });
    await expect(store.get(SESSION_ID)).resolves.toBeNull();
  });

  it("requires an incoming revision to advance the expected CAS revision exactly once", async () => {
    await expect(
      store.put(session({ revision: 2 }), { expectedRevision: null }),
    ).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      context: { expectedRevision: null, suppliedRevision: 2, requiredRevision: 0 },
    });

    await store.put(session(), { expectedRevision: null });
    await expect(
      store.put(session({ revision: 3 }), { expectedRevision: 0 }),
    ).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      context: { expectedRevision: 0, suppliedRevision: 3, requiredRevision: 1 },
    });
  });

  it("refuses a new session once the bounded record count is reached", async () => {
    const saturatedStore = new LocalSearchJourneyStore(
      new SaturatedFileSystem([base], sessionsDir),
      sessionsDir,
      new DeterministicRandom(31),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(32)),
      new FakeClock(0),
    );

    await expect(saturatedStore.put(session(), { expectedRevision: null })).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      context: { recordCount: MAX_SEARCH_JOURNEY_FILES },
    });
  });

  it("honors an already-aborted signal on get, put, and list", async () => {
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal };

    await expect(store.get(SESSION_ID, options)).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(
      store.put(session(), { ...options, expectedRevision: null }),
    ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(store.list("ws-a", options)).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  });

  it("reports invalid JSON as a corrupted committed journey", async () => {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `${SESSION_ID}.json`), "{ not valid json");

    await expect(store.get(SESSION_ID)).rejects.toMatchObject({
      code: "INDEX_INCOMPLETE",
      operation: "search_journey_read",
      context: { sessionId: SESSION_ID },
    });
    await expect(store.list("ws-a")).rejects.toMatchObject({ code: "INDEX_INCOMPLETE" });
  });

  it("rejects an oversized committed record before reading its contents", async () => {
    const recordPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    const oversizedStore = new LocalSearchJourneyStore(
      new OversizedFileSystem([base], recordPath),
      sessionsDir,
      new DeterministicRandom(41),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(42)),
      new FakeClock(0),
    );

    await expect(oversizedStore.get(SESSION_ID)).rejects.toMatchObject({
      code: "INDEX_INCOMPLETE",
      operation: "search_journey_read",
      context: {
        sessionId: SESSION_ID,
        sizeBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES + 1,
        maximumBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES,
      },
    });
  });

  it("rechecks actual UTF-8 bytes and rejects growth beyond the record limit before parsing", async () => {
    await mkdir(sessionsDir, { recursive: true });
    const recordPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await writeFile(recordPath, JSON.stringify(session()));
    const growingStore = new LocalSearchJourneyStore(
      new OversizedDuringReadFileSystem([base], recordPath),
      sessionsDir,
      new DeterministicRandom(45),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(46)),
      new FakeClock(0),
    );

    await expect(growingStore.list("ws-a")).rejects.toMatchObject({
      code: "INDEX_INCOMPLETE",
      operation: "search_journey_list",
      context: {
        fileName: `${SESSION_ID}.json`,
        actualBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES + 1,
        maximumRecordBytes: MAX_SEARCH_JOURNEY_RECORD_BYTES,
      },
    });
  });

  it("fails a report snapshot when a record size changes between preflight and read", async () => {
    await mkdir(sessionsDir, { recursive: true });
    const recordPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await writeFile(recordPath, JSON.stringify(session()));
    const changingStore = new LocalSearchJourneyStore(
      new ChangedDuringReadFileSystem([base], recordPath),
      sessionsDir,
      new DeterministicRandom(47),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(48)),
      new FakeClock(0),
    );

    await expect(changingStore.list("ws-a")).rejects.toMatchObject({
      code: "SEARCH_SESSION_CONFLICT",
      operation: "search_journey_list",
      retryable: true,
      context: {
        fileName: `${SESSION_ID}.json`,
        phase: "post-read",
      },
    });
  });

  it("fails a report snapshot when an enumerated record disappears before read", async () => {
    await mkdir(sessionsDir, { recursive: true });
    const recordPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await writeFile(recordPath, JSON.stringify(session()));
    const disappearingStore = new LocalSearchJourneyStore(
      new DisappearingDuringReadFileSystem([base], recordPath),
      sessionsDir,
      new DeterministicRandom(49),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(50)),
      new FakeClock(0),
    );

    await expect(disappearingStore.list("ws-a")).rejects.toMatchObject({
      code: "SEARCH_SESSION_CONFLICT",
      operation: "search_journey_list",
      retryable: true,
      context: {
        fileName: `${SESSION_ID}.json`,
        phase: "read",
      },
    });
  });

  it("rejects an over-budget snapshot before reading or parsing any session", async () => {
    await mkdir(sessionsDir, { recursive: true });
    const boundedStore = new LocalSearchJourneyStore(
      new AggregateOversizedFileSystem([base], sessionsDir),
      sessionsDir,
      new DeterministicRandom(43),
      new InMemoryLockProvider(new FakeClock(0), new DeterministicRandom(44)),
      new FakeClock(0),
    );

    await expect(boundedStore.list("ws-a")).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
      operation: "search_journey_list",
      context: {
        recordCount: 5,
        maximumBytes: MAX_SEARCH_JOURNEY_LIST_BYTES,
      },
    });
  });

  it("reports a valid-JSON shape mismatch as corruption", async () => {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, `${SESSION_ID}.json`),
      JSON.stringify({ schemaVersion: 1, sessionId: SESSION_ID, attempts: [] }),
    );

    await expect(store.get(SESSION_ID)).rejects.toMatchObject({ code: "INDEX_INCOMPLETE" });
  });

  it("rejects nested status and privacy invariant violations as corruption", async () => {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, `${SESSION_ID}.json`),
      JSON.stringify(
        session({
          goal: { fingerprint: "a".repeat(64), text: "must-not-survive" },
          status: "completed",
        }),
      ),
    );

    await expect(store.get(SESSION_ID)).rejects.toMatchObject({
      code: "INDEX_INCOMPLETE",
      operation: "search_journey_read",
    });
  });

  it("rejects path-like or otherwise invalid session ids before filesystem access", async () => {
    await expect(store.get("../../outside")).rejects.toMatchObject({
      code: "SEARCH_SESSION_NOT_FOUND",
    });
    await expect(
      store.put(session({ sessionId: "not-a-uuid" }), { expectedRevision: null }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_NOT_FOUND" });
  });
});
