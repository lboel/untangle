/**
 * Minified-content detection (spec.md §8.3 step 10).
 *
 * Untangle decision (documented in README "Entscheidungen"): minification is
 * detected from the raw text alone, BEFORE looking at parse results, because
 * minified code can parse perfectly well while still being useless for
 * per-symbol AST chunking (a bundled `.min.js` often has its entire runtime
 * as one statement on one line). Detection is a simple, explainable
 * character-shape heuristic — no dependency on a bundler manifest or file
 * name convention, since generated output does not always carry one.
 */

import { DEFAULT_MINIFIED_RULE, isMinifiedShape } from "@untangle-code/domain";
import type { TextFormatKind } from "@untangle-code/domain";

export interface MinifiedDetectionConfig {
  /** Below this file size (bytes), never classify as minified (avoids false positives on tiny files). */
  minSizeBytes: number;
  /** Average bytes-per-line at or above which content is considered minified. */
  avgLineLengthThreshold: number;
  /** A single long line is sufficient only for structured data, not code or prose. */
  maxLineLengthThreshold: number;
}

export const DEFAULT_MINIFIED_DETECTION_CONFIG: MinifiedDetectionConfig = {
  minSizeBytes: 2000,
  avgLineLengthThreshold: 300,
  // Welle 13: von 1000 auf 500 angeglichen. Der Scanner entschied ohnehin bei
  // 500, und im Indexpfad kam dieser Wert nie zum Zug — zwei Schwellen fuer
  // eine Frage waren der Fehler, nicht die eine oder die andere Zahl.
  maxLineLengthThreshold: DEFAULT_MINIFIED_RULE.maxLineLengthThreshold,
};

/**
 * Heuristically classifies `content` as minified. Pure, deterministic,
 * offline — no tokenizer, no bundler introspection.
 */
export function detectMinifiedContent(
  content: string,
  config: MinifiedDetectionConfig = DEFAULT_MINIFIED_DETECTION_CONFIG,
  textFormat?: TextFormatKind | null,
): boolean {
  const size = Buffer.byteLength(content, "utf8");
  if (size < config.minSizeBytes) {
    return false;
  }
  const lines = content.split("\n");
  let maxLineLength = 0;
  for (const line of lines) {
    if (line.length > maxLineLength) {
      maxLineLength = line.length;
    }
  }
  // Entschieden wird in `@untangle-code/domain`: dieselbe Frage darf nicht an
  // zwei Orten mit zwei Schwellen beantwortet werden. Bis Welle 13 galt hier
  // 1000 und im Scanner 500 — welche Regel griff, hing am Aufrufpfad.
  const avgLineLength = content.length / lines.length;
  return isMinifiedShape(
    { maxLineLength, averageLineLength: avgLineLength },
    { textFormat: textFormat ?? null },
    {
      maxLineLengthThreshold: config.maxLineLengthThreshold,
      averageLineLengthThreshold: config.avgLineLengthThreshold,
    },
  );
}
