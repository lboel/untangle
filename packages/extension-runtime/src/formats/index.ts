/**
 * Die vier Formatparser hinter EINER Auswahlfunktion.
 *
 * `parseOutputFormat` ist total ueber `ExtensionOutputFormat` — die
 * geschlossene Menge aus `@untangle-code/domain`. Ein neues Werkzeug fuehrt
 * NIE zu einem neuen Zweig hier; ein neues FORMAT schon (X9).
 */
import type { ExtensionOutputFormat } from "@untangle-code/domain";

import type { GenericFindingFieldMappingV1 } from "./generic-findings.js";
import { parseGenericFindings } from "./generic-findings.js";
import type { GenericMetricFieldMappingV1 } from "./generic-metrics.js";
import { parseGenericMetrics } from "./generic-metrics.js";
import { parseJUnitXml } from "./junit-xml.js";
import { parseSarif } from "./sarif.js";
import type { FormatParseResultV1 } from "./types.js";

/** Deklaratives Feld-Mapping der `generic-*`-Formate; sonst ohne Wirkung. */
export interface OutputFormatOptions {
  findingFields?: GenericFindingFieldMappingV1;
  metricFields?: GenericMetricFieldMappingV1;
}

/**
 * Liest eine Werkzeugausgabe im angegebenen Format.
 *
 * @throws {FormatParseError} wenn die GESAMTE Ausgabe unbrauchbar ist; die
 * Laufzeit uebersetzt das in `EXTENSION_FAILED` /
 * `details.reason = "output_parse_failed"` (extensions.md §6.5).
 */
export function parseOutputFormat(
  format: ExtensionOutputFormat,
  text: string,
  options: OutputFormatOptions = {},
): FormatParseResultV1 {
  switch (format) {
    case "sarif":
      return parseSarif(text);
    case "junit-xml":
      return parseJUnitXml(text);
    case "generic-findings":
      return parseGenericFindings(text, options.findingFields ?? {});
    case "generic-metrics":
      return parseGenericMetrics(text, options.metricFields ?? {});
  }
}
