/**
 * Redaction (spec.md §24, §23.2): keeps secrets and full source text out of
 * logs, status output and crash reports by default.
 *
 * `redact()` is a pure function — no I/O, no logging decisions of its own.
 * The logger (`logger.ts`) applies it to every event's `context` before
 * writing.
 */

const MASK = "[REDACTED]";
const SOURCE_TEXT_SUPPRESSED = "[SOURCE_TEXT_SUPPRESSED]";

/**
 * Key names spec.md §24 calls out by name, plus the common synonyms and
 * variants ("api_key", "apiKey", "auth", …) adapters realistically use.
 * Matched case-insensitively against the whole key.
 */
const SECRET_KEY_PATTERN =
  /(api[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|token|password|passwd|pwd|secret|authorization|auth|cookie|credential)/i;

/**
 * Field names that carry full source text / code (spec.md §23.2: "vollständige
 * Quelltexte standardmäßig redigieren"). Mirrors the content-bearing fields of
 * domain's `CodeChunkPayloadV1`/`CodeChunkDraft` plus generic synonyms, so a
 * logged chunk, diff or search hit does not dump raw code into logs by
 * default. Matched case-insensitively against the whole key.
 */
const SOURCE_TEXT_KEYS = new Set([
  "content",
  "text",
  "sourcetext",
  "source",
  "sourcecode",
  "code",
  "snippet",
  "prepareddensetext",
  "bm25text",
  "diff",
  "patch",
  "raw",
  "rawtext",
]);

export interface RedactOptions {
  /**
   * Opt-in escape hatch for interactive debugging (spec.md §24: only on
   * explicit debug opt-in). When `false` (default), values under a
   * {@link SOURCE_TEXT_KEYS} key are replaced instead of logged verbatim.
   */
  includeSourceText?: boolean;
}

/**
 * Recursively redacts `value`: keys that look like secrets are masked
 * regardless of their value's shape, keys that carry source text are
 * suppressed unless `includeSourceText` is set, and string values that look
 * like a secret themselves (bearer tokens, JWTs, common vendor key prefixes)
 * are masked even under an innocuous key name.
 *
 * Never throws: unsupported value kinds (bigint, function, symbol) are
 * stringified rather than propagating a serialization error into a logging
 * call.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return redactValue(value, options, new WeakSet<object>());
}

function redactValue(value: unknown, options: RedactOptions, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    return value.map((entry) => redactValue(entry, options, seen));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactEntry(key, entryValue, options, seen);
    }
    return out;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (typeof value === "string" && looksLikeSecretValue(value)) {
    return MASK;
  }
  return value;
}

function redactEntry(
  key: string,
  entryValue: unknown,
  options: RedactOptions,
  seen: WeakSet<object>,
): unknown {
  const lowerKey = key.toLowerCase();
  if (SECRET_KEY_PATTERN.test(lowerKey)) {
    return MASK;
  }
  if (!options.includeSourceText && SOURCE_TEXT_KEYS.has(lowerKey)) {
    return SOURCE_TEXT_SUPPRESSED;
  }
  return redactValue(entryValue, options, seen);
}

/**
 * Heuristic for "a value that looks like a key" (spec.md §24): bearer
 * headers, JWT-shaped triples, and common vendor secret prefixes
 * (`sk-`, `ghp_`, `xox…`). Conservative on purpose — false negatives are
 * expected, false positives on ordinary prose are not.
 */
function looksLikeSecretValue(value: string): boolean {
  if (/^bearer\s+\S+/i.test(value)) {
    return true;
  }
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value)) {
    return true;
  }
  if (/^(sk|pk|rk)-[A-Za-z0-9_-]{16,}$/i.test(value)) {
    return true;
  }
  if (/^(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}$/i.test(value)) {
    return true;
  }
  if (/^xox[baprs]-[A-Za-z0-9-]{10,}$/i.test(value)) {
    return true;
  }
  return false;
}
