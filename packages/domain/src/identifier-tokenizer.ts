/**
 * Shared lexical token space for indexed documents, sparse queries and reranking.
 * Changing this algorithm requires rebuilding stored sparse vectors.
 */
export const LEXICAL_TOKENIZER_VERSION = "untangle-identifier-tokenizer-v2" as const;

/** Underscores and combining marks belong to an identifier, punctuation does not. */
const IDENTIFIER_RUN = /[\p{L}\p{N}\p{M}_]+/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const NUMBER = /\p{N}/u;

function isUpper(char: string | undefined): boolean {
  return char !== undefined && char !== char.toLowerCase() && char === char.toUpperCase();
}

function isLower(char: string | undefined): boolean {
  return char !== undefined && char === char.toLowerCase() && char !== char.toUpperCase();
}

/**
 * Splits snake_case, camelCase and acronym boundaries before case folding.
 * Code points preserve supplementary Unicode letters; NFC unifies equivalent spelling.
 * Digits stay attached to their preceding word (`v2Token` -> `v2`, `token`).
 */
export function splitIdentifierRun(run: string): string[] {
  const parts: string[] = [];
  for (const segment of run.normalize("NFC").split(/_+/u)) {
    const characters = [...segment];
    let current = "";
    for (const [index, char] of characters.entries()) {
      const previous = characters[index - 1];
      const next = characters[index + 1];
      const boundary =
        current !== "" &&
        isUpper(char) &&
        (isLower(previous) ||
          (previous !== undefined && NUMBER.test(previous)) ||
          (isUpper(previous) && isLower(next)));
      if (boundary) {
        parts.push(current.toLowerCase());
        current = char;
      } else {
        current += char;
      }
    }
    if (current !== "" && LETTER_OR_NUMBER.test(current)) parts.push(current.toLowerCase());
  }
  return parts;
}

/**
 * A term-frequency bag: full lowercased identifiers plus their component words.
 * Plain words appear once; repeated occurrences and repeated parts retain their count.
 * Query and document tokenization are deliberately identical.
 */
export function tokenizeIdentifiers(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.normalize("NFC").matchAll(IDENTIFIER_RUN)) {
    const run = match[0];
    if (!LETTER_OR_NUMBER.test(run)) continue;
    const whole = run.toLowerCase();
    const parts = splitIdentifierRun(run);
    tokens.push(whole);
    if (parts.length !== 1 || parts[0] !== whole) tokens.push(...parts);
  }
  return tokens;
}

/** Component words alone, used when matching query parts against symbol names. */
export function identifierParts(text: string): string[] {
  const parts: string[] = [];
  for (const match of text.normalize("NFC").matchAll(IDENTIFIER_RUN)) {
    parts.push(...splitIdentifierRun(match[0]));
  }
  return parts;
}
