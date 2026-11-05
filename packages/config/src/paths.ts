/**
 * Path resolution relative to the configuration file (spec.md §4.3:
 * "Pfade MÜSSEN relativ zur Konfigurationsdatei oder absolut auflösbar
 * sein."). Results are canonical: absolute, `/`-separated, no trailing slash,
 * no `.`/`..` segments.
 */
import { isAbsolute, resolve, sep } from "node:path";

/** Canonicalizes a resolved absolute filesystem path to forward slashes, no trailing slash. */
function toCanonicalAbsolute(absolutePath: string): string {
  const normalized = absolutePath.split(sep).join("/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Resolves `candidatePath` against `configFileDir` (the directory containing
 * the config file that declared it). An already-absolute `candidatePath` is
 * returned canonicalized as-is (spec.md §4.3 allows absolute paths).
 */
export function resolveConfigPath(candidatePath: string, configFileDir: string): string {
  const absolute = isAbsolute(candidatePath)
    ? candidatePath
    : resolve(configFileDir, candidatePath);
  return toCanonicalAbsolute(absolute);
}

/**
 * Resolves every `RepositoryConfig.path` in `repositories` relative to
 * `configFileDir`, returning new objects (inputs are not mutated).
 */
export function resolveRepositoryPaths<T extends { path: string }>(
  repositories: readonly T[],
  configFileDir: string,
): T[] {
  return repositories.map((repo) => ({
    ...repo,
    path: resolveConfigPath(repo.path, configFileDir),
  }));
}
