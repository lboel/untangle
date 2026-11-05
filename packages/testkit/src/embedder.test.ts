import { buildEmbeddingProfileId } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE,
  DeterministicEmbedder,
  embedTextDeterministically,
  hashTokenToDimension,
  hashTokenToSign,
} from "./embedder.js";
import { FakeClock } from "./in-memory/clock.js";
import { cosineSimilarity, l2Norm } from "./math.js";

describe("embedTextDeterministically", () => {
  it("preserves v1 dense vectors when lexical identifier splitting changes", () => {
    expect(embedTextDeterministically("getUserById", 64)).toEqual(
      embedTextDeterministically("getuserbyid", 64),
    );
    expect(embedTextDeterministically("get_user_by_id", 64)).toEqual(
      embedTextDeterministically("get user by id", 64),
    );
  });

  it("is reproducible: same text yields a bit-identical vector across independent calls", () => {
    const a = embedTextDeterministically("the quick brown fox", 32);
    const b = embedTextDeterministically("the quick brown fox", 32);
    expect(a).toEqual(b);
  });

  it("produces a vector of exactly the requested dimensionality", () => {
    expect(embedTextDeterministically("hello world", 16)).toHaveLength(16);
    expect(embedTextDeterministically("hello world", 128)).toHaveLength(128);
  });

  it("is L2-normalized (unit length) for non-empty text", () => {
    const vector = embedTextDeterministically("some reasonably long piece of text", 32);
    expect(l2Norm(vector)).toBeCloseTo(1, 10);
  });

  it("returns an all-zero vector for empty text rather than NaN", () => {
    const vector = embedTextDeterministically("", 8);
    expect(vector).toEqual(new Array(8).fill(0));
  });

  it("gives near-duplicate texts a much higher cosine similarity than unrelated texts", () => {
    const base = embedTextDeterministically(
      "function calculateTotalPrice(items) { return items.reduce((a, b) => a + b.price, 0); }",
      64,
    );
    const nearDuplicate = embedTextDeterministically(
      "function calculateTotalPrice(items) { return items.reduce((sum, b) => sum + b.price, 0); }",
      64,
    );
    const unrelated = embedTextDeterministically(
      "class DatabaseConnectionPool implements resource lifecycle management for pooled sockets",
      64,
    );
    const similarSimilarity = cosineSimilarity(base, nearDuplicate);
    const unrelatedSimilarity = cosineSimilarity(base, unrelated);
    expect(similarSimilarity).toBeGreaterThan(unrelatedSimilarity);
    expect(similarSimilarity).toBeGreaterThan(0.7);
  });

  it("rejects a non-positive or non-integer dimensions argument", () => {
    expect(() => embedTextDeterministically("x", 0)).toThrow();
    expect(() => embedTextDeterministically("x", -3)).toThrow();
    expect(() => embedTextDeterministically("x", 1.5)).toThrow();
  });
});

describe("hashTokenToDimension / hashTokenToSign", () => {
  it("hashTokenToDimension is deterministic and within range", () => {
    const dim = hashTokenToDimension("example", 10);
    expect(dim).toBe(hashTokenToDimension("example", 10));
    expect(dim).toBeGreaterThanOrEqual(0);
    expect(dim).toBeLessThan(10);
  });

  it("hashTokenToSign is deterministic and is either -1 or 1", () => {
    const sign = hashTokenToSign("example");
    expect(sign).toBe(hashTokenToSign("example"));
    expect([1, -1]).toContain(sign);
  });
});

describe("DeterministicEmbedder", () => {
  it("profileId matches buildEmbeddingProfileId(profile)", () => {
    const embedder = new DeterministicEmbedder(new FakeClock(0));
    expect(embedder.profileId).toBe(
      buildEmbeddingProfileId(DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE),
    );
  });

  it("ensureReady reports the profile's model and dimensions, using the injected Clock", async () => {
    const clock = new FakeClock(12_345);
    const embedder = new DeterministicEmbedder(clock);
    const readiness = await embedder.ensureReady();
    expect(readiness.model).toBe(DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE.model);
    expect(readiness.dimensions).toBe(DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE.dimensions);
    expect(readiness.probedAt).toBe(clock.nowIso());
  });

  it("embedDocuments returns one vector per input, in order, with truncated=false for each", async () => {
    const embedder = new DeterministicEmbedder(new FakeClock(0));
    const result = await embedder.embedDocuments(["alpha beta", "gamma delta", "epsilon"]);
    expect(result.vectors).toHaveLength(3);
    expect(result.truncated).toEqual([false, false, false]);
    for (const vector of result.vectors) {
      expect(vector).toHaveLength(DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE.dimensions);
    }
    // Same text embedded via embedQuery must match embedDocuments' entry for it.
    expect(result.vectors[0]).toEqual(await embedder.embedQuery("alpha beta"));
  });

  it("honors a custom profile's dimensions", async () => {
    const embedder = new DeterministicEmbedder(new FakeClock(0), {
      ...DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE,
      dimensions: 8,
    });
    expect(await embedder.embedQuery("hello")).toHaveLength(8);
  });

  it("rejects a non-positive profile.dimensions at construction time", () => {
    expect(
      () =>
        new DeterministicEmbedder(new FakeClock(0), {
          ...DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE,
          dimensions: 0,
        }),
    ).toThrow();
  });

  it("respects an already-aborted signal on every method", async () => {
    const embedder = new DeterministicEmbedder(new FakeClock(0));
    const controller = new AbortController();
    controller.abort();
    await expect(embedder.ensureReady({ signal: controller.signal })).rejects.toThrow();
    await expect(embedder.embedQuery("x", { signal: controller.signal })).rejects.toThrow();
    await expect(embedder.embedDocuments(["x"], { signal: controller.signal })).rejects.toThrow();
  });
});
