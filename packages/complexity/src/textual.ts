/**
 * TextualCalculator (spec.md §16.6).
 *
 * `identifier_entropy`: Shannon entropy in bits computed over the multiset of
 * *characters* across all identifier occurrences in scope (not per-token
 * entropy over distinct identifier names) — Untangle decision, documented in
 * README "Entscheidungen" #6: character-level entropy reacts to naming style
 * (e.g. heavy abbreviation vs. verbose camelCase) rather than being dominated
 * by how many times short common names like `i`/`x` repeat.
 *
 * `magic_literal_count`: counts `number`/`string` literals only (booleans,
 * `null`, regexes, templates are never "magic" by definition here), excluding
 * a small, documented allowlist (see `EXCLUDED_NUMERIC_LITERALS`/
 * `EXCLUDED_STRING_LITERALS` below).
 *
 * `todo_count`/`fixme_count`/`hack_count`: case-insensitive whole-word
 * occurrence counts of `TODO`/`FIXME`/`HACK` inside comment text, sliced from
 * `sourceText` via each comment's byte range.
 */
import type { ComplexityFacts, SourceRange } from "@untangle-code/domain";

import { frequenciesOf, shannonEntropy } from "./entropy.js";
import { sliceByRange } from "./scope.js";
import { classifyLines, scopeLines } from "./text-lines.js";
import type { MetricsResult } from "./types.js";

const EXCLUDED_NUMERIC_LITERALS = new Set(["0", "1", "-1"]);
const EXCLUDED_STRING_LITERALS = new Set(['""', "''", "``", ""]);

function isMagicLiteral(literalKind: string, raw: string): boolean {
  const trimmed = raw.trim();
  if (literalKind === "number") return !EXCLUDED_NUMERIC_LITERALS.has(trimmed);
  if (literalKind === "string") return !EXCLUDED_STRING_LITERALS.has(trimmed);
  return false;
}

function countWholeWordOccurrences(text: string, word: string): number {
  const pattern = new RegExp(`\\b${word}\\b`, "gi");
  return text.match(pattern)?.length ?? 0;
}

function codepointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * @param facts Facts already narrowed to the target scope.
 * @param sourceText Full original file content (UTF-8).
 * @param scopeRange The scope's own range.
 */
export function computeTextual(
  facts: ComplexityFacts,
  sourceText: string,
  scopeRange: SourceRange,
  algorithmVersion = "untangle-textual-v1",
): MetricsResult {
  const scopeText = sliceByRange(sourceText, scopeRange);
  const { physicalLoc, commentLines, docLines } = classifyLines(
    sourceText,
    scopeRange,
    facts.comments,
  );
  const lines = scopeLines(sourceText, scopeRange);

  const lineLengths = lines.map(codepointLength);
  const avgLineLength =
    lineLengths.length > 0 ? lineLengths.reduce((s, v) => s + v, 0) / lineLengths.length : 0;
  const maxLineLength = lineLengths.length > 0 ? Math.max(...lineLengths) : 0;

  const identifierNames = facts.identifiers.map((id) => id.name);
  const uniqueIdentifiers = new Set(identifierNames);
  const identifierLengths = identifierNames.map(codepointLength);
  const avgIdentifierLength =
    identifierLengths.length > 0
      ? identifierLengths.reduce((s, v) => s + v, 0) / identifierLengths.length
      : 0;
  const identifierCharFrequencies = frequenciesOf(identifierNames.join("").split(""), (ch) => ch);

  const magicLiteralCount = facts.literals.filter((lit) =>
    isMagicLiteral(lit.literalKind, lit.raw),
  ).length;

  let todoCount = 0;
  let fixmeCount = 0;
  let hackCount = 0;
  for (const commentRange of facts.comments) {
    const text = sliceByRange(sourceText, commentRange);
    todoCount += countWholeWordOccurrences(text, "todo");
    fixmeCount += countWholeWordOccurrences(text, "fixme");
    hackCount += countWholeWordOccurrences(text, "hack");
  }

  const operatorTexts = facts.operators.map((t) => t.text);
  const operandTexts = facts.operands.map((t) => t.text);

  const metrics: Record<string, number> = {
    character_count: codepointLength(scopeText),
    byte_count: scopeRange.endByte - scopeRange.startByte,
    token_count: operatorTexts.length + operandTexts.length,
    avg_line_length: avgLineLength,
    max_line_length: maxLineLength,
    comment_ratio: physicalLoc > 0 ? commentLines.size / physicalLoc : 0,
    doc_ratio: physicalLoc > 0 ? docLines.size / physicalLoc : 0,
    identifier_count: identifierNames.length,
    unique_identifier_count: uniqueIdentifiers.size,
    avg_identifier_length: avgIdentifierLength,
    identifier_entropy: shannonEntropy(identifierCharFrequencies.values()),
    magic_literal_count: magicLiteralCount,
    todo_count: todoCount,
    fixme_count: fixmeCount,
    hack_count: hackCount,
    operator_count: operatorTexts.length,
    operand_count: operandTexts.length,
    unique_operator_count: new Set(operatorTexts).size,
    unique_operand_count: new Set(operandTexts).size,
  };

  return { metrics, algorithmVersion };
}
