import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "./node-file-system.js";

describe("NodeFileSystem", () => {
  let dir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "untangle-scanner-nodefs-"));
    fs = new NodeFileSystem();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads back a file written through the port", async () => {
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, new TextEncoder().encode("hello"));
    expect(await fs.readTextFile(filePath)).toBe("hello");
    const bytes = await fs.readFile(filePath);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("stat() reports file kind, size and mtime", async () => {
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, new TextEncoder().encode("hello"));
    const stat = await fs.stat(filePath);
    expect(stat).toMatchObject({ kind: "file", sizeBytes: 5 });
    expect(stat?.mtimeEpochMs).toBeGreaterThan(0);
  });

  it("stat() returns null for a missing path", async () => {
    expect(await fs.stat(path.join(dir, "missing.txt"))).toBeNull();
    expect(await fs.lstat(path.join(dir, "missing.txt"))).toBeNull();
  });

  it("readDir() lists entries with correct kinds", async () => {
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), new TextEncoder().encode("x"));
    const entries = await fs.readDir(dir);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("sub")?.kind).toBe("directory");
    expect(byName.get("file.txt")?.kind).toBe("file");
  });

  it("lstat() reports 'symlink' without following, stat() follows to the target", async () => {
    const targetPath = path.join(dir, "target.txt");
    const linkPath = path.join(dir, "link.txt");
    await fs.writeFile(targetPath, new TextEncoder().encode("payload"));
    await symlink(targetPath, linkPath);

    const linkLstat = await fs.lstat(linkPath);
    expect(linkLstat?.kind).toBe("symlink");

    const linkStat = await fs.stat(linkPath);
    expect(linkStat?.kind).toBe("file");
    expect(linkStat?.sizeBytes).toBe("payload".length);
  });

  it("readDir() reports a symlink entry's own kind, not its target's", async () => {
    const targetDir = path.join(dir, "realdir");
    await fs.mkdir(targetDir, { recursive: true });
    await symlink(targetDir, path.join(dir, "aliasdir"));

    const entries = await fs.readDir(dir);
    const alias = entries.find((e) => e.name === "aliasdir");
    expect(alias?.kind).toBe("symlink");
  });

  it("realPath() resolves a symlink to its canonical target", async () => {
    const targetPath = path.join(dir, "target.txt");
    const linkPath = path.join(dir, "link.txt");
    await fs.writeFile(targetPath, new TextEncoder().encode("payload"));
    await symlink(targetPath, linkPath);

    const resolved = await fs.realPath(linkPath);
    expect(resolved).toBe(await fs.realPath(targetPath));
  });

  it("mkdir/rename/remove round-trip", async () => {
    const dirPath = path.join(dir, "sub");
    await fs.mkdir(dirPath);
    const filePath = path.join(dirPath, "f.txt");
    await fs.writeFile(filePath, new TextEncoder().encode("x"));

    const renamedDir = path.join(dir, "sub2");
    await fs.rename(dirPath, renamedDir);
    expect(await fs.stat(path.join(renamedDir, "f.txt"))).not.toBeNull();

    await fs.remove(renamedDir, { recursive: true });
    expect(await fs.stat(renamedDir)).toBeNull();
  });

  it("honors an already-aborted signal on readFile", async () => {
    const filePath = path.join(dir, "a.txt");
    await fs.writeFile(filePath, new TextEncoder().encode("x"));
    const controller = new AbortController();
    controller.abort();
    await expect(fs.readFile(filePath, { signal: controller.signal })).rejects.toThrow();
  });
});
