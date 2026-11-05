/**
 * End-to-end proof that the pure core (`discoverFiles`) works correctly
 * against the real Node adapter and a real filesystem — not just against
 * `MemoryFileSystem` (see `../discovery.test.ts` for the exhaustive,
 * fast, in-memory coverage of every case from the WP-05 order).
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFiles } from "../discovery.js";
import type { ScannedFileV1 } from "../types.js";

import { NodeFileSystem } from "./node-file-system.js";

async function collectPaths(iterable: AsyncIterable<ScannedFileV1>): Promise<string[]> {
  const out: string[] = [];
  for await (const file of iterable) {
    out.push(file.relativePath);
  }
  return out.sort();
}

describe("discoverFiles + NodeFileSystem (real filesystem)", () => {
  let repoRoot: string;
  let outsideRoot: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "untangle-scanner-e2e-"));
    repoRoot = path.join(base, "repo");
    outsideRoot = path.join(base, "outside");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    fs = new NodeFileSystem();
  });

  afterEach(async () => {
    await rm(path.dirname(repoRoot), { recursive: true, force: true });
  });

  it("discovers real files while applying default excludes", async () => {
    await writeFile(path.join(repoRoot, "index.ts"), "export const a = 1;\n");
    await mkdir(path.join(repoRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(repoRoot, "node_modules", "pkg", "index.js"), "vendored");

    const paths = await collectPaths(discoverFiles({ fs, roots: [repoRoot], repoRoot }));
    expect(paths).toEqual(["index.ts"]);
  });

  it("rejects a real symlink escaping the workspace root", async () => {
    await writeFile(path.join(outsideRoot, "secret.txt"), "do not index");
    await writeFile(path.join(repoRoot, "legit.txt"), "fine");
    await symlink(path.join(outsideRoot, "secret.txt"), path.join(repoRoot, "escape"));

    const skips: Array<{ relativePath: string; reason: string }> = [];
    const paths = await collectPaths(
      discoverFiles({ fs, roots: [repoRoot], repoRoot, onSkip: (s) => skips.push(s) }),
    );

    expect(paths).toEqual(["legit.txt"]);
    expect(skips).toContainEqual(
      expect.objectContaining({ relativePath: "escape", reason: "symlink-escape" }),
    );
  });

  it("terminates on a real directory symlink cycle", async () => {
    await mkdir(path.join(repoRoot, "sub"), { recursive: true });
    await writeFile(path.join(repoRoot, "sub", "real.txt"), "hello");
    await symlink(path.join(repoRoot, "sub"), path.join(repoRoot, "sub", "back"));

    const paths = await collectPaths(discoverFiles({ fs, roots: [repoRoot], repoRoot }));
    expect(paths).toEqual(["sub/real.txt"]);
  });

  it("produces a real, stable SHA-256 content hash", async () => {
    await writeFile(path.join(repoRoot, "a.ts"), "export const a = 1;\n");

    const files: ScannedFileV1[] = [];
    for await (const file of discoverFiles({ fs, roots: [repoRoot], repoRoot })) {
      files.push(file);
    }
    expect(files).toHaveLength(1);
    expect(files[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
