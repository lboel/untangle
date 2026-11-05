/**
 * Shared primitive domain types (spec.md §7.1, §7.3, §8.2, §15.2, §16.1).
 */

/**
 * A contiguous source region.
 *
 * Conventions (normative for all producers/consumers):
 * - `startLine`/`endLine` are 1-based and inclusive;
 * - `startByte` is 0-based inclusive, `endByte` is 0-based exclusive
 *   (half-open interval), so `endByte - startByte` is the region length and
 *   two regions are adjacent without gap iff `a.endByte === b.startByte`.
 */
export interface SourceRange {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

/** Parse quality of an analyzed file (spec.md §7.3). */
export type ParseQuality = "complete" | "partial" | "failed";

/** Language support level (spec.md §7.1). */
export type SupportLevel = "deep" | "structural" | "text";

/** Chunk types (spec.md §8.2). */
export const CHUNK_KINDS = [
  "file_preamble",
  "module",
  "class_overview",
  "function",
  "method",
  "constructor",
  "interface",
  "type",
  "enum",
  "property_group",
  "symbol_fragment",
  "comment",
  "configuration",
  "fallback_lines",
  "minified_fragment",
  /**
   * Ein ueberschriftenbewusster Prosa-Abschnitt (vision.md §1c, WP-110).
   *
   * ERGAENZUNG ZU spec.md §8.2 (Untangle-Entscheidung, siehe README
   * "Entscheidungen"): die dortige Liste kennt fuer Prosa nur
   * `fallback_lines` — also genau das willkuerliche Zeilenfenster, das
   * vision.md §1c als „derselbe Qualitaetsverlust wie Zeilenfenster ueber
   * Code" verwirft. Ein Markdown-Abschnitt ist eine semantische Einheit wie
   * eine Funktion und braucht deshalb einen eigenen Namen; ihn `module` oder
   * `comment` zu nennen waere eine Falschaussage ueber den Inhalt.
   */
  "prose_section",
] as const;

export type ChunkKind = (typeof CHUNK_KINDS)[number];

/** Call edge confidence (spec.md §15.2, architecture.md §17.2). */
export type CallConfidence = "local" | "unique" | "ambiguous" | "external" | "unresolved";

/** Scope a retrieval-level metric value refers to (spec.md §10.3 `metrics_scope`). */
export type MetricsScope = "symbol" | "file" | "chunk";

/** Scope a complexity snapshot refers to (spec.md §16.1, architecture.md §10.5). */
export type ComplexityScope = "symbol" | "file" | "repository" | "workspace";
