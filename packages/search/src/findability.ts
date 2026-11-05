/**
 * Findability als Eigenschaft je Symbol (vision.md §1d).
 *
 * Die These, um die es hier geht, steht woertlich in vision.md §1d:
 *
 * > Wenn die Suche nach „Funktion X" nicht schnell an der richtigen Stelle
 * > landet, ist das ein Befund ueber den Code — nicht nur ueber die Suche.
 *
 * Deshalb sucht sich hier ein Symbol SELBST: einmal mit seinem Namen, einmal
 * mit seiner Signatur. Was dabei herauskommt — Rang, Streuung der Treffer,
 * Sprungzahl — ist die Messung. Dass die Score-Zerlegung des Abrufkerns dabei
 * mitlaeuft, ist kein Zufall: ohne sie liesse sich „der richtige Treffer
 * rankt niedrig" nicht von „es gibt gar keinen Treffer" unterscheiden, und das
 * sind zwei VERSCHIEDENE Befunde ueber den Code.
 *
 * ALLES HIER IST HEURISTIK, und die Domain erzwingt das strukturell:
 * `isHeuristic` ist auf `true` typisiert, die Confidence auf `heuristic`
 * festgenagelt. Ein Findability-Wert kann deshalb nirgends die Stelle eines
 * gemessenen Complexity-Werts einnehmen.
 */
import type {
  Clock,
  FindabilityDiagnosisBasisV1,
  FindabilityDiagnosisV1,
  FindabilityDispersionV1,
  FindabilityEvidenceV1,
  FindabilityHopsV1,
  FindabilityOutcomeV1,
  FindabilityProbeKind,
  FindabilityProbeV1,
  FindabilityRankMissingReason,
  FindabilityRetrievalUnavailableReason,
  FindabilityUnavailableV1,
  HeuristicConfidenceV1,
  PortCallOptions,
  SearchResultSetV1,
  SkipLedgerEntryV1,
} from "@untangle-code/domain";
import {
  FINDABILITY_ALGORITHM_ID,
  RANKER_VERSION,
  buildFindabilityId,
  buildSkipLedgerEntry,
  isUntangleError,
  makeFindabilityUnavailable,
  openFindabilityDiagnosisBasis,
  sortByCodepoints,
} from "@untangle-code/domain";

import type { SearchPort } from "./port.js";

/** Das Symbol, dessen Auffindbarkeit gemessen wird. */
export interface FindabilitySubject {
  workspaceId: string;
  repoId: string;
  refId: string;
  symbolId: string;
  symbolName: string;
  symbolFqn: string;
  /** „/"-normalisierter, repo-relativer Pfad. */
  filePath: string;
  signature?: string;
}

/** Liefert die Sprungzahl vom Rang-1-Treffer zum Zielsymbol (Symbolgraph). */
export type HopsLookup = (input: {
  fromSymbolId: string;
  toSymbolId: string;
}) => FindabilityHopsV1 | undefined;

export interface FindabilityOptions {
  /** Wie viele Treffer eine Sonde anfordert; Default 10. */
  probeLimit?: number;
  hops?: HopsLookup;
  generationId: string;
  /**
   * Optionale Vorpruefung: ist das Symbol ueberhaupt indexiert? Fehlt sie,
   * wird nicht geraten — dann bleibt nur, was die Suche selbst meldet.
   * Antwortet sie `false`, entsteht ein Zustandsvermerk statt einer Messung:
   * ein nicht indexiertes Symbol findet sich nicht, und das sagt nichts ueber
   * seinen Code (vision.md §1d).
   */
  isSymbolIndexed?: (symbolId: string) => boolean;
}

/**
 * Schwellen der Diagnose. Sie sind Politik, keine Naturkonstanten — deshalb
 * stehen sie hier benannt und werden in jedem Beleg (`threshold`) mitgeliefert,
 * damit ein Leser die Aussage nachrechnen kann.
 */
export const FINDABILITY_THRESHOLDS = {
  /** Ab diesem Rang gilt der eigene Treffer als „rankt niedrig". */
  weakRank: 3,
  /** Ab dieser Streuung gilt die Verantwortlichkeit als zerfasert. */
  scatteredDispersion: 0.6,
  /** Ab dieser Sprungzahl gilt der Weg als zu verflochten. */
  entangledHops: 2,
} as const;

/** Benannte Formel hinter `FindabilityDispersionV1.dispersion`. */
export const DISPERSION_FORMULA =
  "(matchedFileCount - 1) / max(1, matchedHitCount - 1), clamped to [0, 1]";

/** Benannte Formel hinter `FindabilityV1.score`. */
export const FINDABILITY_SCORE_FORMULA =
  "0.5*rankScore(nameProbe) + 0.2*rankScore(signatureProbe) + 0.2*(1 - dispersion) + 0.1*hopScore, with rankScore(r) = 0 for no rank else 1/r, hopScore = 0.5 when hops are unknown else 1/(1+hops)";

/** Rangwert einer Sonde: Rang 1 → 1.0, Rang 2 → 0.5, kein Rang → 0. */
export function rankScore(rank: number | null): number {
  return rank === null ? 0 : 1 / rank;
}

function heuristicConfidence(value: number, signals: string[]): HeuristicConfidenceV1 {
  return { value, basis: "heuristic", signals };
}

interface ProbeOutcome {
  probe: FindabilityProbeV1;
  /** Dateien der Treffer, fuer die Streuung. */
  filePaths: string[];
  hitCount: number;
  ownFileHitCount: number;
}

function evaluateProbe(
  kind: FindabilityProbeKind,
  queryText: string,
  subject: FindabilitySubject,
  set: SearchResultSetV1,
): ProbeOutcome {
  // Alle Gruppen zusammen: eine Sonde fragt nach EINEM Symbol, und in welcher
  // Profilgruppe es auftaucht, ist fuer die Auffindbarkeit unerheblich. Die
  // Raenge bleiben gruppenintern korrekt, weil die Sonde den Rang des eigenen
  // Treffers innerhalb SEINER Gruppe liest.
  const hits = set.groups.flatMap((group) => group.hits);
  const own = hits.find((hit) => hit.symbolId === subject.symbolId);
  const topScore = hits[0]?.score.final;
  const probe: FindabilityProbeV1 = {
    kind,
    queryText,
    queryFingerprint: set.queryFingerprint,
    rank: own === undefined ? null : own.rank,
    ...(own === undefined ? { rankMissingReason: rankMissingReasonFor(set, hits.length) } : {}),
    hitCount: hits.length,
    ...(topScore === undefined ? {} : { topScore }),
    ...(own === undefined ? {} : { selfScore: own.score.final }),
  };
  return {
    probe,
    filePaths: hits.map((hit) => hit.filePath),
    hitCount: hits.length,
    ownFileHitCount: hits.filter((hit) => hit.filePath === subject.filePath).length,
  };
}

/**
 * Warum eine Sonde keinen Rang ergab — aus der ENTSCHEIDUNG, nie aus der
 * Listenlaenge.
 *
 * Vorher stand hier `hits.length === 0 ? "no_match" : "outside_result_limit"`.
 * Beide sind Behauptungen ueber den CODE. Eine Enthaltung ist aber eine
 * Aussage ueber die KALIBRIERUNG: der Abruf lief, es gab Kandidaten, und die
 * Policy hielt die Evidenz fuer unzureichend. Als `no_match` veroeffentlicht
 * wurde daraus „dazu gibt es nichts" — und ein Symbol, das fuer seinen eigenen
 * Namen auf Rang 1 stuende, galt als unauffindbar.
 */
function rankMissingReasonFor(
  set: SearchResultSetV1,
  hitCount: number,
): FindabilityRankMissingReason {
  if (set.groups.some((group) => group.relevanceDecision?.status === "rejected")) {
    return "relevance_policy_rejected";
  }
  // Kein Kandidat hat den Abruf ueberhaupt erreicht: dann ist „nichts
  // gefunden" eine belegte Aussage und keine Vermutung.
  if (
    set.groups.length > 0 &&
    set.groups.every((group) => group.retrieval?.deduplicatedCandidateCount === 0)
  ) {
    return "no_match";
  }
  return hitCount === 0 ? "no_match" : "outside_result_limit";
}

/** Streuung ueber Dateien (siehe {@link DISPERSION_FORMULA}). */
export function computeDispersion(
  filePaths: readonly string[],
  ownFileHitCount: number,
): FindabilityDispersionV1 {
  const matchedHitCount = filePaths.length;
  const matchedFileCount = new Set(filePaths).size;
  const raw = (matchedFileCount - 1) / Math.max(1, matchedHitCount - 1);
  const dispersion = Math.min(1, Math.max(0, raw));
  return { matchedFileCount, matchedHitCount, ownFileHitCount, dispersion };
}

function evidence(
  kind: FindabilityEvidenceV1["kind"],
  observedValue: number,
  threshold: number,
  references: string[],
  note?: string,
): FindabilityEvidenceV1 {
  return {
    kind,
    observedValue,
    threshold,
    references,
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * Leitet die benannten Ursachen aus den Messwerten ab (vision.md §1d Tabelle).
 *
 * Nimmt bewusst KEINE losen Sonden entgegen, sondern nur einen
 * {@link FindabilityDiagnosisBasisV1} — den Nachweis aus `packages/domain`,
 * dass der Abruf tatsaechlich gelaufen ist. Ein Zustandsvermerk
 * (`FindabilityUnavailableV1`) ist auf diesen Typ nicht zuweisbar, eine
 * ausgefallene Sonde bekommt gar keinen Nachweis. Damit ist es im TYP
 * unmoeglich, aus einem Werkzeugversagen eine Aussage ueber den Code zu
 * machen — genau der Denkfehler, den vision.md §1d frueher offen liess.
 */
export function diagnose(
  subject: FindabilitySubject,
  basis: FindabilityDiagnosisBasisV1,
): FindabilityDiagnosisV1[] {
  const { nameProbe, dispersion, hops } = basis;
  const diagnoses: FindabilityDiagnosisV1[] = [];

  // Die Fallunterscheidung folgt der Tabelle aus vision.md §1d:
  //   „Gar kein passender Treffer"  -> das Symbol taucht in seinen eigenen
  //     Suchergebnissen NICHT auf   -> `undocumented`;
  //   „Der richtige Treffer rankt niedrig" -> es taucht auf, aber weit unten
  //                                 -> `weak-naming`.
  // Wichtig: „kein Rang" heisst NICHT „keine Treffer". Der dichte Zweig
  // liefert fast immer irgendetwas; entscheidend ist, ob das GESUCHTE Symbol
  // darunter ist.
  if (nameProbe.rank === null) {
    diagnoses.push({
      cause: "undocumented",
      confidence: heuristicConfidence(nameProbe.hitCount === 0 ? 0.6 : 0.5, [
        "self_not_in_own_name_results",
        ...(nameProbe.hitCount === 0 ? ["no_results_at_all"] : ["other_results_ranked_instead"]),
      ]),
      evidence: [
        evidence(
          "hit_count",
          nameProbe.hitCount,
          1,
          [subject.symbolFqn],
          "searching for the symbol's own name did not return the symbol itself",
        ),
      ],
      isHeuristic: true,
      note: "the symbol's own name does not retrieve it; either the name carries no intent or nothing describes it",
    });
  } else if (nameProbe.rank > FINDABILITY_THRESHOLDS.weakRank) {
    diagnoses.push({
      cause: "weak-naming",
      confidence: heuristicConfidence(0.5, ["self_rank_below_threshold"]),
      evidence: [
        evidence(
          "self_rank",
          nameProbe.rank,
          FINDABILITY_THRESHOLDS.weakRank,
          [subject.symbolFqn],
          "the symbol does not rank near the top for its own name",
        ),
      ],
      isHeuristic: true,
    });
  }

  if (dispersion.dispersion > FINDABILITY_THRESHOLDS.scatteredDispersion) {
    diagnoses.push({
      cause: "scattered-responsibility",
      confidence: heuristicConfidence(0.5, ["high_file_dispersion"]),
      evidence: [
        evidence(
          "matched_file_count",
          dispersion.matchedFileCount,
          FINDABILITY_THRESHOLDS.scatteredDispersion,
          [subject.filePath],
          `hits spread over ${dispersion.matchedFileCount} files (dispersion ${dispersion.dispersion.toFixed(3)})`,
        ),
      ],
      isHeuristic: true,
    });
  }

  if (hops.hops !== null && hops.hops > FINDABILITY_THRESHOLDS.entangledHops) {
    diagnoses.push({
      cause: "high-entanglement",
      confidence: heuristicConfidence(hops.pathUsesUncertainEdges ? 0.4 : 0.6, [
        "hop_count_above_threshold",
        ...(hops.pathUsesUncertainEdges ? ["path_uses_uncertain_edges"] : []),
      ]),
      evidence: [evidence("hop_count", hops.hops, FINDABILITY_THRESHOLDS.entangledHops, hops.path)],
      isHeuristic: true,
    });
  }

  return diagnoses;
}

// ---------------------------------------------------------------------------
// Lief die Suche ueberhaupt? (vision.md §1d)
// ---------------------------------------------------------------------------

/**
 * Warncodes, mit denen der Abrufkern ein AUSGEFALLENES Suchziel meldet.
 *
 * Diese Liste ist noetig, weil `UntangleSearchEngine` ein ausgefallenes Ziel
 * NICHT wirft, sondern nach spec.md §25.2 sichtbar degradiert: das Ergebnis
 * kommt mit einer Gruppe weniger — im schlimmsten Fall ganz ohne Gruppe — und
 * einer Warnung zurueck. Wer nur auf `hits.length` schaut, liest dann „kein
 * Treffer", und genau daraus entstuende die falsche Aussage ueber den Code.
 */
export const FINDABILITY_RETRIEVAL_FAILURE_WARNING_CODES = [
  "EMBEDDING_DIMENSION_MISMATCH",
  "EMBEDDING_UNAVAILABLE",
  "INDEX_INCOMPLETE",
  "INDEX_PROFILE_MISMATCH",
  "PROFILE_UNAVAILABLE",
  "QDRANT_SCHEMA_INCOMPATIBLE",
  "QDRANT_UNAVAILABLE",
  "SEARCH_BRANCH_UNAVAILABLE",
] as const;

/** Grund plus Begruendung fuer einen Zustandsvermerk. */
export interface FindabilityRetrievalFailureV1 {
  reason: FindabilityRetrievalUnavailableReason;
  detail: string;
}

function reasonForCode(code: string): FindabilityRetrievalUnavailableReason {
  if (code === "INDEX_PROFILE_MISMATCH") return "search_profile_missing";
  if (code === "INDEX_INCOMPLETE") return "symbol_not_indexed";
  return "search_unavailable";
}

/**
 * Prueft ein Suchergebnis darauf, ob die Suche wirklich gelaufen ist.
 *
 * `undefined` heisst: sie lief. Alles andere ist ein Zustandsvermerk, kein
 * Messwert. Eine Ergebnismenge ohne jede Profilgruppe zaehlt dabei als
 * Ausfall — ohne Profil hat niemand gesucht, und „nichts gefunden" waere eine
 * Behauptung ueber den Code, die auf keiner Beobachtung steht.
 *
 * DASSELBE GILT FUER EINE GRUPPE, DIE NICHT DURCHSUCHT WURDE (Befund B1 der
 * Nachpruefung, Fall B). Liegt der Geltungsbereich der Sonde — Workspace,
 * Repository, Ref des Symbols — vollstaendig ausserhalb der verdrahteten
 * Ziele, liefert der Abrufkern trotzdem eine Gruppe: leer, mit
 * `notSearchedReason` und einem Eintrag im Skip-Ledger. Wer nur `groups.length`
 * zaehlt, sieht eine Gruppe und haelt die Sonde fuer gelaufen — und veroeffent-
 * licht danach „no_match" und die Diagnose „undocumented" ueber ein Symbol,
 * nach dem nie gesucht wurde. Deshalb zaehlen hier nur Gruppen, die
 * TATSAECHLICH durchsucht wurden.
 */
export function detectRetrievalFailure(
  set: SearchResultSetV1,
): FindabilityRetrievalFailureV1 | undefined {
  const codes = new Set<string>(FINDABILITY_RETRIEVAL_FAILURE_WARNING_CODES);
  const failed = set.warnings.find((warning) => codes.has(warning.code));
  if (failed !== undefined) {
    return { reason: reasonForCode(failed.code), detail: `${failed.code}: ${failed.message}` };
  }
  if (set.groups.length === 0) {
    return {
      reason: "search_profile_missing",
      detail:
        "the probe came back without a single profile group; no embedding profile answered, so nothing was actually searched",
    };
  }
  const searched = set.groups.filter((group) => group.notSearchedReason === undefined);
  if (searched.length === 0) {
    const reasons = sortByCodepoints(
      set.groups.map((group) => group.notSearchedReason as string),
    ).join("; ");
    return {
      reason: "probe_not_executed",
      detail: `not one of the ${set.groups.length} profile group(s) was actually searched, so the probe observed nothing: ${reasons}`,
    };
  }
  return undefined;
}

function failureForError(error: unknown): FindabilityRetrievalFailureV1 {
  const message = error instanceof Error ? error.message : String(error);
  const code = isUntangleError(error) ? error.code : "SEARCH_FAILED";
  return { reason: reasonForCode(code), detail: `${code}: ${message}` };
}

/**
 * Uebersetzt einen Zustandsvermerk in einen Skip-Ledger-Eintrag (E4). Ein
 * ausgefallener Abruf darf nicht nur im Datensatz stehen, sondern gehoert in
 * dieselbe Liste wie jede andere Auslassung.
 */
export function findabilitySkipEntry(note: FindabilityUnavailableV1): SkipLedgerEntryV1 {
  return buildSkipLedgerEntry({
    stage: "findability",
    subjectKind: "symbol",
    subjectId: note.symbolId,
    path: note.filePath,
    repoId: note.repoId,
    refId: note.refId,
    reason: note.reason === "symbol_not_indexed" ? "missing_index_entry" : "provider_unavailable",
    detail: `findability not measured for "${note.symbolFqn}" (${note.reason}): ${note.detail}`,
    recoverable: true,
  });
}

/**
 * Misst die Auffindbarkeit eines Symbols mit zwei Selbstsonden.
 *
 * Der Aufrufer stellt den Port; diese Funktion macht nichts anderes, als ihn
 * zweimal zu fragen und das Ergebnis ehrlich zu verbuchen — insbesondere den
 * Fall „nicht gefunden", der als Rang `null` MIT benanntem Grund im Datensatz
 * steht und nicht als fehlender Wert verschwindet (E4).
 *
 * ZWEI ERGEBNISSE, NICHT EINS (vision.md §1d): lief die Suche, kommt eine
 * `FindabilityV1`-MESSUNG zurueck. Lief sie nicht — Speicher nicht
 * erreichbar, Profil fehlt, Symbol nicht indexiert —, kommt ein
 * `FindabilityUnavailableV1`-ZUSTANDSVERMERK zurueck. Der traegt keinen Score
 * und keine Diagnose, weil ein Werkzeugversagen kein Befund ueber den Code
 * ist. Aufrufer MUESSEN die beiden Faelle unterscheiden; der Typ zwingt sie
 * dazu.
 */
export async function measureFindability(
  port: SearchPort,
  subject: FindabilitySubject,
  clock: Clock,
  options: FindabilityOptions,
  callOptions?: PortCallOptions,
): Promise<FindabilityOutcomeV1> {
  const limit = options.probeLimit ?? 10;
  const baseRequest = {
    workspaceId: subject.workspaceId,
    repositories: [subject.repoId],
    refs: [subject.refId],
    limit,
    // Ausdruecklich gepinnt: eine veroeffentlichte Kennzahl darf nicht von
    // einer ungepinnten Vorgabe abhaengen. Zoege der Default eines Tages nach
    // `evidence`, bekaemen abgelehnte Sonden still einen Rang.
    abstention: "strict" as const,
  };

  const note = (
    failure: FindabilityRetrievalFailureV1,
    probeKinds: readonly FindabilityProbeKind[],
  ): FindabilityUnavailableV1 =>
    makeFindabilityUnavailable({
      workspaceId: subject.workspaceId,
      repoId: subject.repoId,
      refId: subject.refId,
      symbolId: subject.symbolId,
      symbolFqn: subject.symbolFqn,
      filePath: subject.filePath,
      reason: failure.reason,
      detail: failure.detail,
      probeKinds,
      observedAt: clock.nowIso(),
      generationId: options.generationId,
    });

  const bothProbes: readonly FindabilityProbeKind[] = ["self-name", "self-signature"];

  if (options.isSymbolIndexed !== undefined && !options.isSymbolIndexed(subject.symbolId)) {
    return note(
      {
        reason: "symbol_not_indexed",
        detail: `symbol "${subject.symbolFqn}" is not in the index, so no probe could reach it`,
      },
      bothProbes,
    );
  }

  let nameSet: SearchResultSetV1;
  try {
    nameSet = await port.search({ ...baseRequest, query: subject.symbolName }, callOptions);
  } catch (error) {
    return note(failureForError(error), bothProbes);
  }
  const nameFailure = detectRetrievalFailure(nameSet);
  if (nameFailure !== undefined) return note(nameFailure, bothProbes);
  const nameOutcome = evaluateProbe("self-name", subject.symbolName, subject, nameSet);

  const signatureText = subject.signature ?? subject.symbolFqn;
  let signatureSet: SearchResultSetV1;
  try {
    signatureSet = await port.search({ ...baseRequest, query: signatureText }, callOptions);
  } catch (error) {
    return note(failureForError(error), ["self-signature"]);
  }
  const signatureFailure = detectRetrievalFailure(signatureSet);
  if (signatureFailure !== undefined) return note(signatureFailure, ["self-signature"]);
  const signatureOutcome = evaluateProbe("self-signature", signatureText, subject, signatureSet);

  const dispersion = computeDispersion(
    [...nameOutcome.filePaths, ...signatureOutcome.filePaths],
    nameOutcome.ownFileHitCount + signatureOutcome.ownFileHitCount,
  );

  const topHit = nameSet.groups.flatMap((group) => group.hits)[0];
  const hops: FindabilityHopsV1 =
    options.hops === undefined || topHit?.symbolId === undefined
      ? {
          hops: null,
          hopsMissingReason:
            options.hops === undefined
              ? "no_symbol_graph_lookup_wired"
              : "top_hit_carries_no_symbol_id",
          path: [],
          pathUsesUncertainEdges: false,
        }
      : (options.hops({ fromSymbolId: topHit.symbolId, toSymbolId: subject.symbolId }) ?? {
          hops: null,
          hopsMissingReason: "no_path_in_symbol_graph",
          path: [],
          pathUsesUncertainEdges: false,
        });

  const hopScore = hops.hops === null ? 0.5 : 1 / (1 + hops.hops);
  const score =
    0.5 * rankScore(nameOutcome.probe.rank) +
    0.2 * rankScore(signatureOutcome.probe.rank) +
    0.2 * (1 - dispersion.dispersion) +
    0.1 * hopScore;

  const signals = [
    "self_name_probe",
    "self_signature_probe",
    "file_dispersion",
    hops.hops === null ? "hops_unknown" : "hop_count",
  ];

  // Letzte Instanz vor der Diagnose: der Nachweis aus `packages/domain`. Er
  // bleibt aus, sobald eine Sonde ein Werkzeugversagen meldet — dann gibt es
  // schlicht nichts, woraus sich eine Diagnose bilden LIESSE.
  const basis = openFindabilityDiagnosisBasis({
    nameProbe: nameOutcome.probe,
    signatureProbe: signatureOutcome.probe,
    dispersion,
    hops,
  });

  return {
    schemaVersion: 1,
    findabilityId: buildFindabilityId({
      workspaceId: subject.workspaceId,
      symbolId: subject.symbolId,
      algorithm: FINDABILITY_ALGORITHM_ID,
      rankerVersion: RANKER_VERSION,
    }),
    workspaceId: subject.workspaceId,
    repoId: subject.repoId,
    refId: subject.refId,
    symbolId: subject.symbolId,
    symbolFqn: subject.symbolFqn,
    filePath: subject.filePath,
    algorithm: FINDABILITY_ALGORITHM_ID,
    rankerVersion: RANKER_VERSION,
    score: Math.min(1, Math.max(0, score)),
    isHeuristic: true,
    nameProbe: nameOutcome.probe,
    signatureProbe: signatureOutcome.probe,
    dispersion,
    dispersionFormula: DISPERSION_FORMULA,
    hops,
    // Die Gesamt-Confidence sinkt, wenn ein Bestandteil fehlt: eine Messung
    // ohne Sprungzahl ist weniger belastbar als eine mit.
    confidence: heuristicConfidence(hops.hops === null ? 0.5 : 0.7, signals),
    diagnoses: basis === undefined ? [] : diagnose(subject, basis),
    measuredAt: clock.nowIso(),
    generationId: options.generationId,
  };
}
