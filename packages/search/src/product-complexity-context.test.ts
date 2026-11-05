import {
  RANKER_VERSION,
  SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS,
  searchJourneyValidationIssue,
  sha256Hex,
  type PortCallOptions,
  type SearchJourneyExecutionContextInputV1,
  type SearchJourneyStorePort,
  type SearchJourneyV1,
  type SearchResultSetV1,
} from "@untangle-code/domain";
import { DeterministicRandom, FakeClock } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { SearchJourneyService, buildDynamicProductComplexityReport } from "./product-complexity.js";

const WORKSPACE = "workspace-caller-evidence";
const NOW = "2026-10-19T00:00:00.000Z";
const CONTEXT: SearchJourneyExecutionContextInputV1 = {
  agentModel: "model-version-a",
  harness: "harness-version-a",
  searchStrategy: "hybrid-then-graph-v1",
  taskClass: "find-owner-for-password-reset",
  taskMix: "fixed-eight-tasks-v1",
  priorContext: "fresh-session-no-open-files",
};

class MemoryStore implements SearchJourneyStorePort {
  public readonly sessions = new Map<string, SearchJourneyV1>();

  public get(sessionId: string): Promise<SearchJourneyV1 | null> {
    return Promise.resolve(structuredClone(this.sessions.get(sessionId) ?? null));
  }

  public put(
    session: SearchJourneyV1,
    options: PortCallOptions & { expectedRevision: number | null },
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const stored = this.sessions.get(session.sessionId);
    if ((stored?.revision ?? null) !== options.expectedRevision) {
      return Promise.reject(new Error("test fixture CAS conflict"));
    }
    this.sessions.set(session.sessionId, structuredClone(session));
    return Promise.resolve();
  }

  public list(workspaceId: string): Promise<SearchJourneyV1[]> {
    return Promise.resolve(
      structuredClone(
        [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId),
      ),
    );
  }
}

function harness(workspaceId = WORKSPACE, keyByte = 17) {
  const store = new MemoryStore();
  const service = new SearchJourneyService({
    workspaceId,
    store,
    clock: new FakeClock(Date.parse(NOW)),
    random: new DeterministicRandom(17),
    fingerprintKey: new Uint8Array(32).fill(keyByte),
  });
  return { service, store };
}

function result(): SearchResultSetV1 {
  return {
    schemaVersion: 1,
    queryFingerprint: sha256Hex("find password reset"),
    rankingContextFingerprint: sha256Hex("fixed hybrid ranking"),
    query: {
      schemaVersion: 1,
      text: "find password reset",
      workspaceId: WORKSPACE,
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
      candidateLimit: 20,
      diversify: true,
      includeGraphContext: false,
      includeLinked: false,
      includeContent: false,
      rankerVersion: RANKER_VERSION,
    },
    groups: [
      {
        embeddingProfileId: "profile-a",
        indexGenerations: ["generation-a"],
        corpusRevisionFingerprint: sha256Hex("immutable corpus a"),
        repoIds: ["repo-a"],
        hits: [
          {
            schemaVersion: 1,
            rank: 1,
            repoId: "repo-a",
            repoLabel: "Repo A",
            refId: "main",
            refName: "main",
            fileId: "file-password-reset",
            filePath: "src/password-reset.ts",
            range: { startLine: 1, endLine: 4, startByte: 0, endByte: 40 },
            language: "typescript",
            parseQuality: "complete",
            chunkId: "reset-password",
            chunkKind: "function",
            symbolId: "symbol-reset-password",
            symbolName: "resetPassword",
            symbolFqn: "auth.resetPassword",
            symbolKind: "function",
            score: {
              schemaVersion: 1,
              final: 0.9,
              components: [],
              inputs: {},
              rankerVersion: RANKER_VERSION,
              clamped: false,
            },
            dedupeKey: "reset-password",
            relatedFragments: [],
            embeddingProfileId: "profile-a",
            indexGeneration: "generation-a",
          },
        ],
        rankNormalized: false,
        caveats: [],
        retrieval: {
          branchCandidateCounts: { dense: 1, sparse: 1, symbol: 0 },
          uniqueRetrievedCandidateCount: 1,
          eligibleCandidateCount: 1,
          rankedCandidateCount: 1,
          deduplicatedCandidateCount: 1,
          qualifiedHitCount: 1,
          returnedHitCount: 1,
          uniqueEligibleFileCount: 1,
          uniqueEligibleSymbolCount: 1,
          eligibleFileDispersion: 0,
          topScoreGap: null,
          candidateLimitReached: false,
        },
      },
    ],
    profileSeparation: false,
    totalHits: 1,
    skipped: [],
    warnings: [],
  };
}

async function complete(
  service: SearchJourneyService,
  executionContext: SearchJourneyExecutionContextInputV1 | undefined = CONTEXT,
): Promise<SearchJourneyV1> {
  const started = await service.start({
    goal: "locate reset password ownership",
    featureId: "auth.password-reset",
    ...(executionContext === undefined ? {} : { executionContext }),
  });
  const observed = await service.recordSearch(started.sessionId, result());
  return service.complete(started.sessionId, {
    target: { chunkId: "reset-password" },
    acceptedAttemptId: observed.attempt.attemptId,
  });
}

describe("caller execution context and complete outcome denominators", () => {
  it("uses normalized workspace/key/dimension-separated HMACs with no default free-text retention", async () => {
    const { service } = harness();
    const value = "same-sensitive-label";
    const labels = Object.fromEntries(
      SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.map((dimension) => [dimension, value]),
    ) as unknown as SearchJourneyExecutionContextInputV1;
    const started = await service.start({ goal: value, executionContext: labels });
    const normalized = await service.start({
      goal: value,
      executionContext: { ...labels, agentModel: ` ${value} ` },
    });
    expect(started.executionContext).toEqual(normalized.executionContext);
    expect(searchJourneyValidationIssue(started)).toBeNull();
    expect(JSON.stringify(started)).not.toContain(value);
    expect(
      new Set(
        SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.map(
          (dimension) => started.executionContext?.[dimension]?.fingerprint,
        ),
      ).size,
    ).toBe(6);
    expect(started.executionContext?.agentModel.fingerprint).not.toBe(started.goal.fingerprint);
    const otherWorkspace = await harness("other-workspace").service.start({
      goal: value,
      executionContext: labels,
    });
    const otherKey = await harness(WORKSPACE, 18).service.start({
      goal: value,
      executionContext: labels,
    });
    expect(otherWorkspace.executionContext?.agentModel.fingerprint).not.toBe(
      started.executionContext?.agentModel.fingerprint,
    );
    expect(otherKey.executionContext?.agentModel.fingerprint).not.toBe(
      started.executionContext?.agentModel.fingerprint,
    );
    expect((await service.get(started.sessionId)).executionContext).toEqual(
      started.executionContext,
    );
  });

  it("retains labels only with explicit consent and keeps them out of aggregate report context", async () => {
    const { service } = harness();
    const started = await service.start({
      goal: "inspect reset",
      retainText: true,
      executionContext: CONTEXT,
    });
    expect(started.executionContext?.agentModel.text).toBe(CONTEXT.agentModel);
    expect(searchJourneyValidationIssue(started)).toBeNull();
    await service.abandon(started.sessionId, { reasonCode: "cancelled" });
    const serialized = JSON.stringify(await service.report());
    for (const label of Object.values(CONTEXT)) expect(serialized).not.toContain(label);
  });

  it.each(SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS)(
    "segments a changed %s while preserving retrieval assessments",
    async (dimension) => {
      const { service } = harness();
      const first = await complete(service);
      const changed = await complete(service, {
        ...CONTEXT,
        [dimension]: `${CONTEXT[dimension] ?? "unknown"}-changed`,
      });
      if (first.outcome?.kind !== "completed" || changed.outcome?.kind !== "completed")
        throw new Error("expected completions");
      expect(first.outcome.assessment).toEqual(changed.outcome.assessment);
      const report = await service.report();
      expect(report.cohorts).toHaveLength(2);
      expect(report.featureMappings).toHaveLength(2);
      expect(report.outcomeCohorts).toHaveLength(2);
      expect(report.cohorts.map((cohort) => cohort.completedSessionCount)).toEqual([1, 1]);
      expect(
        new Set(report.cohorts.map((cohort) => cohort.executionContext?.fingerprint)).size,
      ).toBe(2);
      expect(
        report.featureMappings.reduce(
          (sum, mapping) => sum + mapping.search.completedSessionCount,
          0,
        ),
      ).toBe(report.sessionCounts.featureTaggedCompleted);
      expect(report.cohorts.every((cohort) => cohort.callerConditionsControlled)).toBe(true);
    },
  );

  it("keeps legacy retrieval sufficiency separate from unrecorded caller conditions", async () => {
    const { service } = harness();
    // Passing undefined explicitly must leave the caller context absent.
    const sessions: SearchJourneyV1[] = [];
    for (let index = 0; index < 3; index++) {
      const started = await service.start({
        goal: "legacy goal",
        featureId: "auth.password-reset",
      });
      await service.recordSearch(started.sessionId, result());
      sessions.push(
        await service.complete(started.sessionId, { target: { chunkId: "reset-password" } }),
      );
    }
    await complete(service);
    const report = await service.report();
    const legacy = report.cohorts.find(
      (cohort) => cohort.executionContext?.status === "not-recorded",
    );
    if (sessions[0]?.outcome?.kind !== "completed") throw new Error("expected legacy completion");
    expect(legacy).toMatchObject({
      measurementContextId: sessions[0].outcome.assessment.measurementContextId,
      completedSessionCount: 3,
      sufficientEvidence: true,
      callerConditionsControlled: false,
      executionContext: {
        status: "not-recorded",
        uncontrolledDimensions: [...SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS],
      },
    });
    expect(legacy?.caveats.join(" ")).toContain("not recorded");
    expect(report.cohorts).toHaveLength(2);
    expect(JSON.stringify(sessions)).not.toContain("caller-declared");
  });

  it("does not equate missing optional conditions to an explicit unknown label", async () => {
    const { service } = harness();
    const partial = {
      agentModel: CONTEXT.agentModel,
      harness: CONTEXT.harness,
      searchStrategy: CONTEXT.searchStrategy,
      taskClass: CONTEXT.taskClass,
    };
    await complete(service, partial);
    await complete(service, { ...partial, taskMix: "unknown", priorContext: "unknown" });
    const report = await service.report();
    expect(report.cohorts).toHaveLength(2);
    expect(
      report.cohorts.find((cohort) => !cohort.callerConditionsControlled)?.executionContext
        ?.uncontrolledDimensions,
    ).toEqual(["taskMix", "priorContext"]);
  });

  it("exposes abandoned effort, failed searches, active work and terminal denominators beside completed-only metrics", async () => {
    const { service } = harness();
    const completedStart = await service.start({
      goal: "completed task",
      featureId: "auth.password-reset",
      executionContext: CONTEXT,
    });
    const accepted = await service.recordSearch(completedStart.sessionId, result());
    await service.recordSearch(completedStart.sessionId, result());
    await service.complete(completedStart.sessionId, {
      target: { chunkId: "reset-password" },
      acceptedAttemptId: accepted.attempt.attemptId,
    });
    const abandoned = await service.start({
      goal: "hard task",
      featureId: "auth.password-reset",
      executionContext: CONTEXT,
    });
    await service.recordSearch(abandoned.sessionId, result());
    await service.recordSearch(abandoned.sessionId, result());
    await service.recordFailedSearch(abandoned.sessionId, {
      query: "try again",
      failureCode: "PROVIDER_UNAVAILABLE",
      failureReason: "private failure detail",
    });
    await service.observeNavigation(abandoned.sessionId, {
      kind: "open-file",
      target: { filePath: "src/password-reset.ts" },
    });
    await service.abandon(abandoned.sessionId, {
      reasonCode: "target-not-found",
      reason: "private abandonment detail",
    });
    const active = await service.start({
      goal: "still working",
      featureId: "auth.password-reset",
      executionContext: CONTEXT,
    });
    await service.recordSearch(active.sessionId, result());
    const report = await service.report();
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]).toMatchObject({
      completedSessionCount: 1,
      medianSearchesToTarget: 1,
    });
    expect(report.outcomeCohorts).toHaveLength(1);
    expect(report.outcomeCohorts?.[0]).toMatchObject({
      distinctGoalCount: 3,
      sessionCounts: { total: 3, active: 1, completed: 1, abandoned: 1, terminal: 2 },
      terminalCompletionRate: 0.5,
      retrievalContextComplete: false,
      abandonmentReasons: [{ reasonCode: "target-not-found", count: 1 }],
    });
    expect(report.outcomeCohorts?.[0]?.statusEffort).toEqual([
      {
        status: "active",
        sessionCount: 1,
        sessionsWithSearches: 1,
        totalSearches: 1,
        failedSearches: 0,
        totalNavigationEvents: 0,
        totalObservedHops: 1,
        medianSearches: 1,
      },
      {
        status: "completed",
        sessionCount: 1,
        sessionsWithSearches: 1,
        totalSearches: 2,
        failedSearches: 0,
        totalNavigationEvents: 0,
        totalObservedHops: 2,
        medianSearches: 2,
      },
      {
        status: "abandoned",
        sessionCount: 1,
        sessionsWithSearches: 1,
        totalSearches: 3,
        failedSearches: 1,
        totalNavigationEvents: 1,
        totalObservedHops: 4,
        medianSearches: 3,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("private");
    expect(report.caveats.join(" ")).toContain("separate outcome cohorts");
  });

  it("retains zero-search and retrieval-unavailable tasks without inventing comparable profile evidence", async () => {
    const { service } = harness();
    const zero = await service.start({ goal: "zero searches", executionContext: CONTEXT });
    await service.abandon(zero.sessionId);
    const failed = await service.start({ goal: "service unavailable", executionContext: CONTEXT });
    await service.recordFailedSearch(failed.sessionId, {
      query: "reset",
      failureCode: "PROVIDER_UNAVAILABLE",
      failureReason: "offline",
    });
    await service.abandon(failed.sessionId, { reasonCode: "retrieval-unavailable" });
    await service.start({ goal: "not searched yet", executionContext: CONTEXT });
    await complete(service);
    const report = await service.report();
    expect(report.sessionCounts).toMatchObject({ total: 4, active: 1, completed: 1, abandoned: 2 });
    expect(
      report.outcomeCohorts?.reduce((sum, cohort) => sum + cohort.sessionCounts.total, 0),
    ).toBe(4);
    expect(
      report.outcomeCohorts?.reduce(
        (sum, cohort) =>
          sum +
          cohort.statusEffort.reduce((subtotal, effort) => subtotal + effort.totalSearches, 0),
        0,
      ),
    ).toBe(2);
    expect(
      report.outcomeCohorts?.some(
        (cohort) => cohort.sessionCounts.terminal === 0 && cohort.terminalCompletionRate === null,
      ),
    ).toBe(false);
    const noSearch = report.outcomeCohorts?.find((cohort) => cohort.sessionCounts.total === 2);
    expect(noSearch).toMatchObject({ terminalCompletionRate: 0, retrievalContextComplete: false });
    expect(noSearch?.statusEffort.find((effort) => effort.status === "abandoned")).toMatchObject({
      sessionCount: 1,
      totalSearches: 0,
      medianSearches: 0,
    });
    expect(noSearch?.abandonmentReasons).toEqual([{ reasonCode: "not-recorded", count: 1 }]);
    const onlyActive = await harness().service.start({
      goal: "fresh active",
      executionContext: CONTEXT,
    });
    const activeReport = buildDynamicProductComplexityReport(WORKSPACE, [onlyActive], NOW);
    expect(activeReport.outcomeCohorts?.[0]?.terminalCompletionRate).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    "model",
    { ...CONTEXT, agentModel: " " },
    { ...CONTEXT, harness: 17 },
    { ...CONTEXT, searchStrategy: "x".repeat(257) },
    { ...CONTEXT, secret: "should not persist" },
  ])("rejects malformed caller labels before key creation or persistence %#", async (invalid) => {
    const store = new MemoryStore();
    const keyProvider = vi.fn(async () => new Uint8Array(32).fill(17));
    const service = new SearchJourneyService({
      workspaceId: WORKSPACE,
      store,
      clock: new FakeClock(Date.parse(NOW)),
      random: new DeterministicRandom(17),
      fingerprintKeyProvider: keyProvider,
    });
    await expect(
      service.start({
        goal: "task",
        executionContext: invalid as unknown as SearchJourneyExecutionContextInputV1,
      }),
    ).rejects.toThrow("executionContext");
    expect(keyProvider).not.toHaveBeenCalled();
    expect(store.sessions.size).toBe(0);
  });

  it("rejects malformed persisted context before using its fingerprints to merge cohorts", async () => {
    const { service } = harness();
    const completed = await complete(service);
    const invalid = structuredClone(completed);
    if (invalid.executionContext === undefined) throw new Error("expected caller context");
    invalid.executionContext.agentModel.fingerprint = "malformed";
    expect(() => buildDynamicProductComplexityReport(WORKSPACE, [invalid], NOW)).toThrow(
      "invalid execution context",
    );
    const leaking = structuredClone(completed);
    if (leaking.executionContext === undefined) throw new Error("expected caller context");
    leaking.executionContext.harness.text = "secret without consent";
    expect(() => buildDynamicProductComplexityReport(WORKSPACE, [leaking], NOW)).toThrow(
      "text retention",
    );
  });
});
