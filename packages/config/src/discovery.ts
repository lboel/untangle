/**
 * Config file discovery (spec.md §4.1, §4.3 mention `.untangle.json` /
 * `.untangle.local.json` without specifying how they are found;
 * architecture.md §6.3 assigns "Config Discovery" to this package).
 *
 * Upward search from a start path, checking one directory at a time, until
 * either the file is found, the repository root is reached (a directory
 * containing `.git`, checked AFTER that directory's own candidate file so the
 * repo root itself is still searched), or the filesystem root is reached.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROJECT_CONFIG_FILE_NAME = ".untangle.json";
export const LOCAL_CONFIG_FILE_NAME = ".untangle.local.json";
/** Folder-contained project configuration; legacy root files retain priority. */
export const PROJECT_FOLDER_CONFIG_FILE_NAME = join(".untangle", "config.json");
/**
 * `untangle.toml`, the file `untangle init` writes (WP-125).
 *
 * WP-222: it used to be invisible here. `init` wrote `untangle.toml`,
 * discovery looked only for `.untangle.json`, and so `untangle doctor`
 * reported "no configuration found" about a configuration that had just been
 * written — and advised running `untangle init`, which had just run. A user
 * following that advice loops forever. One file name known in one place ends
 * that: whatever `init` writes is exactly what discovery finds.
 */
export const PROJECT_TOML_CONFIG_FILE_NAME = "untangle.toml";

function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Searches `startPath` and its ancestors for `fileName`, stopping after the
 * first directory that is a repository root (has `.git`) or after the
 * filesystem root. Returns the absolute path of the first match, or
 * `undefined` if none is found.
 */
export function discoverConfigFile(startPath: string, fileName: string): string | undefined {
  let dir = resolve(startPath);
  // If startPath is a file (e.g. process.cwd() equivalent passed by mistake),
  // callers are expected to pass a directory; we do not stat startPath itself.
  for (;;) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Unreadable candidate (race, permissions): treat as not found here.
      }
    }
    const atRepoRoot = isRepoRoot(dir);
    const parent = dirname(dir);
    const atFilesystemRoot = parent === dir;
    if (atRepoRoot || atFilesystemRoot) {
      return undefined;
    }
    dir = parent;
  }
}

/** Result of discovering the project-level config files (spec.md §4.1, layers 3–4). */
export interface DiscoveredConfigFiles {
  /** `.untangle.json`, or `.untangle/config.json` when no legacy project file exists. */
  projectConfigPath: string | undefined;
  /**
   * `untangle.toml`, layer 4b — the file `untangle init` writes. It sits
   * directly BENEATH `.untangle.json`: where both exist, the JSON file wins,
   * and `loadConfig` warns rather than picking a winner in silence.
   */
  tomlConfigPath: string | undefined;
  /** `.untangle.local.json`, layer 3 — SHOULD be gitignored (spec.md §4.1). */
  localConfigPath: string | undefined;
  /** Logical project directory for the folder layout, distinct from the config directory. */
  projectRoot?: string;
}

/** Discovers project configuration upward, without crossing a repository boundary. */
export function discoverConfigFiles(startPath: string): DiscoveredConfigFiles {
  const projectConfigPath = discoverConfigFile(startPath, PROJECT_CONFIG_FILE_NAME);
  const tomlConfigPath = discoverConfigFile(startPath, PROJECT_TOML_CONFIG_FILE_NAME);
  const folderConfigPath =
    projectConfigPath === undefined && tomlConfigPath === undefined
      ? discoverConfigFile(startPath, PROJECT_FOLDER_CONFIG_FILE_NAME)
      : undefined;
  return {
    projectConfigPath: projectConfigPath ?? folderConfigPath,
    tomlConfigPath,
    localConfigPath: discoverConfigFile(startPath, LOCAL_CONFIG_FILE_NAME),
    ...(folderConfigPath === undefined ? {} : { projectRoot: dirname(dirname(folderConfigPath)) }),
  };
}
