import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DeterministicRandom, FakeClock } from "@untangle-code/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEmbeddingCacheKey, LocalEmbeddingCache } from "./embedding-cache.js";
import { LocalFileSystem } from "./local-file-system.js";

describe("buildEmbeddingCacheKey", () => {
  it("is exactly profileId + SHA256(preparedText) (spec.md §9.4)", () => {
    const key = buildEmbeddingCacheKey("profile-1", "hello world");
    expect(key.startsWith("profile-1")).toBe(true);
    expect(key.slice("profile-1".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and distinguishes different profiles/texts", () => {
    expect(buildEmbeddingCacheKey("p1", "text")).toBe(buildEmbeddingCacheKey("p1", "text"));
    expect(buildEmbeddingCacheKey("p1", "text")).not.toBe(buildEmbeddingCacheKey("p2", "text"));
    expect(buildEmbeddingCacheKey("p1", "text-a")).not.toBe(buildEmbeddingCacheKey("p1", "text-b"));
  });
});

describe("LocalEmbeddingCache", () => {
  let base: string;
  let cacheDir: string;
  let clock: FakeClock;
  let cache: LocalEmbeddingCache;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-embcache-"));
    cacheDir = path.join(base, "embeddings");
    const fs = new LocalFileSystem([base]);
    clock = new FakeClock(1_000);
    cache = new LocalEmbeddingCache(fs, cacheDir, clock, new DeterministicRandom(5));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("get() on an empty cache is a miss", async () => {
    expect(await cache.get("profile-1", "text")).toBeNull();
  });

  it("set() then get() round-trips the exact vector", async () => {
    await cache.set("profile-1", "text", [0.1, 0.2, 0.3]);
    expect(await cache.get("profile-1", "text")).toEqual([0.1, 0.2, 0.3]);
  });

  it("different prepared texts under the same profile are independent entries", async () => {
    await cache.set("profile-1", "text-a", [1, 0, 0]);
    await cache.set("profile-1", "text-b", [0, 1, 0]);
    expect(await cache.get("profile-1", "text-a")).toEqual([1, 0, 0]);
    expect(await cache.get("profile-1", "text-b")).toEqual([0, 1, 0]);
  });

  it("stats() reports entry count and total bytes", async () => {
    expect(await cache.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
    await cache.set("profile-1", "text", [1, 2, 3]);
    const stats = await cache.stats();
    expect(stats.entryCount).toBe(1);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it("clear() removes every entry", async () => {
    await cache.set("profile-1", "a", [1]);
    await cache.set("profile-1", "b", [2]);
    await cache.clear();
    expect(await cache.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
    expect(await cache.get("profile-1", "a")).toBeNull();
  });

  it("eviction keeps total bytes within maxBytes and drops the least-recently-used entry first", async () => {
    // Each entry's serialized size is deterministic and small; force eviction
    // with a tight byte budget so only two of three survive.
    const oneEntryBytes = Buffer.byteLength(
      JSON.stringify({ profileId: "p", vector: [0.123456, 0.234567, 0.345678] }),
    );
    const boundedCache = new LocalEmbeddingCache(
      new LocalFileSystem([base]),
      cacheDir,
      clock,
      new DeterministicRandom(6),
      { maxBytes: oneEntryBytes * 2 + 1 },
    );

    await boundedCache.set("p", "first", [0.123456, 0.234567, 0.345678]);
    clock.advance(10);
    await boundedCache.set("p", "second", [0.123456, 0.234567, 0.345678]);
    clock.advance(10);
    await boundedCache.set("p", "third", [0.123456, 0.234567, 0.345678]);

    const stats = await boundedCache.stats();
    expect(stats.totalBytes).toBeLessThanOrEqual(oneEntryBytes * 2 + 1);
    expect(stats.entryCount).toBe(2);
    // "first" was least recently used/written, so it must be the one evicted.
    expect(await boundedCache.get("p", "first")).toBeNull();
    expect(await boundedCache.get("p", "second")).toEqual([0.123456, 0.234567, 0.345678]);
    expect(await boundedCache.get("p", "third")).toEqual([0.123456, 0.234567, 0.345678]);
  });

  it("get() refreshes recency, protecting a recently-read entry from eviction", async () => {
    const oneEntryBytes = Buffer.byteLength(JSON.stringify({ profileId: "p", vector: [1, 2, 3] }));
    const boundedCache = new LocalEmbeddingCache(
      new LocalFileSystem([base]),
      cacheDir,
      clock,
      new DeterministicRandom(9),
      { maxBytes: oneEntryBytes * 2 + 1 },
    );

    await boundedCache.set("p", "first", [1, 2, 3]);
    clock.advance(10);
    await boundedCache.set("p", "second", [1, 2, 3]);
    clock.advance(10);
    // Touch "first" so it becomes more recently used than "second".
    await boundedCache.get("p", "first");
    clock.advance(10);
    await boundedCache.set("p", "third", [1, 2, 3]);

    expect(await boundedCache.get("p", "second")).toBeNull(); // now the LRU victim
    expect(await boundedCache.get("p", "first")).toEqual([1, 2, 3]);
    expect(await boundedCache.get("p", "third")).toEqual([1, 2, 3]);
  });

  it("a manifest referencing a deleted entry file self-heals to a miss", async () => {
    await cache.set("profile-1", "text", [1, 2, 3]);
    const shardDirs = await readdir(cacheDir);
    const entrySubdir = shardDirs.find((name) => name !== "index.json");
    expect(entrySubdir).toBeDefined();
    const entryDir = path.join(cacheDir, entrySubdir ?? "");
    const [entryFile] = await readdir(entryDir);
    await rm(path.join(entryDir, entryFile ?? ""));

    expect(await cache.get("profile-1", "text")).toBeNull();
    expect((await cache.stats()).entryCount).toBe(0);
  });

  it("a corrupted entry file degrades to a miss and self-heals the manifest", async () => {
    await cache.set("profile-1", "text", [1, 2, 3]);
    const shardDirs = await readdir(cacheDir);
    const entrySubdir = shardDirs.find((name) => name !== "index.json");
    const entryDir = path.join(cacheDir, entrySubdir ?? "");
    const [entryFile] = await readdir(entryDir);
    await writeFile(path.join(entryDir, entryFile ?? ""), "not json");

    expect(await cache.get("profile-1", "text")).toBeNull();
    expect((await cache.stats()).entryCount).toBe(0);
  });

  it("a corrupted manifest degrades to an empty cache rather than throwing", async () => {
    await cache.set("profile-1", "text", [1, 2, 3]);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "index.json"), "not json");

    // A fresh instance actually re-reads the manifest from disk.
    const freshCache = new LocalEmbeddingCache(
      new LocalFileSystem([base]),
      cacheDir,
      clock,
      new DeterministicRandom(8),
    );
    expect(await freshCache.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
    expect(await freshCache.get("profile-1", "text")).toBeNull();
  });

  it("respects an already-aborted signal on every method", async () => {
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    await expect(cache.get("p", "t", { signal })).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(cache.set("p", "t", [1], { signal })).rejects.toMatchObject({
      code: "JOB_CANCELLED",
    });
    await expect(cache.stats({ signal })).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(cache.clear({ signal })).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  });
});
