/**
 * Findability je Symbol (vision.md §1d; docs/BUILD_PLAN.md WP-120/WP-121).
 *
 * Kernsatz aus vision.md §1d:
 *
 * > Wenn die Suche nach „Funktion X" nicht schnell an der richtigen Stelle
 * > landet, ist das ein Befund ueber den Code — nicht nur ueber die Suche.
 *
 * Findability ist damit eine kontinuierlich gemessene Eigenschaft JE SYMBOL
 * und gehoert in dieselbe Hotspot-Liste wie kognitive Komplexitaet.
 *
 * ALLES HIER IST HEURISTIK — und zwar strukturell, nicht per Kommentar:
 * `isHeuristic` ist auf das Literal `true` typisiert und laesst sich nicht auf
 * `false` setzen; die Confidence ist auf `basis: "heuristic"` festgelegt. Ein
 * Findability-Wert kann deshalb nirgends die Stelle eines gemessenen
 * Complexity-Werts einnehmen.
 */
import { FINDABILITY_ALGORITHM_ID, RANKER_VERSION } from "../versions.js";

import type { GraphConfidenceV1 } from "./symbol-graph.js";

/**
 * Confidence einer Heuristik: gleiche Form wie {@link GraphConfidenceV1}, aber
 * `basis` ist auf `"heuristic"` festgenagelt. Eine Findability-Aussage kann
 * sich damit nie als deterministische Messung ausgeben.
 */
export interface HeuristicConfidenceV1 extends GraphConfidenceV1 {
  basis: "heuristic";
}

/**
 * Geschlossene Menge der Ursachen schlechter Auffindbarkeit (vision.md §1d).
 * Geschlossen, damit eine Diagnose vergleichbar und zaehlbar ist:
 *
 * | Symptom | Ursache |
 * |---|---|
 * | Treffer streuen ueber viele Dateien | `scattered-responsibility` |
 * | Der richtige Treffer rankt niedrig | `weak-naming` |
 * | Erst nach mehreren Spruengen am Ziel | `high-entanglement` |
 * | Gar kein passender Treffer | `undocumented` |
 */
export const FINDABILITY_CAUSES = [
  "scattered-responsibility",
  "weak-naming",
  "high-entanglement",
  "undocumented",
] as const;

export type FindabilityCause = (typeof FINDABILITY_CAUSES)[number];

/** Womit gesucht wurde: mit dem eigenen Namen oder der eigenen Signatur. */
export const FINDABILITY_PROBE_KINDS = ["self-name", "self-signature"] as const;

export type FindabilityProbeKind = (typeof FINDABILITY_PROBE_KINDS)[number];

/** Benannte Gruende, warum eine Sonde keinen Rang ergab (E4). */
export const FINDABILITY_RANK_MISSING_REASONS = [
  "no_match",
  "below_min_score",
  "outside_result_limit",
  "symbol_not_indexed",
  "search_unavailable",
  /**
   * Der Abruf lief und lieferte Kandidaten, aber die kalibrierte
   * Relevanzpolicy hielt die Evidenz fuer unzureichend.
   *
   * Ohne diesen Grund wurde die Enthaltung als `no_match` veroeffentlicht —
   * also als Behauptung ueber den CODE („dazu gibt es nichts"), obwohl sie
   * eine Aussage ueber die KALIBRIERUNG war. Ein Symbol, das fuer seinen
   * eigenen Namen auf Rang 1 stuende, wurde so als unauffindbar gefuehrt.
   */
  "relevance_policy_rejected",
] as const;

export type FindabilityRankMissingReason = (typeof FINDABILITY_RANK_MISSING_REASONS)[number];

/**
 * Eine Suchsonde: das Symbol sucht sich selbst. `rank` ist der 1-basierte Rang
 * des EIGENEN Chunks im Ergebnis; `null` heisst „nicht gefunden" und verlangt
 * dann zwingend `rankMissingReason` — „kein Treffer" ist selbst ein Befund und
 * darf nicht als fehlender Wert verschwinden.
 */
export interface FindabilityProbeV1 {
  kind: FindabilityProbeKind;
  /** Der tatsaechlich gestellte Suchtext (Name bzw. Signatur). */
  queryText: string;
  /** Fingerabdruck der normalisierten Anfrage (`buildSearchQueryFingerprint`). */
  queryFingerprint: string;
  /** 1-basierter Rang des eigenen Treffers, oder null. */
  rank: number | null;
  rankMissingReason?: FindabilityRankMissingReason;
  /** Zahl der Treffer, die die Sonde insgesamt geliefert hat. */
  hitCount: number;
  /** Endscore des besten Treffers, sofern es einen gab. */
  topScore?: number;
  /** Endscore des eigenen Treffers, sofern er vorkam. */
  selfScore?: number;
}

/**
 * Streuung der Treffer ueber Dateien. Hohe Streuung ist das Symptom
 * zerfaserter Verantwortlichkeit (vision.md §1d).
 */
export interface FindabilityDispersionV1 {
  /** Zahl verschiedener Dateien in den Treffern der Sonden. */
  matchedFileCount: number;
  /** Zahl der Treffer insgesamt. */
  matchedHitCount: number;
  /** Treffer, die in der Datei des Symbols selbst liegen. */
  ownFileHitCount: number;
  /**
   * Normalisierte Streuung in [0, 1]: 0 = alle Treffer in einer Datei,
   * 1 = jeder Treffer in einer anderen Datei. Die verwendete Formel steht in
   * `FindabilityV1.dispersionFormula`.
   */
  dispersion: number;
}

/**
 * Zahl der Spruenge vom besten Treffer bis zum eigentlichen Ziel, gemessen im
 * Symbolgraphen. Viele Spruenge sind das Symptom hoher Verflechtung.
 */
export interface FindabilityHopsV1 {
  /** Spruenge vom Rang-1-Treffer zum Zielsymbol; 0 = direkt getroffen. */
  hops: number | null;
  /** Pflicht, wenn `hops` null ist (E4), z. B. "no_path_in_symbol_graph". */
  hopsMissingReason?: string;
  /** Der gefundene Pfad als Symbol-IDs, beginnend beim Rang-1-Treffer. */
  path: string[];
  /**
   * True, wenn der Pfad nur ueber Kanten mit Aufloesungsart `heuristic` oder
   * `ambiguous` fuehrt — die Sprungzahl ist dann selbst unsicher.
   */
  pathUsesUncertainEdges: boolean;
}

/** Belegart einer Diagnose. */
export const FINDABILITY_EVIDENCE_KINDS = [
  "matched_file_count",
  "self_rank",
  "hop_count",
  "hit_count",
  "name_token_overlap",
  "documentation_coverage",
] as const;

export type FindabilityEvidenceKind = (typeof FINDABILITY_EVIDENCE_KINDS)[number];

/** Ein einzelner Beleg fuer eine Diagnose. Ohne Beleg keine Diagnose. */
export interface FindabilityEvidenceV1 {
  kind: FindabilityEvidenceKind;
  /** Beobachteter Wert. */
  observedValue: number;
  /** Schwelle, gegen die verglichen wurde, sofern es eine gibt. */
  threshold?: number;
  /** IDs oder Pfade, die den Beleg nachvollziehbar machen. */
  references: string[];
  note?: string;
}

/**
 * Benannte Ursache mit Beleg und Confidence (WP-121). Eine Diagnose OHNE
 * Confidence ist unzulaessig; `isHeuristic` ist strukturell `true`.
 */
export interface FindabilityDiagnosisV1 {
  cause: FindabilityCause;
  confidence: HeuristicConfidenceV1;
  /** Mindestens ein Beleg; leer ist ein Vertragsbruch. */
  evidence: FindabilityEvidenceV1[];
  /** Immer `true` — Findability ist eine Heuristik, kein Messwert. */
  isHeuristic: true;
  note?: string;
}

/**
 * Findability eines Symbols.
 *
 * `score` ist ein heuristischer Gesamtwert in [0, 1] (1 = leicht auffindbar).
 * Er ersetzt die Bestandteile nicht: `nameProbe`, `signatureProbe`,
 * `dispersion` und `hops` bleiben einzeln sichtbar, weil erst sie die
 * Diagnose belegen.
 */
export interface FindabilityV1 {
  schemaVersion: 1;
  /** Deterministische ID (`buildFindabilityId`). */
  findabilityId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  symbolId: string;
  symbolFqn: string;
  /** "/"-normalisierter, repo-relativer Pfad des Symbols. */
  filePath: string;
  algorithm: typeof FINDABILITY_ALGORITHM_ID;
  /** Rangfolge-Version, unter der die Sonden liefen (spec.md §13.3). */
  rankerVersion: typeof RANKER_VERSION;
  /** Heuristischer Gesamtwert in [0, 1]; 1 = leicht auffindbar. */
  score: number;
  /** Immer `true`. */
  isHeuristic: true;
  nameProbe: FindabilityProbeV1;
  signatureProbe: FindabilityProbeV1;
  dispersion: FindabilityDispersionV1;
  /** Benannte Formel hinter `dispersion.dispersion`. */
  dispersionFormula: string;
  hops: FindabilityHopsV1;
  confidence: HeuristicConfidenceV1;
  /** Benannte Ursachen; leer, wenn der Wert unauffaellig ist. */
  diagnoses: FindabilityDiagnosisV1[];
  /** ISO-8601, ueber den Clock-Port bezogen. */
  measuredAt: string;
  generationId: string;
}

/**
 * Schlanke Findability-Angabe fuer Trefferlisten und die Hotspot-Tabelle
 * (WP-120). Traegt bewusst den `isHeuristic`-Marker mit, damit auch die
 * Kurzform nicht als Messwert gelesen werden kann.
 */
export interface FindabilitySummaryV1 {
  score: number;
  isHeuristic: true;
  algorithm: typeof FINDABILITY_ALGORITHM_ID;
  /** Ursache mit der hoechsten Confidence, sofern es eine Diagnose gibt. */
  primaryCause?: FindabilityCause;
  /** Confidence der genannten Ursache. */
  primaryCauseConfidence?: number;
}

/** Befund der Findability-Pruefung. */
export interface FindabilityIssue {
  kind:
    | "score_out_of_range"
    | "rank_without_reason"
    | "reason_without_rank"
    | "invalid_rank"
    | "dispersion_out_of_range"
    | "negative_hops"
    | "hops_without_reason"
    | "diagnosis_without_evidence"
    | "confidence_out_of_range"
    | "diagnosis_without_retrieval";
  message: string;
}

function checkProbe(probe: FindabilityProbeV1, issues: FindabilityIssue[]): void {
  if (probe.rank === null && probe.rankMissingReason === undefined) {
    issues.push({
      kind: "rank_without_reason",
      message: `probe "${probe.kind}" has no rank and no rankMissingReason (E4)`,
    });
  }
  if (probe.rank !== null && probe.rankMissingReason !== undefined) {
    issues.push({
      kind: "reason_without_rank",
      message: `probe "${probe.kind}" carries both a rank and a rankMissingReason`,
    });
  }
  if (probe.rank !== null && (!Number.isInteger(probe.rank) || probe.rank < 1)) {
    issues.push({
      kind: "invalid_rank",
      message: `probe "${probe.kind}" rank must be a 1-based integer, got ${String(probe.rank)}`,
    });
  }
}

/**
 * Prueft die Invarianten eines Findability-Datensatzes: Wertebereiche, die
 * Kopplung „kein Rang ⇒ benannter Grund" (E4) und die Regel „keine Diagnose
 * ohne Beleg und ohne Confidence" (WP-121).
 */
export function validateFindability(record: FindabilityV1): FindabilityIssue[] {
  const issues: FindabilityIssue[] = [];
  if (!(record.score >= 0 && record.score <= 1)) {
    issues.push({
      kind: "score_out_of_range",
      message: `findability score must be within [0, 1], got ${String(record.score)}`,
    });
  }
  checkProbe(record.nameProbe, issues);
  checkProbe(record.signatureProbe, issues);

  const { dispersion } = record.dispersion;
  if (!(dispersion >= 0 && dispersion <= 1)) {
    issues.push({
      kind: "dispersion_out_of_range",
      message: `dispersion must be within [0, 1], got ${String(dispersion)}`,
    });
  }
  if (record.hops.hops !== null && record.hops.hops < 0) {
    issues.push({
      kind: "negative_hops",
      message: `hops must not be negative, got ${String(record.hops.hops)}`,
    });
  }
  if (record.hops.hops === null && (record.hops.hopsMissingReason ?? "") === "") {
    issues.push({
      kind: "hops_without_reason",
      message: "missing hop count without hopsMissingReason (E4)",
    });
  }
  if (!(record.confidence.value >= 0 && record.confidence.value <= 1)) {
    issues.push({
      kind: "confidence_out_of_range",
      message: `confidence must be within [0, 1], got ${String(record.confidence.value)}`,
    });
  }
  // vision.md §1d gilt nur bei nachweislich funktionierendem Abruf: berichtet
  // eine Sonde von einem Werkzeugversagen, ist jede Diagnose eine Aussage
  // ueber UNS und nicht ueber den Code.
  for (const probe of [record.nameProbe, record.signatureProbe]) {
    if (!probeRetrievalPerformed(probe) && record.diagnoses.length > 0) {
      issues.push({
        kind: "diagnosis_without_retrieval",
        message: `probe "${probe.kind}" reports a tool failure (${probe.rankMissingReason ?? "unknown"}), so the record must not carry diagnoses (vision.md §1d)`,
      });
    }
  }
  for (const diagnosis of record.diagnoses) {
    if (diagnosis.evidence.length === 0) {
      issues.push({
        kind: "diagnosis_without_evidence",
        message: `diagnosis "${diagnosis.cause}" has no evidence (WP-121)`,
      });
    }
    if (!(diagnosis.confidence.value >= 0 && diagnosis.confidence.value <= 1)) {
      issues.push({
        kind: "confidence_out_of_range",
        message: `diagnosis "${diagnosis.cause}" confidence must be within [0, 1], got ${String(diagnosis.confidence.value)}`,
      });
    }
  }
  return issues;
}

/**
 * Leitet die Kurzform aus dem vollen Datensatz ab. Waehlt als `primaryCause`
 * die Diagnose mit der hoechsten Confidence; bei Gleichstand entscheidet die
 * Codepoint-Ordnung der Ursache (deterministisch, nie zufaellig).
 *
 * Nennt keine Ursache, wenn eine Sonde von einem Werkzeugversagen berichtet
 * (vision.md §1d).
 */
export function toFindabilitySummary(record: FindabilityV1): FindabilitySummaryV1 {
  // Zweiter Riegel gegen den Entwurfsfehler aus vision.md §1d: berichtet eine
  // Sonde von einem Werkzeugversagen, wird KEINE Ursache genannt — auch dann
  // nicht, wenn der Datensatz entgegen `validateFindability` welche traegt.
  // Verschwiegen wird nichts: der Datensatz behaelt seine `diagnoses`, und die
  // Pruefung meldet sie als `diagnosis_without_retrieval`.
  const retrievalPerformed =
    probeRetrievalPerformed(record.nameProbe) && probeRetrievalPerformed(record.signatureProbe);
  let primary: FindabilityDiagnosisV1 | undefined;
  for (const diagnosis of retrievalPerformed ? record.diagnoses : []) {
    if (primary === undefined) {
      primary = diagnosis;
      continue;
    }
    if (diagnosis.confidence.value > primary.confidence.value) {
      primary = diagnosis;
      continue;
    }
    if (
      diagnosis.confidence.value === primary.confidence.value &&
      diagnosis.cause < primary.cause
    ) {
      primary = diagnosis;
    }
  }
  return {
    score: record.score,
    isHeuristic: true,
    algorithm: record.algorithm,
    ...(primary === undefined
      ? {}
      : { primaryCause: primary.cause, primaryCauseConfidence: primary.confidence.value }),
  };
}

// ---------------------------------------------------------------------------
// MESSUNG vs. ZUSTANDSVERMERK (vision.md §1d, strukturell)
// ---------------------------------------------------------------------------

/**
 * Der Entwurfsfehler, den dieser Abschnitt behebt:
 *
 * vision.md §1d liest schlechte Auffindbarkeit als Befund UEBER DEN CODE. Das
 * gilt aber nur, wenn der Abruf ueberhaupt gelaufen ist. Faellt die Suche
 * selbst aus — Speicher nicht erreichbar, Symbol nicht indexiert, Profil
 * fehlt —, dann verurteilt dieselbe Logik den Code fuer ein Versagen des
 * WERKZEUGS. Eine ausgefallene Suche ist eine Aussage ueber UNS, nie ueber den
 * gelesenen Code.
 *
 * Deshalb sind Messung und Zustandsvermerk hier ZWEI TYPEN, nicht ein Typ mit
 * einem Flag — dieselbe Bauart, mit der `ExternalNumberV1` in
 * `types/extensions.ts` die Regel X3 strukturell erzwingt:
 *
 * - {@link FindabilityV1} ist die MESSUNG: der Abruf lief, es gibt Raenge,
 *   Streuung, Sprungzahl, Score und ggf. Diagnosen.
 * - {@link FindabilityUnavailableV1} ist der ZUSTANDSVERMERK: der Abruf lief
 *   NICHT. Der Typ traegt keinen Rang, keinen Score, keine `diagnoses` — aus
 *   ihm laesst sich keine {@link FindabilityDiagnosisV1} bilden, weil die
 *   Felder dafuer schlicht nicht existieren. Er ist auch nicht auf
 *   {@link FindabilityV1} zuweisbar.
 * - Der Weg in die Diagnose fuehrt ausschliesslich ueber
 *   {@link FindabilityDiagnosisBasisV1}, und den erzeugt nur
 *   {@link openFindabilityDiagnosisBasis} — und nur aus Sonden, deren Abruf
 *   nachweislich lief.
 */

declare const FINDABILITY_OUTCOME_BRAND: unique symbol;
declare const FINDABILITY_DIAGNOSIS_BASIS_BRAND: unique symbol;

/**
 * Gruende aus {@link FINDABILITY_RANK_MISSING_REASONS}, die vom WERKZEUG
 * handeln und nicht vom Code. Ein fehlender Rang mit einem dieser Gruende ist
 * KEIN Befund ueber den Code und darf keine Diagnose tragen.
 */
export const FINDABILITY_RETRIEVAL_FAILURE_REASONS = [
  "search_unavailable",
  "symbol_not_indexed",
] as const satisfies readonly FindabilityRankMissingReason[];

export type FindabilityRetrievalFailureReason =
  (typeof FINDABILITY_RETRIEVAL_FAILURE_REASONS)[number];

/**
 * Gruende, die vom CODE handeln: der Abruf lief, das Symbol kam trotzdem nicht
 * (weit genug oben) vor. Nur diese Gruende taugen als Belegmaterial fuer eine
 * Diagnose.
 */
export const FINDABILITY_CODE_EVIDENCE_REASONS = [
  "no_match",
  "below_min_score",
  "outside_result_limit",
  // Der Abruf LIEF — das Werkzeug hat nicht versagt. Der Grund gehoert
  // deshalb hierher und nicht zu den Retrieval-Fehlern; sonst faellt eine
  // legitime Diagnose ersatzlos aus.
  "relevance_policy_rejected",
] as const satisfies readonly FindabilityRankMissingReason[];

export type FindabilityCodeEvidenceReason = (typeof FINDABILITY_CODE_EVIDENCE_REASONS)[number];

/**
 * Uebersetzungszeit-Waechter: die beiden Mengen MUESSEN
 * {@link FINDABILITY_RANK_MISSING_REASONS} restlos aufteilen. Kommt spaeter
 * ein Grund hinzu, ohne einer der beiden Seiten zugeordnet zu werden, wird der
 * Typ dieser Konstante `never` und die Datei uebersetzt nicht mehr. Genau das
 * ist der Zweck: niemand soll einen neuen Grund einfuehren koennen, ohne zu
 * entscheiden, ob er vom Code oder vom Werkzeug handelt.
 */
export const FINDABILITY_REASON_CLASSIFICATION_IS_TOTAL: FindabilityRankMissingReason extends
  FindabilityRetrievalFailureReason | FindabilityCodeEvidenceReason
  ? true
  : never = true;

/**
 * Geschlossene Menge der Gruende fuer einen Zustandsvermerk. Obermenge der
 * Werkzeugversagen aus {@link FINDABILITY_RETRIEVAL_FAILURE_REASONS}, weil ein
 * Vermerk auch fuer eine Sonde entstehen kann, die gar nicht erst gestartet
 * ist.
 */
export const FINDABILITY_RETRIEVAL_UNAVAILABLE_REASONS = [
  "search_unavailable",
  "symbol_not_indexed",
  "search_profile_missing",
  "probe_not_executed",
] as const;

export type FindabilityRetrievalUnavailableReason =
  (typeof FINDABILITY_RETRIEVAL_UNAVAILABLE_REASONS)[number];

/**
 * ZUSTANDSVERMERK: der Abruf lief nicht.
 *
 * Bewusst ein EIGENER Typ und kein Sonderfall von {@link FindabilityV1}: er
 * traegt weder `score` noch `nameProbe` noch `diagnoses`, ist deshalb nirgends
 * einsetzbar, wo eine Findability-MESSUNG erwartet wird, und kann keine
 * Diagnose hervorbringen. Was er traegt, ist der Grund — sichtbar, benannt,
 * nicht weggelassen (E4).
 */
export interface FindabilityUnavailableV1 {
  readonly schemaVersion: 1;
  /** Unterscheidet den Vermerk strukturell von der Messung. */
  readonly outcome: "retrieval_unavailable";
  /** Immer `false`; ein Vermerk behauptet nie, gemessen zu haben. */
  readonly retrievalPerformed: false;
  readonly workspaceId: string;
  readonly repoId: string;
  readonly refId: string;
  readonly symbolId: string;
  readonly symbolFqn: string;
  /** "/"-normalisierter, repo-relativer Pfad des Symbols. */
  readonly filePath: string;
  readonly algorithm: typeof FINDABILITY_ALGORITHM_ID;
  readonly rankerVersion: typeof RANKER_VERSION;
  readonly reason: FindabilityRetrievalUnavailableReason;
  /** Menschenlesbare Begruendung; MUSS nicht leer sein (E4). */
  readonly detail: string;
  /** Sonden, die deshalb nicht ausgewertet werden konnten. */
  readonly probeKinds: readonly FindabilityProbeKind[];
  /** ISO-8601, ueber den Clock-Port bezogen. */
  readonly observedAt: string;
  readonly generationId: string;
  /** Nur zur Uebersetzungszeit vorhanden; nie serialisiert. */
  readonly [FINDABILITY_OUTCOME_BRAND]?: "unavailable";
}

/**
 * Ergebnis eines Findability-Laufs: ENTWEDER eine Messung ODER ein
 * Zustandsvermerk. Wer das Ergebnis verwendet, muss den Fall unterscheiden —
 * das ist der Punkt.
 */
export type FindabilityOutcomeV1 = FindabilityV1 | FindabilityUnavailableV1;

/** Eingabe fuer {@link makeFindabilityUnavailable}. */
export interface FindabilityUnavailableInput {
  workspaceId: string;
  repoId: string;
  refId: string;
  symbolId: string;
  symbolFqn: string;
  filePath: string;
  reason: FindabilityRetrievalUnavailableReason;
  detail: string;
  probeKinds: readonly FindabilityProbeKind[];
  observedAt: string;
  generationId: string;
}

/**
 * Erzeugt einen Zustandsvermerk. Lehnt eine leere Begruendung ab: ein Vermerk
 * ohne Grund waere genau das stillschweigende Ueberspringen, das E4 verbietet.
 */
export function makeFindabilityUnavailable(
  input: FindabilityUnavailableInput,
): FindabilityUnavailableV1 {
  if (input.detail.trim() === "") {
    throw new Error(
      `findability retrieval status for reason "${input.reason}" must carry a non-empty detail (E4)`,
    );
  }
  return {
    schemaVersion: 1,
    outcome: "retrieval_unavailable",
    retrievalPerformed: false,
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    refId: input.refId,
    symbolId: input.symbolId,
    symbolFqn: input.symbolFqn,
    filePath: input.filePath,
    algorithm: FINDABILITY_ALGORITHM_ID,
    rankerVersion: RANKER_VERSION,
    reason: input.reason,
    detail: input.detail,
    probeKinds: [...input.probeKinds],
    observedAt: input.observedAt,
    generationId: input.generationId,
  };
}

/** Typwaechter fuer den Zustandsvermerk (auch fuer JSON aus fremder Quelle). */
export function isFindabilityUnavailable(value: unknown): value is FindabilityUnavailableV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "retrieval_unavailable" &&
    (value as { retrievalPerformed?: unknown }).retrievalPerformed === false
  );
}

/** Typwaechter fuer die Messung. */
export function isFindabilityMeasured(value: FindabilityOutcomeV1): value is FindabilityV1 {
  return !isFindabilityUnavailable(value);
}

/**
 * Waechter fuer Auswertungspfade, die eine Messung brauchen: gibt den
 * Datensatz zurueck, wenn wirklich gemessen wurde, und wirft, wenn jemand
 * einen Zustandsvermerk dort einsetzen will, wo eine Aussage ueber den Code
 * entsteht. Gegenstueck zu `assertUntangleMetricNumber` (X3).
 */
export function assertFindabilityMeasured(
  value: FindabilityOutcomeV1,
  label: string,
): FindabilityV1 {
  if (isFindabilityUnavailable(value)) {
    throw new Error(
      `"${label}" received a findability retrieval status note (${value.reason}); a search that did not run is a statement about the tool, never about the code (vision.md §1d)`,
    );
  }
  return value;
}

/** Ist `value` ein Grund, der vom Werkzeug handelt statt vom Code? */
export function isRetrievalFailureReason(
  value: string | undefined,
): value is FindabilityRetrievalFailureReason {
  return (
    value !== undefined &&
    (FINDABILITY_RETRIEVAL_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Lief der Abruf fuer diese Sonde tatsaechlich? Ein Rang zaehlt als Beweis;
 * ein fehlender Rang nur dann, wenn sein Grund vom Code handelt.
 */
export function probeRetrievalPerformed(probe: FindabilityProbeV1): boolean {
  return probe.rank !== null || !isRetrievalFailureReason(probe.rankMissingReason);
}

/**
 * Der NACHWEIS, dass eine Diagnose auf einem tatsaechlich gelaufenen Abruf
 * steht.
 *
 * Es gibt genau einen Erzeuger — {@link openFindabilityDiagnosisBasis} — und
 * er verweigert die Ausgabe, sobald eine Sonde von einem Werkzeugversagen
 * berichtet. Eine Diagnosefunktion, die diesen Typ als Eingabe verlangt, kann
 * deshalb keinen Zustandsvermerk verarbeiten: {@link FindabilityUnavailableV1}
 * ist auf ihn nicht zuweisbar.
 */
export interface FindabilityDiagnosisBasisV1 {
  /** Immer `true`; anders ist der Typ nicht bewohnbar. */
  readonly retrievalPerformed: true;
  readonly nameProbe: FindabilityProbeV1;
  readonly signatureProbe: FindabilityProbeV1;
  readonly dispersion: FindabilityDispersionV1;
  readonly hops: FindabilityHopsV1;
  /** Nur zur Uebersetzungszeit vorhanden; nie serialisiert. */
  readonly [FINDABILITY_DIAGNOSIS_BASIS_BRAND]?: "attested";
}

/** Eingabe fuer {@link openFindabilityDiagnosisBasis}. */
export interface FindabilityDiagnosisBasisInput {
  nameProbe: FindabilityProbeV1;
  signatureProbe: FindabilityProbeV1;
  dispersion: FindabilityDispersionV1;
  hops: FindabilityHopsV1;
}

/**
 * Oeffnet die Diagnose — oder verweigert sie.
 *
 * `undefined` heisst: mindestens eine Sonde hat nicht wirklich gesucht, also
 * gibt es nichts ueber den Code zu sagen. Bewusst streng: schon eine
 * ausgefallene Sonde verfaelscht Streuung und Sprungzahl, weil beide aus den
 * Treffern BEIDER Sonden gebildet werden.
 */
export function openFindabilityDiagnosisBasis(
  input: FindabilityDiagnosisBasisInput,
): FindabilityDiagnosisBasisV1 | undefined {
  if (!probeRetrievalPerformed(input.nameProbe)) return undefined;
  if (!probeRetrievalPerformed(input.signatureProbe)) return undefined;
  return {
    retrievalPerformed: true,
    nameProbe: input.nameProbe,
    signatureProbe: input.signatureProbe,
    dispersion: input.dispersion,
    hops: input.hops,
  };
}
