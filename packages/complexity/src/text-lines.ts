/**
 * Shared, pure line/comment classification used by both StructuralCalculator
 * and TextualCalculator (spec.md §16.5, §16.6). Not a calculator itself —
 * just the byte/line bookkeeping both of them need, factored out so neither
 * calculator duplicates it.
 */
import type { ComplexityFacts, SourceRange } from "@untangle-code/domain";

import { sliceByRange, splitLines } from "./scope.js";

/** Leading markers recognized as "doc comment" (Untangle decision — see README "Entscheidungen" #3). */
const DOC_COMMENT_MARKERS = ["/**", "///", '"""', "'''", "##!", "//!", "/// "];

function isDocCommentText(commentText: string): boolean {
  const trimmed = commentText.trimStart();
  return DOC_COMMENT_MARKERS.some((marker) => trimmed.startsWith(marker));
}

export interface LineClassification {
  /** Physical line count of the scope (`endLine - startLine + 1`, or 0 for an empty range). */
  physicalLoc: number;
  /** Set of absolute physical line numbers touched by any comment range. */
  commentLines: Set<number>;
  /** Subset of `commentLines` whose owning comment looks like a doc comment. */
  docLines: Set<number>;
  /** Absolute line numbers that are blank (whitespace-only) and not comment lines. */
  blankLines: Set<number>;
}

/**
 * Classifies every physical line of `scopeRange` within `sourceText` as
 * blank, comment, and/or doc-comment. `comments` is expected already
 * narrowed to the scope (e.g. via `selectSymbolFacts`).
 *
 * Documented simplification (README "Entscheidungen" #3): a line touched by
 * *any part* of a comment range counts as a comment line in full, even for a
 * trailing `code(); // comment` line — `ComplexityFacts` gives byte ranges,
 * not a column split between code and comment, so a line can't be split
 * further without raw-text heuristics beyond this package's scope.
 */
export function classifyLines(
  sourceText: string,
  scopeRange: SourceRange,
  comments: readonly SourceRange[],
): LineClassification {
  const scopeText = sliceByRange(sourceText, scopeRange);
  const lines = splitLines(scopeText);
  // A trailing newline at the end of the range produces one extra empty
  // element from split("\n"); drop it so physicalLoc reflects real lines.
  const physicalLines =
    lines.length > 1 && lines[lines.length - 1] === "" && scopeText.endsWith("\n")
      ? lines.slice(0, -1)
      : lines;
  const physicalLoc = physicalLines.length;

  const commentLines = new Set<number>();
  const docLines = new Set<number>();
  for (const range of comments) {
    const isDoc = isDocCommentText(sliceByRange(sourceText, range));
    for (let line = range.startLine; line <= range.endLine; line++) {
      commentLines.add(line);
      if (isDoc) docLines.add(line);
    }
  }

  const blankLines = new Set<number>();
  for (let i = 0; i < physicalLines.length; i++) {
    const lineNo = scopeRange.startLine + i;
    const text = physicalLines[i] ?? "";
    if (text.trim().length === 0 && !commentLines.has(lineNo)) {
      blankLines.add(lineNo);
    }
  }

  return { physicalLoc, commentLines, docLines, blankLines };
}

/** Re-exported for calculators that need to iterate raw scope lines directly. */
export function scopeLines(sourceText: string, scopeRange: SourceRange): string[] {
  const scopeText = sliceByRange(sourceText, scopeRange);
  const lines = splitLines(scopeText);
  return lines.length > 1 && lines[lines.length - 1] === "" && scopeText.endsWith("\n")
    ? lines.slice(0, -1)
    : lines;
}

/** Convenience: comments already narrowed to one scope (see `selectSymbolFacts`). */
export function commentsOf(facts: ComplexityFacts): readonly SourceRange[] {
  return facts.comments;
}
