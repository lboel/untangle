import path from "node:path";

import {
  DEFAULT_STORAGE_CONFIG,
  buildEnvConfigLayer,
  mergeConfigLayers,
  parseConfigText,
  resolveUserConfigDir,
  type RawConfigLayer,
} from "@untangle-code/config";
import type { FileSystemPort } from "@untangle-code/domain";

import { OperationalError } from "../../cli/exit.js";

import type { StorageFindingsV1 } from "./types.js";

/** Explicit selection wins; an explicitly configured Qdrant remains opt-in. */
export function initStorageBackend(
  explicit: StorageFindingsV1["backend"] | undefined,
  env: Readonly<Record<string, string | undefined>>,
  existing: RawConfigLayer = {},
): StorageFindingsV1["backend"] {
  const selected = explicit ?? env["UNTANGLE_STORAGE_BACKEND"] ?? existing.storage?.backend;
  if (selected !== undefined) {
    if (selected === "lancedb" || selected === "qdrant") return selected;
    throw new OperationalError(
      `Unknown storage backend ${JSON.stringify(selected)}.`,
      "Select --storage=lancedb or --storage=qdrant.",
    );
  }
  return existing.qdrant !== undefined ||
    buildEnvConfigLayer(env as NodeJS.ProcessEnv).layer.qdrant !== undefined
    ? "qdrant"
    : "lancedb";
}

/** Inspect a local directory without opening a database or creating files. */
export async function inspectInitStorage(
  fs: FileSystemPort,
  root: string,
  explicit: StorageFindingsV1["backend"] | undefined,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<StorageFindingsV1> {
  signal?.throwIfAborted();
  const { layer: existing, warnings } = await existingStorageConfig(fs, root, env, signal);
  const backend = initStorageBackend(explicit, env, existing);
  if (backend === "qdrant") {
    const mode = env["UNTANGLE_QDRANT_MODE"] ?? existing.qdrant?.mode;
    const url = env["UNTANGLE_QDRANT_URL"] ?? existing.qdrant?.url;
    return {
      backend,
      ...(mode === "managed" || mode === "external" ? { qdrantMode: mode } : {}),
      ...(url === undefined ? {} : { qdrantUrl: url }),
      ...(warnings.length === 0 ? {} : { configurationWarnings: warnings }),
    };
  }
  const localPath =
    env["UNTANGLE_LANCEDB_PATH"] ?? existing.storage?.path ?? DEFAULT_STORAGE_CONFIG.path;
  if (!localPath)
    throw new OperationalError("The local storage path is empty.", "Set UNTANGLE_LANCEDB_PATH.");
  const directory = path.resolve(root, localPath);
  signal?.throwIfAborted();
  try {
    const entry = await fs.stat(directory);
    signal?.throwIfAborted();
    return {
      backend,
      path: localPath,
      directory,
      directoryStatus:
        entry === null ? "missing" : entry.kind === "directory" ? "present" : "not-directory",
      ...(warnings.length === 0 ? {} : { configurationWarnings: warnings }),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      backend,
      path: localPath,
      directory,
      directoryStatus: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
      ...(warnings.length === 0 ? {} : { configurationWarnings: warnings }),
    };
  }
}

/** Read the same project layer formats/order as config loading, through init's filesystem port. */
async function existingStorageConfig(
  fs: FileSystemPort,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<{ layer: RawConfigLayer; warnings: string[] }> {
  signal?.throwIfAborted();
  const json = path.join(root, ".untangle.json");
  const toml = path.join(root, "untangle.toml");
  const legacyExists = (await fs.stat(json)) !== null || (await fs.stat(toml)) !== null;
  const user = path.join(
    resolveUserConfigDir(env as NodeJS.ProcessEnv, process.platform),
    "config.json",
  );
  const paths = [
    { path: user, format: "json" as const },
    { path: toml, format: "toml" as const },
    {
      path: legacyExists ? json : path.join(root, ".untangle/config.json"),
      format: "json" as const,
    },
    { path: path.join(root, ".untangle.local.json"), format: "json" as const },
  ];
  const layers: RawConfigLayer[] = [];
  const warnings: string[] = [];
  let legacyQdrant = false;
  for (const file of paths) {
    signal?.throwIfAborted();
    try {
      if ((await fs.stat(file.path))?.kind !== "file") continue;
      const layer = parseConfigText(await fs.readTextFile(file.path), file.format);
      if (layer.qdrant !== undefined) legacyQdrant = true;
      layers.push(layer);
    } catch {
      signal?.throwIfAborted();
      warnings.push(
        `Storage selection could not be inspected in ${file.path}; existing configuration is preserved unless --force is selected.`,
      );
    }
  }
  return {
    layer: mergeConfigLayers<RawConfigLayer>([
      ...(legacyQdrant ? [{ storage: { backend: "qdrant" } }] : []),
      ...layers,
    ]),
    warnings,
  };
}
