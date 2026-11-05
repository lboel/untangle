import { describe, expect, it } from "vitest";

import { FakeClock } from "./clock.js";
import { MemoryFileSystem } from "./file-system.js";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("MemoryFileSystem", () => {
  it("stat/lstat return null for a path that does not exist", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    expect(await fs.stat("/nope")).toBeNull();
    expect(await fs.lstat("/nope")).toBeNull();
  });

  it("writeFile requires the parent directory to already exist (ENOENT otherwise)", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await expect(fs.writeFile("/no/such/dir/file.txt", new Uint8Array())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writeFile then readFile/readTextFile round-trips the exact bytes", async () => {
    const fs = new MemoryFileSystem(new FakeClock(1_000));
    await fs.writeFile("/file.txt", new TextEncoder().encode("hello world"));
    expect(decode(await fs.readFile("/file.txt"))).toBe("hello world");
    expect(await fs.readTextFile("/file.txt")).toBe("hello world");
  });

  it("writeFile stamps mtimeEpochMs from the injected Clock", async () => {
    const clock = new FakeClock(500);
    const fs = new MemoryFileSystem(clock);
    await fs.writeFile("/a.txt", new TextEncoder().encode("a"));
    const stat = await fs.stat("/a.txt");
    expect(stat?.mtimeEpochMs).toBe(500);
    clock.advance(250);
    await fs.writeFile("/a.txt", new TextEncoder().encode("aa"));
    const restat = await fs.stat("/a.txt");
    expect(restat?.mtimeEpochMs).toBe(750);
    expect(restat?.sizeBytes).toBe(2);
  });

  it("readFile on a directory throws EISDIR", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.mkdir("/dir");
    await expect(fs.readFile("/dir")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("readDir lists immediate children only, with kinds", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.mkdir("/repo");
    await fs.mkdir("/repo/src");
    await fs.writeFile("/repo/README.md", new TextEncoder().encode("# hi"));
    await fs.writeFile("/repo/src/index.ts", new TextEncoder().encode("export {};"));

    const entries = await fs.readDir("/repo");
    expect(entries.map((e) => e.name).sort()).toEqual(["README.md", "src"]);
    const src = entries.find((e) => e.name === "src");
    expect(src?.kind).toBe("directory");
    const readme = entries.find((e) => e.name === "README.md");
    expect(readme?.kind).toBe("file");
  });

  it("readDir on a missing path throws ENOENT; on a file throws ENOTDIR", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.writeFile("/a.txt", new TextEncoder().encode("a"));
    await expect(fs.readDir("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readDir("/a.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("directories exist implicitly once any descendant file exists, even without their own node (e.g. after seedFile in test setup)", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    // Seeded directly, bypassing writeFile's own parent-must-exist check —
    // exercises the fallback in `getNode()` that a real filesystem gives
    // for free, useful when test setup seeds deep paths without seeding
    // every ancestor directory individually.
    fs.seedFile("/a/b/c.txt", "nope");
    expect((await fs.stat("/a"))?.kind).toBe("directory");
    expect((await fs.stat("/a/b"))?.kind).toBe("directory");
    expect(await fs.readDir("/a")).toEqual([{ name: "b", path: "/a/b", kind: "directory" }]);
  });

  it("mkdir without recursive requires the parent to exist and rejects an existing target", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await expect(fs.mkdir("/a/b")).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir("/a");
    await expect(fs.mkdir("/a")).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("mkdir with recursive creates missing parents and is idempotent", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.mkdir("/a/b/c", { recursive: true });
    expect((await fs.stat("/a"))?.kind).toBe("directory");
    expect((await fs.stat("/a/b"))?.kind).toBe("directory");
    expect((await fs.stat("/a/b/c"))?.kind).toBe("directory");
    await expect(fs.mkdir("/a/b/c", { recursive: true })).resolves.toBeUndefined();
  });

  it("rename moves a file, including across directories", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.mkdir("/dst", { recursive: true });
    await fs.writeFile("/src.txt", new TextEncoder().encode("payload"));
    await fs.rename("/src.txt", "/dst/renamed.txt");
    expect(await fs.stat("/src.txt")).toBeNull();
    expect(decode(await fs.readFile("/dst/renamed.txt"))).toBe("payload");
  });

  it("rename moves an entire directory subtree", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.mkdir("/old/nested", { recursive: true });
    await fs.writeFile("/old/nested/file.txt", new TextEncoder().encode("x"));
    await fs.rename("/old", "/new");
    expect(await fs.stat("/old")).toBeNull();
    expect(decode(await fs.readFile("/new/nested/file.txt"))).toBe("x");
  });

  it("rename of a non-existent source throws ENOENT", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await expect(fs.rename("/missing", "/dst")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("remove is a no-op (force-like) on an already-missing path", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await expect(fs.remove("/missing")).resolves.toBeUndefined();
  });

  it("remove without recursive on a non-empty directory throws ENOTEMPTY", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.mkdir("/dir");
    await fs.writeFile("/dir/file.txt", new TextEncoder().encode("x"));
    await expect(fs.remove("/dir")).rejects.toMatchObject({ code: "ENOTEMPTY" });
  });

  it("remove with recursive deletes a directory and everything under it", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.mkdir("/dir/nested", { recursive: true });
    await fs.writeFile("/dir/nested/file.txt", new TextEncoder().encode("x"));
    await fs.remove("/dir", { recursive: true });
    expect(await fs.stat("/dir")).toBeNull();
    expect(await fs.stat("/dir/nested/file.txt")).toBeNull();
  });

  it("realPath resolves a symlink chain to its final target", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.writeFile("/real.txt", new TextEncoder().encode("data"));
    fs.seedSymlink("/link.txt", "/real.txt");
    expect(await fs.realPath("/link.txt")).toBe("/real.txt");
    expect(decode(await fs.readFile("/link.txt"))).toBe("data");
  });

  it("realPath throws ELOOP on a symlink cycle", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    fs.seedSymlink("/a", "/b");
    fs.seedSymlink("/b", "/a");
    await expect(fs.realPath("/a")).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("lstat reports a symlink's own kind, never following it", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.writeFile("/real.txt", new TextEncoder().encode("data"));
    fs.seedSymlink("/link.txt", "/real.txt");
    expect((await fs.lstat("/link.txt"))?.kind).toBe("symlink");
    expect((await fs.stat("/link.txt"))?.kind).toBe("file");
  });

  it("respects an already-aborted signal on every method", async () => {
    const fs = new MemoryFileSystem(new FakeClock(0));
    await fs.writeFile("/a.txt", new TextEncoder().encode("a"));
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    await expect(fs.stat("/a.txt", { signal })).rejects.toThrow();
    await expect(fs.lstat("/a.txt", { signal })).rejects.toThrow();
    await expect(fs.readFile("/a.txt", { signal })).rejects.toThrow();
    await expect(fs.readTextFile("/a.txt", { signal })).rejects.toThrow();
    await expect(fs.readDir("/", { signal })).rejects.toThrow();
    await expect(fs.realPath("/a.txt", { signal })).rejects.toThrow();
    await expect(fs.writeFile("/a.txt", new Uint8Array(), { signal })).rejects.toThrow();
    await expect(fs.mkdir("/dir", { signal })).rejects.toThrow();
    await expect(fs.rename("/a.txt", "/b.txt", { signal })).rejects.toThrow();
    await expect(fs.remove("/a.txt", { signal })).rejects.toThrow();
  });
});
