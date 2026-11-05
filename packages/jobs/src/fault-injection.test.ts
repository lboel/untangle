/**
 * Crash simulation (architecture.md §27.5, BUILD_PLAN §5.5) at three
 * injection points:
 *
 *   1. after embedding, before upsert;
 *   2. after (confirmed) upsert, before checkpoint;
 *   3. after checkpoint, before generation commit.
 *
 * The invariant proven after each simulated restart + resume: NO completed
 * index is silently inconsistent — a generation is only ever reported
 * `completed` when all planned work is confirmed, no point is counted
 * twice, and the resumed run finishes successfully.
 */
import type { CheckpointStorePort, IndexCheckpointV1, JobEvent } from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";
import { DeterministicRandom, FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { FileCheckpointStore } from "./checkpoint-store.js";
import { IndexJobRunner, type IndexJobRunnerOptions } from "./runner.js";
import { createFakeWorld, makePlannedFiles } from "./test-support.js";

const IDENTITY = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "ref-1",
  effectiveProfileId: "profile-1",
};

const FILE_COUNT = 8;
const POINTS_PER_FILE = 2;

interface Harness {
  world: ReturnType<typeof createFakeWorld>;
  checkpointStore: CheckpointStorePort;
  clock: FakeClock;
  makeRunner: (overrides?: Partial<IndexJobRunnerOptions>) => IndexJobRunner;
}

function makeHarness(): Harness {
  const world = createFakeWorld({
    files: makePlannedFiles(FILE_COUNT),
    pointsPerFile: POINTS_PER_FILE,
  });
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
      random: new DeterministicRandom(300 + runnerIndex),
      embedBatchSize: 1,
      queueCapacities: { analysis: 2, upsert: 1 },
      ...overrides,
    });
  };
  return { world, checkpointStore, clock, makeRunner };
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

/** Shared post-restart assertions: complete, exact, no double counting. */
async function assertConsistentAfterRestart(harness: Harness, events2: JobEvent[]): Promise<void> {
  const { world, checkpointStore } = harness;
  // The resumed run finishes successfully.
  expect(kinds(events2).at(-1)).toBe("job_completed");
  // Exactly one commit, of exactly one complete generation.
  expect(world.commitCalls).toHaveLength(1);
  const commit = world.commitCalls[0];
  expect(commit?.confirmedFileIds).toHaveLength(FILE_COUNT);
  expect(new Set(commit?.confirmedFileIds).size).toBe(FILE_COUNT);
  expect(world.committedStatus).toBe("completed");
  // No point counted twice: the idempotent store holds exactly the planned set.
  expect(world.storedPoints.size).toBe(FILE_COUNT * POINTS_PER_FILE);
  // The last persisted checkpoint confirms every planned file exactly once.
  const checkpoint: IndexCheckpointV1 | null = await checkpointStore.loadLatest(
    IDENTITY.repoId,
    IDENTITY.refId,
  );
  expect(checkpoint?.completedFiles).toHaveLength(FILE_COUNT);
  expect(new Set(checkpoint?.completedFiles).size).toBe(FILE_COUNT);
}

describe("fault injection point 1: after embedding, before upsert", () => {
  it("crashed run never reports completed; restart resumes and repeats no confirmed work", async () => {
    const harness = makeHarness();
    const { world } = harness;
    let upsertCalls = 0;
    world.faults.beforeUpsert = () => {
      upsertCalls += 1;
      if (upsertCalls === 4) {
        world.faults.beforeUpsert = null;
        throw new UntangleError("QDRANT_UNAVAILABLE", "injected crash before upsert", {
          retryable: true,
        });
      }
    };

    const events1 = await collectEvents(harness.makeRunner().run());
    const last1 = events1.at(-1);
    expect(last1?.kind).toBe("job_failed");
    if (last1?.kind === "job_failed") {
      expect(last1.errorCode).toBe("QDRANT_UNAVAILABLE");
      expect(last1.retryable).toBe(true);
    }
    expect(kinds(events1)).not.toContain("job_completed");
    expect(world.commitCalls).toHaveLength(0);

    // Confirmed before the crash: exactly the 3 checkpointed batches.
    const checkpointAfterCrash = await harness.checkpointStore.loadLatest(
      IDENTITY.repoId,
      IDENTITY.refId,
    );
    const confirmed = new Set(checkpointAfterCrash?.completedFiles ?? []);
    expect(confirmed.size).toBe(3);

    // Restart against the same stores; time passes between the runs so the
    // restarted job's checkpoints are strictly newer.
    harness.clock.advance(60_000);
    const analyzedBefore = world.analyzedFileIds.length;
    const events2 = await collectEvents(harness.makeRunner().run());

    // Confirmed work is not repeated.
    const analyzedInRun2 = world.analyzedFileIds.slice(analyzedBefore);
    for (const fileId of analyzedInRun2) {
      expect(confirmed.has(fileId)).toBe(false);
    }
    expect(analyzedInRun2).toHaveLength(FILE_COUNT - confirmed.size);
    await assertConsistentAfterRestart(harness, events2);
  });
});

describe("fault injection point 2: after confirmed upsert, before checkpoint", () => {
  it("the unconfirmed batch is redone idempotently after restart", async () => {
    const harness = makeHarness();
    const { world } = harness;
    let checkpointAttempts = 0;
    world.faults.beforeCheckpoint = () => {
      checkpointAttempts += 1;
      if (checkpointAttempts === 3) {
        world.faults.beforeCheckpoint = null;
        throw new UntangleError("QDRANT_UNAVAILABLE", "injected crash before checkpoint", {
          retryable: true,
        });
      }
    };
    // Wire the fault into the checkpoint store via a wrapping store.
    const failingStore: CheckpointStorePort = {
      save: async (checkpoint, options) => {
        world.faults.beforeCheckpoint?.();
        await harness.checkpointStore.save(checkpoint, options);
      },
      load: (jobId, options) => harness.checkpointStore.load(jobId, options),
      loadLatest: (repoId, refId, options) =>
        harness.checkpointStore.loadLatest(repoId, refId, options),
      delete: (jobId, options) => harness.checkpointStore.delete(jobId, options),
    };

    const events1 = await collectEvents(
      harness.makeRunner({ checkpointStore: failingStore }).run(),
    );
    expect(kinds(events1).at(-1)).toBe("job_failed");
    expect(kinds(events1)).not.toContain("job_completed");
    expect(world.commitCalls).toHaveLength(0);

    // The store confirmed 3 upserts, but only 2 checkpoints landed: the
    // third batch is confirmed-but-unrecorded — exactly the §27.5 window.
    const upsertsInRun1 = world.upsertedFileIds.length;
    expect(upsertsInRun1).toBe(3);
    const checkpointAfterCrash = await harness.checkpointStore.loadLatest(
      IDENTITY.repoId,
      IDENTITY.refId,
    );
    expect(checkpointAfterCrash?.completedFiles).toHaveLength(2);

    // Restart: the unrecorded batch is re-processed (idempotent upsert),
    // never double-counted.
    harness.clock.advance(60_000);
    const events2 = await collectEvents(harness.makeRunner().run());
    await assertConsistentAfterRestart(harness, events2);
    // The redone file appears twice in the upsert log (once unrecorded,
    // once confirmed) but only once in the final state.
    expect(world.upsertedFileIds.length).toBe(upsertsInRun1 + (FILE_COUNT - 2));
  });
});

describe("fault injection point 3: after checkpoint, before generation commit", () => {
  it("the generation stays uncommitted until a restarted run commits it", async () => {
    const harness = makeHarness();
    const { world } = harness;
    world.faults.beforeCommit = () => {
      world.faults.beforeCommit = null;
      throw new UntangleError("QDRANT_UNAVAILABLE", "injected crash before generation commit", {
        retryable: true,
      });
    };

    const events1 = await collectEvents(harness.makeRunner().run());
    expect(kinds(events1).at(-1)).toBe("job_failed");
    expect(kinds(events1)).not.toContain("job_completed");
    // All pipeline work was confirmed and checkpointed…
    const checkpointAfterCrash = await harness.checkpointStore.loadLatest(
      IDENTITY.repoId,
      IDENTITY.refId,
    );
    expect(checkpointAfterCrash?.completedFiles).toHaveLength(FILE_COUNT);
    // …but the generation was NOT committed: nothing may serve it as complete.
    expect(world.committedStatus).toBe("");
    expect(world.commitCalls).toHaveLength(0);

    // Restart: resume finds no remaining file work and only commits.
    harness.clock.advance(60_000);
    const embedBatchesBefore = world.embedBatchSizes.length;
    const analyzedBefore = world.analyzedFileIds.length;
    const events2 = await collectEvents(harness.makeRunner().run());
    await assertConsistentAfterRestart(harness, events2);
    // No embedding and no analysis was repeated for confirmed work.
    expect(world.embedBatchSizes.length).toBe(embedBatchesBefore);
    expect(world.analyzedFileIds.length).toBe(analyzedBefore);
    // The resumed run kept the crashed run's generation.
    expect(world.commitCalls[0]?.generationId).toBe(checkpointAfterCrash?.generationId ?? "");
  });
});
