/**
 * Prosa-Metriken als EIGENE Metrikfamilie (vision.md §1c/§1d, WP-217).
 *
 * DER GRUND FUER DIESEN TYP
 *
 * Zyklomatische Komplexitaet ueber ein Markdown-Dokument ist keine schlechte
 * Zahl, sondern gar keine: es gibt keinen Kontrollfluss, ueber den man
 * Pfade zaehlen koennte. Umgekehrt sagt eine Verweisdichte nichts ueber eine
 * Funktion. Die beiden Familien duerfen deshalb nie in dieselbe Summe, in
 * dieselbe Hotspot-Liste und in dasselbe Gate geraten.
 *
 * Das ist hier — wie bei `ExternalNumberV1` in `extensions.ts` — STRUKTURELL
 * durchgesetzt und nicht nur kommentiert: ein Prosa-Messwert ist ein OBJEKT
 * ({@link ProseNumberV1}) und damit an keiner Stelle einsetzbar, an der eine
 * Untangle-Code-Metrik (`number`) erwartet wird — weder in
 * `ComplexitySnapshotV1` noch in `ComplexitySummaryV1`, `MetricContribution`
 * oder `RiskScoreV1`. Der einzige vorgesehene Weg aus dem Prosa-Zahlenraum
 * fuehrt ueber {@link formatProseNumber} in einen String;
 * `assertUntangleMetricNumber` (extensions.ts) weist einen Prosa-Wert auf
 * jedem Aggregationspfad zur Laufzeit ab.
 *
 * DER MASSSTAB: WENIGE, BEGRUENDETE MASSE
 *
 * Fuenf Messwerte, jeder mit einer Lesart, die ohne Modellannahme auskommt:
 *
 * 1. `sectionDepth` — tiefste benutzte Ueberschriftenebene. Wie viele
 *    Gliederungsebenen muss ein Leser gleichzeitig im Kopf halten?
 * 2. `maxSectionLines` — laengster Abschnitt in Zeilen. Der Abschnitt ist
 *    die Einheit, die ein Mensch oder ein Agent am Stueck laedt; der
 *    laengste ist der schlechteste Fall des Dokuments.
 * 3. `linkDensity` — Verweise je 100 Inhaltszeilen. Verweise sind
 *    Auslagerung: sie machen ein Dokument kuerzer und den Weg zur Antwort
 *    laenger.
 * 4. `unresolvedLinkRatio` — Anteil der relativen Dateiverweise, deren Ziel
 *    nicht existiert. Der einzige Messwert mit einem klaren Fehlerbegriff:
 *    ein toter Verweis ist immer ein Mangel. `null`, wenn niemand aufgeloest
 *    hat — ein Zustandsvermerk, kein Messwert von 0 (vision.md §1d).
 * 5. `repetitionRatio` — Anteil der Inhaltszeilen, die woertlich schon
 *    einmal im selben Dokument standen. Das Prosa-Analogon zur Kopie.
 *
 * Dazu EIN abgeleiteter Ordnungsschluessel, {@link ProseMetricsV1.structureLoad}:
 * die Summe der Ueberschriftenebenen aller Abschnitte. Bewusst KEINE
 * gewichtete Mischung ungleicher Groessen (das waere der eine
 * „Quality Score", den vision.md §7.6 ablehnt), sondern EINE abzaehlbare
 * Groesse: die Gesamtzahl der Gliederungsstufen, die das Dokument aufspannt.
 */
import type { ProseLinkKind } from "../prose/markdown-links.js";

declare const PROSE_MEASUREMENT_BRAND: unique symbol;

/** Einheiten der Prosa-Familie; geschlossen, damit eine Zahl nie ohne Lesart dasteht. */
export const PROSE_METRIC_UNITS = ["levels", "lines", "per_100_lines", "ratio", "count"] as const;

export type ProseMetricUnit = (typeof PROSE_METRIC_UNITS)[number];

/**
 * Ein Messwert der Prosa-Familie.
 *
 * Bewusst ein OBJEKT, kein `number`. Der Rohwert bleibt in `value` sichtbar,
 * damit nichts verloren geht (E4) — aber er verlaesst diesen Typ nicht als
 * blanke Zahl.
 */
export interface ProseNumberV1 {
  /** Laufzeitmarker; unterscheidet den Wert von einer Code-Metrik. */
  readonly proseMeasurement: true;
  readonly value: number;
  readonly unit: ProseMetricUnit;
  /** Nur zur Uebersetzungszeit vorhanden; nie serialisiert. */
  readonly [PROSE_MEASUREMENT_BRAND]?: "prose";
}

/** Erzeugt einen Prosa-Messwert; lehnt nicht-endliche Zahlen ab. */
export function makeProseNumber(value: number, unit: ProseMetricUnit): ProseNumberV1 {
  if (!Number.isFinite(value)) {
    throw new Error(`prose measurement must be a finite number, got ${String(value)}`);
  }
  return { proseMeasurement: true, value, unit };
}

/** Typwaechter fuer {@link ProseNumberV1} (auch fuer JSON aus fremder Quelle). */
export function isProseNumber(value: unknown): value is ProseNumberV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { proseMeasurement?: unknown }).proseMeasurement === true &&
    typeof (value as { value?: unknown }).value === "number"
  );
}

/**
 * Anzeigeform eines Prosa-Messwerts — der EINZIGE vorgesehene Weg aus dem
 * Prosa-Zahlenraum, und er fuehrt in einen String, nicht in eine Metrik.
 */
export function formatProseNumber(value: ProseNumberV1): string {
  switch (value.unit) {
    case "ratio":
      return `${(value.value * 100).toFixed(1)} %`;
    case "per_100_lines":
      return `${value.value.toFixed(1)}/100 Zeilen`;
    case "levels":
      return `${String(value.value)} Ebenen`;
    case "lines":
      return `${String(value.value)} Zeilen`;
    case "count":
      return String(value.value);
  }
}

/**
 * Waechter fuer Prosa-Metrikpfade: wirft, wenn jemand eine gewoehnliche Zahl
 * (also eine Code-Metrik oder einen rohen Zaehler) dort einsetzen will, wo
 * ein Prosa-Messwert erwartet wird. Das Gegenstueck zu
 * `assertUntangleMetricNumber`.
 */
export function assertProseNumber(value: unknown, label: string): ProseNumberV1 {
  if (!isProseNumber(value)) {
    throw new Error(
      `"${label}" expects a prose measurement; code metrics and raw numbers are a different family (vision.md §1c)`,
    );
  }
  return value;
}

/** Version der Prosa-Metrikfamilie; steht auf jedem Ergebnis. */
export const PROSE_METRICS_VERSION = "untangle-prose-metrics-v1" as const;

export type ProseMetricsVersion = typeof PROSE_METRICS_VERSION;

/** Ein Verweis, wie er im Dokument steht (Beleg zu `linkDensity`/`unresolvedLinkRatio`). */
export interface ProseLinkV1 {
  /** Zielangabe wie geschrieben, z. B. "./spec.md#7-1" oder "https://…". */
  target: string;
  /** Anzeigetext des Verweises. */
  text: string;
  /** 1-basierte Zeile, in der der Verweis steht. */
  line: number;
  /**
   * Verweisart. `relative_file` ist die einzige Art, die ueberhaupt
   * aufloesbar ist — nur sie geht in `unresolvedLinkRatio` ein.
   */
  kind: ProseLinkKind;
  /**
   * Ergebnis der Aufloesung: `true`/`false` nur bei `relative_file` UND nur,
   * wenn ein Aufloeser gestellt wurde; sonst `null` — „niemand hat gesucht"
   * ist kein Befund ueber das Dokument (vision.md §1d).
   */
  resolved: boolean | null;
}

/** Ein Abschnitt mit seiner Groesse (Beleg zu `maxSectionLines`/`structureLoad`). */
export interface ProseSectionMetricV1 {
  /** Ueberschriftenpfad, mit " › " verbunden; leer beim Vorspann. */
  breadcrumb: string;
  /** Ueberschriftenebene; 0 fuer den Vorspann. */
  level: number;
  startLine: number;
  endLine: number;
  /** Zeilen des Abschnitts einschliesslich seiner Ueberschriftenzeile. */
  lines: number;
}

/**
 * Prosa-Metriken eines Dokuments. Jeder Messwert ist ein
 * {@link ProseNumberV1} — es gibt in diesem Typ bewusst KEIN `number`-Feld,
 * das versehentlich in eine Code-Aggregation wandern koennte.
 */
export interface ProseMetricsV1 {
  readonly schemaVersion: 1;
  readonly metricsVersion: ProseMetricsVersion;
  /** "/"-normalisierter, repo-relativer Pfad. */
  readonly path: string;
  /** Abschnittstiefe: tiefste benutzte Ueberschriftenebene (0 ohne Ueberschriften). */
  readonly sectionDepth: ProseNumberV1;
  /** Laengster Abschnitt in Zeilen. */
  readonly maxSectionLines: ProseNumberV1;
  /** Verweise je 100 Inhaltszeilen. */
  readonly linkDensity: ProseNumberV1;
  /**
   * Anteil toter relativer Dateiverweise. `null` heisst „nicht geprueft" —
   * ein Zustandsvermerk, kein Messwert (vision.md §1d).
   */
  readonly unresolvedLinkRatio: ProseNumberV1 | null;
  /** Anteil woertlich wiederholter Inhaltszeilen. */
  readonly repetitionRatio: ProseNumberV1;
  /** Abgeleiteter Ordnungsschluessel: Summe der Ueberschriftenebenen aller Abschnitte. */
  readonly structureLoad: ProseNumberV1;
  /** Anzahl Abschnitte (Vorspann eingeschlossen). */
  readonly sectionCount: ProseNumberV1;
  /** Nicht-leere Zeilen ausserhalb eingezaeunter Codebloecke. */
  readonly contentLines: ProseNumberV1;
  /** Belege: Abschnitte und Verweise, aus denen die Messwerte entstanden sind. */
  readonly sections: readonly ProseSectionMetricV1[];
  readonly links: readonly ProseLinkV1[];
}
