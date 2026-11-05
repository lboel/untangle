#!/usr/bin/env node
/**
 * `pnpm sync-licenses` — WP-221.
 *
 * AGPL-3.0-only §4 und §5 verlangen, dass JEDER Empfaenger einer Kopie des
 * Werks eine Kopie der Lizenz erhaelt. Ein npm-Tarball IST eine solche
 * Weitergabe. Heute enthaelt kein einziges der 18 Tarballs die LICENSE.
 *
 * npm nimmt eine LICENSE-Datei im Paketverzeichnis automatisch auf, auch ohne
 * Eintrag in "files" — aber nur eine ECHTE Datei. Einen Symlink auf die
 * Wurzel-LICENSE nimmt npm NICHT auf. Deshalb legt dieses Skript echte
 * Kopien an und nicht, wie es sonst naheliegend waere, Symlinks.
 *
 * NOTICE wird von npm NICHT automatisch aufgenommen (empirisch geprueft:
 * `npm pack --dry-run` mit files:["dist"] listet LICENSE und README.md, aber
 * weder NOTICE noch THIRD_PARTY_LICENSES.md). NOTICE steht deshalb zusaetzlich
 * in der "files"-Liste jeder package.json.
 *
 * Kopien driften. Deshalb ist dieses Skript zugleich der Drift-Test:
 *   --check  schreibt nichts, sondern meldet jede Abweichung und endet mit 2.
 *
 * Exit-Codes:
 *   0  Alle Kopien stimmen (bzw. wurden geschrieben).
 *   1  Betriebsfehler.
 *   2  Nur mit --check: mindestens eine Kopie fehlt oder weicht ab.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Die Dateien, die in JEDEM Paketverzeichnis liegen muessen. */
export const SYNCED_FILES = ["LICENSE", "NOTICE"];

const WORKSPACE_DIRS = ["packages", "apps"];

/** Sortierung nach Codepoints — nie `localeCompare` (Determinismus-Regel). */
function compareCodepoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Alle Paketverzeichnisse relativ zur Repo-Wurzel, deterministisch sortiert. */
export function collectPackageDirs(repoRoot = REPO_ROOT) {
  const found = [];
  for (const group of WORKSPACE_DIRS) {
    const groupDir = path.join(repoRoot, group);
    if (!existsSync(groupDir) || !statSync(groupDir).isDirectory()) continue;
    for (const entry of readdirSync(groupDir)) {
      if (!existsSync(path.join(groupDir, entry, "package.json"))) continue;
      found.push(`${group}/${entry}`);
    }
  }
  return found.sort(compareCodepoints);
}

function main(argv) {
  const checkOnly = argv.includes("--check");

  const sources = new Map();
  for (const name of SYNCED_FILES) {
    const sourcePath = path.join(REPO_ROOT, name);
    if (!existsSync(sourcePath)) {
      process.stderr.write(
        `sync-licenses: ${name} is missing from the repository root; nothing to copy.
`,
      );
      return 1;
    }
    sources.set(name, readFileSync(sourcePath));
  }

  const dirs = collectPackageDirs();
  if (dirs.length === 0) {
    process.stderr.write("sync-licenses: no package found; check the repository path.\n");
    return 1;
  }

  const problems = [];
  let written = 0;

  for (const dir of dirs) {
    for (const name of SYNCED_FILES) {
      const target = path.join(REPO_ROOT, dir, name);
      const expected = sources.get(name);

      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        // Ein Symlink sieht lokal richtig aus und verschwindet im Tarball.
        problems.push(`${dir}/${name}: is a symlink, which npm excludes from the tarball`);
        if (checkOnly) continue;
      }

      const actual =
        existsSync(target) && !lstatSync(target).isSymbolicLink()
          ? readFileSync(target)
          : undefined;

      if (actual !== undefined && actual.equals(expected)) continue;

      if (checkOnly) {
        problems.push(
          actual === undefined
            ? `${dir}/${name}: missing`
            : `${dir}/${name}: differs from the root ${name}`,
        );
        continue;
      }

      writeFileSync(target, expected);
      written += 1;
      process.stdout.write(`  written: ${dir}/${name}\n`);
    }
  }

  if (checkOnly) {
    const unique = [...new Set(problems)].sort(compareCodepoints);
    if (unique.length === 0) {
      process.stdout.write(
        `sync-licenses --check: ${String(dirs.length)} package directories contain ` +
          `${SYNCED_FILES.join(" and ")} as regular, byte-identical copies.
`,
      );
      return 0;
    }
    process.stderr.write(`sync-licenses --check: ${String(unique.length)} difference(s):\n\n`);
    for (const problem of unique) process.stderr.write(`  ${problem}\n`);
    process.stderr.write("\nNext step: run `pnpm sync-licenses`.\n");
    return 2;
  }

  process.stdout.write(
    `sync-licenses: ${String(written)} file(s) written, ` +
      `${String(dirs.length)} package directories checked.
`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
