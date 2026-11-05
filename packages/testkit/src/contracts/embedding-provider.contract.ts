/**
 * Port-contract suite for `EmbeddingProvider` (domain `ports.ts`, spec.md
 * §9).
 *
 * Determinism is asserted via cosine similarity, not exact equality:
 * `DeterministicEmbedder` is bit-exact, but a real model-backed adapter
 * (Ollama) is only PRACTICALLY deterministic (same text, same model, same
 * host) — asserting bit-for-bit equality would make the suite needlessly
 * adapter-specific. A near-1 cosine similarity threshold captures the
 * meaningful guarantee ("the same text embeds to essentially the same
 * vector") without over-fitting to the fake.
 */
import type { EmbeddingProvider } from "@untangle-code/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { cosineSimilarity } from "../math.js";

export function runEmbeddingProviderContract(
  factory: () => EmbeddingProvider | Promise<EmbeddingProvider>,
): void {
  describe("EmbeddingProvider port contract", () => {
    let provider: EmbeddingProvider;

    beforeEach(async () => {
      provider = await factory();
    });

    it("exposes a profile and a profileId consistent with each other", () => {
      expect(provider.profile).toBeDefined();
      expect(typeof provider.profileId).toBe("string");
      expect(provider.profileId.length).toBeGreaterThan(0);
    });

    it("ensureReady reports the profile's own dimensions and is idempotent", async () => {
      const first = await provider.ensureReady();
      expect(first.dimensions).toBe(provider.profile.dimensions);
      expect(typeof first.model).toBe("string");
      const second = await provider.ensureReady();
      expect(second.dimensions).toBe(first.dimensions);
    });

    it("embedDocuments returns one vector of the profile's dimensionality per input, in order", async () => {
      const texts = [
        "repository: a\npath: x.ts\n\nfunction a() {}",
        "repository: a\npath: y.ts\n\nfunction b() {}",
      ];
      const result = await provider.embedDocuments(texts);
      expect(result.vectors).toHaveLength(texts.length);
      expect(result.truncated).toHaveLength(texts.length);
      for (const vector of result.vectors) {
        expect(vector).toHaveLength(provider.profile.dimensions);
      }
    });

    it("embedDocuments handles an empty batch without error", async () => {
      const result = await provider.embedDocuments([]);
      expect(result.vectors).toEqual([]);
      expect(result.truncated).toEqual([]);
    });

    it("embedQuery returns a vector of the profile's dimensionality", async () => {
      const vector = await provider.embedQuery("search_query: find the parser entry point");
      expect(vector).toHaveLength(provider.profile.dimensions);
    });

    it("the same text embeds to (near-)identical vectors across two calls", async () => {
      const text = "search_document: export function parseModule(source: string): Module";
      const a = await provider.embedQuery(text);
      const b = await provider.embedQuery(text);
      expect(cosineSimilarity(a, b)).toBeGreaterThanOrEqual(0.999);
    });

    it("embedDocuments and embedQuery agree on the same text", async () => {
      const text = "search_document: class Repository { save(entity: Entity): void {} }";
      const [fromBatch] = (await provider.embedDocuments([text])).vectors;
      const fromQuery = await provider.embedQuery(text);
      expect(cosineSimilarity(fromBatch ?? [], fromQuery)).toBeGreaterThanOrEqual(0.999);
    });

    describe("AbortSignal (spec.md §22)", () => {
      it("rejects every method when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const signal = controller.signal;
        await expect(provider.ensureReady({ signal })).rejects.toBeDefined();
        await expect(provider.embedQuery("x", { signal })).rejects.toBeDefined();
        await expect(provider.embedDocuments(["x"], { signal })).rejects.toBeDefined();
      });
    });
  });
}
