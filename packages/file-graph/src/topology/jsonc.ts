/**
 * Toleranter JSON-Leser fuer Projektkonfigurationen.
 *
 * Warum nicht direkt `JSON.parse`: Projektkonfigurationen im
 * TypeScript-Umfeld duerfen Kommentare und abschliessende Kommata enthalten
 * (die `tsconfig.base.json` dieses Repositories tut es). `JSON.parse` wirft
 * darauf, und ein geworfener Fehler wuerde bedeuten, dass saemtliche
 * Pfad-Aliase eines Pakets stillschweigend fehlen — genau das, was E4
 * verbietet. Deshalb ein Vorlauf, der Kommentare und abschliessende Kommata
 * entfernt, und danach `JSON.parse`.
 *
 * Der Vorlauf ist zeichenweise und stringbewusst: ein `"http://x"` in einem
 * Wert darf nicht als Zeilenkommentar gelesen werden.
 */

/** Entfernt Kommentare und abschliessende Kommata; laesst alles andere unveraendert. */
export function stripJsonComments(text: string): string {
  let result = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index] as string;
    if (inString) {
      result += char;
      if (char === "\\" && index + 1 < text.length) {
        result += text[index + 1] as string;
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        // Zeilenumbrueche erhalten, damit Zeilennummern in Fehlermeldungen stimmen.
        if (text[index] === "\n") {
          result += "\n";
        }
        index += 1;
      }
      index += 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return removeTrailingCommas(result);
}

function removeTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      result += char;
      if (char === "\\" && index + 1 < text.length) {
        result += text[index + 1] as string;
        index += 1;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead] as string)) {
        lookahead += 1;
      }
      const next = text[lookahead];
      if (next === "}" || next === "]") {
        continue; // abschliessendes Komma verwerfen
      }
    }
    result += char;
  }
  return result;
}

/** Ergebnis eines toleranten JSON-Lesevorgangs. */
export type JsoncParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Liest ein JSON-Dokument mit Kommentaren. Wirft NICHT: bei einem Fehlschlag
 * kommt `{ ok: false, error }` zurueck, damit der Aufrufer einen
 * Ledger-Eintrag mit Grund schreiben kann, statt still ein leeres Objekt zu
 * verwenden (E4).
 */
export function parseJsonc(text: string): JsoncParseResult {
  try {
    return { ok: true, value: JSON.parse(stripJsonComments(text)) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Typwaechter fuer „ein JSON-Objekt, keine Liste, kein null". */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Liest ein Stringfeld eines JSON-Objekts; `undefined`, wenn es keinen String gibt. */
export function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

/** Liest ein `Record<string, string>`-Feld; nicht-String-Werte werden ausgelassen. */
export function stringRecordField(
  object: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = object[key];
  if (!isJsonObject(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      result[entryKey] = entryValue;
    }
  }
  return result;
}
