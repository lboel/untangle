/**
 * Signature text normalization for Python (spec.md §5.5).
 *
 * `normalizedSignature` feeds `buildSymbolId` and MUST be stable across
 * formatting-only edits. Rules (documented WP-09 decision — Python has no
 * `tree-sitter-python` grammar to reuse `languages/shared/signature.ts`'s
 * `<`/`>`-as-bracket assumption from, which is wrong for Python anyway:
 * `<`/`>` are ONLY comparison operators here, never generic brackets):
 *
 * 1. **Whitespace**: any run of spaces/tabs/newlines collapses to a single
 *    space; spacing around `,`, `:` (annotation colon) and `=` (only for
 *    an ANNOTATED parameter's default, per PEP 8 — `x: int = 1`, not
 *    `x=1`) is canonicalized.
 * 2. **Default values** (`= <expr>`) are STRIPPED from the identity
 *    signature, exactly like the TS/JS adapters: a default value is a
 *    call-site convenience, not a change to the parameter's name,
 *    position, or `*`/`**` role — keeping it would change a symbol's id on
 *    a body-only-feeling edit (`def f(a=1)` -> `def f(a=2)` should not look
 *    like a new symbol). Unlike TypeScript, Python has no separate
 *    "optional marker" syntax (`?`) that would otherwise carry the
 *    "caller may omit this" information forward — that information is
 *    simply not part of the normalized identity for Python, a documented
 *    (not accidental) asymmetry with the TS/JS adapters.
 * 3. **Type annotations** (`: <type>`) are kept verbatim (modulo whitespace
 *    rules) — they are part of the observable call contract.
 * 4. **`*args` / `**kwargs` / bare `*` (keyword-only marker) / `/`
 *    (positional-only marker, PEP 570)**: their `*`/`**`/`/` marker is kept
 *    exactly as written (it changes the call contract), only a following
 *    default (impossible for `*args`/`**kwargs`/markers, but harmless to
 *    guard) or its annotation spacing is normalized.
 * 5. **Return type** (`-> <type>`) is kept verbatim (modulo whitespace),
 *    canonicalized to always have exactly one space on each side of `->`.
 *
 * Known limitation (documented, not a defect, mirroring the TS/JS
 * adapters' own documented limitation): default-value stripping uses a
 * bracket-DEPTH scanner over `( [ {` (never `<`/`>` — see above), not a
 * full expression parser. A default expression containing an unbalanced
 * string literal with a comma/`=` inside is not specially protected either
 * (rare enough in default-value position to accept as a scoping decision).
 */

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

/** Collapses whitespace runs to single spaces and trims. */
export function normalizeSpacing(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Splits `content` on top-level `,` (depth 0 w.r.t. `( [ {`). */
export function splitTopLevelComma(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inString: string | null = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i] as string;
    if (inString !== null) {
      current += ch;
      if (ch === "\\") {
        i += 1;
        if (i < content.length) current += content[i];
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
      continue;
    }
    if (OPEN_BRACKETS.has(ch)) depth += 1;
    else if (CLOSE_BRACKETS.has(ch)) depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Index of the top-level `=` introducing a default value, or -1. Excludes `==`, `!=`, `<=`, `>=`, `:=`. */
function findTopLevelDefaultEquals(text: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString !== null) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
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
        next === "=" ||
        prev === "=" ||
        prev === "!" ||
        prev === "<" ||
        prev === ">" ||
        prev === ":";
      if (!isCompoundOperator) return i;
    }
  }
  return -1;
}

/** Strips one parameter entry's default value (`= <expr>`), keeping any annotation before it. */
export function stripDefaultValue(entry: string): string {
  const eqIndex = findTopLevelDefaultEquals(entry);
  return eqIndex === -1 ? entry : entry.slice(0, eqIndex).trimEnd();
}

/** Canonicalizes one parameter entry's internal spacing: `a :int=1` -> `a: int`. */
function normalizeParamEntry(entry: string): string {
  const stripped = stripDefaultValue(entry);
  const colonIndex = topLevelColonIndex(stripped);
  if (colonIndex === -1) return normalizeSpacing(stripped);
  const name = normalizeSpacing(stripped.slice(0, colonIndex));
  const annotation = normalizeSpacing(stripped.slice(colonIndex + 1));
  return `${name}: ${annotation}`;
}

function topLevelColonIndex(text: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString !== null) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (OPEN_BRACKETS.has(ch)) depth += 1;
    else if (CLOSE_BRACKETS.has(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

/** Normalizes a parameter-list text INCLUDING its outer parens, e.g. `( a:int=1, *, b = 2 )` -> `(a: int, *, b)`. */
export function normalizeParameterList(paramsText: string): string {
  const trimmed = paramsText.trim();
  const hasParens = trimmed.startsWith("(") && trimmed.endsWith(")");
  const inner = hasParens ? trimmed.slice(1, -1) : trimmed;
  const entries = splitTopLevelComma(inner)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const normalizedEntries = entries.map(normalizeParamEntry);
  return `(${normalizedEntries.join(", ")})`;
}

/** Normalizes a `-> ReturnType` suffix (or `""` when absent). */
export function normalizeReturnType(returnTypeRaw: string | undefined): string {
  if (returnTypeRaw === undefined || returnTypeRaw.trim().length === 0) return "";
  return ` -> ${normalizeSpacing(returnTypeRaw)}`;
}

/** Normalizes a class/def header text with no parameter list (e.g. a bare `class Foo:`). */
export function normalizeHeaderText(headerText: string): string {
  return normalizeSpacing(headerText.replace(/:\s*$/, ""));
}
