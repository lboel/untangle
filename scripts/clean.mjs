#!/usr/bin/env node
/**
 * Cross-platform cleanup of build artifacts across the whole workspace.
 *
 * Complements `pnpm -r --if-present run clean` (which only cleans packages
 * that define their own "clean" script): this pass sweeps the entire repo
 * tree for the generic artifact directories/files listed in `.gitignore`
 * (dist, .turbo, coverage, *.tsbuildinfo), so a fresh scaffold or a package
 * that never defined "clean" still gets swept. Never touches `node_modules`,
 * `.git`, or `.untangle/` (local state, not a build artifact of this repo).
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".untangle"]);
const REMOVE_DIR_NAMES = new Set(["dist", ".turbo", "coverage"]);

let removedCount = 0;

function removePath(path) {
  rmSync(path, { recursive: true, force: true });
  removedCount += 1;
  console.log(`removed ${path}`);
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      if (REMOVE_DIR_NAMES.has(entry.name)) {
        removePath(fullPath);
        continue;
      }
      walk(fullPath);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      removePath(fullPath);
    }
  }
}

function main() {
  const rootStat = statSync(REPO_ROOT);
  if (!rootStat.isDirectory()) {
    throw new Error(`Repo root is not a directory: ${REPO_ROOT}`);
  }
  walk(REPO_ROOT);
  console.log(`clean: removed ${removedCount} artifact path(s).`);
}

main();
