/**
 * Node.js implementation of `FileSystemPort` (domain). This is the only
 * file in the package allowed to import `node:fs` — the core (`../index.ts`)
 * stays testable against any port implementation, this adapter is what
 * production code actually wires up.
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  DirEntryV1,
  FileStatV1,
  FileSystemPort,
  PortCallOptions,
} from "@untangle-code/domain";

interface NodeStatsLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Production `FileSystemPort` adapter backed by `node:fs/promises`. */
export class NodeFileSystem implements FileSystemPort {
  public async stat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    options?.signal?.throwIfAborted();
    try {
      const stats = await nodeFs.stat(path);
      return toFileStat(path, stats);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  public async lstat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    options?.signal?.throwIfAborted();
    try {
      const stats = await nodeFs.lstat(path);
      return toFileStat(path, stats);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  public async readFile(path: string, options?: PortCallOptions): Promise<Uint8Array> {
    const buffer = await nodeFs.readFile(path, { signal: options?.signal });
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  public async readTextFile(path: string, options?: PortCallOptions): Promise<string> {
    return await nodeFs.readFile(path, { encoding: "utf8", signal: options?.signal });
  }

  public async readDir(path: string, options?: PortCallOptions): Promise<DirEntryV1[]> {
    options?.signal?.throwIfAborted();
    const entries = await nodeFs.readdir(path, { withFileTypes: true });
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
    options?.signal?.throwIfAborted();
    return await nodeFs.realpath(path);
  }

  public async writeFile(path: string, data: Uint8Array, options?: PortCallOptions): Promise<void> {
    await nodeFs.writeFile(path, data, { signal: options?.signal });
  }

  public async mkdir(
    path: string,
    options?: PortCallOptions & { recursive?: boolean },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await nodeFs.mkdir(path, { recursive: options?.recursive ?? false });
  }

  public async rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await nodeFs.rename(from, to);
  }

  public async remove(
    path: string,
    options?: PortCallOptions & { recursive?: boolean },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await nodeFs.rm(path, { recursive: options?.recursive ?? false, force: true });
  }
}
