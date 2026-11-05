/**
 * Task-basierte Search Journeys und Dynamic Product Complexity.
 *
 * Dieser Reducer ist I/O-agnostisch. Er speichert ausschliesslich ueber den
 * Domain-Port, liest Zeit/Zufall ueber Ports und berechnet jede Kennzahl aus
 * den persistierten Beobachtungen neu. Damit kann derselbe Ablauf lokal, im
 * MCP-Server und in Tests identisch laufen.
 */
import {
  DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID,
  INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  MAX_SEARCH_JOURNEY_ATTEMPTS as DOMAIN_MAX_SEARCH_JOURNEY_ATTEMPTS,
  MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH,
  MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH as DOMAIN_MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH,
  MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS as DOMAIN_MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS,
  MAX_SEARCH_JOURNEY_REASON_LENGTH,
  MAX_SEARCH_JOURNEY_TEXT_LENGTH,
  MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH,
  MINIMUM_PRODUCT_COMPLEXITY_SESSIONS as DOMAIN_MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
  RANKER_VERSION,
  SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS,
  SEARCH_JOURNEY_STATUSES,
  canonicalJson,
  compareCodepoints,
  hmacSha256Hex,
  isUntangleError,
  searchJourneyValidationIssue,
  sha256Hex,
  UntangleError,
  type Clock,
  type ComplexitySummaryV1,
  type DynamicProductComplexityCohortV1,
  type DynamicProductComplexityFeatureMappingV1,
  type DynamicProductComplexityReportV1,
  type DynamicSearchComplexityV1,
  type DynamicSearchOutcomeCohortV1,
  type PortCallOptions,
  type Random,
  type SearchAbstention,
  type SearchJourneyAttemptV1,
  type SearchJourneyAbandonReasonCode,
  type SearchJourneyCandidateV1,
  type SearchJourneyExecutionContextEvidenceV1,
  type SearchJourneyExecutionContextInputV1,
  type SearchJourneyExecutionContextV1,
  type SearchJourneyNavigationEventV1,
  type SearchJourneyNavigationKind,
  type SearchJourneyStorePort,
  type SearchJourneyTargetCodeComplexityEvidenceV1,
  type SearchJourneyTargetV1,
  type SearchJourneyV1,
  type SearchRetrievalDiagnosticsV1,
  type SearchResultSetV1,
} from "@untangle-code/domain";

export const MINIMUM_PRODUCT_COMPLEXITY_SESSIONS = DOMAIN_MINIMUM_PRODUCT_COMPLEXITY_SESSIONS;
export const MAX_SEARCH_JOURNEY_ATTEMPTS = DOMAIN_MAX_SEARCH_JOURNEY_ATTEMPTS;
export const MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH = DOMAIN_MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH;
export const MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS = DOMAIN_MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS;

interface SearchJourneyServiceBaseDeps {
  workspaceId: string;
  store: SearchJourneyStorePort;
  clock: Clock;
  random: Random;
}

/** Ein stabiler Key oder ein persistenter Provider ist fuer korrekte Wiederaufnahme zwingend. */
export type SearchJourneyServiceDeps = SearchJourneyServiceBaseDeps &
  (
    | { fingerprintKey: Uint8Array; fingerprintKeyProvider?: never }
    | {
        fingerprintKey?: never;
        /** Lazy Variante, damit reine Leseoperationen keinen lokalen Schluessel anlegen. */
        fingerprintKeyProvider: (options?: PortCallOptions) => Promise<Uint8Array>;
      }
  );

export interface StartSearchJourneyInput {
  goal: string;
  /** Stabile, vom Produkt vergebene Kennung fuer feature-uebergreifende Probevergleiche. */
  featureId?: string;
  /** Caller labels are pseudonymized by default; no automatic model or task inference. */
  executionContext?: SearchJourneyExecutionContextInputV1;
  /** Persistiert Ziel- und Querytext; Default false speichert nur Fingerprints. */
  retainText?: boolean;
}

export interface ObserveSearchJourneyNavigationInput {
  kind: SearchJourneyNavigationKind;
  toolName?: string;
  target?: SearchJourneyTargetV1;
}

export interface CompleteSearchJourneyInput {
  target: SearchJourneyTargetV1;
  /** Praezisiert den akzeptierten Versuch, wenn derselbe Treffer mehrfach vorkam. */
  acceptedAttemptId?: string;
}

export interface RecordFailedSearchInput {
  query: string;
  failureCode: string;
  failureReason: string;
}

export interface AbandonSearchJourneyInput {
  /** Kontrollierter Grund, der auch im textfreien Default sicher gespeichert werden kann. */
  reasonCode?: SearchJourneyAbandonReasonCode;
  /** Freitext; wird nur bei einer mit `retainText` gestarteten Journey gespeichert. */
  reason?: string;
}

export interface SearchJourneySearchLink {
  /** 1-basierter, pro Session eindeutiger Schritt. */
  step?: number;
}

export interface RecordedSearchAttempt {
  session: SearchJourneyV1;
  attempt: SearchJourneyAttemptV1;
}

function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must not be empty`);
  return normalized;
}

function assertBoundedNonEmpty(value: string, field: string, maximum: number): string {
  const normalized = assertNonEmpty(value, field);
  if (normalized.length > maximum) {
    throw new Error(`${field} must contain at most ${String(maximum)} UTF-16 code units`);
  }
  return normalized;
}

function assertBoundedText(value: string, field: string, maximum: number): string {
  if (value.length > maximum) {
    throw new Error(`${field} must contain at most ${String(maximum)} UTF-16 code units`);
  }
  return value;
}

function normalizedTarget(target: SearchJourneyTargetV1): SearchJourneyTargetV1 {
  const normalized: SearchJourneyTargetV1 = {
    ...(target.repoId === undefined
      ? {}
      : {
          repoId: assertBoundedNonEmpty(
            target.repoId,
            "search journey target repoId",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        }),
    ...(target.refId === undefined
      ? {}
      : {
          refId: assertBoundedNonEmpty(
            target.refId,
            "search journey target refId",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        }),
    ...(target.filePath === undefined
      ? {}
      : {
          filePath: assertBoundedNonEmpty(
            target.filePath,
            "search journey target filePath",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        }),
    ...(target.chunkId === undefined
      ? {}
      : {
          chunkId: assertBoundedNonEmpty(
            target.chunkId,
            "search journey target chunkId",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        }),
    ...(target.symbolId === undefined
      ? {}
      : {
          symbolId: assertBoundedNonEmpty(
            target.symbolId,
            "search journey target symbolId",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        }),
    ...(target.embeddingProfileId === undefined
      ? {}
      : {
          embeddingProfileId: assertBoundedNonEmpty(
            target.embeddingProfileId,
            "search journey target embeddingProfileId",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        }),
    ...(target.indexGeneration === undefined
      ? {}
      : {
          indexGeneration: assertBoundedNonEmpty(
            target.indexGeneration,
            "search journey target indexGeneration",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        }),
  };
  const identity = [normalized.chunkId, normalized.symbolId, normalized.filePath].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (!identity) {
    throw new Error("search journey target requires chunkId, symbolId or filePath");
  }
  return normalized;
}

interface SearchObservationHitProjection {
  repoId: string;
  refId: string;
  filePath: string;
  chunkId: string;
  symbolId?: string;
  symbolFqn?: string;
  embeddingProfileId: string;
  indexGeneration: string;
  rank: number;
  score: number;
  complexity: ComplexitySummaryV1 | null;
  incompletePayloadFields: string[];
}

interface SearchObservationProfileProjection {
  embeddingProfileId: string;
  indexGenerations: string[] | null;
  corpusRevisionFingerprint: string | null;
  notSearchedReason?: string;
  retrieval?: SearchRetrievalDiagnosticsV1;
  hits: SearchObservationHitProjection[];
}

interface SearchObservationProjection {
  queryFingerprint: string;
  queryText: string;
  rankerVersion: string;
  rankingContextFingerprint: string | null;
  resultLimit: number;
  candidateLimit: number;
  retrievalHealthy: boolean;
  groups: SearchObservationProfileProjection[];
  warningCodes: string[];
  /**
   * Unter welchem Abstinenzverhalten der Lauf stand. `null` heisst: fuer keine
   * Gruppe wurde eine Relevanzpolicy konsultiert — dann sind beide Verhalten
   * beweisbar identisch. Es wird NIE aus einer leeren Kandidatenliste
   * erschlossen.
   */
  abstention: SearchAbstention | null;
}

function profilesOfProjection(
  projection: SearchObservationProjection,
): SearchJourneyAttemptV1["profiles"] {
  return projection.groups.map((group) => ({
    embeddingProfileId: group.embeddingProfileId,
    indexGenerations:
      group.indexGenerations === null
        ? [...new Set(group.hits.map((hit) => hit.indexGeneration))].sort(compareCodepoints)
        : [...new Set(group.indexGenerations)].sort(compareCodepoints),
    ...(group.corpusRevisionFingerprint === null
      ? {}
      : { corpusRevisionFingerprint: group.corpusRevisionFingerprint }),
    retrievalPerformed: group.notSearchedReason === undefined,
    ...(group.notSearchedReason === undefined
      ? {}
      : { notSearchedReason: group.notSearchedReason }),
    ...(group.retrieval === undefined ? {} : { retrieval: group.retrieval }),
    candidates: group.hits.map((hit) => ({
      repoId: hit.repoId,
      refId: hit.refId,
      filePath: hit.filePath,
      chunkId: hit.chunkId,
      ...(hit.symbolId === undefined ? {} : { symbolId: hit.symbolId }),
      ...(hit.symbolFqn === undefined ? {} : { symbolFqn: hit.symbolFqn }),
      embeddingProfileId: hit.embeddingProfileId,
      indexGeneration: hit.indexGeneration,
      rank: hit.rank,
      score: hit.score,
      ...(hit.complexity === null ? {} : { complexity: hit.complexity }),
      incompletePayloadFields: [...hit.incompletePayloadFields],
    })),
  }));
}

function assertValidObservationProjection(projection: SearchObservationProjection): void {
  const probe: SearchJourneyV1 = {
    schemaVersion: 1,
    revision: 0,
    sessionId: "projection-validation",
    workspaceId: "projection-validation",
    status: "active",
    recordingConsent: "explicit",
    retainText: false,
    goal: { fingerprint: "0".repeat(64) },
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    attempts: [
      {
        attemptId: "projection-attempt",
        sequence: 1,
        measurementContextVersion: 2,
        ...(projection.abstention === null ? {} : { abstention: projection.abstention }),
        observationFingerprint: "0".repeat(64),
        queryFingerprint: "0".repeat(64),
        rankerVersion: projection.rankerVersion,
        ...(projection.rankingContextFingerprint === null
          ? {}
          : { rankingContextFingerprint: projection.rankingContextFingerprint }),
        resultLimit: projection.resultLimit,
        candidateLimit: projection.candidateLimit,
        observedAt: "1970-01-01T00:00:00.000Z",
        status: "succeeded",
        warningCodes: [...projection.warningCodes],
        retrievalHealthy: projection.retrievalHealthy,
        profiles: profilesOfProjection(projection),
      },
    ],
    navigation: [],
  };
  assertValidSessionState(probe);
}

function projectComplexitySummary(complexity: ComplexitySummaryV1): ComplexitySummaryV1 {
  return {
    metricsScope: complexity.metricsScope,
    metricsScopeId: assertBoundedNonEmpty(
      complexity.metricsScopeId,
      "search hit metricsScopeId",
      MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
    ),
    metricsVersion: assertBoundedNonEmpty(
      complexity.metricsVersion,
      "search hit metricsVersion",
      MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
    ),
    ...(complexity.cyclomaticClassic === undefined
      ? {}
      : { cyclomaticClassic: complexity.cyclomaticClassic }),
    ...(complexity.cyclomaticExtended === undefined
      ? {}
      : { cyclomaticExtended: complexity.cyclomaticExtended }),
    ...(complexity.cognitive === undefined ? {} : { cognitive: complexity.cognitive }),
    ...(complexity.maxNesting === undefined ? {} : { maxNesting: complexity.maxNesting }),
    ...(complexity.sloc === undefined ? {} : { sloc: complexity.sloc }),
    ...(complexity.halsteadVolume === undefined
      ? {}
      : { halsteadVolume: complexity.halsteadVolume }),
    ...(complexity.maintainabilityIndex === undefined
      ? {}
      : { maintainabilityIndex: complexity.maintainabilityIndex }),
    ...(complexity.riskScore === undefined ? {} : { riskScore: complexity.riskScore }),
  };
}

function projectRetrievalDiagnostics(
  retrieval: SearchRetrievalDiagnosticsV1,
): SearchRetrievalDiagnosticsV1 {
  return {
    branchCandidateCounts: {
      dense: retrieval.branchCandidateCounts.dense,
      sparse: retrieval.branchCandidateCounts.sparse,
      symbol: retrieval.branchCandidateCounts.symbol,
    },
    uniqueRetrievedCandidateCount: retrieval.uniqueRetrievedCandidateCount,
    eligibleCandidateCount: retrieval.eligibleCandidateCount,
    rankedCandidateCount: retrieval.rankedCandidateCount,
    deduplicatedCandidateCount: retrieval.deduplicatedCandidateCount,
    qualifiedHitCount: retrieval.qualifiedHitCount,
    returnedHitCount: retrieval.returnedHitCount,
    uniqueEligibleFileCount: retrieval.uniqueEligibleFileCount,
    uniqueEligibleSymbolCount: retrieval.uniqueEligibleSymbolCount,
    eligibleFileDispersion: retrieval.eligibleFileDispersion,
    topScoreGap: retrieval.topScoreGap,
    candidateLimitReached: retrieval.candidateLimitReached,
  };
}

function projectSearchObservation(
  result: SearchResultSetV1,
  queryText: string,
): SearchObservationProjection {
  const queryFingerprint = assertBoundedNonEmpty(
    result.queryFingerprint,
    "search result queryFingerprint",
    MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  );
  const rankerVersion = assertBoundedNonEmpty(
    result.query.rankerVersion,
    "search result rankerVersion",
    MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  );
  const rankingContextFingerprint =
    result.rankingContextFingerprint === undefined
      ? null
      : assertBoundedNonEmpty(
          result.rankingContextFingerprint,
          "search result rankingContextFingerprint",
          MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
        );
  const warningCodes = result.warnings
    .map((warning) =>
      assertBoundedNonEmpty(
        warning.code,
        "search result warning code",
        MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
      ),
    )
    .sort(compareCodepoints);
  const groups = result.groups.map((group): SearchObservationProfileProjection => {
    const embeddingProfileId = assertBoundedNonEmpty(
      group.embeddingProfileId,
      "search result embeddingProfileId",
      MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
    );
    const indexGenerations =
      group.indexGenerations === undefined
        ? null
        : group.indexGenerations.map((generation) =>
            assertBoundedNonEmpty(
              generation,
              "search result indexGeneration",
              MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
            ),
          );
    const corpusRevisionFingerprint =
      group.corpusRevisionFingerprint === undefined
        ? null
        : assertBoundedNonEmpty(
            group.corpusRevisionFingerprint,
            "search result corpusRevisionFingerprint",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          );
    const notSearchedReason =
      group.notSearchedReason === undefined
        ? undefined
        : assertBoundedText(
            group.notSearchedReason,
            "search result notSearchedReason",
            MAX_SEARCH_JOURNEY_REASON_LENGTH,
          );
    if (group.hits.length > result.query.limit) {
      throw new Error("search result group contains more hits than its result limit");
    }
    const hits = group.hits.map((hit): SearchObservationHitProjection => {
      const complexity =
        hit.complexity === undefined ? null : projectComplexitySummary(hit.complexity);
      return {
        repoId: assertBoundedNonEmpty(
          hit.repoId,
          "search hit repoId",
          MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
        ),
        refId: assertBoundedNonEmpty(
          hit.refId,
          "search hit refId",
          MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
        ),
        filePath: assertBoundedText(
          hit.filePath,
          "search hit filePath",
          MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
        ),
        chunkId: assertBoundedNonEmpty(
          hit.chunkId,
          "search hit chunkId",
          MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
        ),
        ...(hit.symbolId === undefined
          ? {}
          : {
              symbolId: assertBoundedNonEmpty(
                hit.symbolId,
                "search hit symbolId",
                MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
              ),
            }),
        ...(hit.symbolFqn === undefined
          ? {}
          : {
              symbolFqn: assertBoundedText(
                hit.symbolFqn,
                "search hit symbolFqn",
                MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
              ),
            }),
        embeddingProfileId: assertBoundedNonEmpty(
          hit.embeddingProfileId,
          "search hit embeddingProfileId",
          MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
        ),
        indexGeneration: assertBoundedNonEmpty(
          hit.indexGeneration,
          "search hit indexGeneration",
          MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
        ),
        rank: hit.rank,
        score: hit.score.final,
        complexity,
        incompletePayloadFields: (hit.incompletePayloadFields ?? []).map((field) =>
          assertBoundedNonEmpty(
            field,
            "search hit incomplete payload field",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          ),
        ),
      };
    });
    return {
      embeddingProfileId,
      indexGenerations,
      corpusRevisionFingerprint,
      ...(notSearchedReason === undefined ? {} : { notSearchedReason }),
      ...(group.retrieval === undefined
        ? {}
        : { retrieval: projectRetrievalDiagnostics(group.retrieval) }),
      hits,
    };
  });
  const projection: SearchObservationProjection = {
    queryFingerprint,
    queryText,
    rankerVersion,
    rankingContextFingerprint,
    resultLimit: result.query.limit,
    candidateLimit: result.query.candidateLimit,
    retrievalHealthy: retrievalHealthyOfResult(result),
    groups,
    warningCodes,
    abstention:
      result.groups.find((group) => group.relevanceDecision !== undefined)?.relevanceDecision
        ?.abstention ?? null,
  };
  assertValidObservationProjection(projection);
  return projection;
}

function assertValidSessionState(session: SearchJourneyV1): void {
  const issue = searchJourneyValidationIssue(session);
  if (issue !== null) {
    throw new UntangleError(
      "SEARCH_SESSION_INVALID_STATE",
      `search journey service produced an invalid state: ${issue}`,
      {
        operation: "search_journey_service",
        context: { sessionId: session.sessionId, validationIssue: issue },
      },
    );
  }
}

function targetMatches(
  candidate: SearchJourneyCandidateV1,
  target: SearchJourneyTargetV1,
): boolean {
  const fields: readonly (keyof SearchJourneyTargetV1)[] = [
    "repoId",
    "refId",
    "filePath",
    "chunkId",
    "symbolId",
    "embeddingProfileId",
    "indexGeneration",
  ];
  return fields.every((field) => target[field] === undefined || candidate[field] === target[field]);
}

function candidateKey(candidate: SearchJourneyCandidateV1): string {
  return canonicalJson([
    candidate.embeddingProfileId,
    candidate.indexGeneration,
    candidate.repoId,
    candidate.refId,
    candidate.chunkId,
  ]);
}

function candidateCodeEvidence(candidate: SearchJourneyCandidateV1): string {
  return canonicalJson({
    complexity: candidate.complexity ?? null,
    incompletePayloadFields: candidate.incompletePayloadFields ?? null,
  });
}

function cloneSession(session: SearchJourneyV1): SearchJourneyV1 {
  return structuredClone(session);
}

function journeyFingerprint(
  fingerprintKey: Uint8Array,
  workspaceId: string,
  purpose:
    | "feature"
    | "goal"
    | "query"
    | "successful-observation"
    | "failed-observation"
    | "execution-context",
  value: unknown,
): string {
  return hmacSha256Hex(
    fingerprintKey,
    canonicalJson({
      schemaVersion: 1,
      namespace: "untangle-search-journey",
      workspaceId,
      purpose,
      value,
    }),
  );
}

function normalizeExecutionContext(
  value: SearchJourneyExecutionContextInputV1 | undefined,
): SearchJourneyExecutionContextInputV1 | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("executionContext must be an object of explicit caller labels");
  }
  if (
    Object.keys(value).some(
      (key) => !SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.some((dimension) => dimension === key),
    )
  ) {
    throw new Error("executionContext contains an unknown dimension");
  }
  const normalized: Record<string, string> = {};
  for (const dimension of SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS) {
    const label = value[dimension];
    if (label === undefined && (dimension === "taskMix" || dimension === "priorContext")) continue;
    if (typeof label !== "string") {
      throw new Error(`executionContext.${dimension} must be a non-empty string`);
    }
    normalized[dimension] = assertBoundedNonEmpty(
      label,
      `executionContext.${dimension}`,
      MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH,
    );
  }
  return normalized as unknown as SearchJourneyExecutionContextInputV1;
}

function persistExecutionContext(
  input: SearchJourneyExecutionContextInputV1,
  fingerprintKey: Uint8Array,
  workspaceId: string,
  retainText: boolean,
): SearchJourneyExecutionContextV1 {
  const fields = Object.fromEntries(
    SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.flatMap((dimension) => {
      const label = input[dimension];
      return label === undefined
        ? []
        : [
            [
              dimension,
              {
                fingerprint: journeyFingerprint(fingerprintKey, workspaceId, "execution-context", {
                  dimension,
                  label,
                }),
                ...(retainText ? { text: label } : {}),
              },
            ],
          ];
    }),
  );
  return {
    schemaVersion: 1,
    source: "caller-declared",
    ...fields,
  } as SearchJourneyExecutionContextV1;
}

function executionContextEvidence(
  session: SearchJourneyV1,
): SearchJourneyExecutionContextEvidenceV1 {
  const context = session.executionContext;
  if (context === undefined) {
    return {
      status: "not-recorded",
      uncontrolledDimensions: [...SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS],
    };
  }
  // Caller fingerprints are grouping evidence only after the persisted shape and retention contract pass.
  assertValidSessionState(session);
  const dimensions = SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.map((dimension) => [
    dimension,
    context[dimension]?.fingerprint ?? null,
  ]);
  return {
    status: "caller-declared",
    fingerprint: sha256Hex(canonicalJson({ schemaVersion: 1, dimensions })),
    uncontrolledDimensions: SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.filter(
      (dimension) => context[dimension] === undefined,
    ),
  };
}

function reportContextId(session: SearchJourneyV1, retrievalContextId: string): string {
  const execution = executionContextEvidence(session);
  return execution.status === "not-recorded"
    ? retrievalContextId
    : sha256Hex(
        canonicalJson({
          schemaVersion: 1,
          retrievalContextId,
          executionContext: execution.fingerprint,
        }),
      );
}

function journeyQueryFingerprint(
  fingerprintKey: Uint8Array,
  workspaceId: string,
  query: string,
): string {
  return journeyFingerprint(fingerprintKey, workspaceId, "query", query.trim());
}

function assertClientStep(step: number | undefined): void {
  if (
    step !== undefined &&
    (!Number.isSafeInteger(step) || step < 1 || step > MAX_SEARCH_JOURNEY_ATTEMPTS)
  ) {
    throw new Error(
      `search journey step must be an integer in [1, ${String(MAX_SEARCH_JOURNEY_ATTEMPTS)}]`,
    );
  }
}

function assertConsistentStepMode(
  attempts: readonly SearchJourneyAttemptV1[],
  step: number | undefined,
  sessionId: string,
): void {
  if (attempts.length === 0) return;
  const numbered = attempts.filter((attempt) => attempt.clientStep !== undefined).length;
  if (numbered !== 0 && numbered !== attempts.length) {
    throw new UntangleError(
      "SEARCH_SESSION_INVALID_STATE",
      `search journey "${sessionId}" contains mixed numbered and unnumbered attempts`,
      { operation: "search_journey_record", context: { sessionId } },
    );
  }
  const expectsStep = numbered === attempts.length;
  if (expectsStep !== (step !== undefined)) {
    throw new UntangleError(
      "SEARCH_SESSION_INVALID_STATE",
      `search journey "${sessionId}" cannot mix numbered and unnumbered attempts`,
      { operation: "search_journey_record", context: { sessionId } },
    );
  }
}

function sortAttempts(attempts: SearchJourneyAttemptV1[]): void {
  attempts.sort((left, right) => {
    return (
      (left.clientStep ?? left.sequence) - (right.clientStep ?? right.sequence) ||
      compareCodepoints(left.observedAt, right.observedAt) ||
      compareCodepoints(left.attemptId, right.attemptId)
    );
  });
  attempts.forEach((attempt, index) => {
    attempt.sequence = index + 1;
  });
}

function retrievalHealthyOfResult(result: SearchResultSetV1): boolean {
  return (
    result.groups.length > 0 &&
    result.groups.every((group) => group.notSearchedReason === undefined) &&
    !result.warnings.some(
      (warning) =>
        warning.code === INDEX_CONTEXT_INCOMPLETE_WARNING_CODE ||
        warning.code === "SEARCH_BRANCH_UNAVAILABLE" ||
        warning.code === "INCOMPLETE_PAYLOAD",
    ) &&
    !result.skipped.some(
      (entry) =>
        entry.subjectKind === "search_candidate" &&
        (entry.reason === "provider_unavailable" || entry.reason === "missing_index_entry"),
    )
  );
}

function observationFingerprintOfProjection(
  fingerprintKey: Uint8Array,
  workspaceId: string,
  projection: SearchObservationProjection,
  includeCodeEvidence = true,
): string {
  return journeyFingerprint(fingerprintKey, workspaceId, "successful-observation", {
    queryFingerprint: projection.queryFingerprint,
    queryText: projection.queryText,
    rankerVersion: projection.rankerVersion,
    rankingContextFingerprint: projection.rankingContextFingerprint,
    resultLimit: projection.resultLimit,
    candidateLimit: projection.candidateLimit,
    retrievalHealthy: projection.retrievalHealthy,
    groups: projection.groups.map((group) => ({
      embeddingProfileId: group.embeddingProfileId,
      indexGenerations: group.indexGenerations,
      ...(includeCodeEvidence
        ? { corpusRevisionFingerprint: group.corpusRevisionFingerprint }
        : {}),
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
        score: hit.score,
        ...(includeCodeEvidence
          ? {
              complexity: hit.complexity,
              incompletePayloadFields: hit.incompletePayloadFields,
            }
          : {}),
      })),
    })),
    warningCodes: projection.warningCodes,
  });
}

function compareCandidates(
  left: SearchJourneyCandidateV1,
  right: SearchJourneyCandidateV1,
): number {
  return (
    left.rank - right.rank ||
    compareCodepoints(left.embeddingProfileId, right.embeddingProfileId) ||
    compareCodepoints(left.indexGeneration, right.indexGeneration) ||
    compareCodepoints(left.repoId, right.repoId) ||
    compareCodepoints(left.refId, right.refId) ||
    compareCodepoints(left.filePath, right.filePath) ||
    compareCodepoints(left.chunkId, right.chunkId)
  );
}

function targetCodeComplexityEvidence(
  acceptedCandidates: readonly SearchJourneyCandidateV1[],
  accepted: SearchJourneyCandidateV1 | null,
): SearchJourneyTargetCodeComplexityEvidenceV1 {
  if (acceptedCandidates.length === 0) {
    return { status: "unavailable", reason: "target-not-returned" };
  }
  if (
    accepted === null ||
    new Set(acceptedCandidates.map((candidate) => candidateKey(candidate))).size !== 1 ||
    new Set(acceptedCandidates.map((candidate) => candidateCodeEvidence(candidate))).size !== 1
  ) {
    return { status: "unavailable", reason: "target-context-ambiguous" };
  }
  // New observations always carry this field, including the empty array.
  // Its absence therefore means that an older persisted candidate cannot
  // prove whether substituted payload values were involved.
  if (accepted.incompletePayloadFields === undefined) {
    return { status: "unavailable", reason: "legacy-observation" };
  }
  if (accepted.complexity === undefined) {
    return { status: "unavailable", reason: "complexity-not-indexed" };
  }
  const incompletePayloadFields = [...new Set(accepted.incompletePayloadFields)].sort(
    compareCodepoints,
  );
  return {
    status: "observed",
    source: "indexed-search-hit",
    candidate: {
      repoId: accepted.repoId,
      refId: accepted.refId,
      filePath: accepted.filePath,
      chunkId: accepted.chunkId,
      ...(accepted.symbolId === undefined ? {} : { symbolId: accepted.symbolId }),
      ...(accepted.symbolFqn === undefined ? {} : { symbolFqn: accepted.symbolFqn }),
      embeddingProfileId: accepted.embeddingProfileId,
      indexGeneration: accepted.indexGeneration,
    },
    complexity: structuredClone(accepted.complexity),
    payloadComplete: incompletePayloadFields.length === 0,
    incompletePayloadFields,
  };
}

function attemptContextKey(attempt: SearchJourneyAttemptV1): string {
  const profiles = attempt.profiles
    .map((profile) => ({
      embeddingProfileId: profile.embeddingProfileId,
      indexGenerations:
        profile.indexGenerations.length === 0
          ? ["unknown"]
          : [...profile.indexGenerations].sort(compareCodepoints),
      corpusRevisionFingerprint: profile.corpusRevisionFingerprint ?? "unknown",
    }))
    .sort((left, right) => compareCodepoints(canonicalJson(left), canonicalJson(right)));
  return canonicalJson({
    rankerVersion: attempt.rankerVersion,
    rankingContextFingerprint: attempt.rankingContextFingerprint ?? "unknown",
    resultLimit: attempt.resultLimit ?? "unknown",
    candidateLimit: attempt.candidateLimit ?? "unknown",
    profiles,
  });
}

function legacyContextId(attempts: readonly SearchJourneyAttemptV1[]): string {
  const rankers = [...new Set(attempts.map((attempt) => attempt.rankerVersion))].sort(
    compareCodepoints,
  );
  const profiles = [
    ...new Set(
      attempts.flatMap((attempt) =>
        attempt.profiles.flatMap((profile) =>
          profile.indexGenerations.length === 0
            ? [`${profile.embeddingProfileId}\u001funknown`]
            : profile.indexGenerations.map(
                (generation) => `${profile.embeddingProfileId}\u001f${generation}`,
              ),
        ),
      ),
    ),
  ].sort(compareCodepoints);
  const rankingContexts = [
    ...new Set(attempts.map((attempt) => attempt.rankingContextFingerprint ?? "unknown")),
  ].sort(compareCodepoints);
  const limits = [
    ...new Set(
      attempts.map(
        (attempt) =>
          `${String(attempt.resultLimit ?? "unknown")}\u001f${String(
            attempt.candidateLimit ?? "unknown",
          )}`,
      ),
    ),
  ].sort(compareCodepoints);
  return sha256Hex(canonicalJson({ rankers, profiles, rankingContexts, limits }));
}

function contextId(attempts: readonly SearchJourneyAttemptV1[]): string {
  const contextualAttempts = attempts.some((attempt) => attempt.status === "succeeded")
    ? attempts.filter((attempt) => attempt.status === "succeeded")
    : attempts;
  if (contextualAttempts.every((attempt) => attempt.measurementContextVersion === undefined)) {
    return legacyContextId(contextualAttempts);
  }
  const attemptContexts = [...new Set(contextualAttempts.map(attemptContextKey))].sort(
    compareCodepoints,
  );
  return sha256Hex(canonicalJson({ schemaVersion: 2, attemptContexts }));
}

function measurementContextComplete(attempts: readonly SearchJourneyAttemptV1[]): boolean {
  const versioned = attempts.some((attempt) => attempt.measurementContextVersion !== undefined);
  return (
    attempts.length > 0 &&
    attempts.every(
      (attempt) =>
        (!versioned || attempt.measurementContextVersion === 2) &&
        attempt.status === "succeeded" &&
        attempt.retrievalHealthy &&
        attempt.rankingContextFingerprint !== undefined &&
        attempt.resultLimit !== undefined &&
        attempt.candidateLimit !== undefined &&
        attempt.profiles.length > 0 &&
        attempt.profiles.every(
          (profile) =>
            (!versioned || profile.corpusRevisionFingerprint !== undefined) &&
            profile.retrieval !== undefined &&
            profile.indexGenerations.length > 0 &&
            profile.indexGenerations.every((generation) => generation !== "unknown"),
        ),
    ) &&
    new Set(attempts.map(attemptContextKey)).size === 1
  );
}

function attemptHasRetrieval(attempt: SearchJourneyAttemptV1): boolean {
  return (
    attempt.status === "succeeded" && attempt.profiles.some((profile) => profile.retrievalPerformed)
  );
}

function jaccardDistance(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return 1 - intersection / union.size;
}

/** Berechnet die erklaerbaren Komponenten einer abgeschlossenen Journey. */
export function assessSearchJourney(
  session: SearchJourneyV1,
  input: CompleteSearchJourneyInput,
): DynamicSearchComplexityV1 {
  const target = normalizedTarget(input.target);
  if (session.attempts.length === 0) {
    throw new Error("search journey cannot be completed before at least one search attempt");
  }
  const numberedSteps = session.attempts.flatMap((attempt) =>
    attempt.clientStep === undefined ? [] : [attempt.clientStep],
  );
  if (numberedSteps.length > 0) {
    const maximum = Math.max(...numberedSteps);
    const present = new Set(numberedSteps);
    const missing = Array.from({ length: maximum }, (_, index) => index + 1).filter(
      (step) => !present.has(step),
    );
    if (missing.length > 0) {
      throw new Error(
        `search journey cannot be completed with missing client step(s): ${missing.join(", ")}`,
      );
    }
  }

  const requestedAttempt =
    input.acceptedAttemptId === undefined
      ? undefined
      : session.attempts.find((attempt) => attempt.attemptId === input.acceptedAttemptId);
  if (input.acceptedAttemptId !== undefined && requestedAttempt === undefined) {
    throw new Error(`search journey has no attempt "${input.acceptedAttemptId}"`);
  }

  const attemptsWithTarget = session.attempts.filter((attempt) =>
    attempt.profiles.some((profile) =>
      profile.candidates.some((candidate) => targetMatches(candidate, target)),
    ),
  );
  if (
    requestedAttempt !== undefined &&
    !attemptsWithTarget.some((attempt) => attempt.attemptId === requestedAttempt.attemptId)
  ) {
    throw new Error(
      `accepted attempt "${requestedAttempt.attemptId}" does not contain the confirmed target`,
    );
  }

  // Der letzte passende Versuch entspricht ohne explizite Auswahl am ehesten
  // dem Treffer, den der Agent gerade akzeptiert hat. Bei expliziter Auswahl
  // zaehlen nur Versuche bis zu diesem Schritt: spaeter/out-of-order
  // eingetroffene Beobachtungen duerfen die Suche bis zum Ziel nicht aufblasen.
  const acceptedAttempt =
    requestedAttempt ?? attemptsWithTarget[attemptsWithTarget.length - 1] ?? null;
  const attemptsToTarget =
    requestedAttempt === undefined
      ? session.attempts
      : session.attempts.filter((attempt) => attempt.sequence <= requestedAttempt.sequence);
  const acceptedCandidates =
    acceptedAttempt === null
      ? []
      : acceptedAttempt.profiles
          .flatMap((profile) => profile.candidates)
          .filter((candidate) => targetMatches(candidate, target))
          .sort(compareCandidates);
  const acceptedContexts = new Set(
    acceptedCandidates.map(
      (candidate) => `${candidate.embeddingProfileId}\u001f${candidate.indexGeneration}`,
    ),
  );
  const targetWasReturned = acceptedCandidates.length > 0;
  const accepted = acceptedContexts.size <= 1 ? (acceptedCandidates[0] ?? null) : null;
  const acceptedTargetCodeComplexity = targetCodeComplexityEvidence(acceptedCandidates, accepted);
  const firstReturnedAttempt =
    attemptsWithTarget.find(
      (attempt) => acceptedAttempt === null || attempt.sequence <= acceptedAttempt.sequence,
    ) ?? null;

  const distinctQueries = new Set(attemptsToTarget.map((attempt) => attempt.queryFingerprint));
  const allCandidates = attemptsToTarget.flatMap((attempt) =>
    attempt.profiles.flatMap((profile) => profile.candidates),
  );
  const uniqueCandidates = new Map(
    allCandidates.map((candidate) => [candidateKey(candidate), candidate]),
  );
  const uniqueFiles = new Set(
    allCandidates.map(
      (candidate) => `${candidate.repoId}\u001f${candidate.refId}\u001f${candidate.filePath}`,
    ),
  );
  const retrievals = attemptsToTarget.flatMap((attempt) =>
    attempt.profiles.flatMap((profile) =>
      profile.retrieval === undefined ? [] : [profile.retrieval],
    ),
  );
  const eligibleCandidatesExamined = retrievals.reduce(
    (sum, retrieval) => sum + retrieval.eligibleCandidateCount,
    0,
  );
  const dispersionWeight = retrievals.reduce(
    (sum, retrieval) => sum + retrieval.eligibleCandidateCount,
    0,
  );
  const meanCandidateFileDispersion =
    dispersionWeight === 0
      ? null
      : retrievals.reduce(
          (sum, retrieval) =>
            sum + retrieval.eligibleFileDispersion * retrieval.eligibleCandidateCount,
          0,
        ) / dispersionWeight;
  const retrievedAttempts = attemptsToTarget.filter(attemptHasRetrieval);
  const candidateLimitHitRate =
    retrievedAttempts.length === 0
      ? 0
      : retrievedAttempts.filter((attempt) =>
          attempt.profiles.some((profile) => profile.retrieval?.candidateLimitReached === true),
        ).length / retrievedAttempts.length;
  const successfulCandidateSets = attemptsToTarget.flatMap((attempt) =>
    !attemptHasRetrieval(attempt)
      ? []
      : [
          new Set(
            attempt.profiles.flatMap((profile) =>
              profile.candidates.map((candidate) => candidateKey(candidate)),
            ),
          ),
        ],
  );
  const churnPairs = successfulCandidateSets
    .slice(1)
    .map((current, index) =>
      jaccardDistance(successfulCandidateSets[index] as ReadonlySet<string>, current),
    );
  const meanCandidateChurn = churnPairs.length === 0 ? null : mean(churnPairs);
  const successfulSearchesToTarget = attemptsToTarget.filter(
    (attempt) => attempt.status === "succeeded",
  ).length;
  const failedSearchesToTarget = attemptsToTarget.length - successfulSearchesToTarget;
  const healthyRetrievalRate =
    attemptsToTarget.length === 0
      ? 0
      : attemptsToTarget.filter((attempt) => attempt.retrievalHealthy).length /
        attemptsToTarget.length;

  let acceptedTargetScoreMargin: number | null = null;
  if (accepted !== null && acceptedAttempt !== null) {
    const profile = acceptedAttempt.profiles.find(
      (entry) => entry.embeddingProfileId === accepted.embeddingProfileId,
    );
    const sameProfile = (profile?.candidates ?? []).filter(
      (candidate) => candidate.indexGeneration === accepted.indexGeneration,
    );
    const competitor = sameProfile
      .filter((candidate) => candidateKey(candidate) !== candidateKey(accepted))
      .sort((left, right) => right.score - left.score || compareCandidates(left, right))[0];
    if (competitor !== undefined) acceptedTargetScoreMargin = accepted.score - competitor.score;
  }

  const caveats = [
    "This is a heuristic observation of one task, not cognitive complexity.",
    "A confirmed target labels one accepted result; it does not label every candidate, so precision is not claimed.",
    "Observed target code complexity is a separate static evidence axis; it is not combined with retrieval effort into a score or a causal claim.",
    session.executionContext === undefined
      ? "Agent model, harness, prior context and search strategy are not captured for this session; compare observations only under externally controlled caller conditions."
      : "Execution context was explicitly caller-declared at journey start; report cohorts segment those fingerprints without independently verifying the declarations or asserting causation.",
  ];
  if (!targetWasReturned) {
    caveats.push(
      "The confirmed target was not present in a returned result; rank, reciprocal rank and score margin are unavailable.",
    );
  }
  if (session.navigation.length === 0) {
    caveats.push(
      "No navigation events were reported; observedToolAndFileHops contains search calls only.",
    );
  }
  if (retrievals.length === 0) {
    caveats.push(
      "No retrieval diagnostics were available; eligible-candidate and dispersion indicators are incomplete.",
    );
  }
  if (attemptsToTarget.some((attempt) => attempt.status === "failed")) {
    caveats.push(
      "At least one search attempt failed; failures remain counted as search effort and their effective retrieval limits are unavailable.",
    );
  }
  if (acceptedContexts.size > 1) {
    caveats.push(
      "The confirmed target appeared in multiple embedding-profile or generation contexts; rank, reciprocal rank and score margin remain unavailable until the target locator selects one context.",
    );
  }
  if (acceptedTargetCodeComplexity.status === "unavailable") {
    caveats.push(
      `Static code complexity for the confirmed target is unavailable (${acceptedTargetCodeComplexity.reason}); no value was inferred.`,
    );
  } else if (!acceptedTargetCodeComplexity.payloadComplete) {
    caveats.push(
      "The confirmed target carries static code metrics, but its search payload used documented substitutes; inspect incompletePayloadFields before comparison.",
    );
  }
  if (requestedAttempt !== undefined && requestedAttempt.sequence < session.attempts.length) {
    caveats.push(
      "Search metrics stop at the explicitly accepted attempt; independently ordered navigation events still include every event reported before completion.",
    );
  }
  if (requestedAttempt === undefined && acceptedAttempt !== null) {
    caveats.push(
      "No acceptedAttemptId was supplied; every search through completion remains counted, while target rank and score margin use the last matching attempt.",
    );
  }
  const contextComplete = measurementContextComplete(attemptsToTarget);
  if (!contextComplete) {
    caveats.push(
      "The effective ranking policy, limits, embedding profiles, index generations or retrieval diagnostics are incomplete or changed across counted attempts; this observation cannot contribute sufficient product-level cohort evidence.",
    );
  }

  return {
    schemaVersion: 1,
    algorithm: DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID,
    isHeuristic: true,
    searchesToTarget: attemptsToTarget.length,
    successfulSearchesToTarget,
    failedSearchesToTarget,
    distinctQueryCount: distinctQueries.size,
    queryReformulations: Math.max(0, distinctQueries.size - 1),
    acceptedTargetRank: accepted?.rank ?? null,
    reciprocalRank: accepted === null ? null : 1 / accepted.rank,
    targetWasReturned,
    targetFirstReturnedAtSearch: firstReturnedAttempt?.sequence ?? null,
    targetAcceptedAtSearch: acceptedAttempt?.sequence ?? null,
    selectionLagSearches:
      acceptedAttempt === null || firstReturnedAttempt === null
        ? null
        : acceptedAttempt.sequence - firstReturnedAttempt.sequence,
    directHit:
      attemptsToTarget.length === 1 && acceptedAttempt?.sequence === 1 && accepted?.rank === 1,
    eligibleCandidatesExamined,
    uniqueCandidatesExposed: uniqueCandidates.size,
    uniqueFilesExposed: uniqueFiles.size,
    navigationEventsToTarget: session.navigation.length,
    observedToolAndFileHops: attemptsToTarget.length + session.navigation.length,
    meanCandidateFileDispersion,
    meanCandidateChurn,
    candidateLimitHitRate,
    healthyRetrievalRate,
    acceptedTargetScoreMargin,
    acceptedTargetCodeComplexity,
    measurementContextId: contextId(attemptsToTarget),
    measurementContextComplete: contextComplete,
    caveats,
  };
}

function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("quantile needs at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return ordered[index] as number;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] as number;
  return ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildCohort(
  measurementContextId: string,
  assessments: readonly DynamicSearchComplexityV1[],
  executionContext: SearchJourneyExecutionContextEvidenceV1,
): DynamicProductComplexityCohortV1 {
  const ranks = assessments.flatMap((assessment) =>
    assessment.acceptedTargetRank === null ? [] : [assessment.acceptedTargetRank],
  );
  const reciprocalRanks = assessments.flatMap((assessment) =>
    assessment.reciprocalRank === null ? [] : [assessment.reciprocalRank],
  );
  const dispersions = assessments.flatMap((assessment) =>
    assessment.meanCandidateFileDispersion === null ? [] : [assessment.meanCandidateFileDispersion],
  );
  const churn = assessments.flatMap((assessment) =>
    assessment.meanCandidateChurn === null ? [] : [assessment.meanCandidateChurn],
  );
  const contextComplete = assessments.every((assessment) => assessment.measurementContextComplete);
  const sufficientEvidence =
    contextComplete && assessments.length >= MINIMUM_PRODUCT_COMPLEXITY_SESSIONS;
  return {
    measurementContextId,
    completedSessionCount: assessments.length,
    measurementContextComplete: contextComplete,
    sufficientEvidence,
    minimumCompletedSessions: MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
    executionContext,
    callerConditionsControlled: executionContext.uncontrolledDimensions.length === 0,
    medianSearchesToTarget: median(assessments.map((assessment) => assessment.searchesToTarget)),
    p90SearchesToTarget: quantile(
      assessments.map((assessment) => assessment.searchesToTarget),
      0.9,
    ),
    medianQueryReformulations: median(
      assessments.map((assessment) => assessment.queryReformulations),
    ),
    medianAcceptedTargetRank: ranks.length === 0 ? null : median(ranks),
    meanReciprocalRank: reciprocalRanks.length === 0 ? null : mean(reciprocalRanks),
    targetReturnedRate:
      assessments.filter((assessment) => assessment.targetWasReturned).length / assessments.length,
    directHitRate:
      assessments.filter((assessment) => assessment.directHit).length / assessments.length,
    healthyRetrievalRate: mean(assessments.map((assessment) => assessment.healthyRetrievalRate)),
    medianEligibleCandidatesExamined: median(
      assessments.map((assessment) => assessment.eligibleCandidatesExamined),
    ),
    medianUniqueFilesExposed: median(
      assessments.map((assessment) => assessment.uniqueFilesExposed),
    ),
    meanCandidateFileDispersion: dispersions.length === 0 ? null : mean(dispersions),
    meanCandidateChurn: churn.length === 0 ? null : mean(churn),
    candidateLimitHitRate: mean(assessments.map((assessment) => assessment.candidateLimitHitRate)),
    caveats: [
      ...(!contextComplete
        ? [
            "At least one observation has an incomplete effective retrieval context; this cohort cannot be treated as sufficient product-level evidence.",
          ]
        : sufficientEvidence
          ? [
              "This is a heuristic cohort signal segmented by ranker, embedding profile and index generation; it is neither a temporal trend nor a static code metric.",
            ]
          : [
              `Only ${String(assessments.length)} completed session(s) are available; at least ${String(MINIMUM_PRODUCT_COMPLEXITY_SESSIONS)} are required before treating this cohort as sufficient product-level evidence.`,
            ]),
      executionContext.status === "not-recorded"
        ? "Caller execution conditions were not recorded; retrieval sufficiency does not establish comparable agent behavior."
        : "Execution conditions are caller-declared, not independently verified; equal labels do not establish a causal product effect.",
      ...(executionContext.uncontrolledDimensions.length === 0
        ? []
        : [
            `Uncontrolled execution dimensions: ${executionContext.uncontrolledDimensions.join(", ")}.`,
          ]),
    ],
  };
}

interface CompletedFeatureObservation {
  goalFingerprint: string;
  target: SearchJourneyTargetV1;
  assessment: DynamicSearchComplexityV1;
  executionContext: SearchJourneyExecutionContextEvidenceV1;
}

function reportAssessment(session: SearchJourneyV1): DynamicSearchComplexityV1 {
  if (session.outcome?.kind !== "completed") {
    throw new Error("report assessment requires a completed search journey");
  }
  const assessment = session.outcome.assessment;
  const contextualAssessment = {
    ...assessment,
    measurementContextId: reportContextId(session, assessment.measurementContextId),
  };
  if (session.attempts.every((attempt) => attempt.measurementContextVersion === 2)) {
    return contextualAssessment;
  }
  return {
    ...contextualAssessment,
    measurementContextComplete: false,
    caveats: [
      ...assessment.caveats,
      "This legacy observation predates immutable corpus-revision fingerprints; it remains visible but cannot contribute sufficient product-level evidence.",
    ],
  };
}

function buildFeatureMapping(
  featureFingerprint: string,
  measurementContextId: string,
  observations: readonly CompletedFeatureObservation[],
): DynamicProductComplexityFeatureMappingV1 {
  const targetGroups = new Map<string, CompletedFeatureObservation[]>();
  for (const observation of observations) {
    const key = canonicalJson(observation.target);
    const group = targetGroups.get(key) ?? [];
    group.push(observation);
    targetGroups.set(key, group);
  }
  const targets = [...targetGroups.entries()]
    .sort(([left], [right]) => compareCodepoints(left, right))
    .map(([, targetObservations]) => {
      const first = targetObservations[0];
      if (first === undefined) throw new Error("feature target group must not be empty");
      const variants = new Map<
        string,
        { evidence: SearchJourneyTargetCodeComplexityEvidenceV1; completedSessionCount: number }
      >();
      for (const observation of targetObservations) {
        const evidence = observation.assessment.acceptedTargetCodeComplexity ?? {
          status: "unavailable" as const,
          reason: "legacy-observation" as const,
        };
        const key = canonicalJson(evidence);
        const existing = variants.get(key);
        if (existing === undefined) {
          variants.set(key, { evidence: structuredClone(evidence), completedSessionCount: 1 });
        } else {
          existing.completedSessionCount += 1;
        }
      }
      return {
        target: structuredClone(first.target),
        completedSessionCount: targetObservations.length,
        complexityVariants: [...variants.entries()]
          .sort(([left], [right]) => compareCodepoints(left, right))
          .map(([, variant]) => variant),
      };
    });
  const evidence = observations.map(
    (observation) =>
      observation.assessment.acceptedTargetCodeComplexity ?? {
        status: "unavailable" as const,
        reason: "legacy-observation" as const,
      },
  );
  const observedComplexitySessionCount = evidence.filter(
    (entry) => entry.status === "observed",
  ).length;
  const incompletePayloadCount = evidence.filter(
    (entry) => entry.status === "observed" && !entry.payloadComplete,
  ).length;
  const unavailableComplexitySessionCount = evidence.length - observedComplexitySessionCount;
  const distinctGoalCount = new Set(observations.map((entry) => entry.goalFingerprint)).size;
  const caveats = [
    "Search effort and static target-code complexity are separate evidence axes; no combined score or causal relationship is asserted.",
    "Different target-locator precision can represent the same physical code as multiple confirmed targets; compare locators before interpreting target counts.",
  ];
  if (distinctGoalCount > 1) {
    caveats.push(
      "This feature mapping contains multiple task goals; search medians describe the observed feature workload, not repeated identical prompts.",
    );
  }
  if (unavailableComplexitySessionCount > 0) {
    caveats.push(
      `${String(unavailableComplexitySessionCount)} completed session(s) have no attributable static target-code complexity; missing values remain explicit and are never treated as zero.`,
    );
  }
  if (incompletePayloadCount > 0) {
    caveats.push(
      `${String(incompletePayloadCount)} observed static complexity value(s) came from search hits with incomplete payload provenance.`,
    );
  }
  return {
    featureFingerprint,
    measurementContextId,
    distinctGoalCount,
    search: buildCohort(
      measurementContextId,
      observations.map((observation) => observation.assessment),
      observations[0]?.executionContext ?? {
        status: "not-recorded",
        uncontrolledDimensions: [...SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS],
      },
    ),
    code: {
      confirmedTargetCount: targets.length,
      observedComplexitySessionCount,
      unavailableComplexitySessionCount,
      targets,
    },
    caveats,
  };
}

function buildOutcomeCohorts(sessions: readonly SearchJourneyV1[]): DynamicSearchOutcomeCohortV1[] {
  const grouped = new Map<
    string,
    {
      measurementContextId: string;
      retrievalContextId: string;
      executionContext: SearchJourneyExecutionContextEvidenceV1;
      featureFingerprint?: string;
      sessions: SearchJourneyV1[];
    }
  >();
  for (const session of sessions) {
    const retrievalContextId = contextId(session.attempts);
    const measurementContextId = reportContextId(session, retrievalContextId);
    const key = canonicalJson([measurementContextId, session.feature?.fingerprint ?? null]);
    const group = grouped.get(key) ?? {
      measurementContextId,
      retrievalContextId,
      executionContext: executionContextEvidence(session),
      ...(session.feature === undefined ? {} : { featureFingerprint: session.feature.fingerprint }),
      sessions: [],
    };
    group.sessions.push(session);
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareCodepoints(left, right))
    .map(([, group]) => {
      const completed = group.sessions.filter((session) => session.status === "completed").length;
      const abandoned = group.sessions.filter((session) => session.status === "abandoned").length;
      const terminal = completed + abandoned;
      const reasons = new Map<
        NonNullable<DynamicSearchOutcomeCohortV1["abandonmentReasons"]>[number]["reasonCode"],
        number
      >();
      for (const session of group.sessions) {
        if (session.outcome?.kind !== "abandoned") continue;
        const reasonCode = session.outcome.reasonCode ?? "not-recorded";
        reasons.set(reasonCode, (reasons.get(reasonCode) ?? 0) + 1);
      }
      const { sessions: observations, ...context } = group;
      return {
        ...context,
        distinctGoalCount: new Set(observations.map((session) => session.goal.fingerprint)).size,
        sessionCounts: {
          total: observations.length,
          active: observations.length - terminal,
          completed,
          abandoned,
          terminal,
        },
        terminalCompletionRate: terminal === 0 ? null : completed / terminal,
        retrievalContextComplete: observations.every(
          (session) =>
            session.attempts.every((attempt) => attempt.measurementContextVersion === 2) &&
            measurementContextComplete(session.attempts),
        ),
        statusEffort: SEARCH_JOURNEY_STATUSES.map((status) => {
          const matching = observations.filter((session) => session.status === status);
          const searches = matching.map((session) => session.attempts.length);
          const totalSearches = searches.reduce((sum, count) => sum + count, 0);
          const totalNavigationEvents = matching.reduce(
            (sum, session) => sum + session.navigation.length,
            0,
          );
          return {
            status,
            sessionCount: matching.length,
            sessionsWithSearches: searches.filter((count) => count > 0).length,
            totalSearches,
            failedSearches: matching.reduce(
              (sum, session) =>
                sum + session.attempts.filter((attempt) => attempt.status === "failed").length,
              0,
            ),
            totalNavigationEvents,
            totalObservedHops: totalSearches + totalNavigationEvents,
            medianSearches: searches.length === 0 ? null : median(searches),
          };
        }),
        abandonmentReasons: [...reasons.entries()]
          .sort(([left], [right]) => compareCodepoints(left, right))
          .map(([reasonCode, count]) => ({ reasonCode, count })),
        caveats: [
          "Outcome cohorts retain every observed search and navigation event, including failed searches, zero-search sessions and searches after an explicitly accepted earlier attempt; these are not completed-to-target metrics.",
          "The completion-rate denominator is completed plus abandoned sessions in this cohort; active sessions are reported separately, and the rate describes recorded tasks rather than benchmark accuracy.",
          "Unknown or incompatible retrieval/execution contexts remain separate, including retrieval-unavailable tasks with no known profile; inspect all cohorts before interpreting successful-task effort.",
          "Task mix, sampling and declaration accuracy are not independently verified or normalized; there is no temporal trend, causal quality claim or ROI estimate.",
        ],
      };
    });
}

/** Aggregiert ausschliesslich kompatible Messkontexte in getrennten Kohorten. */
export function buildDynamicProductComplexityReport(
  workspaceId: string,
  sessions: readonly SearchJourneyV1[],
  generatedAt: string,
): DynamicProductComplexityReportV1 {
  const scoped = sessions.filter((session) => session.workspaceId === workspaceId);
  const completed = scoped.filter(
    (session) => session.status === "completed" && session.outcome?.kind === "completed",
  );
  const grouped = new Map<
    string,
    {
      assessments: DynamicSearchComplexityV1[];
      executionContext: SearchJourneyExecutionContextEvidenceV1;
    }
  >();
  for (const session of completed) {
    if (session.outcome?.kind !== "completed") continue;
    const assessment = reportAssessment(session);
    const cohort = grouped.get(assessment.measurementContextId) ?? {
      assessments: [],
      executionContext: executionContextEvidence(session),
    };
    cohort.assessments.push(assessment);
    grouped.set(assessment.measurementContextId, cohort);
  }

  const cohorts: DynamicProductComplexityCohortV1[] = [...grouped.entries()]
    .sort(([left], [right]) => compareCodepoints(left, right))
    .map(([measurementContextId, cohort]) =>
      buildCohort(measurementContextId, cohort.assessments, cohort.executionContext),
    );

  const featureGroups = new Map<
    string,
    {
      featureFingerprint: string;
      measurementContextId: string;
      observations: CompletedFeatureObservation[];
    }
  >();
  for (const session of completed) {
    if (session.feature === undefined || session.outcome?.kind !== "completed") continue;
    const { target } = session.outcome;
    const assessment = reportAssessment(session);
    const key = canonicalJson([session.feature.fingerprint, assessment.measurementContextId]);
    const group = featureGroups.get(key) ?? {
      featureFingerprint: session.feature.fingerprint,
      measurementContextId: assessment.measurementContextId,
      observations: [],
    };
    group.observations.push({
      goalFingerprint: session.goal.fingerprint,
      target,
      assessment,
      executionContext: executionContextEvidence(session),
    });
    featureGroups.set(key, group);
  }
  const featureMappings = [...featureGroups.values()]
    .sort(
      (left, right) =>
        compareCodepoints(left.featureFingerprint, right.featureFingerprint) ||
        compareCodepoints(left.measurementContextId, right.measurementContextId),
    )
    .map((group) =>
      buildFeatureMapping(group.featureFingerprint, group.measurementContextId, group.observations),
    );

  return {
    schemaVersion: 1,
    algorithm: DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID,
    isHeuristic: true,
    workspaceId,
    generatedAt,
    sessionCounts: {
      total: scoped.length,
      active: scoped.filter((session) => session.status === "active").length,
      completed: completed.length,
      featureTaggedCompleted: completed.filter((session) => session.feature !== undefined).length,
      abandoned: scoped.filter((session) => session.status === "abandoned").length,
    },
    cohorts,
    featureMappings,
    outcomeCohorts: buildOutcomeCohorts(scoped),
    caveats: [
      "Completed-to-target cohort metrics exclude active and abandoned sessions; separate outcome cohorts expose all statuses, denominators and observed effort.",
      "Incompatible ranker/profile/generation contexts are never merged.",
      "Execution context is optional and caller-declared; absent context remains visibly uncontrolled and is never inferred from historical sessions. Equal declared conditions do not independently verify comparability or causation.",
      "Task mix and sampling policy are not normalized in v1; each cohort describes the workload that was actually observed.",
      "The report describes observed retrieval effort; it does not replace cognitive complexity and does not claim unlabeled precision.",
      "Feature mappings include only journeys started with an explicit stable feature ID and keep search effort separate from static target-code complexity.",
    ],
  };
}

export class SearchJourneyService {
  private readonly pendingMutations = new Map<string, Promise<void>>();
  private fingerprintKey: Uint8Array | undefined;

  public constructor(private readonly deps: SearchJourneyServiceDeps) {
    assertBoundedNonEmpty(deps.workspaceId, "workspaceId", MAX_SEARCH_JOURNEY_LOCATOR_LENGTH);
    if (deps.fingerprintKey !== undefined) {
      this.fingerprintKey = this.validatedFingerprintKey(deps.fingerprintKey);
    }
  }

  public async start(
    input: StartSearchJourneyInput,
    options?: PortCallOptions,
  ): Promise<SearchJourneyV1> {
    options?.signal?.throwIfAborted();
    const goal = assertBoundedNonEmpty(input.goal, "goal", MAX_SEARCH_JOURNEY_TEXT_LENGTH);
    const featureId =
      input.featureId === undefined ? undefined : assertNonEmpty(input.featureId, "featureId");
    if (featureId !== undefined && featureId.length > MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH) {
      throw new Error(
        `featureId must contain at most ${String(MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH)} UTF-16 code units`,
      );
    }
    const executionContext = normalizeExecutionContext(input.executionContext);
    const fingerprintKey = await this.getFingerprintKey(options);
    const now = this.deps.clock.nowIso();
    const session: SearchJourneyV1 = {
      schemaVersion: 1,
      revision: 0,
      sessionId: this.deps.random.uuid(),
      workspaceId: this.deps.workspaceId,
      status: "active",
      recordingConsent: "explicit",
      retainText: input.retainText ?? false,
      goal: {
        fingerprint: journeyFingerprint(fingerprintKey, this.deps.workspaceId, "goal", goal),
        ...(input.retainText === true ? { text: goal } : {}),
      },
      ...(featureId === undefined
        ? {}
        : {
            feature: {
              fingerprint: journeyFingerprint(
                fingerprintKey,
                this.deps.workspaceId,
                "feature",
                featureId,
              ),
              ...(input.retainText === true ? { text: featureId } : {}),
            },
          }),
      ...(executionContext === undefined
        ? {}
        : {
            executionContext: persistExecutionContext(
              executionContext,
              fingerprintKey,
              this.deps.workspaceId,
              input.retainText === true,
            ),
          }),
      createdAt: now,
      updatedAt: now,
      attempts: [],
      navigation: [],
    };
    assertValidSessionState(session);
    await this.deps.store.put(session, {
      ...options,
      expectedRevision: null,
    });
    return cloneSession(session);
  }

  public async get(sessionId: string, options?: PortCallOptions): Promise<SearchJourneyV1> {
    const id = assertNonEmpty(sessionId, "sessionId");
    const session = await this.deps.store.get(id, options);
    if (session === null || session.workspaceId !== this.deps.workspaceId) {
      throw new UntangleError(
        "SEARCH_SESSION_NOT_FOUND",
        `search journey "${id}" was not found in this workspace`,
        { operation: "search_journey_get", context: { sessionId: id } },
      );
    }
    return cloneSession(session);
  }

  public async recordSearch(
    sessionId: string,
    result: SearchResultSetV1,
    link: SearchJourneySearchLink = {},
    options?: PortCallOptions,
  ): Promise<RecordedSearchAttempt> {
    assertClientStep(link.step);
    const queryText = assertBoundedNonEmpty(
      result.query.text,
      "query",
      MAX_SEARCH_JOURNEY_TEXT_LENGTH,
    );
    if (result.query.workspaceId !== this.deps.workspaceId) {
      throw new Error(
        `search result belongs to workspace "${result.query.workspaceId}", not "${this.deps.workspaceId}"`,
      );
    }
    const profileIds = result.groups.map((group) => group.embeddingProfileId);
    if (new Set(profileIds).size !== profileIds.length) {
      throw new UntangleError(
        "SEARCH_SESSION_INVALID_STATE",
        "search result contains duplicate embedding-profile groups",
        { operation: "search_journey_record", context: { sessionId } },
      );
    }
    const projection = projectSearchObservation(result, queryText);
    const fingerprintKey = await this.getFingerprintKey(options);
    const observationFingerprint = observationFingerprintOfProjection(
      fingerprintKey,
      this.deps.workspaceId,
      projection,
    );
    const legacyObservationFingerprint = observationFingerprintOfProjection(
      fingerprintKey,
      this.deps.workspaceId,
      projection,
      false,
    );
    return this.mutate(
      sessionId,
      (session) => {
        assertConsistentStepMode(session.attempts, link.step, sessionId);
        const existing = session.attempts.find(
          (attempt) => link.step !== undefined && attempt.clientStep === link.step,
        );
        if (existing !== undefined) {
          const legacyReplay =
            existing.profiles.every((profile) =>
              profile.candidates.every(
                (candidate) =>
                  candidate.complexity === undefined &&
                  candidate.incompletePayloadFields === undefined,
              ),
            ) && existing.observationFingerprint === legacyObservationFingerprint;
          if (existing.observationFingerprint !== observationFingerprint && !legacyReplay) {
            throw new UntangleError(
              "SEARCH_SESSION_CONFLICT",
              `search journey step ${String(link.step)} already records a different observation`,
              {
                operation: "search_journey_record",
                context: { sessionId, step: link.step },
              },
            );
          }
          return { session, value: existing, changed: false };
        }
        if (session.attempts.length >= MAX_SEARCH_JOURNEY_ATTEMPTS) {
          throw new UntangleError(
            "SEARCH_SESSION_INVALID_STATE",
            `search journey reached its limit of ${String(MAX_SEARCH_JOURNEY_ATTEMPTS)} attempts`,
            { operation: "search_journey_record", context: { sessionId } },
          );
        }
        const attempt: SearchJourneyAttemptV1 = {
          attemptId: this.deps.random.uuid(),
          sequence: session.attempts.length + 1,
          measurementContextVersion: 2,
          // Aus dem Verdikt abgeleitet, nie aus einer leeren Kandidatenliste.
          ...(projection.abstention === null ? {} : { abstention: projection.abstention }),
          ...(link.step === undefined ? {} : { clientStep: link.step }),
          observationFingerprint,
          queryFingerprint: journeyQueryFingerprint(
            fingerprintKey,
            this.deps.workspaceId,
            queryText,
          ),
          ...(session.retainText ? { queryText } : {}),
          rankerVersion: projection.rankerVersion,
          ...(projection.rankingContextFingerprint === null
            ? {}
            : { rankingContextFingerprint: projection.rankingContextFingerprint }),
          resultLimit: projection.resultLimit,
          candidateLimit: projection.candidateLimit,
          observedAt: this.deps.clock.nowIso(),
          status: "succeeded",
          warningCodes: [...projection.warningCodes],
          retrievalHealthy: projection.retrievalHealthy,
          profiles: profilesOfProjection(projection),
        };
        session.attempts.push(attempt);
        sortAttempts(session.attempts);
        session.updatedAt = attempt.observedAt;
        return { session, value: attempt };
      },
      options,
      { allowTerminalIdempotentReplay: link.step !== undefined },
    ).then(({ session, value }) => ({ session, attempt: value }));
  }

  public async recordFailedSearch(
    sessionId: string,
    input: RecordFailedSearchInput,
    link: SearchJourneySearchLink = {},
    options?: PortCallOptions,
  ): Promise<RecordedSearchAttempt> {
    assertClientStep(link.step);
    const query = assertBoundedNonEmpty(input.query, "query", MAX_SEARCH_JOURNEY_TEXT_LENGTH);
    const failureCode = assertBoundedNonEmpty(
      input.failureCode,
      "failureCode",
      MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
    );
    const failureReason = assertBoundedNonEmpty(
      input.failureReason,
      "failureReason",
      MAX_SEARCH_JOURNEY_REASON_LENGTH,
    );
    const fingerprintKey = await this.getFingerprintKey(options);
    const observationFingerprint = journeyFingerprint(
      fingerprintKey,
      this.deps.workspaceId,
      "failed-observation",
      {
        query,
        failureCode,
        failureReason,
        rankerVersion: RANKER_VERSION,
      },
    );
    return this.mutate(
      sessionId,
      (session) => {
        assertConsistentStepMode(session.attempts, link.step, sessionId);
        const existing = session.attempts.find(
          (attempt) => link.step !== undefined && attempt.clientStep === link.step,
        );
        if (existing !== undefined) {
          if (existing.observationFingerprint !== observationFingerprint) {
            throw new UntangleError(
              "SEARCH_SESSION_CONFLICT",
              `search journey step ${String(link.step)} already records a different observation`,
              {
                operation: "search_journey_record_failure",
                context: { sessionId, step: link.step },
              },
            );
          }
          return { session, value: existing, changed: false };
        }
        if (session.attempts.length >= MAX_SEARCH_JOURNEY_ATTEMPTS) {
          throw new UntangleError(
            "SEARCH_SESSION_INVALID_STATE",
            `search journey reached its limit of ${String(MAX_SEARCH_JOURNEY_ATTEMPTS)} attempts`,
            { operation: "search_journey_record", context: { sessionId } },
          );
        }
        const observedAt = this.deps.clock.nowIso();
        const attempt: SearchJourneyAttemptV1 = {
          attemptId: this.deps.random.uuid(),
          sequence: session.attempts.length + 1,
          measurementContextVersion: 2,
          // Ein fehlgeschlagener Versuch hat kein Ergebnis und damit kein
          // Verdikt. Hier `strict` einzutragen waere geraten, nicht beobachtet.
          ...(link.step === undefined ? {} : { clientStep: link.step }),
          observationFingerprint,
          queryFingerprint: journeyQueryFingerprint(fingerprintKey, this.deps.workspaceId, query),
          ...(session.retainText ? { queryText: query } : {}),
          rankerVersion: RANKER_VERSION,
          observedAt,
          status: "failed",
          failureCode,
          ...(session.retainText ? { failureReason } : {}),
          warningCodes: [],
          retrievalHealthy: false,
          profiles: [],
        };
        session.attempts.push(attempt);
        sortAttempts(session.attempts);
        session.updatedAt = observedAt;
        return { session, value: attempt };
      },
      options,
      { allowTerminalIdempotentReplay: link.step !== undefined },
    ).then(({ session, value }) => ({ session, attempt: value }));
  }

  public async observeNavigation(
    sessionId: string,
    input: ObserveSearchJourneyNavigationInput,
    options?: PortCallOptions,
  ): Promise<SearchJourneyV1> {
    const target = input.target === undefined ? undefined : normalizedTarget(input.target);
    const toolName =
      input.toolName === undefined
        ? undefined
        : assertBoundedNonEmpty(input.toolName, "toolName", MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH);
    return this.mutate(
      sessionId,
      (session) => {
        if (session.navigation.length >= MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS) {
          throw new UntangleError(
            "SEARCH_SESSION_INVALID_STATE",
            `search journey reached its limit of ${String(MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS)} navigation events`,
            { operation: "search_journey_observe", context: { sessionId } },
          );
        }
        const observedAt = this.deps.clock.nowIso();
        const event: SearchJourneyNavigationEventV1 = {
          eventId: this.deps.random.uuid(),
          sequence: session.navigation.length + 1,
          kind: input.kind,
          observedAt,
          ...(toolName === undefined ? {} : { toolName }),
          ...(target === undefined ? {} : { target }),
        };
        session.navigation.push(event);
        session.updatedAt = observedAt;
        return { session, value: undefined };
      },
      options,
    ).then(({ session }) => session);
  }

  public async complete(
    sessionId: string,
    input: CompleteSearchJourneyInput,
    options?: PortCallOptions,
  ): Promise<SearchJourneyV1> {
    const target = normalizedTarget(input.target);
    const acceptedAttemptId =
      input.acceptedAttemptId === undefined
        ? undefined
        : assertBoundedNonEmpty(
            input.acceptedAttemptId,
            "acceptedAttemptId",
            MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
          );
    return this.mutate(
      sessionId,
      (session) => {
        const completedAt = this.deps.clock.nowIso();
        const assessment = assessSearchJourney(session, {
          target,
          ...(acceptedAttemptId === undefined ? {} : { acceptedAttemptId }),
        });
        session.status = "completed";
        session.updatedAt = completedAt;
        session.outcome = {
          kind: "completed",
          completedAt,
          target,
          ...(acceptedAttemptId === undefined ? {} : { acceptedAttemptId }),
          assessment,
        };
        return { session, value: undefined };
      },
      options,
    ).then(({ session }) => session);
  }

  public async abandon(
    sessionId: string,
    input: AbandonSearchJourneyInput = {},
    options?: PortCallOptions,
  ): Promise<SearchJourneyV1> {
    const reason =
      input.reason === undefined
        ? undefined
        : assertBoundedNonEmpty(input.reason, "reason", MAX_SEARCH_JOURNEY_REASON_LENGTH);
    return this.mutate(
      sessionId,
      (session) => {
        const abandonedAt = this.deps.clock.nowIso();
        session.status = "abandoned";
        session.updatedAt = abandonedAt;
        session.outcome = {
          kind: "abandoned",
          abandonedAt,
          ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
          ...(session.retainText && reason !== undefined ? { reason } : {}),
        };
        return { session, value: undefined };
      },
      options,
    ).then(({ session }) => session);
  }

  public async report(options?: PortCallOptions): Promise<DynamicProductComplexityReportV1> {
    const sessions = await this.deps.store.list(this.deps.workspaceId, options);
    return buildDynamicProductComplexityReport(
      this.deps.workspaceId,
      sessions,
      this.deps.clock.nowIso(),
    );
  }

  private validatedFingerprintKey(key: Uint8Array): Uint8Array {
    if (key.byteLength < 32) {
      throw new Error("search journey fingerprint key must contain at least 32 bytes");
    }
    return key.slice();
  }

  private async getFingerprintKey(options?: PortCallOptions): Promise<Uint8Array> {
    if (this.fingerprintKey !== undefined) return this.fingerprintKey;
    const provider = this.deps.fingerprintKeyProvider;
    if (provider === undefined) throw new Error("search journey fingerprint key is unavailable");
    const loaded = this.validatedFingerprintKey(await provider(options));
    this.fingerprintKey = loaded;
    return loaded;
  }

  private async mutate<T>(
    sessionId: string,
    reducer: (session: SearchJourneyV1) => {
      session: SearchJourneyV1;
      value: T;
      changed?: boolean;
    },
    options?: PortCallOptions,
    mutationOptions: { allowTerminalIdempotentReplay?: boolean } = {},
  ): Promise<{ session: SearchJourneyV1; value: T }> {
    const id = assertNonEmpty(sessionId, "sessionId");
    let resolved: { session: SearchJourneyV1; value: T } | undefined;
    const previous = this.pendingMutations.get(id) ?? Promise.resolve();
    // Ein fehlgeschlagener parallel vorausgehender Mutator darf die lokale
    // Serialisierung nicht dauerhaft vergiften. Jeder Aufruf liest seinen
    // eigenen frischen CAS-Stand und gibt seinen eigenen Fehler weiter.
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          options?.signal?.throwIfAborted();
          const loaded = await this.deps.store.get(id, options);
          if (loaded === null || loaded.workspaceId !== this.deps.workspaceId) {
            throw new UntangleError(
              "SEARCH_SESSION_NOT_FOUND",
              `search journey "${id}" was not found in this workspace`,
              { operation: "search_journey_mutate", context: { sessionId: id } },
            );
          }
          if (
            loaded.status !== "active" &&
            mutationOptions.allowTerminalIdempotentReplay !== true
          ) {
            throw new UntangleError(
              "SEARCH_SESSION_INVALID_STATE",
              `search journey "${id}" is ${loaded.status} and cannot be changed`,
              {
                operation: "search_journey_mutate",
                context: { sessionId: id, status: loaded.status },
              },
            );
          }
          const next = reducer(cloneSession(loaded));
          if (next.changed === false) {
            resolved = { session: cloneSession(loaded), value: next.value };
            return;
          }
          if (loaded.status !== "active") {
            throw new UntangleError(
              "SEARCH_SESSION_INVALID_STATE",
              `search journey "${id}" is ${loaded.status} and cannot be changed`,
              {
                operation: "search_journey_mutate",
                context: { sessionId: id, status: loaded.status },
              },
            );
          }
          next.session.revision = loaded.revision + 1;
          assertValidSessionState(next.session);
          try {
            await this.deps.store.put(next.session, {
              ...options,
              expectedRevision: loaded.revision,
            });
            resolved = { session: cloneSession(next.session), value: next.value };
            return;
          } catch (error) {
            if (
              !isUntangleError(error) ||
              error.code !== "SEARCH_SESSION_CONFLICT" ||
              attempt === 3
            ) {
              throw error;
            }
          }
        }
      });
    this.pendingMutations.set(id, current);
    try {
      await current;
      return resolved as { session: SearchJourneyV1; value: T };
    } finally {
      if (this.pendingMutations.get(id) === current) this.pendingMutations.delete(id);
    }
  }
}
