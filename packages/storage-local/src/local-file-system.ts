/**
 * `FileSystemPort` adapter backed by `node:fs/promises`, scoped to one or
 * more workspace/state roots (architecture.md §2.1, §23.1; docs/BUILD_PLAN.md
 * WP-12 acceptance: "Pfad-Sandbox, Symlink-Prüfung").
 *
 * Every method resolves its path through `assertWithinWorkspace` (domain)
 * BEFORE touching the filesystem — a lexical check that rejects `../` escapes
 * regardless of whether the path exists yet (needed for `writeFile`/`mkdir`
 * of not-yet-existing paths). Where the path (or its parent, for a
 * not-yet-existing leaf) already exists on disk, the adapter additionally
 * resolves the real, symlink-free path and re-asserts against it — the
 * "adapters are responsible for the symlink-aware part of the sandbox"
 * contract from `ports.ts`'s `FileSystemPort` doc comment. See README
 * "Entscheidungen" for the precise guarantee and its documented limits.
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  DirEntryV1,
  FileStatV1,
  FileSystemPort,
  FileWriteOptions,
  PortCallOptions,
} from "@untangle-code/domain";
import { assertWithinWorkspace, UntangleError } from "@untangle-code/domain";

import { assertNotAborted } from "./abort.js";
import { isNotFoundError } from "./fs-errors.js";

interface NodeStatsLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Resolves `candidate` as far as the real filesystem allows: walks up to the
 * nearest EXISTING ancestor, `realpath`s that ancestor, then re-appends the
 * not-yet-existing suffix segments lexically. This is what makes the
 * symlink guard correct even for paths that do not exist yet (a `writeFile`
 * target, a directory `mkdir` is about to create) AND for roots that
 * themselves contain an unresolved symlink segment (e.g. macOS'
 * `/var` → `/private/var`) — comparing an already-realpath-resolved
 * candidate against a NOT-resolved root would otherwise falsely report
 * every path under that root as an escape (the same class of bug
 * `@untangle-code/scanner`'s README "Entscheidungen" #7 documents and fixes
 * for its own, narrower realpath use). Returns `candidate` unchanged if NO
 * ancestor exists at all (e.g. the whole tree is hypothetical).
 */
async function resolveAsFarAsPossible(candidate: string): Promise<string> {
  const pendingSuffix: string[] = [];
  let probe = candidate;
  for (;;) {
    try {
      const real = await nodeFs.realpath(probe);
      return pendingSuffix.length === 0 ? real : nodePath.join(real, ...pendingSuffix.reverse());
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const parent = nodePath.dirname(probe);
      if (parent === probe) {
        // Reached the filesystem root without finding an existing ancestor.
        return candidate;
      }
      pendingSuffix.push(nodePath.basename(probe));
      probe = parent;
    }
  }
}

function kindOf(stats: NodeStatsLike): FileStatV1["kind"] {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}

function toFileStat(path: string, stats: NodeStatsLike): FileStatV1 {
  return {
    path,
    sizeBytes: stats.size,
    mtimeEpochMs: Math.trunc(stats.mtimeMs),
    kind: kindOf(stats),
  };
}

/**
 * Node-backed, path-sandboxed `FileSystemPort`. Construct one per set of
 * roots that should be reachable (typically just the `.untangle` state
 * directory for this package's own callers).
 */
export class LocalFileSystem implements FileSystemPort {
  private readonly roots: readonly string[];

  public constructor(roots: readonly string[]) {
    if (roots.length === 0) {
      throw new UntangleError("PATH_OUTSIDE_WORKSPACE", "LocalFileSystem needs at least one root", {
        operation: "local_file_system_init",
      });
    }
    this.roots = roots;
  }

  /**
   * Lexical sandbox check (throws `PATH_OUTSIDE_WORKSPACE` on escape), plus a
   * real-path re-check via {@link resolveAsFarAsPossible} on BOTH the
   * candidate and the configured roots — needed on both sides: the candidate
   * may not exist yet (`writeFile`/`mkdir` of a new entry) and a root itself
   * may contain an unresolved symlink segment (e.g. macOS'
   * `/var` → `/private/var`) that would otherwise make every path under it
   * look like an escape. Recomputed per call rather than cached, since which
   * prefix of a root already exists changes over the adapter's lifetime
   * (the root itself usually does not exist yet on first use).
   */
  private async guard(candidatePath: string): Promise<string> {
    const lexical = assertWithinWorkspace(candidatePath, this.roots);
    const resolvedCandidate = await resolveAsFarAsPossible(lexical);
    const resolvedRoots = await Promise.all(this.roots.map(resolveAsFarAsPossible));
    assertWithinWorkspace(resolvedCandidate, resolvedRoots);
    return lexical;
  }

  public async stat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    assertNotAborted(options, "stat");
    const resolved = await this.guard(path);
    try {
      const stats = await nodeFs.stat(resolved);
      return toFileStat(path, stats);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  public async lstat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    assertNotAborted(options, "lstat");
    const resolved = await this.guard(path);
    try {
      const stats = await nodeFs.lstat(resolved);
      return toFileStat(path, stats);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  public async readFile(path: string, options?: PortCallOptions): Promise<Uint8Array> {
    assertNotAborted(options, "read_file");
    const resolved = await this.guard(path);
    const buffer = await nodeFs.readFile(resolved, { signal: options?.signal });
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  public async readTextFile(path: string, options?: PortCallOptions): Promise<string> {
    assertNotAborted(options, "read_text_file");
    const resolved = await this.guard(path);
    return await nodeFs.readFile(resolved, { encoding: "utf8", signal: options?.signal });
  }

  public async readDir(path: string, options?: PortCallOptions): Promise<DirEntryV1[]> {
    assertNotAborted(options, "read_dir");
    const resolved = await this.guard(path);
    const entries = await nodeFs.readdir(resolved, { withFileTypes: true });
    return entries.map((entry) => {
      const kind: DirEntryV1["kind"] = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other";
      return { name: entry.name, path: nodePath.join(path, entry.name), kind };
    });
  }

  public async realPath(path: string, options?: PortCallOptions): Promise<string> {
    assertNotAborted(options, "real_path");
    const lexical = assertWithinWorkspace(path, this.roots);
    const real = await nodeFs.realpath(lexical);
    const resolvedRoots = await Promise.all(this.roots.map(resolveAsFarAsPossible));
    return assertWithinWorkspace(real, resolvedRoots);
  }

  public async writeFile(
    path: string,
    data: Uint8Array,
    options?: FileWriteOptions,
  ): Promise<void> {
    assertNotAborted(options, "write_file");
    const resolved = await this.guard(path);
    await nodeFs.writeFile(resolved, data, { signal: options?.signal, mode: options?.mode });
  }

  public async mkdir(
    path: string,
    options?: PortCallOptions & { recursive?: boolean },
  ): Promise<void> {
    assertNotAborted(options, "mkdir");
    const resolved = await this.guard(path);
    await nodeFs.mkdir(resolved, { recursive: options?.recursive ?? false });
  }

  public async rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    assertNotAborted(options, "rename");
    const resolvedFrom = await this.guard(from);
    const resolvedTo = await this.guard(to);
    await nodeFs.rename(resolvedFrom, resolvedTo);
  }

  public async remove(
    path: string,
    options?: PortCallOptions & { recursive?: boolean },
  ): Promise<void> {
    assertNotAborted(options, "remove");
    const resolved = await this.guard(path);
    await nodeFs.rm(resolved, { recursive: options?.recursive ?? false, force: true });
  }
}
