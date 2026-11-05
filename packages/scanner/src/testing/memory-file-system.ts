/**
 * A minimal in-memory `FileSystemPort` implementation for tests. Not part
 * of the package's public surface (only `../index.ts` is) — imported
 * directly by co-located `*.test.ts` files instead.
 *
 * Simplifications documented because this is test-only, never shipped:
 * - symlink resolution follows a chain only when the *exact* requested path
 *   is itself a registered symlink node; a symlink appearing as a
 *   non-terminal path segment (e.g. `/repo/link/deep/file.ts` where `link`
 *   is the symlink) is not resolved mid-path. Tests build symlink targets
 *   by calling `realPath`/`stat` directly on the symlink's own path, which
 *   this covers exactly.
 * - `writeFile`/`mkdir`/`rename`/`remove` are implemented functionally but
 *   without every POSIX edge case (e.g. ENOTEMPTY on a non-recursive
 *   directory removal) — the scanner itself never calls them.
 */
import posixPath from "node:path/posix";

import type {
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

function notFoundError(path: string, syscall: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, ${syscall} '${path}'`,
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

export class MemoryFileSystem implements FileSystemPort {
  private readonly nodes = new Map<string, MemNode>();

  public constructor() {
    this.nodes.set("/", { kind: "directory", mtimeEpochMs: 0 });
  }

  // -- test-setup helpers ----------------------------------------------

  public addDirectory(path: string, mtimeEpochMs = 0): void {
    this.nodes.set(normalize(path), { kind: "directory", mtimeEpochMs });
  }

  public addFile(path: string, content: string | Uint8Array, mtimeEpochMs = 0): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.nodes.set(normalize(path), { kind: "file", content: bytes, mtimeEpochMs });
  }

  public addSymlink(path: string, target: string, mtimeEpochMs = 0): void {
    this.nodes.set(normalize(path), { kind: "symlink", target, mtimeEpochMs });
  }

  // -- internal lookups ---------------------------------------------------

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

  private resolveTarget(fromPath: string, target: string): string {
    if (target.startsWith("/")) {
      return normalize(target);
    }
    const dir = fromPath.slice(0, fromPath.lastIndexOf("/")) || "/";
    return normalize(`${dir}/${target}`);
  }

  private resolveSymlinks(path: string, maxHops = 40): string {
    let current = normalize(path);
    for (let i = 0; i < maxHops; i += 1) {
      const node = this.nodes.get(current);
      if (node?.kind === "symlink") {
        current = this.resolveTarget(current, node.target);
        continue;
      }
      return current;
    }
    const error = new Error(
      `ELOOP: too many symbolic links encountered, stat '${path}'`,
    ) as NodeJS.ErrnoException;
    error.code = "ELOOP";
    throw error;
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

  private list(dirAbs: string): string[] {
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
    return [...names];
  }

  // -- FileSystemPort -------------------------------------------------

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
      throw notFoundError(path, "read");
    }
    if (node.kind !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
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
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }
    const prefix = resolved === "/" ? "/" : `${resolved}/`;
    return this.list(resolved).map((name) => {
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
    this.nodes.set(normalize(path), { kind: "file", content: data.slice(), mtimeEpochMs: 0 });
  }

  public async mkdir(
    path: string,
    options?: PortCallOptions & { recursive?: boolean },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    this.nodes.set(normalize(path), { kind: "directory", mtimeEpochMs: 0 });
  }

  public async rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    const fromNorm = normalize(from);
    const toNorm = normalize(to);
    const fromPrefix = `${fromNorm}/`;
    const toMove: Array<[string, MemNode]> = [];
    for (const [key, node] of this.nodes.entries()) {
      if (key === fromNorm || key.startsWith(fromPrefix)) {
        toMove.push([key, node]);
      }
    }
    for (const [key, node] of toMove) {
      this.nodes.delete(key);
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
    this.nodes.delete(normalized);
    if (options?.recursive === true) {
      const prefix = `${normalized}/`;
      for (const key of [...this.nodes.keys()]) {
        if (key.startsWith(prefix)) {
          this.nodes.delete(key);
        }
      }
    }
  }
}
