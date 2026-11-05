import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./identity.js";
import { compareCodepoints } from "./ordering.js";
import {
  MAX_SEARCH_JOURNEY_ATTEMPTS,
  MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH,
  MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH,
  MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS,
  MAX_SEARCH_JOURNEY_REASON_LENGTH,
  MAX_SEARCH_JOURNEY_TEXT_LENGTH,
  MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH,
  SEARCH_JOURNEY_ABANDON_REASON_CODES,
  SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS,
  SEARCH_JOURNEY_TARGET_CODE_COMPLEXITY_UNAVAILABLE_REASONS,
} from "./types/search-journey.js";
import { INDEX_CONTEXT_INCOMPLETE_WARNING_CODE } from "./types/search.js";
import { DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID } from "./versions.js";

type JsonRecord = Record<string, unknown>;
const SHA256_FINGERPRINT = /^[0-9a-f]{64}$/u;
const UNHEALTHY_SEARCH_WARNING_CODES = new Set([
  INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  "INCOMPLETE_PAYLOAD",
]);

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function only(value: JsonRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function nonEmpty(value: unknown): value is string {
  return text(value) && value.trim() !== "";
}

function boundedText(value: unknown, maximum: number): value is string {
  return text(value) && value.length <= maximum;
}

function boundedNonEmpty(value: unknown, maximum: number): value is string {
  return nonEmpty(value) && value.length <= maximum;
}

function sha256Fingerprint(value: unknown): value is string {
  return text(value) && SHA256_FINGERPRINT.test(value);
}

function optionalSha256Fingerprint(value: unknown): boolean {
  return value === undefined || sha256Fingerprint(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function ratio(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function optionalBoundedNonEmpty(value: unknown, maximum: number): boolean {
  return value === undefined || boundedNonEmpty(value, maximum);
}

function optionalBoundedText(value: unknown, maximum: number): boolean {
  return value === undefined || (text(value) && value.length <= maximum);
}

function executionContext(value: unknown, retainText: boolean): boolean {
  if (value === undefined) return true;
  const item = record(value);
  if (
    item === null ||
    !only(item, ["schemaVersion", "source", ...SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS]) ||
    item["schemaVersion"] !== 1 ||
    item["source"] !== "caller-declared"
  ) {
    return false;
  }
  return SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS.every((dimension) => {
    const entry = item[dimension];
    if (entry === undefined) return dimension === "taskMix" || dimension === "priorContext";
    const field = record(entry);
    return (
      field !== null &&
      only(field, ["fingerprint", "text"]) &&
      sha256Fingerprint(field["fingerprint"]) &&
      (field["text"] === undefined ||
        (retainText &&
          boundedNonEmpty(field["text"], MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH) &&
          field["text"] === field["text"].trim()))
    );
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

function complexitySummary(value: unknown): boolean {
  const item = record(value);
  if (
    item === null ||
    !only(item, [
      "metricsScope",
      "metricsScopeId",
      "metricsVersion",
      "cyclomaticClassic",
      "cyclomaticExtended",
      "cognitive",
      "maxNesting",
      "sloc",
      "halsteadVolume",
      "maintainabilityIndex",
      "riskScore",
    ]) ||
    !["symbol", "file", "chunk"].includes(String(item["metricsScope"])) ||
    !boundedNonEmpty(item["metricsScopeId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !boundedNonEmpty(item["metricsVersion"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH)
  ) {
    return false;
  }
  const countMetricFields = [
    "cyclomaticClassic",
    "cyclomaticExtended",
    "cognitive",
    "maxNesting",
    "sloc",
  ] as const;
  const continuousMetricFields = ["halsteadVolume", "riskScore"] as const;
  const metricFields = [
    ...countMetricFields,
    ...continuousMetricFields,
    "maintainabilityIndex",
  ] as const;
  return (
    metricFields.some((field) => item[field] !== undefined) &&
    countMetricFields.every((field) => item[field] === undefined || integer(item[field])) &&
    continuousMetricFields.every(
      (field) => item[field] === undefined || nonNegative(item[field]),
    ) &&
    (item["maintainabilityIndex"] === undefined ||
      (nonNegative(item["maintainabilityIndex"]) && item["maintainabilityIndex"] <= 100))
  );
}

function sortedUniqueStrings(value: unknown): value is string[] {
  return (
    stringArray(value) &&
    value.every((entry) => boundedNonEmpty(entry, MAX_SEARCH_JOURNEY_LOCATOR_LENGTH)) &&
    new Set(value).size === value.length &&
    value.every(
      (entry, index) => index === 0 || compareCodepoints(value[index - 1] ?? "", entry) < 0,
    )
  );
}

function target(value: unknown): boolean {
  const item = record(value);
  if (
    item === null ||
    !only(item, [
      "repoId",
      "refId",
      "filePath",
      "chunkId",
      "symbolId",
      "embeddingProfileId",
      "indexGeneration",
    ])
  ) {
    return false;
  }
  if (
    !Object.values(item).every((entry) => boundedNonEmpty(entry, MAX_SEARCH_JOURNEY_LOCATOR_LENGTH))
  ) {
    return false;
  }
  return [item["filePath"], item["chunkId"], item["symbolId"]].some(nonEmpty);
}

function retrieval(value: unknown): boolean {
  const item = record(value);
  const branches = record(item?.["branchCandidateCounts"]);
  if (
    item === null ||
    branches === null ||
    !only(item, [
      "branchCandidateCounts",
      "uniqueRetrievedCandidateCount",
      "eligibleCandidateCount",
      "rankedCandidateCount",
      "deduplicatedCandidateCount",
      "qualifiedHitCount",
      "returnedHitCount",
      "uniqueEligibleFileCount",
      "uniqueEligibleSymbolCount",
      "eligibleFileDispersion",
      "topScoreGap",
      "candidateLimitReached",
    ]) ||
    !only(branches, ["dense", "sparse", "symbol"])
  ) {
    return false;
  }
  const counters = [
    branches["dense"],
    branches["sparse"],
    branches["symbol"],
    item["uniqueRetrievedCandidateCount"],
    item["eligibleCandidateCount"],
    item["rankedCandidateCount"],
    item["deduplicatedCandidateCount"],
    item["qualifiedHitCount"],
    item["returnedHitCount"],
    item["uniqueEligibleFileCount"],
    item["uniqueEligibleSymbolCount"],
  ];
  if (
    !counters.every((entry) => integer(entry)) ||
    !ratio(item["eligibleFileDispersion"]) ||
    (item["topScoreGap"] !== null && !finite(item["topScoreGap"])) ||
    typeof item["candidateLimitReached"] !== "boolean"
  ) {
    return false;
  }

  const branchTotal =
    (branches["dense"] as number) + (branches["sparse"] as number) + (branches["symbol"] as number);
  const uniqueRetrieved = item["uniqueRetrievedCandidateCount"] as number;
  const eligible = item["eligibleCandidateCount"] as number;
  const ranked = item["rankedCandidateCount"] as number;
  const deduplicated = item["deduplicatedCandidateCount"] as number;
  const qualified = item["qualifiedHitCount"] as number;
  const returned = item["returnedHitCount"] as number;
  const uniqueFiles = item["uniqueEligibleFileCount"] as number;
  const uniqueSymbols = item["uniqueEligibleSymbolCount"] as number;
  const expectedDispersion = eligible <= 1 ? 0 : (uniqueFiles - 1) / (eligible - 1);
  return (
    uniqueRetrieved <= branchTotal &&
    eligible <= uniqueRetrieved &&
    ranked <= eligible &&
    deduplicated <= ranked &&
    qualified <= deduplicated &&
    returned <= qualified &&
    uniqueFiles <= eligible &&
    uniqueSymbols <= eligible &&
    (eligible === 0 || uniqueFiles >= 1) &&
    Math.abs((item["eligibleFileDispersion"] as number) - expectedDispersion) <= Number.EPSILON &&
    (qualified < 2 ? item["topScoreGap"] === null : item["topScoreGap"] !== null)
  );
}

function candidate(value: unknown): boolean {
  const item = record(value);
  return (
    item !== null &&
    only(item, [
      "repoId",
      "refId",
      "filePath",
      "chunkId",
      "symbolId",
      "symbolFqn",
      "embeddingProfileId",
      "indexGeneration",
      "rank",
      "score",
      "complexity",
      "incompletePayloadFields",
    ]) &&
    boundedNonEmpty(item["repoId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedNonEmpty(item["refId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedText(item["filePath"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedNonEmpty(item["chunkId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    optionalBoundedNonEmpty(item["symbolId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    (item["symbolFqn"] === undefined ||
      boundedText(item["symbolFqn"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH)) &&
    boundedNonEmpty(item["embeddingProfileId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedNonEmpty(item["indexGeneration"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    integer(item["rank"], 1) &&
    finite(item["score"]) &&
    (item["complexity"] === undefined || complexitySummary(item["complexity"])) &&
    (item["incompletePayloadFields"] === undefined ||
      sortedUniqueStrings(item["incompletePayloadFields"]))
  );
}

function profile(value: unknown): boolean {
  const item = record(value);
  if (
    item === null ||
    !only(item, [
      "embeddingProfileId",
      "indexGenerations",
      "corpusRevisionFingerprint",
      "retrievalPerformed",
      "notSearchedReason",
      "retrieval",
      "candidates",
    ]) ||
    !boundedNonEmpty(item["embeddingProfileId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !stringArray(item["indexGenerations"]) ||
    !item["indexGenerations"].every((generation) =>
      boundedNonEmpty(generation, MAX_SEARCH_JOURNEY_LOCATOR_LENGTH),
    ) ||
    !optionalSha256Fingerprint(item["corpusRevisionFingerprint"]) ||
    typeof item["retrievalPerformed"] !== "boolean" ||
    !optionalBoundedText(item["notSearchedReason"], MAX_SEARCH_JOURNEY_REASON_LENGTH) ||
    (item["retrieval"] !== undefined && !retrieval(item["retrieval"])) ||
    !Array.isArray(item["candidates"]) ||
    !item["candidates"].every(candidate)
  ) {
    return false;
  }
  const performed = item["retrievalPerformed"];
  if (
    !performed &&
    (!nonEmpty(item["notSearchedReason"]) ||
      item["retrieval"] !== undefined ||
      item["candidates"].length !== 0)
  ) {
    return false;
  }
  if (performed && item["notSearchedReason"] !== undefined) return false;
  const generations = item["indexGenerations"] as string[];
  const candidates = item["candidates"] as unknown[];
  if (
    candidates.some((entry, index) => {
      const hit = entry as JsonRecord;
      return (
        hit["rank"] !== index + 1 ||
        hit["embeddingProfileId"] !== item["embeddingProfileId"] ||
        !generations.includes(hit["indexGeneration"] as string)
      );
    })
  ) {
    return false;
  }
  const diagnostics = record(item["retrieval"]);
  return diagnostics === null || diagnostics["returnedHitCount"] === candidates.length;
}

function attempt(value: unknown): boolean {
  const item = record(value);
  if (
    item === null ||
    !only(item, [
      "attemptId",
      "sequence",
      "clientStep",
      "observationFingerprint",
      "measurementContextVersion",
      "abstention",
      "queryFingerprint",
      "queryText",
      "rankerVersion",
      "rankingContextFingerprint",
      "resultLimit",
      "candidateLimit",
      "observedAt",
      "status",
      "failureCode",
      "failureReason",
      "warningCodes",
      "retrievalHealthy",
      "profiles",
    ]) ||
    !boundedNonEmpty(item["attemptId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !integer(item["sequence"], 1) ||
    (item["clientStep"] !== undefined &&
      (!integer(item["clientStep"], 1) ||
        (item["clientStep"] as number) > MAX_SEARCH_JOURNEY_ATTEMPTS)) ||
    !sha256Fingerprint(item["observationFingerprint"]) ||
    (item["measurementContextVersion"] !== undefined && item["measurementContextVersion"] !== 2) ||
    // Additiv (schemaVersion bleibt 1). Der Wert geht ausdruecklich in KEINEN
    // Kontextschluessel und in keine Kohortengleichheit ein — sonst wuerden
    // bereits persistierte Journeys in getrennte Kohorten zerfallen.
    (item["abstention"] !== undefined &&
      item["abstention"] !== "strict" &&
      item["abstention"] !== "evidence") ||
    !sha256Fingerprint(item["queryFingerprint"]) ||
    !optionalBoundedText(item["queryText"], MAX_SEARCH_JOURNEY_TEXT_LENGTH) ||
    !boundedNonEmpty(item["rankerVersion"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !optionalSha256Fingerprint(item["rankingContextFingerprint"]) ||
    (item["resultLimit"] !== undefined && !integer(item["resultLimit"], 1)) ||
    (item["candidateLimit"] !== undefined && !integer(item["candidateLimit"], 1)) ||
    !boundedNonEmpty(item["observedAt"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !["succeeded", "failed"].includes(String(item["status"])) ||
    !optionalBoundedNonEmpty(item["failureCode"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !optionalBoundedText(item["failureReason"], MAX_SEARCH_JOURNEY_REASON_LENGTH) ||
    !stringArray(item["warningCodes"]) ||
    !item["warningCodes"].every((code) =>
      boundedNonEmpty(code, MAX_SEARCH_JOURNEY_LOCATOR_LENGTH),
    ) ||
    typeof item["retrievalHealthy"] !== "boolean" ||
    !Array.isArray(item["profiles"]) ||
    !item["profiles"].every(profile)
  ) {
    return false;
  }
  if (
    item["resultLimit"] !== undefined &&
    item["candidateLimit"] !== undefined &&
    (item["candidateLimit"] as number) < (item["resultLimit"] as number)
  ) {
    return false;
  }
  const profiles = item["profiles"] as JsonRecord[];
  if (
    new Set(profiles.map((profileEntry) => profileEntry["embeddingProfileId"] as string)).size !==
    profiles.length
  ) {
    return false;
  }
  if (
    item["retrievalHealthy"] === true &&
    (item["warningCodes"] as string[]).some((code) => UNHEALTHY_SEARCH_WARNING_CODES.has(code))
  ) {
    return false;
  }
  const candidates = profiles.flatMap((profileEntry) => profileEntry["candidates"] as JsonRecord[]);
  const hasModernPayloadEvidence = candidates.every(
    (candidateEntry) => candidateEntry["incompletePayloadFields"] !== undefined,
  );
  if (hasModernPayloadEvidence) {
    const hasIncompleteCandidate = candidates.some(
      (candidateEntry) => (candidateEntry["incompletePayloadFields"] as string[]).length > 0,
    );
    const hasIncompleteWarning = (item["warningCodes"] as string[]).includes("INCOMPLETE_PAYLOAD");
    if (
      hasIncompleteCandidate !== hasIncompleteWarning ||
      (hasIncompleteCandidate && item["retrievalHealthy"] === true)
    ) {
      return false;
    }
  }
  const resultLimit = item["resultLimit"] as number | undefined;
  const candidateLimit = item["candidateLimit"] as number | undefined;
  if (
    resultLimit !== undefined &&
    profiles.some((profileEntry) => {
      const candidates = profileEntry["candidates"] as unknown[];
      const diagnostics = record(profileEntry["retrieval"]);
      return (
        candidates.length > resultLimit ||
        (diagnostics !== null && (diagnostics["returnedHitCount"] as number) > resultLimit)
      );
    })
  ) {
    return false;
  }
  if (
    candidateLimit !== undefined &&
    profiles.some((profileEntry) => {
      const diagnostics = record(profileEntry["retrieval"]);
      if (diagnostics === null) return false;
      const branches = diagnostics["branchCandidateCounts"] as JsonRecord;
      const branchCounts = [branches["dense"], branches["sparse"], branches["symbol"]] as number[];
      return (
        branchCounts.some((count) => count > candidateLimit) ||
        (diagnostics["candidateLimitReached"] === false &&
          branchCounts.some((count) => count >= candidateLimit))
      );
    })
  ) {
    return false;
  }
  if (item["status"] === "failed") {
    return (
      nonEmpty(item["failureCode"]) && item["profiles"].length === 0 && !item["retrievalHealthy"]
    );
  }
  if (item["failureCode"] !== undefined || item["failureReason"] !== undefined) return false;
  return (
    !item["retrievalHealthy"] ||
    (item["profiles"].length > 0 &&
      item["profiles"].every((entry) => (entry as JsonRecord)["retrievalPerformed"] === true))
  );
}

function navigation(value: unknown): boolean {
  const item = record(value);
  return (
    item !== null &&
    only(item, ["eventId", "sequence", "kind", "observedAt", "toolName", "target"]) &&
    boundedNonEmpty(item["eventId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    integer(item["sequence"], 1) &&
    ["open-file", "open-symbol", "graph-query", "other-tool"].includes(String(item["kind"])) &&
    boundedNonEmpty(item["observedAt"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    optionalBoundedNonEmpty(item["toolName"], MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH) &&
    (item["target"] === undefined || target(item["target"]))
  );
}

function abandonReasonCode(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      SEARCH_JOURNEY_ABANDON_REASON_CODES.some((reasonCode) => reasonCode === value))
  );
}

function targetCodeCandidate(value: unknown): boolean {
  const item = record(value);
  return (
    item !== null &&
    only(item, [
      "repoId",
      "refId",
      "filePath",
      "chunkId",
      "symbolId",
      "symbolFqn",
      "embeddingProfileId",
      "indexGeneration",
    ]) &&
    boundedNonEmpty(item["repoId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedNonEmpty(item["refId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedText(item["filePath"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedNonEmpty(item["chunkId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    optionalBoundedNonEmpty(item["symbolId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    (item["symbolFqn"] === undefined ||
      boundedText(item["symbolFqn"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH)) &&
    boundedNonEmpty(item["embeddingProfileId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    boundedNonEmpty(item["indexGeneration"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH)
  );
}

function targetCodeComplexityEvidence(value: unknown): boolean {
  const item = record(value);
  if (item === null || !nonEmpty(item["status"])) return false;
  if (item["status"] === "unavailable") {
    return (
      only(item, ["status", "reason"]) &&
      SEARCH_JOURNEY_TARGET_CODE_COMPLEXITY_UNAVAILABLE_REASONS.some(
        (reason) => reason === item["reason"],
      )
    );
  }
  if (
    item["status"] !== "observed" ||
    !only(item, [
      "status",
      "source",
      "candidate",
      "complexity",
      "payloadComplete",
      "incompletePayloadFields",
    ]) ||
    item["source"] !== "indexed-search-hit" ||
    !targetCodeCandidate(item["candidate"]) ||
    !complexitySummary(item["complexity"]) ||
    typeof item["payloadComplete"] !== "boolean" ||
    !sortedUniqueStrings(item["incompletePayloadFields"])
  ) {
    return false;
  }
  return item["payloadComplete"] === ((item["incompletePayloadFields"] as string[]).length === 0);
}

function assessment(value: unknown): boolean {
  const item = record(value);
  if (
    item === null ||
    !only(item, [
      "schemaVersion",
      "algorithm",
      "isHeuristic",
      "searchesToTarget",
      "successfulSearchesToTarget",
      "failedSearchesToTarget",
      "distinctQueryCount",
      "queryReformulations",
      "acceptedTargetRank",
      "reciprocalRank",
      "targetWasReturned",
      "targetFirstReturnedAtSearch",
      "targetAcceptedAtSearch",
      "selectionLagSearches",
      "directHit",
      "eligibleCandidatesExamined",
      "uniqueCandidatesExposed",
      "uniqueFilesExposed",
      "navigationEventsToTarget",
      "observedToolAndFileHops",
      "meanCandidateFileDispersion",
      "meanCandidateChurn",
      "candidateLimitHitRate",
      "healthyRetrievalRate",
      "acceptedTargetScoreMargin",
      "acceptedTargetCodeComplexity",
      "measurementContextId",
      "measurementContextComplete",
      "caveats",
    ]) ||
    item["schemaVersion"] !== 1 ||
    item["algorithm"] !== DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID ||
    item["isHeuristic"] !== true ||
    !sha256Fingerprint(item["measurementContextId"]) ||
    typeof item["measurementContextComplete"] !== "boolean" ||
    (item["acceptedTargetCodeComplexity"] !== undefined &&
      !targetCodeComplexityEvidence(item["acceptedTargetCodeComplexity"])) ||
    !stringArray(item["caveats"]) ||
    !item["caveats"].every((caveat) => boundedText(caveat, MAX_SEARCH_JOURNEY_REASON_LENGTH))
  ) {
    return false;
  }
  const positiveFields = [
    "searchesToTarget",
    "distinctQueryCount",
    "observedToolAndFileHops",
  ] as const;
  const nonNegativeFields = [
    "successfulSearchesToTarget",
    "failedSearchesToTarget",
    "queryReformulations",
    "eligibleCandidatesExamined",
    "uniqueCandidatesExposed",
    "uniqueFilesExposed",
    "navigationEventsToTarget",
  ] as const;
  const ratios = ["candidateLimitHitRate", "healthyRetrievalRate"] as const;
  const nullableRatios = [
    "reciprocalRank",
    "meanCandidateFileDispersion",
    "meanCandidateChurn",
  ] as const;
  if (!positiveFields.every((field) => integer(item[field], 1))) return false;
  if (!nonNegativeFields.every((field) => integer(item[field]))) return false;
  if (!ratios.every((field) => ratio(item[field]))) return false;
  if (!nullableRatios.every((field) => item[field] === null || ratio(item[field]))) return false;
  if (item["acceptedTargetScoreMargin"] !== null && !finite(item["acceptedTargetScoreMargin"])) {
    return false;
  }
  for (const field of [
    "acceptedTargetRank",
    "targetFirstReturnedAtSearch",
    "targetAcceptedAtSearch",
    "selectionLagSearches",
  ] as const) {
    if (item[field] !== null && !integer(item[field], field === "selectionLagSearches" ? 0 : 1)) {
      return false;
    }
  }
  if (typeof item["targetWasReturned"] !== "boolean" || typeof item["directHit"] !== "boolean") {
    return false;
  }

  const searches = item["searchesToTarget"] as number;
  const distinctQueries = item["distinctQueryCount"] as number;
  const firstReturned = item["targetFirstReturnedAtSearch"] as number | null;
  const acceptedAt = item["targetAcceptedAtSearch"] as number | null;
  const acceptedRank = item["acceptedTargetRank"] as number | null;
  const reciprocalRank = item["reciprocalRank"] as number | null;
  const selectionLag = item["selectionLagSearches"] as number | null;
  const targetWasReturned = item["targetWasReturned"] as boolean;

  if (
    searches !==
      (item["successfulSearchesToTarget"] as number) + (item["failedSearchesToTarget"] as number) ||
    distinctQueries > searches ||
    item["queryReformulations"] !== distinctQueries - 1 ||
    item["observedToolAndFileHops"] !== searches + (item["navigationEventsToTarget"] as number) ||
    (item["uniqueFilesExposed"] as number) > (item["uniqueCandidatesExposed"] as number)
  ) {
    return false;
  }

  if (
    targetWasReturned !== (firstReturned !== null) ||
    targetWasReturned !== (acceptedAt !== null)
  ) {
    return false;
  }
  if (
    firstReturned !== null &&
    (firstReturned > searches ||
      acceptedAt === null ||
      acceptedAt > searches ||
      firstReturned > acceptedAt)
  ) {
    return false;
  }
  if (
    selectionLag !==
    (firstReturned === null || acceptedAt === null ? null : acceptedAt - firstReturned)
  ) {
    return false;
  }
  if (
    acceptedRank === null
      ? reciprocalRank !== null || item["acceptedTargetScoreMargin"] !== null
      : reciprocalRank === null || Math.abs(reciprocalRank - 1 / acceptedRank) > Number.EPSILON
  ) {
    return false;
  }
  if (!targetWasReturned && acceptedRank !== null) return false;

  return item["directHit"] === (searches === 1 && acceptedAt === 1 && acceptedRank === 1);
}

function attemptContextKey(attempt: JsonRecord): string {
  const profiles = (attempt["profiles"] as JsonRecord[])
    .map((profileEntry) => {
      const generations = profileEntry["indexGenerations"] as string[];
      return {
        embeddingProfileId: profileEntry["embeddingProfileId"],
        indexGenerations:
          generations.length === 0 ? ["unknown"] : [...generations].sort(compareCodepoints),
        corpusRevisionFingerprint: profileEntry["corpusRevisionFingerprint"] ?? "unknown",
      };
    })
    .sort((left, right) => compareCodepoints(canonicalJson(left), canonicalJson(right)));
  return canonicalJson({
    rankerVersion: attempt["rankerVersion"],
    rankingContextFingerprint: attempt["rankingContextFingerprint"] ?? "unknown",
    resultLimit: attempt["resultLimit"] ?? "unknown",
    candidateLimit: attempt["candidateLimit"] ?? "unknown",
    profiles,
  });
}

function legacyMeasurementContextId(attempts: readonly JsonRecord[]): string {
  const rankers = [...new Set(attempts.map((entry) => entry["rankerVersion"] as string))].sort(
    compareCodepoints,
  );
  const profiles = [
    ...new Set(
      attempts.flatMap((entry) =>
        (entry["profiles"] as JsonRecord[]).flatMap((profileEntry) => {
          const generations = profileEntry["indexGenerations"] as string[];
          return generations.length === 0
            ? [`${profileEntry["embeddingProfileId"] as string}\u001funknown`]
            : generations.map(
                (generation) =>
                  `${profileEntry["embeddingProfileId"] as string}\u001f${generation}`,
              );
        }),
      ),
    ),
  ].sort(compareCodepoints);
  const rankingContexts = [
    ...new Set(
      attempts.map(
        (entry) => (entry["rankingContextFingerprint"] as string | undefined) ?? "unknown",
      ),
    ),
  ].sort(compareCodepoints);
  const limits = [
    ...new Set(
      attempts.map(
        (entry) =>
          `${String(entry["resultLimit"] ?? "unknown")}\u001f${String(
            entry["candidateLimit"] ?? "unknown",
          )}`,
      ),
    ),
  ].sort(compareCodepoints);
  return sha256Hex(canonicalJson({ rankers, profiles, rankingContexts, limits }));
}

function measurementContextId(attempts: readonly JsonRecord[]): string {
  const contextualAttempts = attempts.some((entry) => entry["status"] === "succeeded")
    ? attempts.filter((entry) => entry["status"] === "succeeded")
    : attempts;
  if (contextualAttempts.every((entry) => entry["measurementContextVersion"] === undefined)) {
    return legacyMeasurementContextId(contextualAttempts);
  }
  const attemptContexts = [...new Set(contextualAttempts.map(attemptContextKey))].sort(
    compareCodepoints,
  );
  return sha256Hex(canonicalJson({ schemaVersion: 2, attemptContexts }));
}

function measurementContextIsComplete(attempts: readonly JsonRecord[]): boolean {
  const versioned = attempts.some((entry) => entry["measurementContextVersion"] !== undefined);
  return (
    attempts.length > 0 &&
    attempts.every((entry) => {
      const profiles = entry["profiles"] as JsonRecord[];
      return (
        (!versioned || entry["measurementContextVersion"] === 2) &&
        entry["status"] === "succeeded" &&
        entry["retrievalHealthy"] === true &&
        entry["rankingContextFingerprint"] !== undefined &&
        entry["resultLimit"] !== undefined &&
        entry["candidateLimit"] !== undefined &&
        profiles.length > 0 &&
        profiles.every((profileEntry) => {
          const generations = profileEntry["indexGenerations"] as string[];
          return (
            (!versioned || profileEntry["corpusRevisionFingerprint"] !== undefined) &&
            profileEntry["retrieval"] !== undefined &&
            generations.length > 0 &&
            generations.every((generation) => generation !== "unknown")
          );
        })
      );
    }) &&
    new Set(attempts.map(attemptContextKey)).size === 1
  );
}

function candidateIdentity(candidateEntry: JsonRecord): string {
  return canonicalJson([
    candidateEntry["embeddingProfileId"],
    candidateEntry["indexGeneration"],
    candidateEntry["repoId"],
    candidateEntry["refId"],
    candidateEntry["chunkId"],
  ]);
}

function candidateCodeEvidence(candidateEntry: JsonRecord): string {
  return canonicalJson({
    complexity: candidateEntry["complexity"] ?? null,
    incompletePayloadFields: candidateEntry["incompletePayloadFields"] ?? null,
  });
}

function candidateMatchesTarget(candidateEntry: JsonRecord, targetEntry: JsonRecord): boolean {
  return [
    "repoId",
    "refId",
    "filePath",
    "chunkId",
    "symbolId",
    "embeddingProfileId",
    "indexGeneration",
  ].every(
    (field) => targetEntry[field] === undefined || candidateEntry[field] === targetEntry[field],
  );
}

function compareCandidateRecords(left: JsonRecord, right: JsonRecord): number {
  return (
    (left["rank"] as number) - (right["rank"] as number) ||
    compareCodepoints(
      left["embeddingProfileId"] as string,
      right["embeddingProfileId"] as string,
    ) ||
    compareCodepoints(left["indexGeneration"] as string, right["indexGeneration"] as string) ||
    compareCodepoints(left["repoId"] as string, right["repoId"] as string) ||
    compareCodepoints(left["refId"] as string, right["refId"] as string) ||
    compareCodepoints(left["filePath"] as string, right["filePath"] as string) ||
    compareCodepoints(left["chunkId"] as string, right["chunkId"] as string)
  );
}

function expectedTargetCodeComplexityEvidence(
  acceptedCandidates: readonly JsonRecord[],
  acceptedCandidate: JsonRecord | null,
): JsonRecord {
  if (acceptedCandidates.length === 0) {
    return { status: "unavailable", reason: "target-not-returned" };
  }
  if (
    acceptedCandidate === null ||
    new Set(acceptedCandidates.map(candidateIdentity)).size !== 1 ||
    new Set(acceptedCandidates.map(candidateCodeEvidence)).size !== 1
  ) {
    return { status: "unavailable", reason: "target-context-ambiguous" };
  }
  const incompleteFields = acceptedCandidate["incompletePayloadFields"];
  if (incompleteFields === undefined) {
    return { status: "unavailable", reason: "legacy-observation" };
  }
  if (acceptedCandidate["complexity"] === undefined) {
    return { status: "unavailable", reason: "complexity-not-indexed" };
  }
  const normalizedIncompleteFields = [...(incompleteFields as string[])].sort(compareCodepoints);
  return {
    status: "observed",
    source: "indexed-search-hit",
    candidate: {
      repoId: acceptedCandidate["repoId"],
      refId: acceptedCandidate["refId"],
      filePath: acceptedCandidate["filePath"],
      chunkId: acceptedCandidate["chunkId"],
      ...(acceptedCandidate["symbolId"] === undefined
        ? {}
        : { symbolId: acceptedCandidate["symbolId"] }),
      ...(acceptedCandidate["symbolFqn"] === undefined
        ? {}
        : { symbolFqn: acceptedCandidate["symbolFqn"] }),
      embeddingProfileId: acceptedCandidate["embeddingProfileId"],
      indexGeneration: acceptedCandidate["indexGeneration"],
    },
    complexity: acceptedCandidate["complexity"],
    payloadComplete: normalizedIncompleteFields.length === 0,
    incompletePayloadFields: normalizedIncompleteFields,
  };
}

function jaccardDistance(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return 1 - intersection / union.size;
}

function assessmentMatchesObservedSession(
  attempts: readonly JsonRecord[],
  navigationEvents: readonly JsonRecord[],
  targetValue: unknown,
  value: unknown,
  acceptedAttemptId?: string,
): boolean {
  const item = record(value);
  const targetEntry = record(targetValue);
  if (item === null || targetEntry === null || !target(targetEntry) || !assessment(item)) {
    return false;
  }
  const searches = item["searchesToTarget"] as number;
  if (searches > attempts.length) return false;
  const explicitlyAcceptedAttempt =
    acceptedAttemptId === undefined
      ? undefined
      : attempts.find((entry) => entry["attemptId"] === acceptedAttemptId);
  if (acceptedAttemptId !== undefined && explicitlyAcceptedAttempt === undefined) return false;
  const observedAttempts =
    explicitlyAcceptedAttempt === undefined
      ? attempts.slice(0, searches)
      : attempts.filter(
          (entry) =>
            (entry["sequence"] as number) <= (explicitlyAcceptedAttempt["sequence"] as number),
        );
  if (observedAttempts.length !== searches) return false;
  const successful = observedAttempts.filter((entry) => entry["status"] === "succeeded").length;
  const healthy = observedAttempts.filter((entry) => entry["retrievalHealthy"] === true).length;
  const distinctQueries = new Set(observedAttempts.map((entry) => entry["queryFingerprint"])).size;
  const profiles = observedAttempts.flatMap((entry) => entry["profiles"] as JsonRecord[]);
  const candidates = profiles.flatMap((profileEntry) => profileEntry["candidates"] as JsonRecord[]);
  const retrievals = profiles.flatMap((profileEntry) => {
    const retrievalEntry = record(profileEntry["retrieval"]);
    return retrievalEntry === null ? [] : [retrievalEntry];
  });
  const uniqueCandidates = new Set(candidates.map(candidateIdentity)).size;
  const uniqueFiles = new Set(
    candidates.map(
      (candidateEntry) =>
        `${candidateEntry["repoId"] as string}\u001f${candidateEntry["refId"] as string}\u001f${candidateEntry["filePath"] as string}`,
    ),
  ).size;
  const retrievedAttempts = observedAttempts.filter(
    (entry) =>
      entry["status"] === "succeeded" &&
      (entry["profiles"] as JsonRecord[]).some(
        (profileEntry) => profileEntry["retrievalPerformed"] === true,
      ),
  );
  const limitHits = retrievedAttempts.filter((entry) =>
    (entry["profiles"] as JsonRecord[]).some(
      (profileEntry) => record(profileEntry["retrieval"])?.["candidateLimitReached"] === true,
    ),
  ).length;
  const expectedLimitRate =
    retrievedAttempts.length === 0 ? 0 : limitHits / retrievedAttempts.length;
  const dispersionWeight = retrievals.reduce(
    (sum, retrievalEntry) => sum + (retrievalEntry["eligibleCandidateCount"] as number),
    0,
  );
  const expectedDispersion =
    dispersionWeight === 0
      ? null
      : retrievals.reduce(
          (sum, retrievalEntry) =>
            sum +
            (retrievalEntry["eligibleFileDispersion"] as number) *
              (retrievalEntry["eligibleCandidateCount"] as number),
          0,
        ) / dispersionWeight;
  const candidateSets = retrievedAttempts.map(
    (entry) =>
      new Set(
        (entry["profiles"] as JsonRecord[]).flatMap((profileEntry) =>
          (profileEntry["candidates"] as JsonRecord[]).map(candidateIdentity),
        ),
      ),
  );
  const churnDistances = candidateSets
    .slice(1)
    .map((current, index) => jaccardDistance(candidateSets[index] as ReadonlySet<string>, current));
  const expectedChurn =
    churnDistances.length === 0
      ? null
      : churnDistances.reduce((sum, distance) => sum + distance, 0) / churnDistances.length;
  const attemptsWithTarget = observedAttempts.filter((entry) =>
    (entry["profiles"] as JsonRecord[]).some((profileEntry) =>
      (profileEntry["candidates"] as JsonRecord[]).some((candidateEntry) =>
        candidateMatchesTarget(candidateEntry, targetEntry),
      ),
    ),
  );
  if (
    explicitlyAcceptedAttempt !== undefined &&
    !attemptsWithTarget.some(
      (entry) => entry["attemptId"] === explicitlyAcceptedAttempt["attemptId"],
    )
  ) {
    return false;
  }
  const acceptedAttempt = explicitlyAcceptedAttempt ?? attemptsWithTarget.at(-1) ?? null;
  const acceptedAt = (acceptedAttempt?.["sequence"] as number | undefined) ?? null;
  const firstReturnedAt = (attemptsWithTarget[0]?.["sequence"] as number | undefined) ?? null;
  const acceptedCandidates =
    acceptedAttempt === null
      ? []
      : (acceptedAttempt["profiles"] as JsonRecord[])
          .flatMap((profileEntry) => profileEntry["candidates"] as JsonRecord[])
          .filter((candidateEntry) => candidateMatchesTarget(candidateEntry, targetEntry))
          .sort(compareCandidateRecords);
  const acceptedContexts = new Set(
    acceptedCandidates.map(
      (candidateEntry) =>
        `${candidateEntry["embeddingProfileId"] as string}\u001f${candidateEntry["indexGeneration"] as string}`,
    ),
  );
  const acceptedCandidate = acceptedContexts.size <= 1 ? (acceptedCandidates[0] ?? null) : null;
  const acceptedRank = (acceptedCandidate?.["rank"] as number | undefined) ?? null;
  let acceptedMargin: number | null = null;
  if (acceptedCandidate !== null && acceptedAttempt !== null) {
    const sameProfileCandidates = (acceptedAttempt["profiles"] as JsonRecord[])
      .filter(
        (profileEntry) =>
          profileEntry["embeddingProfileId"] === acceptedCandidate["embeddingProfileId"],
      )
      .flatMap((profileEntry) => profileEntry["candidates"] as JsonRecord[])
      .filter(
        (candidateEntry) =>
          candidateEntry["indexGeneration"] === acceptedCandidate["indexGeneration"] &&
          candidateIdentity(candidateEntry) !== candidateIdentity(acceptedCandidate),
      )
      .sort(
        (left, right) =>
          (right["score"] as number) - (left["score"] as number) ||
          compareCandidateRecords(left, right),
      );
    const competitor = sameProfileCandidates[0];
    if (competitor !== undefined) {
      acceptedMargin = (acceptedCandidate["score"] as number) - (competitor["score"] as number);
    }
  }
  const suppliedMargin = item["acceptedTargetScoreMargin"] as number | null;
  const suppliedDispersion = item["meanCandidateFileDispersion"] as number | null;
  const suppliedChurn = item["meanCandidateChurn"] as number | null;
  const suppliedCodeComplexity = item["acceptedTargetCodeComplexity"];
  const expectedCodeComplexity = expectedTargetCodeComplexityEvidence(
    acceptedCandidates,
    acceptedCandidate,
  );

  return (
    (explicitlyAcceptedAttempt === undefined
      ? searches === attempts.length || acceptedAt === searches
      : acceptedAt === searches) &&
    item["successfulSearchesToTarget"] === successful &&
    item["failedSearchesToTarget"] === searches - successful &&
    item["distinctQueryCount"] === distinctQueries &&
    item["navigationEventsToTarget"] === navigationEvents.length &&
    item["eligibleCandidatesExamined"] ===
      retrievals.reduce(
        (sum, retrievalEntry) => sum + (retrievalEntry["eligibleCandidateCount"] as number),
        0,
      ) &&
    item["uniqueCandidatesExposed"] === uniqueCandidates &&
    item["uniqueFilesExposed"] === uniqueFiles &&
    Math.abs((item["healthyRetrievalRate"] as number) - healthy / searches) <= Number.EPSILON &&
    Math.abs((item["candidateLimitHitRate"] as number) - expectedLimitRate) <= Number.EPSILON &&
    (suppliedDispersion === null || expectedDispersion === null
      ? suppliedDispersion === expectedDispersion
      : Math.abs(suppliedDispersion - expectedDispersion) <= Number.EPSILON) &&
    (suppliedChurn === null || expectedChurn === null
      ? suppliedChurn === expectedChurn
      : Math.abs(suppliedChurn - expectedChurn) <= Number.EPSILON) &&
    item["measurementContextId"] === measurementContextId(observedAttempts) &&
    item["measurementContextComplete"] === measurementContextIsComplete(observedAttempts) &&
    item["targetWasReturned"] === (acceptedAttempt !== null) &&
    item["targetFirstReturnedAtSearch"] === firstReturnedAt &&
    item["targetAcceptedAtSearch"] === acceptedAt &&
    item["acceptedTargetRank"] === acceptedRank &&
    item["reciprocalRank"] === (acceptedRank === null ? null : 1 / acceptedRank) &&
    item["selectionLagSearches"] ===
      (acceptedAt === null || firstReturnedAt === null ? null : acceptedAt - firstReturnedAt) &&
    item["directHit"] === (searches === 1 && acceptedAt === 1 && acceptedRank === 1) &&
    (suppliedMargin === null || acceptedMargin === null
      ? suppliedMargin === acceptedMargin
      : Math.abs(suppliedMargin - acceptedMargin) <= Number.EPSILON) &&
    (suppliedCodeComplexity === undefined ||
      canonicalJson(suppliedCodeComplexity) === canonicalJson(expectedCodeComplexity))
  );
}

/**
 * Vollstaendige fail-closed Laufzeitpruefung fuer lokal persistierte Journeys.
 * Sie prueft neben der Shape auch Status/Outcome, Reihenfolge und Text-Retention.
 */
export function searchJourneyValidationIssue(value: unknown): string | null {
  const item = record(value);
  if (
    item === null ||
    !only(item, [
      "schemaVersion",
      "revision",
      "sessionId",
      "workspaceId",
      "status",
      "recordingConsent",
      "retainText",
      "goal",
      "feature",
      "executionContext",
      "createdAt",
      "updatedAt",
      "attempts",
      "navigation",
      "outcome",
    ]) ||
    item["schemaVersion"] !== 1 ||
    !integer(item["revision"]) ||
    !boundedNonEmpty(item["sessionId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !boundedNonEmpty(item["workspaceId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !["active", "completed", "abandoned"].includes(String(item["status"])) ||
    item["recordingConsent"] !== "explicit" ||
    typeof item["retainText"] !== "boolean" ||
    !boundedNonEmpty(item["createdAt"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !boundedNonEmpty(item["updatedAt"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) ||
    !Array.isArray(item["attempts"]) ||
    item["attempts"].length > MAX_SEARCH_JOURNEY_ATTEMPTS ||
    !item["attempts"].every(attempt) ||
    !Array.isArray(item["navigation"]) ||
    item["navigation"].length > MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS ||
    !item["navigation"].every(navigation)
  ) {
    return "shape mismatch";
  }
  const goal = record(item["goal"]);
  if (
    goal === null ||
    !only(goal, ["fingerprint", "text"]) ||
    !sha256Fingerprint(goal["fingerprint"]) ||
    !optionalBoundedText(goal["text"], MAX_SEARCH_JOURNEY_TEXT_LENGTH) ||
    (goal["text"] !== undefined && !nonEmpty(goal["text"]))
  ) {
    return "invalid goal";
  }
  const feature = item["feature"] === undefined ? undefined : record(item["feature"]);
  if (
    feature === null ||
    (feature !== undefined &&
      (!only(feature, ["fingerprint", "text"]) ||
        !sha256Fingerprint(feature["fingerprint"]) ||
        !optionalBoundedText(feature["text"], MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH) ||
        (feature["text"] !== undefined && !nonEmpty(feature["text"]))))
  ) {
    return "invalid feature";
  }
  if (!executionContext(item["executionContext"], item["retainText"] as boolean)) {
    return "invalid execution context or text retention";
  }
  const attempts = item["attempts"] as JsonRecord[];
  if (
    attempts.some((entry, index) => entry["sequence"] !== index + 1) ||
    new Set(attempts.map((entry) => entry["attemptId"])).size !== attempts.length
  ) {
    return "invalid attempt ordering";
  }
  const numbered = attempts.filter((entry) => entry["clientStep"] !== undefined);
  if (
    numbered.length !== 0 &&
    (numbered.length !== attempts.length ||
      new Set(numbered.map((entry) => entry["clientStep"])).size !== numbered.length ||
      numbered.some(
        (entry, index) =>
          index > 0 &&
          (entry["clientStep"] as number) <= (numbered[index - 1]?.["clientStep"] as number),
      ))
  ) {
    return "invalid client-step ordering";
  }
  if (
    item["status"] === "completed" &&
    numbered.length > 0 &&
    Math.max(...numbered.map((entry) => entry["clientStep"] as number)) !== numbered.length
  ) {
    return "completed journey has missing client steps";
  }
  const navigationEvents = item["navigation"] as JsonRecord[];
  if (
    navigationEvents.some((entry, index) => entry["sequence"] !== index + 1) ||
    new Set(navigationEvents.map((entry) => entry["eventId"])).size !== navigationEvents.length
  ) {
    return "invalid navigation ordering";
  }
  if (
    item["retainText"] === false &&
    (goal["text"] !== undefined ||
      feature?.["text"] !== undefined ||
      attempts.some(
        (entry) => entry["queryText"] !== undefined || entry["failureReason"] !== undefined,
      ))
  ) {
    return "text retention violates consent";
  }

  const outcome = record(item["outcome"]);
  if (item["status"] === "active") {
    return item["outcome"] === undefined ? null : "active journey has outcome";
  }
  if (outcome === null) return "terminal journey has no outcome";
  if (item["status"] === "completed") {
    return only(outcome, ["kind", "completedAt", "target", "acceptedAttemptId", "assessment"]) &&
      outcome["kind"] === "completed" &&
      boundedNonEmpty(outcome["completedAt"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
      optionalBoundedNonEmpty(outcome["acceptedAttemptId"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
      target(outcome["target"]) &&
      assessmentMatchesObservedSession(
        attempts,
        navigationEvents,
        outcome["target"],
        outcome["assessment"],
        outcome["acceptedAttemptId"] as string | undefined,
      )
      ? null
      : "invalid completed outcome";
  }
  return only(outcome, ["kind", "abandonedAt", "reasonCode", "reason"]) &&
    outcome["kind"] === "abandoned" &&
    boundedNonEmpty(outcome["abandonedAt"], MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) &&
    abandonReasonCode(outcome["reasonCode"]) &&
    (item["retainText"] === true || outcome["reason"] === undefined) &&
    optionalBoundedText(outcome["reason"], MAX_SEARCH_JOURNEY_REASON_LENGTH)
    ? null
    : "invalid abandoned outcome";
}

export function isSearchJourneyV1(value: unknown): boolean {
  return searchJourneyValidationIssue(value) === null;
}
