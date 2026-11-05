import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IndexCheckpointV1 } from "@untangle-code/domain";
import { DeterministicRandom } from "@untangle-code/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalCheckpointStore } from "./checkpoint-store.js";
import { LocalFileSystem } from "./local-file-system.js";

function checkpoint(overrides: Partial<IndexCheckpointV1> = {}): IndexCheckpointV1 {
  return {
    jobId: "job-1",
    generationId: "gen-1",
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "repo-1:main",
    effectiveProfileId: "profile-1",
    completedFiles: ["file-a"],
    storedPointIdsByFile: { "file-a": ["p1"] },
    manifestHashes: { "file-a": "hash-a" },
    stage: "embedding",
    savedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("LocalCheckpointStore", () => {
  let base: string;
  let jobsDir: string;
  let store: LocalCheckpointStore;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-checkpoints-"));
    jobsDir = path.join(base, "jobs");
    const fs = new LocalFileSystem([base]);
    store = new LocalCheckpointStore(fs, jobsDir, new DeterministicRandom(7));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("save() then load() round-trips the exact checkpoint", async () => {
    const cp = checkpoint();
    await store.save(cp);
    expect(await store.load(cp.jobId)).toEqual(cp);
  });

  it("load() returns null for an unknown jobId", async () => {
    expect(await store.load("never-saved")).toBeNull();
  });

  it("loadLatest() returns the most recently saved checkpoint for a repo+ref", async () => {
    await store.save(checkpoint({ jobId: "job-1", stage: "embedding" }));
    await store.save(checkpoint({ jobId: "job-2", stage: "storing" }));
    const latest = await store.loadLatest("repo-1", "repo-1:main");
    expect(latest?.jobId).toBe("job-2");
    expect(latest?.stage).toBe("storing");
  });

  it("loadLatest() returns null when nothing was ever saved for that repo+ref", async () => {
    expect(await store.loadLatest("repo-x", "repo-x:main")).toBeNull();
  });

  it("loadLatest() keeps repos/refs independent", async () => {
    await store.save(checkpoint({ jobId: "job-a", repoId: "repo-a", refId: "repo-a:main" }));
    await store.save(checkpoint({ jobId: "job-b", repoId: "repo-b", refId: "repo-b:main" }));
    expect((await store.loadLatest("repo-a", "repo-a:main"))?.jobId).toBe("job-a");
    expect((await store.loadLatest("repo-b", "repo-b:main"))?.jobId).toBe("job-b");
  });

  it("delete() removes the checkpoint; load() then returns null", async () => {
    const cp = checkpoint();
    await store.save(cp);
    await store.delete(cp.jobId);
    expect(await store.load(cp.jobId)).toBeNull();
  });

  it("delete() on an already-absent checkpoint does not throw", async () => {
    await expect(store.delete("never-there")).resolves.toBeUndefined();
  });

  it("save() writes the final checkpoint file only via rename, never a direct write to the final path", async () => {
    const cp = checkpoint();
    const finalPath = path.join(jobsDir, `${cp.jobId}.json`);
    const fs = new LocalFileSystem([base]);
    const writeFileSpy = { calledWithFinalPath: false };
    const originalWriteFile = fs.writeFile.bind(fs);
    fs.writeFile = async (p, data, options) => {
      if (p === finalPath) {
        writeFileSpy.calledWithFinalPath = true;
      }
      return originalWriteFile(p, data, options);
    };
    const spiedStore = new LocalCheckpointStore(fs, jobsDir, new DeterministicRandom(7));
    await spiedStore.save(cp);
    expect(writeFileSpy.calledWithFinalPath).toBe(false);
    expect(await spiedStore.load(cp.jobId)).toEqual(cp);
  });

  it("a stray leftover temp file from a simulated crash does not affect load() of the real checkpoint", async () => {
    const cp = checkpoint();
    await store.save(cp);

    // Simulate a crash between the temp-file write and the rename: an
    // incomplete/garbage temp file sits next to the real, already-committed
    // checkpoint file.
    const strayTempPath = path.join(jobsDir, `${cp.jobId}.json.some-uuid.tmp`);
    await writeFile(strayTempPath, "{ half-writ");

    expect(await store.load(cp.jobId)).toEqual(cp);
    const filesInJobsDir = await readdir(jobsDir);
    expect(filesInJobsDir).toContain(`${cp.jobId}.json`);
  });

  it("load() throws INDEX_INCOMPLETE when the committed checkpoint file itself is corrupted", async () => {
    const cp = checkpoint();
    await store.save(cp);
    const finalPath = path.join(jobsDir, `${cp.jobId}.json`);
    await writeFile(finalPath, "{ this is not valid json");

    await expect(store.load(cp.jobId)).rejects.toMatchObject({ code: "INDEX_INCOMPLETE" });
  });

  it("loadLatest() degrades to null (rather than throwing) when the pointer file is corrupted", async () => {
    await store.save(checkpoint());
    const pointerDir = path.join(jobsDir, "latest");
    const [pointerFileName] = await readdir(pointerDir);
    await writeFile(path.join(pointerDir, pointerFileName ?? ""), "not json at all");

    await expect(store.loadLatest("repo-1", "repo-1:main")).resolves.toBeNull();
  });

  it("respects an already-aborted signal on every method", async () => {
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    const cp = checkpoint();
    await expect(store.save(cp, { signal })).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(store.load(cp.jobId, { signal })).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(store.loadLatest("repo-1", "repo-1:main", { signal })).rejects.toMatchObject({
      code: "JOB_CANCELLED",
    });
    await expect(store.delete(cp.jobId, { signal })).rejects.toMatchObject({
      code: "JOB_CANCELLED",
    });
  });

  it("distinct repo/ref pairs whose plain concatenation would collide stay independent", async () => {
    // Without a separator, repoId="ab"+refId="c" and repoId="a"+refId="bc"
    // both concatenate to "abc" — the separator must keep these distinct.
    await store.save(checkpoint({ jobId: "job-ab-c", repoId: "ab", refId: "c" }));
    await store.save(checkpoint({ jobId: "job-a-bc", repoId: "a", refId: "bc" }));
    expect((await store.loadLatest("ab", "c"))?.jobId).toBe("job-ab-c");
    expect((await store.loadLatest("a", "bc"))?.jobId).toBe("job-a-bc");
  });
});
