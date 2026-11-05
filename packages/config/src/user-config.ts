/**
 * User configuration location (spec.md §4.1 layer 5: "Nutzerkonfiguration im
 * OS-Konfigurationsverzeichnis"). The exact directory and file name are an
 * Untangle decision — spec.md does not name them.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const USER_CONFIG_FILE_NAME = "config.json";

/**
 * Resolves the per-OS Untangle config directory:
 * - Linux: `$XDG_CONFIG_HOME/untangle` or `~/.config/untangle`;
 * - macOS: `~/Library/Application Support/untangle`;
 * - Windows: `%APPDATA%\untangle` or `~/AppData/Roaming/untangle`.
 *
 * `env` and `platform` are injectable for deterministic tests.
 */
export function resolveUserConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const appData = env["APPDATA"];
    return join(
      appData && appData.length > 0 ? appData : join(homedir(), "AppData", "Roaming"),
      "untangle",
    );
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "untangle");
  }
  const xdgConfigHome = env["XDG_CONFIG_HOME"];
  return join(
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), ".config"),
    "untangle",
  );
}

/** Full path to the user config file, or `undefined` when it does not exist. */
export function resolveUserConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const candidate = join(resolveUserConfigDir(env, platform), USER_CONFIG_FILE_NAME);
  return existsSync(candidate) ? candidate : undefined;
}
