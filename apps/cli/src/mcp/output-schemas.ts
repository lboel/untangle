import {
  MINIMUM_PRODUCT_COMPLEXITY_SESSIONS,
  SEARCH_JOURNEY_ABANDON_REASON_CODES,
  SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS,
  SEARCH_JOURNEY_TARGET_CODE_COMPLEXITY_UNAVAILABLE_REASONS,
  canonicalJson,
  searchJourneyValidationIssue,
} from "@untangle-code/domain";
import * as z from "zod/v4";

import { frontendBoundaryReportSchema } from "./boundaries-schema.js";
import type { UntangleMcpToolName } from "./types.js";

const text = z.string();
const isoTimestamp = text.refine((value) => Number.isFinite(Date.parse(value)), {
  message: "Expected an ISO timestamp",
});
// Validate semantic content without transforming wire values. In particular,
// raw import specifiers may intentionally carry leading/trailing whitespace
// and must round-trip byte-for-byte through the MCP response boundary.
const nonEmpty = text.refine((value) => value.trim().length > 0, {
  message: "Expected a non-empty string",
});
const finite = z.number().finite();
const nonNegative = finite.nonnegative();
const ratio = finite.min(0).max(1);
const integer = z.number().int();
const nonNegativeInt = integer.nonnegative();
const positiveInt = integer.positive();
const sha256Fingerprint = text.regex(/^[0-9a-f]{64}$/u);
const stringArray = z.array(text);
const stringMap = z.record(z.string(), text);
const optionalStringMap = z.record(z.string(), text.nullable());
const numberMap = z.record(z.string(), finite);
const jsonMap = z.record(z.string(), z.json());

const sourceRangeSchema = z
  .object({
    startLine: positiveInt,
    endLine: positiveInt,
    startByte: nonNegativeInt,
    endByte: nonNegativeInt,
  })
  .strict();

const skipLedgerEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.enum([
      "scan",
      "parse",
      "chunk",
      "embed",
      "store",
      "file_graph",
      "symbol_graph",
      "search",
      "findability",
      "extension",
    ]),
    subjectKind: z.enum([
      "file",
      "range",
      "symbol",
      "chunk",
      "file_edge",
      "symbol_edge",
      "search_candidate",
      "artifact",
      "extension",
    ]),
    subjectId: text.optional(),
    path: text.optional(),
    range: sourceRangeSchema.optional(),
    repoId: text.optional(),
    refId: text.optional(),
    reason: z.enum([
      "unsupported_language",
      "parse_failed",
      "file_too_large",
      "binary_content",
      "excluded_by_configuration",
      "token_budget_exceeded",
      "time_budget_exceeded",
      "resolution_failed",
      "ambiguous_resolution",
      "missing_index_entry",
      "provider_unavailable",
      "extension_unavailable",
      "duplicate",
      "no_metric_defined",
      "generated_content",
      "relevance_policy_rejected",
    ]),
    detail: nonEmpty,
    recoverable: z.boolean(),
  })
  .strict();

const indexCountsSchema = z
  .object({
    filesSeen: nonNegativeInt,
    filesPlanned: nonNegativeInt,
    filesUnchanged: nonNegativeInt,
    filesIgnored: nonNegativeInt,
    filesAnalyzed: nonNegativeInt,
    filesRemoved: nonNegativeInt,
    chunks: nonNegativeInt,
    symbols: nonNegativeInt,
    points: nonNegativeInt,
    embeddingCacheHits: nonNegativeInt,
    embeddingsComputed: nonNegativeInt,
    parseCacheHits: nonNegativeInt,
    parseCacheMisses: nonNegativeInt,
    chunkCacheHits: nonNegativeInt,
    chunkCacheMisses: nonNegativeInt,
    metricsCacheHits: nonNegativeInt,
    metricsCacheMisses: nonNegativeInt,
    truncated: nonNegativeInt,
    fileGraphNodes: nonNegativeInt,
    fileGraphEdges: nonNegativeInt,
    symbolGraphNodes: nonNegativeInt,
    symbolGraphEdges: nonNegativeInt,
  })
  .strict();

const indexReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: nonEmpty,
    generationId: text.nullable(),
    workspaceId: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    embeddingProfileId: nonEmpty,
    collection: nonEmpty,
    outcome: z.enum(["completed", "failed", "cancelled"]),
    counts: indexCountsSchema,
    failure: z
      .object({ code: nonEmpty, message: nonEmpty, retryable: z.boolean() })
      .strict()
      .optional(),
    skipped: z.array(skipLedgerEntrySchema),
    skippedByReason: z.record(z.string(), nonNegativeInt),
    skippedByStage: z.record(z.string(), nonNegativeInt),
    skippedTruncated: nonNegativeInt,
  })
  .strict();

const jobStatusSchema = z
  .object({
    jobId: nonEmpty,
    operation: nonEmpty,
    status: z.enum([
      "queued",
      "preparing_infrastructure",
      "discovering_files",
      "parsing_and_chunking",
      "computing_metrics",
      "embedding",
      "storing",
      "checkpointing",
      "building_graphs",
      "indexing_context",
      "finalizing",
      "completed",
      "failed",
      "cancel_requested",
      "cancelled",
    ]),
    workspaceId: nonEmpty,
    generationId: text.optional(),
    updatedAt: text.optional(),
  })
  .strict();

const checkResultSchema = z
  .object({
    id: nonEmpty,
    title: nonEmpty,
    status: z.enum(["ok", "warn", "fail"]),
    detail: nonEmpty,
    nextStep: nonEmpty.optional(),
    facts: z.record(z.string(), z.union([text, finite, z.boolean()])).optional(),
  })
  .strict();

const repositoryConfigSchema = z
  .object({
    id: nonEmpty,
    path: nonEmpty,
    label: text.optional(),
    ref: text.optional(),
    include: stringArray.optional(),
    exclude: stringArray.optional(),
    packageAliases: stringMap.optional(),
    metadata: stringMap.optional(),
  })
  .strict();

const contextArtifactSchema = z
  .object({
    name: nonEmpty,
    path: nonEmpty,
    description: text,
    type: z
      .enum([
        "auto",
        "sql",
        "openapi",
        "asyncapi",
        "protobuf",
        "markdown",
        "terraform",
        "kubernetes",
        "text",
      ])
      .optional(),
    include: stringArray.optional(),
    exclude: stringArray.optional(),
  })
  .strict();

const warningDataSchema = z
  .object({
    code: nonEmpty,
    message: nonEmpty,
    details: jsonMap.optional(),
  })
  .strict();

const scoreComponentSchema = z
  .object({
    kind: z.enum([
      "base_hybrid",
      "exact_symbol_boost",
      "exact_path_boost",
      "repo_priority_boost",
      "graph_proximity_boost",
      "recency_boost",
      "duplicate_penalty",
      "complexity_modifier",
    ]),
    rawValue: finite,
    weight: finite,
    contribution: finite,
    evidence: text.optional(),
  })
  .strict();

const scoreBreakdownSchema = z
  .object({
    schemaVersion: z.literal(1),
    final: finite,
    components: z.array(scoreComponentSchema),
    inputs: z
      .object({
        dense: finite.optional(),
        sparseRank: positiveInt.optional(),
        rrf: finite.optional(),
        denseRank: positiveInt.optional(),
        lexicalScore: finite.optional(),
        lexicalRank: positiveInt.optional(),
        symbolRank: positiveInt.optional(),
      })
      .strict(),
    rankerVersion: nonEmpty,
    clamped: z.boolean(),
    clampReason: text.optional(),
  })
  .strict();

const complexitySummarySchema = z
  .object({
    metricsScope: z.enum(["symbol", "file", "chunk"]),
    metricsScopeId: nonEmpty,
    metricsVersion: nonEmpty,
    cyclomaticClassic: nonNegativeInt.optional(),
    cyclomaticExtended: nonNegativeInt.optional(),
    cognitive: nonNegativeInt.optional(),
    maxNesting: nonNegativeInt.optional(),
    sloc: nonNegativeInt.optional(),
    halsteadVolume: nonNegative.optional(),
    maintainabilityIndex: finite.min(0).max(100).optional(),
    riskScore: nonNegative.optional(),
  })
  .strict()
  .refine(
    (summary) =>
      summary.cyclomaticClassic !== undefined ||
      summary.cyclomaticExtended !== undefined ||
      summary.cognitive !== undefined ||
      summary.maxNesting !== undefined ||
      summary.sloc !== undefined ||
      summary.halsteadVolume !== undefined ||
      summary.maintainabilityIndex !== undefined ||
      summary.riskScore !== undefined,
    { message: "complexity summary requires at least one metric" },
  );

const graphRelationSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.enum(["file_graph", "symbol_graph"]),
    edgeId: nonEmpty,
    direction: z.enum(["incoming", "outgoing"]),
    edgeKind: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    fileId: nonEmpty,
    path: text,
    crossRepository: z.boolean(),
    symbol: z
      .object({ id: nonEmpty, name: text, qualifiedName: text, kind: text })
      .strict()
      .optional(),
  })
  .strict();

const graphRelationsSchema = z
  .object({
    schemaVersion: z.literal(1),
    relations: z.array(graphRelationSchema),
    relationLimit: nonNegativeInt,
    truncated: z.boolean(),
    omittedCount: nonNegativeInt,
    omissions: z.array(
      z
        .object({
          reason: z.enum([
            "graph_unavailable",
            "graph_partial",
            "source_not_in_graph",
            "symbol_id_missing",
            "unresolved_endpoint",
            "heuristic_endpoint",
            "ambiguous_endpoint",
            "endpoint_missing",
            "provider_result_missing",
            "relation_limit",
          ]),
          count: nonNegativeInt,
          detail: nonEmpty,
        })
        .strict(),
    ),
  })
  .strict();

const relatedFragmentSchema = z
  .object({
    chunkId: nonEmpty,
    chunkKind: nonEmpty,
    fragmentIndex: nonNegativeInt.optional(),
    startLine: positiveInt,
    endLine: positiveInt,
    score: finite,
  })
  .strict();

const findabilitySummarySchema = z
  .object({
    score: ratio,
    isHeuristic: z.literal(true),
    algorithm: nonEmpty,
    primaryCause: z
      .enum(["scattered-responsibility", "weak-naming", "high-entanglement", "undocumented"])
      .optional(),
    primaryCauseConfidence: ratio.optional(),
  })
  .strict();

const searchHitSchema = z
  .object({
    schemaVersion: z.literal(1),
    rank: positiveInt,
    repoId: nonEmpty,
    repoLabel: text,
    refId: nonEmpty,
    refName: text,
    commitSha: text.optional(),
    fileId: nonEmpty,
    filePath: text,
    range: sourceRangeSchema,
    language: nonEmpty,
    parseQuality: z.enum(["complete", "partial", "failed"]),
    chunkId: nonEmpty,
    chunkKind: nonEmpty,
    fragmentIndex: nonNegativeInt.optional(),
    fragmentCount: positiveInt.optional(),
    symbolId: text.optional(),
    symbolName: text.optional(),
    symbolFqn: text.optional(),
    symbolKind: text.optional(),
    signature: text.optional(),
    score: scoreBreakdownSchema,
    dedupeKey: nonEmpty,
    relatedFragments: z.array(relatedFragmentSchema),
    embeddingProfileId: nonEmpty,
    indexGeneration: nonEmpty,
    complexity: complexitySummarySchema.optional(),
    findability: findabilitySummarySchema.optional(),
    content: text.optional(),
    contentOmittedReason: text.optional(),
    graphContext: graphRelationsSchema.optional(),
    linkedSymbols: graphRelationsSchema.optional(),
    incompletePayloadFields: stringArray.optional(),
  })
  .strict();

const searchQuerySchema = z
  .object({
    schemaVersion: z.literal(1),
    text: nonEmpty,
    workspaceId: nonEmpty,
    filters: z
      .object({
        repoIds: stringArray,
        refIds: stringArray,
        commitSha: text.optional(),
        languages: stringArray,
        pathGlobs: stringArray,
        symbolNames: stringArray,
        symbolKinds: stringArray,
        chunkKinds: stringArray,
        complexity: z
          .object({
            cyclomaticMin: finite.optional(),
            cyclomaticMax: finite.optional(),
            cognitiveMin: finite.optional(),
            cognitiveMax: finite.optional(),
            riskMin: finite.optional(),
            riskMax: finite.optional(),
          })
          .strict()
          .optional(),
        findability: z
          .object({
            maxScore: finite.optional(),
            minScore: finite.optional(),
            causes: z
              .array(
                z.enum([
                  "scattered-responsibility",
                  "weak-naming",
                  "high-entanglement",
                  "undocumented",
                ]),
              )
              .optional(),
          })
          .strict()
          .optional(),
        changed: z.object({ since: nonEmpty, until: nonEmpty.optional() }).strict().optional(),
      })
      .strict(),
    limit: positiveInt,
    candidateLimit: positiveInt,
    minScore: finite.optional(),
    diversify: z.boolean(),
    includeGraphContext: z.boolean(),
    includeLinked: z.boolean(),
    includeContent: z.boolean(),
    rankerVersion: nonEmpty,
  })
  .strict();

const searchResultSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    queryFingerprint: nonEmpty,
    indexFreshness: z
      .object({
        status: z.enum(["fresh", "stale", "unknown", "incompatible"]),
        checkedAt: isoTimestamp,
        repositories: z.array(
          z
            .object({
              repoId: nonEmpty,
              refId: nonEmpty,
              status: z.enum(["fresh", "stale", "unknown", "incompatible"]),
              reason: nonEmpty,
              filesChecked: nonNegativeInt,
              indexedAt: isoTimestamp.optional(),
              indexedCorpusFingerprint: sha256Fingerprint.optional(),
              currentCorpusFingerprint: sha256Fingerprint.optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    rankingContextFingerprint: nonEmpty.optional(),
    query: searchQuerySchema,
    groups: z.array(
      z
        .object({
          embeddingProfileId: nonEmpty,
          indexGenerations: z.array(nonEmpty).optional(),
          corpusRevisionFingerprint: sha256Fingerprint.optional(),
          repoIds: stringArray,
          hits: z.array(searchHitSchema),
          rankNormalized: z.boolean(),
          caveats: stringArray,
          notSearchedReason: text.optional(),
          relevanceDecision: z
            .object({
              abstention: z.enum(["strict", "evidence"]),
              status: z.enum(["accepted", "rejected", "not_evaluated"]),
              basis: nonEmpty,
              calibrationId: nonEmpty.optional(),
            })
            .strict()
            .optional(),
          retrieval: z
            .object({
              branchCandidateCounts: z
                .object({
                  dense: nonNegativeInt,
                  sparse: nonNegativeInt,
                  symbol: nonNegativeInt,
                })
                .strict(),
              uniqueRetrievedCandidateCount: nonNegativeInt,
              eligibleCandidateCount: nonNegativeInt,
              rankedCandidateCount: nonNegativeInt,
              deduplicatedCandidateCount: nonNegativeInt,
              qualifiedHitCount: nonNegativeInt,
              returnedHitCount: nonNegativeInt,
              uniqueEligibleFileCount: nonNegativeInt,
              uniqueEligibleSymbolCount: nonNegativeInt,
              eligibleFileDispersion: ratio,
              topScoreGap: finite.nullable(),
              candidateLimitReached: z.boolean(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    profileSeparation: z.boolean(),
    totalHits: nonNegativeInt,
    skipped: z.array(skipLedgerEntrySchema),
    warnings: z.array(warningDataSchema),
    timings: z
      .object({
        queryEmbeddingMs: nonNegative.optional(),
        vectorSearchMs: nonNegative.optional(),
        totalMs: nonNegative.optional(),
      })
      .strict()
      .optional(),
    searchObservation: z
      .discriminatedUnion("status", [
        z
          .object({
            sessionId: nonEmpty,
            attemptId: nonEmpty,
            status: z.literal("recorded"),
          })
          .strict(),
        z
          .object({
            sessionId: nonEmpty,
            status: z.literal("not_recorded"),
            warningCode: nonEmpty,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

const searchJourneyTargetSchema = z
  .object({
    repoId: nonEmpty.optional(),
    refId: nonEmpty.optional(),
    filePath: nonEmpty.optional(),
    chunkId: nonEmpty.optional(),
    symbolId: nonEmpty.optional(),
    embeddingProfileId: nonEmpty.optional(),
    indexGeneration: nonEmpty.optional(),
  })
  .strict()
  .refine(
    (target) =>
      target.filePath !== undefined ||
      target.chunkId !== undefined ||
      target.symbolId !== undefined,
    {
      message: "search journey target requires filePath, chunkId or symbolId",
    },
  );

const searchJourneyCandidateSchema = z
  .object({
    repoId: nonEmpty,
    refId: nonEmpty,
    filePath: text,
    chunkId: nonEmpty,
    symbolId: nonEmpty.optional(),
    symbolFqn: text.optional(),
    embeddingProfileId: nonEmpty,
    indexGeneration: nonEmpty,
    rank: positiveInt,
    score: finite,
    complexity: complexitySummarySchema.optional(),
    incompletePayloadFields: stringArray.optional(),
  })
  .strict();

const searchJourneyTargetCodeCandidateSchema = z
  .object({
    repoId: nonEmpty,
    refId: nonEmpty,
    filePath: text,
    chunkId: nonEmpty,
    symbolId: nonEmpty.optional(),
    symbolFqn: text.optional(),
    embeddingProfileId: nonEmpty,
    indexGeneration: nonEmpty,
  })
  .strict();

const searchJourneyTargetCodeComplexitySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("observed"),
      source: z.literal("indexed-search-hit"),
      candidate: searchJourneyTargetCodeCandidateSchema,
      complexity: complexitySummarySchema,
      payloadComplete: z.boolean(),
      incompletePayloadFields: stringArray,
    })
    .strict()
    .superRefine((evidence, context) => {
      if (evidence.payloadComplete !== (evidence.incompletePayloadFields.length === 0)) {
        context.addIssue({
          code: "custom",
          path: ["payloadComplete"],
          message: "payload completeness must match incompletePayloadFields",
        });
      }
      if (
        new Set(evidence.incompletePayloadFields).size !== evidence.incompletePayloadFields.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["incompletePayloadFields"],
          message: "incomplete payload fields must be unique",
        });
      }
    }),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum(SEARCH_JOURNEY_TARGET_CODE_COMPLEXITY_UNAVAILABLE_REASONS),
    })
    .strict(),
]);

const searchRetrievalDiagnosticsSchema = z
  .object({
    branchCandidateCounts: z
      .object({ dense: nonNegativeInt, sparse: nonNegativeInt, symbol: nonNegativeInt })
      .strict(),
    uniqueRetrievedCandidateCount: nonNegativeInt,
    eligibleCandidateCount: nonNegativeInt,
    rankedCandidateCount: nonNegativeInt,
    deduplicatedCandidateCount: nonNegativeInt,
    qualifiedHitCount: nonNegativeInt,
    returnedHitCount: nonNegativeInt,
    uniqueEligibleFileCount: nonNegativeInt,
    uniqueEligibleSymbolCount: nonNegativeInt,
    eligibleFileDispersion: ratio,
    topScoreGap: finite.nullable(),
    candidateLimitReached: z.boolean(),
  })
  .strict();

const searchJourneyAttemptSchema = z
  .object({
    attemptId: nonEmpty,
    sequence: positiveInt,
    clientStep: positiveInt.optional(),
    observationFingerprint: nonEmpty,
    measurementContextVersion: z.literal(2).optional(),
    abstention: z.enum(["strict", "evidence"]).optional(),
    queryFingerprint: nonEmpty,
    queryText: text.optional(),
    rankerVersion: nonEmpty,
    rankingContextFingerprint: nonEmpty.optional(),
    resultLimit: positiveInt.optional(),
    candidateLimit: positiveInt.optional(),
    observedAt: nonEmpty,
    status: z.enum(["succeeded", "failed"]),
    failureCode: nonEmpty.optional(),
    failureReason: text.optional(),
    warningCodes: stringArray,
    retrievalHealthy: z.boolean(),
    profiles: z.array(
      z
        .object({
          embeddingProfileId: nonEmpty,
          indexGenerations: stringArray,
          corpusRevisionFingerprint: sha256Fingerprint.optional(),
          retrievalPerformed: z.boolean(),
          notSearchedReason: text.optional(),
          retrieval: searchRetrievalDiagnosticsSchema.optional(),
          candidates: z.array(searchJourneyCandidateSchema),
        })
        .strict(),
    ),
  })
  .strict();

const dynamicSearchComplexitySchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("untangle-dynamic-search-complexity-v1"),
    isHeuristic: z.literal(true),
    searchesToTarget: positiveInt,
    successfulSearchesToTarget: nonNegativeInt,
    failedSearchesToTarget: nonNegativeInt,
    distinctQueryCount: positiveInt,
    queryReformulations: nonNegativeInt,
    acceptedTargetRank: positiveInt.nullable(),
    reciprocalRank: ratio.nullable(),
    targetWasReturned: z.boolean(),
    targetFirstReturnedAtSearch: positiveInt.nullable(),
    targetAcceptedAtSearch: positiveInt.nullable(),
    selectionLagSearches: nonNegativeInt.nullable(),
    directHit: z.boolean(),
    eligibleCandidatesExamined: nonNegativeInt,
    uniqueCandidatesExposed: nonNegativeInt,
    uniqueFilesExposed: nonNegativeInt,
    navigationEventsToTarget: nonNegativeInt,
    observedToolAndFileHops: positiveInt,
    meanCandidateFileDispersion: ratio.nullable(),
    meanCandidateChurn: ratio.nullable(),
    candidateLimitHitRate: ratio,
    healthyRetrievalRate: ratio,
    acceptedTargetScoreMargin: finite.nullable(),
    acceptedTargetCodeComplexity: searchJourneyTargetCodeComplexitySchema.optional(),
    measurementContextId: nonEmpty,
    measurementContextComplete: z.boolean(),
    caveats: stringArray,
  })
  .strict();

const journeyExecutionValueSchema = z
  .object({ fingerprint: sha256Fingerprint, text: text.optional() })
  .strict();
const journeyExecutionContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("caller-declared"),
    agentModel: journeyExecutionValueSchema,
    harness: journeyExecutionValueSchema,
    searchStrategy: journeyExecutionValueSchema,
    taskClass: journeyExecutionValueSchema,
    taskMix: journeyExecutionValueSchema.optional(),
    priorContext: journeyExecutionValueSchema.optional(),
  })
  .strict();
const journeyExecutionEvidenceSchema = z
  .object({
    status: z.enum(["caller-declared", "not-recorded"]),
    fingerprint: sha256Fingerprint.optional(),
    uncontrolledDimensions: z.array(z.enum(SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS)),
  })
  .strict()
  .superRefine((evidence, context) => {
    if ((evidence.status === "caller-declared") !== (evidence.fingerprint !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "caller-declared conditions require a fingerprint",
      });
    }
    if (new Set(evidence.uncontrolledDimensions).size !== evidence.uncontrolledDimensions.length) {
      context.addIssue({ code: "custom", message: "uncontrolled dimensions must be unique" });
    }
    const allowedMissing =
      evidence.status === "not-recorded"
        ? SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS
        : ["taskMix", "priorContext"];
    if (
      evidence.uncontrolledDimensions.some((dimension) => !allowedMissing.includes(dimension)) ||
      (evidence.status === "not-recorded" &&
        evidence.uncontrolledDimensions.length !==
          SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.length)
    ) {
      context.addIssue({
        code: "custom",
        message: "missing execution dimensions must agree with declaration status",
      });
    }
  });

const searchJourneySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: nonNegativeInt,
    sessionId: nonEmpty,
    workspaceId: nonEmpty,
    status: z.enum(["active", "completed", "abandoned"]),
    recordingConsent: z.literal("explicit"),
    retainText: z.boolean(),
    goal: z.object({ fingerprint: nonEmpty, text: text.optional() }).strict(),
    feature: z
      .object({ fingerprint: sha256Fingerprint, text: text.optional() })
      .strict()
      .optional(),
    executionContext: journeyExecutionContextSchema.optional(),
    createdAt: nonEmpty,
    updatedAt: nonEmpty,
    attempts: z.array(searchJourneyAttemptSchema),
    navigation: z.array(
      z
        .object({
          eventId: nonEmpty,
          sequence: positiveInt,
          kind: z.enum(["open-file", "open-symbol", "graph-query", "other-tool"]),
          observedAt: nonEmpty,
          toolName: nonEmpty.optional(),
          target: searchJourneyTargetSchema.optional(),
        })
        .strict(),
    ),
    outcome: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("completed"),
            completedAt: nonEmpty,
            target: searchJourneyTargetSchema,
            acceptedAttemptId: nonEmpty.optional(),
            assessment: dynamicSearchComplexitySchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("abandoned"),
            abandonedAt: nonEmpty,
            reasonCode: z.enum(SEARCH_JOURNEY_ABANDON_REASON_CODES).optional(),
            reason: text.optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .superRefine((session, context) => {
    const validationIssue = searchJourneyValidationIssue(session);
    if (validationIssue !== null) {
      context.addIssue({
        code: "custom",
        message: `invalid search journey: ${validationIssue}`,
      });
    }
    const terminalKind = session.outcome?.kind;
    if (
      (session.status === "active" && terminalKind !== undefined) ||
      (session.status === "completed" && terminalKind !== "completed") ||
      (session.status === "abandoned" && terminalKind !== "abandoned")
    ) {
      context.addIssue({
        code: "custom",
        message: "search journey status and outcome are inconsistent",
      });
    }
    if (
      !session.retainText &&
      (session.goal.text !== undefined ||
        session.attempts.some(
          (attempt) => attempt.queryText !== undefined || attempt.failureReason !== undefined,
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "redacted search journey contains retained text",
      });
    }
    if (session.attempts.some((attempt, index) => attempt.sequence !== index + 1)) {
      context.addIssue({ code: "custom", message: "search journey attempts are not ordered" });
    }
    const numbered = session.attempts.filter((attempt) => attempt.clientStep !== undefined);
    if (numbered.length !== 0 && numbered.length !== session.attempts.length) {
      context.addIssue({
        code: "custom",
        message: "search journey mixes numbered and unnumbered attempts",
      });
    }
  });

const dynamicProductComplexityCohortSchema = z
  .object({
    measurementContextId: sha256Fingerprint,
    completedSessionCount: positiveInt,
    measurementContextComplete: z.boolean(),
    sufficientEvidence: z.boolean(),
    minimumCompletedSessions: z.literal(MINIMUM_PRODUCT_COMPLEXITY_SESSIONS),
    executionContext: journeyExecutionEvidenceSchema.optional(),
    callerConditionsControlled: z.boolean().optional(),
    medianSearchesToTarget: finite.positive(),
    p90SearchesToTarget: finite.positive(),
    medianQueryReformulations: nonNegative,
    medianAcceptedTargetRank: finite.positive().nullable(),
    meanReciprocalRank: ratio.nullable(),
    targetReturnedRate: ratio,
    directHitRate: ratio,
    healthyRetrievalRate: ratio,
    medianEligibleCandidatesExamined: nonNegative,
    medianUniqueFilesExposed: nonNegative,
    meanCandidateFileDispersion: ratio.nullable(),
    meanCandidateChurn: ratio.nullable(),
    candidateLimitHitRate: ratio,
    caveats: stringArray,
  })
  .strict()
  .superRefine((cohort, context) => {
    if (
      cohort.callerConditionsControlled !== undefined &&
      cohort.callerConditionsControlled !==
        (cohort.executionContext?.status === "caller-declared" &&
          cohort.executionContext.uncontrolledDimensions.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "caller conditions require all declared dimensions",
      });
    }
    const expectedSufficient =
      cohort.measurementContextComplete &&
      cohort.completedSessionCount >= cohort.minimumCompletedSessions;
    if (cohort.sufficientEvidence !== expectedSufficient) {
      context.addIssue({
        code: "custom",
        path: ["sufficientEvidence"],
        message: "sufficient evidence requires a complete context and the minimum cohort size",
      });
    }
    if (cohort.p90SearchesToTarget < cohort.medianSearchesToTarget) {
      context.addIssue({
        code: "custom",
        path: ["p90SearchesToTarget"],
        message: "p90 searches must not be below the median",
      });
    }
    if (cohort.measurementContextComplete && cohort.healthyRetrievalRate !== 1) {
      context.addIssue({
        code: "custom",
        path: ["healthyRetrievalRate"],
        message: "a complete measurement context requires fully healthy retrieval",
      });
    }
    if (cohort.directHitRate > cohort.targetReturnedRate) {
      context.addIssue({
        code: "custom",
        path: ["directHitRate"],
        message: "the direct-hit rate cannot exceed the target-returned rate",
      });
    }
  });

const featureCodeComplexityVariantSchema = z
  .object({
    evidence: searchJourneyTargetCodeComplexitySchema,
    completedSessionCount: positiveInt,
  })
  .strict();

const featureCodeTargetMappingSchema = z
  .object({
    target: searchJourneyTargetSchema,
    completedSessionCount: positiveInt,
    complexityVariants: z.array(featureCodeComplexityVariantSchema).min(1),
  })
  .strict()
  .superRefine((mapping, context) => {
    const variantKeys = mapping.complexityVariants.map((variant) =>
      canonicalJson(variant.evidence),
    );
    if (new Set(variantKeys).size !== variantKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["complexityVariants"],
        message: "complexity evidence variants must be unique",
      });
    }
    for (const [index, variant] of mapping.complexityVariants.entries()) {
      if (variant.evidence.status !== "observed") continue;
      const candidate = variant.evidence.candidate;
      const target = mapping.target;
      const matches =
        (target.repoId === undefined || target.repoId === candidate.repoId) &&
        (target.refId === undefined || target.refId === candidate.refId) &&
        (target.filePath === undefined || target.filePath === candidate.filePath) &&
        (target.chunkId === undefined || target.chunkId === candidate.chunkId) &&
        (target.symbolId === undefined || target.symbolId === candidate.symbolId) &&
        (target.embeddingProfileId === undefined ||
          target.embeddingProfileId === candidate.embeddingProfileId) &&
        (target.indexGeneration === undefined ||
          target.indexGeneration === candidate.indexGeneration);
      if (!matches) {
        context.addIssue({
          code: "custom",
          path: ["complexityVariants", index, "evidence", "candidate"],
          message: "observed complexity candidate must match the confirmed target locator",
        });
      }
    }
    const variantSessions = mapping.complexityVariants.reduce(
      (sum, variant) => sum + variant.completedSessionCount,
      0,
    );
    if (variantSessions !== mapping.completedSessionCount) {
      context.addIssue({
        code: "custom",
        path: ["complexityVariants"],
        message: "complexity variants must account for every completed target session",
      });
    }
  });

const dynamicProductComplexityFeatureMappingSchema = z
  .object({
    featureFingerprint: sha256Fingerprint,
    measurementContextId: sha256Fingerprint,
    distinctGoalCount: positiveInt,
    search: dynamicProductComplexityCohortSchema,
    code: z
      .object({
        confirmedTargetCount: positiveInt,
        observedComplexitySessionCount: nonNegativeInt,
        unavailableComplexitySessionCount: nonNegativeInt,
        targets: z.array(featureCodeTargetMappingSchema).min(1),
      })
      .strict(),
    caveats: stringArray,
  })
  .strict()
  .superRefine((mapping, context) => {
    if (mapping.search.measurementContextId !== mapping.measurementContextId) {
      context.addIssue({
        code: "custom",
        path: ["search", "measurementContextId"],
        message: "feature mapping and search cohort must share a measurement context",
      });
    }
    if (mapping.distinctGoalCount > mapping.search.completedSessionCount) {
      context.addIssue({
        code: "custom",
        path: ["distinctGoalCount"],
        message: "distinct goals cannot exceed completed feature sessions",
      });
    }
    if (mapping.code.confirmedTargetCount !== mapping.code.targets.length) {
      context.addIssue({
        code: "custom",
        path: ["code", "confirmedTargetCount"],
        message: "confirmed target count must equal the target mapping count",
      });
    }
    const targetKeys = mapping.code.targets.map((target) => canonicalJson(target.target));
    if (new Set(targetKeys).size !== targetKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["code", "targets"],
        message: "confirmed feature targets must be unique",
      });
    }
    const targetSessions = mapping.code.targets.reduce(
      (sum, target) => sum + target.completedSessionCount,
      0,
    );
    if (targetSessions !== mapping.search.completedSessionCount) {
      context.addIssue({
        code: "custom",
        path: ["code", "targets"],
        message: "target mappings must account for every completed feature session",
      });
    }
    const observedSessions = mapping.code.targets.reduce(
      (sum, target) =>
        sum +
        target.complexityVariants.reduce(
          (targetSum, variant) =>
            targetSum +
            (variant.evidence.status === "observed" ? variant.completedSessionCount : 0),
          0,
        ),
      0,
    );
    if (
      observedSessions !== mapping.code.observedComplexitySessionCount ||
      targetSessions - observedSessions !== mapping.code.unavailableComplexitySessionCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "observed and unavailable complexity counts must partition feature sessions",
      });
    }
  });

const journeyOutcomeCohortSchema = z
  .object({
    measurementContextId: sha256Fingerprint,
    retrievalContextId: sha256Fingerprint,
    executionContext: journeyExecutionEvidenceSchema,
    featureFingerprint: sha256Fingerprint.optional(),
    distinctGoalCount: positiveInt,
    sessionCounts: z
      .object({
        total: positiveInt,
        active: nonNegativeInt,
        completed: nonNegativeInt,
        abandoned: nonNegativeInt,
        terminal: nonNegativeInt,
      })
      .strict(),
    terminalCompletionRate: ratio.nullable(),
    retrievalContextComplete: z.boolean(),
    statusEffort: z.array(
      z
        .object({
          status: z.enum(["active", "completed", "abandoned"]),
          sessionCount: nonNegativeInt,
          sessionsWithSearches: nonNegativeInt,
          totalSearches: nonNegativeInt,
          failedSearches: nonNegativeInt,
          totalNavigationEvents: nonNegativeInt,
          totalObservedHops: nonNegativeInt,
          medianSearches: nonNegative.nullable(),
        })
        .strict(),
    ),
    abandonmentReasons: z.array(
      z
        .object({
          reasonCode: z.enum([...SEARCH_JOURNEY_ABANDON_REASON_CODES, "not-recorded"]),
          count: positiveInt,
        })
        .strict(),
    ),
    caveats: stringArray,
  })
  .strict()
  .superRefine((cohort, context) => {
    const counts = cohort.sessionCounts;
    if (
      counts.total !== counts.active + counts.completed + counts.abandoned ||
      counts.terminal !== counts.completed + counts.abandoned ||
      cohort.distinctGoalCount > counts.total
    ) {
      context.addIssue({
        code: "custom",
        message: "outcome session counts must partition their cohort",
      });
    }
    const expectedRate = counts.terminal === 0 ? null : counts.completed / counts.terminal;
    if (cohort.terminalCompletionRate !== expectedRate) {
      context.addIssue({
        code: "custom",
        message: "completion rate must use completed plus abandoned sessions",
      });
    }
    if (
      cohort.statusEffort.length !== 3 ||
      new Set(cohort.statusEffort.map((effort) => effort.status)).size !== 3
    ) {
      context.addIssue({
        code: "custom",
        message: "outcome effort must include each session status once",
      });
    }
    for (const effort of cohort.statusEffort) {
      if (
        effort.sessionCount !== counts[effort.status] ||
        effort.sessionsWithSearches > effort.sessionCount ||
        effort.sessionsWithSearches > effort.totalSearches ||
        effort.failedSearches > effort.totalSearches ||
        effort.totalObservedHops !== effort.totalSearches + effort.totalNavigationEvents ||
        (effort.sessionCount === 0) !== (effort.medianSearches === null) ||
        (effort.sessionCount === 0 && effort.totalObservedHops !== 0) ||
        (effort.sessionsWithSearches === 0) !== (effort.totalSearches === 0) ||
        (effort.medianSearches !== null && effort.medianSearches > effort.totalSearches)
      ) {
        context.addIssue({
          code: "custom",
          message: "outcome effort must account for its status sessions and observations",
        });
      }
    }
    if (
      cohort.abandonmentReasons.reduce((sum, reason) => sum + reason.count, 0) !==
        counts.abandoned ||
      new Set(cohort.abandonmentReasons.map((reason) => reason.reasonCode)).size !==
        cohort.abandonmentReasons.length
    ) {
      context.addIssue({
        code: "custom",
        message: "abandonment reasons must partition abandoned sessions",
      });
    }
  });

const dynamicProductComplexityReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("untangle-dynamic-search-complexity-v1"),
    isHeuristic: z.literal(true),
    workspaceId: nonEmpty,
    generatedAt: nonEmpty,
    sessionCounts: z
      .object({
        total: nonNegativeInt,
        active: nonNegativeInt,
        completed: nonNegativeInt,
        featureTaggedCompleted: nonNegativeInt,
        abandoned: nonNegativeInt,
      })
      .strict(),
    cohorts: z.array(dynamicProductComplexityCohortSchema),
    featureMappings: z.array(dynamicProductComplexityFeatureMappingSchema),
    outcomeCohorts: z.array(journeyOutcomeCohortSchema).optional(),
    caveats: stringArray,
  })
  .strict()
  .superRefine((report, context) => {
    const counts = report.sessionCounts;
    if (report.outcomeCohorts !== undefined) {
      const keys = report.outcomeCohorts.map(
        (cohort) => `${cohort.measurementContextId}:${cohort.featureFingerprint ?? ""}`,
      );
      for (const status of ["total", "active", "completed", "abandoned"] as const) {
        if (
          report.outcomeCohorts.reduce((sum, cohort) => sum + cohort.sessionCounts[status], 0) !==
          counts[status]
        ) {
          context.addIssue({
            code: "custom",
            message: "outcome cohorts must partition all recorded sessions",
          });
        }
      }
      if (new Set(keys).size !== keys.length) {
        context.addIssue({
          code: "custom",
          message: "outcome context and feature pairs must be unique",
        });
      }
    }
    if (counts.total !== counts.active + counts.completed + counts.abandoned) {
      context.addIssue({
        code: "custom",
        path: ["sessionCounts", "total"],
        message: "total sessions must equal active, completed and abandoned sessions",
      });
    }
    if (counts.featureTaggedCompleted > counts.completed) {
      context.addIssue({
        code: "custom",
        path: ["sessionCounts", "featureTaggedCompleted"],
        message: "feature-tagged completed sessions cannot exceed completed sessions",
      });
    }
    const contextIds = report.cohorts.map((cohort) => cohort.measurementContextId);
    if (new Set(contextIds).size !== contextIds.length) {
      context.addIssue({
        code: "custom",
        path: ["cohorts"],
        message: "measurement context IDs must be unique",
      });
    }
    const cohortSessions = report.cohorts.reduce(
      (sum, cohort) => sum + cohort.completedSessionCount,
      0,
    );
    if (cohortSessions !== counts.completed) {
      context.addIssue({
        code: "custom",
        path: ["cohorts"],
        message: "every completed session must belong to exactly one cohort",
      });
    }
    const featureKeys = report.featureMappings.map(
      (mapping) => `${mapping.featureFingerprint}\u001f${mapping.measurementContextId}`,
    );
    if (new Set(featureKeys).size !== featureKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["featureMappings"],
        message: "feature and measurement-context pairs must be unique",
      });
    }
    const featureSessions = report.featureMappings.reduce(
      (sum, mapping) => sum + mapping.search.completedSessionCount,
      0,
    );
    if (featureSessions !== counts.featureTaggedCompleted) {
      context.addIssue({
        code: "custom",
        path: ["featureMappings"],
        message: "feature mappings must account for every feature-tagged completed session",
      });
    }
    const knownContexts = new Set(contextIds);
    for (const [index, mapping] of report.featureMappings.entries()) {
      if (!knownContexts.has(mapping.measurementContextId)) {
        context.addIssue({
          code: "custom",
          path: ["featureMappings", index, "measurementContextId"],
          message: "feature mapping must reference an existing workspace cohort",
        });
      }
    }
    for (const cohort of report.cohorts) {
      const taggedInContext = report.featureMappings
        .filter((mapping) => mapping.measurementContextId === cohort.measurementContextId)
        .reduce((sum, mapping) => sum + mapping.search.completedSessionCount, 0);
      if (taggedInContext > cohort.completedSessionCount) {
        context.addIssue({
          code: "custom",
          path: ["featureMappings"],
          message: "feature sessions in a context cannot exceed its completed cohort sessions",
        });
      }
    }
  });

const searchSessionResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), session: searchJourneySchema }).strict(),
  z.object({ action: z.literal("get"), session: searchJourneySchema }).strict(),
  z.object({ action: z.literal("observe"), session: searchJourneySchema }).strict(),
  z.object({ action: z.literal("complete"), session: searchJourneySchema }).strict(),
  z.object({ action: z.literal("abandon"), session: searchJourneySchema }).strict(),
  z.object({ action: z.literal("report"), report: dynamicProductComplexityReportSchema }).strict(),
]);

const graphConfidenceSchema = z
  .object({ value: ratio, basis: z.enum(["deterministic", "heuristic"]), signals: stringArray })
  .strict();

const symbolNodeSchema = z
  .object({
    id: nonEmpty,
    name: text,
    qualifiedName: text,
    kind: text,
    signature: text.optional(),
    repoId: nonEmpty,
    refId: nonEmpty,
    fileId: nonEmpty,
    filePath: text,
    language: text,
    startLine: positiveInt,
    endLine: positiveInt,
    startByte: nonNegativeInt,
    endByte: nonNegativeInt,
    exportedAs: stringArray.optional(),
    visibility: text.optional(),
    contentHash: text,
  })
  .strict();

const symbolEdgeTargetSchema = z
  .object({
    symbolId: nonEmpty,
    qualifiedName: text,
    repoId: nonEmpty,
    refId: nonEmpty,
    filePath: text,
  })
  .strict();

const symbolEdgeSchema = z
  .object({
    schemaVersion: z.literal(1),
    edgeId: nonEmpty,
    workspaceId: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    fromSymbolId: nonEmpty,
    kind: z.enum(["calls", "references", "extends", "implements", "overrides", "unresolved"]),
    toName: text,
    toQualifier: text.optional(),
    resolution: z.enum(["exact", "heuristic", "ambiguous", "unresolved"]),
    target: symbolEdgeTargetSchema.optional(),
    candidates: z.array(symbolEdgeTargetSchema.extend({ weight: ratio }).strict()).optional(),
    unresolvedReason: z
      .enum([
        "no_candidate_found",
        "target_outside_index",
        "target_in_unparsed_file",
        "dynamic_dispatch_not_statically_analyzable",
        "import_unresolved",
        "budget_exceeded",
      ])
      .optional(),
    unresolvedDetail: text.optional(),
    confidence: graphConfidenceSchema,
    crossRepo: z.boolean(),
    sites: z.array(
      z
        .object({
          repoId: nonEmpty,
          refId: nonEmpty,
          filePath: text,
          range: sourceRangeSchema,
          column: positiveInt.optional(),
        })
        .strict(),
    ),
    sitesMissingReason: text.optional(),
    occurrenceOrdinal: nonNegativeInt,
    graphGeneration: nonEmpty,
    graphVersion: nonEmpty,
  })
  .strict();

const symbolBindingSchema = z
  .object({
    symbolId: nonEmpty,
    edgeId: nonEmpty,
    resolution: z.enum(["exact", "heuristic", "ambiguous", "unresolved"]),
    weight: ratio,
    ambiguous: z.boolean(),
  })
  .strict();

const traversalLimitsSchema = z
  .object({
    maxDepth: nonNegativeInt,
    maxNodes: positiveInt,
    maxEdges: positiveInt,
    maxWallTimeMs: positiveInt,
  })
  .strict();

const traversalResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    direction: z.enum(["forward", "reverse"]),
    rootSymbolIds: stringArray,
    visitedSymbolIds: stringArray,
    edgeIds: stringArray,
    depthReached: nonNegativeInt,
    truncated: z.boolean(),
    truncationReason: z
      .enum(["max_depth", "max_nodes", "max_edges", "max_wall_time", "cancelled"])
      .optional(),
    revisitSkippedSymbolIds: stringArray,
    limits: traversalLimitsSchema,
  })
  .strict();

const callPathSchema = z
  .object({
    schemaVersion: z.literal(1),
    symbolIds: stringArray,
    edgeIds: stringArray,
    depth: nonNegativeInt,
    confidence: ratio,
    weakestResolution: z.enum(["exact", "heuristic", "ambiguous", "unresolved"]),
    containsAmbiguous: z.boolean(),
  })
  .strict();

const shortestPathSchema = z
  .object({
    schemaVersion: z.literal(1),
    path: callPathSchema.nullable(),
    missReason: z
      .enum(["unknown_source_symbol", "unknown_target_symbol", "no_path_within_limits"])
      .optional(),
    missDetail: text.optional(),
    truncated: z.boolean(),
    truncationReason: z
      .enum(["max_depth", "max_nodes", "max_edges", "max_wall_time", "cancelled"])
      .optional(),
    limits: traversalLimitsSchema,
  })
  .strict();

const allPathsSchema = z
  .object({
    schemaVersion: z.literal(1),
    paths: z.array(callPathSchema),
    missReason: z
      .enum(["unknown_source_symbol", "unknown_target_symbol", "no_path_within_limits"])
      .optional(),
    missDetail: text.optional(),
    truncated: z.boolean(),
    truncationReason: z
      .enum(["max_depth", "max_nodes", "max_edges", "max_wall_time", "max_paths", "cancelled"])
      .optional(),
    droppedPathCount: nonNegativeInt,
    droppedPathCountExact: z.boolean(),
    pathLimitReached: z.boolean(),
    skipped: z.array(skipLedgerEntrySchema),
    maxDepth: nonNegativeInt,
  })
  .strict();

const impactResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    rootSymbolIds: stringArray,
    affected: z.array(
      z
        .object({
          symbolId: nonEmpty,
          qualifiedName: text,
          filePath: text,
          repoId: nonEmpty,
          depth: nonNegativeInt,
          minDepth: nonNegativeInt,
          confidence: ratio,
          weakestResolution: z.enum(["exact", "heuristic", "ambiguous", "unresolved"]),
          viaEdgeIds: stringArray,
          throughAmbiguous: z.boolean(),
        })
        .strict(),
    ),
    containsAmbiguousEdges: z.boolean(),
    ambiguousEdgeIds: stringArray,
    minConfidence: ratio,
    traversal: traversalResultSchema,
    skipped: z.array(skipLedgerEntrySchema),
  })
  .strict();

const fileNodeSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    fileId: nonEmpty,
    filePath: text,
    language: text,
    contentHash: text,
    imports: stringArray,
    dependencies: stringArray,
    dependents: stringArray,
    graphGeneration: nonEmpty,
    packageName: text.optional(),
    containerService: text.optional(),
    unresolvedImportCount: nonNegativeInt,
  })
  .strict();

const fileEdgeResolutionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("resolved"),
      mechanism: nonEmpty,
      targetFileId: nonEmpty,
      targetRepoId: nonEmpty,
      targetRefId: nonEmpty,
      targetPath: text,
      viaPackageName: text.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("external"),
      mechanism: nonEmpty,
      packageName: nonEmpty,
      declaredVersion: text.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unresolved"),
      reason: nonEmpty,
      detail: nonEmpty,
      rejectedCandidates: stringArray.optional(),
    })
    .strict(),
]);

const fileEdgeSchema = z
  .object({
    schemaVersion: z.literal(1),
    edgeId: nonEmpty,
    workspaceId: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    fromFileId: nonEmpty,
    fromPath: text,
    kind: z.enum([
      "import",
      "re-export",
      "dynamic-import",
      "asset-reference",
      "config-reference",
      "unresolved",
    ]),
    rawSpecifier: nonEmpty,
    resolution: fileEdgeResolutionSchema,
    boundary: z
      .object({
        crossRepo: z.boolean(),
        crossPackage: z.boolean(),
        crossContainer: z.boolean(),
        fromPackageName: text.optional(),
        toPackageName: text.optional(),
        fromContainerService: text.optional(),
        toContainerService: text.optional(),
      })
      .strict(),
    sites: z.array(
      z
        .object({
          range: sourceRangeSchema,
          importedNames: stringArray.optional(),
          typeOnly: z.boolean().optional(),
        })
        .strict(),
    ),
    sitesMissingReason: text.optional(),
    occurrenceOrdinal: nonNegativeInt,
    graphGeneration: nonEmpty,
    graphVersion: nonEmpty,
  })
  .strict();

const centralitySchema = z
  .object({
    fileId: nonEmpty,
    filePath: text,
    inDegree: nonNegativeInt,
    outDegree: nonNegativeInt,
    centrality: ratio,
  })
  .strict();

const fileGraphMetricsSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: nonEmpty,
    graphGeneration: nonEmpty,
    graphVersion: nonEmpty,
    nodeCount: nonNegativeInt,
    edgeCount: nonNegativeInt,
    orphanFileIds: stringArray,
    stronglyConnectedComponents: z.array(stringArray),
    cycles: z.array(stringArray),
    importResolution: z
      .object({
        resolvedCount: nonNegativeInt,
        externalCount: nonNegativeInt,
        unresolvedCount: nonNegativeInt,
        rate: ratio,
      })
      .strict(),
    repositoryDistribution: numberMap,
    languageDistribution: numberMap,
    topCentralFiles: z.array(centralitySchema),
    centralityFormula: nonEmpty,
    truncationReason: text.optional(),
  })
  .strict();

const snapshotReadIssueSchema = z
  .object({
    kind: z.enum([
      "missing_meta",
      "missing_path_index",
      "missing_file_shard",
      "malformed_payload",
      "count_mismatch",
      "workspace_scope_required",
      "scope_mismatch",
    ]),
    message: nonEmpty,
  })
  .strict();

const fileTraversalSchema = z
  .object({
    schemaVersion: z.literal(1),
    direction: z.enum(["forward", "reverse"]),
    rootFileIds: stringArray,
    visitedFileIds: stringArray,
    edgeIds: stringArray,
    depthReached: nonNegativeInt,
    truncated: z.boolean(),
    truncationReason: z
      .enum(["max_depth", "max_nodes", "max_edges", "max_wall_time", "cancelled"])
      .optional(),
    revisitSkippedFileIds: stringArray,
    cycles: z.array(stringArray),
    unvisitedRootFileIds: stringArray.optional(),
    unknownRootFileIds: stringArray.optional(),
    limits: traversalLimitsSchema,
    visitedPaths: stringArray,
    cyclePaths: z.array(stringArray),
  })
  .strict();

const boundaryCountsSchema = z
  .object({
    crossRepo: nonNegativeInt,
    crossPackage: nonNegativeInt,
    crossContainer: nonNegativeInt,
  })
  .strict();

const graphFileViewSchema = z
  .object({
    generationId: nonEmpty,
    workspaceId: nonEmpty,
    node: fileNodeSchema,
    edges: z.array(fileEdgeSchema),
    dependencies: fileTraversalSchema.optional(),
    dependents: fileTraversalSchema.optional(),
    issues: z.array(snapshotReadIssueSchema),
  })
  .strict();

const boundedGraphFileViewSchema = graphFileViewSchema.extend({
  truncated: z.boolean(),
  omittedCount: nonNegativeInt,
});

const graphViewStatsSchema = z
  .object({
    inputNodeCount: nonNegativeInt,
    shownNodeCount: nonNegativeInt,
    nodeLimitDroppedCount: nonNegativeInt,
    sourceEdgeCount: nonNegativeInt,
    candidateLinkCount: nonNegativeInt,
    renderableLinkCount: nonNegativeInt,
    shownLinkCount: nonNegativeInt,
    unrenderableSourceEdgeCount: nonNegativeInt,
    missingEndpointLinkCount: nonNegativeInt,
    nodeLimitDroppedLinkCount: nonNegativeInt,
    edgeLimitDroppedLinkCount: nonNegativeInt,
  })
  .strict();

const graphVisualizationArtifactShape = {
  path: nonEmpty,
  bytes: positiveInt,
  sha256: text.regex(/^[0-9a-f]{64}$/u),
  limits: z.object({ maxNodes: positiveInt, maxEdges: positiveInt }).strict(),
};

const graphVisualizationShape = {
  generationId: nonEmpty,
  workspaceId: nonEmpty,
  issues: z.array(snapshotReadIssueSchema),
};

const graphVisualizationSchema = z.union([
  z
    .object({
      ...graphVisualizationShape,
      artifact: z
        .object({
          ...graphVisualizationArtifactShape,
          views: z.object({ file: graphViewStatsSchema, symbol: graphViewStatsSchema }).strict(),
        })
        .strict(),
      symbolGraph: z.object({ available: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      ...graphVisualizationShape,
      artifact: z
        .object({
          ...graphVisualizationArtifactShape,
          views: z.object({ file: graphViewStatsSchema, symbol: z.null() }).strict(),
        })
        .strict(),
      symbolGraph: z.object({ available: z.literal(false), missingReason: nonEmpty }).strict(),
    })
    .strict(),
]);

const symbolListSchema = z
  .object({
    generationId: nonEmpty,
    symbols: z.array(symbolNodeSchema),
    total: nonNegativeInt,
    truncated: z.boolean(),
  })
  .strict();

const symbolDetailSchema = z
  .object({
    generationId: nonEmpty,
    matchedBy: z.enum(["symbol_id", "qualified_name", "file_and_name", "name"]).optional(),
    symbol: symbolNodeSchema,
    outgoing: z.array(symbolEdgeSchema),
    callers: z.array(symbolBindingSchema),
  })
  .strict();

const boundedFlowSymbolDetailSchema = symbolDetailSchema.extend({
  truncated: z.boolean(),
  omittedCount: nonNegativeInt,
});

const flowSchema = z.union([
  boundedFlowSymbolDetailSchema,
  z
    .object({
      generationId: nonEmpty,
      from: symbolNodeSchema,
      to: symbolNodeSchema,
      shortest: shortestPathSchema,
      all: allPathsSchema,
    })
    .strict(),
]);

const impactSchema = z
  .object({
    generationId: nonEmpty,
    root: symbolNodeSchema,
    impact: impactResultSchema,
    truncated: z.boolean(),
    omittedCount: nonNegativeInt,
  })
  .strict();

const proseNumberSchema = z
  .object({
    proseMeasurement: z.literal(true),
    value: finite,
    unit: z.enum(["levels", "lines", "per_100_lines", "ratio", "count"]),
  })
  .strict();

const complexitySymbolSchema = z
  .object({
    filePath: text,
    name: text,
    kind: text,
    line: positiveInt,
    executionUnit: z.boolean(),
    cognitive: nonNegative,
    cyclomatic: nonNegative,
    sloc: nonNegative,
  })
  .strict();

const complexityViolationSchema = z
  .object({
    filePath: text,
    line: positiveInt,
    name: text,
    metric: z.enum(["cognitive", "cyclomatic"]),
    value: nonNegative,
    threshold: finite,
  })
  .strict();

const proseSummarySchema = z
  .object({
    path: text,
    metricsVersion: nonEmpty,
    structureLoad: proseNumberSchema,
    sectionCount: proseNumberSchema,
    sectionDepth: proseNumberSchema,
    maxSectionLines: proseNumberSchema,
    linkDensity: proseNumberSchema,
    unresolvedLinkRatio: proseNumberSchema.nullable(),
    repetitionRatio: proseNumberSchema,
    contentLines: proseNumberSchema,
  })
  .strict();

const complexityReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    root: nonEmpty,
    filesDiscovered: nonNegativeInt,
    filesAnalyzed: nonNegativeInt,
    filesProse: nonNegativeInt,
    totalsReading: z.enum(["execution_unit"]).optional(),
    totals: z
      .object({
        executionUnits: nonNegativeInt,
        executionUnitRoots: nonNegativeInt.optional(),
        cognitive: nonNegative,
        cyclomatic: nonNegative,
      })
      .strict(),
    hotspots: z.array(complexitySymbolSchema),
    violations: z.array(complexityViolationSchema),
    prose: z.array(proseSummarySchema),
    skipped: z.array(skipLedgerEntrySchema),
  })
  .strict();

const metricContributionSchema = z
  .object({
    line: positiveInt,
    column: positiveInt.optional(),
    kind: nonEmpty,
    value: finite,
    note: text.optional(),
  })
  .strict();

const cognitiveContributionSchema = z
  .object({
    line: positiveInt,
    column: positiveInt.optional(),
    kind: nonEmpty,
    base: finite,
    nestingPenalty: finite,
    total: finite,
    note: text.optional(),
  })
  .strict();

const complexitySnapshotSchema = z
  .object({
    snapshotId: nonEmpty,
    scope: z.enum(["symbol", "file", "repository", "workspace"]),
    scopeId: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    commitSha: text.optional(),
    metricsVersion: nonEmpty,
    measuredAt: nonEmpty,
    parseQuality: z.enum(["complete", "partial", "failed"]),
    cyclomatic: z
      .object({
        classic: finite,
        extended: finite,
        contributors: z.array(metricContributionSchema),
      })
      .strict(),
    cognitive: z
      .object({
        value: finite,
        algorithm: nonEmpty,
        contributors: z.array(cognitiveContributionSchema),
      })
      .strict(),
    structural: numberMap,
    textual: numberMap,
    syntactic: numberMap,
    halstead: numberMap,
    maintainabilityIndex: finite,
    maintainabilityFormula: nonEmpty,
  })
  .strict();

const metricDeltaSchema = z
  .object({
    metric: nonEmpty,
    baseValue: finite.nullable(),
    headValue: finite.nullable(),
    delta: finite.nullable(),
    relativeDelta: finite.nullable(),
  })
  .strict();

const changeEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    changeId: nonEmpty,
    workspaceId: nonEmpty,
    repoId: nonEmpty,
    baseRef: nonEmpty,
    headRef: nonEmpty,
    baseCommit: text.optional(),
    headCommit: text.optional(),
    changedAt: nonEmpty,
    changeKind: z.enum(["added", "modified", "deleted", "renamed", "moved", "moved_and_renamed"]),
    oldSymbolId: text.optional(),
    newSymbolId: text.optional(),
    oldFilePath: text.optional(),
    newFilePath: text.optional(),
    textDiffSummary: z
      .object({
        linesAdded: nonNegativeInt,
        linesRemoved: nonNegativeInt,
        hunkCount: nonNegativeInt,
        binary: z.boolean(),
        bytesAdded: nonNegativeInt.optional(),
        bytesRemoved: nonNegativeInt.optional(),
      })
      .strict(),
    astDiffSummary: z
      .object({
        nodesAdded: nonNegativeInt,
        nodesRemoved: nonNegativeInt,
        nodesMoved: nonNegativeInt,
        nodesUpdated: nonNegativeInt,
        affectedNodeKinds: stringArray,
        fingerprintChanged: z.boolean(),
      })
      .strict()
      .optional(),
    complexityDelta: z
      .object({
        metricsVersion: nonEmpty,
        epsilon: nonNegative,
        entries: z.array(metricDeltaSchema),
      })
      .strict()
      .optional(),
    graphDelta: z
      .object({
        addedFileImports: z.array(
          z
            .object({
              fromId: nonEmpty,
              toId: nonEmpty,
              edgeKind: nonEmpty,
              crossRepo: z.boolean(),
            })
            .strict(),
        ),
        removedFileImports: z.array(
          z
            .object({
              fromId: nonEmpty,
              toId: nonEmpty,
              edgeKind: nonEmpty,
              crossRepo: z.boolean(),
            })
            .strict(),
        ),
        addedSymbolCalls: z.array(
          z
            .object({
              fromId: nonEmpty,
              toId: nonEmpty,
              edgeKind: nonEmpty,
              crossRepo: z.boolean(),
            })
            .strict(),
        ),
        removedSymbolCalls: z.array(
          z
            .object({
              fromId: nonEmpty,
              toId: nonEmpty,
              edgeKind: nonEmpty,
              crossRepo: z.boolean(),
            })
            .strict(),
        ),
        addedCrossRepoEdges: z.array(
          z
            .object({
              fromId: nonEmpty,
              toId: nonEmpty,
              edgeKind: nonEmpty,
              crossRepo: z.boolean(),
            })
            .strict(),
        ),
        removedCrossRepoEdges: z.array(
          z
            .object({
              fromId: nonEmpty,
              toId: nonEmpty,
              edgeKind: nonEmpty,
              crossRepo: z.boolean(),
            })
            .strict(),
        ),
        addedCycles: z.array(stringArray),
        removedCycles: z.array(stringArray),
        fanChanges: z.array(
          z
            .object({
              nodeId: nonEmpty,
              fanInBefore: nonNegativeInt,
              fanInAfter: nonNegativeInt,
              fanOutBefore: nonNegativeInt,
              fanOutAfter: nonNegativeInt,
            })
            .strict(),
        ),
        impactSizeBefore: nonNegativeInt,
        impactSizeAfter: nonNegativeInt,
      })
      .strict()
      .optional(),
    blastRadius: z
      .object({
        impactedFileCount: nonNegativeInt,
        impactedSymbolCount: nonNegativeInt,
        impactedRepoIds: stringArray,
        maxDepthReached: nonNegativeInt,
        truncated: z.boolean(),
        truncationReason: text.optional(),
        sampleImpactedSymbolIds: stringArray,
      })
      .strict()
      .optional(),
    risk: z
      .object({
        value: ratio,
        level: z.enum(["low", "medium", "high", "critical"]),
        algorithm: nonEmpty,
        components: z.record(
          z.string(),
          z.object({ value: finite, weight: finite, contribution: finite }).strict(),
        ),
        caveats: stringArray,
      })
      .strict()
      .optional(),
  })
  .strict();

const qualityGateSchema = z
  .object({
    status: z.enum(["passed", "warning", "failed", "incomplete"]),
    base: nonEmpty,
    head: nonEmpty,
    violations: z.array(
      z
        .object({
          rule: nonEmpty,
          severity: z.enum(["warning", "error"]),
          scope: z.enum(["symbol", "file", "workspace"]),
          scopeId: nonEmpty,
          filePath: text.optional(),
          symbolId: text.optional(),
          symbolFqn: text.optional(),
          metric: text.optional(),
          baseValue: finite.optional(),
          headValue: finite.optional(),
          threshold: finite.optional(),
          newViolation: z.boolean(),
          worsened: z.boolean(),
          message: nonEmpty,
        })
        .strict(),
    ),
    improvements: z.array(
      z
        .object({
          rule: nonEmpty,
          scope: z.enum(["symbol", "file", "workspace"]),
          scopeId: nonEmpty,
          filePath: text.optional(),
          symbolId: text.optional(),
          symbolFqn: text.optional(),
          metric: text.optional(),
          baseValue: finite.optional(),
          headValue: finite.optional(),
          message: nonEmpty,
        })
        .strict(),
    ),
    analysisCoverage: z
      .object({
        filesChanged: nonNegativeInt,
        filesAnalyzed: nonNegativeInt,
        symbolsChanged: nonNegativeInt,
        parseFailures: nonNegativeInt,
      })
      .strict(),
  })
  .strict();

// Portfolio contracts: portfolio.md sections 7 and 14.2.
const portfolioEvidenceKindSchema = z.enum([
  "manifest",
  "lockfile",
  "config",
  "import_graph",
  "symbol_graph",
  "ci",
  "container",
  "iac",
  "change_history",
  "heuristic",
]);

const portfolioProvenanceSchema = z
  .object({
    workspaceId: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    commitSha: text.optional(),
    sourceFile: text,
    startLine: positiveInt.optional(),
    endLine: positiveInt.optional(),
    detectorId: nonEmpty,
    detectorVersion: nonEmpty,
    evidenceKind: portfolioEvidenceKindSchema,
  })
  .strict();

const portfolioConfidenceSchema = z
  .object({ value: ratio, basis: z.enum(["deterministic", "heuristic"]), signals: stringArray })
  .strict();

const repositoryHealthSchema = z
  .object({
    metricsVersion: nonEmpty,
    measuredAt: nonEmpty,
    maintainabilityIndexMedian: finite.optional(),
    cognitiveP90: finite.optional(),
    cyclomaticP90: finite.optional(),
    dependencyCycleCount: nonNegativeInt.optional(),
    hotspotShare: ratio.optional(),
    unresolvedImportRatio: ratio.optional(),
    parseFailureRatio: ratio.optional(),
    caveats: stringArray,
  })
  .strict();

const stackMatrixEntrySchema = z
  .object({
    technologyId: nonEmpty,
    name: nonEmpty,
    category: nonEmpty,
    ecosystem: text.optional(),
    problemDomain: text.optional(),
    adoption: z
      .object({ repoCount: nonNegativeInt, repoShare: ratio, repoIds: stringArray })
      .strict(),
    versionSpread: z
      .object({
        distinctVersions: stringArray,
        byRepo: optionalStringMap,
        majorSpread: nonNegativeInt,
        comparable: z.boolean(),
      })
      .strict(),
    usageDepth: z
      .object({
        importingFilesByRepo: z.record(z.string(), nonNegativeInt),
        declaredOnlyRepos: stringArray,
        importOnlyRepos: stringArray,
      })
      .strict(),
    firstSeenAt: text.optional(),
    lastSeenAt: text.optional(),
    confidence: portfolioConfidenceSchema,
  })
  .strict();

export const stackMatrixResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    matrixId: nonEmpty,
    workspaceId: nonEmpty,
    generationId: nonEmpty,
    generatedAt: nonEmpty,
    analyzerVersion: nonEmpty,
    repositories: z.array(
      z.object({ repoId: nonEmpty, refId: nonEmpty, profileId: nonEmpty }).strict(),
    ),
    entries: z.array(stackMatrixEntrySchema),
    warnings: stringArray,
  })
  .strict();

const conventionRuleSchema = z
  .object({
    ruleKind: z.enum([
      "path_exists",
      "path_layout",
      "naming_pattern",
      "dependency_present",
      "layering",
      "symbol_pattern",
      "config_pattern",
    ]),
    expression: jsonMap,
    humanReadable: nonEmpty,
  })
  .strict();

const conventionSchema = z
  .object({
    schemaVersion: z.literal(1),
    conventionId: nonEmpty,
    workspaceId: nonEmpty,
    generationId: nonEmpty,
    kind: z.enum([
      "directory_layout",
      "layering",
      "naming",
      "test_setup",
      "error_handling",
      "config_handling",
      "logging",
    ]),
    title: nonEmpty,
    description: text,
    rule: conventionRuleSchema,
    evidence: z
      .object({
        applicableRepos: stringArray,
        supportingRepos: stringArray,
        matchCount: nonNegativeInt,
        counterexamples: z.array(
          z
            .object({
              repoId: nonEmpty,
              provenance: portfolioProvenanceSchema,
              note: text.optional(),
            })
            .strict(),
        ),
        sampleProvenance: z.array(portfolioProvenanceSchema),
      })
      .strict(),
    confidence: portfolioConfidenceSchema,
    detectorId: nonEmpty,
    detectorVersion: nonEmpty,
    heuristic: z.boolean(),
  })
  .strict();

const archetypeNameSchema = z.enum([
  "layered_service",
  "hexagonal_service",
  "modular_monolith",
  "api_service",
  "worker",
  "cli_tool",
  "library",
  "frontend_app",
  "mcp_server",
  "infra_repo",
  "monorepo_root",
  "unclassified",
]);

const archetypeSchema = z
  .object({
    schemaVersion: z.literal(1),
    archetypeId: nonEmpty,
    workspaceId: nonEmpty,
    repoId: nonEmpty,
    refId: nonEmpty,
    generationId: nonEmpty,
    classifierVersion: nonEmpty,
    archetype: archetypeNameSchema,
    score: ratio,
    alternatives: z.array(z.object({ archetype: archetypeNameSchema, score: ratio }).strict()),
    signals: z.array(
      z
        .object({
          signalId: nonEmpty,
          description: nonEmpty,
          weight: finite,
          matched: z.boolean(),
          contribution: finite,
          provenance: portfolioProvenanceSchema.optional(),
          heuristic: z.boolean(),
        })
        .strict(),
    ),
    confidence: portfolioConfidenceSchema,
  })
  .strict();

const radarEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    entryId: nonEmpty,
    workspaceId: nonEmpty,
    generationId: nonEmpty,
    radarVersion: nonEmpty,
    technologyId: nonEmpty,
    name: nonEmpty,
    category: nonEmpty,
    problemDomain: text.optional(),
    ring: z.enum(["adopt", "maintain", "consolidate", "retire"]),
    ringReason: stringArray,
    versionDrift: z
      .object({
        distinctVersions: stringArray,
        majorSpread: nonNegativeInt,
        byRepo: optionalStringMap,
        comparable: z.boolean(),
      })
      .strict(),
    duplicates: z.array(
      z.object({ problemDomain: nonEmpty, competingTechnologyIds: stringArray }).strict(),
    ),
    trend: z
      .object({
        direction: z.enum(["converging", "diverging", "stable", "declining", "new", "unknown"]),
        points: z.array(
          z
            .object({
              window: nonEmpty,
              repoCount: nonNegativeInt,
              distinctVersionCount: nonNegativeInt,
            })
            .strict(),
        ),
      })
      .strict(),
    evidence: z.array(portfolioProvenanceSchema),
    confidence: portfolioConfidenceSchema,
  })
  .strict();

const blueprintKindSchema = z.enum([
  "api-service",
  "worker",
  "cli",
  "library",
  "web-app",
  "mcp-server",
]);

const blueprintFileSchema = z
  .object({
    path: text,
    templateId: nonEmpty,
    contentPreviewHash: nonEmpty,
    sizeBytes: nonNegativeInt,
  })
  .strict();

const blueprintDependencySchema = z
  .object({
    technologyId: nonEmpty,
    name: nonEmpty,
    ecosystem: nonEmpty,
    version: nonEmpty,
    usage: z.enum(["runtime", "dev"]),
    recommendationId: nonEmpty,
  })
  .strict();

const recommendationComponentSchema = z
  .object({
    name: z.enum(["adoption", "recency", "health", "version_consistency"]),
    value: ratio,
    weight: finite,
    contribution: finite,
    inputs: jsonMap,
  })
  .strict();

const blueprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    blueprintId: nonEmpty,
    workspaceId: nonEmpty,
    generationId: nonEmpty,
    advisorVersion: nonEmpty,
    generatedAt: nonEmpty,
    kind: blueprintKindSchema,
    language: nonEmpty,
    runtime: z.object({ name: nonEmpty, versionRange: nonEmpty }).strict(),
    directoryLayout: z.array(
      z
        .object({
          path: text,
          kind: z.enum(["directory", "file"]),
          purpose: nonEmpty,
          sourceConventionId: text.optional(),
        })
        .strict(),
    ),
    dependencies: z.array(blueprintDependencySchema),
    toolchain: z.array(blueprintDependencySchema),
    testSetup: z
      .object({ framework: nonEmpty, layout: nonEmpty, recommendationId: nonEmpty })
      .strict(),
    ciSkeleton: z
      .object({ system: nonEmpty, workflowFiles: stringArray, recommendationId: nonEmpty })
      .strict(),
    appliedConventionIds: stringArray,
    recommendationIds: stringArray,
    files: z.array(blueprintFileSchema).optional(),
    evidenceSummary: z
      .object({
        reposConsidered: nonNegativeInt,
        reposMatchingKind: stringArray,
        portfolioGenerationId: nonEmpty,
      })
      .strict(),
    warnings: stringArray,
  })
  .strict();

const blueprintRecommendationSchema = z
  .object({
    schemaVersion: z.literal(1),
    recommendationId: nonEmpty,
    blueprintId: nonEmpty,
    workspaceId: nonEmpty,
    generationId: nonEmpty,
    advisorVersion: nonEmpty,
    topic: nonEmpty,
    recommended: z
      .object({ technologyId: nonEmpty, name: nonEmpty, version: text.optional() })
      .strict(),
    fitScore: ratio,
    components: z.array(recommendationComponentSchema),
    evidence: z
      .object({
        supportingRepoIds: stringArray,
        supportingRecordIds: stringArray,
        healthByRepo: z.record(z.string(), repositoryHealthSchema.nullable()),
      })
      .strict(),
    alternatives: z.array(
      z
        .object({
          technologyId: nonEmpty,
          name: nonEmpty,
          version: text.optional(),
          fitScore: ratio,
          components: z.array(recommendationComponentSchema),
          note: text.optional(),
        })
        .strict(),
    ),
    risks: z.array(
      z
        .object({
          kind: z.enum([
            "outdated_version",
            "low_adoption",
            "high_hotspot_share",
            "version_divergence",
            "single_repo_evidence",
            "declared_only_evidence",
            "heuristic_evidence",
          ]),
          severity: z.enum(["info", "warning", "critical"]),
          message: nonEmpty,
          evidence: z.array(portfolioProvenanceSchema),
        })
        .strict(),
    ),
    confidence: portfolioConfidenceSchema,
  })
  .strict();

export const portfolioScanResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: nonEmpty,
    generationId: nonEmpty,
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    repositoriesPlanned: nonNegativeInt,
    repositoriesCompleted: nonNegativeInt,
    technologiesDetected: nonNegativeInt.optional(),
    conventionsDetected: nonNegativeInt.optional(),
    warnings: stringArray,
  })
  .strict();

export const whoUsesResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    technology: z
      .object({
        technologyId: nonEmpty,
        name: nonEmpty,
        category: nonEmpty,
        ecosystem: text.optional(),
      })
      .strict(),
    generationId: nonEmpty,
    usages: z.array(
      z
        .object({
          repoId: nonEmpty,
          repoLabel: text,
          refId: nonEmpty,
          versionRaw: text.optional(),
          versionResolved: text.optional(),
          usage: nonEmpty,
          declaredOnly: z.boolean(),
          importOnly: z.boolean(),
          importingFileCount: nonNegativeInt.optional(),
          firstSeenAt: text.optional(),
          lastSeenAt: text.optional(),
          provenance: z.array(portfolioProvenanceSchema),
        })
        .strict(),
    ),
    notUsingRepoIds: stringArray,
    warnings: stringArray,
  })
  .strict();

export const conventionsResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    generationId: nonEmpty,
    conventions: z.array(conventionSchema),
    suppressedCount: nonNegativeInt,
    warnings: stringArray,
  })
  .strict();

export const archetypesResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    generationId: nonEmpty,
    classifierVersion: nonEmpty,
    assignments: z.array(archetypeSchema),
    warnings: stringArray,
  })
  .strict();

export const techRadarResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    generationId: nonEmpty,
    radarVersion: nonEmpty,
    entries: z.array(radarEntrySchema),
    historyAvailable: z.boolean(),
    warnings: stringArray,
  })
  .strict();

export const blueprintResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    blueprint: blueprintSchema,
    recommendations: z.array(blueprintRecommendationSchema),
    scaffold: z
      .object({
        mode: z.enum(["dry_run", "applied"]),
        targetDir: nonEmpty,
        files: z.array(blueprintFileSchema),
        manifestPath: text.optional(),
      })
      .strict()
      .optional(),
    warnings: stringArray,
  })
  .strict();

const graphStatusSchema = z
  .object({
    generationId: nonEmpty,
    workspaceId: nonEmpty,
    metrics: fileGraphMetricsSchema,
    issues: z.array(snapshotReadIssueSchema),
  })
  .strict();

const graphStatsSchema = z
  .object({
    generationId: nonEmpty,
    metrics: fileGraphMetricsSchema,
    boundaries: boundaryCountsSchema,
    issues: z.array(snapshotReadIssueSchema),
  })
  .strict();

const graphCyclesSchema = z
  .object({
    generationId: nonEmpty,
    cycles: z.array(stringArray),
    total: nonNegativeInt,
    issues: z.array(snapshotReadIssueSchema),
  })
  .strict();

const aboutSchema = z
  .object({
    name: z.literal("untangle"),
    version: nonEmpty,
    license: z.literal("AGPL-3.0-only"),
    source: nonEmpty,
    commit: nonEmpty,
    availableTools: z.array(nonEmpty),
    unavailableToolsReturn: z.literal("FEATURE_UNAVAILABLE"),
  })
  .strict();

/** Tool-specific success payload contracts; none falls back to an arbitrary object. */
const productSourceReferenceSchema = z.object({ path: text, heading: text }).strict();
const productFileSelectionSchema = z
  .object({ include: stringArray, exclude: stringArray.optional() })
  .strict();
const productManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    owners: z.array(
      z
        .object({
          id: text,
          label: text,
          kind: z.enum(["person", "team", "role"]),
          status: z.enum(["declared", "confirmed"]),
          confirmedBy: text.optional(),
          sources: z.array(productSourceReferenceSchema),
        })
        .strict(),
    ),
    features: z.array(
      z
        .object({
          id: text,
          title: text,
          stage: z.enum(["implemented", "planned"]),
          review: z.enum(["proposed", "confirmed"]),
          confirmedBy: text.optional(),
          intent: z.array(
            productSourceReferenceSchema.extend({ role: z.enum(["vision", "specification"]) }),
          ),
          owners: stringArray,
          code: productFileSelectionSchema,
          tests: productFileSelectionSchema,
          criteria: z.array(
            z
              .object({
                id: text,
                description: text,
                tests: stringArray,
                testNames: stringArray.optional(),
              })
              .strict(),
          ),
          dependsOn: stringArray,
          budgets: z
            .object({
              maxCognitivePerUnit: nonNegative.optional(),
              maxCognitiveTotal: nonNegative.optional(),
              maxCodeFiles: nonNegativeInt.optional(),
              maxOwners: nonNegativeInt.optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
const productSourceEvidenceSchema = productSourceReferenceSchema.extend({
  status: z.enum(["resolved", "missing", "ambiguous", "not_in_scan", "changed", "unreadable"]),
  contentHash: sha256Fingerprint.optional(),
  startLine: positiveInt.optional(),
  endLine: positiveInt.optional(),
});
const productFileEvidenceSchema = z
  .object({
    path: nonEmpty,
    status: z.enum([
      "measured",
      "not_in_scan",
      "changed",
      "unreadable",
      "unsupported",
      "partial",
      "invalid_metrics",
    ]),
    contentHash: sha256Fingerprint.optional(),
    scannedContentHash: sha256Fingerprint.optional(),
  })
  .strict();
const productMetricReadingsSchema = z
  .object({ top_level: nonNegative, execution_unit: nonNegative, self: nonNegative })
  .strict();
const productCodeMetricsSchema = z
  .object({
    metricsVersion: nonEmpty,
    cognitiveAlgorithm: nonEmpty,
    cognitive: productMetricReadingsSchema,
    cyclomaticClassic: productMetricReadingsSchema,
    cyclomaticExtended: productMetricReadingsSchema,
    files: nonNegativeInt,
    scopes: nonNegativeInt,
    executionUnitRoots: nonNegativeInt,
    sloc: nonNegativeInt,
    cyclomaticPerScopeBase: z.literal(1),
  })
  .strict();
const productMeasuredSelectionSchema = z
  .object({
    complete: z.boolean(),
    files: z.array(productFileEvidenceSchema),
    metrics: productCodeMetricsSchema.nullable(),
  })
  .strict();
const productHotspotSchema = z
  .object({
    path: nonEmpty,
    contentHash: sha256Fingerprint,
    symbol: nonEmpty,
    scopeId: nonEmpty,
    startLine: positiveInt,
    endLine: positiveInt,
    cognitive: nonNegative,
    cyclomaticClassic: nonNegative,
    cyclomaticExtended: nonNegative,
  })
  .strict();
const productAgentHintSchema = z
  .object({
    code: nonEmpty,
    severity: z.enum(["info", "warning", "error"]),
    message: text,
    paths: stringArray,
    suggestedAction: text,
    search: z
      .object({ symbol: nonEmpty, path: nonEmpty, requireFresh: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict();
const productFeatureAlignmentSchema = z
  .object({
    id: nonEmpty,
    title: text,
    stage: z.enum(["implemented", "planned"]),
    review: z.enum(["proposed", "confirmed"]),
    status: z.enum(["evidence_consistent", "needs_review", "incomplete", "violated"]),
    intent: z.array(
      productSourceEvidenceSchema.extend({ role: z.enum(["vision", "specification"]) }),
    ),
    ownership: z.array(
      z
        .object({
          id: nonEmpty,
          label: text.optional(),
          status: z.enum(["declared", "confirmed", "missing"]),
          sources: z.array(productSourceEvidenceSchema),
        })
        .strict(),
    ),
    code: productMeasuredSelectionSchema.extend({ hotspots: z.array(productHotspotSchema) }),
    tests: productMeasuredSelectionSchema,
    testEvidence: z
      .object({
        status: z.enum(["bound_passed", "bound_failed", "not_run", "stale", "invalid"]),
        passed: nonNegativeInt,
        failed: nonNegativeInt,
        skipped: nonNegativeInt,
        proof: z.enum(["supplied_source_bound_report", "none"]),
      })
      .strict(),
    criteria: z.array(
      z
        .object({
          id: nonEmpty,
          description: text,
          matchedFiles: stringArray,
          status: z.enum(["passed", "failed", "not_run", "missing_tests", "unverified"]),
        })
        .strict(),
    ),
    dimensions: z
      .object({
        requirements: nonNegativeInt,
        owners: nonNegativeInt,
        codeFiles: nonNegativeInt,
        testFiles: nonNegativeInt,
        sharedCodeFiles: nonNegativeInt,
        declaredDependencies: nonNegativeInt,
        dependentFeatures: nonNegativeInt,
      })
      .strict(),
    dependsOn: stringArray,
    agentHints: z.array(productAgentHintSchema),
    issues: stringArray,
  })
  .strict();
const productAlignmentReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    root: nonEmpty,
    status: z.enum([
      "needs_manifest",
      "invalid_manifest",
      "evidence_consistent",
      "needs_review",
      "incomplete",
      "violated",
    ]),
    manifest: z
      .object({
        path: nonEmpty,
        status: z.enum(["missing", "loaded", "invalid", "not_in_scan", "changed", "unreadable"]),
        contentHash: sha256Fingerprint.optional(),
      })
      .strict(),
    sourceTreeDigest: sha256Fingerprint,
    inventory: z
      .object({ files: nonNegativeInt, truncated: z.boolean(), excluded: nonNegativeInt })
      .strict(),
    semanticConformance: z.literal("not_independently_proven"),
    ownershipAuthority: z.literal("manifest_declarations"),
    selection: z
      .object({
        path: nonEmpty,
        status: z.enum(["matched", "unmapped", "missing", "not_in_scan", "changed", "unreadable"]),
        matches: z.array(
          z
            .object({
              featureId: nonEmpty,
              roles: z.array(z.enum(["code", "test", "intent", "ownership"])),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    testRun: z
      .object({
        status: z.enum([
          "completed",
          "stale",
          "invalid_report",
          "spawn_failed",
          "timed_out",
          "output_limit",
          "cancelled",
        ]),
        directory: nonEmpty,
        receiptPath: nonEmpty,
        exitCode: integer.nullable(),
        issue: text.optional(),
      })
      .strict()
      .optional(),
    features: z.array(productFeatureAlignmentSchema),
    coverage: z
      .object({
        measuredCodeFiles: nonNegativeInt,
        mappedCodeFiles: nonNegativeInt,
        unmappedCodeFiles: stringArray,
        unmappedCodeFileCount: nonNegativeInt,
        sharedFiles: z.array(z.object({ path: nonEmpty, featureIds: stringArray }).strict()),
        mappedCodeUnion: productCodeMetricsSchema.nullable(),
      })
      .strict(),
    dependencyCycles: z.array(stringArray),
    issues: stringArray,
    limitations: stringArray,
    draft: productManifestSchema.nullable(),
  })
  .strict();

export const UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS = {
  untangle_index: indexReportSchema,
  untangle_update: indexReportSchema,
  untangle_stop: z.object({ job: jobStatusSchema, cancellationRequested: z.boolean() }).strict(),
  untangle_watch: z.object({ job: jobStatusSchema, watching: z.boolean() }).strict(),
  untangle_status: z.object({ jobs: z.array(jobStatusSchema) }).strict(),
  untangle_health: z
    .object({ schemaVersion: z.literal(1), ok: z.boolean(), checks: z.array(checkResultSchema) })
    .strict(),
  untangle_projects: z
    .object({
      root: nonEmpty,
      repositories: z.array(repositoryConfigSchema),
      projectId: text.optional(),
    })
    .strict(),
  untangle_search: searchResultSetSchema,
  untangle_search_session: searchSessionResultSchema,
  untangle_context_list: z
    .object({ artifacts: z.array(contextArtifactSchema), configured: nonNegativeInt })
    .strict(),
  untangle_context_index: z
    .object({
      generationId: nonEmpty,
      artifacts: z.array(nonEmpty),
      indexedDocuments: nonNegativeInt,
    })
    .strict(),
  untangle_context_search: z
    .object({
      query: nonEmpty,
      results: z.array(
        z
          .object({
            artifactName: nonEmpty,
            chunkId: nonEmpty,
            path: text,
            kind: nonEmpty,
            title: text.optional(),
            score: finite,
            content: text.optional(),
          })
          .strict(),
      ),
      total: nonNegativeInt,
    })
    .strict(),
  untangle_context_remove: z
    .object({ target: nonEmpty, removed: z.boolean(), removedDocumentCount: nonNegativeInt })
    .strict(),
  untangle_graph_build: z
    .object({
      generationId: nonEmpty,
      workspaceId: nonEmpty,
      fileGraph: z.object({ nodeCount: nonNegativeInt, edgeCount: nonNegativeInt }).strict(),
      symbolGraph: z.object({ nodeCount: nonNegativeInt, edgeCount: nonNegativeInt }).strict(),
      skipped: z.array(skipLedgerEntrySchema),
    })
    .strict(),
  untangle_graph_status: graphStatusSchema,
  untangle_graph_query: boundedGraphFileViewSchema,
  untangle_graph_stats: graphStatsSchema,
  untangle_graph_cycles: graphCyclesSchema,
  untangle_graph_visualize: graphVisualizationSchema,
  untangle_graph_remove: z
    .object({ target: nonEmpty, generationId: nonEmpty, removed: z.boolean() })
    .strict(),
  untangle_symbols: symbolListSchema,
  untangle_symbol: symbolDetailSchema,
  untangle_flow: flowSchema,
  untangle_impact: impactSchema,
  untangle_cross_repo_impact: z
    .object({
      generationId: nonEmpty,
      root: symbolNodeSchema,
      impact: impactResultSchema,
      repoIds: stringArray,
    })
    .strict(),
  untangle_complexity: complexityReportSchema,
  untangle_complexity_explain: z
    .object({ symbol: symbolNodeSchema, snapshot: complexitySnapshotSchema })
    .strict(),
  untangle_hotspots: complexityReportSchema,
  untangle_complexity_diff: z
    .object({
      base: nonEmpty,
      head: nonEmpty,
      metricsVersion: nonEmpty,
      entries: z.array(metricDeltaSchema),
      warnings: stringArray,
    })
    .strict(),
  untangle_changes: z
    .object({
      base: nonEmpty,
      head: nonEmpty,
      changes: z.array(changeEventSchema),
      total: nonNegativeInt,
    })
    .strict(),
  untangle_change_search: z
    .object({ query: nonEmpty, changes: z.array(changeEventSchema), total: nonNegativeInt })
    .strict(),
  untangle_quality_gate: qualityGateSchema,
  untangle_about: aboutSchema,
  untangle_portfolio_scan: portfolioScanResultSchema,
  untangle_stack_matrix: stackMatrixResultSchema,
  untangle_who_uses: whoUsesResultSchema,
  untangle_conventions: conventionsResultSchema,
  untangle_archetypes: archetypesResultSchema,
  untangle_tech_radar: techRadarResultSchema,
  untangle_blueprint: blueprintResultSchema,
  untangle_product: productAlignmentReportSchema,
  untangle_boundaries: frontendBoundaryReportSchema,
} as const satisfies Record<UntangleMcpToolName, z.ZodType>;

export type UntangleMcpSuccessDataByOperation = {
  [Name in UntangleMcpToolName]: z.output<(typeof UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS)[Name]>;
};
