/**
 * Kleine, gemeinsame Lesehilfen der Formatparser.
 *
 * Grundregel aus extensions.md §6.5: unbekannte Felder tolerieren, bekannte
 * Felder streng lesen. Deshalb liefern alle Leser hier `undefined` statt zu
 * werfen — ob ein fehlendes Feld ein Fehler ist, entscheidet der Parser und
 * vermerkt es als {@link FormatParseIssueV1}, nie stillschweigend.
 */
/** True, wenn `value` ein gewoehnliches Objekt ist (kein Array, kein null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Liest ein Feld als nicht-leeren String; sonst `undefined`. */
export function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Liest ein Feld als endliche Zahl; akzeptiert auch numerische Strings. */
export function readNumber(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Liest ein Feld als Boolean; sonst `undefined`. */
export function readBoolean(source: unknown, key: string): boolean | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Liest ein Feld als Array; sonst `undefined`. */
export function readArray(source: unknown, key: string): unknown[] | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return Array.isArray(value) ? value : undefined;
}

/** Liest ein Feld als Objekt; sonst `undefined`. */
export function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Bringt einen Werkzeugpfad auf eine einheitliche Schreibweise: `/` als
 * Trenner, ohne `file://`-Schema, ohne URL-Prozentkodierung, ohne fuehrendes
 * `./` und ohne abschliessenden Trenner.
 *
 * Bewusst NICHT `normalizeRelativePath` aus `@untangle-code/domain`: das wirft
 * bei absoluten Pfaden, und externe Werkzeuge liefern regelmaessig absolute
 * `file://`-URIs. Ein Formatparser darf daran nicht scheitern. Absolute Pfade
 * bleiben hier absolut; sie repo-relativ zu machen ist Sache der
 * Normalisierung, die den Repository-Wurzelpfad kennt — ein stilles
 * Abschneiden waere geraten (E4).
 */
export function normalizeToolPath(rawPath: string): string {
  let path = rawPath.replace(/\\/g, "/");
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
  }
  if (path.includes("%")) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // Kein gueltiges Prozent-Encoding: der Rohpfad ist die bessere Antwort
      // als ein Abbruch. Nichts geht verloren, nichts wird geraten.
    }
  }
  const absolutePrefix = /^([a-zA-Z]:\/|\/)/.exec(path)?.[0] ?? "";
  const body = path.slice(absolutePrefix.length);
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return absolutePrefix + segments.join("/");
}

/** True, wenn `path` bereits eine repo-relative Untangle-Pfadform ist. */
export function isRelativeRepoPath(path: string): boolean {
  return path !== "" && !/^([a-zA-Z]:\/|\/)/.test(path) && !path.startsWith("../") && path !== "..";
}

/** Eine 1-basierte, positive ganze Zeilennummer oder `undefined`. */
export function readLineNumber(source: unknown, key: string): number | undefined {
  const value = readNumber(source, key);
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

/**
 * Ergebnis eines Feldzugriffs, der „fehlt" von „ist da, ist aber unbrauchbar"
 * unterscheidet.
 *
 * Diese Unterscheidung ist der Kern von E4 an der Formatgrenze: ein FEHLENDES
 * Feld ist eine Auslassung des Werkzeugs, ueber die es nichts zu berichten
 * gibt; ein VORHANDENES, unlesbares Feld ist eine kaputte Angabe. Sie
 * stillschweigend durch einen Vorgabewert zu ersetzen, erzeugt eine Zahl, die
 * von einer gemessenen nicht mehr zu unterscheiden ist.
 */
export type FieldReadV1<T> =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly raw: string }
  | { readonly state: "value"; readonly value: T };

/** Kurze, zitierfaehige Beschreibung eines Rohwerts fuer Fehlermeldungen. */
export function describeRawValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `an array of ${String(value.length)} element(s)`;
  }
  if (typeof value === "object") {
    return "an object";
  }
  return typeof value;
}

/** True, wenn das Feld ueberhaupt nicht belegt ist. */
function isAbsent(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

/** Liest einen Rohwert als endliche Zahl; akzeptiert auch numerische Strings. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Liest eine Confidence in [0,1].
 *
 * Ein Wert ausserhalb des Bereichs wird NICHT zurechtgebogen: eine 7 auf 1 zu
 * kappen oder als Prozentwert zu deuten waere geraten. Er gilt als unlesbar,
 * bleibt aber ueber `raw` als unveraenderter Werkzeugwert erhalten.
 */
export function readConfidenceValue(value: unknown): FieldReadV1<number> {
  if (isAbsent(value)) {
    return { state: "absent" };
  }
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) {
    return { state: "unreadable", raw: describeRawValue(value) };
  }
  return { state: "value", value: numeric };
}

/**
 * Liest eine Ja/Nein-Angabe.
 *
 * Neben echten Booleans gelten nur die Zeichenketten `"true"` und `"false"` —
 * beides sind JSON-Schreibweisen desselben Wertes. Alles andere ist unlesbar;
 * eine freie Zeichenkette als „wahr" zu deuten waere geraten.
 */
export function readFlagValue(value: unknown): FieldReadV1<boolean> {
  if (isAbsent(value)) {
    return { state: "absent" };
  }
  if (typeof value === "boolean") {
    return { state: "value", value };
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return { state: "value", value: true };
    }
    if (normalized === "false") {
      return { state: "value", value: false };
    }
  }
  return { state: "unreadable", raw: describeRawValue(value) };
}

/** Liest eine 1-basierte, positive ganze Zeilennummer. */
export function readLineValue(value: unknown): FieldReadV1<number> {
  if (isAbsent(value)) {
    return { state: "absent" };
  }
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || !Number.isInteger(numeric) || numeric < 1) {
    return { state: "unreadable", raw: describeRawValue(value) };
  }
  return { state: "value", value: numeric };
}

/** Liest einen 0-basierten, nicht negativen ganzzahligen Byte-Wert. */
export function readByteValue(value: unknown): FieldReadV1<number> {
  if (isAbsent(value)) {
    return { state: "absent" };
  }
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || !Number.isInteger(numeric) || numeric < 0) {
    return { state: "unreadable", raw: describeRawValue(value) };
  }
  return { state: "value", value: numeric };
}
