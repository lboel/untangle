#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = path.join(ROOT, "eslint.config.js");
const code = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const skippedDirectories = new Set(["node_modules", "dist", "coverage", ".git", ".turbo"]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");

/** Explicit active-helper gate; historical archives are never selected by default. */
export async function lintEvidence(inputs, { root = ROOT } = {}) {
  root = path.resolve(root);
  if (inputs.length === 0) {
    throw new Error("Usage: pnpm run lint:evidence -- <active-helper-path> [...]");
  }
  const selected = new Set();
  const stateRoot = path.join(root, ".untangle");
  const insideState = (file) => {
    const rest = path.relative(stateRoot, file);
    if (rest === "" || rest === ".." || rest.startsWith(`..${path.sep}`) || path.isAbsolute(rest)) {
      throw new Error(`Select active helper paths inside .untangle/: ${file}`);
    }
  };
  async function visit(file, explicit = false) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Evidence lint does not follow symlinks: ${file}`);
    if (stat.isDirectory()) {
      if (skippedDirectories.has(path.basename(file))) {
        throw new Error(`Generated directory is not an active helper: ${file}`);
      }
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    } else if (stat.isFile() && code.test(file)) {
      selected.add(file);
    } else if (explicit) {
      throw new Error(`Active helper must be a JavaScript or TypeScript source: ${file}`);
    }
  }
  async function collect() {
    selected.clear();
    for (const input of inputs) {
      const file = path.resolve(root, input);
      insideState(file);
      // An ancestor symlink must not redirect an apparently local selection.
      let parent = path.dirname(file);
      while (parent !== root) {
        if ((await fs.lstat(parent)).isSymbolicLink()) {
          throw new Error(`Evidence lint does not follow symlinks: ${parent}`);
        }
        parent = path.dirname(parent);
      }
      await visit(file, true);
    }
    return [...selected].sort();
  }
  const files = await collect();
  if (files.length === 0) throw new Error("No active helper source files were selected.");
  const before = await Promise.all(
    files.map(async (file) => ({
      path: relative(root, file),
      sha256: sha(await fs.readFile(file)),
    })),
  );
  // Disable path ignores only for this explicit file list; keep the real config/rules.
  const configHash = sha(await fs.readFile(CONFIG));
  const eslint = new ESLint({ cwd: root, overrideConfigFile: CONFIG, ignore: false, fix: false });
  const results = await eslint.lintFiles(files);
  const inspected = results.map((result) => path.resolve(result.filePath)).sort();
  const expected = [...files].sort();
  if (
    JSON.stringify(inspected) !== JSON.stringify(expected) ||
    results.some((result) =>
      result.messages.some(
        (message) =>
          message.ruleId === null && /ignor|no matching configuration/iu.test(message.message),
      ),
    )
  ) {
    throw new Error("ESLint did not inspect every selected active helper.");
  }
  if (JSON.stringify(await collect()) !== JSON.stringify(files)) {
    throw new Error("Active helper file selection changed during evidence lint.");
  }
  const after = await Promise.all(
    files.map(async (file) => ({
      path: relative(root, file),
      sha256: sha(await fs.readFile(file)),
    })),
  );
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Active helper bytes changed during evidence lint.");
  }
  if (sha(await fs.readFile(CONFIG)) !== configHash) {
    throw new Error("Repository lint configuration changed during evidence lint.");
  }
  const errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
  const warningCount = results.reduce((sum, result) => sum + result.warningCount, 0);
  return {
    schemaVersion: 1,
    status: errorCount === 0 ? "passed" : "failed",
    checkedFiles: files.length,
    files: before,
    errorCount,
    warningCount,
    configuration: { path: relative(ROOT, CONFIG), sha256: configHash },
    results: results.map((result) => ({
      path: relative(root, result.filePath),
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      messages: result.messages,
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const inputs = process.argv.slice(2);
    if (inputs[0] === "--") inputs.shift();
    const report = await lintEvidence(inputs);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `Evidence lint failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
