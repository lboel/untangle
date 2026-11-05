import {
  RANKER_VERSION,
  UntangleError,
  type JobEvent,
  type SearchResultSetV1,
} from "@untangle-code/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createIndexPipeline,
  createIndexStages,
  createUntangle,
  createUntangleEngine,
  EngineClosedError,
  FeatureUnavailableError,
  type IndexRequest,
} from "./index.js";

const INDEX_REQUEST: IndexRequest = { workspaceId: "workspace-1", repoIds: ["repo-1"] };
const COMPLETED_EVENT: JobEvent = {
  kind: "job_completed",
  jobId: "job-1",
  workspaceId: "workspace-1",
  occurredAt: "2026-09-06T00:00:00.000Z",
  generationId: "generation-1",
  durationMs: 7,
};
const SEARCH_RESPONSE: SearchResultSetV1 = {
  schemaVersion: 1,
  queryFingerprint: "query-fingerprint",
  query: {
    schemaVersion: 1,
    text: "needle",
    workspaceId: "workspace-1",
    filters: {
      repoIds: [],
      refIds: [],
      languages: [],
      pathGlobs: [],
      symbolNames: [],
      symbolKinds: [],
      chunkKinds: [],
    },
    limit: 10,
    candidateLimit: 50,
    diversify: true,
    includeGraphContext: false,
    includeLinked: false,
    includeContent: false,
    rankerVersion: RANKER_VERSION,
  },
  groups: [],
  profileSeparation: false,
  totalHits: 0,
  skipped: [],
  warnings: [],
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("UntangleEngine facade", () => {
  it("delegates streams and promises with the unchanged request and AbortSignal", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const engine = createUntangle({
      index: {
        async *index(request, options) {
          seen.push(["index", request, options?.signal]);
          yield COMPLETED_EVENT;
        },
      },
      search: {
        async search(request, options) {
          seen.push(["search", request, options?.signal]);
          return SEARCH_RESPONSE;
        },
      },
    });

    const searchRequest = { query: "needle", workspaceId: "workspace-1" };
    await expect(
      collect(engine.index(INDEX_REQUEST, { signal: controller.signal })),
    ).resolves.toEqual([COMPLETED_EVENT]);
    await expect(engine.search(searchRequest, { signal: controller.signal })).resolves.toBe(
      SEARCH_RESPONSE,
    );
    expect(seen).toEqual([
      ["index", INDEX_REQUEST, controller.signal],
      ["search", searchRequest, controller.signal],
    ]);
  });

  it("preserves the architecture factory name and the index-pipeline compatibility alias", () => {
    expect(createUntangleEngine).toBe(createUntangle);
    expect(createIndexPipeline).toBe(createIndexStages);
  });

  it("reports every missing capability as FEATURE_UNAVAILABLE instead of an empty success", async () => {
    const engine = createUntangle({});

    expect(() => engine.index(INDEX_REQUEST)).toThrow(
      expect.objectContaining({
        code: "FEATURE_UNAVAILABLE",
        feature: "index",
        retryable: false,
      }),
    );
    await expect(engine.search({ query: "needle" })).rejects.toEqual(
      expect.objectContaining({
        code: "FEATURE_UNAVAILABLE",
        feature: "search",
        retryable: false,
      }),
    );

    const error = new FeatureUnavailableError("impact");
    expect(error.toEnvelopeError()).toEqual({
      code: "FEATURE_UNAVAILABLE",
      message: error.message,
      retryable: false,
      details: { feature: "impact" },
    });
  });

  it("does not start work for an already aborted signal", async () => {
    const index = vi.fn((_request: IndexRequest) => emptyEvents());
    const search = vi.fn(async () => SEARCH_RESPONSE);
    const engine = createUntangle({ index: { index }, search: { search } });
    const controller = new AbortController();
    controller.abort("test cancellation");

    expect(() => engine.index(INDEX_REQUEST, { signal: controller.signal })).toThrow(
      expect.objectContaining({ code: "JOB_CANCELLED" }),
    );
    await expect(
      engine.search({ query: "needle" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    expect(index).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects promptly when an in-flight promise is aborted even if its port ignores the signal", async () => {
    let finish!: (value: SearchResultSetV1) => void;
    const work = new Promise<SearchResultSetV1>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const engine = createUntangle({ search: { search: async () => work } });

    const result = engine.search({ query: "needle" }, { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    finish(SEARCH_RESPONSE);
  });

  it("stops an in-flight event stream promptly and asks its iterator to clean up", async () => {
    const pending = new Promise<IteratorResult<JobEvent>>(() => undefined);
    const iterator = {
      next: vi.fn(() => pending),
      return: vi.fn(async (): Promise<IteratorResult<JobEvent>> => ({
        done: true,
        value: undefined,
      })),
    };
    const stream: AsyncIterable<JobEvent> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    const controller = new AbortController();
    const engine = createUntangle({ index: { index: () => stream } });

    const outer = engine.index(INDEX_REQUEST, { signal: controller.signal });
    const next = outer[Symbol.asyncIterator]().next();
    controller.abort();

    await expect(next).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    expect(iterator.next).toHaveBeenCalledTimes(1);
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });

  it("translates an AbortError from a delegated port into JOB_CANCELLED", async () => {
    const engine = createUntangle({
      search: {
        search: async () => {
          throw new DOMException("aborted", "AbortError");
        },
      },
    });

    const result = engine.search({ query: "needle" });
    await expect(result).rejects.toBeInstanceOf(UntangleError);
    await expect(result).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  });

  it("closes the injected lifecycle exactly once and rejects later work", async () => {
    const close = vi.fn(async () => undefined);
    const search = vi.fn(async () => SEARCH_RESPONSE);
    const engine = createUntangle({ lifecycle: { close }, search: { search } });

    await Promise.all([engine.close(), engine.close(), engine.close()]);

    expect(close).toHaveBeenCalledTimes(1);
    await expect(engine.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(engine.search({ query: "needle" })).rejects.toBeInstanceOf(EngineClosedError);
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps the engine open when a pre-aborted close call never started", async () => {
    const close = vi.fn(async () => undefined);
    const search = vi.fn(async () => SEARCH_RESPONSE);
    const engine = createUntangle({ lifecycle: { close }, search: { search } });
    const controller = new AbortController();
    controller.abort();

    await expect(engine.close({ signal: controller.signal })).rejects.toMatchObject({
      code: "JOB_CANCELLED",
    });
    expect(close).not.toHaveBeenCalled();
    await expect(engine.search({ query: "needle" })).resolves.toBe(SEARCH_RESPONSE);
  });
});

async function* emptyEvents(): AsyncIterable<JobEvent> {
  yield* [];
}
