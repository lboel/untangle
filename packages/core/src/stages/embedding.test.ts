import {
  UntangleError,
  type EmbeddingBatchResultV1,
  type EmbeddingProvider,
  type PortCallOptions,
} from "@untangle-code/domain";
import type { AnalyzedFileV1, PreparedTextV1 } from "@untangle-code/jobs";
import { describe, expect, it, vi } from "vitest";

import { OFFLINE_EMBEDDING_PROFILE } from "../offline-embedder.js";
import type { EmbeddingCacheLike } from "../types.js";

import { createEmbeddingStage, type EmbeddingStageDeps } from "./embedding.js";

function makeHarness() {
  const embedDocuments = vi.fn<EmbeddingProvider["embedDocuments"]>();
  embedDocuments.mockImplementation(async (texts) => ({
    vectors: texts.map((_, index) => [index, index + 1]),
    truncated: texts.map(() => false),
  }));
  const embedder: EmbeddingProvider = {
    profile: { ...OFFLINE_EMBEDDING_PROFILE, dimensions: 2 },
    profileId: "provider-profile",
    ensureReady: vi.fn<EmbeddingProvider["ensureReady"]>(),
    embedQuery: vi.fn<EmbeddingProvider["embedQuery"]>(),
    embedDocuments,
  };
  const cache = {
    get: vi.fn<EmbeddingCacheLike["get"]>().mockResolvedValue(null),
    set: vi.fn<EmbeddingCacheLike["set"]>().mockResolvedValue(undefined),
  };
  const counts = { cacheHits: 11, computed: 7, truncated: 13 };
  const initialCounts = { ...counts };
  const deps: EmbeddingStageDeps = {
    embedder,
    embeddingProfileId: "selected-profile",
    dimensions: 2,
    counts,
  };
  return { deps, counts, initialCounts, embedder, embedDocuments, cache };
}

function analyzedFile(fileId: string, preparedTexts: PreparedTextV1[]): AnalyzedFileV1 {
  return {
    file: { fileId, filePath: `${fileId}.ts`, contentHash: `hash-${fileId}` },
    preparedTexts,
    parseQuality: "complete",
    chunkCount: preparedTexts.length,
    symbolCount: 0,
    estimatedBytes: 0,
  };
}

function cancelledError(kind: "job" | "abort"): Error {
  return kind === "job"
    ? new UntangleError("JOB_CANCELLED", "cancelled")
    : Object.assign(new Error("cancelled"), { name: "AbortError" });
}

describe("createEmbeddingStage", () => {
  it.each([false, true])(
    "returns an empty batch without ports or count changes (file=%s)",
    async (withFile) => {
      const harness = makeHarness();
      harness.deps.cache = harness.cache;
      const batch = withFile ? [analyzedFile("empty", [])] : [];
      const controller = new AbortController();
      controller.abort();

      const result = await createEmbeddingStage(harness.deps).embedBatch(batch, {
        signal: controller.signal,
      });

      expect(result).toEqual({
        files: batch.map((item) => item.file),
        points: [],
        cacheHits: 0,
        truncatedCount: 0,
        estimatedBytes: 0,
      });
      if (withFile) expect(result.files[0]).toBe(batch[0]?.file);
      expect(harness.cache.get).not.toHaveBeenCalled();
      expect(harness.cache.set).not.toHaveBeenCalled();
      expect(harness.embedDocuments).not.toHaveBeenCalled();
      expect(harness.counts).toEqual(harness.initialCounts);
    },
  );

  it("preserves file and point order, duplicate texts, reference identity, and UTF-16 byte estimates", async () => {
    const harness = makeHarness();
    const firstPayload = { source: "first", embedding_truncated: false };
    const secondPayload = { source: "second", embedding_truncated: true };
    const first = analyzedFile("first", [
      { pointId: "a", text: "same", payload: firstPayload },
      { pointId: "b", text: "same" },
    ]);
    const second = analyzedFile("second", [{ pointId: "c", text: "😀", payload: secondPayload }]);
    const vectors = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    harness.embedDocuments.mockResolvedValue({ vectors, truncated: [true] });
    const options: PortCallOptions = { signal: new AbortController().signal };
    const stage = createEmbeddingStage(harness.deps);

    const result = await stage.embedBatch([first, second], options);

    expect(harness.embedDocuments).toHaveBeenCalledExactlyOnceWith(["same", "same", "😀"], options);
    expect(harness.embedDocuments.mock.calls[0]?.[1]).toBe(options);
    expect(harness.embedder.ensureReady).not.toHaveBeenCalled();
    expect(harness.embedder.embedQuery).not.toHaveBeenCalled();
    expect(result.files[0]).toBe(first.file);
    expect(result.files[1]).toBe(second.file);
    expect(result.points).toEqual([
      { pointId: "a", fileId: "first", vector: vectors[0], payload: firstPayload },
      { pointId: "b", fileId: "first", vector: vectors[1] },
      { pointId: "c", fileId: "second", vector: vectors[2], payload: secondPayload },
    ]);
    expect(result.points[0]?.vector).toBe(vectors[0]);
    expect(result.points[0]?.payload).toBe(firstPayload);
    expect(result.points[2]?.payload).toBe(secondPayload);
    expect(firstPayload.embedding_truncated).toBe(true);
    expect(secondPayload.embedding_truncated).toBe(false);
    expect(result).toMatchObject({ cacheHits: 0, truncatedCount: 1, estimatedBytes: 68 });
    expect(harness.counts).toEqual({ cacheHits: 11, computed: 10, truncated: 14 });

    await stage.embedBatch([first, second]);
    expect(harness.counts).toEqual({ cacheHits: 11, computed: 13, truncated: 15 });
  });

  it("reads every cache entry before embedding misses and writes sequentially before publishing counts or payloads", async () => {
    const harness = makeHarness();
    harness.deps.cache = harness.cache;
    const events: string[] = [];
    const payload = { embedding_truncated: "unchanged" };
    const cachedVector = [9];
    const batch = [
      analyzedFile("file", [
        { pointId: "hit", text: "cached", payload },
        { pointId: "miss-1", text: "same" },
        { pointId: "miss-2", text: "same" },
      ]),
    ];
    const options: PortCallOptions = { signal: new AbortController().signal };
    harness.cache.get.mockImplementation(async (_profile, text, receivedOptions) => {
      expect(receivedOptions).toBe(options);
      events.push(`get:${text}`);
      return text === "cached" ? cachedVector : null;
    });
    const vectors = [
      [1, 2],
      [3, 4],
    ];
    harness.embedDocuments.mockImplementation(async (texts, receivedOptions) => {
      expect(receivedOptions).toBe(options);
      events.push(`embed:${texts.join(",")}`);
      return { vectors, truncated: [true, false] };
    });
    harness.cache.set.mockImplementation(async (profile, text, vector, receivedOptions) => {
      expect(profile).toBe("selected-profile");
      expect(receivedOptions).toBe(options);
      expect(harness.counts).toEqual(harness.initialCounts);
      expect(payload.embedding_truncated).toBe("unchanged");
      events.push(`set:${text}:${vector.join(",")}`);
    });

    const result = await createEmbeddingStage(harness.deps).embedBatch(batch, options);

    expect(events).toEqual([
      "get:cached",
      "get:same",
      "get:same",
      "embed:same,same",
      "set:same:1,2",
      "set:same:3,4",
    ]);
    expect(harness.cache.get.mock.calls.map((call) => call[0])).toEqual([
      "selected-profile",
      "selected-profile",
      "selected-profile",
    ]);
    expect(harness.cache.set.mock.calls[0]?.[2]).toBe(vectors[0]);
    expect(result.points[0]?.vector).toBe(cachedVector);
    expect(result.points.map((point) => point.pointId)).toEqual(["hit", "miss-1", "miss-2"]);
    expect(payload.embedding_truncated).toBe(false);
    expect(result).toMatchObject({ cacheHits: 1, truncatedCount: 1, estimatedBytes: 68 });
    expect(harness.counts).toEqual({ cacheHits: 12, computed: 9, truncated: 14 });
  });

  it("uses cached vectors without dimension checks or remembered truncation and skips the provider", async () => {
    const harness = makeHarness();
    harness.deps.cache = harness.cache;
    const vector = [4];
    harness.cache.get.mockResolvedValue(vector);
    const payload = { embedding_truncated: true };

    const result = await createEmbeddingStage(harness.deps).embedBatch([
      analyzedFile("file", [{ pointId: "point", text: "cached", payload }]),
    ]);

    expect(harness.embedDocuments).not.toHaveBeenCalled();
    expect(harness.cache.set).not.toHaveBeenCalled();
    expect(result.points[0]?.vector).toBe(vector);
    expect(result).toMatchObject({ cacheHits: 1, truncatedCount: 0, estimatedBytes: 20 });
    expect(payload.embedding_truncated).toBe(false);
    expect(harness.counts).toEqual({ cacheHits: 12, computed: 7, truncated: 13 });
  });

  it.each([new Error("cache unavailable"), "cache unavailable"])(
    "recomputes after an ordinary cache read failure (%s)",
    async (failure) => {
      const harness = makeHarness();
      harness.deps.cache = harness.cache;
      harness.cache.get.mockResolvedValueOnce([8, 9]).mockRejectedValueOnce(failure);
      const batch = [
        analyzedFile("file", [
          { pointId: "a", text: "hit" },
          { pointId: "b", text: "miss" },
        ]),
      ];

      const result = await createEmbeddingStage(harness.deps).embedBatch(batch);

      expect(harness.embedDocuments).toHaveBeenCalledExactlyOnceWith(["miss"], undefined);
      expect(harness.cache.set).toHaveBeenCalledExactlyOnceWith(
        "selected-profile",
        "miss",
        [0, 1],
        undefined,
      );
      expect(result.cacheHits).toBe(1);
      expect(harness.counts).toEqual({ cacheHits: 12, computed: 8, truncated: 13 });
    },
  );

  it("continues after ordinary cache write failures without changing write order", async () => {
    const harness = makeHarness();
    harness.deps.cache = harness.cache;
    harness.cache.set.mockRejectedValueOnce(new Error("read-only cache"));

    const result = await createEmbeddingStage(harness.deps).embedBatch([
      analyzedFile("file", [
        { pointId: "a", text: "first" },
        { pointId: "b", text: "second" },
      ]),
    ]);

    expect(harness.cache.set.mock.calls.map((call) => call[1])).toEqual(["first", "second"]);
    expect(result.points).toHaveLength(2);
    expect(harness.counts).toEqual({ cacheHits: 11, computed: 9, truncated: 13 });
  });

  it.each([new Error("provider offline"), "provider offline"])(
    "wraps provider failure without publishing a partial batch or accumulated counts (%s)",
    async (failure) => {
      const harness = makeHarness();
      harness.deps.cache = harness.cache;
      harness.cache.get.mockResolvedValueOnce([8, 9]).mockResolvedValueOnce(null);
      harness.embedDocuments.mockRejectedValue(failure);
      const payload = { embedding_truncated: "unchanged" };
      const batch = [
        analyzedFile("file", [
          { pointId: "a", text: "hit", payload },
          { pointId: "b", text: "miss" },
        ]),
      ];

      await expect(createEmbeddingStage(harness.deps).embedBatch(batch)).rejects.toMatchObject({
        code: "EMBEDDING_UNAVAILABLE",
        message: "The embedder returned no result for 1 texts: provider offline",
        retryable: true,
        operation: "index.embed",
        context: { textCount: 1 },
        cause: failure,
      });
      expect(harness.cache.set).not.toHaveBeenCalled();
      expect(payload.embedding_truncated).toBe("unchanged");
      expect(harness.counts).toEqual(harness.initialCounts);
    },
  );

  it.each([1, 3])(
    "rejects the wrong provider vector count before any cache write (count=%s)",
    async (count) => {
      const harness = makeHarness();
      harness.deps.cache = harness.cache;
      harness.embedDocuments.mockResolvedValue({
        vectors: Array.from({ length: count }, () => [1, 2]),
        truncated: [],
      });
      const payload = { embedding_truncated: "unchanged" };

      await expect(
        createEmbeddingStage(harness.deps).embedBatch([
          analyzedFile("file", [
            { pointId: "a", text: "first", payload },
            { pointId: "b", text: "second" },
          ]),
        ]),
      ).rejects.toMatchObject({
        code: "EMBEDDING_UNAVAILABLE",
        message: `The embedder returned ${String(count)} vectors for 2 texts.`,
        retryable: false,
        operation: "index.embed",
      });
      expect(harness.cache.set).not.toHaveBeenCalled();
      expect(payload.embedding_truncated).toBe("unchanged");
      expect(harness.counts).toEqual(harness.initialCounts);
    },
  );

  it.each([0, 1])(
    "rejects a dimension mismatch after only earlier valid vectors have been cached (position=%s)",
    async (invalidPosition) => {
      const harness = makeHarness();
      harness.deps.cache = harness.cache;
      const vectors = [
        [1, 2],
        [3, 4],
      ];
      vectors[invalidPosition] = [5];
      harness.embedDocuments.mockResolvedValue({ vectors, truncated: [true, false] });
      const payload = { embedding_truncated: "unchanged" };

      await expect(
        createEmbeddingStage(harness.deps).embedBatch([
          analyzedFile("file", [
            { pointId: "a", text: "first", payload },
            { pointId: "b", text: "second" },
          ]),
        ]),
      ).rejects.toMatchObject({
        code: "EMBEDDING_DIMENSION_MISMATCH",
        message: "The embedder returned a vector with length 1, the collection expects 2.",
        retryable: false,
        operation: "index.embed",
      });
      expect(harness.cache.set).toHaveBeenCalledTimes(invalidPosition);
      if (invalidPosition === 1) {
        expect(harness.cache.set).toHaveBeenCalledWith(
          "selected-profile",
          "first",
          vectors[0],
          undefined,
        );
      }
      expect(payload.embedding_truncated).toBe("unchanged");
      expect(harness.counts).toEqual(harness.initialCounts);
    },
  );

  it.each([
    ["read", "job", true],
    ["read", "abort", true],
    ["provider", "job", true],
    ["provider", "abort", true],
    ["write", "job", true],
    ["write", "abort", true],
    ["read", "job", false],
    ["read", "abort", false],
    ["provider", "job", false],
    ["provider", "abort", false],
    ["write", "job", false],
    ["write", "abort", false],
  ] as const)(
    "propagates the original cancellation at %s (%s, signalAborted=%s) and stops subsequent effects",
    async (phase, kind, abortSignal) => {
      const harness = makeHarness();
      harness.deps.cache = harness.cache;
      const failure = cancelledError(kind);
      const payload = { embedding_truncated: "unchanged" };
      const batch = [
        analyzedFile("file", [
          { pointId: "a", text: "first", payload },
          { pointId: "b", text: "second" },
          { pointId: "c", text: "third" },
        ]),
      ];
      const controller = new AbortController();
      const options: PortCallOptions = { signal: controller.signal };
      if (phase === "read") {
        harness.cache.get.mockResolvedValueOnce([8, 9]).mockImplementationOnce(async () => {
          if (abortSignal) controller.abort(failure);
          throw failure;
        });
      } else if (phase === "provider") {
        harness.embedDocuments.mockImplementation(async () => {
          if (abortSignal) controller.abort(failure);
          throw failure;
        });
      } else {
        harness.cache.set
          .mockImplementationOnce(async () => undefined)
          .mockImplementationOnce(async () => {
            if (abortSignal) controller.abort(failure);
            throw failure;
          });
      }

      await expect(createEmbeddingStage(harness.deps).embedBatch(batch, options)).rejects.toBe(
        failure,
      );

      expect(harness.cache.get).toHaveBeenCalledTimes(phase === "read" ? 2 : 3);
      expect(harness.embedDocuments).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
      expect(harness.cache.set).toHaveBeenCalledTimes(phase === "write" ? 2 : 0);
      for (const call of harness.cache.get.mock.calls) expect(call[2]).toBe(options);
      for (const call of harness.embedDocuments.mock.calls) expect(call[1]).toBe(options);
      for (const call of harness.cache.set.mock.calls) expect(call[3]).toBe(options);
      expect(controller.signal.aborted).toBe(abortSignal);
      expect(payload.embedding_truncated).toBe("unchanged");
      expect(harness.counts).toEqual(harness.initialCounts);
    },
  );

  it("starts the provider before a caller can immediately abort a batch without a cache", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const events: string[] = [];
    harness.embedDocuments.mockImplementation(async (_texts, receivedOptions) => {
      expect(receivedOptions).toBe(options);
      events.push(`provider:${String(controller.signal.aborted)}`);
      receivedOptions?.signal?.throwIfAborted();
      return { vectors: [[1, 2]], truncated: [false] };
    });

    const promise = createEmbeddingStage(harness.deps).embedBatch(
      [analyzedFile("file", [{ pointId: "point", text: "text" }])],
      options,
    );
    events.push("caller-abort");
    controller.abort(cancelledError("abort"));

    const result = await promise;
    expect(events).toEqual(["provider:false", "caller-abort"]);
    expect(result.points).toHaveLength(1);
    expect(harness.counts).toEqual({ cacheHits: 11, computed: 8, truncated: 13 });
  });

  it.each(["miss", "failure"] as const)(
    "starts the provider after a cache %s before a later queued caller abort",
    async (cacheResult) => {
      const harness = makeHarness();
      harness.deps.cache = harness.cache;
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const events: string[] = [];
      harness.cache.get.mockImplementation(async (_profile, _text, receivedOptions) => {
        expect(receivedOptions).toBe(options);
        events.push(`get:${String(controller.signal.aborted)}`);
        receivedOptions?.signal?.throwIfAborted();
        if (cacheResult === "failure") throw new Error("cache unavailable");
        return null;
      });
      harness.embedDocuments.mockImplementation(async (_texts, receivedOptions) => {
        expect(receivedOptions).toBe(options);
        events.push(`provider:${String(controller.signal.aborted)}`);
        receivedOptions?.signal?.throwIfAborted();
        return { vectors: [[1, 2]], truncated: [false] };
      });
      harness.cache.set.mockImplementation(async (_profile, _text, _vector, receivedOptions) => {
        expect(receivedOptions).toBe(options);
        events.push(`set:${String(controller.signal.aborted)}`);
      });

      const promise = createEmbeddingStage(harness.deps).embedBatch(
        [analyzedFile("file", [{ pointId: "point", text: "text" }])],
        options,
      );
      queueMicrotask(() => {
        events.push("caller-abort");
        controller.abort(cancelledError("abort"));
      });

      const result = await promise;
      expect(events).toEqual(["get:false", "provider:false", "caller-abort", "set:true"]);
      expect(result.points).toHaveLength(1);
      expect(harness.counts).toEqual({ cacheHits: 11, computed: 8, truncated: 13 });
    },
  );

  it("starts each cache read at the original await boundaries for an all-hit batch", async () => {
    const harness = makeHarness();
    harness.deps.cache = harness.cache;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const events: string[] = [];
    harness.cache.get.mockImplementation(async (_profile, text, receivedOptions) => {
      expect(receivedOptions).toBe(options);
      events.push(`get:${text}:${String(controller.signal.aborted)}`);
      receivedOptions?.signal?.throwIfAborted();
      return [1, 2];
    });

    const promise = createEmbeddingStage(harness.deps).embedBatch(
      [
        analyzedFile("file", [
          { pointId: "a", text: "first" },
          { pointId: "b", text: "second" },
        ]),
      ],
      options,
    );
    queueMicrotask(() => {
      events.push("caller-abort");
      controller.abort(cancelledError("abort"));
    });

    const result = await promise;
    expect(events).toEqual(["get:first:false", "get:second:false", "caller-abort"]);
    expect(result.points).toHaveLength(2);
    expect(harness.embedDocuments).not.toHaveBeenCalled();
    expect(harness.cache.set).not.toHaveBeenCalled();
    expect(harness.counts).toEqual({ cacheHits: 13, computed: 7, truncated: 13 });
  });

  it("passes a pre-aborted signal through to the provider without adding its own cancellation check", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort(new Error("aborted"));
    const options = { signal: controller.signal };

    const result = await createEmbeddingStage(harness.deps).embedBatch(
      [analyzedFile("file", [{ pointId: "point", text: "text" }])],
      options,
    );

    expect(harness.embedDocuments).toHaveBeenCalledExactlyOnceWith(["text"], options);
    expect(result.points).toHaveLength(1);
  });

  it("rejects a malformed cache hit with no vector instead of silently dropping the point", async () => {
    const harness = makeHarness();
    harness.deps.cache = harness.cache;
    harness.cache.get.mockResolvedValue(undefined as unknown as number[]);

    await expect(
      createEmbeddingStage(harness.deps).embedBatch([
        analyzedFile("file", [{ pointId: "point", text: "text" }]),
      ]),
    ).rejects.toMatchObject({
      code: "EMBEDDING_UNAVAILABLE",
      message: 'No vector exists for chunk "point".',
      retryable: false,
      operation: "index.embed",
    });
    expect(harness.embedDocuments).not.toHaveBeenCalled();
    expect(harness.counts).toEqual(harness.initialCounts);
  });

  it("keeps computed counts and earlier payload mutations if a later payload cannot be written", async () => {
    const harness = makeHarness();
    const firstPayload = { embedding_truncated: "unchanged" };
    const frozenPayload = Object.freeze({ embedding_truncated: "unchanged" });
    const result: EmbeddingBatchResultV1 = {
      vectors: [
        [1, 2],
        [3, 4],
      ],
      truncated: [true, true],
    };
    harness.embedDocuments.mockResolvedValue(result);

    await expect(
      createEmbeddingStage(harness.deps).embedBatch([
        analyzedFile("file", [
          { pointId: "a", text: "first", payload: firstPayload },
          { pointId: "b", text: "second", payload: frozenPayload },
        ]),
      ]),
    ).rejects.toBeInstanceOf(TypeError);

    expect(firstPayload.embedding_truncated).toBe(true);
    expect(frozenPayload.embedding_truncated).toBe("unchanged");
    expect(harness.counts).toEqual({ cacheHits: 11, computed: 9, truncated: 13 });
  });
});
