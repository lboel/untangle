/**
 * Echte, task-basierte Agenten-Suchwege (Dynamic Search Complexity).
 *
 * Abgrenzung:
 * - Cognitive Complexity misst Kontrollfluss in Code.
 * - Findability misst synthetische Selbstsuche eines bekannten Symbols.
 * - Search Journeys beobachten mehrere reale Suchversuche bis ein Agent oder
 *   Mensch das Ziel ausdruecklich bestaetigt.
 *
 * Ohne diese Bestaetigung darf der Vertrag weder Precision noch
 * Produktkomplexitaet behaupten.
 */
import type { PortCallOptions } from "../ports.js";
import type { DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID } from "../versions.js";

import type { ComplexitySummaryV1 } from "./complexity.js";
import type { SearchAbstention, SearchRetrievalDiagnosticsV1 } from "./search.js";

export const SEARCH_JOURNEY_STATUSES = ["active", "completed", "abandoned"] as const;
export type SearchJourneyStatus = (typeof SEARCH_JOURNEY_STATUSES)[number];
export const MINIMUM_PRODUCT_COMPLEXITY_SESSIONS = 3;
export const MAX_SEARCH_JOURNEY_ATTEMPTS = 128;
export const MAX_SEARCH_JOURNEY_NAVIGATION_EVENTS = 512;
/** UTF-16 code units, aligned with MCP string validation. */
export const MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH = 256;
/** Free task/search text retained only after explicit consent. */
export const MAX_SEARCH_JOURNEY_TEXT_LENGTH = 4_096;
/** Any one persisted target/candidate locator component. */
export const MAX_SEARCH_JOURNEY_LOCATOR_LENGTH = 4_096;
/** Free failure/abandon detail retained only after explicit consent. */
export const MAX_SEARCH_JOURNEY_REASON_LENGTH = 4_096;
/** Explicitly reported navigation tool name. */
export const MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH = 4_096;
/** Bounded caller labels; never inferred from the calling agent or repository. */
export const MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH = 256;
export const SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS = [
  "agentModel",
  "harness",
  "searchStrategy",
  "taskClass",
  "taskMix",
  "priorContext",
] as const;
export type SearchJourneyExecutionContextDimension =
  (typeof SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS)[number];

/** Explicit caller declarations, not independently verified agent telemetry. */
export interface SearchJourneyExecutionContextInputV1 {
  agentModel: string;
  harness: string;
  searchStrategy: string;
  taskClass: string;
  taskMix?: string;
  priorContext?: string;
}

/** Each dimension uses a separate workspace-local HMAC domain. */
export interface SearchJourneyExecutionContextValueV1 {
  fingerprint: string;
  /** Retained only with explicit retainText consent. */
  text?: string;
}

export interface SearchJourneyExecutionContextV1 {
  schemaVersion: 1;
  source: "caller-declared";
  agentModel: SearchJourneyExecutionContextValueV1;
  harness: SearchJourneyExecutionContextValueV1;
  searchStrategy: SearchJourneyExecutionContextValueV1;
  taskClass: SearchJourneyExecutionContextValueV1;
  taskMix?: SearchJourneyExecutionContextValueV1;
  priorContext?: SearchJourneyExecutionContextValueV1;
}

export interface SearchJourneyExecutionContextEvidenceV1 {
  status: "caller-declared" | "not-recorded";
  fingerprint?: string;
  /** Missing dimensions are uncontrolled, never retroactively inferred. */
  uncontrolledDimensions: SearchJourneyExecutionContextDimension[];
}

export interface SearchJourneyGoalV1 {
  /** Workspace-lokaler, domain-separierter HMAC-SHA-256 des getrimmten Zieltexts. */
  fingerprint: string;
  /** Nur bei ausdruecklichem `retainText`; lokale Persistenz, nie noetig. */
  text?: string;
}

/**
 * Stabile, vom Aufrufer vergebene Produkt-/Feature-Einheit einer Journey.
 * Wie das freie Ziel wird ihre Kennung standardmaessig nur als
 * workspace-lokaler HMAC persistiert.
 */
export interface SearchJourneyFeatureV1 {
  fingerprint: string;
  /** Nur bei ausdruecklichem `retainText`; enthaelt die getrimmte Feature-ID. */
  text?: string;
}

/** Schlanker Trefferbezug; niemals Chunk-Inhalt oder Quelltext. */
export interface SearchJourneyCandidateV1 {
  repoId: string;
  refId: string;
  filePath: string;
  chunkId: string;
  symbolId?: string;
  symbolFqn?: string;
  embeddingProfileId: string;
  indexGeneration: string;
  /** Profil-lokaler, 1-basierter Rang. */
  rank: number;
  score: number;
  /** Statische, mit genau dieser Indexgeneration gelieferte Code-Metriken. */
  complexity?: ComplexitySummaryV1;
  /**
   * Fehlende Payloadfelder des Suchtreffers. Neue Writer setzen immer ein
   * Array; `undefined` kennzeichnet eine Legacy-Beobachtung.
   */
  incompletePayloadFields?: string[];
}

/**
 * Ziel-Locator. Mindestens `chunkId`, `symbolId` oder `filePath` muss gesetzt
 * sein; Implementierungen lehnen leere Locators ab. Alle gesetzten Felder
 * muessen fuer einen Match uebereinstimmen.
 */
export interface SearchJourneyTargetV1 {
  repoId?: string;
  refId?: string;
  filePath?: string;
  chunkId?: string;
  symbolId?: string;
  embeddingProfileId?: string;
  indexGeneration?: string;
}

export interface SearchJourneyProfileObservationV1 {
  embeddingProfileId: string;
  indexGenerations: string[];
  /** Immutable fingerprint of the completed corpus revisions searched. */
  corpusRevisionFingerprint?: string;
  retrievalPerformed: boolean;
  notSearchedReason?: string;
  retrieval?: SearchRetrievalDiagnosticsV1;
  candidates: SearchJourneyCandidateV1[];
}

export interface SearchJourneyAttemptV1 {
  attemptId: string;
  /** 1-basierte Reihenfolge innerhalb der Session. */
  sequence: number;
  /** Explizite Agentenreihenfolge fuer idempotente/parallele MCP-Aufrufe. */
  clientStep?: number;
  /** Fingerabdruck der beobachteten Ergebnis-Metadaten. */
  observationFingerprint: string;
  /** Fehlt nur bei vor der unveraenderlichen Korpusrevision gespeicherten Journeys. */
  measurementContextVersion?: 2;
  /**
   * Unter welchem Abstinenzverhalten dieser Versuch lief.
   *
   * ABWESENHEIT heisst: fuer keine Gruppe dieses Versuchs wurde eine
   * Relevanzpolicy konsultiert — dann sind beide Verhalten beweisbar
   * identisch. Sie heisst NICHT `strict`, und sie wird NIE aus einer leeren
   * Kandidatenliste erschlossen.
   *
   * `schemaVersion` bleibt 1: das Feld ist additiv, und bereits persistierte
   * Datensaetze bleiben ohne Migration lesbar.
   */
  abstention?: SearchAbstention;
  /** Workspace-lokaler, domain-separierter HMAC-SHA-256 des getrimmten Suchtexts. */
  queryFingerprint: string;
  /** Nur bei `retainText`. */
  queryText?: string;
  rankerVersion: string;
  /** Wirksamer Suchmodus, Gewichte und Ranking-Policy als stabiler Fingerabdruck. */
  rankingContextFingerprint?: string;
  /** Effektives Ausgabelimit nach Konfigurations-Clamping. */
  resultLimit?: number;
  /** Effektives Kandidatenlimit je Retrieval-Zweig. */
  candidateLimit?: number;
  observedAt: string;
  status: "succeeded" | "failed";
  failureCode?: string;
  /** Freitext nur bei `retainText`; standardmaessig bleibt allein der Code. */
  failureReason?: string;
  warningCodes: string[];
  /** False bei Provider-/Profil-Ausfall oder nicht durchsuchter Gruppe. */
  retrievalHealthy: boolean;
  profiles: SearchJourneyProfileObservationV1[];
}

export const SEARCH_JOURNEY_NAVIGATION_KINDS = [
  "open-file",
  "open-symbol",
  "graph-query",
  "other-tool",
] as const;
export type SearchJourneyNavigationKind = (typeof SEARCH_JOURNEY_NAVIGATION_KINDS)[number];

export interface SearchJourneyNavigationEventV1 {
  eventId: string;
  sequence: number;
  kind: SearchJourneyNavigationKind;
  observedAt: string;
  toolName?: string;
  target?: SearchJourneyTargetV1;
}

export const SEARCH_JOURNEY_TARGET_CODE_COMPLEXITY_UNAVAILABLE_REASONS = [
  "target-not-returned",
  "target-context-ambiguous",
  "complexity-not-indexed",
  "legacy-observation",
] as const;

export type SearchJourneyTargetCodeComplexityUnavailableReason =
  (typeof SEARCH_JOURNEY_TARGET_CODE_COMPLEXITY_UNAVAILABLE_REASONS)[number];

/** Provenienz des einen Treffer-Chunks, dessen Code-Metriken bestaetigt wurden. */
export interface SearchJourneyTargetCodeCandidateV1 {
  repoId: string;
  refId: string;
  filePath: string;
  chunkId: string;
  symbolId?: string;
  symbolFqn?: string;
  embeddingProfileId: string;
  indexGeneration: string;
}

/**
 * Statische Code-Komplexitaet am bestaetigten Treffer. Sie bleibt eine
 * eigene Evidenzachse und wird nie in den Suchaufwand eingerechnet.
 */
export type SearchJourneyTargetCodeComplexityEvidenceV1 =
  | {
      status: "observed";
      source: "indexed-search-hit";
      candidate: SearchJourneyTargetCodeCandidateV1;
      complexity: ComplexitySummaryV1;
      payloadComplete: boolean;
      incompletePayloadFields: string[];
    }
  | {
      status: "unavailable";
      reason: SearchJourneyTargetCodeComplexityUnavailableReason;
    };

export interface DynamicSearchComplexityV1 {
  schemaVersion: 1;
  algorithm: typeof DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID;
  isHeuristic: true;
  /** Suchaufrufe bis zum Abschluss oder bis zu einem explizit akzeptierten Versuch. */
  searchesToTarget: number;
  successfulSearchesToTarget: number;
  failedSearchesToTarget: number;
  distinctQueryCount: number;
  /** Verschiedene Query-Fingerprints minus eins. */
  queryReformulations: number;
  /** Profil-lokaler Rang des bestaetigten Treffers; null bei extern gefundenem Ziel. */
  acceptedTargetRank: number | null;
  /** Reciprocal Rank des bestaetigten Treffers; null ohne Treffer im Ergebnis. */
  reciprocalRank: number | null;
  targetWasReturned: boolean;
  /** Erster Versuch, in dem das spaeter bestaetigte Ziel sichtbar war. */
  targetFirstReturnedAtSearch: number | null;
  /** Explizit akzeptierter oder, ohne Attempt-ID, letzter passender Versuch. */
  targetAcceptedAtSearch: number | null;
  /** Differenz aus Akzeptanz- und Erstpraesentationsversuch. */
  selectionLagSearches: number | null;
  directHit: boolean;
  /** Zulässige Kandidaten aller Versuche bis zum Ziel. */
  eligibleCandidatesExamined: number;
  /** Eindeutige ausgegebene Kandidaten bis zum Ziel. */
  uniqueCandidatesExposed: number;
  /** Eindeutige Dateien in ausgegebenen Kandidaten bis zum Ziel. */
  uniqueFilesExposed: number;
  /** Vom Agenten explizit gemeldete Navigationsschritte. */
  navigationEventsToTarget: number;
  /** Suchaufrufe + explizit gemeldete Navigationsschritte. */
  observedToolAndFileHops: number;
  /** Mittel der kandidatengewichteten Dateistreuung, oder null ohne Diagnostik. */
  meanCandidateFileDispersion: number | null;
  /** Mittlere Jaccard-Distanz aufeinanderfolgender erfolgreicher Hitlisten. */
  meanCandidateChurn: number | null;
  /** Anteil der Versuche, die mindestens ein Kandidatenlimit erreichten. */
  candidateLimitHitRate: number;
  healthyRetrievalRate: number;
  /**
   * Score des Ziels minus staerkster Konkurrenz innerhalb derselben
   * Profilgruppe: positiv bei Rang 1, negativ wenn ein Treffer davor lag.
   */
  acceptedTargetScoreMargin: number | null;
  /**
   * Additive v1-Evidenz. Optional nur, damit bereits persistierte Journeys
   * lesbar bleiben; neue Abschluesse setzen das diskriminierte Feld immer.
   */
  acceptedTargetCodeComplexity?: SearchJourneyTargetCodeComplexityEvidenceV1;
  /** Kontextschluessel; nur gleiche Schluessel duerfen aggregiert werden. */
  measurementContextId: string;
  /** False, wenn wirksame Policy, Limits, Profile oder Generationen unbekannt sind. */
  measurementContextComplete: boolean;
  caveats: string[];
}

export interface SearchJourneyCompletedOutcomeV1 {
  kind: "completed";
  completedAt: string;
  target: SearchJourneyTargetV1;
  /**
   * Exakte Identitaet des vom Caller ausdruecklich akzeptierten Versuchs.
   * Optional, damit persistierte Legacy-Outcomes ohne dieses Feld lesbar
   * bleiben und weiterhin die bisherige Last-Match-Semantik verwenden.
   */
  acceptedAttemptId?: string;
  assessment: DynamicSearchComplexityV1;
}

export const SEARCH_JOURNEY_ABANDON_REASON_CODES = [
  "target-not-found",
  "task-changed",
  "retrieval-unavailable",
  "cancelled",
  "other",
] as const;
export type SearchJourneyAbandonReasonCode = (typeof SEARCH_JOURNEY_ABANDON_REASON_CODES)[number];

export interface SearchJourneyAbandonedOutcomeV1 {
  kind: "abandoned";
  abandonedAt: string;
  /** Kontrollierter, textfreier Grund; darf auch ohne `retainText` gespeichert werden. */
  reasonCode?: SearchJourneyAbandonReasonCode;
  /** Freitext nur bei ausdruecklichem `retainText`. */
  reason?: string;
}

export type SearchJourneyOutcomeV1 =
  SearchJourneyCompletedOutcomeV1 | SearchJourneyAbandonedOutcomeV1;

export interface SearchJourneyV1 {
  schemaVersion: 1;
  /** Monotoner Compare-and-Swap-Zaehler fuer mehrere Agenten/Prozesse. */
  revision: number;
  sessionId: string;
  workspaceId: string;
  status: SearchJourneyStatus;
  /** Persistenz wurde durch `start` ausdruecklich aktiviert. */
  recordingConsent: "explicit";
  retainText: boolean;
  goal: SearchJourneyGoalV1;
  /** Optional fuer Legacy-/allgemeine Tasks ohne stabile Feature-Zuordnung. */
  feature?: SearchJourneyFeatureV1;
  /** Additive v1 field; absence means that caller conditions were not recorded. */
  executionContext?: SearchJourneyExecutionContextV1;
  createdAt: string;
  updatedAt: string;
  attempts: SearchJourneyAttemptV1[];
  navigation: SearchJourneyNavigationEventV1[];
  outcome?: SearchJourneyOutcomeV1;
}

export interface DynamicProductComplexityCohortV1 {
  measurementContextId: string;
  completedSessionCount: number;
  measurementContextComplete: boolean;
  /** V1 verlangt drei bestaetigte Ziele fuer ein ausreichendes Kohortensignal. */
  sufficientEvidence: boolean;
  minimumCompletedSessions: number;
  /** New writers always report caller conditions separately from retrieval sufficiency. */
  executionContext?: SearchJourneyExecutionContextEvidenceV1;
  /** All six dimensions explicitly declared; this does not verify their accuracy. */
  callerConditionsControlled?: boolean;
  medianSearchesToTarget: number;
  p90SearchesToTarget: number;
  medianQueryReformulations: number;
  medianAcceptedTargetRank: number | null;
  meanReciprocalRank: number | null;
  targetReturnedRate: number;
  directHitRate: number;
  healthyRetrievalRate: number;
  medianEligibleCandidatesExamined: number;
  medianUniqueFilesExposed: number;
  meanCandidateFileDispersion: number | null;
  meanCandidateChurn: number | null;
  candidateLimitHitRate: number;
  caveats: string[];
}

export interface SearchJourneyStatusEffortV1 {
  status: SearchJourneyStatus;
  sessionCount: number;
  sessionsWithSearches: number;
  totalSearches: number;
  failedSearches: number;
  totalNavigationEvents: number;
  totalObservedHops: number;
  /** All observed searches, including zero-search sessions and unsuccessful tasks. */
  medianSearches: number | null;
}

/** Outcome denominators and raw effort; never substituted for completed-to-target metrics. */
export interface DynamicSearchOutcomeCohortV1 {
  measurementContextId: string;
  retrievalContextId: string;
  executionContext: SearchJourneyExecutionContextEvidenceV1;
  featureFingerprint?: string;
  distinctGoalCount: number;
  sessionCounts: {
    total: number;
    active: number;
    completed: number;
    abandoned: number;
    terminal: number;
  };
  terminalCompletionRate: number | null;
  retrievalContextComplete: boolean;
  statusEffort: SearchJourneyStatusEffortV1[];
  abandonmentReasons: {
    reasonCode: SearchJourneyAbandonReasonCode | "not-recorded";
    count: number;
  }[];
  caveats: string[];
}

/** Eine deduplizierte Complexity-Variante eines bestaetigten Code-Ziels. */
export interface FeatureCodeComplexityVariantV1 {
  evidence: SearchJourneyTargetCodeComplexityEvidenceV1;
  completedSessionCount: number;
}

/** Code-Zielmenge einer stabilen Feature-Einheit innerhalb eines Messkontexts. */
export interface FeatureCodeTargetMappingV1 {
  target: SearchJourneyTargetV1;
  completedSessionCount: number;
  complexityVariants: FeatureCodeComplexityVariantV1[];
}

/**
 * Zwei bewusst getrennte Achsen: beobachteter Suchaufwand und statische
 * Metrikevidenz der bestaetigten Ziele. Es existiert kein kombinierter Score.
 */
export interface DynamicProductComplexityFeatureMappingV1 {
  featureFingerprint: string;
  measurementContextId: string;
  distinctGoalCount: number;
  search: DynamicProductComplexityCohortV1;
  code: {
    confirmedTargetCount: number;
    observedComplexitySessionCount: number;
    unavailableComplexitySessionCount: number;
    targets: FeatureCodeTargetMappingV1[];
  };
  caveats: string[];
}

export interface DynamicProductComplexityReportV1 {
  schemaVersion: 1;
  algorithm: typeof DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID;
  isHeuristic: true;
  workspaceId: string;
  generatedAt: string;
  sessionCounts: {
    total: number;
    active: number;
    completed: number;
    /** Teilmenge von `completed`, die explizit eine Feature-ID trägt. */
    featureTaggedCompleted: number;
    abandoned: number;
  };
  cohorts: DynamicProductComplexityCohortV1[];
  /** Nur explizit mit einer stabilen Feature-ID gestartete Journeys. */
  featureMappings: DynamicProductComplexityFeatureMappingV1[];
  /** Additive v1: includes active/abandoned work instead of hiding it behind successful medians. */
  outcomeCohorts?: DynamicSearchOutcomeCohortV1[];
  caveats: string[];
}

/** Persistenzport; Adapter duerfen lokal oder ueber einen MetadataStore arbeiten. */
export interface SearchJourneyStorePort {
  get(sessionId: string, options?: PortCallOptions): Promise<SearchJourneyV1 | null>;
  put(
    session: SearchJourneyV1,
    options: PortCallOptions & { expectedRevision: number | null },
  ): Promise<void>;
  list(workspaceId: string, options?: PortCallOptions): Promise<SearchJourneyV1[]>;
}
