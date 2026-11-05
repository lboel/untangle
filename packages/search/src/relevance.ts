/**
 * Ergebnis-Relevanz und Abwesenheitsaussage (WP-231).
 *
 * Ein Listenmaximum allein ist kein Relevanzbeleg: irgendein Kandidat ist
 * immer der beste, auch wenn die gesuchte Sache im Repository nicht
 * existiert. Die kalibrierte Entscheidung hat deshalb genau zwei Wege:
 *
 * 1. ein exakter Symbolname ist direkte Evidenz;
 * 2. sonst muessen ALLE drei gemessenen Signale tragen: absoluter dichter
 *    Topwert, relativer Abstand zu einem festen dichten Referenzrang und die
 *    IDF-gewichtete Abdeckung der normalisierten Query-Terme in einem
 *    einzelnen Kandidaten der festen Dense-/Sparse-Evidenzunion.
 *
 * Die exportierte qwen-Policy ist am stehenden, in
 * `benchmark/signals.mjs` vermessenen Untangle-Selbstindex kalibriert. Die
 * Konjunktion behaelt dort alle 22 beantwortbaren Hauptfragen sowie sieben
 * getrennte deutsche Prosa-Proben und verwirft 11 von 14 klaren bzw.
 * adversarialen Negativfragen. Die beiden nachgemessenen Grenzwerte liegen
 * bewusst zwischen dem jeweils schwaechsten positiven und staerksten klar
 * negativen Signal; kein einzelnes Signal darf allein entscheiden. Andere
 * Modelle oder Korpora koennen voellig andere Wertebereiche haben. Deshalb
 * hat die Engine keinen universellen Default, und jede Policy muss zusaetzlich
 * an Workspace und Collection gebunden werden. Auch nach einer wesentlichen
 * Revision desselben Korpus ist neu zu messen und zu kalibrieren.
 */
import { termFrequencies, tokenizeIdentifiers } from "./tokenize.js";

export const NO_SUFFICIENT_MATCH_WARNING_CODE = "NO_SUFFICIENT_MATCH";
export const RELEVANCE_POLICY_NOT_EVALUATED_WARNING_CODE = "RELEVANCE_POLICY_NOT_EVALUATED";

export interface RelevancePolicyV1 {
  /** Menschen- und maschinenlesbare Herkunft der Kalibrierung. */
  calibrationId: string;
  /** Absoluter Mindestwert des besten dichten Kandidaten. */
  minimumDenseScore: number;
  /** Mindestabstand zwischen bestem dichten Wert und `denseReferenceRank`. */
  minimumDenseSpread: number;
  /** 1-basierter fester Vergleichsrang; fehlt er, wird NICHT entschieden. */
  denseReferenceRank: number;
  /**
   * IDF-gewichteter Mindestanteil aller normalisierten Query-Terme im festen
   * Evidenzpool aus Dense- und Sparse-Praefix.
   */
  minimumCandidateIdfCoverage: number;
}

/** Bindet eine Modellkalibrierung an genau das vermessene Korpus. */
export interface RelevancePolicyBindingV1 {
  workspaceId: string;
  collection: string;
  policy: RelevancePolicyV1;
}

export const QWEN3_EMBEDDING_06B_RELEVANCE_POLICY: Readonly<RelevancePolicyV1> = {
  calibrationId: "qwen3-embedding:0.6b/untangle-self-index-2026-09-05",
  minimumDenseScore: 0.45,
  minimumDenseSpread: 0.061,
  denseReferenceRank: 50,
  minimumCandidateIdfCoverage: 0.291,
};

export type RelevancePolicyConfig = false | RelevancePolicyV1;

export interface RelevanceCandidateEvidence {
  denseScore?: number;
  lexicalText: string;
  exactSymbolMatch: boolean;
}

export type RelevanceDecisionStatus = "accepted" | "rejected" | "not_evaluated";

export type RelevanceDecisionBasis =
  | "exact_symbol"
  | "dense_absolute_relative_and_candidate_idf_coverage"
  | "insufficient_evidence"
  | "dense_reference_unavailable";

/** Vollstaendige, maschinenlesbare Begruendung fuer Treffer, Enthaltung oder Nichtentscheidung. */
export interface RelevanceDecisionV1 {
  status: RelevanceDecisionStatus;
  basis: RelevanceDecisionBasis;
  exactSymbolMatches: number;
  topDenseScore?: number;
  /** Nur gesetzt, wenn der kalibrierte feste Referenzrang wirklich beobachtet wurde. */
  denseReferenceScore?: number;
  /** Nur aus Topwert und dem wirklich beobachteten festen Referenzrang berechnet. */
  denseSpread?: number;
  denseScoresObserved: number;
  /** Tiefster tatsaechlich beobachteter dichter Rang; 0 bedeutet keine dichte Evidenz. */
  deepestDenseRankObserved: number;
  /** Nur gesetzt, wenn genau der kalibrierte Referenzrang beobachtet wurde. */
  denseReferenceRankObserved?: number;
  /** Zahl der Kandidaten in der festen, residual gueltigen Evidenzunion. */
  candidateEvidenceCount: number;
  candidateIdfCoverage: number;
  queryTerms: string[];
  policy: RelevancePolicyV1;
}

export interface CandidateIdfCoverageV1 {
  coverage: number;
  queryTerms: string[];
}

export interface CompleteRelevanceMeasurementsV1 {
  topDenseScore: number;
  denseSpread: number;
  candidateIdfCoverage: number;
}

/** Die qwen-Kalibrierung misst die feste Union aus dichtem und spaerlichem Abruf. */
export type RelevanceEvidenceBranch = "dense" | "sparse";

export interface RelevanceEvidenceBranchV1 {
  branch: RelevanceEvidenceBranch;
  candidateIds: readonly string[];
}

export interface FixedRelevanceEvidencePoolV1 {
  /** Deterministische Union der kalibrierten Praefixe in Zweigreihenfolge. */
  candidateIds: string[];
  /** Gueltige Kandidaten im festen dichten Praefix; nur sie tragen Dense-Scores. */
  denseCandidateIds: string[];
}

/**
 * Baut einen von einem groesseren Abruflimit unabhaengigen Evidenzpool.
 *
 * Pro Abrufzweig zaehlt ausschliesslich das feste rohe Praefix der
 * Kalibrierung. Erst danach werden residual ungueltige Kandidaten entfernt;
 * ein tieferer Kandidat darf einen ausgeschlossenen Praefix-Kandidaten nicht
 * ersetzen, nur weil der Aufrufer statt 50 nun 200 Treffer abruft. Fehlt
 * dadurch ein dichter Referenzrang, trifft `decideResultRelevance` die
 * sichtbare konservative Nichtentscheidung.
 */
export function selectFixedRelevanceEvidencePool(
  branches: readonly RelevanceEvidenceBranchV1[],
  eligibleCandidateIds: ReadonlySet<string>,
  branchDepth: number,
): FixedRelevanceEvidencePoolV1 {
  if (!Number.isInteger(branchDepth) || branchDepth < 1) {
    throw new Error(`relevance evidence branchDepth must be an integer >= 1, got ${branchDepth}`);
  }
  const candidateIds: string[] = [];
  const denseCandidateIds: string[] = [];
  const seen = new Set<string>();
  const denseSeen = new Set<string>();
  for (const branch of branches) {
    for (const candidateId of branch.candidateIds.slice(0, branchDepth)) {
      if (!eligibleCandidateIds.has(candidateId)) {
        continue;
      }
      if (branch.branch === "dense" && !denseSeen.has(candidateId)) {
        denseSeen.add(candidateId);
        denseCandidateIds.push(candidateId);
      }
      if (!seen.has(candidateId)) {
        seen.add(candidateId);
        candidateIds.push(candidateId);
      }
    }
  }
  return { candidateIds, denseCandidateIds };
}

/** Validiert eine explizit profilgebundene Policy; ohne Vorgabe bleibt Legacy-Verhalten. */
export function resolveRelevancePolicy(
  config: RelevancePolicyConfig | undefined,
): RelevancePolicyV1 | false {
  if (config === false || config === undefined) {
    return false;
  }
  const policy = { ...config };
  if (policy.calibrationId.trim() === "") {
    throw new Error("relevancePolicy.calibrationId must not be empty");
  }
  assertFiniteRange("minimumDenseScore", policy.minimumDenseScore, -1, 1);
  assertFiniteRange("minimumDenseSpread", policy.minimumDenseSpread, 0, 2);
  if (!Number.isInteger(policy.denseReferenceRank) || policy.denseReferenceRank < 2) {
    throw new Error(
      `relevancePolicy.denseReferenceRank must be an integer >= 2, got ${String(policy.denseReferenceRank)}`,
    );
  }
  assertFiniteRange("minimumCandidateIdfCoverage", policy.minimumCandidateIdfCoverage, 0, 1);
  return policy;
}

/** Validiert und kopiert die Korpusbindung einer Policy. */
export function resolveRelevancePolicyBinding(
  binding: RelevancePolicyBindingV1,
): RelevancePolicyBindingV1 {
  const workspaceId = binding.workspaceId.trim();
  const collection = binding.collection.trim();
  if (workspaceId === "") {
    throw new Error("relevancePolicy binding workspaceId must not be empty");
  }
  if (collection === "") {
    throw new Error("relevancePolicy binding collection must not be empty");
  }
  const policy = resolveRelevancePolicy(binding.policy);
  if (policy === false) {
    throw new Error("relevancePolicy binding must contain an enabled policy");
  }
  return { workspaceId, collection, policy };
}

/**
 * Entscheidet rein aus Kandidatenevidenz; keine Liste wird am eigenen
 * Maximum normalisiert. Fehlt der feste Referenzrang, ist eine kalibrierte
 * Negativentscheidung unzulaessig. Ein exakter Symbolname darf weiterhin
 * direkt akzeptieren.
 */
export function decideResultRelevance(
  queryText: string,
  candidates: readonly RelevanceCandidateEvidence[],
  policy: RelevancePolicyV1,
): RelevanceDecisionV1 {
  const exactSymbolMatches = candidates.filter((candidate) => candidate.exactSymbolMatch).length;
  const denseScores = candidates
    .map((candidate) => candidate.denseScore)
    .filter((score): score is number => score !== undefined && Number.isFinite(score))
    .sort((left, right) => right - left);
  const topDenseScore = denseScores[0];
  const coverage = maximumCandidateIdfCoverage(
    queryText,
    candidates.map((candidate) => candidate.lexicalText),
  );
  const shared = {
    exactSymbolMatches,
    ...(topDenseScore === undefined ? {} : { topDenseScore }),
    denseScoresObserved: denseScores.length,
    deepestDenseRankObserved: denseScores.length,
    candidateEvidenceCount: candidates.length,
    candidateIdfCoverage: coverage.coverage,
    queryTerms: coverage.queryTerms,
    policy: { ...policy },
  };

  if (exactSymbolMatches > 0) {
    return { status: "accepted", basis: "exact_symbol", ...shared };
  }
  if (denseScores.length < policy.denseReferenceRank) {
    return {
      status: "not_evaluated",
      basis: "dense_reference_unavailable",
      ...shared,
    };
  }

  const denseReferenceScore = denseScores[policy.denseReferenceRank - 1] as number;
  const denseSpread = (topDenseScore as number) - denseReferenceScore;
  const sufficient = satisfiesNonSymbolRelevancePolicy(
    {
      topDenseScore: topDenseScore as number,
      denseSpread,
      candidateIdfCoverage: coverage.coverage,
    },
    policy,
  );
  return {
    status: sufficient ? "accepted" : "rejected",
    basis: sufficient
      ? "dense_absolute_relative_and_candidate_idf_coverage"
      : "insufficient_evidence",
    ...shared,
    denseReferenceScore,
    denseSpread,
    denseReferenceRankObserved: policy.denseReferenceRank,
  };
}

/** Die drei Nicht-Symbol-Signale sind bewusst eine Konjunktion. */
export function satisfiesNonSymbolRelevancePolicy(
  measurements: CompleteRelevanceMeasurementsV1,
  policy: RelevancePolicyV1,
): boolean {
  return (
    measurements.topDenseScore >= policy.minimumDenseScore &&
    measurements.denseSpread >= policy.minimumDenseSpread &&
    measurements.candidateIdfCoverage >= policy.minimumCandidateIdfCoverage
  );
}

/**
 * Groesster IDF-gewichteter Anteil ALLER normalisierten Query-Terme, den EIN
 * Kandidat gemeinsam belegt. IDF wird ausschliesslich im tatsaechlichen
 * Kandidatenpool berechnet; auch dort unbelegte Query-Terme bleiben mit ihrem
 * hohen Gewicht im Nenner. Ein ueber mehrere Treffer verteilter Wortsalat
 * gilt damit nicht als Antwort.
 */
export function maximumCandidateIdfCoverage(
  queryText: string,
  documents: readonly string[],
): CandidateIdfCoverageV1 {
  const queryTerms = [...termFrequencies(tokenizeIdentifiers(queryText)).keys()];
  if (queryTerms.length === 0 || documents.length === 0) {
    return { coverage: 0, queryTerms };
  }

  const documentTerms = documents.map((document) => new Set(tokenizeIdentifiers(document)));
  const poolSize = documentTerms.length;
  const weightedTerms = queryTerms.map((term) => {
    const documentFrequency = documentTerms.filter((terms) => terms.has(term)).length;
    const idf = Math.log(1 + (poolSize - documentFrequency + 0.5) / (documentFrequency + 0.5));
    return { term, idf };
  });
  const totalIdf = weightedTerms.reduce((sum, entry) => sum + entry.idf, 0);
  if (totalIdf === 0) {
    return { coverage: 0, queryTerms };
  }

  let maximum = 0;
  for (const terms of documentTerms) {
    const matchedIdf = weightedTerms
      .filter((entry) => terms.has(entry.term))
      .reduce((sum, entry) => sum + entry.idf, 0);
    maximum = Math.max(maximum, matchedIdf / totalIdf);
  }
  return { coverage: maximum, queryTerms };
}

function assertFiniteRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `relevancePolicy.${name} must be finite and in [${minimum}, ${maximum}], got ${String(value)}`,
    );
  }
}
