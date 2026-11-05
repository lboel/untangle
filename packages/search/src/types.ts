/**
 * Paket-eigene Vertraege des Abrufkerns.
 *
 * Grundsatz: Alles, was schon in `@untangle-code/domain` steht
 * (`SearchRequestV1`, `SearchQueryV1`, `ScoreBreakdownV1`, `SearchHitV1`,
 * `SearchResultSetV1`, `SkipLedgerEntryV1`, …), wird NICHT neu definiert,
 * sondern verwendet. Hier stehen nur die Erweiterungen, die der Abrufkern
 * zusaetzlich braucht und die die Werkzeuggrenze aus spec.md §13.1 bewusst
 * nicht kennt:
 *
 * - Suchmodus (semantisch / lexikalisch / Symbolname / hybrid),
 * - die grep-artigen Faehigkeiten (Nutzerwunsch A4),
 * - Ausgabeformate und Sortierung,
 * - der Komplexitaets-Bias (vision.md §1b: Komplexitaet ist ein Blickwinkel
 *   auf dieselbe Frage, kein zweites Werkzeug).
 */
import type {
  IndexFreshnessV1,
  SearchAbstention,
  SearchRequestV1,
  SkipLedgerEntryV1,
  ToolWarningV1,
} from "@untangle-code/domain";

/**
 * Welche unabhaengigen Abruf- und Rankingzweige ausgefuehrt werden.
 *
 * - `hybrid` (Default): dicht + lexikalisch + exakter Symbolname, fusioniert;
 * - `semantic`: nur der dichte Zweig;
 * - `lexical`: nur BM25;
 * - `symbol`: nur der exakte Symbolnamen-Abrufzweig.
 *
 * Lexikalische und Symbolsuche erzeugen kein Queryembedding. Ein
 * eingeschraenkter Modus laesst die anderen Abrufzweige weg; Fusion und
 * Score-Zerlegung bleiben dieselben. Genau deshalb
 * bleibt ein `lexical`-Ergebnis mit einem `hybrid`-Ergebnis vergleichbar
 * lesbar — es fehlen nur Bestandteile, es sind keine anderen.
 */
export const SEARCH_MODES = ["hybrid", "semantic", "lexical", "symbol"] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

// Aus dem Domain re-exportiert, damit Aufrufer nur EIN Paket brauchen.
export { SEARCH_ABSTENTIONS } from "@untangle-code/domain";
export type { SearchAbstention };

/**
 * Ausdrueckliche Bevorzugung einfacher oder komplexer Treffer (vision.md §1b).
 *
 * Default ist `none`. Das ist eine Entscheidung, keine Bequemlichkeit:
 * Komplexitaet DARF die Rangfolge nicht stillschweigend verschieben. Wer sie
 * einbezieht, bekommt dafuer einen sichtbaren `complexity_modifier` in der
 * Score-Zerlegung.
 */
export const COMPLEXITY_BIASES = ["none", "prefer-simple", "prefer-complex"] as const;

export type ComplexityBias = (typeof COMPLEXITY_BIASES)[number];

/** Sortierschluessel der Trefferliste (Nutzerwunsch A4: „Sortierung"). */
export const SEARCH_SORTS = [
  "relevance",
  "path",
  "complexity-desc",
  "complexity-asc",
  "findability-asc",
] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Ausgabeformate (Nutzerwunsch A4: „Text, JSON, JSONL"). */
export const OUTPUT_FORMATS = ["text", "json", "jsonl"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Suchanfrage des Abrufkerns: die Spezifikationsform aus spec.md §13.1 plus
 * die Erweiterungen dieses Pakets. Additiv — jede gueltige `SearchRequestV1`
 * ist auch eine gueltige `UntangleSearchRequestV1`.
 */
export interface UntangleSearchRequestV1 extends SearchRequestV1 {
  mode?: SearchMode;
  /**
   * Verhalten bei unzureichender Evidenz. Fehlt es, gilt `strict` — das ist
   * byte-identisch zum Verhalten vor Welle 14, bis in beide Fingerprints.
   */
  abstention?: SearchAbstention;
  /** Pfadmuster, die AUSGESCHLOSSEN werden (Gegenstueck zu `pathGlob`). */
  pathExclude?: string[];
  /** Chunk-Inhalt mitliefern; Default false (tokenarm fuer Agents). */
  includeContent?: boolean;
  complexityBias?: ComplexityBias;
  sort?: SearchSort;
  /** Nur Treffer mit Findability-Score <= diesem Wert (vision.md §1d). */
  findabilityMaxScore?: number;
  /** Nur Treffer mit Findability-Score >= diesem Wert. */
  findabilityMinScore?: number;
}

/**
 * Normalisierte Zusatzangaben — das Gegenstueck zu `SearchQueryV1` fuer die
 * Felder, die dieses Paket ergaenzt. Alle Felder sind gesetzt (keine
 * `undefined`-Faelle mehr), damit der Ausfuehrungspfad keine Defaults mehr
 * erraten muss.
 */
export interface SearchQueryExtensionsV1 {
  mode: SearchMode;
  abstention: SearchAbstention;
  pathExcludes: string[];
  includeContent: boolean;
  complexityBias: ComplexityBias;
  sort: SearchSort;
}

// ---------------------------------------------------------------------------
// grep-Modus (Nutzerwunsch A4)
// ---------------------------------------------------------------------------

/** Sortierung der grep-Treffer. */
export const GREP_SORTS = ["path", "matches-desc"] as const;

export type GrepSort = (typeof GREP_SORTS)[number];

/**
 * Regex-/Literalsuche ueber den INDEXIERTEN Inhalt.
 *
 * Wichtig fuer das Verstaendnis der Ergebnisse: gesucht wird im Index, nicht
 * auf der Platte. Ein nicht indizierter oder wegen Groesse uebersprungener
 * Inhalt kann hier nicht gefunden werden — deshalb traegt das Ergebnis den
 * Skip-Ledger mit, statt schlicht „nichts gefunden" zu behaupten (E4).
 */
export interface GrepRequestV1 {
  /** Suchmuster; regulaerer Ausdruck, wenn `regex` true ist, sonst Literal. */
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Nur ganze Woerter (Bezeichnergrenzen). */
  wholeWord?: boolean;
  workspaceId?: string;
  repositories?: string[];
  refs?: string[];
  languages?: string[];
  pathGlob?: string[];
  pathExclude?: string[];
  /** Kontextzeilen vor bzw. nach der Trefferzeile. */
  contextLinesBefore?: number;
  contextLinesAfter?: number;
  /** Obergrenze der zurueckgegebenen Treffer insgesamt. */
  maxMatches?: number;
  /** Obergrenze je Datei; verhindert, dass eine Datei die Liste fuellt. */
  maxMatchesPerFile?: number;
  /**
   * Obergrenze der durchsuchten Chunks. Schuetzt vor pathologischen
   * Ausdruecken und riesigen Indizes; Ueberschreitung ist ein sichtbarer
   * Abbruchgrund, kein stilles Kuerzen.
   */
  maxScannedChunks?: number;
  sort?: GrepSort;
}

/** Eine Kontextzeile eines grep-Treffers. */
export interface GrepContextLineV1 {
  /** 1-basierte Zeilennummer in der Datei. */
  line: number;
  text: string;
}

/** Ein einzelner grep-Treffer mit Herkunft und Kontext. */
export interface GrepMatchV1 {
  repoId: string;
  repoLabel: string;
  refId: string;
  refName: string;
  commitSha?: string;
  fileId: string;
  /** „/"-normalisierter, repo-relativer Pfad. */
  filePath: string;
  language: string;
  chunkId: string;
  symbolName?: string;
  /** 1-basierte Zeilennummer in der Datei. */
  line: number;
  /** 1-basierte Spalte des Treffers innerhalb der Zeile (UTF-16-Einheiten). */
  column: number;
  /** Der getroffene Text selbst. */
  matchText: string;
  /** Die vollstaendige Trefferzeile. */
  lineText: string;
  before: GrepContextLineV1[];
  after: GrepContextLineV1[];
}

/** Ergebnis einer grep-Ausfuehrung. */
export interface GrepResultSetV1 {
  schemaVersion: 1;
  indexFreshness?: IndexFreshnessV1;
  pattern: string;
  isRegex: boolean;
  matches: GrepMatchV1[];
  totalMatches: number;
  /** True, wenn eine Grenze griff; dann ist `truncationReason` Pflicht (E4). */
  truncated: boolean;
  truncationReason?: "max_matches" | "max_matches_per_file" | "max_scanned_chunks";
  scannedChunks: number;
  skipped: SkipLedgerEntryV1[];
  warnings: ToolWarningV1[];
}
