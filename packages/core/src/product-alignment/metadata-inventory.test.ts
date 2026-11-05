import { discoverFiles } from "@untangle-code/scanner";
import type { ScannedFileV1 } from "@untangle-code/scanner";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { collectProductInventory, createProductInventory } from "./analysis.js";

const root = "/workspace/product-metadata";
const source = "export const feature = true;\n";

function project(contents: Record<string, string> = {}): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock(100));
  fs.seedDirectory(root);
  fs.seedFile(`${root}/main.ts`, source);
  for (const [file, text] of Object.entries(contents)) fs.seedFile(`${root}/${file}`, text);
  return fs;
}

describe("product inventory excludes its root-owned metadata", () => {
  it("keeps the digest stable as index outputs are added, updated and deleted but detects source edits", async () => {
    const fs = project();
    const before = await collectProductInventory({ root, fs });
    fs.seedFile(`${root}/.untangle/index-state.json`, '{"revision":1}');
    fs.seedFile(`${root}/.untangle/graphs/imports.json`, '{"edges":[]}');
    const added = await collectProductInventory({ root, fs });
    fs.seedFile(`${root}/.untangle/index-state.json`, '{"revision":2}');
    fs.seedFile(`${root}/.untangle/reports/product.json`, '{"status":"ready"}');
    const updated = await collectProductInventory({ root, fs });
    await fs.remove(`${root}/.untangle`, { recursive: true });
    const deleted = await collectProductInventory({ root, fs });
    for (const inventory of [added, updated, deleted]) {
      expect(inventory.sourceTreeDigest).toBe(before.sourceTreeDigest);
      expect(inventory.files).toEqual(before.files);
      expect(inventory.truncated).toBe(false);
    }
    expect(added.excluded).toBe(1);
    expect(updated.excluded).toBe(1);
    expect(deleted.excluded).toBe(0);
    fs.seedFile(`${root}/main.ts`, "export const feature = false;\n");
    expect((await collectProductInventory({ root, fs })).sourceTreeDigest).not.toBe(
      before.sourceTreeDigest,
    );
  });

  it("prunes metadata before the file cap while retaining truncation for an actual additional source", async () => {
    const fs = project();
    for (let index = 0; index < 20; index++)
      fs.seedFile(`${root}/.untangle/index/chunk-${index}.ts`, source);
    const scope = { maxFilesScanned: 1, concurrency: 1 };
    const inventory = await collectProductInventory({ root, fs, scope });
    expect(inventory.files.map((file) => file.relativePath)).toEqual(["main.ts"]);
    expect(inventory.truncated).toBe(false);
    expect(inventory.excluded).toBe(1);
    fs.seedFile(`${root}/second.ts`, source);
    expect((await collectProductInventory({ root, fs, scope })).truncated).toBe(true);
  });

  it("does not mark an inventory containing only metadata as truncated with a zero-file cap", async () => {
    const fs = project({ ".untangle/receipt.json": "{}" });
    await fs.remove(`${root}/main.ts`);
    const inventory = await collectProductInventory({
      root,
      fs,
      scope: { maxFilesScanned: 0 },
    });
    expect(inventory.files).toEqual([]);
    expect(inventory.truncated).toBe(false);
    expect(inventory.excluded).toBe(1);
  });

  it.each([".gitignore", ".untangleignore"])(
    "keeps re-included root metadata out of the cap and digest with %s negations",
    async (ignoreFile) => {
      const fs = project({ [ignoreFile]: "!/.untangle/\n!/.untangle/**\n" });
      const scope = { maxFilesScanned: 2, concurrency: 1 };
      const before = await collectProductInventory({ root, fs, scope });
      fs.seedFile(`${root}/.untangle/index-state.json`, "{}");
      fs.seedFile(`${root}/.untangle/chunks/state.ts`, source);
      const after = await collectProductInventory({ root, fs, scope });
      expect(after.files.map((file) => file.relativePath)).toEqual([ignoreFile, "main.ts"]);
      expect(after.sourceTreeDigest).toBe(before.sourceTreeDigest);
      expect(after.truncated).toBe(false);
      expect(after.excluded).toBe(0);
    },
  );

  it("retains the metadata boundary when the caller negates an additional default exclusion", async () => {
    const fs = project({ ".untangle/receipt.json": "{}" });
    const inventory = await collectProductInventory({
      root,
      fs,
      scope: { additionalDefaultExcludes: ["!/.untangle"], maxFilesScanned: 1 },
    });
    expect(inventory.files.map((file) => file.relativePath)).toEqual(["main.ts"]);
    expect(inventory.truncated).toBe(false);
    expect(inventory.excluded).toBe(0);
  });

  it("accepts nested .untangle source directories and nearby names in both inventory entry points", async () => {
    const kept = [
      ".untangle-other/feature.ts",
      ".untangle.ts",
      ".untangleignore",
      "main.ts",
      "src/.untangle/feature.ts",
    ];
    const fs = project({
      ".untangle/cache.ts": source,
      ".untangle-other/feature.ts": source,
      ".untangle.ts": source,
      ".untangleignore": "# User exclusions\n",
      "src/.untangle/feature.ts": source,
    });
    const collected = await collectProductInventory({ root, fs });
    const scanned: ScannedFileV1[] = [];
    for await (const file of discoverFiles({ fs, roots: [root], repoRoot: root }))
      scanned.push(file);
    expect(scanned.map((file) => file.relativePath)).toContain(".untangle/cache.ts");
    const supplied = createProductInventory({
      root,
      fs,
      files: scanned,
      excluded: 7,
      truncated: true,
    });
    expect(collected.files.map((file) => file.relativePath)).toEqual(kept);
    expect(supplied.files.map((file) => file.relativePath)).toEqual(kept);
    expect(supplied.sourceTreeDigest).toBe(collected.sourceTreeDigest);
    expect(supplied.excluded).toBe(7);
    expect(supplied.truncated).toBe(true);
  });

  it("filters normalized root metadata paths from a supplied census before checking conflicts", async () => {
    const fs = project({ ".untangle/cache.ts": source });
    const scanned: ScannedFileV1[] = [];
    for await (const file of discoverFiles({ fs, roots: [root], repoRoot: root }))
      scanned.push(file);
    const metadata = scanned.find((file) => file.relativePath === ".untangle/cache.ts");
    if (metadata === undefined) throw new Error("Expected metadata in the raw scanner census");
    const expected = createProductInventory({
      root,
      fs,
      files: scanned.filter((file) => file.relativePath === "main.ts"),
    });
    const inventory = createProductInventory({
      root,
      fs,
      files: [
        ...scanned,
        { ...metadata, relativePath: "./.untangle/cache.ts", contentHash: "changed" },
        { ...metadata, relativePath: ".untangle\\cache.ts", contentHash: "changed" },
        { ...metadata, relativePath: "src/../.untangle/cache.ts", contentHash: "changed" },
        { ...metadata, relativePath: `${root}/.untangle/cache.ts`, contentHash: "changed" },
      ],
    });
    expect(inventory.files).toEqual(expected.files);
    expect(inventory.sourceTreeDigest).toBe(expected.sourceTreeDigest);
  });

  it("reserves the exact root namespace even when .untangle is a file", async () => {
    const fs = project({ ".untangle": "own metadata" });
    const collected = await collectProductInventory({ root, fs });
    const scanned: ScannedFileV1[] = [];
    for await (const file of discoverFiles({ fs, roots: [root], repoRoot: root }))
      scanned.push(file);
    const supplied = createProductInventory({ root, fs, files: scanned });
    expect(collected.files.map((file) => file.relativePath)).toEqual(["main.ts"]);
    expect(supplied.files).toEqual(collected.files);
    expect(supplied.sourceTreeDigest).toBe(collected.sourceTreeDigest);
  });
});
