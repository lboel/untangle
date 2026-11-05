import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DeterministicRandom, FakeClock } from "@untangle-code/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listStateDirLayoutPaths } from "./layout.js";
import { openLocalStorage, type LocalStorage } from "./storage.js";

describe("openLocalStorage", () => {
  let base: string;
  let stateRoot: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-open-"));
    stateRoot = path.join(base, ".untangle");
    storage = await openLocalStorage(stateRoot, {
      clock: new FakeClock(1_000),
      random: new DeterministicRandom(42),
      host: "test-host",
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("creates the full .untangle/ layout on disk", async () => {
    for (const dir of listStateDirLayoutPaths(storage.layout)) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
  });

  it("wires the embedding cache to a working set()/get() round trip under the layout root", async () => {
    await storage.embeddingCache.set("profile-1", "text", [1, 2, 3]);
    expect(await storage.embeddingCache.get("profile-1", "text")).toEqual([1, 2, 3]);
  });

  it("wires the checkpoint store to a working save()/load() round trip", async () => {
    await storage.checkpoints.save({
      jobId: "job-1",
      generationId: "gen-1",
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      effectiveProfileId: "profile-1",
      completedFiles: [],
      storedPointIdsByFile: {},
      manifestHashes: {},
      stage: "queued",
      savedAt: "2024-01-01T00:00:00.000Z",
    });
    expect((await storage.checkpoints.load("job-1"))?.jobId).toBe("job-1");
  });

  it("wires the lock provider to a working tryAcquire()/release() round trip", async () => {
    const handle = await storage.locks.tryAcquire("repo:repo-1:repo-1:main:index");
    expect(handle).not.toBeNull();
    expect(await storage.locks.inspect("repo:repo-1:repo-1:main:index")).not.toBeNull();
    await handle?.release();
    expect(await storage.locks.inspect("repo:repo-1:repo-1:main:index")).toBeNull();
  });

  it("rejects a path escape attempt through the returned FileSystemPort", async () => {
    await expect(
      storage.fs.writeFile(path.join(base, "outside.txt"), new TextEncoder().encode("x")),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });
});
