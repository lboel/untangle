/**
 * Formatebene: was ein AUSGABEFORMAT allein aus seinem Text hergibt
 * (extensions.md §17, X9).
 *
 * Bewusste Trennung in zwei Stufen:
 *
 * 1. Der Formatparser ist rein. Er bekommt Text und liefert
 *    {@link RawFindingV1}/{@link RawMeasurementV1} — Zeilenangaben, Regel-ID,
 *    Meldung und den unveraenderten Severity-String des Werkzeugs. Mehr steht
 *    im Text nicht: keine `workspace_id`, keine Byte-Offsets, keine Symbole.
 * 2. `normalizeFindings` hebt das Rohergebnis auf `ExternalFindingV1` — mit
 *    Identitaeten, Byte-Range (extensions.md §7.1) und Symbolzuordnung
 *    (§7.2).
 *
 * Der Grund fuer die Trennung ist Ehrlichkeit: wuerde der Parser direkt
 * `ExternalFindingV1` liefern, muesste er Byte-Offsets erfinden, die im Text
 * nicht stehen. `parseAndNormalize` bietet trotzdem den Einschritt-Weg
 * „Text rein, ExternalFindingV1[] raus".
 *
 * Kein Modul unterhalb von `formats/` kennt ein Werkzeug (E2). Werkzeugnamen
 * kommen ausschliesslich aus den Nutzerdaten — Manifest oder Werkzeugausgabe.
 */

/** Zeilen-/Spaltenangabe, wie externe Werkzeuge sie liefern (1-basiert). */
export interface RawPositionV1 {
  /** 1-basiert, inklusiv. */
  startLine: number;
  /** 1-basiert, inklusiv; gleich `startLine`, wenn das Format nur eine Zeile nennt. */
  endLine: number;
  /** 1-basiert, inklusiv; fehlt, wenn das Format keine Spalten liefert. */
  startColumn?: number;
  /** 1-basiert, exklusiv (SARIF-Konvention); fehlt ohne Spaltenangabe. */
  endColumn?: number;
  /**
   * 0-basierter Byte-Offset, wenn das FORMAT ihn selbst fuehrt (SARIF
   * `region.byteOffset`). Ist er da, entfaellt die Zeile→Byte-Uebersetzung
   * aus extensions.md §7.1 — die genauere Angabe gewinnt.
   */
  byteOffset?: number;
  /** Laenge in Bytes zu {@link byteOffset} (SARIF `region.byteLength`). */
  byteLength?: number;
  /**
   * True, wenn das FORMAT keine brauchbare Zeilenangabe lieferte und der
   * Parser den Befund ersatzweise am Dateianfang verankert hat.
   *
   * Die Zeile 1 ist dann eine ERSATZANGABE, keine Messung. Ohne diese Marke
   * waere ein erfundener Ort von einem belegten nicht mehr zu unterscheiden —
   * genau das schliesst E4 aus. Die Normalisierung macht die Marke im Lauf
   * sichtbar; einen Befund deswegen fallen zu lassen waere der groessere
   * Verlust, denn Datei, Regel und Meldung sind belegt.
   */
  lineUnknown?: boolean;
}

/** Ein Befund auf Formatebene — vor jeder Untangle-Identitaet. */
export interface RawFindingV1 {
  /** "/"-normalisierter, repo-relativer Pfad, so wie das Format ihn nennt. */
  filePath: string;
  position: RawPositionV1;
  /** Regelkennung des Werkzeugs, unveraendert. */
  ruleId: string;
  message: string;
  /**
   * Unveraenderter Severity-String des Werkzeugs. Formate ohne eigene
   * Severity liefern hier einen dokumentierten Formatwert (z. B. `"failure"`
   * bei JUnit) — nie einen geratenen Untangle-Wert.
   */
  originalSeverity: string;
  remediationHint?: string;
  /** Unveraenderter Confidence-String, wenn das Format einen fuehrt. */
  originalConfidence?: string;
  /** Numerische Confidence in [0,1], wenn das Format sie liefert. */
  confidenceValue?: number;
  /** True, wenn das Format den Befund selbst als heuristisch kennzeichnet. */
  isHeuristic?: boolean;
  ruleset?: string;
  rulesetVersion?: string;
  /** Zeiger in die Rohausgabe (JSON-Pointer bzw. Zeilennummer). */
  rawLocation: string;
}

/** Ein Kennwert auf Formatebene (`generic-metrics`). */
export interface RawMeasurementV1 {
  /** Schluessel wie vom Werkzeug geliefert, unveraendert. */
  key: string;
  value: number;
  unit?: string;
  /** "/"-normalisierter, repo-relativer Pfad, sofern die Groesse dateibezogen ist. */
  filePath?: string;
  rawLocation: string;
}

/** Warum ein Eintrag der Rohausgabe nicht uebernommen werden konnte. */
export const FORMAT_PARSE_ISSUE_REASONS = [
  "invalid_entry",
  "missing_required_field",
  "invalid_number",
  "unsupported_version",
  "no_location",
  /**
   * Ein Feld IST da, sein Wert ist aber unbrauchbar (falscher Typ, ausserhalb
   * des Wertebereichs). Zu unterscheiden von „Feld fehlt": ein fehlendes Feld
   * ist eine Auslassung des Werkzeugs, ein unlesbares eine kaputte Angabe —
   * und ein stillschweigend durch einen Vorgabewert ersetzter Wert waere eine
   * erfundene Zahl mit dem Anschein einer gemessenen (E4).
   */
  "unreadable_field",
  /**
   * Das Werkzeug meldet in seiner eigenen Ausgabe, dass sein Lauf nicht
   * erfolgreich war (z. B. SARIF `invocations[].executionSuccessful: false`).
   * Die Ausgabe ist dann bestenfalls eine Teilmenge — das darf nicht als
   * vollstaendiges Ergebnis durchgehen.
   */
  "tool_reported_failure",
] as const;

export type FormatParseIssueReason = (typeof FORMAT_PARSE_ISSUE_REASONS)[number];

/**
 * Ein nicht uebernommener Eintrag MIT Grund (E4).
 *
 * Teilweise unbrauchbare Ausgabe darf nicht still zu einer Teilmenge werden
 * (extensions.md §6.5): jeder verworfene Eintrag steht hier, gueltige
 * Eintraege gehen nicht verloren.
 */
export interface FormatParseIssueV1 {
  rawLocation: string;
  reason: FormatParseIssueReason;
  detail: string;
}

/** Ergebnis eines Formatparsers. */
export interface FormatParseResultV1 {
  parserVersion: string;
  findings: RawFindingV1[];
  measurements: RawMeasurementV1[];
  /** Nicht uebernommene Eintraege mit Grund (E4). */
  issues: FormatParseIssueV1[];
  /** Wie viele Eintraege die Rohausgabe enthielt — Basis fuer `issues`. */
  entriesSeen: number;
  /** Werkzeugname laut Ausgabe (Nutzerdaten, nicht Quelltextwissen). */
  toolNameHint?: string;
  /** Werkzeugversion laut Ausgabe (Nutzerdaten, nicht Quelltextwissen). */
  toolVersionHint?: string;
  /**
   * WP-199: Ob die Ausgabe als BERICHT DIESES FORMATS erkannt wurde — auch
   * wenn sie keinen einzigen Eintrag enthielt.
   *
   * Der Unterschied ist nicht kosmetisch. „Kein Eintrag" hat zwei sehr
   * verschiedene Ursachen: das Werkzeug ist abgestuerzt und hat Muell oder
   * nichts geschrieben (dann belegt der Lauf gar nichts), oder es hat einen
   * einwandfreien, LEEREN Bericht geschrieben (dann belegt er, dass das
   * Werkzeug durchgelaufen ist und nichts zu melden hatte). Wer beides gleich
   * behandelt, laesst einen gueltigen Lauf mit einer sachlich falschen
   * Begruendung scheitern.
   *
   * Nur Formate mit einer erkennbaren Berichtshuelle setzen das Feld: SARIF
   * (`runs`) und JUnit-XML (`<testsuites>`/`<testsuite>`). Bei zeilenweisen
   * Formaten gibt es keine Huelle — dort ist leere Ausgabe schlicht leere
   * Ausgabe, und das Feld bleibt ungesetzt.
   */
  recognizedReport?: boolean;
}

/**
 * Die Gesamtausgabe ist syntaktisch unbrauchbar (extensions.md §6.5).
 *
 * Die Laufzeit uebersetzt das in `EXTENSION_FAILED` mit
 * `details.reason = "output_parse_failed"`. Der Parser selbst kennt weder
 * Extension-ID noch Fehlercode — er bleibt rein.
 */
export class FormatParseError extends Error {
  public readonly parserVersion: string;

  public constructor(parserVersion: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FormatParseError";
    this.parserVersion = parserVersion;
  }
}

/** Leeres Ergebnis eines Parsers; Basis fuer die vier Formatparser. */
export function emptyParseResult(parserVersion: string): FormatParseResultV1 {
  return { parserVersion, findings: [], measurements: [], issues: [], entriesSeen: 0 };
}
