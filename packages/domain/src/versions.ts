/**
 * Version constants (architecture.md §2.3, §26.2; docs/BUILD_PLAN.md §3).
 *
 * Every produced data record carries these identifiers so that a new algorithm
 * never silently changes the meaning of stored values. All constants are
 * exported with literal types so downstream contracts can reference them as
 * `typeof COGNITIVE_ALGORITHM_ID` etc.
 */

/** Integer version of all `*V1` domain result schemas (architecture.md §26.2). */
export const SCHEMA_VERSION = 1 as const;

/** Integer version of the MCP tool schema (spec.md §2.4). */
export const TOOL_SCHEMA_VERSION = 1 as const;

/** Integer version of the MCP result schema (spec.md §2.4). */
export const RESULT_SCHEMA_VERSION = 1 as const;

/** Overall analyzer pipeline version stamped on produced records (architecture.md §2.3). */
export const ANALYZER_VERSION = "untangle-analyzer-v1" as const;

/**
 * Parser/adapter output version (architecture.md §2.3) — der tree-sitter-Weg
 * und jeder handgeschriebene Adapter dieses Projekts.
 */
export const PARSER_VERSION = "untangle-parser-v1" as const;

/**
 * Parserversion der Sprachen, die ueber das ast-grep-Backend laufen (WP-220).
 *
 * WARUM EINE EIGENE: ein anderes Backend erzeugt eine andere AST-Form, und
 * daran haengen Chunk-IDs, `astHash` und `tokenFingerprint`. Das ist zulaessig
 * — aber es MUSS sichtbar sein, sonst liefern die inhaltsadressierten Caches
 * aus WP-100 (`analysis-cache-key.ts`) nach einem Backendwechsel
 * stillschweigend Werte aus der alten Form. Genau diese Art von stillem
 * Falschtreffer verbietet E4.
 *
 * WARUM NICHT EINFACH `PARSER_VERSION` HOCHZAEHLEN: fuer TypeScript,
 * JavaScript, TSX und JSX hat sich NICHTS geaendert (dieselbe Grammatik,
 * derselbe Walk, dieselben Golden-Tests). Ein globaler Sprung wuerde jeden
 * bestehenden Index ohne Grund entwerten.
 */
export const ASTGREP_PARSER_VERSION = "untangle-parser-astgrep-v1" as const;

/** SFC block extraction plus original-source script ASTs; separate from plain TS/JS. */
export const VUE_SFC_PARSER_VERSION = "untangle-parser-vue-sfc-v1" as const;

/**
 * Die Backends, ueber die dieses Projekt Quelltext parst.
 *
 * "handwritten" meint einen Parser dieses Repos ohne fremde Grammatik
 * (Prosa, strukturierter Text) — er kann nicht fehlen, weil er
 * mitgeliefert ist. "tree-sitter" und "ast-grep" laden je eine NATIVE
 * Grammatik, die auf einer Maschine fehlen kann; nur bei diesen beiden ist
 * die Frage "ist die Sprache hier wirklich verfuegbar?" ueberhaupt sinnvoll.
 */
export const PARSER_BACKENDS = ["tree-sitter", "ast-grep", "handwritten", "vue-sfc"] as const;

export type ParserBackend = (typeof PARSER_BACKENDS)[number];

/**
 * Welche Sprache ueber welches Backend laeuft — die einzige Stelle, an der
 * diese Zuordnung steht.
 *
 * Sie gehoert hierher und nicht in die Parser-Registry, weil sie eine
 * VERSIONSAUSSAGE ist: `@untangle-code/core` baut daraus Cache-Schluessel und
 * stempelt sie auf jeden Chunk, ohne den Adapter danach fragen zu koennen (der
 * `LanguageAdapter`-Vertrag kennt keine Version und soll auch keine kennen).
 *
 * WARUM HIER ALLE ACHTZEHN SPRACHEN STEHEN und nicht nur die elf mit eigener
 * Version: eine Tabelle, die nur die Ausnahmen kennt, kann nicht sagen, ob
 * eine Sprache FEHLT. Vollstaendig kann sie es — und `apps/cli` prueft in
 * `commands/doctor.languages.test.ts` gegen die WIRKLICH registrierten
 * Adapter, dass hier keine Sprache steht, die es nicht gibt, und keine fehlt,
 * die es gibt. Ohne diese Pruefung waere die Tabelle genau die Sorte
 * Faehigkeitsbehauptung, die still veraltet (E4).
 *
 * DIESE TABELLE IST DIE QUELLE der Parserversion (siehe
 * {@link parserVersionForLanguage}): eine ast-grep-Sprache bekommt
 * {@link ASTGREP_PARSER_VERSION}, jede andere {@link PARSER_VERSION}. Zwei
 * getrennte Tabellen zu pflegen hiesse, ihnen das Auseinanderlaufen zu
 * erlauben.
 */
const PARSER_BACKEND_BY_LANGUAGE: Readonly<Record<string, ParserBackend>> = {
  // tree-sitter mit Cursor-Walk: 3,74x schneller als ast-grep (gemessen,
  // `parser-registry/src/languages/astgrep-backend/README.md`).
  typescript: "tree-sitter",
  javascript: "tree-sitter",
  tsx: "tree-sitter",
  jsx: "tree-sitter",
  vue: "vue-sfc",
  // Eigene Parser dieses Repos — ohne fremde Grammatik, also ohne Prebuild,
  // der fehlen koennte.
  markdown: "handwritten",
  "structured-text": "handwritten",
  // WP-220: Go und Rust ueber ast-grep.
  go: "ast-grep",
  rust: "ast-grep",
  // WP-239: Python ist von einem handgeschriebenen Parser auf ast-grep
  // umgestellt. Der Eintrag MUSS mitwandern — sonst bekaemen Chunks aus der
  // neuen AST-Form den Cache-Schluessel der alten (E4).
  python: "ast-grep",
  // WP-86: neun weitere Sprachen ueber dasselbe Backend. Sie MUESSEN hier
  // stehen — eine ast-grep-Sprache ohne Eintrag bekaeme `PARSER_VERSION` und
  // damit den Cache-Schluessel des tree-sitter-Weges, obwohl ihre AST-Form
  // eine andere ist.
  java: "ast-grep",
  csharp: "ast-grep",
  ruby: "ast-grep",
  php: "ast-grep",
  kotlin: "ast-grep",
  c: "ast-grep",
  cpp: "ast-grep",
  swift: "ast-grep",
  shell: "ast-grep",
};

/**
 * Das Backend einer Sprache, oder `null` fuer eine Sprache, die dieses
 * Projekt nicht kennt.
 *
 * `null` und nicht "handwritten": eine unbekannte Sprache hat KEIN Backend,
 * und sie so zu nennen, als liefe sie ueber den mitgelieferten Parser, waere
 * eine Behauptung ueber etwas, das es nicht gibt.
 */
export function parserBackendForLanguage(languageId: string): ParserBackend | null {
  return PARSER_BACKEND_BY_LANGUAGE[languageId] ?? null;
}

/** Alle Sprachen dieser Tabelle, in der Reihenfolge ihrer Eintragung. */
export function knownParserLanguages(): readonly string[] {
  return Object.keys(PARSER_BACKEND_BY_LANGUAGE);
}

/**
 * Die `parser_version` fuer eine Sprache. Unbekannte Sprachen bekommen
 * {@link PARSER_VERSION} — das ist die richtige Vorgabe, weil jede Sprache
 * ohne eigenen Eintrag ueber den urspruenglichen Weg laeuft.
 */
export function parserVersionForLanguage(languageId: string): string {
  if (languageId === "vue") return VUE_SFC_PARSER_VERSION;
  return parserBackendForLanguage(languageId) === "ast-grep"
    ? ASTGREP_PARSER_VERSION
    : PARSER_VERSION;
}

/** Chunker strategy version; part of chunk identity (spec.md §5.6). */
// v2 preserves AST symbol identity in formatted code with isolated long lines.
// Old minified chunks must not be reused from the analysis cache.
export const CHUNKER_VERSION = "untangle-chunker-v2" as const;

/** Metrics family version stamped on complexity snapshots (architecture.md §2.3). */
export const METRICS_VERSION = "untangle-metrics-v1" as const;

/** Cognitive complexity algorithm id (spec.md §16.4). */
export const COGNITIVE_ALGORITHM_ID = "untangle-cognitive-v1" as const;

/** Risk score algorithm id (spec.md §17.6). */
export const RISK_ALGORITHM_ID = "untangle-risk-v1" as const;

/** Portfolio analyzer version stamped on repository profiles (portfolio.md §7.2). */
export const PORTFOLIO_ANALYZER_VERSION = "untangle-portfolio-v1" as const;

/** Portfolio manifest detector family version (portfolio.md §6.3). */
export const PORTFOLIO_DETECTOR_VERSION = "portfolio-detect-v1" as const;

/** Versioned technology alias table id (portfolio.md §5). */
export const PORTFOLIO_ALIAS_TABLE_ID = "portfolio-alias-v1" as const;

/** Versioned problem-domain mapping table id (portfolio.md §7.1). */
export const PORTFOLIO_DOMAIN_MAP_ID = "portfolio-domain-map-v1" as const;

/** Archetype classifier version (portfolio.md §7.5). */
export const ARCHETYPE_CLASSIFIER_VERSION = "untangle-archetype-v1" as const;

/** Tech radar ruleset version (portfolio.md §7.8). */
export const RADAR_VERSION = "untangle-radar-v1" as const;

/** Blueprint advisor version (portfolio.md §7.6, §7.7). */
export const BLUEPRINT_ADVISOR_VERSION = "untangle-blueprint-v1" as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
export type CognitiveAlgorithmId = typeof COGNITIVE_ALGORITHM_ID;
export type RiskAlgorithmId = typeof RISK_ALGORITHM_ID;
export type ArchetypeClassifierVersion = typeof ARCHETYPE_CLASSIFIER_VERSION;
export type RadarVersion = typeof RADAR_VERSION;
export type BlueprintAdvisorVersion = typeof BLUEPRINT_ADVISOR_VERSION;

// ---------------------------------------------------------------------------
// Abrufkern (Welle 3): Graphen, Suche, Findability, Extensions
// ---------------------------------------------------------------------------

/** Version des Dateigraph-Aufbaus; steht auf jedem `FileEdgeV1` (spec.md §14). */
export const FILE_GRAPH_VERSION = "untangle-file-graph-v1" as const;

/** Version des Symbolgraph-Aufbaus; steht auf jedem `SymbolEdgeV1` (spec.md §15). */
export const SYMBOL_GRAPH_VERSION = "untangle-symbol-graph-v1" as const;

/**
 * Version der Rangfolge-/Boost-Berechnung (spec.md §13.3). Aendert sich die
 * Score-Zusammensetzung, aendert sich diese Kennung — sonst waeren zwei
 * Rangfolgen unbemerkt unvergleichbar.
 */
export const RANKER_VERSION = "untangle-ranker-v2" as const;

/**
 * Version der Findability-Heuristik (vision.md §1d, WP-120/121). Teil der
 * Findability-ID: ein neuer Algorithmus erzeugt neue Datensaetze statt alte
 * stillschweigend umzudeuten.
 */
export const FINDABILITY_ALGORITHM_ID = "untangle-findability-v1" as const;

/**
 * Version der task-basierten Suchaufwand-Messung (product.md: Dynamic Product
 * Complexity). Sie ist bewusst getrennt von `FINDABILITY_ALGORITHM_ID`:
 * Findability sondiert ein bekanntes Symbol synthetisch, waehrend diese
 * Messfamilie echte, mehrstufige Agenten-Suchauftraege beobachtet.
 */
export const DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID =
  "untangle-dynamic-search-complexity-v1" as const;

/** Version der Severity-Abbildung externer Befunde (extensions.md §7.3). */
export const SEVERITY_MAP_VERSION = "untangle-severity-map-v1" as const;

export type FileGraphVersion = typeof FILE_GRAPH_VERSION;
export type SymbolGraphVersion = typeof SYMBOL_GRAPH_VERSION;
export type RankerVersion = typeof RANKER_VERSION;
export type FindabilityAlgorithmId = typeof FINDABILITY_ALGORITHM_ID;
export type DynamicSearchComplexityAlgorithmId = typeof DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID;
export type SeverityMapVersion = typeof SEVERITY_MAP_VERSION;
