/**
 * Top-level configuration loading: discovery + six-level layering (spec.md
 * §4.1) + path resolution (spec.md §4.3) + validation (spec.md §4.8) +
 * canonical hashing and embedding profile derivation (architecture.md §6.3).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildWorkspaceId } from "@untangle-code/domain";
import { parse as parseToml } from "smol-toml";

import { PRODUCT_DEFAULT_CONFIG } from "./defaults.js";
import { discoverConfigFiles } from "./discovery.js";
import { buildEnvConfigLayer } from "./env.js";
import { computeConfigHash, deriveEmbeddingProfileId } from "./hash.js";
import { mergeConfigLayers } from "./merge.js";
import { migrateConfig } from "./migrations.js";
import { resolveConfigPath } from "./paths.js";
import type { RawConfigLayer, EffectiveUntangleConfigV1 } from "./types.js";
import { resolveUserConfigPath } from "./user-config.js";
import type { ConfigIssue } from "./validate.js";
import { validateEffectiveConfig } from "./validate.js";

export interface LoadConfigOptions {
  /** Directory to start upward config-file discovery from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Highest-priority layer (spec.md §4.1 layer 1): explicit API/CLI arguments. */
  explicit?: RawConfigLayer;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ConfigSources {
  userConfigPath: string | undefined;
  projectConfigPath: string | undefined;
  /**
   * `untangle.toml` (layer 4b) — the file `untangle init` writes. Reported
   * separately so a diagnostic command can name the file the user actually
   * has instead of the one it expected (WP-222).
   */
  tomlConfigPath: string | undefined;
  localConfigPath: string | undefined;
  explicitProvided: boolean;
  /** `UNTANGLE_*` variables from `ENV_MAPPING` that were actually set. */
  envVarsApplied: string[];
  /**
   * Fallback directory shown for diagnostics only: `.untangle.json`'s
   * directory, else `untangle.toml`'s, else `.untangle.local.json`'s, else
   * `cwd`. It is NOT
   * necessarily what `repositories`/`contextArtifacts` paths were resolved
   * against — each of those resolves against the directory of whichever
   * layer actually defined it (spec.md §4.3; see `loadConfig`'s
   * `originBaseDirFor`), which may be the OS user config directory or `cwd`
   * (env/explicit layers) instead.
   */
  configBaseDir: string;
  /** Logical project root for `.untangle/config.json`; legacy layouts keep their existing base. */
  projectRoot?: string;
}

export interface LoadConfigResult {
  effectiveConfig: EffectiveUntangleConfigV1;
  warnings: ConfigIssue[];
  errors: ConfigIssue[];
  sources: ConfigSources;
  /** Canonical effective-config hash; Qdrant excludes additive storage fields for legacy identity. */
  configHash: string;
  /** `buildWorkspaceId({ explicitId: effectiveConfig.workspaceId, configHash })` (spec.md §5.1). */
  workspaceId: string;
  /** `buildEmbeddingProfileId` over the derived profile (spec.md §5.7). */
  embeddingProfileId: string;
}

interface FileLayerOutcome {
  layer: RawConfigLayer;
  error: ConfigIssue | undefined;
}

function readJsonConfigFile(path: string): FileLayerOutcome {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      layer: {},
      error: {
        code: "CONFIG_INVALID",
        message: `failed to read config file "${path}": ${String(error)}`,
        path,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      layer: {},
      error: {
        code: "CONFIG_INVALID",
        message: `"${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        path,
      },
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      layer: {},
      error: { code: "CONFIG_INVALID", message: `"${path}" must contain a JSON object`, path },
    };
  }
  const migrated = migrateConfig(parsed as Record<string, unknown>);
  return { layer: migrated.config as RawConfigLayer, error: undefined };
}

/**
 * Reads `untangle.toml` into the same raw layer shape a JSON config produces.
 *
 * The TOML file `untangle init` writes carries the SAME keys as
 * `.untangle.json` — `schemaVersion`, `repositories`, `qdrant`, `embeddings`
 * and so on — so it needs no separate schema, only a separate parser. It
 * runs through `migrateConfig` and the ordinary validation like every other
 * layer; a typo in it is reported the same way, in the same list, against
 * the same paths.
 */
function readTomlConfigFile(path: string): FileLayerOutcome {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      layer: {},
      error: {
        code: "CONFIG_INVALID",
        message: `failed to read config file "${path}": ${String(error)}`,
        path,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (error) {
    return {
      layer: {},
      error: {
        code: "CONFIG_INVALID",
        message: `"${path}" is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
        path,
      },
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      layer: {},
      error: { code: "CONFIG_INVALID", message: `"${path}" must contain a TOML table`, path },
    };
  }
  const migrated = migrateConfig(parsed as Record<string, unknown>);
  return { layer: migrated.config as RawConfigLayer, error: undefined };
}

/**
 * Loads and resolves the effective Untangle configuration through all six
 * layers of spec.md §4.1: explicit args > env (`UNTANGLE_*`) >
 * `.untangle.local.json` > `.untangle.json` > OS user config > product
 * defaults. Never throws for validation problems — see {@link ConfigIssue}
 * and `validate.ts`'s `assertConfigValid` for the "MUST abort" behavior
 * spec.md §4.8 requires from a caller.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const { projectConfigPath, tomlConfigPath, localConfigPath, projectRoot } =
    discoverConfigFiles(cwd);
  const userConfigPath = resolveUserConfigPath(env, platform);

  const errors: ConfigIssue[] = [];

  const userLayerOutcome: FileLayerOutcome = userConfigPath
    ? readJsonConfigFile(userConfigPath)
    : { layer: {}, error: undefined };
  const projectLayerOutcome: FileLayerOutcome = projectConfigPath
    ? readJsonConfigFile(projectConfigPath)
    : { layer: {}, error: undefined };
  const tomlLayerOutcome: FileLayerOutcome = tomlConfigPath
    ? readTomlConfigFile(tomlConfigPath)
    : { layer: {}, error: undefined };
  const localLayerOutcome: FileLayerOutcome = localConfigPath
    ? readJsonConfigFile(localConfigPath)
    : { layer: {}, error: undefined };
  for (const outcome of [
    userLayerOutcome,
    tomlLayerOutcome,
    projectLayerOutcome,
    localLayerOutcome,
  ]) {
    if (outcome.error) {
      errors.push(outcome.error);
    }
  }

  const envLayerResult = buildEnvConfigLayer(env);
  for (const parseError of envLayerResult.parseErrors) {
    errors.push({
      code: "CONFIG_INVALID",
      message: `environment variable ${parseError.env}: ${parseError.message}`,
      path: parseError.env,
    });
  }

  const explicitLayer: RawConfigLayer = options.explicit ?? {};

  // Each layer's OWN directory (spec.md §4.3: a path resolves relative to
  // the config file that declared it). Layers with no backing file (product
  // defaults, the env layer, explicit args) have no directory of their own,
  // so they fall back to `cwd` — the directory the caller is running from.
  const namedLayers: readonly { layer: RawConfigLayer; baseDir: string }[] = [
    { layer: PRODUCT_DEFAULT_CONFIG, baseDir: cwd },
    { layer: userLayerOutcome.layer, baseDir: userConfigPath ? dirname(userConfigPath) : cwd },
    // Layer 4b, directly beneath `.untangle.json`: `untangle.toml`. Where
    // both exist the JSON file wins — and `warnings` says so out loud, so a
    // user never wonders why an edit had no effect (WP-222).
    { layer: tomlLayerOutcome.layer, baseDir: tomlConfigPath ? dirname(tomlConfigPath) : cwd },
    {
      layer: projectLayerOutcome.layer,
      baseDir: projectConfigPath ? dirname(projectConfigPath) : cwd,
    },
    { layer: localLayerOutcome.layer, baseDir: localConfigPath ? dirname(localConfigPath) : cwd },
    { layer: envLayerResult.layer, baseDir: cwd },
    { layer: explicitLayer, baseDir: cwd },
  ];

  // Preserve existing Qdrant projects without letting the product-default
  // qdrant section choose a backend for new projects. This compatibility
  // default sits below every user layer: an explicit storage.backend at any
  // priority overrides it, while storage.path alone never migrates an index.
  const configuredLayers = namedLayers.slice(1).map((named) => named.layer);
  const legacyStorageDefault: RawConfigLayer = configuredLayers.some(
    (layer) => layer.qdrant !== undefined,
  )
    ? { storage: { backend: "qdrant" } }
    : {};
  const merged = mergeConfigLayers<Record<string, unknown>>([
    PRODUCT_DEFAULT_CONFIG,
    legacyStorageDefault,
    ...configuredLayers,
  ]);

  const configBaseDir = projectConfigPath
    ? dirname(projectConfigPath)
    : tomlConfigPath
      ? dirname(tomlConfigPath)
      : localConfigPath
        ? dirname(localConfigPath)
        : cwd;

  /**
   * `mergeConfigLayers` REPLACES arrays wholesale rather than concatenating
   * them (merge.ts) — so the final `repositories`/`contextArtifacts` array
   * in `merged` originates entirely from ONE layer: the highest-priority
   * layer that defined it. Its entries' `path` fields MUST resolve against
   * THAT layer's own directory (spec.md §4.3), not a single global
   * `configBaseDir` computed after the merge — otherwise a repository
   * defined in the OS user config (or via an env/explicit layer) silently
   * loses its origin and resolves against the wrong directory. Walking
   * `namedLayers` highest-priority-first and taking the first one that set
   * `key` recovers exactly the layer the merge itself used.
   */
  function originBaseDirFor(key: "repositories" | "contextArtifacts"): string {
    for (let i = namedLayers.length - 1; i >= 0; i -= 1) {
      const candidate = namedLayers[i];
      if (candidate && Array.isArray((candidate.layer as Record<string, unknown>)[key])) {
        return candidate.baseDir;
      }
    }
    return cwd;
  }

  if (Array.isArray(merged["repositories"])) {
    const baseDir = originBaseDirFor("repositories");
    merged["repositories"] = (merged["repositories"] as { path: string }[]).map((repo) => ({
      ...repo,
      path: resolveConfigPath(repo.path, baseDir),
    }));
  }
  if (Array.isArray(merged["contextArtifacts"])) {
    const baseDir = originBaseDirFor("contextArtifacts");
    merged["contextArtifacts"] = (merged["contextArtifacts"] as { path: string }[]).map(
      (artifact) => ({
        ...artifact,
        path: resolveConfigPath(artifact.path, baseDir),
      }),
    );
  }

  const { errors: validationErrors, warnings } = validateEffectiveConfig(merged);
  errors.push(...validationErrors);

  if (projectConfigPath !== undefined && tomlConfigPath !== undefined) {
    warnings.push({
      code: "CONFIG_DUPLICATE_PROJECT_FILE",
      message:
        `both "${projectConfigPath}" and "${tomlConfigPath}" exist; ` +
        `"${projectConfigPath}" wins for every key it sets`,
      path: "(project config)",
    });
  }

  const effectiveConfig = merged as unknown as EffectiveUntangleConfigV1;
  const configHash = computeConfigHash(effectiveConfig);
  const workspaceId = buildWorkspaceId(
    effectiveConfig.workspaceId === undefined
      ? { configHash }
      : { explicitId: effectiveConfig.workspaceId, configHash },
  );
  const embeddingProfileId = deriveEmbeddingProfileId(effectiveConfig);

  return {
    effectiveConfig,
    warnings,
    errors,
    sources: {
      userConfigPath,
      projectConfigPath,
      tomlConfigPath,
      localConfigPath,
      explicitProvided: options.explicit !== undefined,
      envVarsApplied: Object.keys(env).filter(
        (key) => key.startsWith("UNTANGLE_") && env[key] !== undefined,
      ),
      configBaseDir,
      ...(projectRoot === undefined ? {} : { projectRoot }),
    },
    configHash,
    workspaceId,
    embeddingProfileId,
  };
}

/** Re-exported for callers that only need to check whether a discovered path exists (rare; mostly test convenience). */
export function configFileExists(path: string | undefined): boolean {
  return path !== undefined && existsSync(path);
}
