import type {
  Clock,
  LogEvent,
  LoggerPort,
  SearchGraphRelationsV1,
  SearchHitV1,
  SearchResultSetV1,
} from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import type { SearchGraphEnrichmentResultV1 } from "./port.js";
import type { ChunkFixture } from "./testing/in-memory-index.js";
import { buildInMemorySearchEngine } from "./testing/in-memory-index.js";

// Vor dem Refactor gegen den unveraenderten Abrufkern eingefrorene Fehlervertraege.
// Zwei finale Treffer verhindern, dass ein nur teilweise ausgefuehrter Reset
// versehentlich als vollstaendige Degradation durchgeht.
const FIXTURES: readonly ChunkFixture[] = [
  {
    chunkId: "charge-first",
    filePath: "src/first.ts",
    symbolId: "symbol-first",
    symbolName: "charge",
    symbolFqn: "First.charge",
    content: "function charge() { return firstGateway.send(); }",
  },
  {
    chunkId: "charge-second",
    filePath: "src/second.ts",
    symbolId: "symbol-second",
    symbolName: "charge",
    symbolFqn: "Second.charge",
    content: "function charge() { return secondGateway.send(); }",
  },
];

const REQUEST = { query: "charge", mode: "symbol" as const, limit: 2, includeContent: true };
const TIMESTAMP = "2026-10-11T00:00:00.000Z";

function observedPorts(
  trace: string[],
  loggerFailure?: Error,
): {
  clock: Clock;
  logger: LoggerPort;
  logs: LogEvent[];
} {
  const logs: LogEvent[] = [];
  const logger: LoggerPort = {
    log(event) {
      trace.push("logger");
      logs.push(event);
      if (loggerFailure !== undefined) throw loggerFailure;
    },
    child() {
      return logger;
    },
  };
  return {
    clock: {
      nowEpochMs: () => Date.parse(TIMESTAMP),
      nowIso() {
        trace.push("clock");
        return TIMESTAMP;
      },
    },
    logger,
    logs,
  };
}

function successfulFacet(marker: string): SearchGraphRelationsV1 {
  return {
    schemaVersion: 1,
    relations: [
      {
        schemaVersion: 1,
        source: "file_graph",
        edgeId: marker,
        direction: "outgoing",
        edgeKind: "import",
        repoId: "repo-a",
        refId: "ref-main",
        fileId: `${marker}-file`,
        path: `src/${marker}.ts`,
        crossRepository: false,
      },
    ],
    relationLimit: 32,
    truncated: false,
    omittedCount: 0,
    omissions: [],
  };
}

function withoutGraphFacets(hit: SearchHitV1): SearchHitV1 {
  const copy = { ...hit };
  delete copy.graphContext;
  delete copy.linkedSymbols;
  return copy;
}

function expectUnchangedSearch(failed: SearchResultSetV1, baseline: SearchResultSetV1): void {
  const withoutEnrichment = (result: SearchResultSetV1): SearchResultSetV1 => ({
    ...result,
    groups: result.groups.map((group) => ({
      ...group,
      hits: group.hits.map(withoutGraphFacets),
    })),
    warnings: [],
  });
  expect(withoutEnrichment(failed)).toEqual(withoutEnrichment(baseline));
  expect(failed.totalHits).toBe(2);
  expect(failed.groups.flatMap((group) => group.hits)).toHaveLength(2);
}

function expectUnavailableFacets(
  result: SearchResultSetV1,
  includeContext: boolean,
  includeLinked: boolean,
  message: string,
): void {
  const detail = `graph enrichment failed after ranking: ${message}`;
  const unavailable: SearchGraphRelationsV1 = {
    schemaVersion: 1,
    relations: [],
    relationLimit: 32,
    truncated: false,
    omittedCount: 1,
    omissions: [{ reason: "graph_unavailable", count: 1, detail }],
  };
  for (const hit of result.groups.flatMap((group) => group.hits)) {
    expect(hit.graphContext).toEqual(includeContext ? unavailable : undefined);
    expect(hit.linkedSymbols).toEqual(includeLinked ? unavailable : undefined);
  }
  expect(
    result.warnings.filter(
      (warning) =>
        warning.code.startsWith("GRAPH_") || warning.code === "LINKED_ARTIFACTS_UNAVAILABLE",
    ),
  ).toEqual([
    ...(includeContext ? [{ code: "GRAPH_CONTEXT_UNAVAILABLE", message: detail }] : []),
    ...(includeLinked ? [{ code: "LINKED_ARTIFACTS_UNAVAILABLE", message: detail }] : []),
  ]);
}

function expectFailureLog(logs: LogEvent[], message: string): void {
  expect(logs).toEqual([
    {
      timestamp: TIMESTAMP,
      level: "warn",
      component: "search",
      event: "graph_enrichment_failed",
      context: { message },
    },
  ]);
}

describe("final-hit graph failure characterization", () => {
  it.each([
    { name: "context only", includeContext: true, includeLinked: false },
    { name: "linked only", includeContext: false, includeLinked: true },
    { name: "both facets", includeContext: true, includeLinked: true },
  ])(
    "degrades $name after an awaited provider error and keeps all retrieval fields",
    async ({ includeContext, includeLinked }) => {
      const trace: string[] = [];
      const { clock, logger, logs } = observedPorts(trace);
      const message = "graph provider failed after its await";
      const request = { ...REQUEST, includeContext, includeLinked };
      const baselineHarness = await buildInMemorySearchEngine(FIXTURES, { clock });
      const failedHarness = await buildInMemorySearchEngine(FIXTURES, {
        clock,
        logger,
        graphEnrichment: {
          async enrich(enrichmentRequest) {
            trace.push("provider:start");
            expect(enrichmentRequest.includeContext).toBe(includeContext);
            expect(enrichmentRequest.includeLinked).toBe(includeLinked);
            expect(enrichmentRequest.targets).toHaveLength(2);
            await Promise.resolve();
            trace.push("provider:throw");
            throw new Error(message);
          },
        },
      });
      const baseline = await baselineHarness.engine.search(request);
      const failed = await failedHarness.engine.search(request);
      trace.push("search:resolved");

      expectUnchangedSearch(failed, baseline);
      expectUnavailableFacets(failed, includeContext, includeLinked, message);
      expectFailureLog(logs, message);
      expect(trace).toEqual([
        "provider:start",
        "provider:throw",
        "clock",
        "logger",
        "search:resolved",
      ]);
    },
  );

  it("also degrades a synchronous provider throw before it returns a promise", async () => {
    const trace: string[] = [];
    const { clock, logger, logs } = observedPorts(trace);
    const message = "synchronous graph failure";
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      clock,
      logger,
      graphEnrichment: {
        enrich() {
          trace.push("provider:throw");
          throw new Error(message);
        },
      },
    });
    const result = await engine.search({ ...REQUEST, includeContext: true, includeLinked: true });
    expectUnavailableFacets(result, true, true, message);
    expectFailureLog(logs, message);
    expect(trace).toEqual(["provider:throw", "clock", "logger"]);
  });

  it("resets every requested facet when a malformed success fails after partial hit mutation", async () => {
    const trace: string[] = [];
    const { clock, logger, logs } = observedPorts(trace);
    const visited: string[] = [];
    const request = { ...REQUEST, includeContext: true, includeLinked: true };
    const baselineHarness = await buildInMemorySearchEngine(FIXTURES, { clock });
    const failedHarness = await buildInMemorySearchEngine(FIXTURES, {
      clock,
      logger,
      graphEnrichment: {
        enrich(enrichmentRequest) {
          trace.push("provider:resolved");
          const malformed: SearchGraphRelationsV1 = {
            ...successfulFacet("second-linked"),
            omissions: [{ reason: "unresolved_endpoint", count: 0, detail: "invalid omission" }],
          };
          return Promise.resolve({
            entries: enrichmentRequest.targets.map((target, index) => ({
              targetId: target.targetId,
              get graphContext() {
                visited.push(`${String(index)}:context`);
                return successfulFacet(`context-${String(index)}`);
              },
              get linkedSymbols() {
                visited.push(`${String(index)}:linked`);
                return index === 0 ? successfulFacet("first-linked") : malformed;
              },
            })),
            warnings: [],
          });
        },
      },
    });
    const baseline = await baselineHarness.engine.search(request);
    const failed = await failedHarness.engine.search(request);
    const message = "search graph omission requires a positive integer count and non-empty detail";

    // The first hit and the second context were really processed before the
    // second linked facet threw; successful-looking relations must not survive.
    expect(visited).toContain("0:linked");
    expect(visited.indexOf("0:linked")).toBeLessThan(visited.indexOf("1:context"));
    expect(visited.indexOf("1:context")).toBeLessThan(visited.indexOf("1:linked"));
    expectUnchangedSearch(failed, baseline);
    expectUnavailableFacets(failed, true, true, message);
    expectFailureLog(logs, message);
    expect(trace).toEqual(["provider:resolved", "clock", "logger"]);
  });

  it("rethrows the external abort reason when an awaited provider later rejects", async () => {
    const trace: string[] = [];
    const { clock, logger, logs } = observedPorts(trace);
    const controller = new AbortController();
    const reason = new Error("external graph cancellation");
    let rejectProvider: ((error: Error) => void) | undefined;
    let markProviderStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      clock,
      logger,
      graphEnrichment: {
        enrich(_request, options) {
          expect(options?.signal).toBe(controller.signal);
          trace.push("provider:start");
          markProviderStarted?.();
          return new Promise<SearchGraphEnrichmentResultV1>((_resolve, reject) => {
            rejectProvider = reject;
          });
        },
      },
    });
    const pending = engine.search(
      { ...REQUEST, includeContext: true, includeLinked: true },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toBe(reason);
    await started;
    trace.push("external:abort");
    controller.abort(reason);
    trace.push("provider:reject");
    rejectProvider?.(new Error("provider rejection must not replace the abort"));
    await rejected;

    expect(logs).toEqual([]);
    expect(trace).toEqual(["provider:start", "external:abort", "provider:reject"]);
  });

  it("observes a queued abort before processing a successfully resolved provider batch", async () => {
    const trace: string[] = [];
    const { clock, logger, logs } = observedPorts(trace);
    const controller = new AbortController();
    const reason = new Error("abort before enrichment continuation");
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      clock,
      logger,
      graphEnrichment: {
        enrich(request, options) {
          expect(options?.signal).toBe(controller.signal);
          trace.push("provider:resolved");
          queueMicrotask(() => {
            trace.push("external:abort");
            controller.abort(reason);
          });
          return Promise.resolve({
            get entries() {
              trace.push("entries:read");
              return request.targets.map((target) => ({ targetId: target.targetId }));
            },
            warnings: [],
          });
        },
      },
    });
    await expect(
      engine.search(
        { ...REQUEST, includeContext: true, includeLinked: true },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(logs).toEqual([]);
    expect(trace).toEqual(["provider:resolved", "external:abort"]);
  });

  it("keeps provider JOB_CANCELLED as visible graph degradation when the caller signal is not aborted", async () => {
    const trace: string[] = [];
    const { clock, logger, logs } = observedPorts(trace);
    const controller = new AbortController();
    const message = "graph adapter cancelled its own operation";
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      clock,
      logger,
      graphEnrichment: {
        enrich() {
          return Promise.reject(new UntangleError("JOB_CANCELLED", message));
        },
      },
    });
    const result = await engine.search(
      { ...REQUEST, includeContext: true, includeLinked: true },
      { signal: controller.signal },
    );
    expect(controller.signal.aborted).toBe(false);
    expectUnavailableFacets(result, true, true, message);
    expectFailureLog(logs, message);
  });

  it("does not swallow or replace a logger failure after graph degradation", async () => {
    const trace: string[] = [];
    const loggerFailure = new Error("logger failed");
    const { clock, logger, logs } = observedPorts(trace, loggerFailure);
    const message = "graph provider unavailable";
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      clock,
      logger,
      graphEnrichment: {
        enrich() {
          trace.push("provider:reject");
          return Promise.reject(new Error(message));
        },
      },
    });
    await expect(
      engine.search({ ...REQUEST, includeContext: true, includeLinked: true }),
    ).rejects.toBe(loggerFailure);
    expectFailureLog(logs, message);
    expect(trace).toEqual(["provider:reject", "clock", "logger"]);
  });
});
