import type {
  CheckpointStorePort,
  JobEvent,
  LockHandle,
  LockProvider,
  LockRecordV1,
  LogEvent,
} from "@untangle-code/domain";
import { buildCorpusRevisionFingerprint } from "@untangle-code/domain";
import {
  DeterministicRandom,
  FakeClock,
  InMemoryLockProvider,
  MemoryFileSystem,
} from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { FileCheckpointStore } from "./checkpoint-store.js";
import { IndexJobRunner, type IndexJobRunnerOptions } from "./runner.js";
import { createFakeWorld, createGate, makePlannedFiles, settle, until } from "./test-support.js";

const IDENTITY = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "ref-1",
  effectiveProfileId: "profile-1",
};

interface Harness {
  clock: FakeClock;
  fs: MemoryFileSystem;
  checkpointStore: CheckpointStorePort;
  makeRunner: (overrides?: Partial<IndexJobRunnerOptions>) => IndexJobRunner;
}

function makeHarness(world: ReturnType<typeof createFakeWorld>): Harness {
  const clock = new FakeClock(1_750_000_000_000);
  const fs = new MemoryFileSystem(clock);
  const checkpointStore = new FileCheckpointStore(fs, { directory: "/state/checkpoints" });
  let runnerIndex = 0;
  const makeRunner = (overrides: Partial<IndexJobRunnerOptions> = {}): IndexJobRunner => {
    runnerIndex += 1;
    return new IndexJobRunner({
      identity: IDENTITY,
      stages: world.stages,
      checkpointStore,
      clock,
      random: new DeterministicRandom(100 + runnerIndex),
      ...overrides,
    });
  };
  return { clock, fs, checkpointStore, makeRunner };
}

async function collectEvents(iterable: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function kinds(events: JobEvent[]): string[] {
  return events.map((event) => event.kind);
}

function scriptedLockProvider(input: {
  renew: () => Promise<void>;
  onAcquire?: (leaseMs: number | undefined) => void;
  onRelease?: () => void;
}): LockProvider {
  let record: LockRecordV1 | null = null;
  const handle = (): LockHandle => ({
    get key() {
      return (record as LockRecordV1).key;
    },
    get record() {
      return record as LockRecordV1;
    },
    renew: input.renew,
    release: async () => {
      input.onRelease?.();
      record = null;
    },
  });
  return {
    acquire: async (key, options) => {
      input.onAcquire?.(options?.leaseMs);
      record = {
        key,
        pid: process.pid,
        processInstanceId: "scripted-lock-owner",
        host: "test",
        acquiredAt: "2025-01-01T00:00:00.000Z",
        leaseExpiresAt: "2025-01-01T00:01:00.000Z",
      };
      return handle();
    },
    tryAcquire: async () => null,
    inspect: async () => record,
  };
}

describe("IndexJobRunner — happy path", () => {
  it("emits the typed event stream and completes only after the generation commit", async () => {
    const world = createFakeWorld();
    const harness = makeHarness(world);
    const runner = harness.makeRunner({ embedBatchSize: 2 });

    const events = await collectEvents(runner.run());
    const eventKinds = kinds(events);

    expect(eventKinds.slice(0, 3)).toEqual([
      "job_queued",
      "infrastructure_ready",
      "files_discovered",
    ]);
    expect(eventKinds.at(-1)).toBe("job_completed");
    expect(eventKinds.filter((kind) => kind === "file_analyzed")).toHaveLength(6);
    expect(eventKinds.filter((kind) => kind === "graph_updated")).toHaveLength(2);
    expect(eventKinds.filter((kind) => kind === "points_stored").length).toBeGreaterThan(0);
    // One checkpoint per confirmed batch plus the final one — and each
    // points_stored is followed by its checkpoint_saved.
    expect(eventKinds.filter((kind) => kind === "checkpoint_saved").length).toBe(
      eventKinds.filter((kind) => kind === "points_stored").length + 1,
    );
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]?.kind === "points_stored") {
        const following = eventKinds.slice(index + 1);
        expect(following).toContain("checkpoint_saved");
      }
    }

    // Every event carries the common base fields (architecture.md §2.2).
    for (const event of events) {
      expect(event.jobId).toBe(runner.status().jobId);
      expect(event.workspaceId).toBe("ws-1");
      expect(typeof event.occurredAt).toBe("string");
    }
    // The generation id is known from discovery onward.
    for (const event of events.slice(2)) {
      expect(event.generationId).toBe(runner.status().generationId);
    }

    expect(runner.status().stage).toBe("completed");
    expect(runner.status().filesCompleted).toBe(6);
    expect(world.commitCalls).toHaveLength(1);
    expect(world.commitCalls[0]?.confirmedFileIds).toHaveLength(6);
    expect(world.storedPoints.size).toBe(12);
    expect(world.committedStatus).toBe("completed");
  });

  it("completes a run with zero changed files without inventing pipeline work", async () => {
    const world = createFakeWorld();
    const corpusManifestHashes = { ...world.discovery.corpusManifestHashes };
    world.discovery = {
      planned: [],
      corpusManifestHashes,
      totalFiles: 8,
      unchangedFiles: 8,
      ignoredFiles: 0,
    };
    const harness = makeHarness(world);
    let publishedCorpusRevision: string | undefined;
    const runner = harness.makeRunner({
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        expect(outcome).toBe("completed");
        publishedCorpusRevision = corpusRevisionFingerprint;
      },
    });

    const events = await collectEvents(runner.run());
    expect(kinds(events).at(-1)).toBe("job_completed");
    expect(world.analyzedFileIds).toHaveLength(0);
    expect(world.embedBatchSizes).toHaveLength(0);
    expect(world.commitCalls).toHaveLength(1);
    expect(runner.status().stage).toBe("completed");
    expect(publishedCorpusRevision).toBe(buildCorpusRevisionFingerprint(corpusManifestHashes));
  });

  it("run() is single-shot", async () => {
    const world = createFakeWorld();
    const runner = makeHarness(world).makeRunner();
    await collectEvents(runner.run());
    expect(() => runner.run()).toThrow(/once/u);
  });

  it("publishes the generation marker before pipeline mutation and stops when publication fails", async () => {
    const world = createFakeWorld();
    const observedGenerations: string[] = [];
    const runner = makeHarness(world).makeRunner({
      generationId: "generation-before-mutation",
      onGenerationStarted: async (generationId) => {
        observedGenerations.push(generationId);
        expect(world.analyzedFileIds).toEqual([]);
        expect(world.embedBatchSizes).toEqual([]);
        expect(world.upsertedFileIds).toEqual([]);
        expect(world.commitCalls).toEqual([]);
        throw new Error("running marker could not be published");
      },
    });

    const events = await collectEvents(runner.run());

    expect(observedGenerations).toEqual(["generation-before-mutation"]);
    expect(kinds(events)).toEqual(["job_queued", "infrastructure_ready", "job_failed"]);
    expect(events.at(-1)).toMatchObject({
      kind: "job_failed",
      generationId: "generation-before-mutation",
      errorCode: "INDEX_INCOMPLETE",
    });
    expect(world.analyzedFileIds).toEqual([]);
    expect(world.embedBatchSizes).toEqual([]);
    expect(world.upsertedFileIds).toEqual([]);
    expect(world.commitCalls).toEqual([]);
  });

  it("publishes the terminal generation state before releasing the repository lock", async () => {
    const world = createFakeWorld();
    const harness = makeHarness(world);
    const lockProvider = new InMemoryLockProvider(harness.clock, new DeterministicRandom(701));
    const lockKey = "repo:repo-1:ref-1:index";
    const terminal: string[] = [];
    const runner = harness.makeRunner({
      lockProvider,
      onGenerationFinished: async (generationId, outcome) => {
        terminal.push(`${generationId}:${outcome}`);
        const contender = await lockProvider.tryAcquire(lockKey);
        expect(contender).toBeNull();
      },
    });

    await collectEvents(runner.run());

    expect(terminal).toEqual([`${runner.status().generationId}:completed`]);
    const afterRun = await lockProvider.tryAcquire(lockKey);
    expect(afterRun).not.toBeNull();
    await afterRun?.release();
  });
});

describe("IndexJobRunner — incomplete generations are never completed", () => {
  it("fails with INDEX_INCOMPLETE when a required graph is missing, WITHOUT committing", async () => {
    const world = createFakeWorld({
      graphs: [{ graph: "file", nodeCount: 1, edgeCount: 0 }],
    });
    const runner = makeHarness(world).makeRunner();

    const events = await collectEvents(runner.run());
    const last = events.at(-1);
    expect(last?.kind).toBe("job_failed");
    if (last?.kind === "job_failed") {
      expect(last.errorCode).toBe("INDEX_INCOMPLETE");
      expect(last.retryable).toBe(false);
    }
    expect(kinds(events)).not.toContain("job_completed");
    // The commit stage was never even asked (§13.4 pre-check).
    expect(world.commitCalls).toHaveLength(0);
    expect(runner.status().stage).toBe("failed");
  });

  it("fails when the commit stage does not reach final metadata status", async () => {
    const world = createFakeWorld({ commitStatus: "partial" });
    const runner = makeHarness(world).makeRunner();

    const events = await collectEvents(runner.run());
    const last = events.at(-1);
    expect(last?.kind).toBe("job_failed");
    if (last?.kind === "job_failed") {
      expect(last.errorCode).toBe("INDEX_INCOMPLETE");
    }
    expect(kinds(events)).not.toContain("job_completed");
  });
});

describe("IndexJobRunner — cancellation (AbortSignal)", () => {
  it("cancels at a safe batch boundary, saves a checkpoint and ends with job_cancelled", async () => {
    const world = createFakeWorld({ files: makePlannedFiles(8) });
    const gate = createGate();
    world.upsertGate = gate;
    const harness = makeHarness(world);
    const runner = harness.makeRunner({
      embedBatchSize: 1,
      queueCapacities: { analysis: 2, upsert: 1 },
    });

    const controller = new AbortController();
    const events: JobEvent[] = [];
    const consumer = (async () => {
      for await (const event of runner.run({ signal: controller.signal })) {
        events.push(event);
      }
    })();

    // Let exactly two batches through, so confirmed work exists.
    gate.release(2);
    await until(
      () => events.filter((event) => event.kind === "checkpoint_saved").length >= 2,
      "two confirmed checkpoints",
    );
    controller.abort();
    gate.openForever();
    await consumer;

    const eventKinds = kinds(events);
    expect(eventKinds.at(-1)).toBe("job_cancelled");
    expect(eventKinds).not.toContain("job_completed");
    expect(eventKinds).not.toContain("job_failed");
    const cancelled = events.at(-1);
    if (cancelled?.kind === "job_cancelled") {
      expect(cancelled.checkpointSaved).toBe(true);
    }
    expect(runner.status().stage).toBe("cancelled");
    // No generation was committed.
    expect(world.commitCalls).toHaveLength(0);

    // The persisted checkpoint is valid and contains ONLY confirmed files.
    const checkpoint = await harness.checkpointStore.loadLatest("repo-1", "ref-1");
    expect(checkpoint).not.toBeNull();
    const confirmedUpserts = new Set(world.upsertedFileIds.flat());
    for (const fileId of checkpoint?.completedFiles ?? []) {
      expect(confirmedUpserts.has(fileId)).toBe(true);
    }
    expect(checkpoint?.completedFiles.length).toBeGreaterThanOrEqual(2);
  });

  it("a job aborted before any batch cancels cleanly without a fabricated checkpoint", async () => {
    const world = createFakeWorld();
    const runner = makeHarness(world).makeRunner();
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(runner.run({ signal: controller.signal }));
    expect(kinds(events).at(-1)).toBe("job_cancelled");
    const cancelled = events.at(-1);
    if (cancelled?.kind === "job_cancelled") {
      // Nothing was confirmed, the generation is not even known yet.
      expect(cancelled.checkpointSaved).toBe(false);
    }
    expect(runner.status().stage).toBe("cancelled");
  });

  it("resume after cancellation continues exactly at the checkpoint without repeating work", async () => {
    const world = createFakeWorld({ files: makePlannedFiles(8) });
    const gate = createGate();
    world.upsertGate = gate;
    const harness = makeHarness(world);
    const runner1 = harness.makeRunner({ embedBatchSize: 1, queueCapacities: { upsert: 1 } });

    const controller = new AbortController();
    const events1: JobEvent[] = [];
    const consumer = (async () => {
      for await (const event of runner1.run({ signal: controller.signal })) {
        events1.push(event);
      }
    })();
    gate.release(3);
    await until(
      () => events1.filter((event) => event.kind === "checkpoint_saved").length >= 3,
      "three confirmed checkpoints",
    );
    controller.abort();
    gate.openForever();
    await consumer;
    expect(kinds(events1).at(-1)).toBe("job_cancelled");

    const checkpoint = await harness.checkpointStore.loadLatest("repo-1", "ref-1");
    const confirmedInRun1 = new Set(checkpoint?.completedFiles ?? []);
    expect(confirmedInRun1.size).toBeGreaterThanOrEqual(3);

    // Second run: same stores, no gate, fresh runner.
    world.upsertGate = null;
    const analyzedBefore = world.analyzedFileIds.length;
    const runner2 = harness.makeRunner({ embedBatchSize: 1 });
    const events2 = await collectEvents(runner2.run());

    expect(kinds(events2).at(-1)).toBe("job_completed");
    // The resumed run adopts the checkpoint's generation.
    expect(runner2.status().generationId).toBe(checkpoint?.generationId ?? "");
    // Confirmed work is NOT repeated: run 2 analyzed only the remaining files.
    const analyzedInRun2 = world.analyzedFileIds.slice(analyzedBefore);
    expect(analyzedInRun2).toHaveLength(8 - confirmedInRun1.size);
    for (const fileId of analyzedInRun2) {
      expect(confirmedInRun1.has(fileId)).toBe(false);
    }
    // All 8 files confirmed in the committed generation; no double counting.
    expect(world.commitCalls).toHaveLength(1);
    expect(world.commitCalls[0]?.confirmedFileIds).toHaveLength(8);
    expect(new Set(world.commitCalls[0]?.confirmedFileIds).size).toBe(8);
    expect(world.storedPoints.size).toBe(16);
  });
});

describe("IndexJobRunner — backpressure and memory budget (§13.2)", () => {
  it("a slow storage stage pauses analysis: memory does not grow unbounded", async () => {
    const world = createFakeWorld({ files: makePlannedFiles(12) });
    const gate = createGate();
    world.upsertGate = gate;
    const harness = makeHarness(world);
    const analysisCapacity = 2;
    const upsertCapacity = 1;
    const runner = harness.makeRunner({
      embedBatchSize: 1,
      queueCapacities: { analysis: analysisCapacity, upsert: upsertCapacity },
      memoryBudgetBytes: 1_000_000,
    });

    const events: JobEvent[] = [];
    const consumer = (async () => {
      for await (const event of runner.run()) {
        events.push(event);
      }
    })();

    // With storage fully blocked, the pipeline may hold at most: the two
    // queues plus one in-flight item per worker hand-off.
    const bound = analysisCapacity + upsertCapacity + 3;
    await until(() => world.analyzedFileIds.length >= bound, "pipeline filled up");
    await settle(50);
    expect(world.analyzedFileIds.length).toBeLessThanOrEqual(bound);
    expect(world.analyzedFileIds.length).toBeLessThan(12);

    // Status makes the budget and queue depths visible mid-run.
    const status = runner.status();
    expect(status.memoryBudgetBytes).toBe(1_000_000);
    expect(status.queues).not.toBeNull();
    expect(status.queues?.analysis.depth).toBeLessThanOrEqual(analysisCapacity);
    expect(status.queues?.upsert.depth).toBeLessThanOrEqual(upsertCapacity);

    gate.openForever();
    await consumer;
    expect(kinds(events).at(-1)).toBe("job_completed");

    // High-water marks prove the bound held for the whole run.
    const finalStatus = runner.status();
    expect(finalStatus.queues?.analysis.maxDepthObserved).toBeLessThanOrEqual(analysisCapacity);
    expect(finalStatus.queues?.upsert.maxDepthObserved).toBeLessThanOrEqual(upsertCapacity);
  });
});

describe("IndexJobRunner — WP-79: a poisoned estimatedBytes fails the job instead of disabling the byte budget", () => {
  it("fails the job (never runs away past the budget) when a stage reports a non-finite estimatedBytes", async () => {
    // End-to-end version of the adversarial repro: file #2's analysis
    // result misreports its size as Infinity (a plausible upstream bug --
    // a bad Content-Length, overflowed byte-length math on a huge
    // generated file, dividing by a zero token count, ...), not a crafted
    // attack. Before the fix this silently turned the analysis queue's
    // `bytes` counter into `NaN` on the next pull, permanently disabling
    // the byte budget for the rest of the job while it kept accepting
    // every remaining file.
    const FILE_COUNT = 20;
    const POISON_FILE_ID = "file-002";
    const world = createFakeWorld({ files: makePlannedFiles(FILE_COUNT) });
    const originalAnalyze = world.stages.analysis.analyze;
    world.stages.analysis.analyze = async (file, options) => {
      const analyzed = await originalAnalyze(file, options);
      return file.fileId === POISON_FILE_ID ? { ...analyzed, estimatedBytes: Infinity } : analyzed;
    };

    const harness = makeHarness(world);
    const runner = harness.makeRunner({
      embedBatchSize: 1,
      queueCapacities: { analysis: 10_000, upsert: 10_000 },
      memoryBudgetBytes: 64 * 1024,
    });

    const events = await collectEvents(runner.run());

    const last = events.at(-1);
    expect(last?.kind).toBe("job_failed");
    if (last?.kind === "job_failed") {
      expect(last.errorCode).toBe("INDEX_INCOMPLETE");
      expect(last.retryable).toBe(false);
    }

    // The pipeline stopped at the poisoned file instead of silently
    // continuing to accept every remaining file past the budget.
    expect(world.analyzedFileIds.length).toBeLessThan(FILE_COUNT);
    expect(world.commitCalls).toHaveLength(0);

    // The byte counter itself was never corrupted -- still a finite,
    // non-negative number, never NaN/Infinity, proving the budget stayed
    // provable even while the job was unwinding.
    const finalStatus = runner.status();
    const analysisBytes = finalStatus.queues?.analysis.bytes ?? 0;
    expect(Number.isFinite(analysisBytes)).toBe(true);
    expect(analysisBytes).toBeGreaterThanOrEqual(0);
  });
});

describe("IndexJobRunner — WP-116: resource options are validated at the entrance", () => {
  // Die Haertung aus WP-79 sitzt im `BoundedQueue`-Konstruktor und greift
  // erst in `runPipeline()` — also mitten im Lauf. `queueCapacities` und
  // `memoryBudgetBytes` kommen aber HIER herein; sie werden jetzt geprueft,
  // bevor der Job Lock, Generation oder Checkpoints anfasst.
  const invalidCapacities: readonly (readonly [string, number])[] = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["beyond safe integers", 1e21],
  ];

  for (const [label, value] of invalidCapacities) {
    it(`rejects a ${label} analysis capacity with CONFIG_INVALID before anything runs`, () => {
      const harness = makeHarness(createFakeWorld());
      expect(() => harness.makeRunner({ queueCapacities: { analysis: value } })).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    });

    it(`rejects a ${label} upsert capacity the same way`, () => {
      const harness = makeHarness(createFakeWorld());
      expect(() => harness.makeRunner({ queueCapacities: { upsert: value } })).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    });
  }

  it("rejects an invalid memoryBudgetBytes at construction instead of mid-pipeline", () => {
    const harness = makeHarness(createFakeWorld());
    for (const budget of [0, -1, 1.5, NaN, Infinity, 1e21]) {
      expect(() => harness.makeRunner({ memoryBudgetBytes: budget })).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    }
  });

  it("rejects an invalid embedBatchSize the same way", () => {
    const harness = makeHarness(createFakeWorld());
    for (const size of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => harness.makeRunner({ embedBatchSize: size })).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    }
  });

  it("end to end: a run of items over the whole budget fails the job instead of streaming past it", async () => {
    // Zwei Dateien melden je 100 kB gegen ein Analyse-Budget von 32 kiB
    // (64 kiB haelftig). Die erste darf passieren — sonst haengt die
    // Pipeline an ihr fest —, die zweite beendet den Job mit benanntem
    // Fehler, statt das Budget dauerhaft zu ueberschreiten. Vor WP-116
    // liefen bei `capacity: 1` beliebig viele solcher Dateien durch.
    const world = createFakeWorld({ files: makePlannedFiles(6) });
    const originalAnalyze = world.stages.analysis.analyze;
    world.stages.analysis.analyze = async (file, options) => {
      const analyzed = await originalAnalyze(file, options);
      return { ...analyzed, estimatedBytes: 100_000 };
    };
    const logged: LogEvent[] = [];
    const harness = makeHarness(world);
    const runner = harness.makeRunner({
      embedBatchSize: 1,
      queueCapacities: { analysis: 1, upsert: 1 },
      memoryBudgetBytes: 64 * 1024,
      logger: {
        log: (event) => logged.push(event),
        child: () => {
          throw new Error("unused");
        },
      },
    });

    const events = await collectEvents(runner.run());
    const last = events.at(-1);
    expect(last?.kind).toBe("job_failed");
    if (last?.kind === "job_failed") {
      expect(last.errorCode).toBe("INDEX_INCOMPLETE");
      expect(last.retryable).toBe(false);
    }
    expect(world.commitCalls).toHaveLength(0);
    // Die eine unvermeidbare Ueberschreitung ist gemeldet, nicht stumm (E4).
    const warnings = logged.filter((event) => event.event === "queue_over_budget_admission");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.level).toBe("warn");
    expect(runner.status().queues?.analysis.overBudgetAdmissions).toBe(1);
  });

  it("still accepts capacity 1 — it is valid, it just no longer disables the byte budget", async () => {
    const world = createFakeWorld({ files: makePlannedFiles(4) });
    const harness = makeHarness(world);
    const runner = harness.makeRunner({
      embedBatchSize: 1,
      queueCapacities: { analysis: 1, upsert: 1 },
      memoryBudgetBytes: 1_000_000,
    });
    const events = await collectEvents(runner.run());
    expect(kinds(events).at(-1)).toBe("job_completed");
    expect(runner.status().queues?.analysis.overBudgetAdmissions).toBe(0);
  });
});

describe("IndexJobRunner — cross-process lock", () => {
  it.each([0, 1, 2, 3.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid lockLeaseMs=%s before the job starts",
    (lockLeaseMs) => {
      const world = createFakeWorld();
      const harness = makeHarness(world);

      expect(() => harness.makeRunner({ lockLeaseMs })).toThrow(/lockLeaseMs.*integer >= 3/u);
      expect(world.analyzedFileIds).toEqual([]);
    },
  );

  it("fails with LOCK_HELD when another job holds the ref lock", async () => {
    const world = createFakeWorld();
    const harness = makeHarness(world);
    const lockProvider = new InMemoryLockProvider(harness.clock, new DeterministicRandom(7));
    await lockProvider.acquire("repo:repo-1:ref-1:index", { leaseMs: 60_000 });

    const runner = harness.makeRunner({ lockProvider });
    const events = await collectEvents(runner.run());
    const last = events.at(-1);
    expect(last?.kind).toBe("job_failed");
    if (last?.kind === "job_failed") {
      expect(last.errorCode).toBe("LOCK_HELD");
    }
  });

  it("renews a long-running job without overlapping heartbeat calls", async () => {
    const world = createFakeWorld({ files: makePlannedFiles(2) });
    const storageGate = createGate();
    const renewalGate = createGate();
    world.upsertGate = storageGate;
    const harness = makeHarness(world);
    let activeRenewals = 0;
    let maximumActiveRenewals = 0;
    let renewalCalls = 0;
    let acquiredLeaseMs: number | undefined;
    const lockProvider = scriptedLockProvider({
      onAcquire: (leaseMs) => {
        acquiredLeaseMs = leaseMs;
      },
      renew: async () => {
        renewalCalls += 1;
        activeRenewals += 1;
        maximumActiveRenewals = Math.max(maximumActiveRenewals, activeRenewals);
        if (renewalCalls === 1) await renewalGate.wait();
        activeRenewals -= 1;
      },
    });
    const runner = harness.makeRunner({ lockProvider, lockLeaseMs: 30, embedBatchSize: 1 });

    const eventsPromise = collectEvents(runner.run());
    await until(() => world.embedBatchSizes.length > 0, "pipeline reached its gated storage stage");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(renewalCalls).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(renewalCalls).toBe(1);

    renewalGate.openForever();
    storageGate.openForever();
    const events = await eventsPromise;

    expect(acquiredLeaseMs).toBe(30);
    expect(renewalCalls).toBeGreaterThanOrEqual(2);
    expect(maximumActiveRenewals).toBe(1);
    expect(kinds(events).at(-1)).toBe("job_completed");
  });

  it("fails with LOCK_HELD and suppresses terminal publication when heartbeat renewal is lost", async () => {
    const world = createFakeWorld({ files: makePlannedFiles(2) });
    const storageGate = createGate();
    world.upsertGate = storageGate;
    const harness = makeHarness(world);
    let renewalCalls = 0;
    const terminal: string[] = [];
    const lockProvider = scriptedLockProvider({
      renew: async () => {
        renewalCalls += 1;
        throw new Error("lease was stolen");
      },
    });
    const runner = harness.makeRunner({
      lockProvider,
      lockLeaseMs: 30,
      embedBatchSize: 1,
      onGenerationFinished: async (generationId, outcome) => {
        terminal.push(`${generationId}:${outcome}`);
      },
    });

    const eventsPromise = collectEvents(runner.run());
    await until(() => world.embedBatchSizes.length > 0, "pipeline reached its gated storage stage");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await until(() => renewalCalls > 0, "heartbeat attempted lock renewal");
    storageGate.openForever();
    const events = await eventsPromise;
    const last = events.at(-1);

    expect(last).toMatchObject({ kind: "job_failed", errorCode: "LOCK_HELD", retryable: true });
    expect(kinds(events)).not.toContain("job_completed");
    expect(terminal).toEqual([]);
  });

  it("performs a final ownership check before terminal publication", async () => {
    const world = createFakeWorld();
    const harness = makeHarness(world);
    const terminal: string[] = [];
    const lockProvider = scriptedLockProvider({
      renew: async () => {
        throw new Error("ownership changed before terminal publish");
      },
    });
    const runner = harness.makeRunner({
      lockProvider,
      lockLeaseMs: 60_000,
      onGenerationFinished: async (generationId, outcome) => {
        terminal.push(`${generationId}:${outcome}`);
      },
    });

    const events = await collectEvents(runner.run());

    expect(events.at(-1)).toMatchObject({
      kind: "job_failed",
      errorCode: "LOCK_HELD",
      retryable: true,
    });
    expect(terminal).toEqual([]);
  });
});
