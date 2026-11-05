/**
 * Deep merge for the layering pipeline (spec.md §4.1).
 *
 * Array semantics: arrays REPLACE, they never concatenate. A layer with
 * `index.extraExtensions: [".proto"]` fully replaces a lower layer's array —
 * two layers are never spliced together, because there is no reasonable way
 * to know whether a higher layer meant to add to or reset a list (e.g.
 * `exclude` globs), and silent concatenation would make higher-priority
 * layers unable to shrink a list at all.
 *
 * Relevance-policy bindings are another deliberate replacement boundary:
 * entries below `search.relevancePolicies.<profileId>` are calibrated,
 * corpus-bound units. Merging a new workspace/collection with thresholds
 * inherited from a lower layer would silently apply one corpus's policy to
 * another corpus.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges `override` onto `base`. Plain objects merge key by key (recursively);
 * arrays, primitives, `null` and any non-plain object (e.g. would-be class
 * instances) from `override` replace the corresponding value in `base`
 * wholesale. `undefined` values in `override` are treated as "not set" and do
 * not overwrite a present `base` value — this lets a layer omit a field
 * without needing to know the value from lower layers.
 */
export function deepMergeConfig<T>(base: T, override: unknown): T {
  return deepMergeConfigAtPath(base, override, []);
}

function isAtomicReplacementPath(path: readonly string[]): boolean {
  return path.length === 3 && path[0] === "search" && path[1] === "relevancePolicies";
}

function deepMergeConfigAtPath<T>(base: T, override: unknown, path: readonly string[]): T {
  if (override === undefined) {
    return base;
  }
  if (isAtomicReplacementPath(path)) {
    return override as T;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const baseValue = (base as Record<string, unknown>)[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMergeConfigAtPath(baseValue, value, [...path, key])
        : value;
  }
  return result as T;
}

/**
 * Merges layers left to right — later layers win — mirroring spec.md §4.1's
 * priority order when called with `[productDefaults, userConfig, projectConfig,
 * localConfig, envLayer, explicitArgs]` (lowest priority first).
 */
export function mergeConfigLayers<T>(layers: readonly unknown[]): T {
  return layers.reduce<unknown>((acc, layer) => deepMergeConfig(acc, layer), {}) as T;
}
