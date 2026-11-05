/**
 * Signature text normalization for the JS/TS grammar family.
 *
 * Normative requirement (WP-06 task, spec.md §5.5): `normalizedSignature`
 * feeds `buildSymbolId`, so it MUST be stable across:
 *
 * 1. Whitespace — any run of spaces/tabs/newlines collapses to a single
 *    space; spacing around `,`, `:`, `(`, `)`, `<`, `>`, `?:` is
 *    canonicalized rather than preserved verbatim.
 * 2. Default values — `= <expr>` parameter/type-parameter initializers are
 *    STRIPPED. Rationale: giving a parameter a default value is (mostly) a
 *    call-site convenience, not a new overload; keeping it in the identity
 *    signature would needlessly change a symbol's id on a body-only-feeling
 *    edit. The optional marker (see next point) already captures "callers
 *    may omit this argument".
 * 3. Optional markers — TypeScript's trailing `?` on a parameter name is
 *    KEPT and canonicalized to sit directly against the following `:`
 *    (`a ?:string` and `a?: string` both become `a?: string`) because it
 *    changes the call contract independent of any default value.
 * 4. Type annotations — kept verbatim (modulo the same whitespace rules)
 *    because they are part of the observable contract.
 *
 * Known limitation (documented, not a defect): default-value stripping and
 * top-level-comma splitting use a bracket-DEPTH scanner, not a full
 * expression parser. A `<` used as a less-than operator inside a default
 * expression (e.g. `(a = b < c ? 1 : 2)`) is misread as a generic open
 * bracket and can throw off depth tracking for the rest of that one
 * parameter. This is vanishingly rare in default-value position and is
 * accepted as a WP-06 scoping decision (see README "Entscheidungen").
 */

const OPEN_BRACKETS = new Set(["(", "[", "{", "<"]);
const CLOSE_BRACKETS = new Set([")", "]", "}", ">"]);

/** Collapses whitespace and canonicalizes spacing around common punctuation. */
export function normalizeSpacing(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*\?\s*:/g, "?:")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/<\s+/g, "<")
    .replace(/\s+>/g, ">")
    .replace(/\.\.\.\s+/g, "...")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Splits `content` on top-level occurrences of `separator` (depth 0 with
 * respect to `(`, `[`, `{`, `<`/`>`). Used to split parameter lists and
 * type-parameter lists without being confused by nested generics/objects.
 */
export function splitTopLevel(content: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of content) {
    if (OPEN_BRACKETS.has(ch)) depth += 1;
    else if (CLOSE_BRACKETS.has(ch)) depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Index of the top-level `=` that introduces a default value, or -1.
 * Excludes `=>`, `==`, `===`, `!=`, `!==`, `<=`, `>=`.
 */
function findTopLevelDefaultEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (OPEN_BRACKETS.has(ch)) {
      depth += 1;
      continue;
    }
    if (CLOSE_BRACKETS.has(ch)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "=" && depth === 0) {
      const prev = i > 0 ? text[i - 1] : "";
      const next = i + 1 < text.length ? text[i + 1] : "";
      const isCompoundOperator =
        next === "=" || next === ">" || prev === "!" || prev === "<" || prev === ">";
      if (!isCompoundOperator) return i;
    }
  }
  return -1;
}

/** Strips a single parameter's/type-parameter's default value (`= <expr>`), keeping any `?`/type annotation before it. */
export function stripDefaultValue(entry: string): string {
  const eqIndex = findTopLevelDefaultEquals(entry);
  return eqIndex === -1 ? entry : entry.slice(0, eqIndex).trimEnd();
}

/**
 * Normalizes a formal-parameter-list text (including its outer parens),
 * e.g. `(a: number = 1, b ?: string)` -> `(a: number, b?: string)`.
 */
export function normalizeParameterList(paramsText: string): string {
  const trimmed = paramsText.trim();
  const hasParens = trimmed.startsWith("(") && trimmed.endsWith(")");
  const inner = hasParens ? trimmed.slice(1, -1) : trimmed;
  const entries = splitTopLevel(inner, ",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const normalizedEntries = entries.map((entry) => normalizeSpacing(stripDefaultValue(entry)));
  return `(${normalizedEntries.join(", ")})`;
}

/**
 * Normalizes a type-parameter list text (including its outer `<>`), e.g.
 * `<T extends object = {}, U>` -> `<T extends object, U>`.
 */
export function normalizeTypeParameterList(typeParamsText: string | undefined): string {
  if (typeParamsText === undefined || typeParamsText.trim().length === 0) return "";
  const trimmed = typeParamsText.trim();
  const hasBrackets = trimmed.startsWith("<") && trimmed.endsWith(">");
  const inner = hasBrackets ? trimmed.slice(1, -1) : trimmed;
  const entries = splitTopLevel(inner, ",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return "";
  const normalizedEntries = entries.map((entry) => normalizeSpacing(stripDefaultValue(entry)));
  return `<${normalizedEntries.join(", ")}>`;
}

/** Normalizes a return-type annotation text (e.g. ` : Promise<void> ` -> `: Promise<void>`). */
export function normalizeReturnType(returnTypeText: string | undefined): string {
  if (returnTypeText === undefined || returnTypeText.trim().length === 0) return "";
  const normalized = normalizeSpacing(returnTypeText);
  return normalized.startsWith(":") ? normalized : `: ${normalized}`;
}

/** Normalizes an arbitrary header text (class/interface/type/enum declarations). */
export function normalizeHeaderText(headerText: string): string {
  return normalizeSpacing(headerText.replace(/;\s*$/, ""));
}
