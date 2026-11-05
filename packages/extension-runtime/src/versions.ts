/**
 * Versionskennungen der Extension-Laufzeit (architecture.md §2.3).
 *
 * Untangle kennt AUSGABEFORMATE, nicht Werkzeuge (extensions.md §17, X9).
 * Deshalb ist hier je FORMAT eine Parserversion vergeben und nicht je
 * Werkzeug eine Adapterversion. Aendert sich die Auslegung eines Formats,
 * aendert sich die Kennung — sonst waeren zwei Befundmengen unbemerkt
 * unvergleichbar.
 */
import type { ExtensionOutputFormat } from "@untangle-code/domain";

/** Version der Laufzeit selbst (Lebenszyklus, Budgets, Normalisierung). */
export const EXTENSION_RUNTIME_VERSION = "untangle-extension-runtime-v1" as const;

/** Version des SARIF-2.1.0-Parsers. */
export const SARIF_PARSER_VERSION = "untangle-format-sarif-v1" as const;

/**
 * Version des JUnit-XML-Parsers.
 *
 * v2: die Suche nach Suiten laeuft rekursiv ueber BEIDE suitetragenden
 * Elemente (`testsuites` wie `testsuite`) und liest Testfaelle auch direkt am
 * Containerelement. Ein Bericht mit `testsuites` unterhalb der Wurzel liefert
 * damit Befunde, die v1 stillschweigend verlor — zwei Befundmengen aus v1 und
 * v2 sind deshalb nicht vergleichbar.
 */
export const JUNIT_XML_PARSER_VERSION = "untangle-format-junit-xml-v2" as const;

/** Version des `generic-findings`-Parsers (JSON Lines). */
export const GENERIC_FINDINGS_PARSER_VERSION = "untangle-format-generic-findings-v1" as const;

/** Version des `generic-metrics`-Parsers (JSON Lines). */
export const GENERIC_METRICS_PARSER_VERSION = "untangle-format-generic-metrics-v1" as const;

export type ExtensionRuntimeVersion = typeof EXTENSION_RUNTIME_VERSION;

/** Formatkennung → Parserversion. Vollstaendig ueber die geschlossene Menge. */
export const FORMAT_PARSER_VERSIONS: Readonly<Record<ExtensionOutputFormat, string>> = {
  sarif: SARIF_PARSER_VERSION,
  "junit-xml": JUNIT_XML_PARSER_VERSION,
  "generic-findings": GENERIC_FINDINGS_PARSER_VERSION,
  "generic-metrics": GENERIC_METRICS_PARSER_VERSION,
};

/** Parserversion eines Formats; total ueber {@link FORMAT_PARSER_VERSIONS}. */
export function formatParserVersion(format: ExtensionOutputFormat): string {
  return FORMAT_PARSER_VERSIONS[format];
}
