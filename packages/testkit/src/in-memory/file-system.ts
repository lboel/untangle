/**
 * In-memory `FileSystemPort` (architecture.md §2.1, §23.1) — no real disk.
 *
 * Modeled closely on Node's real `fs`/`fs/promises` behavior, on purpose:
 * this is the port-contract self-test target AND the fake that other
 * packages' unit tests build workspaces against, so it needs to fail the
 * same way a real Node-backed adapter would fail, not merely "some way".
 * Concretely:
 * - errors are plain `Error` objects carrying a Node-style `.code`
 *   (`ENOENT`, `ENOTDIR`, `EISDIR`, `EEXIST`, `ENOTEMPTY`) — domain's fixed
 *   error-code enum (spec.md §25.1) has no "file not found" style code (by
 *   design: only `PATH_OUTSIDE_WORKSPACE` is filesystem-related there, a
 *   sandbox concern the port doc explicitly delegates to adapters), so
 *   mirroring `node:fs`'s own error shape is what lets one assertion work
 *   against both this fake and a real Node-backed adapter later;
 * - `writeFile` requires the parent directory to already exist (real
 *   `fs.writeFile` does not create parents);
 * - `mkdir` without `recursive` requires the parent to exist and rejects an
 *   already-existing target; `mkdir` with `recursive` is idempotent and
 *   creates missing parents, exactly like `fs.mkdir`;
 * - `remove` without `recursive` succeeds silently on an already-missing
 *   path (mirrors `NodeFileSystem`'s `fs.rm(path, { force: true, ... })`)
 *   but still rejects removing a non-empty directory;
 * - `stat`/`readFile`/`readDir`/`realPath`/`writeFile` resolve a symlink
 *   chain (bounded hop count against cycles → `ELOOP`) when the EXACT
 *   requested path is itself a symlink; a symlink appearing as a
 *   non-terminal path segment (e.g. `/repo/link/deep/file.ts` where `link`
 *   is the symlink) is not resolved mid-path — a documented simplification,
 *   never exercised by this package's own fixtures. `lstat` never resolves.
 *
 * Timestamps come from the injected `Clock` — never `Date.now()` — so a
 * test can assert exact `mtimeEpochMs` values and advance them deliberately
 * between writes (BUILD_PLAN global determinism rule).
 */
import posixPath from "node:path/posix";

import type {
  Clock,
  DirEntryV1,
  FileStatV1,
  FileSystemPort,
  PortCallOptions,
} from "@untangle-code/domain";

type MemNode =
  | { kind: "file"; content: Uint8Array; mtimeEpochMs: number }
  | { kind: "directory"; mtimeEpochMs: number }
  | { kind: "symlink"; target: string; mtimeEpochMs: number };

function normalize(path: string): string {
  const normalized = posixPath.normalize(path);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function parentOf(path: string): string {
  const parent = posixPath.dirname(path);
  return parent;
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function notFoundError(path: string, syscall: string): NodeJS.ErrnoException {
  return errnoError("ENOENT", `ENOENT: no such file or directory, ${syscall} '${path}'`);
}

export class MemoryFileSystem implements FileSystemPort {
  private readonly nodes = new Map<string, MemNode>();

  public constructor(private readonly clock: Clock) {
    this.nodes.set("/", { kind: "directory", mtimeEpochMs: this.clock.nowEpochMs() });
  }

  // -- test-setup helpers (not part of FileSystemPort) --------------------

  /** Seeds a directory node directly, without requiring the parent to exist. */
  public seedDirectory(path: string): void {
    this.nodes.set(normalize(path), { kind: "directory", mtimeEpochMs: this.clock.nowEpochMs() });
  }

  /** Seeds a file (and implicitly nothing else — parents are NOT created). */
  public seedFile(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.nodes.set(normalize(path), {
      kind: "file",
      content: bytes.slice(),
      mtimeEpochMs: this.clock.nowEpochMs(),
    });
  }

  /** Seeds a symlink node pointing at `target` (absolute, or relative to `path`'s directory). */
  public seedSymlink(path: string, target: string): void {
    this.nodes.set(normalize(path), {
      kind: "symlink",
      target,
      mtimeEpochMs: this.clock.nowEpochMs(),
    });
  }

  // -- internal lookups -----------------------------------------------------

  /**
   * A path is a directory either explicitly (a `directory` node) or
   * implicitly — any prefix of an existing node's path is a directory, even
   * without its own node (mirrors a real filesystem, where `mkdir -p`-style
   * bookkeeping is not required for every ancestor).
   */
  private getNode(path: string): MemNode | undefined {
    const explicit = this.nodes.get(path);
    if (explicit !== undefined) {
      return explicit;
    }
    const prefix = path === "/" ? "/" : `${path}/`;
    for (const key of this.nodes.keys()) {
      if (key.startsWith(prefix)) {
        return { kind: "directory", mtimeEpochMs: 0 };
      }
    }
    return undefined;
  }

  private resolveSymlinkTarget(fromPath: string, target: string): string {
    if (target.startsWith("/")) {
      return normalize(target);
    }
    return normalize(posixPath.join(parentOf(fromPath), target));
  }

  private resolveSymlinks(path: string, maxHops = 40): string {
    let current = normalize(path);
    for (let i = 0; i < maxHops; i += 1) {
      const node = this.nodes.get(current);
      if (node?.kind === "symlink") {
        current = this.resolveSymlinkTarget(current, node.target);
        continue;
      }
      return current;
    }
    throw errnoError("ELOOP", `ELOOP: too many symbolic links encountered, stat '${path}'`);
  }

  private toFileStat(path: string, node: MemNode): FileStatV1 {
    if (node.kind === "file") {
      return {
        path,
        sizeBytes: node.content.byteLength,
        mtimeEpochMs: node.mtimeEpochMs,
        kind: "file",
      };
    }
    if (node.kind === "directory") {
      return { path, sizeBytes: 0, mtimeEpochMs: node.mtimeEpochMs, kind: "directory" };
    }
    return {
      path,
      sizeBytes: node.target.length,
      mtimeEpochMs: node.mtimeEpochMs,
      kind: "symlink",
    };
  }

  private listChildNames(dirAbs: string): string[] {
    const prefix = dirAbs === "/" ? "/" : `${dirAbs}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (key === dirAbs || !key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      const separatorIndex = rest.indexOf("/");
      names.add(separatorIndex === -1 ? rest : rest.slice(0, separatorIndex));
    }
    return [...names].sort();
  }

  // -- FileSystemPort -------------------------------------------------------

  public async stat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    options?.signal?.throwIfAborted();
    let resolved: string;
    try {
      resolved = this.resolveSymlinks(path);
    } catch {
      return null;
    }
    const node = this.getNode(resolved);
    if (node === undefined) {
      return null;
    }
    return this.toFileStat(resolved, node);
  }

  public async lstat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    options?.signal?.throwIfAborted();
    const normalized = normalize(path);
    const node = this.getNode(normalized);
    if (node === undefined) {
      return null;
    }
    return this.toFileStat(normalized, node);
  }

  public async readFile(path: string, options?: PortCallOptions): Promise<Uint8Array> {
    options?.signal?.throwIfAborted();
    const resolved = this.resolveSymlinks(path);
    const node = this.getNode(resolved);
    if (node === undefined) {
      throw notFoundError(path, "open");
    }
    if (node.kind !== "file") {
      throw errnoError("EISDIR", `EISDIR: illegal operation on a directory, read '${path}'`);
    }
    return node.content.slice();
  }

  public async readTextFile(path: string, options?: PortCallOptions): Promise<string> {
    const bytes = await this.readFile(path, options);
    return new TextDecoder("utf-8").decode(bytes);
  }

  public async readDir(path: string, options?: PortCallOptions): Promise<DirEntryV1[]> {
    options?.signal?.throwIfAborted();
    const resolved = this.resolveSymlinks(path);
    const node = this.getNode(resolved);
    if (node === undefined) {
      throw notFoundError(path, "scandir");
    }
    if (node.kind !== "directory") {
      throw errnoError("ENOTDIR", `ENOTDIR: not a directory, scandir '${path}'`);
    }
    const prefix = resolved === "/" ? "/" : `${resolved}/`;
    return this.listChildNames(resolved).map((name) => {
      const childPath = `${prefix}${name}`;
      const childNode = this.getNode(childPath);
      const kind: DirEntryV1["kind"] = childNode === undefined ? "other" : childNode.kind;
      return { name, path: childPath, kind };
    });
  }

  public async realPath(path: string, options?: PortCallOptions): Promise<string> {
    options?.signal?.throwIfAborted();
    const resolved = this.resolveSymlinks(path);
    if (this.getNode(resolved) === undefined) {
      throw notFoundError(path, "realpath");
    }
    return resolved;
  }

  public async writeFile(path: string, data: Uint8Array, options?: PortCallOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    // Follow a symlink at the target path itself (real `fs.writeFile` does
    // too) — only the FINAL component; a symlink partway through the
    // parent chain is not resolved (documented simplification, see class
    // doc comment).
    const normalized = this.resolveSymlinks(path);
    const parent = parentOf(normalized);
    const parentNode = this.getNode(parent);
    if (parentNode === undefined) {
      throw notFoundError(path, "open");
    }
    if (parentNode.kind !== "directory") {
      throw errnoError("ENOTDIR", `ENOTDIR: not a directory, open '${path}'`);
    }
    const existing = this.nodes.get(normalized);
    if (existing?.kind === "directory") {
      throw errnoError("EISDIR", `EISDIR: illegal operation on a directory, open '${path}'`);
    }
    this.nodes.set(normalized, {
      kind: "file",
      content: data.slice(),
      mtimeEpochMs: this.clock.nowEpochMs(),
    });
  }

  public async mkdir(
    path: string,
    options?: PortCallOptions & { recursive?: boolean },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const normalized = normalize(path);
    const recursive = options?.recursive ?? false;
    const existing = this.getNode(normalized);
    if (existing !== undefined) {
      if (recursive && existing.kind === "directory") {
        return;
      }
      throw errnoError("EEXIST", `EEXIST: file already exists, mkdir '${path}'`);
    }
    if (!recursive) {
      const parentNode = this.getNode(parentOf(normalized));
      if (parentNode === undefined) {
        throw notFoundError(path, "mkdir");
      }
      if (parentNode.kind !== "directory") {
        throw errnoError("ENOTDIR", `ENOTDIR: not a directory, mkdir '${path}'`);
      }
      this.nodes.set(normalized, { kind: "directory", mtimeEpochMs: this.clock.nowEpochMs() });
      return;
    }
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    let built = "";
    for (const segment of segments) {
      built = `${built}/${segment}`;
      const node = this.nodes.get(built);
      if (node === undefined) {
        this.nodes.set(built, { kind: "directory", mtimeEpochMs: this.clock.nowEpochMs() });
      } else if (node.kind !== "directory") {
        throw errnoError("ENOTDIR", `ENOTDIR: not a directory, mkdir '${path}'`);
      }
    }
  }

  public async rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    const fromNorm = normalize(from);
    const toNorm = normalize(to);
    if (this.getNode(fromNorm) === undefined) {
      throw notFoundError(from, "rename");
    }
    const toParentNode = this.getNode(parentOf(toNorm));
    if (toParentNode === undefined) {
      throw notFoundError(to, "rename");
    }
    const fromPrefix = `${fromNorm}/`;
    const toMove: Array<[string, MemNode]> = [];
    for (const [key, node] of this.nodes.entries()) {
      if (key === fromNorm || key.startsWith(fromPrefix)) {
        toMove.push([key, node]);
      }
    }
    for (const [key] of toMove) {
      this.nodes.delete(key);
    }
    for (const [key, node] of toMove) {
      const newKey = key === fromNorm ? toNorm : `${toNorm}${key.slice(fromNorm.length)}`;
      this.nodes.set(newKey, node);
    }
  }

  public async remove(
    path: string,
    options?: PortCallOptions & { recursive?: boolean },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const normalized = normalize(path);
    const node = this.getNode(normalized);
    if (node === undefined) {
      // Mirrors `NodeFileSystem.remove`, which always calls Node's
      // `fs.rm(path, { force: true, ... })`: a missing path is not an error.
      return;
    }
    const recursive = options?.recursive ?? false;
    if (node.kind === "directory") {
      const hasChildren = this.listChildNames(normalized).length > 0;
      if (hasChildren && !recursive) {
        throw errnoError("ENOTEMPTY", `ENOTEMPTY: directory not empty, rmdir '${path}'`);
      }
    }
    this.nodes.delete(normalized);
    if (recursive) {
      const prefix = `${normalized}/`;
      for (const key of [...this.nodes.keys()]) {
        if (key.startsWith(prefix)) {
          this.nodes.delete(key);
        }
      }
    }
  }
}
