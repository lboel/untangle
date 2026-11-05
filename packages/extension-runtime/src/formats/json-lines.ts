/**
 * Gemeinsame Eintragslesung der beiden `generic-*`-Formate.
 *
 * Traegerform ist JSON Lines: eine Zeile, ein Eintrag. Zwei Zugestaendnisse,
 * beide dokumentiert und ohne Rateanteil:
 * - ist die GESAMTE Ausgabe ein JSON-Array, sind dessen Elemente die
 *   Eintraege;
 * - ist sie ein Objekt mit einem Array unter dem erwarteten Schluessel
 *   (`findings` bzw. `metrics`), sind dessen Elemente die Eintraege.
 *
 * Eine Zeile, die kein JSON ist, wird gezaehlt und begruendet (E4) — sie
 * reisst die uebrigen Zeilen nicht mit. Erst wenn KEINE Zeile lesbar ist, ist
 * die Gesamtausgabe unbrauchbar.
 */
import type { FormatParseIssueV1 } from "./types.js";
import { FormatParseError } from "./types.js";
import { isRecord } from "./util.js";

/** Ein gelesener Eintrag mit seinem Zeiger in die Rohausgabe. */
export interface JsonEntryV1 {
  value: unknown;
  rawLocation: string;
}

export interface JsonEntriesV1 {
  entries: JsonEntryV1[];
  issues: FormatParseIssueV1[];
}

/**
 * Liest die Eintraege einer `generic-*`-Ausgabe.
 *
 * `containerPath` verlegt die erwartete Liste auf einen Punktpfad
 * (`"component.measures"`), wie ihn eine Web-API liefert. Ist der Pfad
 * deklariert und zeigt ins Leere, ist das ein BEFUND und kein leeres Ergebnis:
 * „dort steht nichts" und „dort steht keine Liste" sind verschiedene Aussagen,
 * und die zweite still als die erste zu fuehren waere der Skip ohne Grund, den
 * E4 verbietet.
 *
 * @throws {FormatParseError} wenn der Text nicht leer ist, aber keine einzige
 * Zeile und auch nicht der Gesamttext als JSON gelesen werden kann.
 */
export function readJsonEntries(
  text: string,
  parserVersion: string,
  containerKey: string,
  options: { containerPath?: string } = {},
): JsonEntriesV1 {
  const trimmed = text.trim();
  if (trimmed === "") {
    // Leere Ausgabe ist eine gueltige Aussage: „nichts gefunden".
    return { entries: [], issues: [] };
  }

  // 1. Gesamtdokument: Array oder Container-Objekt.
  let whole: unknown;
  let wholeIsJson = false;
  try {
    whole = JSON.parse(trimmed) as unknown;
    wholeIsJson = true;
  } catch {
    // Kein Gesamtdokument — das ist der Normalfall bei JSON Lines.
  }
  if (wholeIsJson) {
    if (Array.isArray(whole)) {
      return {
        entries: whole.map((value, index) => ({ value, rawLocation: `/${String(index)}` })),
        issues: [],
      };
    }
    if (isRecord(whole)) {
      if (options.containerPath !== undefined) {
        const located = readPath(whole, options.containerPath);
        if (Array.isArray(located)) {
          return {
            entries: located.map((value, index) => ({
              value,
              rawLocation: `/${options.containerPath ?? ""}/${String(index)}`,
            })),
            issues: [],
          };
        }
        return {
          entries: [],
          issues: [
            {
              rawLocation: `/${options.containerPath}`,
              reason: "missing_required_field",
              detail:
                `the declared container path "${options.containerPath}" holds ` +
                `${located === undefined ? "nothing" : "no array"}`,
            },
          ],
        };
      }
      const container = whole[containerKey];
      if (Array.isArray(container)) {
        return {
          entries: container.map((value, index) => ({
            value,
            rawLocation: `/${containerKey}/${String(index)}`,
          })),
          issues: [],
        };
      }
    }
    // Ein einzelnes JSON-Objekt ohne Container ist ein Eintrag.
    return { entries: [{ value: whole, rawLocation: "/" }], issues: [] };
  }

  // 2. JSON Lines.
  const entries: JsonEntryV1[] = [];
  const issues: FormatParseIssueV1[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const candidate = line.trim();
    if (candidate === "") {
      continue;
    }
    const rawLocation = `line:${String(index + 1)}`;
    try {
      entries.push({ value: JSON.parse(candidate) as unknown, rawLocation });
    } catch (cause) {
      issues.push({
        rawLocation,
        reason: "invalid_entry",
        detail: `line is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }
  if (entries.length === 0) {
    throw new FormatParseError(
      parserVersion,
      `output contains no readable JSON entry (${String(issues.length)} unreadable line(s))`,
    );
  }
  return { entries, issues };
}

/**
 * Liest einen Wert ueber einen Punktpfad (`"extra.severity"`). Ein Pfad ohne
 * Punkt ist ein gewoehnlicher Schluessel. Fehlt ein Zwischenschritt, ist das
 * Ergebnis `undefined` — nie ein Fehler.
 */
export function readPath(source: unknown, dottedPath: string): unknown {
  let current: unknown = source;
  for (const segment of dottedPath.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
