import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./identity.js";
import { searchJourneyValidationIssue } from "./search-journey-validation.js";
import {
  MAX_SEARCH_JOURNEY_ATTEMPTS,
  MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH,
  MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS,
  MAX_SEARCH_JOURNEY_TEXT_LENGTH,
  MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH,
  type DynamicSearchComplexityV1,
  type SearchJourneyV1,
} from "./types/search-journey.js";
import {
  INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  type SearchRetrievalDiagnosticsV1,
} from "./types/search.js";
import { DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID } from "./versions.js";

const GOAL_FINGERPRINT = "a".repeat(64);
const FEATURE_FINGERPRINT = "f".repeat(64);
const OBSERVATION_FINGERPRINT = "b".repeat(64);
const QUERY_FINGERPRINT = "c".repeat(64);
const RANKING_CONTEXT_FINGERPRINT = "d".repeat(64);
const MEASUREMENT_CONTEXT_ID = sha256Hex(
  canonicalJson({
    rankers: ["ranker-v1"],
    profiles: ["profile-v1\u001fgeneration-v1"],
    rankingContexts: [RANKING_CONTEXT_FINGERPRINT],
    limits: ["10\u001f20"],
  }),
);

function assessment(): DynamicSearchComplexityV1 {
  return {
    schemaVersion: 1,
    algorithm: DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID,
    isHeuristic: true,
    searchesToTarget: 1,
    successfulSearchesToTarget: 1,
    failedSearchesToTarget: 0,
    distinctQueryCount: 1,
    queryReformulations: 0,
    acceptedTargetRank: 1,
    reciprocalRank: 1,
    targetWasReturned: true,
    targetFirstReturnedAtSearch: 1,
    targetAcceptedAtSearch: 1,
    selectionLagSearches: 0,
    directHit: true,
    eligibleCandidatesExamined: 1,
    uniqueCandidatesExposed: 1,
    uniqueFilesExposed: 1,
    navigationEventsToTarget: 0,
    observedToolAndFileHops: 1,
    meanCandidateFileDispersion: 0,
    meanCandidateChurn: null,
    candidateLimitHitRate: 0,
    healthyRetrievalRate: 1,
    acceptedTargetScoreMargin: null,
    measurementContextId: MEASUREMENT_CONTEXT_ID,
    measurementContextComplete: true,
    caveats: [],
  };
}

function completedJourney(): SearchJourneyV1 {
  return {
    schemaVersion: 1,
    revision: 2,
    sessionId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "workspace-a",
    status: "completed",
    recordingConsent: "explicit",
    retainText: false,
    goal: { fingerprint: GOAL_FINGERPRINT },
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:02.000Z",
    attempts: [
      {
        attemptId: "22222222-2222-4222-8222-222222222222",
        sequence: 1,
        observationFingerprint: OBSERVATION_FINGERPRINT,
        queryFingerprint: QUERY_FINGERPRINT,
        rankerVersion: "ranker-v1",
        rankingContextFingerprint: RANKING_CONTEXT_FINGERPRINT,
        resultLimit: 10,
        candidateLimit: 20,
        observedAt: "2026-09-06T10:00:01.000Z",
        status: "succeeded",
        warningCodes: [],
        retrievalHealthy: true,
        profiles: [
          {
            embeddingProfileId: "profile-v1",
            indexGenerations: ["generation-v1"],
            retrievalPerformed: true,
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
            candidates: [
              {
                repoId: "repo-a",
                refId: "ref-main",
                filePath: "src/target.ts",
                chunkId: "target",
                symbolId: "symbol:target",
                embeddingProfileId: "profile-v1",
                indexGeneration: "generation-v1",
                rank: 1,
                score: 0.9,
              },
            ],
          },
        ],
      },
    ],
    navigation: [],
    outcome: {
      kind: "completed",
      completedAt: "2026-09-06T10:00:02.000Z",
      target: { chunkId: "target" },
      assessment: assessment(),
    },
  };
}

function completedFeatureJourney(): SearchJourneyV1 {
  const journey = completedJourney();
  journey.feature = { fingerprint: FEATURE_FINGERPRINT };
  const candidate = journey.attempts[0]?.profiles[0]?.candidates[0];
  if (candidate === undefined || journey.outcome?.kind !== "completed") {
    throw new Error("expected completed candidate fixture");
  }
  candidate.complexity = {
    metricsScope: "symbol",
    metricsScopeId: "symbol:target",
    metricsVersion: "untangle-metrics-v1",
    cognitive: 8,
    cyclomaticExtended: 4,
    sloc: 12,
  };
  candidate.incompletePayloadFields = [];
  journey.outcome.assessment.acceptedTargetCodeComplexity = {
    status: "observed",
    source: "indexed-search-hit",
    candidate: {
      repoId: "repo-a",
      refId: "ref-main",
      filePath: "src/target.ts",
      chunkId: "target",
      symbolId: "symbol:target",
      embeddingProfileId: "profile-v1",
      indexGeneration: "generation-v1",
    },
    complexity: structuredClone(candidate.complexity),
    payloadComplete: true,
    incompletePayloadFields: [],
  };
  return journey;
}

function diagnostics(journey: SearchJourneyV1): SearchRetrievalDiagnosticsV1 {
  const value = journey.attempts[0]?.profiles[0]?.retrieval;
  if (value === undefined) throw new Error("expected retrieval diagnostics");
  return value;
}

function addDuplicateTargetCandidate(journey: SearchJourneyV1, cognitive: number): void {
  const profile = journey.attempts[0]?.profiles[0];
  const first = profile?.candidates[0];
  if (
    profile === undefined ||
    first === undefined ||
    first.complexity === undefined ||
    journey.outcome?.kind !== "completed" ||
    profile.retrieval === undefined
  ) {
    throw new Error("expected completed feature fixture");
  }
  profile.candidates.push({
    ...structuredClone(first),
    rank: 2,
    score: 0.8,
    complexity: { ...first.complexity, cognitive },
  });
  Object.assign(profile.retrieval, {
    branchCandidateCounts: { dense: 2, sparse: 2, symbol: 0 },
    uniqueRetrievedCandidateCount: 2,
    eligibleCandidateCount: 2,
    rankedCandidateCount: 2,
    deduplicatedCandidateCount: 2,
    qualifiedHitCount: 2,
    returnedHitCount: 2,
    uniqueEligibleFileCount: 1,
    uniqueEligibleSymbolCount: 1,
    eligibleFileDispersion: 0,
    topScoreGap: 0.1,
  });
  journey.outcome.assessment.eligibleCandidatesExamined = 2;
}

describe("search journey runtime validation", () => {
  it("accepts a complete internally consistent journey", () => {
    expect(searchJourneyValidationIssue(completedJourney())).toBeNull();
    expect(searchJourneyValidationIssue(completedFeatureJourney())).toBeNull();
  });

  it("accepts journey text and locators exactly at their persistence limits", () => {
    const journey = completedJourney();
    const attempt = journey.attempts[0];
    if (attempt === undefined || journey.outcome?.kind !== "completed") {
      throw new Error("expected completed attempt fixture");
    }
    journey.retainText = true;
    journey.goal.text = "g".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH);
    attempt.queryText = "q".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH);
    const chunkId = "c".repeat(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH);
    const candidate = attempt.profiles[0]?.candidates[0];
    if (candidate === undefined) throw new Error("expected candidate fixture");
    candidate.chunkId = chunkId;
    journey.outcome.target = { chunkId };

    expect(searchJourneyValidationIssue(journey)).toBeNull();
  });

  it("rejects oversized retained text, locators and tool names", () => {
    const goal = completedJourney();
    goal.retainText = true;
    goal.goal.text = "g".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH + 1);

    const locator = completedJourney();
    if (locator.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    locator.outcome.target = { chunkId: "c".repeat(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH + 1) };

    const tool = completedJourney();
    tool.navigation.push({
      eventId: "navigation-1",
      sequence: 1,
      kind: "other-tool",
      observedAt: "2026-09-06T10:00:01.500Z",
      toolName: "t".repeat(MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH + 1),
    });

    expect(searchJourneyValidationIssue(goal)).toBe("invalid goal");
    expect(searchJourneyValidationIssue(locator)).toBe("invalid completed outcome");
    expect(searchJourneyValidationIssue(tool)).toBe("shape mismatch");
  });

  it("accepts additive accepted-attempt provenance and rejects dangling identities", () => {
    const explicit = completedJourney();
    if (explicit.outcome?.kind !== "completed" || explicit.attempts[0] === undefined) {
      throw new Error("expected completed attempt fixture");
    }
    explicit.outcome.acceptedAttemptId = explicit.attempts[0].attemptId;

    const dangling = structuredClone(explicit);
    if (dangling.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    dangling.outcome.acceptedAttemptId = "33333333-3333-4333-8333-333333333333";

    const blank = structuredClone(explicit);
    if (blank.outcome?.kind !== "completed") throw new Error("expected completed outcome");
    blank.outcome.acceptedAttemptId = " ";

    expect(searchJourneyValidationIssue(explicit)).toBeNull();
    expect(searchJourneyValidationIssue(dangling)).toBe("invalid completed outcome");
    expect(searchJourneyValidationIssue(blank)).toBe("invalid completed outcome");
    expect(searchJourneyValidationIssue(completedJourney())).toBeNull();
  });

  it("validates pseudonymous feature identity and recomputes target-code complexity evidence", () => {
    const rawFeature = completedFeatureJourney();
    if (rawFeature.feature === undefined) throw new Error("expected feature fixture");
    rawFeature.feature.fingerprint = "profile.cards";

    const leakedFeature = completedFeatureJourney();
    if (leakedFeature.feature === undefined) throw new Error("expected feature fixture");
    leakedFeature.feature.text = "profile.cards";

    const oversizedFeature = completedFeatureJourney();
    oversizedFeature.retainText = true;
    if (oversizedFeature.feature === undefined) throw new Error("expected feature fixture");
    oversizedFeature.feature.text = "x".repeat(MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH + 1);

    const inventedComplexity = completedFeatureJourney();
    if (inventedComplexity.outcome?.kind !== "completed") throw new Error("expected outcome");
    const evidence = inventedComplexity.outcome.assessment.acceptedTargetCodeComplexity;
    if (evidence?.status !== "observed") throw new Error("expected observed complexity");
    evidence.complexity.cognitive = 99;

    const falsePayloadCompleteness = completedFeatureJourney();
    if (falsePayloadCompleteness.outcome?.kind !== "completed") {
      throw new Error("expected outcome");
    }
    const falseEvidence = falsePayloadCompleteness.outcome.assessment.acceptedTargetCodeComplexity;
    if (falseEvidence?.status !== "observed") throw new Error("expected observed complexity");
    falseEvidence.payloadComplete = false;

    expect(searchJourneyValidationIssue(rawFeature)).not.toBeNull();
    expect(searchJourneyValidationIssue(leakedFeature)).toBe("text retention violates consent");
    expect(searchJourneyValidationIssue(oversizedFeature)).toBe("invalid feature");
    expect(searchJourneyValidationIssue(inventedComplexity)).not.toBeNull();
    expect(searchJourneyValidationIssue(falsePayloadCompleteness)).not.toBeNull();
  });

  it("requires mathematically valid target-code complexity summaries", () => {
    const invalidMetrics: ReadonlyArray<Readonly<Record<string, number>>> = [
      { cyclomaticClassic: -1 },
      { cyclomaticExtended: -1 },
      { cognitive: -1 },
      { maxNesting: -1 },
      { sloc: -1 },
      { halsteadVolume: -0.1 },
      { maintainabilityIndex: -0.1 },
      { maintainabilityIndex: 100.1 },
      { riskScore: -0.1 },
      { cognitive: 0.5 },
    ];
    for (const invalidMetric of invalidMetrics) {
      const journey = completedFeatureJourney();
      const candidate = journey.attempts[0]?.profiles[0]?.candidates[0];
      const evidence =
        journey.outcome?.kind === "completed"
          ? journey.outcome.assessment.acceptedTargetCodeComplexity
          : undefined;
      if (candidate?.complexity === undefined || evidence?.status !== "observed") {
        throw new Error("expected observed complexity fixture");
      }
      Object.assign(candidate.complexity, invalidMetric);
      Object.assign(evidence.complexity, invalidMetric);
      expect(searchJourneyValidationIssue(journey)).not.toBeNull();
    }

    const boundaries = completedFeatureJourney();
    const candidate = boundaries.attempts[0]?.profiles[0]?.candidates[0];
    const evidence =
      boundaries.outcome?.kind === "completed"
        ? boundaries.outcome.assessment.acceptedTargetCodeComplexity
        : undefined;
    if (candidate === undefined || evidence?.status !== "observed") {
      throw new Error("expected observed complexity fixture");
    }
    candidate.complexity = {
      metricsScope: "symbol",
      metricsScopeId: "symbol:target",
      metricsVersion: "untangle-metrics-v1",
      cyclomaticClassic: 0,
      cyclomaticExtended: 0,
      cognitive: 0,
      maxNesting: 0,
      sloc: 0,
      halsteadVolume: 0,
      maintainabilityIndex: 100,
      riskScore: 0,
    };
    evidence.complexity = structuredClone(candidate.complexity);
    expect(searchJourneyValidationIssue(boundaries)).toBeNull();
  });

  it("accepts duplicate candidate identities only when their code evidence is identical", () => {
    const conflicting = completedFeatureJourney();
    addDuplicateTargetCandidate(conflicting, 99);
    expect(searchJourneyValidationIssue(conflicting)).not.toBeNull();
    if (conflicting.outcome?.kind !== "completed") throw new Error("expected outcome");
    conflicting.outcome.assessment.acceptedTargetCodeComplexity = {
      status: "unavailable",
      reason: "target-context-ambiguous",
    };
    expect(searchJourneyValidationIssue(conflicting)).toBeNull();

    const identical = completedFeatureJourney();
    addDuplicateTargetCandidate(identical, 8);
    expect(searchJourneyValidationIssue(identical)).toBeNull();
  });

  it("rejects unknown keys at every persisted trust boundary, including the assessment", () => {
    const root = completedJourney();
    Object.assign(root, { unexpected: true });

    const assessmentUnknown = completedJourney();
    if (assessmentUnknown.outcome?.kind !== "completed") throw new Error("expected outcome");
    Object.assign(assessmentUnknown.outcome.assessment, { unexpected: true });

    const candidateUnknown = completedJourney();
    Object.assign(candidateUnknown.attempts[0]?.profiles[0]?.candidates[0] ?? {}, {
      rawContent: "must never be persisted",
    });

    expect(searchJourneyValidationIssue(root)).not.toBeNull();
    expect(searchJourneyValidationIssue(assessmentUnknown)).not.toBeNull();
    expect(searchJourneyValidationIssue(candidateUnknown)).not.toBeNull();
  });

  it("rejects impossible assessment relationships and out-of-range ratios", () => {
    const inconsistentCounts = completedJourney();
    const invalidReciprocalRank = completedJourney();
    const invalidChurn = completedJourney();
    const inconsistentDirectHit = completedJourney();
    for (const journey of [
      inconsistentCounts,
      invalidReciprocalRank,
      invalidChurn,
      inconsistentDirectHit,
    ]) {
      if (journey.outcome?.kind !== "completed") throw new Error("expected outcome");
    }
    if (inconsistentCounts.outcome?.kind === "completed") {
      inconsistentCounts.outcome.assessment.searchesToTarget = 2;
    }
    if (invalidReciprocalRank.outcome?.kind === "completed") {
      invalidReciprocalRank.outcome.assessment.reciprocalRank = 0.5;
    }
    if (invalidChurn.outcome?.kind === "completed") {
      invalidChurn.outcome.assessment.meanCandidateChurn = 1.1;
    }
    if (inconsistentDirectHit.outcome?.kind === "completed") {
      inconsistentDirectHit.outcome.assessment.directHit = false;
    }

    expect(searchJourneyValidationIssue(inconsistentCounts)).not.toBeNull();
    expect(searchJourneyValidationIssue(invalidReciprocalRank)).not.toBeNull();
    expect(searchJourneyValidationIssue(invalidChurn)).not.toBeNull();
    expect(searchJourneyValidationIssue(inconsistentDirectHit)).not.toBeNull();
  });

  it("rejects impossible retrieval funnels before they can reach aggregation", () => {
    const mutations: Array<(value: SearchRetrievalDiagnosticsV1) => void> = [
      (value) => {
        value.uniqueRetrievedCandidateCount = 3;
      },
      (value) => {
        value.eligibleCandidateCount = 2;
      },
      (value) => {
        value.rankedCandidateCount = 2;
      },
      (value) => {
        value.deduplicatedCandidateCount = 2;
      },
      (value) => {
        value.qualifiedHitCount = 2;
      },
      (value) => {
        value.returnedHitCount = 2;
      },
      (value) => {
        value.uniqueEligibleFileCount = 2;
      },
      (value) => {
        value.uniqueEligibleSymbolCount = 2;
      },
      (value) => {
        value.eligibleFileDispersion = 0.5;
      },
    ];

    for (const mutate of mutations) {
      const journey = completedJourney();
      mutate(diagnostics(journey));
      expect(searchJourneyValidationIssue(journey)).not.toBeNull();
    }
  });

  it("rejects duplicate embedding-profile observations within one attempt", () => {
    const journey = completedJourney();
    const firstProfile = journey.attempts[0]?.profiles[0];
    if (firstProfile === undefined) throw new Error("expected profile fixture");
    journey.attempts[0]?.profiles.push(structuredClone(firstProfile));

    expect(searchJourneyValidationIssue(journey)).not.toBeNull();
  });

  it("rejects incomplete index evidence that is marked retrieval-healthy", () => {
    for (const warningCode of [INDEX_CONTEXT_INCOMPLETE_WARNING_CODE, "INCOMPLETE_PAYLOAD"]) {
      const journey = completedJourney();
      const firstAttempt = journey.attempts[0];
      if (firstAttempt === undefined) throw new Error("expected attempt fixture");
      firstAttempt.warningCodes.push(warningCode);

      expect(searchJourneyValidationIssue(journey)).not.toBeNull();
    }
  });

  it("binds persisted retrieval observations to their effective result and candidate limits", () => {
    const tooManyReturned = completedJourney();
    const firstAttempt = tooManyReturned.attempts[0];
    const firstProfile = firstAttempt?.profiles[0];
    if (
      firstAttempt === undefined ||
      firstProfile === undefined ||
      firstProfile.retrieval === undefined ||
      tooManyReturned.outcome?.kind !== "completed"
    ) {
      throw new Error("expected a completed journey fixture");
    }
    firstAttempt.resultLimit = 1;
    firstProfile.candidates.push({
      ...(firstProfile.candidates[0] as (typeof firstProfile.candidates)[number]),
      filePath: "src/second.ts",
      chunkId: "second",
      symbolId: "symbol:second",
      rank: 2,
      score: 0.8,
    });
    Object.assign(firstProfile.retrieval, {
      branchCandidateCounts: { dense: 2, sparse: 2, symbol: 0 },
      uniqueRetrievedCandidateCount: 2,
      eligibleCandidateCount: 2,
      rankedCandidateCount: 2,
      deduplicatedCandidateCount: 2,
      qualifiedHitCount: 2,
      returnedHitCount: 2,
      uniqueEligibleFileCount: 2,
      uniqueEligibleSymbolCount: 2,
      eligibleFileDispersion: 1,
      topScoreGap: 0.1,
    });
    Object.assign(tooManyReturned.outcome.assessment, {
      eligibleCandidatesExamined: 2,
      uniqueCandidatesExposed: 2,
      uniqueFilesExposed: 2,
      meanCandidateFileDispersion: 1,
      acceptedTargetScoreMargin: 0.1,
      measurementContextId: sha256Hex(
        canonicalJson({
          rankers: ["ranker-v1"],
          profiles: ["profile-v1\u001fgeneration-v1"],
          rankingContexts: [RANKING_CONTEXT_FINGERPRINT],
          limits: ["1\u001f20"],
        }),
      ),
    });

    const branchOverflow = completedJourney();
    diagnostics(branchOverflow).branchCandidateCounts.dense = 21;
    const hiddenLimitHit = completedJourney();
    diagnostics(hiddenLimitHit).branchCandidateCounts.dense = 20;

    expect(searchJourneyValidationIssue(tooManyReturned)).not.toBeNull();
    expect(searchJourneyValidationIssue(branchOverflow)).not.toBeNull();
    expect(searchJourneyValidationIssue(hiddenLimitHit)).not.toBeNull();
  });

  it("requires pseudonymous fields and context identifiers to be lowercase SHA-256 hex", () => {
    const rawGoal = completedJourney();
    rawGoal.goal.fingerprint = "private profile-card goal";
    const rawQuery = completedJourney();
    if (rawQuery.attempts[0] === undefined) throw new Error("expected attempt");
    rawQuery.attempts[0].queryFingerprint = "private profile-card query";
    const rawObservation = completedJourney();
    if (rawObservation.attempts[0] === undefined) throw new Error("expected attempt");
    rawObservation.attempts[0].observationFingerprint = "raw result metadata";
    const invalidContext = completedJourney();
    if (invalidContext.outcome?.kind !== "completed") throw new Error("expected outcome");
    invalidContext.outcome.assessment.measurementContextId = "not-a-context-fingerprint";

    expect(searchJourneyValidationIssue(rawGoal)).not.toBeNull();
    expect(searchJourneyValidationIssue(rawQuery)).not.toBeNull();
    expect(searchJourneyValidationIssue(rawObservation)).not.toBeNull();
    expect(searchJourneyValidationIssue(invalidContext)).not.toBeNull();
  });

  it("cross-checks persisted assessments against the observed attempt prefix", () => {
    const falseHealthyContext = completedJourney();
    const synchronizedButFalseCounts = completedJourney();
    const wrongContext = completedJourney();
    for (const journey of [falseHealthyContext, synchronizedButFalseCounts, wrongContext]) {
      if (journey.outcome?.kind !== "completed") throw new Error("expected outcome");
    }
    if (falseHealthyContext.outcome?.kind === "completed") {
      falseHealthyContext.outcome.assessment.healthyRetrievalRate = 0.5;
    }
    if (synchronizedButFalseCounts.outcome?.kind === "completed") {
      synchronizedButFalseCounts.outcome.assessment.successfulSearchesToTarget = 0;
      synchronizedButFalseCounts.outcome.assessment.failedSearchesToTarget = 1;
    }
    if (wrongContext.outcome?.kind === "completed") {
      wrongContext.outcome.assessment.measurementContextId = "e".repeat(64);
    }

    expect(searchJourneyValidationIssue(falseHealthyContext)).not.toBeNull();
    expect(searchJourneyValidationIssue(synchronizedButFalseCounts)).not.toBeNull();
    expect(searchJourneyValidationIssue(wrongContext)).not.toBeNull();
  });

  it("cross-checks target and derived retrieval metrics against persisted candidates", () => {
    const missingTarget = completedJourney();
    const inventedRank = completedJourney();
    const inventedDispersion = completedJourney();
    const inventedChurn = completedJourney();
    if (missingTarget.outcome?.kind !== "completed") throw new Error("expected outcome");
    missingTarget.outcome.target = { filePath: "src/external.ts" };
    if (inventedRank.outcome?.kind !== "completed") throw new Error("expected outcome");
    inventedRank.outcome.assessment.acceptedTargetRank = 2;
    inventedRank.outcome.assessment.reciprocalRank = 0.5;
    inventedRank.outcome.assessment.directHit = false;
    if (inventedDispersion.outcome?.kind !== "completed") throw new Error("expected outcome");
    inventedDispersion.outcome.assessment.meanCandidateFileDispersion = 0.5;
    if (inventedChurn.outcome?.kind !== "completed") throw new Error("expected outcome");
    inventedChurn.outcome.assessment.meanCandidateChurn = 0.5;

    expect(searchJourneyValidationIssue(missingTarget)).not.toBeNull();
    expect(searchJourneyValidationIssue(inventedRank)).not.toBeNull();
    expect(searchJourneyValidationIssue(inventedDispersion)).not.toBeNull();
    expect(searchJourneyValidationIssue(inventedChurn)).not.toBeNull();
  });

  it("rejects resource-limit overflow and a completed numbered journey with gaps", () => {
    const tooManyAttempts = completedJourney();
    tooManyAttempts.status = "active";
    delete tooManyAttempts.outcome;
    tooManyAttempts.attempts = Array.from(
      { length: MAX_SEARCH_JOURNEY_ATTEMPTS + 1 },
      (_, index) => ({
        ...(completedJourney().attempts[0] as SearchJourneyV1["attempts"][number]),
        attemptId: `attempt-${String(index + 1)}`,
        sequence: index + 1,
      }),
    );
    const tooManyNavigationEvents = completedJourney();
    tooManyNavigationEvents.status = "active";
    delete tooManyNavigationEvents.outcome;
    tooManyNavigationEvents.attempts = [];
    tooManyNavigationEvents.navigation = Array.from(
      { length: MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS + 1 },
      (_, index) => ({
        eventId: `event-${String(index + 1)}`,
        sequence: index + 1,
        kind: "other-tool" as const,
        observedAt: "2026-09-06T10:00:01.000Z",
      }),
    );
    const missingStep = completedJourney();
    if (missingStep.attempts[0] === undefined) throw new Error("expected attempt");
    missingStep.attempts[0].clientStep = 2;
    const reversedSteps = completedJourney();
    const firstAttempt = reversedSteps.attempts[0];
    if (firstAttempt === undefined || reversedSteps.outcome?.kind !== "completed") {
      throw new Error("expected completed attempt fixture");
    }
    firstAttempt.clientStep = 2;
    reversedSteps.attempts.push({
      ...structuredClone(firstAttempt),
      attemptId: "33333333-3333-4333-8333-333333333333",
      sequence: 2,
      clientStep: 1,
    });
    Object.assign(reversedSteps.outcome.assessment, {
      searchesToTarget: 2,
      successfulSearchesToTarget: 2,
      targetAcceptedAtSearch: 2,
      selectionLagSearches: 1,
      directHit: false,
      eligibleCandidatesExamined: 2,
      observedToolAndFileHops: 2,
      meanCandidateChurn: 0,
    });

    expect(searchJourneyValidationIssue(tooManyAttempts)).not.toBeNull();
    expect(searchJourneyValidationIssue(tooManyNavigationEvents)).not.toBeNull();
    expect(searchJourneyValidationIssue(missingStep)).toBe(
      "completed journey has missing client steps",
    );
    expect(searchJourneyValidationIssue(reversedSteps)).toBe("invalid client-step ordering");
  });
});
