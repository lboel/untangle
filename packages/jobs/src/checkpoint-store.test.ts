import type { IndexCheckpointV1 } from "@untangle-code/domain";
import { isUntangleError } from "@untangle-code/domain";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { FileCheckpointStore, isIndexCheckpointV1 } from "./checkpoint-store.js";

const DIRECTORY = "/workspace/.untangle/checkpoints";

function makeCheckpoint(overrides: Partial<IndexCheckpointV1> = {}): IndexCheckpointV1 {
  return {
    jobId: "job-1",
    generationId: "gen-1",
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    effectiveProfileId: "profile-1",
    completedFiles: ["file-a", "file-b"],
    storedPointIdsByFile: { "file-a": ["file-a:p0"], "file-b": ["file-b:p0", "file-b:p1"] },
    manifestHashes: { "file-a": "hash-a", "file-b": "hash-b" },
    stage: "checkpointing",
    savedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStore(): { store: FileCheckpointStore; fs: MemoryFileSystem; clock: FakeClock } {
  const clock = new FakeClock(1_700_000_000_000);
  const fs = new MemoryFileSystem(clock);
  const store = new FileCheckpointStore(fs, { directory: DIRECTORY });
  return { store, fs, clock };
}

describe("FileCheckpointStore", () => {
  it("round-trips a checkpoint exactly", async () => {
    const { store } = makeStore();
    const checkpoint = makeCheckpoint();
    await store.save(checkpoint);
    expect(await store.load("job-1")).toEqual(checkpoint);
  });

  it("persists atomically: no temp file survives a save", async () => {
    const { store, fs } = makeStore();
    await store.save(makeCheckpoint());
    const entries = await fs.readDir(DIRECTORY);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name.endsWith(".json")).toBe(true);
    expect(entries.some((entry) => entry.name.includes(".tmp"))).toBe(false);
  });

  it("overwrites the previous checkpoint of the same job", async () => {
    const { store, fs } = makeStore();
    await store.save(makeCheckpoint({ completedFiles: ["file-a"] }));
    await store.save(makeCheckpoint({ completedFiles: ["file-a", "file-b"] }));
    const loaded = await store.load("job-1");
    expect(loaded?.completedFiles).toEqual(["file-a", "file-b"]);
    expect(await fs.readDir(DIRECTORY)).toHaveLength(1);
  });

  it("returns null for a missing checkpoint — 'not found' is not an error", async () => {
    const { store } = makeStore();
    expect(await store.load("does-not-exist")).toBeNull();
    expect(await store.loadLatest("repo-x", "ref-x")).toBeNull();
  });

  it("throws INDEX_INCOMPLETE for a corrupt checkpoint file — never null", async () => {
    const { store, fs } = makeStore();
    await store.save(makeCheckpoint());
    const entries = await fs.readDir(DIRECTORY);
    const path = entries[0]?.path ?? "";
    fs.seedFile(path, "{ not json at all");
    let caught: unknown;
    try {
      await store.load("job-1");
    } catch (error) {
      caught = error;
    }
    expect(isUntangleError(caught)).toBe(true);
    if (isUntangleError(caught)) {
      expect(caught.code).toBe("INDEX_INCOMPLETE");
    }
  });

  it("throws INDEX_INCOMPLETE for a well-formed JSON file with a wrong shape", async () => {
    const { store, fs } = makeStore();
    await store.save(makeCheckpoint());
    const entries = await fs.readDir(DIRECTORY);
    fs.seedFile(entries[0]?.path ?? "", JSON.stringify({ jobId: 42 }));
    await expect(store.load("job-1")).rejects.toSatisfy(
      (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
    );
  });

  it("loadLatest returns the newest checkpoint for the requested repo/ref only", async () => {
    const { store } = makeStore();
    await store.save(makeCheckpoint({ jobId: "job-old", savedAt: "2026-01-01T00:00:00.000Z" }));
    await store.save(makeCheckpoint({ jobId: "job-new", savedAt: "2026-01-02T00:00:00.000Z" }));
    await store.save(
      makeCheckpoint({ jobId: "job-other", repoId: "repo-2", savedAt: "2026-01-03T00:00:00.000Z" }),
    );
    const latest = await store.loadLatest("repo-1", "ref-1");
    expect(latest?.jobId).toBe("job-new");
    const other = await store.loadLatest("repo-2", "ref-1");
    expect(other?.jobId).toBe("job-other");
  });

  it("delete removes the checkpoint and is idempotent", async () => {
    const { store } = makeStore();
    await store.save(makeCheckpoint());
    await store.delete("job-1");
    expect(await store.load("job-1")).toBeNull();
    await expect(store.delete("job-1")).resolves.toBeUndefined();
  });

  it("rejects saving a malformed checkpoint object", async () => {
    const { store } = makeStore();
    await expect(
      store.save({ ...makeCheckpoint(), completedFiles: "nope" } as unknown as IndexCheckpointV1),
    ).rejects.toSatisfy(
      (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
    );
  });

  it("every method rejects with JOB_CANCELLED on an aborted signal", async () => {
    const { store } = makeStore();
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal };
    const isCancelled = (error: unknown): boolean =>
      isUntangleError(error) && error.code === "JOB_CANCELLED";
    await expect(store.save(makeCheckpoint(), options)).rejects.toSatisfy(isCancelled);
    await expect(store.load("job-1", options)).rejects.toSatisfy(isCancelled);
    await expect(store.loadLatest("repo-1", "ref-1", options)).rejects.toSatisfy(isCancelled);
    await expect(store.delete("job-1", options)).rejects.toSatisfy(isCancelled);
  });

  it("sanitizes hostile job ids into safe, collision-free file names", async () => {
    const { store, fs } = makeStore();
    await store.save(makeCheckpoint({ jobId: "../../evil/../job" }));
    await store.save(makeCheckpoint({ jobId: "..%2F..%2Fevil%2F..%2Fjob" }));
    const entries = await fs.readDir(DIRECTORY);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.path.startsWith(`${DIRECTORY}/`)).toBe(true);
    }
    expect(await store.load("../../evil/../job")).not.toBeNull();
  });
});

describe("isIndexCheckpointV1", () => {
  it("accepts the exact architecture.md §13.3 shape and rejects near-misses", () => {
    expect(isIndexCheckpointV1(makeCheckpoint())).toBe(true);
    expect(isIndexCheckpointV1(null)).toBe(false);
    expect(isIndexCheckpointV1({})).toBe(false);
    expect(isIndexCheckpointV1({ ...makeCheckpoint(), savedAt: 5 })).toBe(false);
    expect(isIndexCheckpointV1({ ...makeCheckpoint(), storedPointIdsByFile: { a: [1] } })).toBe(
      false,
    );
    expect(isIndexCheckpointV1({ ...makeCheckpoint(), manifestHashes: { a: null } })).toBe(false);
  });
});
