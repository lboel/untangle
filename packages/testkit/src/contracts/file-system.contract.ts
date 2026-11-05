/**
 * Port-contract suite for `FileSystemPort` (domain `ports.ts`,
 * architecture.md §2.1, §23.1).
 *
 * Every adapter under test is given its own throwaway root directory (see
 * `factory`'s contract below) so the suite can freely create, rename and
 * remove paths without adapters colliding with each other or with a real
 * project tree.
 *
 * Deliberately OUT of scope (documented, see README "Entscheidungen"):
 * - the symlink-aware part of the path sandbox (`realPath` +
 *   `assertWithinWorkspace` re-check) — ports.ts explicitly assigns this to
 *   adapters, not the port itself, so it is not a generic conformance
 *   property; symlink support beyond `lstat` reporting the right `kind` is
 *   likewise not asserted here, since it is documented as a simplification
 *   even in this package's own `MemoryFileSystem`;
 * - exact Node `.code` values (`ENOENT`, `EISDIR`, …) — asserted only
 *   loosely (that these operations reject at all) because they are an
 *   adapter/OS-specific string, not part of the `FileSystemPort` type
 *   itself; a Node-backed adapter's own test suite is the right place to
 *   pin the exact codes.
 */
import type { FileSystemPort } from "@untangle-code/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** One throwaway root per test; adapters can be given a temp directory. */
export interface FileSystemContractContext {
  fs: FileSystemPort;
  /** Absolute path of an empty directory the suite may use freely. */
  root: string;
  /** Called after each test to release whatever `factory` allocated. */
  cleanup?: () => Promise<void> | void;
}

function joinPath(root: string, ...segments: string[]): string {
  return [root.replace(/\/+$/, ""), ...segments].join("/");
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function runFileSystemContract(
  factory: () => FileSystemContractContext | Promise<FileSystemContractContext>,
): void {
  describe("FileSystemPort port contract", () => {
    let fs: FileSystemPort;
    let root: string;
    let cleanup: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const context = await factory();
      fs = context.fs;
      root = context.root;
      cleanup = context.cleanup;
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it("stat/lstat return null for a path that does not exist", async () => {
      expect(await fs.stat(joinPath(root, "nope.txt"))).toBeNull();
      expect(await fs.lstat(joinPath(root, "nope.txt"))).toBeNull();
    });

    it("writeFile then readFile round-trips the exact bytes", async () => {
      const path = joinPath(root, "file.txt");
      await fs.writeFile(path, encode("hello world"));
      expect(decode(await fs.readFile(path))).toBe("hello world");
    });

    it("readTextFile decodes UTF-8 the same way readFile + TextDecoder would", async () => {
      const path = joinPath(root, "text.txt");
      await fs.writeFile(path, encode("héllo"));
      expect(await fs.readTextFile(path)).toBe("héllo");
    });

    it("stat reports the correct kind and size for a file", async () => {
      const path = joinPath(root, "file.txt");
      await fs.writeFile(path, encode("12345"));
      const stat = await fs.stat(path);
      expect(stat?.kind).toBe("file");
      expect(stat?.sizeBytes).toBe(5);
    });

    it("mkdir then stat reports a directory", async () => {
      const dir = joinPath(root, "dir");
      await fs.mkdir(dir);
      expect((await fs.stat(dir))?.kind).toBe("directory");
    });

    it("mkdir with recursive creates missing parents", async () => {
      const dir = joinPath(root, "a", "b", "c");
      await fs.mkdir(dir, { recursive: true });
      expect((await fs.stat(dir))?.kind).toBe("directory");
    });

    it("readDir lists exactly the immediate children of a directory", async () => {
      const dir = joinPath(root, "listed");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(joinPath(dir, "a.txt"), encode("a"));
      await fs.mkdir(joinPath(dir, "sub"));
      const entries = await fs.readDir(dir);
      expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "sub"]);
    });

    it("readFile on a missing path rejects rather than returning empty content", async () => {
      await expect(fs.readFile(joinPath(root, "missing.txt"))).rejects.toBeDefined();
    });

    it("readFile on a directory rejects rather than returning content", async () => {
      const dir = joinPath(root, "adir");
      await fs.mkdir(dir);
      await expect(fs.readFile(dir)).rejects.toBeDefined();
    });

    it("realPath on an existing path resolves without throwing", async () => {
      const path = joinPath(root, "file.txt");
      await fs.writeFile(path, encode("x"));
      await expect(fs.realPath(path)).resolves.toEqual(expect.any(String));
    });

    it("realPath on a missing path rejects", async () => {
      await expect(fs.realPath(joinPath(root, "missing.txt"))).rejects.toBeDefined();
    });

    it("rename moves a file so it reads from the new path and not the old one", async () => {
      const from = joinPath(root, "from.txt");
      const to = joinPath(root, "to.txt");
      await fs.writeFile(from, encode("payload"));
      await fs.rename(from, to);
      expect(await fs.stat(from)).toBeNull();
      expect(decode(await fs.readFile(to))).toBe("payload");
    });

    it("remove deletes a file", async () => {
      const path = joinPath(root, "gone.txt");
      await fs.writeFile(path, encode("x"));
      await fs.remove(path);
      expect(await fs.stat(path)).toBeNull();
    });

    it("remove with recursive deletes a non-empty directory and its contents", async () => {
      const dir = joinPath(root, "tree");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(joinPath(dir, "leaf.txt"), encode("x"));
      await fs.remove(dir, { recursive: true });
      expect(await fs.stat(dir)).toBeNull();
    });

    it("remove on an already-missing path does not throw", async () => {
      await expect(fs.remove(joinPath(root, "never-existed.txt"))).resolves.toBeUndefined();
    });

    describe("AbortSignal (spec.md §22)", () => {
      it("rejects every method when the signal is already aborted", async () => {
        const path = joinPath(root, "file.txt");
        await fs.writeFile(path, encode("x"));
        const controller = new AbortController();
        controller.abort();
        const signal = controller.signal;
        await expect(fs.stat(path, { signal })).rejects.toBeDefined();
        await expect(fs.lstat(path, { signal })).rejects.toBeDefined();
        await expect(fs.readFile(path, { signal })).rejects.toBeDefined();
        await expect(fs.readTextFile(path, { signal })).rejects.toBeDefined();
        await expect(fs.readDir(root, { signal })).rejects.toBeDefined();
        await expect(fs.realPath(path, { signal })).rejects.toBeDefined();
        await expect(fs.writeFile(path, encode("y"), { signal })).rejects.toBeDefined();
        await expect(fs.mkdir(joinPath(root, "d"), { signal })).rejects.toBeDefined();
        await expect(fs.rename(path, joinPath(root, "y.txt"), { signal })).rejects.toBeDefined();
        await expect(fs.remove(path, { signal })).rejects.toBeDefined();
      });
    });
  });
}
