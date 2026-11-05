import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error Local executable module has no separate declaration file.
import { lintEvidence } from "./lint-evidence.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = path.join(ROOT, "eslint.config.js");
const temporary: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "untangle-evidence-lint-"));
  temporary.push(root);
  return root;
}
async function write(root: string, name: string, content: string) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("source and evidence lint boundaries", () => {
  it("auto-discovers tracked and untracked sources while leaving archived generated code intact", async () => {
    const root = await workspace();
    const invalid = "export function check(flag) { if (flag) {} }\n";
    const tracked = await write(root, "scripts/tracked.js", invalid);
    const untracked = await write(root, "scripts/untracked.js", invalid);
    const archive = await write(
      root,
      ".untangle/releases/old/browser-built-dist/assets/vendor.js",
      invalid,
    );
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["add", "--", "scripts/tracked.js"], { cwd: root });
    expect(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })).toBe(
      "scripts/tracked.js\n",
    );
    const eslint = new ESLint({ cwd: root, overrideConfigFile: CONFIG });
    const results = await eslint.lintFiles(["."]);
    expect(results.map((result) => result.filePath).sort()).toEqual([tracked, untracked].sort());
    for (const result of results)
      expect(result.messages.some((message) => message.ruleId === "no-empty")).toBe(true);
    expect(await fs.readFile(archive, "utf8")).toBe(invalid);
  });

  it("explicitly checks active helpers with real repository rules and no file mutation", async () => {
    const root = await workspace();
    const source =
      "export function check(flag) { if (flag) {} }\nexport const timestamp = Date.now();\n";
    const file = await write(root, ".untangle/run/helpers/check.mjs", source);
    const report = await lintEvidence([".untangle/run/helpers"], { root });
    expect(report.status).toBe("failed");
    expect(report.checkedFiles).toBe(1);
    expect(report.files).toEqual([
      {
        path: ".untangle/run/helpers/check.mjs",
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ]);
    expect(report.results[0].messages.map((message: { ruleId: string }) => message.ruleId)).toEqual(
      expect.arrayContaining(["no-empty", "no-restricted-syntax"]),
    );
    expect(await fs.readFile(file, "utf8")).toBe(source);
  });

  it("requires a real nonempty selection and rejects links and non-helper files", async () => {
    const root = await workspace();
    await fs.mkdir(path.join(root, ".untangle/run/helpers"), { recursive: true });
    await expect(lintEvidence([], { root })).rejects.toThrow("Usage:");
    await expect(lintEvidence([".untangle/run/helpers"], { root })).rejects.toThrow(
      "No active helper",
    );
    await expect(lintEvidence([".untangle"], { root })).rejects.toThrow("Select active helper");
    const source = await write(root, "scripts/source.js", "export const value = 1;\n");
    await expect(lintEvidence([source], { root })).rejects.toThrow("Select active helper");
    const report = await write(root, ".untangle/run/report.json", "{}\n");
    await expect(lintEvidence([report], { root })).rejects.toThrow("JavaScript or TypeScript");
    await fs.symlink(source, path.join(root, ".untangle/run/helpers/linked.mjs"));
    await expect(lintEvidence([".untangle/run/helpers/linked.mjs"], { root })).rejects.toThrow(
      "symlinks",
    );
    await fs.symlink(path.join(root, "scripts"), path.join(root, ".untangle/redirected"));
    await expect(lintEvidence([".untangle/redirected/source.js"], { root })).rejects.toThrow(
      "symlinks",
    );
  });

  it("returns exact hashes and checked counts for passing explicitly selected helpers", async () => {
    const root = await workspace();
    await write(root, ".untangle/run/helpers/check.mjs", "export const answer = 42;\n");
    await write(root, ".untangle/run/helpers/original.js.txt", "if (true) {}\n");
    const report = await lintEvidence(
      [".untangle/run/helpers", ".untangle/run/helpers/check.mjs"],
      { root },
    );
    expect(report.status).toBe("passed");
    expect(report.errorCount).toBe(0);
    expect(report.checkedFiles).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.files[0].path).toBe(".untangle/run/helpers/check.mjs");
  });

  it.each(["dist", "coverage", "node_modules"])(
    "rejects nested %s directories instead of silently omitting helper code",
    async (directory) => {
      const root = await workspace();
      await write(root, ".untangle/run/helpers/check.mjs", "export const answer = 42;\n");
      await write(
        root,
        `.untangle/run/helpers/${directory}/unchecked.mjs`,
        "export function check(flag) { if (flag) {} }\n",
      );
      await expect(lintEvidence([".untangle/run/helpers"], { root })).rejects.toThrow(
        "Generated directory is not an active helper",
      );
    },
  );
});
