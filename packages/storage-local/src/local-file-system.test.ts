import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runFileSystemContract } from "@untangle-code/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { LocalFileSystem } from "./local-file-system.js";

runFileSystemContract(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-fs-"));
  const root = path.join(base, "state");
  await mkdir(root, { recursive: true });
  return {
    fs: new LocalFileSystem([root]),
    root,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
});

describe("LocalFileSystem — path sandbox (architecture.md §23.1)", () => {
  let base: string;
  let root: string;
  let outside: string;
  let fs: LocalFileSystem;

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function setUp(): Promise<void> {
    base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-sandbox-"));
    root = path.join(base, "state");
    outside = path.join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    fs = new LocalFileSystem([root]);
  }

  it("rejects a lexical '..' escape on writeFile", async () => {
    await setUp();
    const escapePath = path.join(root, "..", "outside", "evil.txt");
    await expect(fs.writeFile(escapePath, new TextEncoder().encode("x"))).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("rejects reading a path lexically outside all roots", async () => {
    await setUp();
    await expect(fs.readFile(outside)).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("rejects a real symlink whose target escapes the root", async () => {
    await setUp();
    await writeFile(path.join(outside, "secret.txt"), "do not read");
    const linkPath = path.join(root, "escape-link");
    await symlink(path.join(outside, "secret.txt"), linkPath);
    await expect(fs.readFile(linkPath)).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("rejects writing into a new file under a symlinked directory that escapes the root", async () => {
    await setUp();
    const linkedDir = path.join(root, "linked-dir");
    await symlink(outside, linkedDir);
    const newFilePath = path.join(linkedDir, "new-file.txt");
    await expect(fs.writeFile(newFilePath, new TextEncoder().encode("x"))).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("allows a path that stays within the root after '..' segments cancel out", async () => {
    await setUp();
    const withinPath = path.join(root, "sub", "..", "file.txt");
    await fs.writeFile(withinPath, new TextEncoder().encode("ok"));
    expect(await fs.readTextFile(path.join(root, "file.txt"))).toBe("ok");
  });

  it("accepts a genuine, real symlink that resolves back inside the root", async () => {
    await setUp();
    const targetDir = path.join(root, "real-target");
    await mkdir(targetDir, { recursive: true });
    const linkPath = path.join(root, "internal-link");
    await symlink(targetDir, linkPath);
    await fs.writeFile(path.join(linkPath, "f.txt"), new TextEncoder().encode("hi"));
    expect(await fs.readTextFile(path.join(targetDir, "f.txt"))).toBe("hi");
  });

  it("throws on construction with zero roots", () => {
    expect(() => new LocalFileSystem([])).toThrow();
  });
});
