/**
 * A small, self-contained gitignore-pattern compiler (spec.md §6.2:
 * "Gitignore-Semantik selbst implementieren oder ueber die ignore-Bibliothek").
 * Supports negation (`!pattern`), directory-only patterns (`pattern/`),
 * root anchors (`/pattern`), `**`, `*`, `?` and `[...]` character classes.
 *
 * Deliberately self-implemented (no dependency) to keep full control over
 * how multiple layers compose (see `ignore-engine.ts`), which the spec's
 * multi-source priority model (§6.2) needs more of than a single
 * `.gitignore` parser typically exposes.
 */

export interface CompiledPattern {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
  raw: string;
}

function escapeRegexLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function escapeBaseDir(baseDir: string): string {
  return baseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Translates one gitignore glob (no leading `/`, no trailing `/`) into a regex source string. */
function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else if (i + 2 >= pattern.length) {
          out += ".*";
          i += 1;
        } else {
          // "**" not followed by "/" and not at the end: treat as a plain "*".
          out += "[^/]*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      let j = i + 1;
      let cls = "[";
      if (pattern[j] === "!" || pattern[j] === "^") {
        cls += "^";
        j += 1;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        const c = pattern[j];
        cls += c === "\\" ? "\\\\" : c;
        j += 1;
      }
      cls += "]";
      out += cls;
      i = j;
    } else if (ch === "\\" && i + 1 < pattern.length) {
      out += escapeRegexLiteral(pattern[i + 1] as string);
      i += 1;
    } else {
      out += escapeRegexLiteral(ch as string);
    }
  }
  return out;
}

/**
 * Compiles one gitignore-style line, scoped to `baseDir` (the "/"-relative
 * directory the source `.gitignore`/`.untangleignore` file lives in, `""`
 * for the workspace/repo root). Returns `null` for blank lines and comments.
 */
export function compilePattern(rawLine: string, baseDir: string): CompiledPattern | null {
  const trimmed = rawLine.replace(/\s+$/, "");
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("#")) {
    return null;
  }

  let pattern = trimmed;
  let negate = false;
  if (pattern.startsWith("!")) {
    negate = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0) {
    return null;
  }

  let anchored = pattern.includes("/");
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
    anchored = true;
  }

  const base = escapeBaseDir(baseDir);
  const basePrefix = baseDir.length > 0 ? `${base}/` : "";
  const body = globToRegexSource(pattern);

  const source = anchored
    ? `^${basePrefix}${body}(?:/.*)?$`
    : `^${basePrefix}(?:.*/)?${body}(?:/.*)?$`;

  return { regex: new RegExp(source), negate, dirOnly, raw: rawLine };
}

/** Compiles every line of a `.gitignore`/`.untangleignore`-style file. */
export function compilePatterns(content: string, baseDir: string): CompiledPattern[] {
  const patterns: CompiledPattern[] = [];
  for (const line of content.split(/\r\n|\r|\n/)) {
    const compiled = compilePattern(line, baseDir);
    if (compiled !== null) {
      patterns.push(compiled);
    }
  }
  return patterns;
}

/** Compiles a flat list of plain glob strings (e.g. config include/exclude), all rooted at "". */
export function compileGlobList(patterns: readonly string[]): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (const pattern of patterns) {
    const result = compilePattern(pattern, "");
    if (result !== null) {
      compiled.push(result);
    }
  }
  return compiled;
}

/**
 * Evaluates one layer's patterns against a path (standard gitignore
 * semantics: later patterns override earlier ones within the same layer).
 * Returns `undefined` when no pattern in the layer applies at all — that is
 * the signal for callers to defer to a lower-priority layer's decision.
 */
export function evaluateLayer(
  patterns: readonly CompiledPattern[],
  relativePath: string,
  isDirectory: boolean,
): boolean | undefined {
  let result: boolean | undefined;
  for (const pattern of patterns) {
    if (pattern.dirOnly && !isDirectory) {
      continue;
    }
    if (pattern.regex.test(relativePath)) {
      result = !pattern.negate;
    }
  }
  return result;
}
