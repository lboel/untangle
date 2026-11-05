/**
 * Die Ereignisse des Komplexitaetswaechters — der Strom, den `untangle watch`
 * ausgibt (vision.md §1b "Ratsche", §1d "Auffindbarkeit ist selbst ein
 * Qualitaetssignal").
 *
 * Diese Datei fixiert die FORM des Stroms; `render.ts` fixiert nur seine
 * Darstellung. Beide Ausgabewege (Text, JSON) speisen sich aus denselben
 * Werten, damit die maschinenlesbare Ausgabe nie etwas anderes behauptet als
 * die lesbare.
 *
 * ENTSCHEIDUNG (E4 an der Oberflaeche): `WatchUnanalyzedEventV1` ist ein
 * ERSTKLASSIGES Stromereignis, kein Log-Rauschen. Eine Datei, die der
 * Waechter nicht messen konnte, MUSS im selben Strom auftauchen wie eine, die
 * er messen konnte — sonst liest der Nutzer aus dem Schweigen "nichts
 * passiert", und genau das waere schlimmer als kein Waechter.
 */
import type { SkipLedgerEntryV1 } from "@untangle-code/domain";

/**
 * Die vier Metriken des Waechters (vision.md §1b: "strukturell, semantisch,
 * cyclomatic, cognitive").
 *
 * Reihenfolge ist normativ: sie ist die Ausgabereihenfolge in JEDER
 * Darstellung, damit zwei Laeufe zeilenweise vergleichbar bleiben.
 */
export const METRIC_KEYS = ["structural", "semantic", "cyclomatic", "cognitive"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** Metrikwerte einer Messung, immer vollstaendig — kein Feld fehlt je. */
export type MetricValues = Readonly<Record<MetricKey, number>>;

/**
 * Die Richtung einer Aenderung. Fuer ALLE vier Metriken gilt: kleiner ist
 * einfacher, also bedeutet ein negatives Delta abgebaute Komplexitaet. Eine
 * nackte Zahl hilft niemandem — die Richtung ist der Teil, der die Aussage
 * traegt.
 */
export type ComplexityDirection = "abgebaut" | "aufgebaut" | "unveraendert";

/**
 * Welche Lesart einer Scope-Summe hinter einem Metrikwert steht
 * (`packages/complexity/src/scope-aggregate.ts`). Eine Zahl ohne Lesart waere
 * bedeutungslos, deshalb reist sie mit.
 *
 * - `"execution_unit"` — Summe ueber die aeussersten Ausfuehrungseinheiten,
 *   jede genau einmal, verschachtelte Closures darin enthalten. Die Vorgabe
 *   fuer strukturell/cyclomatic/cognitive.
 * - `"file_chunks"` — die semantische Ladung wird nicht ueber Scopes
 *   summiert, sondern ueber die Chunks der Datei (siehe `analyze.ts`).
 */
export type MetricReadingKind = "execution_unit" | "file_chunks";

/** Ein Delta EINER Metrik, mit Richtung. */
export interface MetricDeltaV1 {
  metric: MetricKey;
  reading: MetricReadingKind;
  /** Wert vor der Aenderung; `null` bei einer neu hinzugekommenen Datei. */
  previous: number | null;
  /** Wert nach der Aenderung; `null` bei einer geloeschten Datei. */
  current: number | null;
  /** `current - previous`, mit fehlender Seite als 0 gelesen. */
  delta: number;
  direction: ComplexityDirection;
}

/** Ein Delta EINES Scopes — die Stelle, an der der Preis entsteht. */
export interface ScopeDeltaV1 {
  /** `metrics_scope_id` nach spec.md §16.10. */
  metricsScopeId: string;
  /** Qualifizierter Name des Scopes, wie ihn der Sprachadapter meldet. */
  label: string;
  kind: string;
  /** Erste Zeile des Scopes NACH der Aenderung, sonst davor. */
  line: number;
  metric: MetricKey;
  previous: number | null;
  current: number | null;
  delta: number;
  direction: ComplexityDirection;
}

/** Der Waechter hat den Lock erworben und die Grundmessung begonnen. */
export interface WatchStartedEventV1 {
  kind: "started";
  sequence: number;
  at: string;
  root: string;
  repoId: string;
  refId: string;
  lockKey: string;
}

/**
 * Die Grundmessung ist fertig: ab hier sind alle Deltas gegen einen bekannten
 * Stand gemessen und nicht gegen Nichts.
 */
export interface WatchBaselineEventV1 {
  kind: "baseline";
  sequence: number;
  at: string;
  filesAnalyzed: number;
  /** Wie viele Dateien mit Grund im Ledger stehen (E4). */
  filesUnanalyzed: number;
  /**
   * Wie viele Pfade der Scanner ueber Ignorierregeln ausgeschlossen hat
   * (`.gitignore`, Vorgabeausschluesse, Konfiguration).
   *
   * WARUM NUR EINE ZAHL UND KEIN EREIGNIS JE PFAD: das sind auf einem
   * gewoehnlichen Repository zehntausende Pfade (`node_modules/`, `dist/`),
   * und ein Strom, der davon ueberflutet wird, verbirgt genau das, was E4
   * sichtbar machen will. Ausgeschlossen-nach-Regel ist zudem eine
   * Konfigurationsentscheidung des Nutzers, kein Analysefehlschlag. Jeder
   * Ausschluss, der NICHT auf einer Regel beruht — binaerer Inhalt,
   * Groessengrenze, unlesbar — bekommt sein eigenes `unanalyzed`-Ereignis.
   */
  filesExcludedByRules: number;
  totals: MetricValues;
  /** Summe der Scopes, die in die drei Scope-Metriken eingehen. */
  scopeCount: number;
  /**
   * Wie viele Scope-Ids der Sprachadapter innerhalb einer Datei doppelt
   * vergeben hat und `withUniqueScopeIds` reparieren musste (WP-82). `> 0`
   * ist kein Fehler, aber eine Einschraenkung, die sichtbar bleiben muss.
   */
  scopeIdCollisions: number;
  /**
   * Wie viele `NodeKindFact`s nur ueber den Ersatzweg zugeordnet werden
   * konnten (sie tragen keine `SourceRange`). Betrifft ausschliesslich die
   * strukturelle Metrik.
   */
  nodeKindFallbacks: number;
  durationMs: number;
}

/** Eine Aenderung an einer Datei, mit Deltas je Metrik und je Scope. */
export interface WatchChangeEventV1 {
  kind: "change";
  sequence: number;
  at: string;
  changeKind: "added" | "modified" | "deleted";
  /** "/"-normalisierter, repo-relativer Pfad. */
  path: string;
  languageId: string | null;
  contentHash: string | null;
  metrics: MetricDeltaV1[];
  /**
   * Die Scopes, deren Wert sich geaendert hat — nach Betrag absteigend,
   * bei Gleichstand nach Scope-Id (Codepoint-Ordnung).
   */
  scopes: ScopeDeltaV1[];
  /** Gesamtrichtung ueber alle vier Metriken (siehe `delta.ts`). */
  verdict: ComplexityDirection;
  /**
   * Einschraenkungen dieser einen Messung im Klartext (Parse-Qualitaet,
   * Chunker-Abstufung, Scope-Id-Kollisionen). Leer heisst: keine.
   */
  notes: string[];
  analysisMs: number;
}

/**
 * E4 an der Oberflaeche: eine Datei, die NICHT analysiert werden konnte,
 * erscheint im Strom als solche — mit Grund, Detailtext und der Angabe, ob
 * ein spaeterer Versuch Aussicht auf Erfolg hat.
 */
export interface WatchUnanalyzedEventV1 {
  kind: "unanalyzed";
  sequence: number;
  at: string;
  /** Woher die Datei kam: Grundmessung oder eine laufende Aenderung. */
  origin: "baseline" | "change";
  entry: SkipLedgerEntryV1;
}

/** Zustandswechsel des Watchers (`starting` → `running` → `degraded` → `stopped`). */
export interface WatchStatusEventV1 {
  kind: "status";
  sequence: number;
  at: string;
  status: "starting" | "running" | "degraded" | "stopped";
  /** Fehlertext, wenn der Wechsel durch einen Fehler ausgeloest wurde. */
  detail: string | null;
}

/** Der Waechter hat sauber beendet: Strom geschlossen, Lock freigegeben. */
export interface WatchStoppedEventV1 {
  kind: "stopped";
  sequence: number;
  at: string;
  /**
   * `"signal"` = SIGINT/SIGTERM, `"limit"` = `--exit-after` erreicht,
   * `"baseline"` = `--baseline-only`, `"error"` = Abbruch.
   */
  reason: "signal" | "limit" | "baseline" | "error";
  signal: string | null;
  changesObserved: number;
  filesUnanalyzed: number;
  /** Netto-Delta der Sitzung je Metrik: was diese Sitzung insgesamt bewirkt hat. */
  net: MetricValues;
  netDirection: ComplexityDirection;
  /** Rueckstau-Kennzahlen der `BoundedQueue` (architecture.md §13.2). */
  queue: {
    maxDepthObserved: number;
    maxBytesObserved: number;
    overBudgetAdmissions: number;
  };
  lockReleased: boolean;
  durationMs: number;
}

export type WatchStreamEventV1 =
  | WatchStartedEventV1
  | WatchBaselineEventV1
  | WatchChangeEventV1
  | WatchUnanalyzedEventV1
  | WatchStatusEventV1
  | WatchStoppedEventV1;

/** Nullwerte fuer alle vier Metriken — nie `{}` weiterreichen. */
export function zeroMetricValues(): MetricValues {
  return { structural: 0, semantic: 0, cyclomatic: 0, cognitive: 0 };
}

/**
 * Ein Ereignis OHNE Umschlag (`sequence`, `at`) — die Form, in der der
 * Waechter ein Ereignis meldet; den Umschlag setzt `runWatch` an genau einer
 * Stelle, damit die laufende Nummer luecken- und sprungfrei bleibt.
 *
 * Die Verteilung ueber die Vereinigung (`T extends unknown ? ... : never`)
 * ist notwendig: ein `Omit` DIREKT auf der Vereinigung behielte nur die
 * gemeinsamen Felder aller Varianten uebrig und verwuerfe genau die Felder,
 * um die es geht.
 */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "sequence" | "at"> : never;
export type WatchStreamEventDraftV1 = WithoutEnvelope<WatchStreamEventV1>;
