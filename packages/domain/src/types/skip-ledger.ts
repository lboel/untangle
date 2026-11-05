/**
 * Skip-Ledger (vision.md §8.4; docs/BUILD_PLAN.md E4, WP-49).
 *
 * E4 lautet: kein stillschweigendes Ueberspringen von Inhalten. Jede Datei,
 * jeder Bereich, jede Kante und jeder Kandidat, den eine Stufe auslaesst,
 * bekommt hier einen Eintrag MIT Grund. Ein `catch`-Block, der einen
 * Fehlschlag verschluckt, ohne ihn in ein Ledger zu schreiben, ist ein Defekt.
 *
 * Der Typ ist bewusst stufenneutral: Scanner, Parser, Chunker, Graphen, Suche
 * und Extensions schreiben in dasselbe Format, damit `status`- und
 * `query`-Ausgaben eine einzige Liste zeigen koennen.
 */
import type { SourceRange } from "./common.js";

/** Worauf sich ein Ledger-Eintrag bezieht. */
export const SKIP_SUBJECT_KINDS = [
  "file",
  "range",
  "symbol",
  "chunk",
  "file_edge",
  "symbol_edge",
  "search_candidate",
  "artifact",
  "extension",
] as const;

export type SkipSubjectKind = (typeof SKIP_SUBJECT_KINDS)[number];

/**
 * Geschlossene Menge der Ueberspringungsgruende. Geschlossen, damit die
 * Gruende zaehlbar und vergleichbar bleiben; die freie Erlaeuterung steht in
 * `detail`, nicht im Grund.
 */
export const SKIP_REASONS = [
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
  /**
   * Das Format ist verstanden — fuer DIESE Auswertung ist nur keine Metrik
   * definiert (vision.md §1c, WP-217).
   *
   * Beispiel: `untangle.toml` geht in keine Komplexitaetszahl ein, weil
   * strukturierte Konfiguration keinen Kontrollfluss hat. Das mit
   * `unsupported_language` zu begruenden waere schlicht falsch: die Sprache
   * ist unterstuetzt (Stufe `text`, Suche und Chunks funktionieren), es gibt
   * nur nichts zu rechnen. Ein falscher Grund ist ein stiller Datenverlust
   * mit Etikett — E4 verbietet beides.
   */
  "no_metric_defined",
  /**
   * Maschinell erzeugter Inhalt (Lockdateien und Vergleichbares).
   *
   * Hier steht keine verfasste Aussage. Eine `pnpm-lock.yaml` semantisch zu
   * durchsuchen liefert Rauschen und kostet Einbettungen. Auch das ist NICHT
   * "unsupported_language" — YAML ist unterstuetzt; die Datei ist nur
   * niemandes Text.
   */
  "generated_content",
  /**
   * Die kalibrierte Relevanzpolicy hat die Evidenz fuer unzureichend gehalten
   * (extensions-unabhaengig; siehe `packages/search/src/relevance.ts`).
   *
   * `excluded_by_configuration` waere hier das falsche Etikett, und zwar in
   * beide Richtungen: es wurde nichts wegkonfiguriert, und der Kandidat ist
   * nicht durch einen Filter oder ein Budget gefallen. Das Korpus wurde
   * gemessen, und eine an DIESEM Korpus kalibrierte Konjunktion aus drei
   * Bedingungen hat entschieden. Wer die beiden nicht unterscheiden kann,
   * kann eine Enthaltung nicht von einem Score-Schwellwert trennen — und
   * genau das braucht man, um eine Kalibrierung zu beurteilen.
   */
  "relevance_policy_rejected",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

/** Pipelinestufe, die den Eintrag erzeugt hat. */
export const SKIP_STAGES = [
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
] as const;

export type SkipStage = (typeof SKIP_STAGES)[number];

/** Ein uebersprungener Gegenstand mit Grund (E4). */
export interface SkipLedgerEntryV1 {
  schemaVersion: 1;
  stage: SkipStage;
  subjectKind: SkipSubjectKind;
  /** ID des Gegenstands (file_id, symbol_id, edge_id, extension_id, …). */
  subjectId?: string;
  /** "/"-normalisierter, repo-relativer Pfad, sofern es einen gibt. */
  path?: string;
  /** Betroffener Quellbereich bei `subjectKind: "range"`. */
  range?: SourceRange;
  repoId?: string;
  refId?: string;
  reason: SkipReason;
  /** Menschenlesbare Begruendung; MUSS nicht leer sein — das ist der Kern von E4. */
  detail: string;
  /**
   * True, wenn ein erneuter Lauf denselben Gegenstand voraussichtlich
   * verarbeiten kann (z. B. Anbieter war kurz nicht erreichbar). False bei
   * dauerhaften Grenzen (z. B. nicht unterstuetzte Sprache).
   */
  recoverable: boolean;
}

/** Gesamtes Ledger einer Generation. */
export interface SkipLedgerV1 {
  schemaVersion: 1;
  generationId: string;
  entries: SkipLedgerEntryV1[];
  /** Grund → Anzahl; MUSS zu `entries` passen (siehe `validateSkipLedger`). */
  countsByReason: Partial<Record<SkipReason, number>>;
}

/**
 * Erzeugt einen Ledger-Eintrag und lehnt eine leere Begruendung ab. Eine
 * Uebersprungmeldung ohne Grund ist schlimmer als keine: sie taeuscht
 * Vollstaendigkeit der Diagnose vor.
 */
export function buildSkipLedgerEntry(
  input: Omit<SkipLedgerEntryV1, "schemaVersion">,
): SkipLedgerEntryV1 {
  if (input.detail.trim() === "") {
    throw new Error(
      `skip ledger entry for reason "${input.reason}" must carry a non-empty detail (E4)`,
    );
  }
  return { schemaVersion: 1, ...input };
}

/** Zaehlt Eintraege je Grund; deterministisch, unabhaengig von der Reihenfolge. */
export function summarizeSkipReasons(
  entries: readonly SkipLedgerEntryV1[],
): Partial<Record<SkipReason, number>> {
  const counts: Partial<Record<SkipReason, number>> = {};
  for (const entry of entries) {
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return counts;
}

/** Ein Befund der Ledger-Pruefung. */
export interface SkipLedgerIssue {
  kind: "empty_detail" | "count_mismatch" | "missing_subject";
  message: string;
  index?: number;
}

/**
 * Prueft ein Ledger auf innere Stimmigkeit: jede Begruendung nicht leer, jeder
 * Eintrag mit identifizierbarem Gegenstand, `countsByReason` deckungsgleich
 * mit `entries`.
 */
export function validateSkipLedger(ledger: SkipLedgerV1): SkipLedgerIssue[] {
  const issues: SkipLedgerIssue[] = [];
  for (const [index, entry] of ledger.entries.entries()) {
    if (entry.detail.trim() === "") {
      issues.push({
        kind: "empty_detail",
        message: `entry ${index} (${entry.reason}) has an empty detail (E4)`,
        index,
      });
    }
    if (entry.subjectId === undefined && entry.path === undefined) {
      issues.push({
        kind: "missing_subject",
        message: `entry ${index} (${entry.reason}) identifies neither a subjectId nor a path`,
        index,
      });
    }
  }
  const expected = summarizeSkipReasons(ledger.entries);
  const reasons = new Set([...Object.keys(expected), ...Object.keys(ledger.countsByReason)]);
  for (const reason of reasons) {
    const key = reason as SkipReason;
    if ((expected[key] ?? 0) !== (ledger.countsByReason[key] ?? 0)) {
      issues.push({
        kind: "count_mismatch",
        message: `countsByReason["${reason}"] is ${String(
          ledger.countsByReason[key] ?? 0,
        )}, entries contain ${String(expected[key] ?? 0)}`,
      });
    }
  }
  return issues;
}
