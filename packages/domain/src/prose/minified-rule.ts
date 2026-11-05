/**
 * Die Minified-Frage: EINE Regel, an einem Ort (spec.md §8.3 Schritt 10).
 *
 * Bis Welle 13 wurde sie an zwei Orten mit verschiedenen Schwellen
 * beantwortet — der Scanner bei 500 Zeichen Einzelzeile auf einer 8-KB-
 * Stichprobe, der Chunker bei 1000 auf dem ganzen Inhalt. Welche galt, hing
 * daran, ob eine Datei ueber den Index- oder den Watch-Pfad kam. Dieselbe
 * Datei konnte also beides sein, und niemand haette es gemerkt.
 *
 * Der inhaltliche Fehler wog schwerer: eine einzelne lange Zeile beweist
 * weder bei Code noch bei Prosa Minifizierung. Eine Diagnose-/Stringzeile
 * darf nicht die Methodensymbole eines sonst formatierten Moduls entfernen.
 * In Markdown ist eine lange Tabellenzeile normal. Vier der
 * wichtigsten Dokumente dieses Repositoriums lagen deshalb als strukturlose
 * Bytefenster im Index — und ob eine Datei betroffen war, entschied die
 * Stichprobenlage: die erste lange Zeile musste zufaellig in die ersten 8 KB
 * fallen.
 *
 * Diese Funktion misst nichts. Sie bekommt die Form des Inhalts und
 * entscheidet — damit beide Aufrufer in ihrer eigenen Darstellung messen
 * koennen (der eine auf Bytes, der andere auf einem String) und trotzdem
 * dieselbe Antwort bekommen.
 */
import type { TextFormatKind } from "./text-formats.js";

/** Die gemessene Form eines Inhalts. */
export interface MinifiedShapeV1 {
  /** Laenge der laengsten Zeile. */
  maxLineLength: number;
  /** Durchschnittliche Zeilenlaenge ueber den gemessenen Ausschnitt. */
  averageLineLength: number;
}

/** Die Schwellen der Regel. */
export interface MinifiedRuleV1 {
  /** Eine einzelne Zeile ab dieser Laenge genuegt nur bei strukturierten Daten. */
  maxLineLengthThreshold: number;
  /** Durchschnittliche Zeilenlaenge ab der Minifizierung gilt; immer wirksam. */
  averageLineLengthThreshold: number;
}

/**
 * Die eine Vorgabe. 500 stammt aus dem Scanner, der die Entscheidung
 * tatsaechlich traf; die 1000 des Chunkers waren im Indexpfad ohne Wirkung.
 */
export const DEFAULT_MINIFIED_RULE: Readonly<MinifiedRuleV1> = {
  maxLineLengthThreshold: 500,
  averageLineLengthThreshold: 300,
};

/**
 * Entscheidet, ob eine Form als minifiziert gilt.
 *
 * Code und Prosa brauchen den hohen Durchschnitt: einzelne lange Strings,
 * Diagnosen, Tabellen oder Absaetze sind keine Minifizierung. Die bisherige
 * OR-Regel fuer Code verlor dadurch alle Symbole normal formatierter Module.
 * Ein echtes einzeiliges Bundle erreicht weiterhin den Durchschnittswert.
 *
 * `structured_data` behaelt die Einzelzeilenregel: eine einzeilige JSON-Datei
 * ist kein Fliesstext, und ihre Struktur geht durch Bytefenster nicht verloren,
 * weil sie keine Ueberschriften hat.
 */
export function isMinifiedShape(
  shape: MinifiedShapeV1,
  options: { textFormat?: TextFormatKind | null },
  rule: MinifiedRuleV1 = DEFAULT_MINIFIED_RULE,
): boolean {
  if (shape.averageLineLength >= rule.averageLineLengthThreshold) {
    return true;
  }
  return (
    options.textFormat === "structured_data" && shape.maxLineLength >= rule.maxLineLengthThreshold
  );
}
