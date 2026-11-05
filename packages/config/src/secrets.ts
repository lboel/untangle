/**
 * Secret references and redaction (spec.md §4.4/§4.5 `apiKeyEnv`; §24
 * "API-Keys DÜRFEN nicht in Status, Logs oder Crash Reports erscheinen";
 * architecture.md §23.2: "Der Wert wird nie in Effective Config Dumps
 * geschrieben.").
 *
 * The primary guarantee is structural: `QdrantConfig`/`EmbeddingConfig` only
 * ever carry `apiKeyEnv` — the NAME of an environment variable — never a
 * resolved secret value, so an `EffectiveUntangleConfigV1` cannot contain a
 * secret by construction. `redactSecrets` is a defense-in-depth belt: it
 * scrubs any resolved-secret-shaped field (e.g. code elsewhere mistakenly
 * attaching a resolved key onto a config object for convenience) before that
 * object is serialized, dumped, or logged.
 */

const REDACTED_PLACEHOLDER = "[REDACTED]";

// Field name ends in one of these -> looks like a *resolved* secret value.
const SECRET_VALUE_KEY_PATTERN = /(apikey|secret|password|token|credential)$/i;
// ...unless it ends in "Env" (e.g. `apiKeyEnv`), which holds an env var NAME
// and is exactly what spec.md §24 requires to stay visible for transparency.
const ENV_REFERENCE_SUFFIX_PATTERN = /env$/i;

function looksLikeResolvedSecretKey(key: string): boolean {
  if (ENV_REFERENCE_SUFFIX_PATTERN.test(key)) {
    return false;
  }
  return SECRET_VALUE_KEY_PATTERN.test(key);
}

function redactRecursive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactRecursive);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      result[key] = looksLikeResolvedSecretKey(key)
        ? REDACTED_PLACEHOLDER
        : redactRecursive(entryValue);
    }
    return result;
  }
  return value;
}

/**
 * Returns a deep copy of `value` with any field whose name looks like a
 * resolved secret (`apiKey`, `token`, `password`, `secret`, `credential`, but
 * NOT the `...Env` reference fields) replaced by a fixed placeholder. Safe to
 * call on an `EffectiveUntangleConfigV1`, a partial layer, or arbitrary
 * nested data.
 */
export function redactSecrets<T>(value: T): T {
  return redactRecursive(value) as T;
}

/** `JSON.stringify` through {@link redactSecrets} — the one safe way to dump a config. */
export function toRedactedJson(value: unknown, space?: number): string {
  return JSON.stringify(redactSecrets(value), null, space);
}

/**
 * Resolves an `apiKeyEnv` reference to its actual secret value AT CALL TIME.
 * The result MUST NOT be stored back onto any config object — callers (e.g.
 * a Qdrant/Ollama adapter) use it immediately for one connection attempt.
 * Returns `undefined` when `envVarName` is unset or the variable is not
 * present in `env`.
 */
export function resolveApiKey(
  envVarName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (envVarName === undefined || envVarName.length === 0) {
    return undefined;
  }
  return env[envVarName];
}
