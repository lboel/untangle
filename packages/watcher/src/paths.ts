/**
 * Path helpers shared by the native watcher adapter, the reconciler and
 * `RepoWatcher` itself. All internal bookkeeping (snapshots, events, the
 * `ignore` predicate) uses "/"-normalized relative paths — mirroring
 * `@untangle-code/scanner`'s `ScannedFileV1.relativePath` convention — even
 * though the OS-native watch root itself is an absolute, platform-native
 * path.
 */
import nodePath from "node:path";

/** Converts an OS-native relative path (as reported by `node:fs`) to "/"-normalized form. */
export function normalizeRelativePath(raw: string): string {
  return raw.split(nodePath.sep).join("/");
}

/** Joins a "/"-normalized relative path onto an absolute, OS-native root. */
export function joinRelative(rootPath: string, relativePath: string): string {
  if (relativePath === "") {
    return rootPath;
  }
  return nodePath.join(rootPath, ...relativePath.split("/"));
}

/** True for `.git` itself and everything under it — the one built-in exclusion (see README). */
export function isDotGitPath(relativePath: string): boolean {
  return relativePath === ".git" || relativePath.startsWith(".git/");
}
