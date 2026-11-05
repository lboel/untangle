/**
 * Adapter configuration (spec.md §4.4) and its resolution into the effective
 * settings this package's stores consume.
 *
 * `QdrantConfig` (from `@untangle-code/config`) carries only `apiKeyEnv` —
 * the NAME of an environment variable, never a secret value
 * (architecture.md §23.2); {@link resolveQdrantStorageConfig} resolves it
 * against an explicitly passed `env` record.
 */
import type { QdrantConfig } from "@untangle-code/config";
import { configInvalidError } from "@untangle-code/observability";

/** Effective, fully-defaulted settings of the Qdrant storage adapter. */
export interface QdrantStorageConfig {
  /** Base URL of the Qdrant instance. */
  url: string;
  /** Resolved API key value, when configured. */
  apiKey?: string;
  /** Collection name prefix (architecture.md §11.1: replaces "untangle_"). */
  collectionPrefix: string;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Base delay between retry attempts (multiplied by the attempt number). */
  retryDelayMs: number;
  /** Upsert batch limit by point count (spec.md §10.5). */
  upsertMaxPoints: number;
  /** Upsert batch limit by serialized byte size (spec.md §10.5). */
  upsertBudgetBytes: number;
  /**
   * Per-part payload budget for multipart graph shards
   * (architecture.md §11.7). Must be comfortably below `upsertBudgetBytes`
   * so a single part always fits into one upsert batch.
   */
  graphPartBudgetBytes: number;
}

/**
 * The URL `mode: "managed"` resolves to when no `url` is configured:
 * Untangle's OWN Qdrant container on the host port spec.md §3.1 assigns it.
 *
 * WP-222: this used to be `6333`, upstream Qdrant's default port — which on
 * a developer machine is regularly SOMEBODY ELSE'S instance. `managed` mode
 * therefore silently adopted a foreign store, and `untangle doctor` reported
 * it as healthy and recommended indexing into it. `managed` means "the
 * instance Untangle manages"; nothing else may satisfy it.
 */
export const MANAGED_QDRANT_URL = "http://127.0.0.1:16333";

/** Defaults mirroring `DEFAULT_QDRANT_CONFIG` of `@untangle-code/config`. */
export const QDRANT_STORAGE_DEFAULTS = {
  url: MANAGED_QDRANT_URL,
  collectionPrefix: "untangle_",
  requestTimeoutMs: 30000,
  maxRetries: 3,
  retryDelayMs: 200,
  upsertMaxPoints: 256,
  upsertBudgetBytes: 4 * 1024 * 1024,
  graphPartBudgetBytes: 1024 * 1024,
} as const;

const COLLECTION_PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Validates a collection prefix (used verbatim in Qdrant collection names).
 * Throws `CONFIG_INVALID` for anything outside `[a-z0-9_-]` or an empty
 * prefix — an empty prefix would let Untangle collections collide with
 * foreign collections on a shared instance.
 */
export function assertValidCollectionPrefix(prefix: string): void {
  if (!COLLECTION_PREFIX_PATTERN.test(prefix)) {
    throw configInvalidError(
      `invalid Qdrant collection prefix "${prefix}": expected a non-empty string of ` +
        "[a-z0-9_-] starting with [a-z0-9]",
      { context: { collectionPrefix: prefix } },
    );
  }
}

/**
 * Resolves a `QdrantConfig` (spec.md §4.4) plus an environment record into
 * the adapter's effective configuration. Throws `CONFIG_INVALID` when
 * `mode: "external"` lacks a URL, when the prefix is invalid, when a numeric
 * limit is not a positive integer, or when `apiKeyEnv` names a variable that
 * is not set.
 */
export function resolveQdrantStorageConfig(
  config: QdrantConfig,
  env: Record<string, string | undefined> = {},
): QdrantStorageConfig {
  const url = config.url ?? (config.mode === "managed" ? MANAGED_QDRANT_URL : undefined);
  if (url === undefined || url.length === 0) {
    throw configInvalidError('qdrant.url is required when qdrant.mode is "external"', {
      context: { mode: config.mode },
    });
  }
  const collectionPrefix = config.collectionPrefix ?? QDRANT_STORAGE_DEFAULTS.collectionPrefix;
  assertValidCollectionPrefix(collectionPrefix);

  let apiKey: string | undefined;
  if (config.apiKeyEnv !== undefined) {
    apiKey = env[config.apiKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      throw configInvalidError(
        `qdrant.apiKeyEnv names the environment variable "${config.apiKeyEnv}", but it is not set`,
        { context: { apiKeyEnv: config.apiKeyEnv } },
      );
    }
  }

  const requestTimeoutMs = positiveInt(
    "qdrant.requestTimeoutMs",
    config.requestTimeoutMs ?? QDRANT_STORAGE_DEFAULTS.requestTimeoutMs,
  );
  const maxRetries = nonNegativeInt(
    "qdrant.maxRetries",
    config.maxRetries ?? QDRANT_STORAGE_DEFAULTS.maxRetries,
  );
  const upsertMaxPoints = positiveInt(
    "qdrant.upsertMaxPoints",
    config.upsertMaxPoints ?? QDRANT_STORAGE_DEFAULTS.upsertMaxPoints,
  );
  const upsertBudgetBytes = positiveInt(
    "qdrant.upsertBudgetBytes",
    config.upsertBudgetBytes ?? QDRANT_STORAGE_DEFAULTS.upsertBudgetBytes,
  );
  const graphPartBudgetBytes = Math.min(
    QDRANT_STORAGE_DEFAULTS.graphPartBudgetBytes,
    upsertBudgetBytes,
  );

  return {
    url,
    ...(apiKey === undefined ? {} : { apiKey }),
    collectionPrefix,
    requestTimeoutMs,
    maxRetries,
    retryDelayMs: QDRANT_STORAGE_DEFAULTS.retryDelayMs,
    upsertMaxPoints,
    upsertBudgetBytes,
    graphPartBudgetBytes,
  };
}

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw configInvalidError(`${name} must be a positive integer, got ${value}`, {
      context: { field: name, value },
    });
  }
  return value;
}

function nonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw configInvalidError(`${name} must be a non-negative integer, got ${value}`, {
      context: { field: name, value },
    });
  }
  return value;
}
