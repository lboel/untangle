import { isUntangleError } from "@untangle-code/domain";
import {
  DeterministicRandom,
  FakeClock,
  runEmbeddingProviderContract,
} from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { OllamaEmbeddingProvider } from "./provider.js";
import {
  createFakeOllamaFetch,
  createRecordingSleep,
  createTestProviderConfig,
} from "./test-helpers.js";

function makeProvider(
  fetchImpl: typeof fetch,
  configOverrides: Parameters<typeof createTestProviderConfig>[0] = {},
  sleep = createRecordingSleep().sleep,
): OllamaEmbeddingProvider {
  return new OllamaEmbeddingProvider(createTestProviderConfig(configOverrides), {
    clock: new FakeClock(1_700_000_000_000),
    random: new DeterministicRandom(1),
    sleep,
    fetchImpl,
  });
}

describe("OllamaEmbeddingProvider — port contract", () => {
  runEmbeddingProviderContract(() => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    return makeProvider(fetchImpl);
  });
});

describe("OllamaEmbeddingProvider — dimension mismatch", () => {
  it("surfaces EMBEDDING_DIMENSION_MISMATCH from the very first embed call (before any upsert)", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 999,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl);
    const error = await provider.embedQuery("search_query: hello").catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_DIMENSION_MISMATCH");
  });

  it("surfaces the same error from ensureReady directly", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 999,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl);
    const error = await provider.ensureReady().catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_DIMENSION_MISMATCH");
  });
});

describe("OllamaEmbeddingProvider — cache (spec.md §9.4)", () => {
  it("a cache hit avoids a second /api/embed request for the same text", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl);
    const text = "search_document: export function example() {}";

    const first = await provider.embedDocuments([text]);
    const embedCallsAfterFirst = calls.filter((call) => call.path === "api/embed").length;

    const second = await provider.embedDocuments([text]);
    const embedCallsAfterSecond = calls.filter((call) => call.path === "api/embed").length;

    expect(second.vectors[0]).toEqual(first.vectors[0]);
    expect(embedCallsAfterSecond).toBe(embedCallsAfterFirst); // no new /api/embed call
  });

  it("only fetches the uncached texts within a mixed batch", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl, { batchSize: 10 });
    await provider.embedDocuments(["alpha", "beta"]);
    calls.length = 0; // reset call log

    await provider.embedDocuments(["alpha", "gamma"]); // "alpha" is cached, "gamma" is not
    const embedCalls = calls.filter((call) => call.path === "api/embed");
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.body?.["input"]).toEqual(["gamma"]);
  });
});

describe("OllamaEmbeddingProvider — truncation guard (spec.md §9.3)", () => {
  it("marks a point embedding_truncated=true when the text exceeds contextLength", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl, { contextLength: 5 });
    const longText = "word ".repeat(200); // far beyond an estimated 5-token budget
    const result = await provider.embedDocuments([longText]);
    expect(result.truncated).toEqual([true]);
  });

  it("leaves embedding_truncated=false for text well within contextLength", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl, { contextLength: 2048 });
    const result = await provider.embedDocuments(["short text"]);
    expect(result.truncated).toEqual([false]);
  });
});

describe("OllamaEmbeddingProvider — backoff (spec.md §9.2)", () => {
  it("retries a transient /api/embed failure with backoff and still returns the right vectors", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
      transientFailures: { "api/embed": 2 },
    });
    const { sleep, delays } = createRecordingSleep();
    const provider = makeProvider(
      fetchImpl,
      { maxRetries: 5, baseBackoffMs: 10, maxBackoffMs: 100 },
      sleep,
    );
    const result = await provider.embedDocuments(["hello"]);
    expect(result.vectors[0]).toHaveLength(8);
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call.path === "api/embed").length).toBeGreaterThanOrEqual(3);
  });

  it("gives up after maxRetries and reports EMBEDDING_UNAVAILABLE for a persistently failing endpoint", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
      transientFailures: { "api/embed": 100 },
    });
    const { sleep } = createRecordingSleep();
    const provider = makeProvider(
      fetchImpl,
      { maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 2 },
      sleep,
    );
    const error = await provider.embedDocuments(["hello"]).catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string; retryable: boolean }).code).toBe("EMBEDDING_UNAVAILABLE");
    expect((error as { retryable: boolean }).retryable).toBe(false);
  });

  it("does not retry a permanent (4xx, non-429) error on a batch embed call", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    let failNextEmbed = false;
    let interceptedAttempts = 0;
    const flakyFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api/embed") && failNextEmbed) {
        interceptedAttempts += 1;
        return new Response("bad request", { status: 400 });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const provider = makeProvider(flakyFetch, { maxRetries: 5 });

    await provider.ensureReady(); // succeeds via the normal fake; consumes the probe embed call.
    const embedCallsAfterReadiness = calls.filter((call) => call.path === "api/embed").length;

    failNextEmbed = true;
    const error = await provider.embedDocuments(["hello"]).catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_UNAVAILABLE");
    // Exactly one attempt (the failed one) — a permanent error must not be retried.
    expect(interceptedAttempts).toBe(1);
    // And the real fake never saw a genuine embed call beyond the earlier readiness probe.
    expect(calls.filter((call) => call.path === "api/embed")).toHaveLength(
      embedCallsAfterReadiness,
    );
  });
});

describe("OllamaEmbeddingProvider — AbortSignal mid-batch (spec.md §22)", () => {
  it("cancels the remaining batches once the signal aborts mid-way, surfacing JOB_CANCELLED", async () => {
    const controller = new AbortController();
    let embedCallCount = 0;
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
      embedOverride: (texts) => {
        embedCallCount += 1;
        if (embedCallCount === 1) {
          // Abort right after the first slice's request is dispatched, before the second starts.
          controller.abort();
        }
        return texts.map(() => new Array(8).fill(0));
      },
    });
    const provider = makeProvider(fetchImpl, { batchSize: 1, maxConnections: 1 });
    const error = await provider
      .embedDocuments(["one", "two", "three"], { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("JOB_CANCELLED");
    // At most the in-flight first slice's embed call happened; the loop must not
    // have pressed on to embed "two"/"three" after the abort.
    expect(embedCallCount).toBeLessThan(3);
  });

  it("rejects immediately when the signal is already aborted before the call starts", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl);
    const controller = new AbortController();
    controller.abort();
    const error = await provider
      .embedDocuments(["one"], { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("JOB_CANCELLED");
  });
});

describe("OllamaEmbeddingProvider — progress (spec.md §9.2)", () => {
  it("reports progress once per network batch, in increasing order", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl, { batchSize: 1, maxConnections: 1 });
    const progressEvents: { batchIndex: number; batchCount: number; embeddedCount: number }[] = [];
    await provider.embedDocuments(["a", "b", "c"], {
      onBatchProgress: (progress) => progressEvents.push(progress),
    });
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents.map((p) => p.batchIndex)).toEqual([0, 1, 2]);
    expect(progressEvents.every((p) => p.batchCount === 3)).toBe(true);
    expect(progressEvents.at(-1)?.embeddedCount).toBe(3);
  });
});
