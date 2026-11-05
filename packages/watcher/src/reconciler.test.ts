import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { defaultContentHasher } from "./content-hash.js";
import { evaluatePath, reconcileTree } from "./reconciler.js";
import type { WatchedFileSnapshotV1 } from "./types.js";

function setup(): { clock: FakeClock; fs: MemoryFileSystem } {
  const clock = new FakeClock(1_000);
  const fs = new MemoryFileSystem(clock);
  fs.seedDirectory("/repo");
  return { clock, fs };
}

describe("reconcileTree", () => {
  it("reports every file as added when the snapshot starts empty", async () => {
    const { fs } = setup();
    fs.seedFile("/repo/a.ts", "export const a = 1;");
    fs.seedFile("/repo/b.ts", "export const b = 2;");
    const snapshots = new Map<string, WatchedFileSnapshotV1>();

    const events = await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });

    expect(events.map((e) => e.relativePath).sort()).toEqual(["a.ts", "b.ts"]);
    expect(events.every((e) => e.changeKind === "added")).toBe(true);
    expect(snapshots.size).toBe(2);
  });

  it("finds a change the native watcher slept through (size/mtime unchanged, content hash differs)", async () => {
    const { fs } = setup();
    fs.seedFile("/repo/a.ts", "export const a = 1;");
    const snapshots = new Map<string, WatchedFileSnapshotV1>();

    // Baseline pass — establishes the snapshot.
    await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });
    const baseline = snapshots.get("a.ts");
    expect(baseline).toBeDefined();

    // Simulate a missed native event: the content changes to a
    // same-length replacement WITHOUT advancing the clock, so size and
    // mtime are byte-for-byte identical to the snapshot — only the content
    // hash can catch this (spec.md §12.1: "Nur der Content Hash darf den
    // endgültigen Unchanged-Status bestimmen").
    fs.seedFile("/repo/a.ts", "export const a = 9;");
    const statAfter = await fs.stat("/repo/a.ts");
    expect(statAfter?.sizeBytes).toBe(baseline?.sizeBytes);
    expect(statAfter?.mtimeEpochMs).toBe(baseline?.mtimeEpochMs);

    const events = await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });

    expect(events).toEqual([
      expect.objectContaining({ changeKind: "modified", relativePath: "a.ts" }),
    ]);
    expect(snapshots.get("a.ts")?.contentHash).not.toBe(baseline?.contentHash);
  });

  it("reports a snapshot entry no longer on disk as deleted", async () => {
    const { fs } = setup();
    fs.seedFile("/repo/a.ts", "export const a = 1;");
    const snapshots = new Map<string, WatchedFileSnapshotV1>();
    await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });

    await fs.remove("/repo/a.ts");
    const events = await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });

    expect(events).toEqual([{ changeKind: "deleted", relativePath: "a.ts" }]);
    expect(snapshots.has("a.ts")).toBe(false);
  });

  it("reports nothing when content is genuinely unchanged", async () => {
    const { fs } = setup();
    fs.seedFile("/repo/a.ts", "export const a = 1;");
    const snapshots = new Map<string, WatchedFileSnapshotV1>();
    await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });

    const events = await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });

    expect(events).toEqual([]);
  });

  it("skips ignored paths entirely, in both directions", async () => {
    const { fs } = setup();
    fs.seedDirectory("/repo/node_modules");
    fs.seedFile("/repo/node_modules/lib.js", "noise");
    fs.seedFile("/repo/a.ts", "export const a = 1;");
    const snapshots = new Map<string, WatchedFileSnapshotV1>();

    const events = await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: (p) => p === "node_modules" || p.startsWith("node_modules/"),
    });

    expect(events.map((e) => e.relativePath)).toEqual(["a.ts"]);
    expect(snapshots.has("node_modules/lib.js")).toBe(false);
  });

  it("walks nested directories recursively", async () => {
    const { fs } = setup();
    fs.seedDirectory("/repo/src");
    fs.seedDirectory("/repo/src/nested");
    fs.seedFile("/repo/src/nested/deep.ts", "export const deep = true;");
    const snapshots = new Map<string, WatchedFileSnapshotV1>();

    const events = await reconcileTree({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      snapshots,
      ignore: () => false,
    });

    expect(events.map((e) => e.relativePath)).toEqual(["src/nested/deep.ts"]);
  });
});

describe("evaluatePath", () => {
  it("returns null and leaves the snapshot untouched for a path that never existed", async () => {
    const { fs } = setup();
    const snapshots = new Map<string, WatchedFileSnapshotV1>();

    const event = await evaluatePath({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      relativePath: "missing.ts",
      snapshots,
    });

    expect(event).toBeNull();
    expect(snapshots.size).toBe(0);
  });

  it("classifies a first sighting as added", async () => {
    const { fs } = setup();
    fs.seedFile("/repo/a.ts", "content");
    const snapshots = new Map<string, WatchedFileSnapshotV1>();

    const event = await evaluatePath({
      fs,
      hasher: defaultContentHasher,
      rootPath: "/repo",
      relativePath: "a.ts",
      snapshots,
    });

    expect(event?.changeKind).toBe("added");
  });
});
