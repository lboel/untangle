import { describe, expect, it } from "vitest";

import { InMemoryEmbeddingCache } from "./cache.js";

describe("InMemoryEmbeddingCache", () => {
  it("returns null for a key that was never set", async () => {
    const cache = new InMemoryEmbeddingCache();
    const result = await cache.get({ embeddingProfileId: "p1", preparedTextHash: "h1" });
    expect(result).toBeNull();
  });

  it("round-trips a set entry", async () => {
    const cache = new InMemoryEmbeddingCache();
    const key = { embeddingProfileId: "p1", preparedTextHash: "h1" };
    await cache.set(key, { vector: [1, 2, 3], truncated: true });
    expect(await cache.get(key)).toEqual({ vector: [1, 2, 3], truncated: true });
  });

  it("keys on both embeddingProfileId and preparedTextHash — neither alone collides", async () => {
    const cache = new InMemoryEmbeddingCache();
    await cache.set(
      { embeddingProfileId: "p1", preparedTextHash: "h1" },
      { vector: [1], truncated: false },
    );
    await cache.set(
      { embeddingProfileId: "p2", preparedTextHash: "h1" },
      { vector: [2], truncated: false },
    );
    await cache.set(
      { embeddingProfileId: "p1", preparedTextHash: "h2" },
      { vector: [3], truncated: false },
    );

    expect(await cache.get({ embeddingProfileId: "p1", preparedTextHash: "h1" })).toEqual({
      vector: [1],
      truncated: false,
    });
    expect(await cache.get({ embeddingProfileId: "p2", preparedTextHash: "h1" })).toEqual({
      vector: [2],
      truncated: false,
    });
    expect(await cache.get({ embeddingProfileId: "p1", preparedTextHash: "h2" })).toEqual({
      vector: [3],
      truncated: false,
    });
  });

  it("overwrites an existing entry on a second set for the same key", async () => {
    const cache = new InMemoryEmbeddingCache();
    const key = { embeddingProfileId: "p1", preparedTextHash: "h1" };
    await cache.set(key, { vector: [1], truncated: false });
    await cache.set(key, { vector: [2], truncated: true });
    expect(await cache.get(key)).toEqual({ vector: [2], truncated: true });
    expect(cache.size).toBe(1);
  });
});
