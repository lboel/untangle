import { isUntangleError } from "@untangle-code/domain";
import { DeterministicRandom, FakeClock } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { OllamaHttpClient } from "./http.js";
import { runReadinessSequence } from "./readiness.js";
import {
  createFakeOllamaFetch,
  createRecordingSleep,
  createTestProviderConfig,
} from "./test-helpers.js";
import { DEFAULT_MAX_RETRIES } from "./types.js";

function makeDeps(fetchImpl: typeof fetch, maxRetries = 1) {
  const client = new OllamaHttpClient({ requestTimeoutMs: 1000, maxConnections: 2, fetchImpl });
  const { sleep } = createRecordingSleep();
  return {
    httpClient: client,
    clock: new FakeClock(1_700_000_000_000),
    random: new DeterministicRandom(1),
    sleep,
    backoffConfig: { maxRetries, baseDelayMs: 1, maxDelayMs: 5 },
  };
}

describe("runReadinessSequence", () => {
  it("runs the full sequence and returns endpoint/model/dimensions/probedAt", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const config = createTestProviderConfig({});
    const outcome = await runReadinessSequence(config, makeDeps(fetchImpl));

    expect(outcome.readiness.endpoint).toBe("http://fake-ollama.test");
    expect(outcome.readiness.model).toBe("test-embed-model");
    expect(outcome.readiness.dimensions).toBe(8);
    expect(outcome.readiness.probedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(outcome.endpointUrl).toBe("http://fake-ollama.test");

    const paths = calls.map((call) => call.path);
    expect(paths).toContain("api/tags");
    expect(paths).toContain("api/embed");
    expect(paths).not.toContain("api/pull"); // model already present
  });

  it("throws EMBEDDING_DIMENSION_MISMATCH when the probe vector has the wrong dimensionality", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 999, // wrong on purpose vs. profile.dimensions = 8
      models: ["test-embed-model:latest"],
    });
    const config = createTestProviderConfig({});
    const error = await runReadinessSequence(config, makeDeps(fetchImpl)).catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_DIMENSION_MISMATCH");
  });

  it("throws EMBEDDING_UNAVAILABLE when the external endpoint is unreachable", async () => {
    const { fetchImpl } = createFakeOllamaFetch({ dimensions: 8, reachable: false });
    const config = createTestProviderConfig({ mode: "external", url: "http://unreachable.test" });
    const error = await runReadinessSequence(config, makeDeps(fetchImpl)).catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_UNAVAILABLE");
  });

  it("requires a url in external mode", async () => {
    const { fetchImpl } = createFakeOllamaFetch({ dimensions: 8 });
    const config = createTestProviderConfig({ mode: "external", url: undefined });
    const error = await runReadinessSequence(config, makeDeps(fetchImpl)).catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("CONFIG_INVALID");
  });

  it("does not pull a missing model in external mode — fails instead (spec.md §3.2)", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({ dimensions: 8, models: [] });
    const config = createTestProviderConfig({ mode: "external" });
    const error = await runReadinessSequence(config, makeDeps(fetchImpl)).catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_UNAVAILABLE");
    expect(calls.some((call) => call.path === "api/pull")).toBe(false);
  });

  it("pulls a missing model in managed mode, then proceeds", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({ dimensions: 8, models: [] });
    const config = createTestProviderConfig({ mode: "managed", url: "http://managed.test" });
    const outcome = await runReadinessSequence(config, makeDeps(fetchImpl));
    expect(outcome.readiness.dimensions).toBe(8);
    const pullCalls = calls.filter((call) => call.path === "api/pull");
    expect(pullCalls).toHaveLength(1);
    expect(pullCalls[0]?.body?.["model"]).toBe("test-embed-model");
  });

  it("auto mode falls back to the managed endpoint when the native probe is unreachable", async () => {
    const native = createFakeOllamaFetch({ dimensions: 8, reachable: false });
    const managed = createFakeOllamaFetch({ dimensions: 8, models: ["test-embed-model:latest"] });
    const combinedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://native.test")) {
        return native.fetchImpl(input, init);
      }
      return managed.fetchImpl(input, init);
    }) as typeof fetch;

    const config = createTestProviderConfig({
      mode: "auto",
      url: undefined,
      nativeProbeUrl: "http://native.test",
      managedUrl: "http://managed.test",
    });
    const outcome = await runReadinessSequence(config, makeDeps(combinedFetch));
    expect(outcome.endpointUrl).toBe("http://managed.test");
  });

  it("auto mode prefers the native endpoint when it is reachable", async () => {
    const { fetchImpl } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const config = createTestProviderConfig({
      mode: "auto",
      url: undefined,
      nativeProbeUrl: "http://fake-ollama.test",
      managedUrl: "http://should-not-be-used.test",
    });
    const outcome = await runReadinessSequence(config, makeDeps(fetchImpl));
    expect(outcome.endpointUrl).toBe("http://fake-ollama.test");
  });

  it("retries a transient failure during the reachability check before giving up", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
      transientFailures: { "api/tags": 1 },
    });
    const config = createTestProviderConfig({});
    const outcome = await runReadinessSequence(config, makeDeps(fetchImpl, DEFAULT_MAX_RETRIES));
    expect(outcome.readiness.dimensions).toBe(8);
    expect(calls.filter((call) => call.path === "api/tags").length).toBeGreaterThanOrEqual(2);
  });
});
