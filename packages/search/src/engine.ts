/**
 * Der hybride Abrufkern (spec.md §13.2; architecture.md §18; vision.md §1d).
 *
 * ABRUF UND RANGFOLGE SIND ZWEI VERSCHIEDENE DINGE — das ist die zentrale
 * Bauentscheidung dieses Moduls und der Grund, warum sich der Suchmodus so
 * einfach einschraenken laesst:
 *
 * - ABRUF (Recall) holt Kandidaten aus dem Speicher. Quellen: der dichte
 *   Zweig (`hybridQuery` mit Query-Embedding), der spaerliche Zweig
 *   (`hybridQuery` mit spaerlichem Vektor, sofern ein `SparseVectorizer`
 *   gestellt wurde) und der Symbolzweig (`scroll` mit Filter auf
 *   `symbol_name`).
 * - RANGFOLGE entsteht danach IN DIESEM PROZESS: der dichte Rang aus den
 *   Cosine-Scores des Speichers, der lexikalische Rang aus dem eigenen BM25
 *   ueber den Kandidatenpool, der Symbolrang aus dem Namensvergleich. Diese
 *   drei Ranglisten werden per RRF fusioniert (`fusion.ts`).
 *
 * Der Suchmodus waehlt Abruf UND Rangfolge: `semantic` fragt nur den
 * dichten Zweig, `lexical` nur den spaerlichen, `symbol` nur den
 * Symbolspeicher. Im Hybridmodus laufen die drei Zweige unabhaengig;
 * ausgefallene Zweige duerfen nutzbare Antworten anderer Zweige nicht
 * verhindern. Jede solche Teilsuche bleibt als Degradation sichtbar.
 *
 * E4 durchgaengig: jeder verworfene Kandidat — Nachfilter, `minScore`,
 * Dedupe, `limit`, unbrauchbarer Payload, ausgefallenes Ziel — bekommt einen
 * Eintrag im Skip-Ledger des Ergebnisses. Kein `catch`, das schweigt.
 */
import type { SearchConfig } from "@untangle-code/config";
import { DEFAULT_SEARCH_CONFIG } from "@untangle-code/config";
import type {
  Clock,
  LoggerPort,
  PayloadFilter,
  PortCallOptions,
  ScoredPointV1,
  SearchFiltersV1,
  SearchHitGroupV1,
  SearchRelevanceVerdictV1,
  SearchHitV1,
  SearchQueryDefaults,
  SearchQueryV1,
  SearchResultSetV1,
  ToolWarningV1,
  VectorStore,
} from "@untangle-code/domain";
import {
  buildSearchQueryFingerprint,
  canonicalJson,
  compareCodepoints,
  INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  isUntangleError,
  normalizeSearchQuery,
  sha256Hex,
  sortByCodepoints,
  UntangleError,
  uniqueSortedByCodepoints,
} from "@untangle-code/domain";

import { Bm25Ranker } from "./bm25.js";
import { dedupeCandidates } from "./dedupe.js";
import type { ScoredCandidate } from "./dedupe.js";
import { assignDuplicatePenalties } from "./diversify.js";
import {
  SEARCH_GRAPH_RELATION_LIMIT,
  boundSearchGraphDetail,
  createSearchGraphRelations,
  unavailableSearchGraphRelations,
} from "./enrichment.js";
import type { SearchScopeV1 } from "./filter.js";
import { buildPayloadFilter } from "./filter.js";
import type { BranchWeights, FusionInput, FusionResult } from "./fusion.js";
import { DEFAULT_BRANCH_WEIGHTS, fuseRankings } from "./fusion.js";
import { assertValidGlobPatterns, isPathSelected } from "./glob.js";
import { grepIndexedChunks } from "./grep.js";
import { SearchSkipLedger } from "./ledger.js";
import type { SearchCandidate } from "./payload.js";
import { candidateFromPoint, lexicalDocumentText, readRawString } from "./payload.js";
import type {
  FindabilityLookup,
  GraphProximityLookup,
  ProfileTargetV1,
  SearchGraphEnrichmentPort,
  SearchPort,
  SparseVectorizer,
} from "./port.js";
import { relevancePrerequisiteFailure } from "./relevance-prerequisites.js";
import type { RelevancePolicyBindingV1 } from "./relevance.js";
import {
  NO_SUFFICIENT_MATCH_WARNING_CODE,
  RELEVANCE_POLICY_NOT_EVALUATED_WARNING_CODE,
  decideResultRelevance,
  resolveRelevancePolicyBinding,
  selectFixedRelevanceEvidencePool,
} from "./relevance.js";
import {
  assertCompletedRetrieval,
  branchesOfMode,
  retrieveIndependentBranches,
  rethrowCancellation,
} from "./retrieval.js";
import type { ScoringContext } from "./scoring.js";
import { MAX_BOOST_SHARE, assembleScoreBreakdown } from "./scoring.js";
import { assignRanks, sortHits } from "./sort.js";
import { matchSymbolName } from "./symbol-match.js";
import { isLikelyGermanQuestion } from "./tokenize.js";
import type {
  GrepRequestV1,
  GrepResultSetV1,
  SearchQueryExtensionsV1,
  UntangleSearchRequestV1,
} from "./types.js";

/** Halbwertszeit des Recency-Boosts, wenn keine gesetzt ist. */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;
/** Harte Grenze fuer freie Providerwarnungen und Batch-Diagnose-IDs. */
export const SEARCH_GRAPH_DIAGNOSTIC_LIMIT = 32;
/** Providerwarnungen sind eine eigene Ausgabeachse und deshalb separat gedeckelt. */
export const SEARCH_GRAPH_PROVIDER_WARNING_LIMIT = 16;

function normalizeGraphProviderWarning(warning: ToolWarningV1): ToolWarningV1 {
  const source = warning.details;
  const details: Record<string, unknown> = {};
  if (source !== undefined && source !== null && typeof source === "object") {
    if (typeof source["workspaceId"] === "string") {
      details["workspaceId"] = boundSearchGraphDetail(source["workspaceId"]);
    }
    if (typeof source["generationId"] === "string") {
      details["generationId"] = boundSearchGraphDetail(source["generationId"]);
    }

    const rawIssues = source["issues"];
    if (Array.isArray(rawIssues)) {
      const issues = rawIssues.map(String).map(boundSearchGraphDetail).sort(compareCodepoints);
      details["issues"] = issues.slice(0, SEARCH_GRAPH_PROVIDER_WARNING_LIMIT);
      const providerOmitted = source["omittedIssueCount"];
      const providerOmittedCount =
        typeof providerOmitted === "number" &&
        Number.isSafeInteger(providerOmitted) &&
        providerOmitted >= 0
          ? providerOmitted
          : 0;
      details["omittedIssueCount"] =
        providerOmittedCount + Math.max(0, issues.length - SEARCH_GRAPH_PROVIDER_WARNING_LIMIT);
    }

    const retainedKeys = new Set(["workspaceId", "generationId", "issues", "omittedIssueCount"]);
    const omittedDetailFieldCount = Object.keys(source).filter(
      (key) => !retainedKeys.has(key),
    ).length;
    if (omittedDetailFieldCount > 0) {
      details["omittedDetailFieldCount"] = omittedDetailFieldCount;
    }
  }
  return {
    code: boundSearchGraphDetail(String(warning.code)),
    message: boundSearchGraphDetail(String(warning.message)),
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}

function boundedDiagnosticIds(values: readonly string[]): {
  ids: string[];
  omittedCount: number;
} {
  const sorted = sortByCodepoints([...new Set(values)]);
  return {
    ids: sorted.slice(0, SEARCH_GRAPH_DIAGNOSTIC_LIMIT).map(boundSearchGraphDetail),
    omittedCount: Math.max(0, sorted.length - SEARCH_GRAPH_DIAGNOSTIC_LIMIT),
  };
}

export const DEFAULT_SEARCH_BRANCH_TIMEOUT_MS = 10_000;

/** Alles, was der Abrufkern braucht — reine Ports und Daten, keine Adapter. */
export interface HybridSearchEngineDeps {
  vectorStore: VectorStore;
  /** Ein Ziel je Embedding-Profil (spec.md §13.4). */
  targets: ProfileTargetV1[];
  /** Vorgaben aus der Konfiguration fuer `normalizeSearchQuery`. */
  defaults: SearchQueryDefaults;
  searchConfig?: SearchConfig;
  /** Nur fuer den Recency-Boost noetig; ohne Clock entfaellt der Bestandteil. */
  clock?: Clock;
  logger?: LoggerPort;
  /** Erzeugt spaerliche Anfragevektoren; siehe {@link SparseVectorizer}. */
  sparseVectorizer?: SparseVectorizer;
  /** Repo-Prioritaeten in [0, 1] fuer den `repo_priority_boost`. */
  repoPriorities?: Record<string, number>;
  graphProximity?: GraphProximityLookup;
  /** Post-Ranking-Anreicherung; kennt als Port keine konkreten Graphpakete. */
  graphEnrichment?: SearchGraphEnrichmentPort;
  findability?: FindabilityLookup;
  recencyHalfLifeDays?: number;
  branchWeights?: BranchWeights;
  /** Hybrid-only deadline per independent branch; single-mode uses caller cancellation. */
  branchTimeoutMs?: number;
  /**
   * Profilgebundene Abwesenheitsentscheidungen. Eine leere Map behaelt das
   * bisherige ungefilterte Verhalten. Ist die Map konfiguriert, aber fuer ein
   * aktives Profil fehlt der Eintrag, bleibt die Trefferliste ebenfalls
   * unveraendert und die Engine meldet die nicht ausgewertete Policy sichtbar.
   */
  relevancePolicies?: Readonly<Record<string, RelevancePolicyBindingV1>>;
  /** Display-only legacy fallback; never accepted as persisted provenance. */
  indexGeneration?: string;
}

/**
 * Gibt dem PRAEZISIONSzweig bei einer zeichengleichen Symbolanfrage genug
 * Basisgewicht, dass ein exakter Treffer selbst unter den erlaubten
 * Boost-Grenzfaellen vor einem nicht-exakten Treffer bleibt.
 *
 * Bei MAX_BOOST_SHARE=0.5 kann ein nicht-exakter Basisscore hoechstens auf
 * 1.5x steigen und ein exakter durch Strafen hoechstens auf 0.5x fallen. Das
 * benoetigte Basisverhaeltnis ist daher (1+s)/(1-s)=3. Der kleine vorhandene
 * Symbolanteil oberhalb dieser Grenze macht die Ungleichung strikt. Der
 * Boost-Deckel selbst bleibt vollkommen unveraendert.
 */
export function exactSymbolIntentBranchWeights(
  weights: BranchWeights,
  active: { dense: boolean; lexical: boolean; symbol: boolean },
): BranchWeights {
  if (!active.symbol || weights.symbol <= 0) {
    return { ...weights };
  }
  const nonSymbolWeight =
    (active.dense ? Math.max(0, weights.dense) : 0) +
    (active.lexical ? Math.max(0, weights.lexical) : 0);
  const dominanceRatio = (1 + MAX_BOOST_SHARE) / (1 - MAX_BOOST_SHARE);
  return {
    ...weights,
    symbol: Math.max(weights.symbol, nonSymbolWeight * dominanceRatio + weights.symbol),
  };
}

/** Zahl dichter Spitzenplaetze, die einen lexikalischen Spitzenkandidaten bestaetigen. */
export const GERMAN_LEXICAL_CORROBORATION_DEPTH = 10;

/**
 * Nur eine als deutsch erkannte Frage mit einem lexikalischen Spitzenreiter,
 * der NICHT unter den zehn dicht besten Kandidaten vorkommt, verliert im
 * Hybridmodus den lokalen BM25-Rang. Stimmen beide unabhaengigen Zweige
 * ueberein, bleibt das nuetzliche lexikalische Signal erhalten.
 */
export function shouldOmitUncorroboratedGermanLexicalBranch(
  queryText: string,
  denseRankedIds: readonly string[],
  lexicalRankedIds: readonly string[],
): boolean {
  if (!isLikelyGermanQuestion(queryText)) {
    return false;
  }
  const lexicalTop = lexicalRankedIds[0];
  if (lexicalTop === undefined) {
    return true;
  }
  return !denseRankedIds.slice(0, GERMAN_LEXICAL_CORROBORATION_DEPTH).includes(lexicalTop);
}

/** Normalisiert die Zusatzfelder dieses Pakets (Gegenstueck zu `SearchQueryV1`). */
export function normalizeExtensions(request: UntangleSearchRequestV1): SearchQueryExtensionsV1 {
  const pathExcludes = uniqueSortedByCodepoints(
    (request.pathExclude ?? []).map((value) => value.trim()).filter((value) => value !== ""),
  );
  return {
    mode: request.mode ?? "hybrid",
    abstention: request.abstention ?? "strict",
    pathExcludes,
    includeContent: request.includeContent ?? false,
    complexityBias: request.complexityBias ?? "none",
    sort: request.sort ?? "relevance",
  };
}

/**
 * Die Zusatzangaben, die den Fingerabdruck der Anfrage veraendern MUESSEN.
 *
 * Der Fingerabdruck beantwortet „ist das dieselbe Frage?". `mode`,
 * `pathExcludes`, `complexityBias` und `sort` aendern die Treffermenge bzw.
 * die Rangfolge — zwei Anfragen, die sich nur darin unterscheiden, sind NICHT
 * dieselbe Frage. `includeContent` bleibt draussen: es aendert nur die
 * Darstellung, genau wie `limit` und `candidateLimit` (siehe
 * `buildSearchQueryFingerprint`).
 *
 * Nur ABWEICHUNGEN vom Standard gehen ein. Eine Anfrage ohne
 * Paket-Erweiterungen behaelt damit exakt den Fingerabdruck, den sie ohne
 * dieses Feld haette — Findability-Datensaetze aelterer Laeufe bleiben
 * vergleichbar.
 */
export function fingerprintRankingOptions(
  extensions: SearchQueryExtensionsV1,
): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (extensions.mode !== "hybrid") {
    options["mode"] = extensions.mode;
  }
  if (extensions.pathExcludes.length > 0) {
    options["pathExcludes"] = extensions.pathExcludes;
  }
  if (extensions.complexityBias !== "none") {
    options["complexityBias"] = extensions.complexityBias;
  }
  if (extensions.sort !== "relevance") {
    options["sort"] = extensions.sort;
  }
  // NUR bei Abweichung. `strict` traegt nichts bei, damit jeder bereits
  // persistierte `queryFingerprint` byte-identisch bleibt — sonst waeren alle
  // Findability-Datensaetze und Journey-Kohorten auf einen Schlag entwertet.
  if (extensions.abstention !== "strict") {
    options["abstention"] = extensions.abstention;
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

/**
 * Ergaenzt die Findability-Filter aus der Paketanfrage in die normalisierten
 * Domain-Filter. `normalizeSearchQuery` kennt sie nicht, weil `SearchRequestV1`
 * (spec.md §13.1) sie nicht kennt — `SearchFiltersV1` hat das Feld aber
 * bereits, also wird es hier gefuellt statt neben der Query gefuehrt.
 */
function withFindabilityFilter(
  query: SearchQueryV1,
  request: UntangleSearchRequestV1,
): SearchQueryV1 {
  const { findabilityMinScore, findabilityMaxScore } = request;
  if (findabilityMinScore === undefined && findabilityMaxScore === undefined) {
    return query;
  }
  if (
    findabilityMinScore !== undefined &&
    findabilityMaxScore !== undefined &&
    findabilityMinScore > findabilityMaxScore
  ) {
    throw new Error(
      `search query filter "findability" has min > max (${findabilityMinScore} > ${findabilityMaxScore})`,
    );
  }
  const filters: SearchFiltersV1 = {
    ...query.filters,
    findability: {
      ...(findabilityMinScore === undefined ? {} : { minScore: findabilityMinScore }),
      ...(findabilityMaxScore === undefined ? {} : { maxScore: findabilityMaxScore }),
    },
  };
  return { ...query, filters };
}

/**
 * WP-188 (E4): `searchConfig.diversifyByDefault` und `searchConfig.minScoreDefault`
 * hatten KEINEN Leser.
 *
 * Beide standen in der Konfiguration, waren dokumentiert, wurden validiert —
 * und veraenderten nichts. Eine Einstellung, die nichts tut, ist schlimmer als
 * eine fehlende: sie behauptet eine Wirkung. Wer `minScoreDefault = 0.5`
 * setzte und weiterhin Treffer mit 0.2 bekam, hatte keinen Grund, den Fehler
 * beim Werkzeug zu suchen.
 *
 * Die Vorgaben greifen nur, wo die ANFRAGE nichts sagt — eine ausdrueckliche
 * Angabe des Aufrufers gewinnt immer. Sie werden VOR dem Fingerabdruck
 * angewandt, damit „gleiche Frage" auch dann gleich heisst, wenn ein Teil der
 * Antwort aus der Konfiguration kommt.
 */
function applyConfigDefaults(
  query: SearchQueryV1,
  request: UntangleSearchRequestV1,
  config: SearchConfig,
): { query: SearchQueryV1; minScoreFromConfig: boolean } {
  const diversify = request.diversify ?? config.diversifyByDefault;
  const useConfigMinScore =
    request.minScore === undefined &&
    config.minScoreDefault !== undefined &&
    Number.isFinite(config.minScoreDefault);
  return {
    query: {
      ...query,
      diversify,
      ...(useConfigMinScore ? { minScore: config.minScoreDefault as number } : {}),
    },
    minScoreFromConfig: useConfigMinScore,
  };
}

/** Woher der wirksame `minScore` stammt — Wortlaut fuer den Skip-Ledger. */
type MinScoreOrigin = "requested" | "from searchConfig.minScoreDefault";

interface TargetOutcome {
  group: SearchHitGroupV1;
  refIds: Set<string>;
  relevanceWarning?: ToolWarningV1;
  indexContextWarning?: ToolWarningV1;
  branchWarnings?: ToolWarningV1[];
}

/**
 * Die Referenzimplementierung des {@link SearchPort}.
 *
 * Sie ist speicher-agnostisch: alles laeuft ueber den `VectorStore`-Port, also
 * gegen Qdrant genauso wie gegen den In-Memory-Speicher des testkits.
 */
export class HybridSearchEngine implements SearchPort {
  private readonly config: SearchConfig;
  private readonly branchWeights: BranchWeights;
  private readonly branchTimeoutMs: number;
  private readonly relevancePolicies: ReadonlyMap<string, RelevancePolicyBindingV1>;

  public constructor(private readonly deps: HybridSearchEngineDeps) {
    const seenProfileIds = new Set<string>();
    for (const target of deps.targets) {
      if (target.embeddingProfileId !== target.embedder.profileId) {
        throw new Error(
          `search target embeddingProfileId "${target.embeddingProfileId}" does not match its embedder.profileId "${target.embedder.profileId}"; collection/profile grouping and calibrated policies would be misattributed`,
        );
      }
      if (seenProfileIds.has(target.embeddingProfileId)) {
        throw new Error(
          `search target embeddingProfileId "${target.embeddingProfileId}" is configured more than once; one result group per embedding profile is required`,
        );
      }
      seenProfileIds.add(target.embeddingProfileId);
    }
    this.config = deps.searchConfig ?? DEFAULT_SEARCH_CONFIG;
    this.branchWeights = deps.branchWeights ?? { ...DEFAULT_BRANCH_WEIGHTS };
    this.branchTimeoutMs = deps.branchTimeoutMs ?? DEFAULT_SEARCH_BRANCH_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.branchTimeoutMs) ||
      this.branchTimeoutMs <= 0 ||
      this.branchTimeoutMs > 2_147_483_647
    ) {
      throw new Error("branchTimeoutMs must be an integer between 1 and 2147483647");
    }
    // Die projektweite Config ist selbst eine vollwertige Verdrahtungsquelle.
    // Das explizite Dependency-Feld bleibt fuer Library-Aufrufer und Tests,
    // gewinnt bei gleichzeitiger Angabe aber eindeutig. Sonst waere eine
    // geladene, validierte SearchConfig erneut ein wirkungsloser Wert.
    const configuredRelevancePolicies = deps.relevancePolicies ?? this.config.relevancePolicies;
    this.relevancePolicies = new Map(
      Object.entries(configuredRelevancePolicies ?? {}).map(([embeddingProfileId, configured]) => {
        if (embeddingProfileId.trim() === "") {
          throw new Error("relevancePolicies keys must be non-empty embedding profile ids");
        }
        return [embeddingProfileId, resolveRelevancePolicyBinding(configured)] as const;
      }),
    );
  }

  public async search(
    request: UntangleSearchRequestV1,
    options?: PortCallOptions,
  ): Promise<SearchResultSetV1> {
    options?.signal?.throwIfAborted();
    const extensions = normalizeExtensions(request);
    const defaulted = applyConfigDefaults(
      withFindabilityFilter(normalizeSearchQuery(request, this.deps.defaults), request),
      request,
      this.config,
    );
    const query = defaulted.query;
    // Der Ursprung reist als Parameter mit, NICHT als Feld der Instanz: zwei
    // gleichzeitige `search()`-Aufrufe auf derselben Maschine wuerden sich
    // sonst gegenseitig die Begruendung im Ledger umschreiben.
    const minScoreOrigin: MinScoreOrigin = defaulted.minScoreFromConfig
      ? "from searchConfig.minScoreDefault"
      : "requested";
    // Fehlerhafte Muster sind ein Eingabefehler des Nutzers und werden HIER
    // abgelehnt. Faellt der Fehler erst beim Abgleich je Kandidat an, faengt
    // ihn das Ziel-catch auf und meldet einen Speicherausfall — eine falsche
    // Diagnose fuer ein falsches Zeichen im Suchmuster.
    assertValidGlobPatterns(query.filters.pathGlobs, "pathGlob");
    assertValidGlobPatterns(extensions.pathExcludes, "pathExclude");

    const ledger = new SearchSkipLedger();
    const warnings: ToolWarningV1[] = [];

    // Die Obergrenze aus der Konfiguration ist eine Grenze, kein Vorschlag:
    // ohne sie zieht eine Anfrage mit candidateLimit=100000 drei Rundlaeufe
    // ueber 100000 Punkte plus einen BM25-Aufbau darueber.
    //
    // WARUM AUCH `limit` GEDECKELT WIRD: `SearchQueryV1` verlangt
    // `candidateLimit >= limit`, und `normalizeSearchQuery` weist alles andere
    // ab. Wer die Obergrenze nur auf `candidateLimit` anwendet und den Wert
    // anschliessend mit `Math.max(max, limit)` wieder anhebt, hat die Grenze
    // damit fuer JEDE Anfrage mit grossem `limit` ausgeschaltet — die drei
    // Speicherrundlaeufe ueber 100000 Punkte laufen dann wie zuvor. Die
    // Obergrenze ist eine Aussage ueber die ARBEIT, nicht ueber ein einzelnes
    // Feld: mehr als `maxCandidateLimit` Kandidaten werden nicht geholt, also
    // koennen auch nicht mehr als `maxCandidateLimit` Treffer entstehen. Beide
    // Deckelungen stehen einzeln und benannt im Ergebnis (E4).
    const maxCandidateLimit = this.config.maxCandidateLimit;
    const candidateCapActive = Number.isInteger(maxCandidateLimit) && maxCandidateLimit > 0;
    let candidateLimit = query.candidateLimit;
    let limit = query.limit;
    if (candidateCapActive && candidateLimit > maxCandidateLimit) {
      candidateLimit = maxCandidateLimit;
      warnings.push({
        code: "CANDIDATE_LIMIT_CLAMPED",
        message: `candidateLimit ${query.candidateLimit} exceeds the configured maximum of ${maxCandidateLimit}; the search ran with ${candidateLimit} candidates per branch instead`,
        details: {
          requested: query.candidateLimit,
          effective: candidateLimit,
          maxCandidateLimit,
        },
      });
    }
    if (limit > candidateLimit) {
      warnings.push({
        code: "RESULT_LIMIT_CLAMPED",
        message: `limit ${limit} exceeds the candidate pool of ${candidateLimit} (configured maximum ${maxCandidateLimit}); the search returned at most ${candidateLimit} hits per profile group instead`,
        details: {
          requested: limit,
          effective: candidateLimit,
          candidateLimit,
          maxCandidateLimit,
        },
      });
      limit = candidateLimit;
    }

    const effectiveQuery: SearchQueryV1 = {
      ...query,
      includeContent: extensions.includeContent,
      candidateLimit,
      limit,
    };
    // Die VOLLSTAENDIGE normalisierte Anfrage geht hinein, nicht eine von Hand
    // gepflegte Auswahl daraus: `buildSearchQueryFingerprint` streicht selbst,
    // was reine Darstellung ist (siehe SEARCH_FINGERPRINT_IGNORED_FIELDS).
    // Wuerde hier eine Auswahl stehen, fiele jedes spaeter ergaenzte
    // ergebnisveraendernde Feld wieder lautlos heraus — genau so verloren
    // `workspaceId`, `minScore` und `diversify` ihren Platz im Fingerabdruck.
    const rankingOptions = fingerprintRankingOptions(extensions);
    const fingerprint = buildSearchQueryFingerprint({
      ...effectiveQuery,
      ...(rankingOptions === undefined ? {} : { rankingOptions }),
    });
    const rankingContextFingerprint = this.rankingContextFingerprint(effectiveQuery, extensions);

    // Ein nicht verdrahteter Port bleibt derselbe ehrliche UNAVAILABLE-Fall
    // wie bisher. Ist einer vorhanden, wird er erst NACH Ranking, Dedupe und
    // Limit gerufen (unterhalb der Zielschleife).
    if (effectiveQuery.includeGraphContext && this.deps.graphEnrichment === undefined) {
      warnings.push({
        code: "GRAPH_CONTEXT_UNAVAILABLE",
        message:
          "the request asked for structural graph context (includeContext), but no graph enrichment provider is wired; the hits carry NO graph context",
      });
    }
    if (effectiveQuery.includeLinked && this.deps.graphEnrichment === undefined) {
      warnings.push({
        code: "LINKED_ARTIFACTS_UNAVAILABLE",
        message:
          "the request asked for linked symbols (includeLinked), but no graph enrichment provider is wired; the hits carry NO linked symbols",
      });
    }

    if (effectiveQuery.filters.findability !== undefined && this.deps.findability === undefined) {
      warnings.push({
        code: "FINDABILITY_FILTER_UNAVAILABLE",
        message:
          "the request asked for a findability filter, but no findability lookup is wired into the engine — the filter was NOT applied",
        details: { filter: effectiveQuery.filters.findability },
      });
    }
    if (branchesOfMode(extensions.mode).lexical && this.deps.sparseVectorizer === undefined) {
      warnings.push({
        code: "SPARSE_RECALL_UNAVAILABLE",
        message:
          "no sparse vectorizer is wired into the engine; the requested lexical retrieval branch is unavailable",
      });
    }

    const groups: SearchHitGroupV1[] = [];
    const failedTargets: { profileId: string; error: unknown }[] = [];
    const refIdsByRepo = new Map<string, Set<string>>();
    for (const target of this.deps.targets) {
      options?.signal?.throwIfAborted();
      try {
        const outcome = await this.searchTarget(
          target,
          effectiveQuery,
          extensions,
          ledger,
          minScoreOrigin,
          options,
        );
        groups.push(outcome.group);
        warnings.push(...(outcome.branchWarnings ?? []));
        if (outcome.relevanceWarning !== undefined) {
          warnings.push(outcome.relevanceWarning);
        }
        if (outcome.indexContextWarning !== undefined) {
          warnings.push(outcome.indexContextWarning);
        }
        for (const hit of outcome.group.hits) {
          const set = refIdsByRepo.get(hit.repoId) ?? new Set<string>();
          set.add(hit.refId);
          refIdsByRepo.set(hit.repoId, set);
        }
      } catch (error) {
        rethrowCancellation(error, options);
        // E4: ein ausgefallenes Ziel wird gemeldet, nicht verschluckt. Die
        // uebrigen Profile werden weiter durchsucht (spec.md §25.2: eine
        // Lesende Operation degradiert sichtbar, statt ganz zu scheitern).
        const message = error instanceof Error ? error.message : String(error);
        const code = isUntangleError(error) ? error.code : "PROFILE_UNAVAILABLE";
        failedTargets.push({ profileId: target.embeddingProfileId, error });
        warnings.push({
          code,
          message: `profile "${target.embeddingProfileId}" could not be searched: ${message}`,
          details: { collection: target.collection, repoIds: target.repoIds },
        });
        ledger.add({
          subjectKind: "search_candidate",
          subjectId: target.embeddingProfileId,
          reason: "provider_unavailable",
          detail: `collection "${target.collection}" did not answer: ${message}`,
          recoverable: true,
        });
        this.deps.logger?.log({
          timestamp: this.deps.clock?.nowIso() ?? "",
          level: "warn",
          component: "search",
          event: "profile_search_failed",
          context: { profileId: target.embeddingProfileId, message },
        });
      }
    }

    if (
      failedTargets.length > 0 &&
      !groups.some((group) => group.notSearchedReason === undefined)
    ) {
      const first = failedTargets[0] as (typeof failedTargets)[number];
      throw new UntangleError(
        isUntangleError(first.error) ? first.error.code : "QDRANT_UNAVAILABLE",
        `search failed: no requested profile completed a retrieval branch; ${failedTargets
          .map(
            ({ profileId, error }) =>
              `profile "${profileId}": ${error instanceof Error ? error.message : String(error)}`,
          )
          .join("; ")}`,
        {
          operation: "search",
          retryable: failedTargets.some(({ error }) => !isUntangleError(error) || error.retryable),
          context: { failedProfileIds: failedTargets.map(({ profileId }) => profileId) },
          cause: first.error,
        },
      );
    }

    // Pipeline-Schritt 11: Nur die BEREITS final begrenzten und gerankten
    // Treffer verlassen den Abrufkern in Richtung Graphadapter. Weder ein
    // Graphsignal noch ein Ladefehler kann dadurch Ranking, Score, Dedupe,
    // Fingerabdruck oder Trefferzahl veraendern.
    //
    // Diese Bedingung fragt, ob es ueberhaupt einen Treffer gibt, an den man
    // Relationen haengen kann. Sie ist AUSDRUECKLICH KEINE Enthaltungspruefung:
    // unter `evidence` behaelt eine von der Policy abgelehnte Gruppe ihre
    // Treffer und wird folgerichtig angereichert. Anreicherung zu ueberspringen,
    // weil die Policy ablehnte, waere eine zweite, verdeckte Bedeutung an
    // derselben Stelle — genau die Verwechslung, die diese Welle beseitigt.
    const hasHitsToEnrich = groups.some((group) => group.hits.length > 0);
    if (
      this.deps.graphEnrichment !== undefined &&
      (effectiveQuery.includeGraphContext || effectiveQuery.includeLinked) &&
      hasHitsToEnrich
    ) {
      await this.enrichFinalHits(groups, effectiveQuery, warnings, options);
    }

    for (const [repoId, refIds] of refIdsByRepo) {
      if (refIds.size > 1) {
        warnings.push({
          code: "MULTIPLE_REFS",
          message: `repository "${repoId}" contributed hits from ${refIds.size} refs; results from different refs describe different states of the same code`,
          details: { repoId, refIds: sortByCodepoints([...refIds]) },
        });
      }
    }

    const incompleteHits = groups.flatMap((group) =>
      group.hits.filter((hit) => hit.incompletePayloadFields !== undefined),
    );
    if (incompleteHits.length > 0) {
      warnings.push({
        code: "INCOMPLETE_PAYLOAD",
        message: `${incompleteHits.length} hit(s) carry payload fields that were missing in the index and filled with documented substitutes; see each hit's incompletePayloadFields`,
        details: {
          chunkIds: sortByCodepoints(incompleteHits.map((hit) => hit.chunkId)),
        },
      });
    }

    const profileSeparation = groups.length > 1;
    if (profileSeparation) {
      warnings.push({
        code: "PROFILE_SEPARATION",
        message:
          "results are grouped per embedding profile; scores are comparable only WITHIN a group (spec.md §13.4)",
        details: { profileIds: groups.map((group) => group.embeddingProfileId) },
      });
    }

    return {
      schemaVersion: 1,
      queryFingerprint: fingerprint,
      rankingContextFingerprint,
      query: effectiveQuery,
      groups,
      profileSeparation,
      totalHits: groups.reduce((sum, group) => sum + group.hits.length, 0),
      skipped: ledger.toArray(),
      warnings,
    };
  }

  private rankingContextFingerprint(
    query: SearchQueryV1,
    extensions: SearchQueryExtensionsV1,
  ): string {
    const targets = this.deps.targets
      .map((target) => ({
        embeddingProfileId: target.embeddingProfileId,
        collection: target.collection,
        repoIds: uniqueSortedByCodepoints(target.repoIds),
      }))
      .sort((left, right) => compareCodepoints(canonicalJson(left), canonicalJson(right)));
    const relevancePolicies = [...this.relevancePolicies.entries()]
      .sort(([left], [right]) => compareCodepoints(left, right))
      .map(([embeddingProfileId, binding]) => ({ embeddingProfileId, ...binding }));
    const repoPriorities = Object.entries(this.deps.repoPriorities ?? {}).sort(([left], [right]) =>
      compareCodepoints(left, right),
    );
    return sha256Hex(
      canonicalJson({
        schemaVersion: 1,
        rankerVersion: query.rankerVersion,
        mode: extensions.mode,
        // Mode-selected recall and independent branch failure handling must
        // never be cohort-compatible with the previous rank-only strategy.
        retrievalStrategy: "independent-branches-v1",
        ...(extensions.mode === "hybrid" ? { branchTimeoutMs: this.branchTimeoutMs } : {}),
        // Ausdruecklicher bedingter Spread, NICHT `abstention: x ?? undefined`:
        // der Hash darf nicht davon abhaengen, ob canonicalJson undefined
        // wegwirft. Unter `strict` ist das gehashte Objekt buchstaeblich
        // unveraendert, also bleiben persistierte Journey-Kohorten vergleichbar.
        ...(extensions.abstention === "strict" ? {} : { abstention: extensions.abstention }),
        sort: extensions.sort,
        complexityBias: extensions.complexityBias,
        diversify: query.diversify,
        minScore: query.minScore ?? null,
        branchWeights: this.branchWeights,
        boostWeights: this.config.boostWeights,
        recencyHalfLifeDays: this.deps.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS,
        clockEnabled: this.deps.clock !== undefined,
        sparseVectorizerEnabled: this.deps.sparseVectorizer !== undefined,
        graphProximityEnabled: this.deps.graphProximity !== undefined,
        findabilityEnabled: this.deps.findability !== undefined,
        targets,
        repoPriorities,
        relevancePolicies,
      }),
    );
  }

  private async enrichFinalHits(
    groups: SearchHitGroupV1[],
    query: SearchQueryV1,
    warnings: ToolWarningV1[],
    options?: PortCallOptions,
  ): Promise<void> {
    const provider = this.deps.graphEnrichment;
    if (provider === undefined) return;

    const targets = groups.flatMap((group, groupIndex) =>
      group.hits.map((hit, hitIndex) => ({
        targetId: `group:${String(groupIndex)}:hit:${String(hitIndex)}`,
        workspaceId: query.workspaceId,
        generationId: hit.indexGeneration,
        repoId: hit.repoId,
        refId: hit.refId,
        fileId: hit.fileId,
        filePath: hit.filePath,
        ...(hit.symbolId === undefined ? {} : { symbolId: hit.symbolId }),
      })),
    );

    try {
      const result = await provider.enrich(
        {
          includeContext: query.includeGraphContext,
          includeLinked: query.includeLinked,
          relationLimit: SEARCH_GRAPH_RELATION_LIMIT,
          targets,
        },
        options,
      );
      options?.signal?.throwIfAborted();

      const expectedIds = new Set(targets.map((target) => target.targetId));
      const entries = new Map<string, (typeof result.entries)[number]>();
      const duplicateIds = new Set<string>();
      const unexpectedIds = new Set<string>();
      for (const entry of result.entries) {
        if (!expectedIds.has(entry.targetId)) {
          unexpectedIds.add(entry.targetId);
          continue;
        }
        if (entries.has(entry.targetId)) duplicateIds.add(entry.targetId);
        else entries.set(entry.targetId, entry);
      }
      const missingIds: string[] = [];

      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex] as SearchHitGroupV1;
        for (let hitIndex = 0; hitIndex < group.hits.length; hitIndex++) {
          const hit = group.hits[hitIndex] as SearchHitV1;
          const targetId = `group:${String(groupIndex)}:hit:${String(hitIndex)}`;
          const entry = duplicateIds.has(targetId) ? undefined : entries.get(targetId);
          if (entry === undefined) missingIds.push(targetId);
          const detail = `graph enrichment provider returned no unique result for final hit "${hit.chunkId}"`;

          if (query.includeGraphContext) {
            hit.graphContext =
              entry?.graphContext === undefined
                ? unavailableSearchGraphRelations(
                    "provider_result_missing",
                    detail,
                    SEARCH_GRAPH_RELATION_LIMIT,
                  )
                : createSearchGraphRelations(
                    entry.graphContext.relations,
                    entry.graphContext.omissions,
                    SEARCH_GRAPH_RELATION_LIMIT,
                  );
          }
          if (query.includeLinked) {
            hit.linkedSymbols =
              entry?.linkedSymbols === undefined
                ? unavailableSearchGraphRelations(
                    "provider_result_missing",
                    detail,
                    SEARCH_GRAPH_RELATION_LIMIT,
                  )
                : createSearchGraphRelations(
                    entry.linkedSymbols.relations,
                    entry.linkedSymbols.omissions,
                    SEARCH_GRAPH_RELATION_LIMIT,
                  );
          }
        }
      }

      const providerWarnings = [...result.warnings]
        .map(normalizeGraphProviderWarning)
        .sort((left, right) => {
          const byCode = compareCodepoints(left.code, right.code);
          if (byCode !== 0) return byCode;
          const byMessage = compareCodepoints(left.message, right.message);
          return byMessage !== 0
            ? byMessage
            : compareCodepoints(
                JSON.stringify(left.details ?? {}),
                JSON.stringify(right.details ?? {}),
              );
        });
      warnings.push(...providerWarnings.slice(0, SEARCH_GRAPH_PROVIDER_WARNING_LIMIT));
      if (providerWarnings.length > SEARCH_GRAPH_PROVIDER_WARNING_LIMIT) {
        warnings.push({
          code: "GRAPH_ENRICHMENT_WARNINGS_TRUNCATED",
          message: `${String(providerWarnings.length - SEARCH_GRAPH_PROVIDER_WARNING_LIMIT)} additional graph enrichment provider warning(s) were omitted by the response limit`,
          details: {
            warningLimit: SEARCH_GRAPH_PROVIDER_WARNING_LIMIT,
            omittedWarningCount: providerWarnings.length - SEARCH_GRAPH_PROVIDER_WARNING_LIMIT,
          },
        });
      }
      if (missingIds.length > 0 || duplicateIds.size > 0 || unexpectedIds.size > 0) {
        const missing = boundedDiagnosticIds(missingIds);
        const duplicates = boundedDiagnosticIds([...duplicateIds]);
        const unexpected = boundedDiagnosticIds([...unexpectedIds]);
        warnings.push({
          code: "GRAPH_ENRICHMENT_INCOMPLETE",
          message:
            "the graph enrichment provider returned an incomplete or ambiguous batch; affected hits carry provider_result_missing omissions",
          details: {
            missingTargetIds: missing.ids,
            omittedMissingTargetIdCount: missing.omittedCount,
            duplicateTargetIds: duplicates.ids,
            omittedDuplicateTargetIdCount: duplicates.omittedCount,
            unexpectedTargetIds: unexpected.ids,
            omittedUnexpectedTargetIdCount: unexpected.omittedCount,
          },
        });
      }
    } catch (error) {
      options?.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      const detail = boundSearchGraphDetail(`graph enrichment failed after ranking: ${message}`);
      markFinalHitGraphUnavailable(groups, query, detail);
      if (query.includeGraphContext) {
        warnings.push({ code: "GRAPH_CONTEXT_UNAVAILABLE", message: detail });
      }
      if (query.includeLinked) {
        warnings.push({ code: "LINKED_ARTIFACTS_UNAVAILABLE", message: detail });
      }
      this.deps.logger?.log({
        timestamp: this.deps.clock?.nowIso() ?? "",
        level: "warn",
        component: "search",
        event: "graph_enrichment_failed",
        context: { message },
      });
    }
  }

  /**
   * grep laeuft im selben Geltungsbereich wie `search`: Workspace aus den
   * Vorgaben, wenn die Anfrage keinen nennt, und nur die Repositories der
   * verdrahteten Ziele. Sonst faende dieselbe Oberflaeche mit demselben
   * Aufrufer je nach Werkzeug verschiedene Mengen.
   */
  public grep(request: GrepRequestV1, options?: PortCallOptions): Promise<GrepResultSetV1> {
    return grepIndexedChunks(
      this.deps.vectorStore,
      uniqueSortedByCodepoints(this.deps.targets.map((target) => target.collection)),
      request,
      options,
      {
        workspaceId: this.deps.defaults.workspaceId,
        repoIds: uniqueSortedByCodepoints(this.deps.targets.flatMap((target) => target.repoIds)),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Ein Ziel (= ein Embedding-Profil, eine Collection)
  // -------------------------------------------------------------------------

  private async searchTarget(
    target: ProfileTargetV1,
    query: SearchQueryV1,
    extensions: SearchQueryExtensionsV1,
    ledger: SearchSkipLedger,
    minScoreOrigin: MinScoreOrigin,
    options?: PortCallOptions,
  ): Promise<TargetOutcome> {
    const scope: SearchScopeV1 = {
      workspaceId: query.workspaceId,
      targetRepoIds: target.repoIds,
    };
    const requestedFilter = buildPayloadFilter(query.filters, scope);
    // A ref-less request must not turn a locally recorded current corpus into
    // an unbounded scan of every historical ref still present in the shared
    // collection. Use every recorded ref in the effective repo scope. Doing
    // this at the port boundary keeps non-CLI callers honest as well.
    const inferredRefIds =
      query.filters.refIds.length === 0 && requestedFilter.emptyScopeReason === undefined
        ? uniqueSortedByCodepoints(
            (target.indexContexts ?? [])
              .filter(
                (context) =>
                  requestedFilter.scopeRepoIds.length === 0 ||
                  requestedFilter.scopeRepoIds.includes(context.repoId),
              )
              .map((context) => context.refId),
          )
        : [];
    const effectiveRefIds =
      query.filters.refIds.length === 0 ? inferredRefIds : query.filters.refIds;
    const built =
      query.filters.refIds.length === 0 && inferredRefIds.length > 0
        ? buildPayloadFilter({ ...query.filters, refIds: inferredRefIds }, scope)
        : requestedFilter;
    // WP-178: Die zweite Verteidigungslinie prueft ab hier den WIRKSAMEN
    // Bereich (Ziel geschnitten mit dem Repo-Filter der Anfrage), nicht mehr
    // nur die Zieldeklaration. Ein Speicher, der den Payloadfilter ignoriert,
    // lieferte sonst einen Treffer aus einem Repository, das der Nutzer
    // ausdruecklich NICHT angefragt hat — waehrend `group.repoIds` das
    // Gegenteil behauptet.
    const effectiveScope: SearchScopeV1 = {
      workspaceId: query.workspaceId,
      targetRepoIds: built.scopeRepoIds,
    };
    if (built.emptyScopeReason !== undefined) {
      // E4: Der Speicher wird NICHT gefragt — eine leere `in`-Liste waere
      // kein Filter, sondern gar keiner, und die Suche liefe ueber die ganze
      // Collection. Der leere Bereich steht stattdessen im Ledger.
      ledger.add({
        subjectKind: "search_candidate",
        subjectId: target.embeddingProfileId,
        reason: "excluded_by_configuration",
        detail: built.emptyScopeReason,
        recoverable: true,
      });
      return {
        group: {
          embeddingProfileId: target.embeddingProfileId,
          repoIds: [],
          hits: [],
          rankNormalized: false,
          caveats: [built.emptyScopeReason],
          // E4: „nicht gesucht" ist im Ergebnis von „gesucht, nichts gefunden"
          // zu unterscheiden. Ohne diese Markierung sieht die Gruppe wie eine
          // leere Trefferliste aus, und die Findability-Sonde macht daraus
          // „das Symbol findet sich selbst nicht" — eine Aussage ueber den
          // Code, die auf keiner Beobachtung steht.
          notSearchedReason: built.emptyScopeReason,
        },
        refIds: new Set<string>(),
      };
    }
    // WP-176 (E4): Angefragte Repositories, die dieses Ziel gar nicht fuehrt,
    // fielen bisher lautlos aus dem Durchschnitt. Nur der VOLLSTAENDIG leere
    // Fall (oben) kam in den Ledger. Ein teilweiser Ausfall sieht damit wie
    // eine vollstaendige Suche aus — die gefaehrlichere der beiden Formen,
    // weil sie Treffer liefert und deshalb niemand nachfragt.
    const outOfScope = built.outOfScopeRepoIds;
    const caveats = built.residual.map(
      (residual) =>
        `filter "${residual.name}" was applied in-process, not in the store: ${residual.reason}`,
    );
    if (query.filters.refIds.length === 0 && inferredRefIds.length > 0) {
      caveats.push(
        `the request omitted refs; this target was searched only across locally recorded refs [${inferredRefIds.join(", ")}]`,
      );
    }
    if (outOfScope.length > 0) {
      const detail = `the requested repositories [${outOfScope.join(", ")}] are not part of this target's repositories [${sortByCodepoints([...target.repoIds]).join(", ")}]; they were NOT searched here`;
      caveats.push(detail);
      for (const repoId of outOfScope) {
        ledger.add({
          subjectKind: "search_candidate",
          subjectId: `${target.embeddingProfileId}:${repoId}`,
          reason: "excluded_by_configuration",
          detail,
          recoverable: true,
        });
      }
    }

    const pool = new Map<string, SearchCandidate>();
    const rejectedPointIds = new Set<string>();
    const active = branchesOfMode(extensions.mode);
    const retrieval = await retrieveIndependentBranches(
      {
        vectorStore: this.deps.vectorStore,
        target,
        text: query.text,
        filter: built.filter,
        candidateLimit: query.candidateLimit,
        mode: extensions.mode,
        branchTimeoutMs: this.branchTimeoutMs,
        ...(this.deps.sparseVectorizer === undefined
          ? {}
          : { sparseVectorizer: this.deps.sparseVectorizer }),
      },
      options,
    );
    caveats.push(...retrieval.caveats);
    for (const skipped of retrieval.skipped) ledger.add(skipped);
    assertCompletedRetrieval(retrieval, target);
    const {
      densePoints,
      sparsePoints,
      symbolPage,
      completedBranches,
      warnings: branchWarnings,
    } = retrieval;
    this.collect(densePoints, pool, rejectedPointIds, ledger, (candidate, point) => {
      candidate.denseScore = point.denseScore ?? point.score;
    });
    this.collect(sparsePoints, pool, rejectedPointIds, ledger, () => undefined);

    // --- Abruf: Symbolzweig ----------------------------------------------
    let symbolPointCount = 0;
    let symbolLimitReached = false;
    if (symbolPage !== undefined) {
      const symbolPoints = symbolPage.points.map((point) => ({
        id: point.id,
        score: 0,
        payload: point.payload,
      }));
      symbolPointCount = symbolPoints.length;
      symbolLimitReached =
        symbolPage.nextOffset !== undefined || symbolPoints.length >= query.candidateLimit;
      this.collect(symbolPoints, pool, rejectedPointIds, ledger, () => undefined);
      if (symbolPage.nextOffset !== undefined) {
        ledger.add({
          subjectKind: "search_candidate",
          subjectId: `${target.collection}:symbol_scroll`,
          reason: "excluded_by_configuration",
          detail: `exact symbol-name scroll stopped at candidateLimit=${query.candidateLimit}; more exact matches exist in "${target.collection}"`,
          recoverable: true,
        });
      }
    }

    // --- Residuale Filter VOR jeder Rangfolge ------------------------------
    // Ein Kandidat, der laut Anfrage ungueltig ist, darf weder Pool-IDF noch
    // Zweigraenge, exakten Intent oder dessen Gewicht beeinflussen. Dadurch
    // entsprechen alle erklaerten Raenge der Menge, die wirklich antworten
    // durfte. `passesResidualFilters` wird genau einmal je Kandidat gerufen,
    // also entsteht auch genau ein Ledger-Eintrag je Ausschluss.
    const candidates = [...pool.values()].filter((candidate) =>
      this.passesResidualFilters(
        candidate,
        query,
        extensions,
        effectiveScope,
        effectiveRefIds,
        ledger,
      ),
    );
    const eligibleIds = new Set(candidates.map((candidate) => candidate.pointId));
    const denseRankedIds: string[] = [];
    const denseSeen = new Set<string>();
    for (const point of densePoints) {
      if (!eligibleIds.has(point.id) || denseSeen.has(point.id)) {
        continue;
      }
      const candidate = pool.get(point.id);
      if (candidate === undefined) {
        continue;
      }
      denseSeen.add(point.id);
      denseRankedIds.push(point.id);
      candidate.denseRank = denseRankedIds.length;
    }

    // --- Rangfolge: lexikalisch (eigenes BM25 ueber den gueltigen Pool) ----
    const lexicalRanker = new Bm25Ranker(
      candidates.map((candidate) => ({
        id: candidate.pointId,
        text: lexicalDocumentText(candidate.payload),
      })),
    );
    const lexicalRanking =
      active.lexical && completedBranches.has("sparse") ? lexicalRanker.rank(query.text) : [];
    const lexicalRankedIds = lexicalRanking.map((entry) => entry.id);
    for (const entry of lexicalRanking) {
      const candidate = pool.get(entry.id);
      if (candidate !== undefined) {
        candidate.lexicalScore = entry.score;
        candidate.lexicalRank = entry.rank;
      }
    }

    // --- Rangfolge: exakter Symbolname ------------------------------------
    const symbolMatches: {
      id: string;
      strength: number;
      repoId: string;
      refId: string;
      filePath: string;
      startLine: number;
    }[] = [];
    for (const candidate of candidates) {
      const match = matchSymbolName(candidate.payload, query.text);
      if (match !== null) {
        candidate.symbolMatchStrength = match.strength;
        candidate.symbolMatchEvidence = match.evidence;
        symbolMatches.push({
          id: candidate.pointId,
          strength: match.strength,
          repoId: candidate.payload.repo_id,
          refId: candidate.payload.ref_id,
          filePath: candidate.payload.file_path,
          startLine: candidate.payload.start_line,
        });
      }
    }
    symbolMatches.sort((a, b) => {
      if (a.strength !== b.strength) {
        return b.strength - a.strength;
      }
      const byRepo = compareCodepoints(a.repoId, b.repoId);
      if (byRepo !== 0) {
        return byRepo;
      }
      const byRef = compareCodepoints(a.refId, b.refId);
      if (byRef !== 0) {
        return byRef;
      }
      const byPath = compareCodepoints(a.filePath, b.filePath);
      if (byPath !== 0) {
        return byPath;
      }
      if (a.startLine !== b.startLine) {
        return a.startLine - b.startLine;
      }
      return compareCodepoints(a.id, b.id);
    });
    // --- Fusion ------------------------------------------------------------
    const available = {
      dense: active.dense && completedBranches.has("dense"),
      lexical: active.lexical && completedBranches.has("sparse"),
      symbol: active.symbol && completedBranches.has("symbol"),
    };
    const inputs: FusionInput[] = [];
    if (available.dense) {
      inputs.push({ branch: "dense", rankedIds: denseRankedIds });
    }
    // WP-232: Bei klar deutsch formulierten NATUERLICHEN Fragen kann BM25 ein
    // systematischer Gegenspieler des multilingualen Embeddings sein. Es wird
    // aber nur dann weggelassen, wenn sein eigener Spitzenkandidat NICHT in
    // den dichten Top 10 bestaetigt ist. So bleibt nuetzliche Uebereinstimmung
    // (d1 und die deutsche INDEX-SHARING-Probe) erhalten, waehrend die
    // gemessenen Fehlraenge d3/d4/d6 nicht mehr in die Fusion eingehen.
    const omitLexicalForGermanQuestion =
      extensions.mode === "hybrid" &&
      available.dense &&
      available.lexical &&
      shouldOmitUncorroboratedGermanLexicalBranch(query.text, denseRankedIds, lexicalRankedIds);
    if (available.lexical && !omitLexicalForGermanQuestion) {
      inputs.push({ branch: "lexical", rankedIds: lexicalRankedIds });
    }
    if (omitLexicalForGermanQuestion) {
      caveats.push(
        `the lexical ranking branch did not participate because its top candidate was not corroborated in the dense top ${GERMAN_LEXICAL_CORROBORATION_DEPTH} for this German natural-language question; dense multilingual ranking remains active (WP-232)`,
      );
    }
    const effectiveActive = {
      ...available,
      lexical: available.lexical && !omitLexicalForGermanQuestion,
    };
    const exactSymbolMatches = symbolMatches.filter((entry) => entry.strength === 1);
    const exactSymbolIntent =
      available.symbol && exactSymbolMatches.length > 0 && this.branchWeights.symbol > 0;
    const symbolRanking = exactSymbolIntent ? exactSymbolMatches : symbolMatches;
    if (available.symbol) {
      symbolRanking.forEach((entry, index) => {
        const candidate = pool.get(entry.id);
        if (candidate !== undefined) {
          candidate.symbolRank = index + 1;
        }
      });
      inputs.push({ branch: "symbol", rankedIds: symbolRanking.map((entry) => entry.id) });
    }
    const effectiveBranchWeights = exactSymbolIntent
      ? exactSymbolIntentBranchWeights(this.branchWeights, effectiveActive)
      : this.branchWeights;
    if (exactSymbolIntent) {
      caveats.push(
        `exact symbol-name intent: the symbol RRF branch contains only ${exactSymbolMatches.length} character-identical match(es) and uses weight ${effectiveBranchWeights.symbol}; heuristic boost clamping remains unchanged`,
      );
    }
    const fused = fuseRankings(inputs, effectiveBranchWeights);
    const fusionById = new Map(fused.map((entry) => [entry.id, entry]));

    // Kandidaten, die in KEINEM aktiven Zweig auftauchen, sind fuer diesen
    // Modus schlicht nicht relevant. Sie verschwinden trotzdem nicht
    // stillschweigend (E4).
    for (const candidate of candidates) {
      if (!fusionById.has(candidate.pointId)) {
        ledger.addCandidate({
          subjectId: candidate.payload.chunk_id,
          path: candidate.payload.file_path,
          repoId: candidate.payload.repo_id,
          refId: candidate.payload.ref_id,
          reason: "excluded_by_configuration",
          detail: `no active ranking branch (mode "${extensions.mode}") produced a rank for this candidate`,
        });
      }
    }

    // --- Kandidaten mit Basisrang ------------------------------------------
    const scored: ScoredCandidate[] = [];
    for (const entry of fused) {
      const candidate = pool.get(entry.id);
      if (candidate === undefined) {
        continue;
      }
      scored.push({ candidate, baseScore: entry.normalized });
    }

    // --- Dedupe -------------------------------------------------------------
    const deduped = dedupeCandidates(scored);
    for (const group of deduped) {
      for (const absorbed of group.absorbed) {
        ledger.addCandidate({
          subjectId: absorbed.candidate.payload.chunk_id,
          path: absorbed.candidate.payload.file_path,
          repoId: absorbed.candidate.payload.repo_id,
          refId: absorbed.candidate.payload.ref_id,
          reason: "duplicate",
          detail: `merged into chunk "${group.primary.candidate.payload.chunk_id}" as a related fragment (same metrics_scope_id "${absorbed.candidate.payload.metrics_scope_id}")`,
        });
      }
    }

    // --- Diversifizierung ---------------------------------------------------
    const penalties = query.diversify
      ? assignDuplicatePenalties(deduped, (entry) => entry.primary.candidate.payload)
      : deduped.map((entry) => ({ item: entry, penaltyRawValue: 0 }));

    // --- Score-Zerlegung ----------------------------------------------------
    const scoringContext: ScoringContext = {
      queryText: query.text,
      weights: this.config.boostWeights,
      complexityBias: extensions.complexityBias,
      repoPriorities: this.deps.repoPriorities ?? {},
      graphProximity: this.buildProximityMap(deduped),
      ...(this.deps.clock === undefined ? {} : { nowEpochMs: this.deps.clock.nowEpochMs() }),
      recencyHalfLifeDays: this.deps.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS,
    };

    let hits: SearchHitV1[] = [];
    for (const penalized of penalties) {
      const group = penalized.item;
      const fusion = fusionById.get(group.primary.candidate.pointId) as FusionResult;
      const breakdown = assembleScoreBreakdown(
        group.primary.candidate,
        fusion,
        scoringContext,
        penalized.penaltyRawValue,
      );
      const minScore = query.minScore;
      if (minScore !== undefined && breakdown.final < minScore) {
        ledger.addCandidate({
          subjectId: group.primary.candidate.payload.chunk_id,
          path: group.primary.candidate.payload.file_path,
          repoId: group.primary.candidate.payload.repo_id,
          refId: group.primary.candidate.payload.ref_id,
          reason: "excluded_by_configuration",
          detail: `final score ${breakdown.final} is below the effective minScore ${minScore} (${minScoreOrigin})`,
        });
        continue;
      }
      hits.push(
        this.buildHit(
          group.primary.candidate,
          breakdown,
          group.dedupeKey,
          group.relatedFragments,
          target,
          extensions,
        ),
      );
    }

    hits = sortHits(hits, extensions.sort);
    let relevanceWarning: ToolWarningV1 | undefined;
    // Das Verdikt gehoert an die Gruppe, nicht nur in eine Warnung. Bis Welle
    // 14 war es ausschliesslich in `relevanceWarning.details` flachgeklopft —
    // deshalb lasen zehn Stellen im Repository die Enthaltung aus der
    // Listenlaenge statt aus der Entscheidung.
    let relevanceVerdict: SearchRelevanceVerdictV1 | undefined;
    const relevanceBinding = this.relevancePolicies.get(target.embeddingProfileId);
    if (relevanceBinding === undefined && this.relevancePolicies.size > 0) {
      const configuredEmbeddingProfileIds = sortByCodepoints([...this.relevancePolicies.keys()]);
      const detail = `relevance policy was not evaluated because active embedding profile "${target.embeddingProfileId}" has no configured binding; configured profile keys: ${configuredEmbeddingProfileIds.join(", ")}; results were left unchanged`;
      caveats.push(detail);
      relevanceWarning = {
        code: RELEVANCE_POLICY_NOT_EVALUATED_WARNING_CODE,
        message: detail,
        details: {
          status: "not_evaluated",
          basis: "policy_profile_mismatch",
          actualEmbeddingProfileId: target.embeddingProfileId,
          configuredEmbeddingProfileIds,
        },
      };
      relevanceVerdict = {
        abstention: extensions.abstention,
        status: "not_evaluated",
        basis: "policy_profile_mismatch",
      };
    } else if (relevanceBinding !== undefined) {
      const exactSymbolIds = new Set(exactSymbolMatches.map((exact) => exact.id));
      const prerequisiteFailure = relevancePrerequisiteFailure({
        binding: relevanceBinding,
        embeddingProfileId: target.embeddingProfileId,
        workspaceId: query.workspaceId,
        collection: target.collection,
        completedBranches,
        exactSymbolEvidenceAvailable: active.symbol && exactSymbolIds.size > 0,
        abstention: extensions.abstention,
      });
      if (prerequisiteFailure !== undefined) {
        caveats.push(prerequisiteFailure.detail);
        relevanceWarning = prerequisiteFailure.warning;
        relevanceVerdict = prerequisiteFailure.verdict;
      } else {
        // Die Schwellen wurden gegen das feste Praefix von jeweils Rang 50
        // des dichten UND spaerlichen Abrufzweigs kalibriert. Der
        // Ranking-Pool darf groesser sein, die Abwesenheitsevidenz aber nicht:
        // sonst veraendert candidateLimit die Pool-IDF und damit bei
        // identischer Anfrage die Ja/Nein-Antwort. Der Symbolabruf gehoert
        // nicht zur IDF-Kalibrierung; ein exakter Name bleibt eigene direkte
        // Evidenz.
        // Residual ungueltige IDs sind bereits aus `eligibleIds` entfernt und
        // werden innerhalb des festen Praefixes bewusst NICHT durch tiefere
        // Kandidaten ersetzt.
        const evidencePool = selectFixedRelevanceEvidencePool(
          [
            { branch: "dense", candidateIds: densePoints.map((point) => point.id) },
            { branch: "sparse", candidateIds: sparsePoints.map((point) => point.id) },
          ],
          eligibleIds,
          relevanceBinding.policy.denseReferenceRank,
        );
        const evidenceIds = [...evidencePool.candidateIds];
        const evidenceIdSet = new Set(evidenceIds);
        // Der exakte Symbolpfad bleibt direkte Evidenz, auch wenn sehr viele
        // gleichartige Scroll-Treffer vor ihm liegen. Nur residual gueltige
        // `symbolMatches` koennen hier auftauchen.
        if (active.symbol) {
          for (const exactSymbolId of exactSymbolIds) {
            if (!evidenceIdSet.has(exactSymbolId)) {
              evidenceIdSet.add(exactSymbolId);
              evidenceIds.push(exactSymbolId);
            }
          }
        }
        const denseEvidenceIds = new Set(evidencePool.denseCandidateIds);
        const relevanceDecision = decideResultRelevance(
          query.text,
          evidenceIds.flatMap((candidateId) => {
            const candidate = pool.get(candidateId);
            if (candidate === undefined) {
              return [];
            }
            return [
              {
                ...(denseEvidenceIds.has(candidateId) && candidate.denseScore !== undefined
                  ? { denseScore: candidate.denseScore }
                  : {}),
                lexicalText: lexicalDocumentText(candidate.payload),
                exactSymbolMatch: active.symbol && exactSymbolIds.has(candidate.pointId),
              },
            ];
          }),
          relevanceBinding.policy,
        );
        relevanceVerdict = {
          abstention: extensions.abstention,
          status: relevanceDecision.status,
          basis: relevanceDecision.basis,
          calibrationId: relevanceBinding.policy.calibrationId,
        };
        if (relevanceDecision.status === "rejected") {
          const observedReferenceRank = relevanceDecision.denseReferenceRankObserved as number;
          const detail = `candidate rejected by relevance policy "${relevanceBinding.policy.calibrationId}": top dense ${relevanceDecision.topDenseScore ?? "none"} (minimum ${relevanceBinding.policy.minimumDenseScore}), spread between rank 1 and observed rank ${observedReferenceRank} ${relevanceDecision.denseSpread ?? "unavailable"} (minimum ${relevanceBinding.policy.minimumDenseSpread}), fixed per-branch candidate-evidence pool IDF coverage ${relevanceDecision.candidateIdfCoverage} across ${relevanceDecision.candidateEvidenceCount} candidates (minimum ${relevanceBinding.policy.minimumCandidateIdfCoverage}); all three non-symbol conditions are required`;
          // NUR `strict` verwirft. Unter `evidence` bleiben die Treffer
          // stehen und tragen das Verdikt mit — und dann darf auch KEIN
          // Ledger-Eintrag geschrieben werden: ein Eintrag ueber einen
          // Gegenstand, der im Ergebnis steht, ist in diesem Repository ein
          // dokumentierter E4-Defekt (WP-142).
          if (extensions.abstention === "strict") {
            for (const dropped of hits) {
              ledger.addCandidate({
                subjectId: dropped.chunkId,
                path: dropped.filePath,
                repoId: dropped.repoId,
                refId: dropped.refId,
                // NICHT `excluded_by_configuration`: es wurde nichts
                // wegkonfiguriert, und der Kandidat ist nicht durch Filter
                // oder Budget gefallen. Ohne eigenen Grund liesse sich eine
                // Enthaltung nicht von einem Score-Schwellwert trennen (E4).
                reason: "relevance_policy_rejected",
                detail,
              });
            }
            hits = [];
          }
          // Vorbehalt und Warnung sind in BEIDEN Verhalten byte-identisch:
          // das Urteil aendert sich nicht, nur was mit den Treffern geschieht.
          caveats.push(detail);
          relevanceWarning = {
            code: NO_SUFFICIENT_MATCH_WARNING_CODE,
            message: `No sufficiently relevant result for embedding profile "${target.embeddingProfileId}": without an exact symbol name, the dense top score, gap to the fixed reference rank and IDF-weighted query coverage must jointly support the verdict within the fixed evidence pool`,
            details: {
              embeddingProfileId: target.embeddingProfileId,
              collection: target.collection,
              ...relevanceDecision,
            },
          };
        } else if (relevanceDecision.status === "not_evaluated") {
          const detail = `relevance policy "${relevanceBinding.policy.calibrationId}" was not evaluated: the deepest dense rank actually observed was ${relevanceDecision.deepestDenseRankObserved}, so calibrated reference rank ${relevanceBinding.policy.denseReferenceRank} was not observed; results were left unchanged`;
          caveats.push(detail);
          relevanceWarning = {
            code: RELEVANCE_POLICY_NOT_EVALUATED_WARNING_CODE,
            message: detail,
            details: {
              embeddingProfileId: target.embeddingProfileId,
              collection: target.collection,
              ...relevanceDecision,
            },
          };
        }
      }
    }
    const qualifiedHitCount = hits.length;
    const topScoreGap =
      hits.length < 2
        ? null
        : (hits[0] as SearchHitV1).score.final - (hits[1] as SearchHitV1).score.final;
    if (hits.length > query.limit) {
      for (const dropped of hits.slice(query.limit)) {
        ledger.addCandidate({
          subjectId: dropped.chunkId,
          path: dropped.filePath,
          repoId: dropped.repoId,
          refId: dropped.refId,
          reason: "excluded_by_configuration",
          detail: `final score ${dropped.score.final} ranked below the requested limit of ${query.limit} results`,
        });
      }
      hits = hits.slice(0, query.limit);
    }
    hits = assignRanks(hits);

    const uniqueEligibleFileCount = new Set(
      candidates.map(
        (candidate) =>
          `${candidate.payload.repo_id}\u001f${candidate.payload.ref_id}\u001f${candidate.payload.file_path}`,
      ),
    ).size;
    const uniqueEligibleSymbolCount = new Set(
      candidates.flatMap((candidate) =>
        candidate.payload.symbol_id === undefined
          ? []
          : [
              `${candidate.payload.repo_id}\u001f${candidate.payload.ref_id}\u001f${candidate.payload.symbol_id}`,
            ],
      ),
    ).size;
    const eligibleFileDispersion =
      candidates.length <= 1 ? 0 : (uniqueEligibleFileCount - 1) / (candidates.length - 1);
    const {
      contexts: scopedIndexContexts,
      corpusRevisionFingerprint,
      warning: indexContextWarning,
    } = this.indexContextProvenance(
      target,
      built.scopeRepoIds,
      effectiveRefIds,
      candidates,
      query.filters.refIds.length === 0,
    );
    // WP-189: Der Vertrag von `SearchHitGroupV1.repoIds` lautet „Repositories,
    // die zu dieser Gruppe BEITRAGEN". Hier stand der erlaubte Bereich — also
    // eine Aussage ueber die Anfrage, ausgegeben als Aussage ueber das
    // Ergebnis. Bei drei erlaubten und einem liefernden Repository nannte die
    // Gruppe drei Herkuenfte, von denen zwei nichts beigetragen hatten.
    const contributing = uniqueSortedByCodepoints(hits.map((hit) => hit.repoId));
    return {
      group: {
        embeddingProfileId: target.embeddingProfileId,
        // A completed local state proves provenance for an empty result, but
        // must never lend its generation to a returned legacy candidate that
        // did not carry `generation_id` itself. The display field may retain
        // the legacy dependency fallback; corpus provenance below never does.
        indexGenerations: uniqueSortedByCodepoints(
          candidates.length === 0
            ? scopedIndexContexts.map((context) => context.generationId)
            : candidates.map((candidate) => this.indexGenerationOf(candidate)),
        ),
        ...(corpusRevisionFingerprint === undefined ? {} : { corpusRevisionFingerprint }),
        repoIds: contributing,
        hits,
        rankNormalized: false,
        caveats,
        ...(relevanceVerdict === undefined ? {} : { relevanceDecision: relevanceVerdict }),
        retrieval: {
          branchCandidateCounts: {
            dense: densePoints.length,
            sparse: sparsePoints.length,
            symbol: symbolPointCount,
          },
          uniqueRetrievedCandidateCount: pool.size,
          eligibleCandidateCount: candidates.length,
          rankedCandidateCount: fused.length,
          deduplicatedCandidateCount: deduped.length,
          qualifiedHitCount,
          returnedHitCount: hits.length,
          uniqueEligibleFileCount,
          uniqueEligibleSymbolCount,
          eligibleFileDispersion,
          topScoreGap,
          candidateLimitReached:
            densePoints.length >= query.candidateLimit ||
            sparsePoints.length >= query.candidateLimit ||
            symbolLimitReached,
        },
      },
      refIds: new Set(hits.map((hit) => hit.refId)),
      ...(relevanceWarning === undefined ? {} : { relevanceWarning }),
      ...(indexContextWarning === undefined ? {} : { indexContextWarning }),
      ...(branchWarnings.length === 0 ? {} : { branchWarnings }),
    };
  }

  /** Uebernimmt Speicherpunkte in den Kandidatenpool; unbrauchbare landen im Ledger. */
  private collect(
    points: readonly ScoredPointV1[],
    pool: Map<string, SearchCandidate>,
    rejectedPointIds: Set<string>,
    ledger: SearchSkipLedger,
    onCandidate: (candidate: SearchCandidate, point: ScoredPointV1) => void,
  ): void {
    points.forEach((point) => {
      if (rejectedPointIds.has(point.id)) {
        return;
      }
      const existing = pool.get(point.id);
      if (existing !== undefined) {
        onCandidate(existing, point);
        return;
      }
      const result = candidateFromPoint(point);
      if (!result.ok) {
        rejectedPointIds.add(point.id);
        ledger.addCandidate({
          subjectId: point.id,
          reason: "missing_index_entry",
          detail: `point "${point.id}" could not be read as a code chunk: ${result.reason}`,
        });
        return;
      }
      pool.set(point.id, result.candidate);
      onCandidate(result.candidate, point);
    });
  }

  /** Pfad-Globs und Findability — die Filter, die der Speicher nicht kennt. */
  private passesResidualFilters(
    candidate: SearchCandidate,
    query: SearchQueryV1,
    extensions: SearchQueryExtensionsV1,
    scope: SearchScopeV1,
    effectiveRefIds: readonly string[],
    ledger: SearchSkipLedger,
  ): boolean {
    const { payload } = candidate;
    // Der Geltungsbereich steht bereits im Speicherfilter. Er wird hier ein
    // ZWEITES Mal geprueft, weil ein Speicher, der den Filter nicht oder
    // anders auswertet, sonst fremden Inhalt als eigenen ausliefern wuerde —
    // und das waere kein ungenaues Ranking, sondern ein Datenleck.
    if (payload.workspace_id !== scope.workspaceId) {
      ledger.addCandidate({
        subjectId: payload.chunk_id,
        path: payload.file_path,
        repoId: payload.repo_id,
        refId: payload.ref_id,
        reason: "excluded_by_configuration",
        detail: `candidate belongs to workspace "${payload.workspace_id}", but the query is scoped to workspace "${scope.workspaceId}"`,
      });
      return false;
    }
    const targetRepoIds = scope.targetRepoIds ?? [];
    if (targetRepoIds.length > 0 && !targetRepoIds.includes(payload.repo_id)) {
      ledger.addCandidate({
        subjectId: payload.chunk_id,
        path: payload.file_path,
        repoId: payload.repo_id,
        refId: payload.ref_id,
        reason: "excluded_by_configuration",
        detail: `candidate belongs to repository "${payload.repo_id}", which is not one of this target's repositories [${sortByCodepoints([...targetRepoIds]).join(", ")}]`,
      });
      return false;
    }
    if (effectiveRefIds.length > 0 && !effectiveRefIds.includes(payload.ref_id)) {
      ledger.addCandidate({
        subjectId: payload.chunk_id,
        path: payload.file_path,
        repoId: payload.repo_id,
        refId: payload.ref_id,
        reason: "excluded_by_configuration",
        detail: `candidate belongs to ref "${payload.ref_id}", which is not one of the effective refs [${sortByCodepoints([...effectiveRefIds]).join(", ")}]`,
      });
      return false;
    }
    if (!isPathSelected(payload.file_path, query.filters.pathGlobs, extensions.pathExcludes)) {
      ledger.addCandidate({
        subjectId: payload.chunk_id,
        path: payload.file_path,
        repoId: payload.repo_id,
        refId: payload.ref_id,
        reason: "excluded_by_configuration",
        detail: `path "${payload.file_path}" does not pass the include/exclude globs (include: [${query.filters.pathGlobs.join(", ")}], exclude: [${extensions.pathExcludes.join(", ")}])`,
      });
      return false;
    }
    const findabilityFilter = query.filters.findability;
    const lookup = this.deps.findability;
    if (findabilityFilter !== undefined && lookup !== undefined) {
      const summary = payload.symbol_id === undefined ? undefined : lookup(payload.symbol_id);
      if (summary === undefined) {
        ledger.addCandidate({
          subjectId: payload.chunk_id,
          path: payload.file_path,
          repoId: payload.repo_id,
          refId: payload.ref_id,
          reason: "missing_index_entry",
          detail:
            "a findability filter was requested but no findability record exists for this symbol",
          recoverable: true,
        });
        return false;
      }
      const { minScore, maxScore, causes } = findabilityFilter;
      const failsMin = minScore !== undefined && summary.score < minScore;
      const failsMax = maxScore !== undefined && summary.score > maxScore;
      const failsCause =
        causes !== undefined &&
        causes.length > 0 &&
        (summary.primaryCause === undefined || !causes.includes(summary.primaryCause));
      if (failsMin || failsMax || failsCause) {
        ledger.addCandidate({
          subjectId: payload.chunk_id,
          path: payload.file_path,
          repoId: payload.repo_id,
          refId: payload.ref_id,
          reason: "excluded_by_configuration",
          detail: `findability score ${summary.score} / cause "${summary.primaryCause ?? "none"}" does not satisfy the requested findability filter`,
        });
        return false;
      }
    }
    return true;
  }

  private buildProximityMap(
    deduped: readonly { primary: ScoredCandidate }[],
  ): ReadonlyMap<string, number> {
    const map = new Map<string, number>();
    const lookup = this.deps.graphProximity;
    if (lookup === undefined) {
      return map;
    }
    for (const group of deduped) {
      const symbolId = group.primary.candidate.payload.symbol_id;
      if (symbolId === undefined || map.has(symbolId)) {
        continue;
      }
      const value = lookup(symbolId);
      if (value !== undefined) {
        map.set(symbolId, value);
      }
    }
    return map;
  }

  private buildHit(
    candidate: SearchCandidate,
    score: SearchHitV1["score"],
    dedupeKey: string,
    relatedFragments: SearchHitV1["relatedFragments"],
    target: ProfileTargetV1,
    extensions: SearchQueryExtensionsV1,
  ): SearchHitV1 {
    const { payload } = candidate;
    const findabilitySummary =
      payload.symbol_id === undefined ? undefined : this.deps.findability?.(payload.symbol_id);
    const contentRequested = extensions.includeContent;
    const hasContent = payload.content !== "";
    const complexity = this.complexityOf(candidate);
    return {
      schemaVersion: 1,
      // Der endgueltige Rang wird nach der Sortierung gesetzt (`assignRanks`);
      // bis dahin ist 0 ein bewusst ungueltiger Platzhalter, kein Rang 1.
      rank: 0,
      repoId: payload.repo_id,
      repoLabel: payload.repo_label,
      refId: payload.ref_id,
      refName: payload.ref_name,
      ...(payload.commit_sha === undefined ? {} : { commitSha: payload.commit_sha }),
      fileId: payload.file_id,
      filePath: payload.file_path,
      range: {
        startLine: payload.start_line,
        endLine: payload.end_line,
        startByte: payload.start_byte,
        endByte: payload.end_byte,
      },
      language: payload.language,
      parseQuality: payload.parse_quality,
      chunkId: payload.chunk_id,
      chunkKind: payload.chunk_kind,
      ...(payload.fragment_index === undefined ? {} : { fragmentIndex: payload.fragment_index }),
      ...(payload.fragment_count === undefined ? {} : { fragmentCount: payload.fragment_count }),
      ...(payload.symbol_id === undefined ? {} : { symbolId: payload.symbol_id }),
      ...(payload.symbol_name === undefined ? {} : { symbolName: payload.symbol_name }),
      ...(payload.symbol_fqn === undefined ? {} : { symbolFqn: payload.symbol_fqn }),
      ...(payload.symbol_kind === undefined ? {} : { symbolKind: payload.symbol_kind }),
      ...(payload.signature === undefined ? {} : { signature: payload.signature }),
      score,
      dedupeKey,
      relatedFragments,
      embeddingProfileId: target.embeddingProfileId,
      indexGeneration: this.indexGenerationOf(candidate),
      ...(complexity === undefined ? {} : { complexity }),
      ...(findabilitySummary === undefined ? {} : { findability: findabilitySummary }),
      ...(contentRequested && hasContent ? { content: payload.content } : {}),
      ...(contentRequested && !hasContent
        ? {
            contentOmittedReason:
              "the stored chunk payload carries no content (indexed without content, or content stripped at index time)",
          }
        : {}),
      ...(candidate.substitutedFields.length === 0
        ? {}
        : { incompletePayloadFields: [...candidate.substitutedFields] }),
    };
  }

  private indexGenerationOf(candidate: SearchCandidate): string {
    return this.rawIndexGenerationOf(candidate) ?? this.deps.indexGeneration ?? "unknown";
  }

  /** Persisted candidate provenance; display fallbacks are deliberately excluded. */
  private rawIndexGenerationOf(candidate: SearchCandidate): string | undefined {
    return readRawString(candidate.raw, "generation_id");
  }

  private indexContextProvenance(
    target: ProfileTargetV1,
    scopeRepoIds: readonly string[],
    scopedRefIds: readonly string[],
    candidates: readonly SearchCandidate[],
    refScopeWasImplicit: boolean,
  ): {
    contexts: NonNullable<ProfileTargetV1["indexContexts"]>;
    corpusRevisionFingerprint?: string;
    warning?: ToolWarningV1;
  } {
    const contexts = (target.indexContexts ?? []).filter(
      (context) =>
        scopeRepoIds.includes(context.repoId) &&
        (scopedRefIds.length === 0 || scopedRefIds.includes(context.refId)),
    );
    const completedContextExists = (repoId: string, refId?: string, generationId?: string) =>
      contexts.some(
        (context) =>
          context.outcome === "completed" &&
          context.repoId === repoId &&
          (refId === undefined || context.refId === refId) &&
          (generationId === undefined || context.generationId === generationId),
      );
    // An implicit scope represents "the recorded current ref(s) of every
    // selected repository", so every repository needs a completed context.
    // Explicit repo-qualified ref IDs instead form real repo/ref pairs. They
    // are not a Cartesian product: repo-a:main does not need to exist in
    // repo-b merely because both repos and both refs were selected.
    const hasCompleteScopeCoverage =
      contexts.length > 0 &&
      (refScopeWasImplicit
        ? scopeRepoIds.every((repoId) => completedContextExists(repoId))
        : scopedRefIds.every((refId) =>
            contexts.some((context) => context.outcome === "completed" && context.refId === refId),
          ));
    const candidatesHaveCompletedContext = candidates.every((candidate) => {
      const rawGenerationId = this.rawIndexGenerationOf(candidate);
      return (
        rawGenerationId !== undefined &&
        completedContextExists(candidate.payload.repo_id, candidate.payload.ref_id, rawGenerationId)
      );
    });
    const incomplete =
      target.indexContexts !== undefined &&
      (!hasCompleteScopeCoverage ||
        !candidatesHaveCompletedContext ||
        contexts.some(
          (context) =>
            context.outcome !== "completed" || context.corpusRevisionFingerprint === undefined,
        ));
    if (!incomplete) {
      if (target.indexContexts === undefined) return { contexts };
      const corpusContexts = contexts
        .map((context) => ({
          repoId: context.repoId,
          refId: context.refId,
          generationId: context.generationId,
          corpusRevisionFingerprint: context.corpusRevisionFingerprint as string,
        }))
        .sort((left, right) => compareCodepoints(canonicalJson(left), canonicalJson(right)));
      return {
        contexts,
        corpusRevisionFingerprint: sha256Hex(
          canonicalJson({
            schemaVersion: 1,
            embeddingProfileId: target.embeddingProfileId,
            contexts: corpusContexts,
          }),
        ),
      };
    }
    return {
      contexts,
      warning: {
        code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
        message:
          `index completion could not be verified for embedding profile "${target.embeddingProfileId}"; ` +
          "hits remain usable, but this search is not healthy product-complexity evidence",
        details: {
          embeddingProfileId: target.embeddingProfileId,
          observedOutcomes: uniqueSortedByCodepoints(contexts.map((context) => context.outcome)),
        },
      },
    };
  }

  private complexityOf(candidate: SearchCandidate): SearchHitV1["complexity"] {
    const { payload } = candidate;
    const values = {
      ...(payload.cyclomatic_classic === undefined
        ? {}
        : { cyclomaticClassic: payload.cyclomatic_classic }),
      ...(payload.cyclomatic_extended === undefined
        ? {}
        : { cyclomaticExtended: payload.cyclomatic_extended }),
      ...(payload.cognitive === undefined ? {} : { cognitive: payload.cognitive }),
      ...(payload.max_nesting === undefined ? {} : { maxNesting: payload.max_nesting }),
      ...(payload.sloc === undefined ? {} : { sloc: payload.sloc }),
      ...(payload.halstead_volume === undefined ? {} : { halsteadVolume: payload.halstead_volume }),
      ...(payload.maintainability_index === undefined
        ? {}
        : { maintainabilityIndex: payload.maintainability_index }),
      ...(payload.risk_score === undefined ? {} : { riskScore: payload.risk_score }),
    };
    if (Object.keys(values).length === 0) {
      return undefined;
    }
    return {
      metricsScope: payload.metrics_scope,
      metricsScopeId: payload.metrics_scope_id,
      metricsVersion: payload.metrics_version,
      ...values,
    };
  }
}

/** Kleiner Bequemlichkeits-Konstruktor. */
export function createHybridSearchEngine(deps: HybridSearchEngineDeps): HybridSearchEngine {
  return new HybridSearchEngine(deps);
}

/** Wiederexport, damit Aufrufer den Filtertyp nicht aus zwei Paketen ziehen muessen. */
export type { PayloadFilter };

function markFinalHitGraphUnavailable(
  groups: SearchHitGroupV1[],
  query: SearchQueryV1,
  detail: string,
): void {
  for (const group of groups) {
    for (const hit of group.hits) {
      if (query.includeGraphContext) {
        hit.graphContext = unavailableSearchGraphRelations("graph_unavailable", detail);
      }
      if (query.includeLinked) {
        hit.linkedSymbols = unavailableSearchGraphRelations("graph_unavailable", detail);
      }
    }
  }
}
