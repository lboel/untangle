import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";

export class PathOutsideWorkspaceError extends Error {
  readonly requestedPath: string;
  readonly workspaceRoots: readonly string[];

  constructor(requestedPath: string, workspaceRoots: readonly string[]) {
    super(`Path "${requestedPath}" resolves outside every allowed workspace root.`);
    this.name = "PathOutsideWorkspaceError";
    this.requestedPath = requestedPath;
    this.workspaceRoots = workspaceRoots;
  }
}

/** A path could not be canonicalized safely (cycle, invalid bytes, I/O). */
export class InvalidWorkspacePathError extends Error {
  readonly requestedPath: string;

  constructor(requestedPath: string, cause: unknown) {
    super(
      `Path "${requestedPath}" cannot be canonicalized safely: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "InvalidWorkspacePathError";
    this.requestedPath = requestedPath;
  }
}

/**
 * Canonicalizes an existing path, or the nearest existing ancestor plus the
 * unresolved suffix. The latter closes the common `out/new-file` case while
 * still resolving every symlink that already exists on the route.
 */
export function canonicalPotentialPath(input: string): string {
  try {
    return canonicalPotentialPathFrom(input, new Set<string>());
  } catch (error) {
    if (error instanceof InvalidWorkspacePathError) throw error;
    throw new InvalidWorkspacePathError(input, error);
  }
}

function canonicalPotentialPathFrom(input: string, visitedLinks: Set<string>): string {
  let cursor = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    const stat = lstatOrNull(cursor);
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        if (visitedLinks.has(cursor)) {
          throw new InvalidWorkspacePathError(
            input,
            new Error(`Symbolic-link cycle encountered at "${cursor}".`),
          );
        }
        visitedLinks.add(cursor);
        const target = path.resolve(path.dirname(cursor), readlinkSync(cursor));
        return canonicalPotentialPathFrom(path.resolve(target, ...suffix), visitedLinks);
      }
      return path.resolve(realpathSync(cursor), ...suffix);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(cursor, ...suffix);
}

function lstatOrNull(candidate: string): Stats | null {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function assertPathInsideWorkspace(
  requestedPath: string,
  options: { cwd: string; workspaceRoots: readonly string[] },
): string {
  let candidate: string;
  try {
    candidate = canonicalPotentialPath(path.resolve(options.cwd, requestedPath));
  } catch (error) {
    if (error instanceof InvalidWorkspacePathError) {
      throw new InvalidWorkspacePathError(requestedPath, error.cause ?? error);
    }
    throw error;
  }
  const roots = options.workspaceRoots.map(canonicalPotentialPath);
  if (!roots.some((root) => isWithin(root, candidate))) {
    throw new PathOutsideWorkspaceError(requestedPath, roots);
  }
  return candidate;
}

export function assertToolPathsInsideWorkspace(
  input: Readonly<Record<string, unknown>>,
  pathFields: readonly string[],
  options: { cwd: string; workspaceRoots: readonly string[] },
): void {
  canonicalizeToolPathsInsideWorkspace(input, pathFields, options);
}

/**
 * Prueft alle deklarierten Pfade und ersetzt sie fuer den nachfolgenden
 * Runtime-Aufruf durch ihre kanonischen absoluten Ziele. So kann ein bereits
 * aufgeloester Symlink nach der Pruefung nicht allein dadurch wieder wirksam
 * werden, dass die Runtime denselben rohen Linkpfad erneut interpretiert.
 */
export function canonicalizeToolPathsInsideWorkspace(
  input: Readonly<Record<string, unknown>>,
  pathFields: readonly string[],
  options: { cwd: string; workspaceRoots: readonly string[] },
): Record<string, unknown> {
  const canonicalInput: Record<string, unknown> = { ...input };
  const rootValue = input["root"];
  const toolCwd =
    typeof rootValue === "string" ? assertPathInsideWorkspace(rootValue, options) : options.cwd;
  if (typeof rootValue === "string") canonicalInput["root"] = toolCwd;

  for (const field of pathFields) {
    if (field === "root") continue;
    const value = input[field];
    if (typeof value === "string") {
      canonicalInput[field] = assertPathInsideWorkspace(value, { ...options, cwd: toolCwd });
      continue;
    }
    if (Array.isArray(value)) {
      canonicalInput[field] = value.map((entry) =>
        typeof entry === "string"
          ? assertPathInsideWorkspace(entry, { ...options, cwd: toolCwd })
          : entry,
      );
    }
  }
  return canonicalInput;
}
