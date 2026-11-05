import {
  INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  MAX_SEARCH_JOURNEY_REASON_LENGTH,
  MAX_SEARCH_JOURNEY_TEXT_LENGTH,
  MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH,
  RANKER_VERSION,
  UntangleError,
  canonicalJson,
  hmacSha256Hex,
  searchJourneyValidationIssue,
  sha256Hex,
  type PortCallOptions,
  type SearchHitV1,
  type SearchJourneyStorePort,
  type SearchJourneyV1,
  type SearchResultSetV1,
  type SearchRetrievalDiagnosticsV1,
} from "@untangle-code/domain";
import { DeterministicRandom, FakeClock, textToSparseVector } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { HybridSearchEngine } from "./engine.js";
import {
  MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH,
  MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
  SearchJourneyService,
  assessSearchJourney,
  buildDynamicProductComplexityReport,
} from "./product-complexity.js";
import {
  TEST_COLLECTION,
  TEST_WORKSPACE_ID,
  buildInMemorySearchEngine,
} from "./testing/in-memory-index.js";

const WORKSPACE_ID = "ws-product-complexity";

class MemorySearchJourneyStore implements SearchJourneyStorePort {
  private readonly sessions = new Map<string, SearchJourneyV1>();

  public get(sessionId: string, options?: PortCallOptions): Promise<SearchJourneyV1 | null> {
    options?.signal?.throwIfAborted();
    const session = this.sessions.get(sessionId);
    return Promise.resolve(session === undefined ? null : structuredClone(session));
  }

  public put(
    session: SearchJourneyV1,
    options: PortCallOptions & { expectedRevision: number | null },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const current = this.sessions.get(session.sessionId);
    const expected = options.expectedRevision;
    const conflict = expected === null ? current !== undefined : current?.revision !== expected;
    if (conflict) {
      return Promise.reject(
        new UntangleError("SEARCH_SESSION_CONFLICT", "stale revision", {
          retryable: true,
        }),
      );
    }
    this.sessions.set(session.sessionId, structuredClone(session));
    return Promise.resolve();
  }

  public list(workspaceId: string, options?: PortCallOptions): Promise<SearchJourneyV1[]> {
    options?.signal?.throwIfAborted();
    return Promise.resolve(
      [...this.sessions.values()]
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => structuredClone(session)),
    );
  }
}

function searchHit(
  chunkId: string,
  filePath: string,
  rank: number,
  score: number,
  options: {
    generation?: string;
    profile?: string;
    complexity?: SearchHitV1["complexity"];
    incompletePayloadFields?: string[];
  } = {},
): SearchHitV1 {
  const embeddingProfileId = options.profile ?? "profile-v1";
  const indexGeneration = options.generation ?? "generation-v1";
  return {
    schemaVersion: 1,
    rank,
    repoId: "repo-a",
    repoLabel: "Repo A",
    refId: "ref-main",
    refName: "main",
    fileId: `file:${filePath}`,
    filePath,
    range: { startLine: 1, endLine: 4, startByte: 0, endByte: 40 },
    language: "typescript",
    parseQuality: "complete",
    chunkId,
    chunkKind: "function",
    symbolId: `symbol:${chunkId}`,
    symbolName: chunkId,
    symbolFqn: `Profile.${chunkId}`,
    symbolKind: "function",
    score: {
      schemaVersion: 1,
      final: score,
      components: [
        {
          kind: "base_hybrid",
          rawValue: score,
          weight: 1,
          contribution: score,
        },
      ],
      inputs: {},
      rankerVersion: RANKER_VERSION,
      clamped: false,
    },
    dedupeKey: `dedupe:${chunkId}`,
    relatedFragments: [],
    embeddingProfileId,
    indexGeneration,
    ...(options.complexity === undefined ? {} : { complexity: options.complexity }),
    ...(options.incompletePayloadFields === undefined
      ? {}
      : { incompletePayloadFields: options.incompletePayloadFields }),
  };
}

function codeComplexity(
  metricsScopeId: string,
  cognitive: number,
): NonNullable<SearchHitV1["complexity"]> {
  return {
    metricsScope: "symbol",
    metricsScopeId,
    metricsVersion: "untangle-metrics-v1",
    cognitive,
    cyclomaticExtended: Math.max(1, Math.ceil(cognitive / 2)),
    sloc: 12,
  };
}

function searchResult(
  query: string,
  hits: SearchHitV1[],
  retrievalOverrides: Partial<SearchRetrievalDiagnosticsV1> = {},
  workspaceId = WORKSPACE_ID,
): SearchResultSetV1 {
  const profile = hits[0]?.embeddingProfileId ?? "profile-v1";
  const retrieval: SearchRetrievalDiagnosticsV1 = {
    branchCandidateCounts: { dense: hits.length, sparse: hits.length, symbol: 0 },
    uniqueRetrievedCandidateCount: hits.length,
    eligibleCandidateCount: hits.length,
    rankedCandidateCount: hits.length,
    deduplicatedCandidateCount: hits.length,
    qualifiedHitCount: hits.length,
    returnedHitCount: hits.length,
    uniqueEligibleFileCount: new Set(hits.map((hit) => hit.filePath)).size,
    uniqueEligibleSymbolCount: new Set(hits.map((hit) => hit.symbolId)).size,
    eligibleFileDispersion: hits.length < 2 ? 0 : 1,
    topScoreGap: hits.length < 2 ? null : (hits[0]?.score.final ?? 0) - (hits[1]?.score.final ?? 0),
    candidateLimitReached: false,
    ...retrievalOverrides,
  };
  return {
    schemaVersion: 1,
    queryFingerprint: sha256Hex(query),
    rankingContextFingerprint: sha256Hex("ranking-context:hybrid-v1"),
    query: {
      schemaVersion: 1,
      text: query,
      workspaceId,
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
        embeddingProfileId: profile,
        corpusRevisionFingerprint: sha256Hex("corpus-revision:v1"),
        repoIds: ["repo-a"],
        hits,
        rankNormalized: false,
        caveats: [],
        retrieval,
      },
    ],
    profileSeparation: false,
    totalHits: hits.length,
    skipped: [],
    warnings: [],
  };
}

function legacyObservationFingerprint(result: SearchResultSetV1, seed = 17): string {
  return hmacSha256Hex(
    new Uint8Array(32).fill(seed),
    canonicalJson({
      schemaVersion: 1,
      namespace: "untangle-search-journey",
      workspaceId: result.query.workspaceId,
      purpose: "successful-observation",
      value: {
        queryFingerprint: result.queryFingerprint,
        queryText: result.query.text,
        rankerVersion: result.query.rankerVersion,
        rankingContextFingerprint: result.rankingContextFingerprint ?? null,
        resultLimit: result.query.limit,
        candidateLimit: result.query.candidateLimit,
        retrievalHealthy: true,
        groups: result.groups.map((group) => ({
          embeddingProfileId: group.embeddingProfileId,
          indexGenerations: group.indexGenerations ?? null,
          notSearchedReason: group.notSearchedReason,
          retrieval: group.retrieval,
          hits: group.hits.map((hit) => ({
            repoId: hit.repoId,
            refId: hit.refId,
            filePath: hit.filePath,
            chunkId: hit.chunkId,
            symbolId: hit.symbolId,
            symbolFqn: hit.symbolFqn,
            indexGeneration: hit.indexGeneration,
            rank: hit.rank,
            score: hit.score.final,
          })),
        })),
        warningCodes: [],
      },
    }),
  );
}

function harness(
  seed = 17,
  workspaceId = WORKSPACE_ID,
): {
  service: SearchJourneyService;
  store: MemorySearchJourneyStore;
  clock: FakeClock;
} {
  const store = new MemorySearchJourneyStore();
  const clock = new FakeClock(Date.parse("2026-09-06T10:00:00.000Z"));
  return {
    service: new SearchJourneyService({
      workspaceId,
      store,
      clock,
      random: new DeterministicRandom(seed),
      fingerprintKey: new Uint8Array(32).fill(seed),
    }),
    store,
    clock,
  };
}

describe("SearchJourneyService", () => {
  it("starts only with explicit recording and redacts goal and query text by default", async () => {
    const { service, store } = harness();
    const goal = "Improve the private profile-card rendering";
    const query = "secret internal profile card component";

    const started = await service.start({ goal });
    expect(started).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      workspaceId: WORKSPACE_ID,
      status: "active",
      recordingConsent: "explicit",
      retainText: false,
      attempts: [],
    });
    expect(started.goal.fingerprint).toHaveLength(64);
    expect(started.goal).not.toHaveProperty("text");

    const recorded = await service.recordSearch(
      started.sessionId,
      searchResult(query, [searchHit("profile-card", "src/profile/card.tsx", 1, 0.92)]),
    );
    expect(recorded.attempt.queryFingerprint).toHaveLength(64);
    expect(recorded.attempt).not.toHaveProperty("queryText");
    expect(recorded.attempt).toMatchObject({ resultLimit: 10, candidateLimit: 20 });

    const persisted = await store.get(started.sessionId);
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(goal);
    expect(serialized).not.toContain(query);

    const retained = await service.start({ goal, retainText: true });
    const retainedAttempt = await service.recordSearch(
      retained.sessionId,
      searchResult(query, [searchHit("profile-card", "src/profile/card.tsx", 1, 0.92)]),
    );
    expect(retained.goal.text).toBe(goal);
    expect(retainedAttempt.attempt.queryText).toBe(query);
  });

  it("binds changing task goals to a stable pseudonymous feature without retaining its ID", async () => {
    const featureId = "profile.cards.presentation";
    const left = harness(17, "workspace-left");
    const sameScope = harness(17, "workspace-left");
    const otherWorkspace = harness(17, "workspace-right");

    const first = await left.service.start({ goal: "Improve card spacing", featureId });
    const second = await sameScope.service.start({ goal: "Clarify card hierarchy", featureId });
    const elsewhere = await otherWorkspace.service.start({
      goal: "Improve card spacing",
      featureId,
    });

    expect(first.feature?.fingerprint).toHaveLength(64);
    expect(first.feature?.fingerprint).toBe(second.feature?.fingerprint);
    expect(first.feature?.fingerprint).not.toBe(elsewhere.feature?.fingerprint);
    expect(first.goal.fingerprint).not.toBe(second.goal.fingerprint);
    expect(first.feature).not.toHaveProperty("text");
    expect(JSON.stringify(first)).not.toContain(featureId);

    const retained = await left.service.start({
      goal: "Retained feature probe",
      featureId,
      retainText: true,
    });
    expect(retained.feature?.text).toBe(featureId);
    await expect(
      left.service.start({
        goal: "Oversized feature",
        featureId: "x".repeat(MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH + 1),
      }),
    ).rejects.toThrow("UTF-16 code units");
  });

  it("enforces persisted text and locator limits in direct service calls", async () => {
    const { service } = harness();
    await expect(
      service.start({ goal: "g".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH + 1) }),
    ).rejects.toThrow(/goal.*at most/u);

    const started = await service.start({ goal: "bounded journey", retainText: true });
    await expect(
      service.recordFailedSearch(started.sessionId, {
        query: "q".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH + 1),
        failureCode: "SEARCH_FAILED",
        failureReason: "failure",
      }),
    ).rejects.toThrow(/query.*at most/u);
    await expect(
      service.recordFailedSearch(started.sessionId, {
        query: "bounded query",
        failureCode: "SEARCH_FAILED",
        failureReason: "r".repeat(MAX_SEARCH_JOURNEY_REASON_LENGTH + 1),
      }),
    ).rejects.toThrow(/failureReason.*at most/u);
    await expect(
      service.observeNavigation(started.sessionId, {
        kind: "other-tool",
        toolName: "t".repeat(MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH + 1),
      }),
    ).rejects.toThrow(/toolName.*at most/u);
    await expect(
      service.complete(started.sessionId, {
        target: { filePath: "p".repeat(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH + 1) },
      }),
    ).rejects.toThrow(/target filePath.*at most/u);

    const oversizedCandidate = searchResult("bounded query", [
      searchHit("oversized-candidate", "p".repeat(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH + 1), 1, 0.9),
    ]);
    await expect(service.recordSearch(started.sessionId, oversizedCandidate)).rejects.toThrow(
      /search hit filePath.*at most/u,
    );

    const malformedCandidate = searchResult("bounded query", [
      searchHit("invalid-rank", "src/invalid.ts", 0, 0.9),
    ]);
    await expect(service.recordSearch(started.sessionId, malformedCandidate)).rejects.toMatchObject(
      {
        code: "SEARCH_SESSION_INVALID_STATE",
        operation: "search_journey_service",
      },
    );
    await expect(service.get(started.sessionId)).resolves.toMatchObject({ attempts: [] });

    const boundaryPath = "p".repeat(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH);
    await service.recordSearch(
      started.sessionId,
      searchResult("bounded query", [searchHit("boundary", boundaryPath, 1, 0.9)]),
    );
    const completed = await service.complete(started.sessionId, {
      target: { filePath: `  ${boundaryPath}  ` },
    });
    expect(completed.outcome).toMatchObject({
      kind: "completed",
      target: { filePath: boundaryPath },
      assessment: { targetWasReturned: true },
    });

    const navigationSession = await service.start({ goal: "normalize navigation target" });
    const observed = await service.observeNavigation(navigationSession.sessionId, {
      kind: "open-file",
      target: { filePath: "  src/profile/cards.ts  " },
    });
    expect(observed.navigation[0]?.target).toEqual({ filePath: "src/profile/cards.ts" });
  });

  it("scopes goal, query and observation fingerprints to the workspace", async () => {
    const text = "same private task text";
    const left = harness(17, "workspace-left");
    const right = harness(17, "workspace-right");
    const sameScope = harness(17, "workspace-left");
    const rotatedKey = harness(18, "workspace-left");
    const leftJourney = await left.service.start({ goal: text });
    const rightJourney = await right.service.start({ goal: text });
    const sameScopeJourney = await sameScope.service.start({ goal: text });
    const rotatedKeyJourney = await rotatedKey.service.start({ goal: text });
    const leftAttempt = await left.service.recordSearch(
      leftJourney.sessionId,
      searchResult(text, [searchHit("target", "src/target.ts", 1, 0.9)], {}, "workspace-left"),
    );
    const rightAttempt = await right.service.recordSearch(
      rightJourney.sessionId,
      searchResult(text, [searchHit("target", "src/target.ts", 1, 0.9)], {}, "workspace-right"),
    );

    expect(leftJourney.goal.fingerprint).not.toBe(rightJourney.goal.fingerprint);
    expect(leftJourney.goal.fingerprint).toBe(sameScopeJourney.goal.fingerprint);
    expect(leftJourney.goal.fingerprint).not.toBe(rotatedKeyJourney.goal.fingerprint);
    expect(leftJourney.goal.fingerprint).not.toBe(sha256Hex(text));
    expect(leftAttempt.attempt.queryFingerprint).not.toBe(rightAttempt.attempt.queryFingerprint);
    expect(leftAttempt.attempt.queryFingerprint).not.toBe(sha256Hex(text));
    expect(leftAttempt.attempt.observationFingerprint).not.toBe(
      rightAttempt.attempt.observationFingerprint,
    );
    expect(leftJourney.goal.fingerprint).not.toBe(leftAttempt.attempt.queryFingerprint);
  });

  it("derives rank, reformulation, churn and retrieval effort from two searches and an explicit target", async () => {
    const { service, clock } = harness();
    const started = await service.start({ goal: "Improve cards in the profile area" });

    const first = await service.recordSearch(
      started.sessionId,
      searchResult(
        "profile cards",
        [
          searchHit("settings-card", "src/settings/card.tsx", 1, 0.91),
          searchHit("shared-card", "src/ui/card.tsx", 2, 0.78),
        ],
        {
          branchCandidateCounts: { dense: 5, sparse: 0, symbol: 0 },
          uniqueRetrievedCandidateCount: 5,
          eligibleCandidateCount: 5,
          uniqueEligibleFileCount: 2,
          eligibleFileDispersion: 0.25,
          candidateLimitReached: true,
        },
      ),
    );
    clock.advance(1_000);
    const second = await service.recordSearch(
      started.sessionId,
      searchResult(
        "profile overview card presentation",
        [
          searchHit("shared-card", "src/ui/card.tsx", 1, 0.9),
          searchHit("profile-card", "src/profile/card.tsx", 2, 0.7, {
            complexity: codeComplexity("symbol:profile-card", 14),
          }),
        ],
        {
          branchCandidateCounts: { dense: 9, sparse: 0, symbol: 0 },
          uniqueRetrievedCandidateCount: 9,
          eligibleCandidateCount: 9,
          uniqueEligibleFileCount: 7,
          eligibleFileDispersion: 0.75,
          candidateLimitReached: false,
        },
      ),
    );
    await service.observeNavigation(started.sessionId, {
      kind: "open-file",
      target: { repoId: "repo-a", filePath: "src/profile/card.tsx" },
    });

    const completed = await service.complete(started.sessionId, {
      target: { repoId: "repo-a", chunkId: "profile-card" },
      acceptedAttemptId: second.attempt.attemptId,
    });

    expect(first.attempt.sequence).toBe(1);
    expect(second.attempt.sequence).toBe(2);
    expect(completed).toMatchObject({ status: "completed", revision: 4 });
    expect(completed.outcome?.kind).toBe("completed");
    if (completed.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    expect(completed.outcome.assessment).toMatchObject({
      searchesToTarget: 2,
      successfulSearchesToTarget: 2,
      failedSearchesToTarget: 0,
      distinctQueryCount: 2,
      queryReformulations: 1,
      acceptedTargetRank: 2,
      reciprocalRank: 0.5,
      targetWasReturned: true,
      targetFirstReturnedAtSearch: 2,
      targetAcceptedAtSearch: 2,
      selectionLagSearches: 0,
      directHit: false,
      eligibleCandidatesExamined: 14,
      uniqueCandidatesExposed: 3,
      uniqueFilesExposed: 3,
      navigationEventsToTarget: 1,
      observedToolAndFileHops: 3,
      candidateLimitHitRate: 0.5,
      healthyRetrievalRate: 1,
    });
    expect(completed.outcome.assessment.meanCandidateFileDispersion).toBeCloseTo(4 / 7);
    expect(completed.outcome.assessment.meanCandidateChurn).toBeCloseTo(2 / 3);
    expect(completed.outcome.assessment.acceptedTargetScoreMargin).toBeCloseTo(-0.2);
    expect(second.attempt.profiles[0]?.candidates[1]).toMatchObject({
      complexity: { metricsScopeId: "symbol:profile-card", cognitive: 14 },
      incompletePayloadFields: [],
    });
    expect(completed.outcome.assessment.acceptedTargetCodeComplexity).toMatchObject({
      status: "observed",
      source: "indexed-search-hit",
      candidate: {
        filePath: "src/profile/card.tsx",
        chunkId: "profile-card",
        indexGeneration: "generation-v1",
      },
      complexity: { metricsScopeId: "symbol:profile-card", cognitive: 14 },
      payloadComplete: true,
      incompletePayloadFields: [],
    });
    expect(completed.outcome.assessment.measurementContextId).toHaveLength(64);
  });

  it("requires a target identity but truthfully permits an externally found target", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Find the owning component" });
    await service.recordSearch(
      started.sessionId,
      searchResult("owning component", [searchHit("nearby", "src/nearby.ts", 1, 0.8)]),
    );

    await expect(service.complete(started.sessionId, { target: {} })).rejects.toThrow(
      "requires chunkId, symbolId or filePath",
    );
    expect((await service.get(started.sessionId)).status).toBe("active");

    const completed = await service.complete(started.sessionId, {
      target: { filePath: "external/manual-location.ts" },
    });
    if (completed.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    expect(completed.outcome.assessment).toMatchObject({
      searchesToTarget: 1,
      acceptedTargetRank: null,
      reciprocalRank: null,
      targetWasReturned: false,
      targetFirstReturnedAtSearch: null,
      targetAcceptedAtSearch: null,
      selectionLagSearches: null,
      acceptedTargetScoreMargin: null,
      acceptedTargetCodeComplexity: {
        status: "unavailable",
        reason: "target-not-returned",
      },
    });
    expect(completed.outcome.assessment.caveats.join(" ")).toContain(
      "not present in a returned result",
    );
  });

  it("does not attribute one code metric when a broad file target matches multiple chunks", async () => {
    const { service } = harness();
    const started = await service.start({
      goal: "Find the profile presentation owner",
      featureId: "profile.cards.presentation",
    });
    const recorded = await service.recordSearch(
      started.sessionId,
      searchResult(
        "profile presentation owner",
        [
          searchHit("render-card", "src/profile/card.tsx", 1, 0.92, {
            complexity: codeComplexity("symbol:render-card", 12),
          }),
          searchHit("load-card", "src/profile/card.tsx", 2, 0.81, {
            complexity: codeComplexity("symbol:load-card", 7),
          }),
        ],
        { eligibleFileDispersion: 0 },
      ),
    );
    const completed = await service.complete(started.sessionId, {
      target: { repoId: "repo-a", filePath: "src/profile/card.tsx" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });

    expect(completed.outcome).toMatchObject({
      kind: "completed",
      assessment: {
        acceptedTargetRank: 1,
        acceptedTargetCodeComplexity: {
          status: "unavailable",
          reason: "target-context-ambiguous",
        },
      },
    });
    expect(searchJourneyValidationIssue(completed)).toBeNull();
  });

  it("attributes duplicate candidate identities only when their code evidence agrees", async () => {
    const conflicting = harness();
    const conflictingStart = await conflicting.service.start({ goal: "Find the target" });
    const conflictingAttempt = await conflicting.service.recordSearch(
      conflictingStart.sessionId,
      searchResult(
        "target",
        [
          searchHit("target", "src/target.ts", 1, 0.9, {
            complexity: codeComplexity("symbol:target", 8),
          }),
          searchHit("target", "src/target.ts", 2, 0.8, {
            complexity: codeComplexity("symbol:target", 9),
          }),
        ],
        { eligibleFileDispersion: 0 },
      ),
    );
    const conflictingCompleted = await conflicting.service.complete(conflictingStart.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: conflictingAttempt.attempt.attemptId,
    });
    expect(conflictingCompleted.outcome).toMatchObject({
      kind: "completed",
      assessment: {
        acceptedTargetRank: 1,
        acceptedTargetCodeComplexity: {
          status: "unavailable",
          reason: "target-context-ambiguous",
        },
      },
    });
    expect(searchJourneyValidationIssue(conflictingCompleted)).toBeNull();

    const identical = harness();
    const identicalStart = await identical.service.start({ goal: "Find the target" });
    const exactComplexity = codeComplexity("symbol:target", 8);
    const identicalAttempt = await identical.service.recordSearch(
      identicalStart.sessionId,
      searchResult(
        "target",
        [
          searchHit("target", "src/target.ts", 1, 0.9, { complexity: exactComplexity }),
          searchHit("target", "src/target.ts", 2, 0.8, {
            complexity: structuredClone(exactComplexity),
          }),
        ],
        { eligibleFileDispersion: 0 },
      ),
    );
    const identicalCompleted = await identical.service.complete(identicalStart.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: identicalAttempt.attempt.attemptId,
    });
    expect(identicalCompleted.outcome).toMatchObject({
      kind: "completed",
      assessment: {
        acceptedTargetRank: 1,
        acceptedTargetCodeComplexity: {
          status: "observed",
          complexity: { metricsScopeId: "symbol:target", cognitive: 8 },
        },
      },
    });
    expect(searchJourneyValidationIssue(identicalCompleted)).toBeNull();
  });

  it("counts only attempts through an explicitly accepted earlier result", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Accept an earlier target" });
    const accepted = await service.recordSearch(
      started.sessionId,
      searchResult("exact target", [searchHit("target", "src/target.ts", 1, 0.95)]),
    );
    await service.recordSearch(
      started.sessionId,
      searchResult("late unrelated work", [searchHit("other", "src/other.ts", 1, 0.7)]),
    );

    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: accepted.attempt.attemptId,
    });
    if (completed.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    expect(completed.outcome.assessment).toMatchObject({
      searchesToTarget: 1,
      successfulSearchesToTarget: 1,
      distinctQueryCount: 1,
      directHit: true,
      eligibleCandidatesExamined: 1,
      uniqueCandidatesExposed: 1,
      observedToolAndFileHops: 1,
    });
    expect(searchJourneyValidationIssue(completed)).toBeNull();
  });

  it("persists the accepted attempt across repeated targets and out-of-order numbered arrivals", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Pin one repeated result" });
    const later = await service.recordSearch(
      started.sessionId,
      searchResult("later repeated target", [searchHit("target", "src/later.ts", 1, 0.72)]),
      { step: 3 },
    );
    await service.recordSearch(
      started.sessionId,
      searchResult("first unrelated result", [searchHit("near", "src/near.ts", 1, 0.81)]),
      { step: 1 },
    );
    const accepted = await service.recordSearch(
      started.sessionId,
      searchResult("accepted repeated target", [searchHit("target", "src/accepted.ts", 1, 0.94)]),
      { step: 2 },
    );

    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: accepted.attempt.attemptId,
    });
    if (completed.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    expect(completed.attempts.map((attempt) => attempt.clientStep)).toEqual([1, 2, 3]);
    expect(completed.outcome.acceptedAttemptId).toBe(accepted.attempt.attemptId);
    expect(completed.outcome.assessment).toMatchObject({
      searchesToTarget: 2,
      targetAcceptedAtSearch: 2,
      acceptedTargetRank: 1,
    });
    expect(searchJourneyValidationIssue(completed)).toBeNull();

    const dangling = structuredClone(completed);
    if (dangling.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    dangling.outcome.acceptedAttemptId = later.attempt.attemptId;
    expect(searchJourneyValidationIssue(dangling)).toBe("invalid completed outcome");

    const legacy = structuredClone(completed);
    if (legacy.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    delete legacy.outcome.acceptedAttemptId;
    expect(searchJourneyValidationIssue(legacy)).toBeNull();
  });

  it("counts every search through completion when no accepted attempt is supplied", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Confirm a previously returned target" });
    await service.recordSearch(
      started.sessionId,
      searchResult("exact target", [searchHit("target", "src/target.ts", 1, 0.95)]),
    );
    await service.recordSearch(
      started.sessionId,
      searchResult("late unrelated work", [searchHit("other", "src/other.ts", 1, 0.7)]),
    );

    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
    });
    if (completed.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    expect(completed.outcome.assessment).toMatchObject({
      searchesToTarget: 2,
      successfulSearchesToTarget: 2,
      distinctQueryCount: 2,
      targetFirstReturnedAtSearch: 1,
      targetAcceptedAtSearch: 1,
      directHit: false,
      eligibleCandidatesExamined: 2,
      uniqueCandidatesExposed: 2,
      observedToolAndFileHops: 2,
    });
    expect(completed.outcome.assessment.caveats.join(" ")).toContain(
      "No acceptedAttemptId was supplied",
    );
    expect(searchJourneyValidationIssue(completed)).toBeNull();
  });

  it("counts a failed retry of the same text as effort, not as a reformulation or new cohort", async () => {
    const { service } = harness();
    const withFailure = await service.start({ goal: "Find after a transient failure" });
    const failedAttempt = await service.recordFailedSearch(withFailure.sessionId, {
      query: "exact target",
      failureCode: "QDRANT_UNAVAILABLE",
      failureReason: "provider unavailable",
    });
    const recovered = await service.recordSearch(
      withFailure.sessionId,
      searchResult("exact target", [searchHit("target", "src/target.ts", 1, 0.95)]),
    );
    expect(failedAttempt.attempt.queryFingerprint).toBe(recovered.attempt.queryFingerprint);
    const failedCompletion = await service.complete(withFailure.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: recovered.attempt.attemptId,
    });
    if (failedCompletion.outcome?.kind !== "completed") {
      throw new Error("expected completed outcome");
    }
    expect(failedCompletion.outcome.assessment).toMatchObject({
      searchesToTarget: 2,
      failedSearchesToTarget: 1,
      successfulSearchesToTarget: 1,
      distinctQueryCount: 1,
      queryReformulations: 0,
      healthyRetrievalRate: 0.5,
      measurementContextComplete: false,
    });

    const healthy = await service.start({ goal: "Find without a transient failure" });
    const direct = await service.recordSearch(
      healthy.sessionId,
      searchResult("exact target", [searchHit("target", "src/target.ts", 1, 0.95)]),
    );
    const healthyCompletion = await service.complete(healthy.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: direct.attempt.attemptId,
    });
    if (healthyCompletion.outcome?.kind !== "completed") {
      throw new Error("expected completed outcome");
    }
    expect(failedCompletion.outcome.assessment.measurementContextId).toBe(
      healthyCompletion.outcome.assessment.measurementContextId,
    );
  });

  it("never treats recovered failed searches as complete cohort evidence", async () => {
    const { service } = harness();
    for (let index = 1; index <= MINIMUM_PRODUCT_COMPLEXITY_SESSIONS; index += 1) {
      const target = `target-${String(index)}`;
      const started = await service.start({ goal: `Recovered task ${String(index)}` });
      await service.recordFailedSearch(started.sessionId, {
        query: target,
        failureCode: "QDRANT_UNAVAILABLE",
        failureReason: "provider unavailable",
      });
      const recovered = await service.recordSearch(
        started.sessionId,
        searchResult(target, [searchHit(target, `src/${target}.ts`, 1, 0.95)]),
      );
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: target },
        acceptedAttemptId: recovered.attempt.attemptId,
      });
      if (completed.outcome?.kind !== "completed") throw new Error("expected completion");
      expect(completed.outcome.assessment.measurementContextComplete).toBe(false);
    }

    const report = await service.report();
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]).toMatchObject({
      completedSessionCount: MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
      measurementContextComplete: false,
      sufficientEvidence: false,
    });
  });

  it("keeps rank profile-local when a confirmed target appears in multiple profiles", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Find a cross-profile target" });
    const result = searchResult("shared target", [
      searchHit("distractor", "src/distractor.ts", 1, 0.85, { profile: "profile-a" }),
      searchHit("target", "src/target.ts", 2, 0.8, { profile: "profile-a" }),
    ]);
    const secondHit = searchHit("target", "src/target.ts", 1, 0.9, {
      profile: "profile-b",
    });
    result.groups.push({
      embeddingProfileId: "profile-b",
      repoIds: ["repo-a"],
      hits: [secondHit],
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
    });
    result.profileSeparation = true;
    result.totalHits = 3;

    const recorded = await service.recordSearch(started.sessionId, result);
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });
    if (completed.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    expect(completed.outcome.assessment).toMatchObject({
      targetWasReturned: true,
      acceptedTargetRank: null,
      reciprocalRank: null,
      acceptedTargetScoreMargin: null,
    });
    expect(completed.outcome.assessment.caveats.join(" ")).toContain(
      "multiple embedding-profile or generation contexts",
    );

    const pinned = await service.start({ goal: "Find the target in profile B" });
    const pinnedAttempt = await service.recordSearch(pinned.sessionId, result);
    const pinnedCompletion = await service.complete(pinned.sessionId, {
      target: { chunkId: "target", embeddingProfileId: "profile-b" },
      acceptedAttemptId: pinnedAttempt.attempt.attemptId,
    });
    if (pinnedCompletion.outcome?.kind !== "completed") {
      throw new Error("expected completed outcome");
    }
    expect(pinnedCompletion.outcome.assessment).toMatchObject({
      targetWasReturned: true,
      acceptedTargetRank: 1,
      reciprocalRank: 1,
    });
  });

  it("rejects duplicate embedding-profile groups before persisting an observation", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Reject an ambiguous result envelope" });
    const result = searchResult("target", [searchHit("target", "src/target.ts", 1, 0.9)]);
    result.groups.push(structuredClone(result.groups[0] as (typeof result.groups)[number]));

    await expect(service.recordSearch(started.sessionId, result)).rejects.toMatchObject({
      code: "SEARCH_SESSION_INVALID_STATE",
    });
    await expect(service.get(started.sessionId)).resolves.toMatchObject({
      revision: 0,
      attempts: [],
    });
  });

  it("separates a searched empty profile from an otherwise identical single-profile context", async () => {
    const { service } = harness();
    const complete = async (withEmptyProfile: boolean): Promise<string> => {
      const started = await service.start({ goal: "Compare profile topology" });
      const result = searchResult("target", [searchHit("target", "src/target.ts", 1, 0.9)]);
      if (withEmptyProfile) {
        result.groups.push({
          embeddingProfileId: "profile-empty",
          repoIds: [],
          hits: [],
          rankNormalized: false,
          caveats: [],
          retrieval: {
            branchCandidateCounts: { dense: 0, sparse: 0, symbol: 0 },
            uniqueRetrievedCandidateCount: 0,
            eligibleCandidateCount: 0,
            rankedCandidateCount: 0,
            deduplicatedCandidateCount: 0,
            qualifiedHitCount: 0,
            returnedHitCount: 0,
            uniqueEligibleFileCount: 0,
            uniqueEligibleSymbolCount: 0,
            eligibleFileDispersion: 0,
            topScoreGap: null,
            candidateLimitReached: false,
          },
        });
        result.profileSeparation = true;
      }
      const recorded = await service.recordSearch(started.sessionId, result);
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: "target" },
        acceptedAttemptId: recorded.attempt.attemptId,
      });
      if (completed.outcome?.kind !== "completed") throw new Error("expected completion");
      expect(completed.outcome.assessment.measurementContextComplete).toBe(!withEmptyProfile);
      return completed.outcome.assessment.measurementContextId;
    };

    await expect(complete(false)).resolves.not.toBe(await complete(true));
  });

  it("never treats partially unhealthy retrieval as complete cohort evidence", async () => {
    const { service } = harness();
    for (let index = 1; index <= MINIMUM_PRODUCT_COMPLEXITY_SESSIONS; index += 1) {
      const started = await service.start({ goal: `Partially degraded task ${String(index)}` });
      const result = searchResult(`target ${String(index)}`, [
        searchHit(`target-${String(index)}`, `src/target-${String(index)}.ts`, 1, 0.9),
      ]);
      result.skipped.push({
        schemaVersion: 1,
        stage: "search",
        subjectKind: "search_candidate",
        reason: "provider_unavailable",
        detail: "a configured embedding profile was unavailable",
        recoverable: true,
      });
      const recorded = await service.recordSearch(started.sessionId, result);
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: `target-${String(index)}` },
        acceptedAttemptId: recorded.attempt.attemptId,
      });
      if (completed.outcome?.kind !== "completed") throw new Error("expected completion");
      expect(completed.outcome.assessment.measurementContextComplete).toBe(false);
      expect(searchJourneyValidationIssue(completed)).toBeNull();
    }

    const report = await service.report();
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]).toMatchObject({
      completedSessionCount: MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
      measurementContextComplete: false,
      sufficientEvidence: false,
    });
  });

  it("keeps fallback hits usable without promoting their journey to complete measurement evidence", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine([
      {
        chunkId: "charge",
        symbolId: "sym-charge",
        symbolName: "charge",
        filePath: "src/charge.ts",
        content: "function charge() { return gateway.send(); }",
      },
    ]);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          collection: TEST_COLLECTION,
          embeddingProfileId: embedder.profileId,
          repoIds: ["repo-a"],
          embedder,
          indexContexts: [
            {
              repoId: "repo-a",
              refId: "ref-main",
              generationId: "gen-1",
              corpusRevisionFingerprint: "a".repeat(64),
              outcome: "completed",
            },
          ],
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      sparseVectorizer: textToSparseVector,
      clock,
    });
    vi.spyOn(embedder, "embedQuery").mockRejectedValue(
      new UntangleError("EMBEDDING_UNAVAILABLE", "Ollama is offline"),
    );
    const result = await engine.search({ query: "charge" });
    expect(result.groups[0]?.hits[0]?.chunkId).toBe("charge");
    expect(result.groups[0]?.corpusRevisionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    // The warning is independently authoritative even for a caller that
    // supplies no skip ledger with its otherwise valid result projection.
    const { service } = harness(17, TEST_WORKSPACE_ID);
    for (let index = 0; index < MINIMUM_PRODUCT_COMPLEXITY_SESSIONS; index += 1) {
      const started = await service.start({ goal: "Find charge through fallback retrieval" });
      const recorded = await service.recordSearch(started.sessionId, { ...result, skipped: [] });
      expect(recorded.attempt.retrievalHealthy).toBe(false);
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: "charge" },
        acceptedAttemptId: recorded.attempt.attemptId,
      });
      expect(completed.outcome).toMatchObject({
        kind: "completed",
        assessment: { targetWasReturned: true, measurementContextComplete: false },
      });
      expect(searchJourneyValidationIssue(completed)).toBeNull();
    }
    const report = await service.report();
    expect(report.cohorts[0]).toMatchObject({
      completedSessionCount: MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
      measurementContextComplete: false,
      sufficientEvidence: false,
    });
  });

  it("never treats missing retrieval diagnostics as sufficient cohort evidence", async () => {
    const { service } = harness();
    for (let index = 1; index <= MINIMUM_PRODUCT_COMPLEXITY_SESSIONS; index += 1) {
      const target = `legacy-target-${String(index)}`;
      const started = await service.start({ goal: `Legacy diagnostics task ${String(index)}` });
      const result = searchResult(target, [searchHit(target, `src/${target}.ts`, 1, 0.9)]);
      const group = result.groups[0];
      if (group === undefined) throw new Error("expected profile group");
      delete group.retrieval;
      const recorded = await service.recordSearch(started.sessionId, result);
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: target },
        acceptedAttemptId: recorded.attempt.attemptId,
      });
      expect(completed.outcome).toMatchObject({
        kind: "completed",
        assessment: { measurementContextComplete: false },
      });
      expect(searchJourneyValidationIssue(completed)).toBeNull();
    }

    const report = await service.report();
    expect(report.cohorts).toHaveLength(1);
    expect(report.cohorts[0]).toMatchObject({
      completedSessionCount: MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
      measurementContextComplete: false,
      sufficientEvidence: false,
    });
  });

  it("never treats an incomplete index generation as healthy journey evidence", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Find in a partially written index" });
    const result = searchResult("target", [searchHit("target", "src/target.ts", 1, 0.9)]);
    result.warnings.push({
      code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
      message: "index run was cancelled after writing partial points",
    });
    const recorded = await service.recordSearch(started.sessionId, result);
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });

    expect(completed.outcome).toMatchObject({
      kind: "completed",
      assessment: {
        healthyRetrievalRate: 0,
        measurementContextComplete: false,
      },
    });
    expect(searchJourneyValidationIssue(completed)).toBeNull();
  });

  it("keeps stale-index fallback hits out of complete journey measurement contexts", async () => {
    const { service } = harness();
    const result = searchResult("target", [searchHit("target", "src/target.ts", 1, 0.9)]);
    const group = result.groups[0];
    if (group === undefined) throw new Error("expected profile group");
    // CLI freshness projection preserves usable hits but removes an unverified
    // corpus fingerprint and marks the context as incomplete.
    delete group.corpusRevisionFingerprint;
    result.warnings.push({
      code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
      message: "the indexed source revision differs from the current working tree",
      details: { freshness: "stale" },
    });

    for (let index = 0; index < MINIMUM_PRODUCT_COMPLEXITY_SESSIONS; index += 1) {
      const started = await service.start({ goal: "Find a target in an older index" });
      const recorded = await service.recordSearch(started.sessionId, result);
      expect(recorded.attempt.retrievalHealthy).toBe(false);
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: "target" },
        acceptedAttemptId: recorded.attempt.attemptId,
      });
      expect(completed.outcome).toMatchObject({
        kind: "completed",
        assessment: { targetWasReturned: true, measurementContextComplete: false },
      });
      expect(searchJourneyValidationIssue(completed)).toBeNull();
    }

    const report = await service.report();
    expect(report.cohorts[0]).toMatchObject({
      measurementContextComplete: false,
      sufficientEvidence: false,
    });
  });

  it("keeps a usable result with an unreadable index candidate out of healthy evidence", async () => {
    const { engine, store } = await buildInMemorySearchEngine([
      {
        chunkId: "valid-target",
        repoId: "repo-a",
        refId: "ref-main",
        filePath: "src/valid-target.ts",
        symbolId: "symbol:valid-target",
        symbolName: "charge",
        content: "export function charge() { return true; }",
      },
    ]);
    await store.upsert(TEST_COLLECTION, [
      {
        id: "broken-point",
        dense: new Array<number>(64).fill(0.1),
        sparse: textToSparseVector("charge charge charge"),
        payload: {
          point_type: "code_chunk",
          workspace_id: TEST_WORKSPACE_ID,
          repo_id: "repo-a",
          symbol_name: "charge",
        },
      },
    ]);
    const result = await engine.search({ query: "charge", limit: 5 });
    expect(result.groups.flatMap((group) => group.hits)).not.toHaveLength(0);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        subjectId: "broken-point",
        subjectKind: "search_candidate",
        reason: "missing_index_entry",
      }),
    );

    const { service } = harness(17, TEST_WORKSPACE_ID);
    const started = await service.start({ goal: "Find the valid charge implementation" });
    const recorded = await service.recordSearch(started.sessionId, result);
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "valid-target" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });

    expect(completed.outcome).toMatchObject({
      kind: "completed",
      assessment: {
        healthyRetrievalRate: 0,
        measurementContextComplete: false,
      },
    });
    expect(searchJourneyValidationIssue(completed)).toBeNull();
  });

  it("does not treat substituted hit payload fields as healthy journey evidence", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Find a target with complete provenance" });
    const result = searchResult("target", [
      searchHit("target", "src/target.ts", 1, 0.9, {
        complexity: codeComplexity("symbol:target", 10),
        incompletePayloadFields: ["metrics_version"],
      }),
    ]);
    result.warnings.push({
      code: "INCOMPLETE_PAYLOAD",
      message: "the hit contains documented substitutes for missing index payload fields",
    });
    const recorded = await service.recordSearch(started.sessionId, result);
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });

    expect(completed.outcome).toMatchObject({
      kind: "completed",
      assessment: {
        healthyRetrievalRate: 0,
        measurementContextComplete: false,
        acceptedTargetCodeComplexity: {
          status: "observed",
          payloadComplete: false,
          incompletePayloadFields: ["metrics_version"],
        },
      },
    });
    expect(searchJourneyValidationIssue(completed)).toBeNull();
  });

  it("keeps an unknown index generation out of sufficient cohort evidence", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Legacy generation context" });
    const legacyResult = searchResult("target", [
      searchHit("target", "src/target.ts", 1, 0.9, { generation: "unknown" }),
    ]);
    if (legacyResult.groups[0] === undefined) throw new Error("expected profile group");
    legacyResult.groups[0].indexGenerations = ["unknown"];
    const recorded = await service.recordSearch(started.sessionId, legacyResult);
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });

    expect(completed.outcome).toMatchObject({
      kind: "completed",
      assessment: { measurementContextComplete: false },
    });
  });

  it("keeps a healthy no-hit search comparable when the searched generation is known", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Find after a healthy empty result" });
    const empty = searchResult("broad first attempt", []);
    if (empty.groups[0] === undefined) throw new Error("expected profile group");
    empty.groups[0].indexGenerations = ["generation-v1"];
    await service.recordSearch(started.sessionId, empty);
    const found = await service.recordSearch(
      started.sessionId,
      searchResult("precise target", [searchHit("target", "src/target.ts", 1, 0.9)]),
    );
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: found.attempt.attemptId,
    });

    expect(completed.outcome).toMatchObject({
      kind: "completed",
      assessment: {
        searchesToTarget: 2,
        targetFirstReturnedAtSearch: 2,
        measurementContextComplete: true,
      },
    });
  });

  it("does not call a cohort sufficient before three comparable completions", async () => {
    const { service } = harness();

    const completeOne = async (
      index: number,
      generation = "generation-v1",
      resultLimit = 10,
      rankingContextFingerprint = sha256Hex("ranking-context:hybrid-v1"),
    ): Promise<void> => {
      const journey = await service.start({ goal: `Task ${String(index)}` });
      const target = searchHit(
        `target-${String(index)}`,
        `src/target-${String(index)}.ts`,
        1,
        0.9,
        { generation },
      );
      const result = searchResult(`target ${String(index)}`, [target]);
      result.query.limit = resultLimit;
      result.query.candidateLimit = Math.max(resultLimit, 20);
      result.rankingContextFingerprint = rankingContextFingerprint;
      const recorded = await service.recordSearch(journey.sessionId, result);
      await service.complete(journey.sessionId, {
        target: { chunkId: target.chunkId },
        acceptedAttemptId: recorded.attempt.attemptId,
      });
    };

    await completeOne(1);
    await completeOne(2);
    const tooSmall = await service.report();
    expect(tooSmall.cohorts).toHaveLength(1);
    expect(tooSmall.cohorts[0]).toMatchObject({
      completedSessionCount: 2,
      sufficientEvidence: false,
      minimumCompletedSessions: MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
    });

    await completeOne(3);
    const sufficient = await service.report();
    expect(sufficient.cohorts[0]).toMatchObject({
      completedSessionCount: 3,
      sufficientEvidence: true,
      directHitRate: 1,
      targetReturnedRate: 1,
      medianSearchesToTarget: 1,
    });

    await completeOne(4, "generation-v2");
    const segmented = await service.report();
    expect(segmented.cohorts).toHaveLength(2);
    expect(segmented.cohorts.map((cohort) => cohort.completedSessionCount).sort()).toEqual([1, 3]);

    await completeOne(5, "generation-v1", 5);
    const limitSegmented = await service.report();
    expect(limitSegmented.cohorts).toHaveLength(3);
    expect(limitSegmented.cohorts.map((cohort) => cohort.completedSessionCount).sort()).toEqual([
      1, 1, 3,
    ]);

    await completeOne(6, "generation-v1", 10, sha256Hex("ranking-context:lexical-v1"));
    const rankingSegmented = await service.report();
    expect(rankingSegmented.cohorts).toHaveLength(4);
    expect(rankingSegmented.cohorts.map((cohort) => cohort.completedSessionCount).sort()).toEqual([
      1, 1, 1, 3,
    ]);
  });

  it("maps only explicit stable features across search and target-code complexity axes", async () => {
    const { service } = harness();
    const completeFeature = async (
      featureId: string | undefined,
      goal: string,
      chunkId: string,
      cognitive: number,
      generation = "generation-v1",
    ): Promise<SearchJourneyV1> => {
      const started = await service.start({
        goal,
        ...(featureId === undefined ? {} : { featureId }),
      });
      const hit = searchHit(chunkId, `src/${chunkId}.ts`, 1, 0.9, {
        generation,
        complexity: codeComplexity(`symbol:${chunkId}`, cognitive),
      });
      const attempt = await service.recordSearch(started.sessionId, searchResult(goal, [hit]));
      return await service.complete(started.sessionId, {
        target: { chunkId },
        acceptedAttemptId: attempt.attempt.attemptId,
      });
    };

    const first = await completeFeature(
      "profile.cards",
      "Improve the profile cards",
      "profile-card",
      8,
    );
    await completeFeature("profile.cards", "Improve the profile cards", "profile-card", 8);
    await completeFeature("profile.cards", "Clarify profile card hierarchy", "card-layout", 13);
    await completeFeature(
      "profile.cards",
      "Probe the profile cards after reindexing",
      "profile-card",
      9,
      "generation-v2",
    );
    const other = await completeFeature("billing.invoice", "Find invoice rendering", "invoice", 5);
    await completeFeature(undefined, "Unscoped legacy-style task", "unscoped", 3);

    const report = await service.report();
    expect(report.sessionCounts.featureTaggedCompleted).toBe(5);
    expect(report.cohorts).toHaveLength(2);
    expect(report.cohorts.map((cohort) => cohort.completedSessionCount).sort()).toEqual([1, 5]);
    expect(report.featureMappings).toHaveLength(3);
    if (first.outcome?.kind !== "completed") throw new Error("expected completed feature probe");
    const firstMeasurementContextId = first.outcome.assessment.measurementContextId;
    const profileMapping = report.featureMappings.find(
      (mapping) =>
        mapping.featureFingerprint === first.feature?.fingerprint &&
        mapping.measurementContextId === firstMeasurementContextId,
    );
    const billingMapping = report.featureMappings.find(
      (mapping) => mapping.featureFingerprint === other.feature?.fingerprint,
    );
    expect(profileMapping).toMatchObject({
      distinctGoalCount: 2,
      search: {
        completedSessionCount: 3,
        sufficientEvidence: true,
        medianSearchesToTarget: 1,
      },
      code: {
        confirmedTargetCount: 2,
        observedComplexitySessionCount: 3,
        unavailableComplexitySessionCount: 0,
      },
    });
    expect(profileMapping?.measurementContextId).toBe(profileMapping?.search.measurementContextId);
    expect(
      profileMapping?.code.targets.find((entry) => entry.target.chunkId === "profile-card"),
    ).toMatchObject({
      completedSessionCount: 2,
      complexityVariants: [
        {
          completedSessionCount: 2,
          evidence: {
            status: "observed",
            complexity: { cognitive: 8, metricsScopeId: "symbol:profile-card" },
          },
        },
      ],
    });
    expect(billingMapping?.search).toMatchObject({
      completedSessionCount: 1,
      sufficientEvidence: false,
    });
    expect(
      report.featureMappings.filter(
        (mapping) => mapping.featureFingerprint === first.feature?.fingerprint,
      ),
    ).toHaveLength(2);
    expect(profileMapping).not.toHaveProperty("combinedScore");
    expect(profileMapping?.caveats.join(" ")).toContain("target-locator precision");
  });

  it("preserves complete attempt-context tuples and marks policy changes incomplete", async () => {
    const { service } = harness();
    type Context = {
      ranking: string;
      generation: string;
      resultLimit: number;
      candidateLimit: number;
    };
    const run = async (goal: string, contexts: readonly Context[]) => {
      const started = await service.start({ goal });
      let acceptedAttemptId = "";
      for (const [index, context] of contexts.entries()) {
        const target = index === contexts.length - 1;
        const result = searchResult(`query-${String(index + 1)}`, [
          searchHit(
            target ? "target" : `near-${String(index + 1)}`,
            target ? "src/target.ts" : `src/near-${String(index + 1)}.ts`,
            1,
            0.9,
            { generation: context.generation },
          ),
        ]);
        result.rankingContextFingerprint = context.ranking;
        result.query.limit = context.resultLimit;
        result.query.candidateLimit = context.candidateLimit;
        acceptedAttemptId = (
          await service.recordSearch(started.sessionId, result, { step: index + 1 })
        ).attempt.attemptId;
      }
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: "target" },
        acceptedAttemptId,
      });
      if (completed.outcome?.kind !== "completed") throw new Error("expected completion");
      expect(searchJourneyValidationIssue(completed)).toBeNull();
      return completed.outcome.assessment;
    };
    const contextOne = sha256Hex("context-one");
    const contextTwo = sha256Hex("context-two");
    const first = await run("first crossed context", [
      { ranking: contextOne, generation: "generation-1", resultLimit: 5, candidateLimit: 10 },
      { ranking: contextTwo, generation: "generation-2", resultLimit: 10, candidateLimit: 20 },
    ]);
    const crossed = await run("second crossed context", [
      { ranking: contextOne, generation: "generation-2", resultLimit: 10, candidateLimit: 20 },
      { ranking: contextTwo, generation: "generation-1", resultLimit: 5, candidateLimit: 10 },
    ]);

    expect(first.measurementContextId).not.toBe(crossed.measurementContextId);
    expect(first.measurementContextComplete).toBe(false);
    expect(crossed.measurementContextComplete).toBe(false);
  });

  it("separates immutable corpus revisions even when the generation id is reused", async () => {
    const { service } = harness();
    const run = async (corpusRevisionFingerprint: string) => {
      const started = await service.start({ goal: `probe ${corpusRevisionFingerprint[0]}` });
      const result = searchResult("same query", [
        searchHit("target", "src/target.ts", 1, 0.9, { generation: "resumed-generation" }),
      ]);
      const group = result.groups[0];
      if (group === undefined) throw new Error("expected search group");
      group.corpusRevisionFingerprint = corpusRevisionFingerprint;
      const recorded = await service.recordSearch(started.sessionId, result);
      const completed = await service.complete(started.sessionId, {
        target: { chunkId: "target" },
        acceptedAttemptId: recorded.attempt.attemptId,
      });
      if (completed.outcome?.kind !== "completed") throw new Error("expected completion");
      return completed.outcome.assessment;
    };

    const first = await run("a".repeat(64));
    const second = await run("b".repeat(64));
    expect(first.measurementContextComplete).toBe(true);
    expect(second.measurementContextComplete).toBe(true);
    expect(first.measurementContextId).not.toBe(second.measurementContextId);
  });

  it("keeps legacy corpus contexts visible but never sufficient in reports", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "legacy corpus context" });
    const recorded = await service.recordSearch(
      started.sessionId,
      searchResult("target", [searchHit("target", "src/target.ts", 1, 0.9)]),
    );
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });
    const legacy = structuredClone(completed);
    for (const attempt of legacy.attempts) {
      delete attempt.measurementContextVersion;
      for (const profile of attempt.profiles) delete profile.corpusRevisionFingerprint;
    }
    if (legacy.outcome?.kind !== "completed") throw new Error("expected completion");
    legacy.outcome.assessment = assessSearchJourney(legacy, {
      target: legacy.outcome.target,
      acceptedAttemptId: recorded.attempt.attemptId,
    });
    expect(legacy.outcome.assessment.measurementContextComplete).toBe(true);

    const report = buildDynamicProductComplexityReport(
      WORKSPACE_ID,
      [legacy],
      "2026-09-06T10:00:05.000Z",
    );
    expect(report.cohorts[0]).toMatchObject({
      completedSessionCount: 1,
      measurementContextComplete: false,
      sufficientEvidence: false,
    });
    expect(report.cohorts[0]?.caveats.join(" ")).toContain("incomplete");
  });

  it("keeps abandoned sessions visible but excludes them from product-complexity cohorts", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "A task with no confirmed target" });
    await service.recordFailedSearch(started.sessionId, {
      query: "profile mystery",
      failureCode: "QDRANT_UNAVAILABLE",
      failureReason: "local provider unavailable",
    });
    const failed = await service.get(started.sessionId);
    expect(failed.attempts[0]).not.toHaveProperty("queryText");
    expect(failed.attempts[0]).not.toHaveProperty("failureReason");
    expect(JSON.stringify(failed)).not.toContain("profile mystery");
    expect(JSON.stringify(failed)).not.toContain("local provider unavailable");

    const abandoned = await service.abandon(started.sessionId, {
      reasonCode: "cancelled",
      reason: " agent stopped ",
    });
    expect(abandoned).toMatchObject({
      status: "abandoned",
      revision: 2,
      outcome: { kind: "abandoned", reasonCode: "cancelled" },
    });
    expect(abandoned.outcome).not.toHaveProperty("reason");
    expect(searchJourneyValidationIssue(abandoned)).toBeNull();

    const retained = await service.start({ goal: "Retained abandonment", retainText: true });
    const retainedAbandonment = await service.abandon(retained.sessionId, {
      reasonCode: "other",
      reason: " agent supplied detail ",
    });
    expect(retainedAbandonment.outcome).toMatchObject({
      kind: "abandoned",
      reasonCode: "other",
      reason: "agent supplied detail",
    });
    expect(searchJourneyValidationIssue(retainedAbandonment)).toBeNull();
    await expect(
      service.recordFailedSearch(started.sessionId, {
        query: "another query",
        failureCode: "QDRANT_UNAVAILABLE",
        failureReason: "still unavailable",
      }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_INVALID_STATE" });

    const report = await service.report();
    expect(report.sessionCounts).toEqual({
      total: 2,
      active: 0,
      completed: 0,
      featureTaggedCompleted: 0,
      abandoned: 2,
    });
    expect(report.cohorts).toEqual([]);
  });

  it("orders explicit client steps, deduplicates retries and rejects gaps or conflicting retries", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Parallel agent search" });
    const secondResult = searchResult("second", [searchHit("target", "src/target.ts", 1, 0.9)]);
    const second = await service.recordSearch(started.sessionId, secondResult, { step: 2 });
    const firstResult = searchResult("first", [searchHit("near", "src/near.ts", 1, 0.8)]);
    await service.recordSearch(started.sessionId, firstResult, { step: 1 });

    const ordered = await service.get(started.sessionId);
    expect(ordered.attempts.map((attempt) => [attempt.clientStep, attempt.sequence])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    const retried = await service.recordSearch(started.sessionId, secondResult, { step: 2 });
    expect(retried.attempt.attemptId).toBe(second.attempt.attemptId);
    expect(retried.session.attempts).toHaveLength(2);
    expect(retried.session.revision).toBe(2);
    await expect(
      service.recordSearch(started.sessionId, searchResult("conflict", []), { step: 2 }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_CONFLICT" });

    const gap = await service.start({ goal: "Missing step" });
    await service.recordSearch(gap.sessionId, secondResult, { step: 2 });
    await expect(
      service.complete(gap.sessionId, { target: { chunkId: "target" } }),
    ).rejects.toThrow("missing client step(s): 1");

    const mixed = await service.start({ goal: "Mixed ordering mode" });
    await service.recordSearch(mixed.sessionId, firstResult);
    await expect(
      service.recordSearch(mixed.sessionId, secondResult, { step: 2 }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_INVALID_STATE" });
  });

  it("keeps numbered retries idempotent after completion and rejects divergent replays", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Retry after a terminal response" });
    const result = searchResult("exact target", [searchHit("target", "src/target.ts", 1, 0.9)]);
    const recorded = await service.recordSearch(started.sessionId, result, { step: 1 });
    const completed = await service.complete(started.sessionId, {
      target: { chunkId: "target" },
      acceptedAttemptId: recorded.attempt.attemptId,
    });

    const replayed = await service.recordSearch(started.sessionId, result, { step: 1 });
    expect(replayed).toMatchObject({
      session: { status: "completed", revision: completed.revision },
      attempt: { attemptId: recorded.attempt.attemptId },
    });
    await expect(
      service.recordSearch(started.sessionId, searchResult("different evidence", []), { step: 1 }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_CONFLICT" });
    await expect(
      service.recordSearch(started.sessionId, result, { step: 2 }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_INVALID_STATE" });
    await expect(service.get(started.sessionId)).resolves.toEqual(completed);
  });

  it("keeps a legacy numbered observation replayable after code-evidence fingerprinting", async () => {
    const { service, store } = harness();
    const started = await service.start({ goal: "Replay an older recorded search" });
    const result = searchResult("exact target", [
      searchHit("target", "src/target.ts", 1, 0.9, {
        complexity: codeComplexity("symbol:target", 8),
      }),
    ]);
    await service.recordSearch(started.sessionId, result, { step: 1 });
    const legacy = await service.get(started.sessionId);
    const attempt = legacy.attempts[0];
    if (attempt === undefined) throw new Error("expected recorded attempt");
    attempt.observationFingerprint = legacyObservationFingerprint(result);
    for (const candidate of attempt.profiles.flatMap((profile) => profile.candidates)) {
      delete candidate.complexity;
      delete candidate.incompletePayloadFields;
    }
    legacy.revision += 1;
    await store.put(legacy, { expectedRevision: legacy.revision - 1 });

    await expect(
      service.recordSearch(started.sessionId, result, { step: 1 }),
    ).resolves.toMatchObject({
      session: { revision: legacy.revision },
      attempt: { observationFingerprint: legacyObservationFingerprint(result) },
    });
  });

  it("keeps a numbered failed-search retry idempotent after abandonment", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Retry a failed terminal observation" });
    const failure = {
      query: "target query",
      failureCode: "QDRANT_UNAVAILABLE",
      failureReason: "provider unavailable",
    };
    const recorded = await service.recordFailedSearch(started.sessionId, failure, { step: 1 });
    const abandoned = await service.abandon(started.sessionId, {
      reasonCode: "retrieval-unavailable",
    });

    await expect(
      service.recordFailedSearch(started.sessionId, failure, { step: 1 }),
    ).resolves.toMatchObject({
      session: { status: "abandoned", revision: abandoned.revision },
      attempt: { attemptId: recorded.attempt.attemptId },
    });
    await expect(
      service.recordFailedSearch(
        started.sessionId,
        { ...failure, failureCode: "OLLAMA_UNAVAILABLE" },
        { step: 1 },
      ),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_CONFLICT" });
  });

  it("rejects a client-step retry when retrieval health changes", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Retry health must remain stable" });
    const degraded = searchResult("same query", [searchHit("target", "src/target.ts", 1, 0.9)]);
    degraded.skipped.push({
      schemaVersion: 1,
      stage: "search",
      subjectKind: "search_candidate",
      reason: "provider_unavailable",
      detail: "a configured embedding profile was unavailable",
      recoverable: true,
    });

    const recorded = await service.recordSearch(started.sessionId, degraded, { step: 1 });
    await expect(
      service.recordSearch(started.sessionId, degraded, { step: 1 }),
    ).resolves.toMatchObject({ attempt: { attemptId: recorded.attempt.attemptId } });
    await expect(
      service.recordSearch(
        started.sessionId,
        searchResult("same query", [searchHit("target", "src/target.ts", 1, 0.9)]),
        { step: 1 },
      ),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_CONFLICT" });
  });

  it("binds idempotent search steps to code complexity and incomplete-payload evidence", async () => {
    const { service } = harness();
    const complexityJourney = await service.start({
      goal: "Observe exact target metrics",
      featureId: "target.metrics",
    });
    const withComplexity = searchResult("same query", [
      searchHit("target", "src/target.ts", 1, 0.9, {
        complexity: codeComplexity("symbol:target", 8),
      }),
    ]);
    await service.recordSearch(complexityJourney.sessionId, withComplexity, { step: 1 });
    const changedComplexity = structuredClone(withComplexity);
    const changedSummary = changedComplexity.groups[0]?.hits[0]?.complexity;
    if (changedSummary === undefined) throw new Error("expected complexity fixture");
    changedSummary.cognitive = 9;
    await expect(
      service.recordSearch(complexityJourney.sessionId, changedComplexity, { step: 1 }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_CONFLICT" });

    const payloadJourney = await service.start({
      goal: "Observe payload provenance",
      featureId: "target.payload",
    });
    const incomplete = searchResult("same query", [
      searchHit("target", "src/target.ts", 1, 0.9, {
        complexity: codeComplexity("symbol:target", 8),
        incompletePayloadFields: ["repo_label"],
      }),
    ]);
    incomplete.warnings.push({ code: "INCOMPLETE_PAYLOAD", message: "substituted field" });
    await service.recordSearch(payloadJourney.sessionId, incomplete, { step: 1 });
    const changedPayload = structuredClone(incomplete);
    const changedHit = changedPayload.groups[0]?.hits[0];
    if (changedHit === undefined) throw new Error("expected hit fixture");
    changedHit.incompletePayloadFields = ["ref_name"];
    await expect(
      service.recordSearch(payloadJourney.sessionId, changedPayload, { step: 1 }),
    ).rejects.toMatchObject({ code: "SEARCH_SESSION_CONFLICT" });
  });

  it("validates the result workspace before accepting an idempotent retry", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Workspace isolation" });
    const result = searchResult("same query", [searchHit("target", "src/target.ts", 1, 0.9)]);
    await service.recordSearch(started.sessionId, result, { step: 1 });
    const wrongWorkspace = structuredClone(result);
    wrongWorkspace.query.workspaceId = "another-workspace";

    await expect(
      service.recordSearch(started.sessionId, wrongWorkspace, { step: 1 }),
    ).rejects.toThrow('search result belongs to workspace "another-workspace"');
  });

  it("does not let a failed concurrent mutation poison the next queued mutation", async () => {
    const { service } = harness();
    const started = await service.start({ goal: "Concurrent retry isolation" });
    const invalid = searchResult("wrong workspace", []);
    invalid.query.workspaceId = "another-workspace";

    const rejected = service.recordSearch(started.sessionId, invalid);
    const accepted = service.recordSearch(
      started.sessionId,
      searchResult("valid retry", [searchHit("target", "src/target.ts", 1, 0.9)]),
    );

    await expect(rejected).rejects.toThrow("another-workspace");
    await expect(accepted).resolves.toMatchObject({ attempt: { sequence: 1 } });
    await expect(service.get(started.sessionId)).resolves.toMatchObject({
      revision: 1,
      attempts: [{ sequence: 1 }],
    });
  });

  it("honors an already-aborted start without persisting a session", async () => {
    const { service, store } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.start({ goal: "must not be recorded" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(store.list(WORKSPACE_ID)).resolves.toEqual([]);
  });
});
