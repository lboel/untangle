/**
 * Environment variable layer (spec.md §4.1 layer 2, prefix `UNTANGLE_`).
 *
 * spec.md does not enumerate the mapping, so this table is an explicit
 * Untangle decision: it covers the fields most likely to be overridden
 * outside a checked-in config file (endpoints, modes, secrets-by-reference,
 * gate strictness, telemetry opt-in), not every leaf field of
 * `UntangleConfigV1`. New mappings MAY be added additively; removing or
 * renaming one is a breaking change to this package's public contract.
 *
 * `UNTANGLE_QDRANT_API_KEY_ENV` / `UNTANGLE_EMBEDDINGS_API_KEY_ENV` set the
 * NAME of a further environment variable holding a secret; they never carry
 * the secret value itself (architecture.md §23.2).
 */
import type { RawConfigLayer } from "./types.js";

type Parser = (raw: string) => unknown;

const parseString: Parser = (raw) => raw;
const parseNumber: Parser = (raw) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`expected a finite number, got "${raw}"`);
  }
  return value;
};
const parseBoolean: Parser = (raw) => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`expected a boolean ("true"/"false"/"1"/"0"), got "${raw}"`);
};
const parseCsv: Parser = (raw) =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export interface EnvMappingEntry {
  /** Environment variable name, e.g. `UNTANGLE_QDRANT_URL`. */
  env: string;
  /** Dotted path into `UntangleConfigV1`, e.g. `["qdrant", "url"]`. */
  path: readonly string[];
  parse: Parser;
}

/** The complete, documented `UNTANGLE_*` → config-path mapping table. */
export const ENV_MAPPING: readonly EnvMappingEntry[] = [
  { env: "UNTANGLE_WORKSPACE_ID", path: ["workspaceId"], parse: parseString },
  { env: "UNTANGLE_PROJECT_ID", path: ["projectId"], parse: parseString },

  { env: "UNTANGLE_STORAGE_BACKEND", path: ["storage", "backend"], parse: parseString },
  { env: "UNTANGLE_LANCEDB_PATH", path: ["storage", "path"], parse: parseString },

  { env: "UNTANGLE_QDRANT_MODE", path: ["qdrant", "mode"], parse: parseString },
  { env: "UNTANGLE_QDRANT_URL", path: ["qdrant", "url"], parse: parseString },
  { env: "UNTANGLE_QDRANT_API_KEY_ENV", path: ["qdrant", "apiKeyEnv"], parse: parseString },
  {
    env: "UNTANGLE_QDRANT_COLLECTION_PREFIX",
    path: ["qdrant", "collectionPrefix"],
    parse: parseString,
  },
  {
    env: "UNTANGLE_QDRANT_REQUEST_TIMEOUT_MS",
    path: ["qdrant", "requestTimeoutMs"],
    parse: parseNumber,
  },
  { env: "UNTANGLE_QDRANT_MAX_RETRIES", path: ["qdrant", "maxRetries"], parse: parseNumber },

  { env: "UNTANGLE_EMBEDDINGS_MODE", path: ["embeddings", "mode"], parse: parseString },
  { env: "UNTANGLE_EMBEDDINGS_URL", path: ["embeddings", "url"], parse: parseString },
  { env: "UNTANGLE_EMBEDDINGS_API_KEY_ENV", path: ["embeddings", "apiKeyEnv"], parse: parseString },
  { env: "UNTANGLE_EMBEDDINGS_MODEL", path: ["embeddings", "model"], parse: parseString },
  { env: "UNTANGLE_EMBEDDINGS_DIMENSIONS", path: ["embeddings", "dimensions"], parse: parseNumber },
  {
    env: "UNTANGLE_EMBEDDINGS_REQUEST_TIMEOUT_MS",
    path: ["embeddings", "requestTimeoutMs"],
    parse: parseNumber,
  },

  { env: "UNTANGLE_INDEX_WATCH", path: ["index", "watch"], parse: parseBoolean },
  { env: "UNTANGLE_INDEX_MAX_FILE_SIZE_MB", path: ["index", "maxFileSizeMb"], parse: parseNumber },
  { env: "UNTANGLE_INDEX_EXTRA_EXTENSIONS", path: ["index", "extraExtensions"], parse: parseCsv },

  { env: "UNTANGLE_QUALITY_GATE_MODE", path: ["qualityGate", "mode"], parse: parseString },
  {
    env: "UNTANGLE_QUALITY_GATE_MINIMUM_PARSE_QUALITY",
    path: ["qualityGate", "minimumParseQuality"],
    parse: parseString,
  },

  { env: "UNTANGLE_TELEMETRY_ENABLED", path: ["telemetry", "enabled"], parse: parseBoolean },
  { env: "UNTANGLE_TELEMETRY_LOG_LEVEL", path: ["telemetry", "logLevel"], parse: parseString },

  { env: "UNTANGLE_PORTFOLIO_ENABLED", path: ["portfolio", "enabled"], parse: parseBoolean },
] as const;

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string;
    const next = cursor[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1] as string;
  cursor[lastKey] = value;
}

export interface EnvLayerResult {
  layer: RawConfigLayer;
  /** Env vars that were present but failed to parse (e.g. non-numeric `UNTANGLE_EMBEDDINGS_DIMENSIONS`). */
  parseErrors: { env: string; message: string }[];
}

/** Builds a `RawConfigLayer` from `env` using {@link ENV_MAPPING}. Unset variables are skipped. */
export function buildEnvConfigLayer(env: NodeJS.ProcessEnv = process.env): EnvLayerResult {
  const layer: Record<string, unknown> = {};
  const parseErrors: { env: string; message: string }[] = [];
  for (const entry of ENV_MAPPING) {
    const raw = env[entry.env];
    if (raw === undefined) {
      continue;
    }
    try {
      setAtPath(layer, entry.path, entry.parse(raw));
    } catch (error) {
      parseErrors.push({
        env: entry.env,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { layer: layer as RawConfigLayer, parseErrors };
}
