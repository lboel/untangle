import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildChunkCacheKey,
  buildMetricsCacheKey,
  buildParseCacheKey,
  type AnalysisIdentityKeyPartsV1,
} from "@untangle-code/domain";
import { DeterministicRandom, FakeClock } from "@untangle-code/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalAnalysisCache, LocalContentCache } from "./analysis-cache.js";
import { LocalFileSystem } from "./local-file-system.js";

const IDENTITY: AnalysisIdentityKeyPartsV1 = {
  workspaceId: "ws",
  repoId: "repo",
  refId: "repo:main",
  fileId: "file-1",
  filePath: "src/a.ts",
  languageId: "typescript",
};

describe("Schluessel der Analyse-Caches (WP-100)", () => {
  it("ist stabil bei gleichen Eingaben", () => {
    const input = { contentHash: "abc", parserVersion: "p1", identity: IDENTITY };
    expect(buildParseCacheKey(input)).toBe(buildParseCacheKey(input));
  });

  it("EINE Versionsaenderung macht den Eintrag unauffindbar — Parse", () => {
    const alt = buildParseCacheKey({ contentHash: "abc", parserVersion: "p1", identity: IDENTITY });
    const neu = buildParseCacheKey({ contentHash: "abc", parserVersion: "p2", identity: IDENTITY });
    expect(neu).not.toBe(alt);
  });

  it("EINE Versionsaenderung macht den Eintrag unauffindbar — Chunk", () => {
    const base = {
      contentHash: "abc",
      chunkerVersion: "c1",
      parserVersion: "p1",
      configFingerprint: "cfg",
      identity: IDENTITY,
    };
    expect(buildChunkCacheKey({ ...base, chunkerVersion: "c2" })).not.toBe(
      buildChunkCacheKey(base),
    );
    // Der Parser erzeugt die Regionen, aus denen die Chunks entstehen: auch
    // SEINE Version muss den Chunk-Eintrag verfallen lassen.
    expect(buildChunkCacheKey({ ...base, parserVersion: "p2" })).not.toBe(buildChunkCacheKey(base));
    expect(buildChunkCacheKey({ ...base, configFingerprint: "cfg2" })).not.toBe(
      buildChunkCacheKey(base),
    );
  });

  it("EINE Versionsaenderung macht den Eintrag unauffindbar — Metrik", () => {
    const base = {
      contentHash: "abc",
      metricsVersion: "m1",
      parserVersion: "p1",
      cognitiveAlgorithmId: "cog1",
      identity: IDENTITY,
    };
    expect(buildMetricsCacheKey({ ...base, metricsVersion: "m2" })).not.toBe(
      buildMetricsCacheKey(base),
    );
    expect(buildMetricsCacheKey({ ...base, parserVersion: "p2" })).not.toBe(
      buildMetricsCacheKey(base),
    );
    expect(buildMetricsCacheKey({ ...base, cognitiveAlgorithmId: "cog2" })).not.toBe(
      buildMetricsCacheKey(base),
    );
  });

  it("ein geaenderter Inhalt trifft einen anderen Eintrag", () => {
    expect(
      buildParseCacheKey({ contentHash: "abc", parserVersion: "p1", identity: IDENTITY }),
    ).not.toBe(buildParseCacheKey({ contentHash: "abd", parserVersion: "p1", identity: IDENTITY }));
  });

  it("eine andere Identitaet trifft einen anderen Eintrag (spec.md §5.5, §5.6)", () => {
    const anderer: AnalysisIdentityKeyPartsV1 = { ...IDENTITY, refId: "repo:zweig" };
    expect(
      buildParseCacheKey({ contentHash: "abc", parserVersion: "p1", identity: IDENTITY }),
    ).not.toBe(buildParseCacheKey({ contentHash: "abc", parserVersion: "p1", identity: anderer }));
  });

  it("die drei Arten teilen sich niemals einen Schluessel", () => {
    const parse = buildParseCacheKey({
      contentHash: "abc",
      parserVersion: "p1",
      identity: IDENTITY,
    });
    const chunk = buildChunkCacheKey({
      contentHash: "abc",
      chunkerVersion: "p1",
      parserVersion: "p1",
      configFingerprint: "p1",
      identity: IDENTITY,
    });
    const metrics = buildMetricsCacheKey({
      contentHash: "abc",
      metricsVersion: "p1",
      parserVersion: "p1",
      cognitiveAlgorithmId: "p1",
      identity: IDENTITY,
    });
    expect(new Set([parse, chunk, metrics]).size).toBe(3);
  });
});

describe("LocalContentCache", () => {
  let base: string;
  let dir: string;
  let fs: LocalFileSystem;
  let clock: FakeClock;
  let cache: LocalContentCache;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-analysis-cache-"));
    dir = path.join(base, "parse");
    fs = new LocalFileSystem([base]);
    clock = new FakeClock(1_000);
    cache = new LocalContentCache(fs, dir, clock, new DeterministicRandom(7));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("get() auf einem leeren Cache ist ein Fehlschlag", async () => {
    expect(await cache.get("k1")).toBeNull();
    expect((await cache.stats()).misses).toBe(1);
  });

  it("set() und get() liefern denselben Wert zurueck", async () => {
    await cache.set("k1", { v: 1, regions: [{ startLine: 1 }] });
    expect(await cache.get("k1")).toEqual({ v: 1, regions: [{ startLine: 1 }] });
  });

  it("meldet seine Trefferquote", async () => {
    await cache.set("k1", { v: 1 });
    await cache.get("k1");
    await cache.get("k2");
    const stats = await cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it("ueberlebt einen Neustart, sobald flush() gelaufen ist", async () => {
    await cache.set("k1", { v: 1, wert: "bleibt" });
    await cache.flush();
    const zweiter = new LocalContentCache(fs, dir, clock, new DeterministicRandom(7));
    expect(await zweiter.get("k1")).toEqual({ v: 1, wert: "bleibt" });
  });

  it("ohne flush() ist der Eintrag fuer einen neuen Leser nicht da — und das ist ein FEHLSCHLAG, kein falscher Wert", async () => {
    await cache.set("k1", { v: 1 });
    const zweiter = new LocalContentCache(fs, dir, clock, new DeterministicRandom(7));
    expect(await zweiter.get("k1")).toBeNull();
  });

  it("verdraengt den aeltesten Eintrag, wenn die Groessengrenze reisst", async () => {
    const klein = new LocalContentCache(
      fs,
      path.join(base, "klein"),
      clock,
      new DeterministicRandom(3),
      {
        maxBytes: 60,
      },
    );
    await klein.set("alt", { v: 1, fuellung: "aaaaaaaaaaaaaaaaaaaa" });
    clock.advance(1_000);
    await klein.set("neu", { v: 1, fuellung: "bbbbbbbbbbbbbbbbbbbb" });
    expect(await klein.get("alt")).toBeNull();
    expect(await klein.get("neu")).toEqual({ v: 1, fuellung: "bbbbbbbbbbbbbbbbbbbb" });
    expect((await klein.stats()).evictions).toBeGreaterThan(0);
  });

  it("ein beschaedigter Eintrag ist ein Fehlschlag, kein geworfener Fehler", async () => {
    await cache.set("k1", { v: 1 });
    await cache.flush();
    // Die Ablagedatei mutwillig zerstoeren.
    const shard = await import("node:fs/promises").then((m) => m.readdir(dir));
    const sub = shard.find((name) => name.length === 2);
    if (sub !== undefined) {
      const files = await import("node:fs/promises").then((m) => m.readdir(path.join(dir, sub)));
      for (const file of files) {
        await writeFile(path.join(dir, sub, file), "{kein json", "utf8");
      }
    }
    const zweiter = new LocalContentCache(fs, dir, clock, new DeterministicRandom(7));
    expect(await zweiter.get("k1")).toBeNull();
  });

  it("ein fehlendes Manifest ist ein leerer Cache, kein Fehler", async () => {
    await mkdir(dir, { recursive: true });
    const leer = new LocalContentCache(fs, dir, clock, new DeterministicRandom(7));
    expect(await leer.get("k1")).toBeNull();
    expect((await leer.stats()).entryCount).toBe(0);
  });

  it("clear() loescht nur das eigene Verzeichnis", async () => {
    await cache.set("k1", { v: 1 });
    await cache.flush();
    await cache.clear();
    expect(await cache.get("k1")).toBeNull();
  });
});

describe("LocalAnalysisCache", () => {
  it("haelt die drei Arten getrennt und meldet eine gemeinsame Quote", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "untangle-analysis-bundle-"));
    const fs = new LocalFileSystem([base]);
    const clock = new FakeClock(1_000);
    const bundle = new LocalAnalysisCache(
      new LocalContentCache(fs, path.join(base, "parse"), clock, new DeterministicRandom(1)),
      new LocalContentCache(fs, path.join(base, "chunk"), clock, new DeterministicRandom(2)),
      new LocalContentCache(fs, path.join(base, "metrics"), clock, new DeterministicRandom(3)),
    );
    // Derselbe Schluessel in zwei Arten darf sich NICHT ins Gehege kommen.
    await bundle.set("parse", "same-key", { v: 1, art: "parse" });
    await bundle.set("chunk", "same-key", { v: 1, art: "chunk" });
    expect(await bundle.get("parse", "same-key")).toEqual({ v: 1, art: "parse" });
    expect(await bundle.get("chunk", "same-key")).toEqual({ v: 1, art: "chunk" });
    expect(await bundle.get("metrics", "same-key")).toBeNull();

    const stats = await bundle.stats();
    expect(stats.totalHits).toBe(2);
    expect(stats.totalMisses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 10);

    await bundle.flush();
    await rm(base, { recursive: true, force: true });
  });
});
