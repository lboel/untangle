/**
 * Parser fuer `generic-metrics` — Kennzahlen als flache Schluessel-Wert-Liste
 * (extensions.md §17).
 *
 * X3 ist hier der springende Punkt: die gelesenen Zahlen verlassen diesen
 * Parser NICHT als `number`, sondern als {@link RawMeasurementV1} und weiter
 * als `ExternalMeasurementV1` mit `ExternalNumberV1`. Sie passen damit
 * strukturell an keine Untangle-Metrikstelle. Misst ein Werkzeug dieselbe
 * Groesse wie Untangle, ist das eine Gegenprobe in der Testsuite (X8), kein
 * zweiter Anzeigewert.
 *
 * Kanonischer Eintrag (JSON Lines, ein Objekt je Zeile):
 *
 * ```json
 * {"key":"duplicated_lines_density","value":3.4,"unit":"percent","path":"src/a.ts"}
 * ```
 *
 * Pflichtfelder sind `key` und ein endlicher numerischer `value`.
 */
import { GENERIC_METRICS_PARSER_VERSION } from "../versions.js";

import { compareCodepoints } from "@untangle-code/domain";

import { readJsonEntries, readPath } from "./json-lines.js";
import type { FormatParseIssueV1, FormatParseResultV1, RawMeasurementV1 } from "./types.js";
import { emptyParseResult, FormatParseError } from "./types.js";
import { describeRawValue, isRecord, normalizeToolPath } from "./util.js";

/**
 * Traegerform der Ausgabe.
 *
 * `entries` ist der Normalfall: JSON Lines, ein Array, oder ein Objekt mit
 * einem Array unter `metrics` bzw. unter {@link GenericMetricFieldMappingV1.container}.
 *
 * `flat-object` ist die andere sehr gewoehnliche Form — ein einziges Objekt,
 * dessen Schluessel die Kennzahlnamen und dessen Werte die Zahlen sind. Sie
 * wird DEKLARIERT und nie erraten: dasselbe Objekt kann ebensogut ein
 * einzelner Eintrag mit `key`/`value` sein, und eine Vermutung darueber waere
 * die stille Umdeutung, die E4 verbietet.
 */
export type GenericMetricShapeV1 = "entries" | "flat-object";

/** Deklaratives Feld-Mapping: kanonisches Feld → Punktpfad in der Ausgabe. */
export interface GenericMetricFieldMappingV1 {
  shape?: GenericMetricShapeV1;
  /** Punktpfad zur Eintragsliste, wenn sie nicht unter `metrics` liegt. */
  container?: string;
  key?: string;
  value?: string;
  unit?: string;
  path?: string;
}

/** Die kanonischen Schluesselnamen — zugleich das Default-Mapping. */
export const DEFAULT_GENERIC_METRIC_FIELDS: Required<
  Pick<GenericMetricFieldMappingV1, "key" | "value" | "unit" | "path">
> = {
  key: "key",
  value: "value",
  unit: "unit",
  path: "path",
};

/**
 * Liest ein flaches Objekt: ein Schluessel, eine Zahl, ein Messwert.
 *
 * Jeder Schluessel, dessen Wert keine endliche Zahl ist, wird GENANNT statt
 * uebergangen — ein weggelassener Zeitstempel ist harmlos, ein weggelassener
 * Kennwert waere eine andere Aussage als die des Werkzeugs (E4).
 *
 * Die Ausgabe ist nach Schluessel sortiert. Die Reihenfolge der Schluessel in
 * einem JSON-Objekt ist eine Eigenschaft des Werkzeugs, nicht der Messung;
 * eine stabile Ordnung macht zwei Laeufe vergleichbar.
 */
function parseFlatObject(text: string, result: FormatParseResultV1): FormatParseResultV1 {
  const trimmed = text.trim();
  if (trimmed === "") {
    return result;
  }
  let document: unknown;
  try {
    document = JSON.parse(trimmed) as unknown;
  } catch (cause) {
    throw new FormatParseError(
      GENERIC_METRICS_PARSER_VERSION,
      `output is declared as a flat metric object but is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (!isRecord(document)) {
    throw new FormatParseError(
      GENERIC_METRICS_PARSER_VERSION,
      `output is declared as a flat metric object but is ${describeRawValue(document)}`,
    );
  }

  const measurements: RawMeasurementV1[] = [];
  const issues: FormatParseIssueV1[] = [];
  for (const [key, raw] of Object.entries(document)) {
    result.entriesSeen += 1;
    const numeric = typeof raw === "string" ? (raw.trim() === "" ? Number.NaN : Number(raw)) : raw;
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      issues.push({
        rawLocation: `/${key}`,
        reason: "invalid_number",
        detail: `"${key}" is ${describeRawValue(raw)}, not a finite number`,
      });
      continue;
    }
    measurements.push({ key, value: numeric, rawLocation: `/${key}` });
  }
  measurements.sort((left, right) => compareCodepoints(left.key, right.key));
  issues.sort((left, right) => compareCodepoints(left.rawLocation, right.rawLocation));
  result.measurements = measurements;
  result.issues.push(...issues);
  return result;
}

/** Liest `generic-metrics` mit optionalem, deklarativem Feld-Mapping. */
export function parseGenericMetrics(
  text: string,
  mapping: GenericMetricFieldMappingV1 = {},
): FormatParseResultV1 {
  const fields = { ...DEFAULT_GENERIC_METRIC_FIELDS, ...mapping };
  const result = emptyParseResult(GENERIC_METRICS_PARSER_VERSION);
  if ((mapping.shape ?? "entries") === "flat-object") {
    return parseFlatObject(text, result);
  }
  const read = readJsonEntries(
    text,
    GENERIC_METRICS_PARSER_VERSION,
    "metrics",
    mapping.container === undefined ? {} : { containerPath: mapping.container },
  );
  result.issues.push(...read.issues);

  const measurements: RawMeasurementV1[] = [];
  for (const entry of read.entries) {
    result.entriesSeen += 1;
    if (!isRecord(entry.value)) {
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "invalid_entry",
        detail: "entry is not a JSON object",
      });
      continue;
    }
    const rawKey = readPath(entry.value, fields.key);
    const key = typeof rawKey === "string" && rawKey !== "" ? rawKey : undefined;
    if (key === undefined) {
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "missing_required_field",
        detail: `entry lacks a non-empty "${fields.key}"`,
      });
      continue;
    }
    const rawValue = readPath(entry.value, fields.value);
    // WP-184: `Number("")` und `Number("   ")` sind 0 — und 0 ist bei einer
    // Kennzahl kein Platzhalter, sondern eine Aussage („keine Duplikate",
    // „keine Verstoesse"). Ein leerer Wert wurde damit zur ERFUNDENEN
    // Bestnote, ohne `issue` und ohne Vermerk. Ein leerer String ist keine
    // Null, sondern eine fehlende Zahl.
    const numeric =
      typeof rawValue === "string"
        ? rawValue.trim() === ""
          ? Number.NaN
          : Number(rawValue)
        : rawValue;
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "invalid_number",
        detail: `"${fields.value}" of metric "${key}" is ${describeRawValue(rawValue)}, not a finite number`,
      });
      continue;
    }
    const rawUnit = readPath(entry.value, fields.unit);
    const unit = typeof rawUnit === "string" && rawUnit !== "" ? rawUnit : undefined;
    if (unit === undefined && rawUnit !== undefined && rawUnit !== null) {
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "unreadable_field",
        detail: `"${fields.unit}" of metric "${key}" is ${describeRawValue(rawUnit)}, not a non-empty string`,
      });
    }
    const rawPath = readPath(entry.value, fields.path);
    const filePath = typeof rawPath === "string" && rawPath !== "" ? rawPath : undefined;
    if (filePath === undefined && rawPath !== undefined && rawPath !== null) {
      // Der Kennwert verliert damit seinen Dateibezug. Ihn ohne Vermerk als
      // repo-weite Groesse zu fuehren, waere eine andere Aussage als die des
      // Werkzeugs (E4).
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "unreadable_field",
        detail:
          `"${fields.path}" of metric "${key}" is ${describeRawValue(rawPath)}, not a non-empty ` +
          "string; the measurement loses its file scope",
      });
    }

    measurements.push({
      key,
      value: numeric,
      ...(unit === undefined ? {} : { unit }),
      ...(filePath === undefined ? {} : { filePath: normalizeToolPath(filePath) }),
      rawLocation: entry.rawLocation,
    });
  }
  result.measurements = measurements;
  return result;
}
