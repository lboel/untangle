#!/usr/bin/env node
/**
 * `pnpm check-publishable` — WP-166, erweitert um WP-220/WP-221/WP-223/WP-224.
 *
 * Die Frage, die dieses Skript beantwortet, ist die des Nutzers: „Ich will das
 * via npm installieren."
 *
 * WARUM ES NEU GESCHRIEBEN WURDE (WP-223). Die alte Fassung prueft
 * ausschliesslich Felder in `package.json` und meldete „Keine Abweichung",
 * waehrend die Veroeffentlichung an zwei Dingen scheiterte, die sie gar nicht
 * ansah:
 *
 *   1. `npm pack` laesst `"workspace:*"` WOERTLICH im gepackten Manifest
 *      stehen. `npm install <tarball>` endet mit EUNSUPPORTEDPROTOCOL — also
 *      scheitert exakt die Zeile, die README und `scripts/install.sh`
 *      versprechen. `pnpm pack` ersetzt das Protokoll durch die Version.
 *   2. Kein Tarball enthielt LICENSE oder NOTICE. AGPL-3.0-only §4/§5
 *      verlangen, dass jeder Empfaenger die Lizenz mitbekommt.
 *
 * Ein Pruefskript, das die realen Blockierer nicht sieht, ist schlimmer als
 * keins, weil es Sicherheit vortaeuscht. Deshalb prueft dieses Skript nicht
 * mehr nur Felder, sondern PACKT jedes veroeffentlichte Paket wirklich (mit
 * pnpm) und sieht in das Tarball hinein. Was hier gruen ist, ist an einem
 * echten Tarball gruen — nicht an einer Absichtserklaerung.
 *
 * Geprueft wird je veroeffentlichtem Paket:
 *   Manifest  — license/version/description/repository/engines/publishConfig/
 *               files/exports|bin, keine Laufzeitabhaengigkeit auf ein
 *               privates Paket, `prepack`-Guard verdrahtet.
 *   Dateien   — LICENSE und NOTICE als ECHTE, wortgleiche Kopien der
 *               Wurzeldateien (kein Symlink: den nimmt npm nicht ins Tarball
 *               auf), aktuelle THIRD_PARTY_LICENSES.md, README nennt die
 *               Lizenz (die README IST die npm-Paketseite).
 *   Tarball   — kein `workspace:` im gepackten Manifest; LICENSE, NOTICE,
 *               README.md und THIRD_PARTY_LICENSES.md liegen darin; die
 *               Einstiegspunkte aus `exports`/`bin` existieren; kein
 *               Testgeruest; KEINE TOTE SOURCE-MAP (jede `sources`-Angabe
 *               muss im selben Tarball liegen).
 *
 * Exit-Codes:
 *   0  Alle Pakete entsprechen der Entscheidung.
 *   1  Betriebsfehler (Datei unlesbar, kaputtes JSON, pack fehlgeschlagen).
 *   2  Mindestens ein Paket weicht ab. Jede Abweichung wird EINZELN genannt.
 *
 * Optionen:
 *   --json      Maschinenlesbare Ausgabe statt Text.
 *   --no-pack   Nur die Manifest- und Dateipruefungen. AUSDRUECKLICH NICHT der
 *               Normalfall: ohne Pack-Lauf bleiben die beiden Blockierer aus
 *               WP-220/WP-221 unsichtbar. Fuer schnelle lokale Zwischenlaeufe.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function terminateOwnedChild(child, signal = "SIGTERM") {
  if (!child.pid) return;
  if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null))
    return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/** A killed grandchild with ignored stdio has no ChildProcess close event to await. */
async function waitForOwnedGroupShutdown(child) {
  if (!child.pid || process.platform === "win32") return;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      // macOS can deny signal-zero after group termination; inspect our group instead.
      if (error.code !== "EPERM") throw error;
    }
    const inventory = spawnSync("ps", ["-axo", "pgid=,stat="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    if (inventory.status !== 0) throw new Error("Cannot verify owned process group shutdown.");
    const active = inventory.stdout.split("\n").some((line) => {
      const fields = line.trim().split(/\s+/);
      return Number(fields[0]) === child.pid && !fields[1]?.startsWith("Z");
    });
    // Zombies cannot execute or access the owned installation directory.
    if (!active) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Owned process group ${child.pid} did not terminate after SIGKILL.`);
}

/** The spawned Unix process group belongs exclusively to this invocation. */
export function startOwnedChild(command, args, { cwd, env, signal, timeoutMs }) {
  signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
  let stopReason;
  let forceTimer;
  let closeResult;
  let groupStopped = false;
  let settling = false;
  let finish;
  function stop(reason) {
    stopReason ??= reason;
    terminateOwnedChild(child);
    forceTimer ??= setTimeout(() => {
      // The parent may already have closed; its SIGTERM-ignoring descendants still own this group.
      terminateOwnedChild(child, "SIGKILL");
      groupStopped = true;
      finish();
    }, 2_000);
  }
  const timer = setTimeout(() => stop(new Error(`${command} exceeded ${timeoutMs}ms`)), timeoutMs);
  const aborted = () => stop(signal.reason ?? new Error("Release smoke cancelled."));
  signal?.addEventListener("abort", aborted, { once: true });
  const closed = new Promise((resolve, reject) => {
    finish = async () => {
      if (settling || !closeResult || (stopReason && !groupStopped)) return;
      settling = true;
      try {
        await waitForOwnedGroupShutdown(child);
      } catch (error) {
        if (stopReason) {
          const originalMessage =
            stopReason instanceof Error ? stopReason.message : String(stopReason);
          stopReason = new Error(
            `${originalMessage} (owned group shutdown verification failed: ${error.message})`,
            { cause: stopReason },
          );
        } else stopReason = error;
      }
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", aborted);
      if (stopReason) reject(stopReason);
      else resolve(closeResult);
    };
    child.once("error", stop);
    child.once("close", (code, exitSignal) => {
      closeResult = { code, signal: exitSignal };
      clearTimeout(timer);
      // Successful commands must not leave detached lifecycle children behind either.
      if (!stopReason) terminateOwnedChild(child, "SIGKILL");
      finish();
    });
  });
  // Consumers attach their own rejection path; avoid an unhandled rejection during RPC waits.
  closed.catch(() => {});
  return { child, closed, stop };
}

export async function runOwnedCommand(command, args, options) {
  const handle = startOwnedChild(command, args, options);
  let stdout = "";
  let stderr = "";
  const collect = (stream, key) =>
    stream.on("data", (chunk) => {
      if (key === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > (options.maxOutput ?? 16 * 1024 * 1024))
        handle.stop(new Error(`${command} exceeded output limit.`));
    });
  collect(handle.child.stdout, "stdout");
  collect(handle.child.stderr, "stderr");
  handle.child.stdin.end();
  const exit = await handle.closed;
  if (exit.code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${exit.code ?? exit.signal}):\n${stderr || stdout}`,
    );
  return { command: [command, ...args], exitCode: exit.code, stdout, stderr };
}

/** Die EINZIGE Stelle, an der die Auswahl steht. */
const PRIVATE_PACKAGES = new Set([
  "@untangle-code/testkit",
  "@untangle-code/mcp-server",
  "@untangle-code/website",
]);

const EXPECTED_LICENSE = "AGPL-3.0-only";
const EXPECTED_REPOSITORY_URL = "git+https://github.com/lboel/untangle.git";
const WORKSPACE_DIRS = ["packages", "apps"];

/** Dateien, die JEDES veroeffentlichte Tarball tragen muss (AGPL §4/§5, R6). */
const REQUIRED_TARBALL_FILES = ["LICENSE", "NOTICE", "README.md", "THIRD_PARTY_LICENSES.md"];

/** Wortgleiche Kopien der Wurzeldateien — siehe scripts/sync-license-files.mjs. */
const SYNCED_FILES = ["LICENSE", "NOTICE"];

const PREPACK_COMMAND = "node ../../scripts/prepack-guard.mjs";

/**
 * Testgeruest, das in keinem Produktions-Tarball etwas verloren hat (WP-224).
 * Bewusst als Pfad-SEGMENT bzw. Dateiname geprueft, nicht als Teilstring:
 * ein Modul namens `attesting.js` ist kein Testgeruest.
 */
const TEST_SCAFFOLD_SEGMENTS = new Set(["testing", "test-support", "__tests__", "test-helpers"]);
const TEST_FILE_PATTERN = /(^|\.)(test|spec)\.[cm]?[jt]sx?$/;
const SCAFFOLD_FILE_STEMS = new Set(["test-support", "test-helpers"]);

/** Sortierung nach Codepoints — nie `localeCompare` (Determinismus-Regel). */
function compareCodepoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectManifests() {
  const found = [];
  for (const group of WORKSPACE_DIRS) {
    const groupDir = path.join(REPO_ROOT, group);
    if (!existsSync(groupDir) || !statSync(groupDir).isDirectory()) continue;
    for (const entry of readdirSync(groupDir)) {
      const manifestPath = path.join(groupDir, entry, "package.json");
      if (!existsSync(manifestPath)) continue;
      found.push({ dir: `${group}/${entry}`, manifestPath });
    }
  }
  return found.sort((a, b) => compareCodepoints(a.dir, b.dir));
}

function readManifest(manifestPath) {
  let text;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`${manifestPath} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${error.message}`);
  }
}

/**
 * Prueft EIN Manifest samt der Dateien daneben. Liefert eine Liste von
 * Befunden; leer heisst „in Ordnung". Jeder Befund nennt Feld, Ist und Soll —
 * ein Befund ohne naechsten Schritt waere fuer den Leser wertlos.
 */
function checkManifest({ dir, manifestPath }, privateNames, rootFiles) {
  const pkg = readManifest(manifestPath);
  const findings = [];
  const add = (field, actual, expected) => {
    findings.push({ package: pkg.name ?? dir, dir, field, actual, expected });
  };

  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    add("name", String(pkg.name), "a non-empty package name");
    return { name: dir, dir, pkg, findings, published: false };
  }

  const shouldBePrivate = privateNames.has(pkg.name);
  const published = !shouldBePrivate;

  // --- Fuer JEDES Paket, ob veroeffentlicht oder nicht ---------------------
  if (pkg.license !== EXPECTED_LICENSE) {
    add("license", String(pkg.license), EXPECTED_LICENSE);
  }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    add("version", String(pkg.version), "a version");
  }
  if (typeof pkg.description !== "string" || pkg.description.length < 20) {
    add("description", String(pkg.description), "a description (>= 20 characters)");
  }
  const repository = pkg.repository;
  if (typeof repository !== "object" || repository === null) {
    add("repository", String(repository), "{ type, url, directory }");
  } else {
    if (repository.type !== "git") add("repository.type", String(repository.type), "git");
    if (repository.url !== EXPECTED_REPOSITORY_URL) {
      add("repository.url", String(repository.url), EXPECTED_REPOSITORY_URL);
    }
    if (repository.directory !== dir) {
      add("repository.directory", String(repository.directory), dir);
    }
  }
  if (typeof pkg.engines?.node !== "string") {
    add(
      "engines.node",
      String(pkg.engines?.node),
      "a Node range, for example ^22.13.0 || >=24.0.0",
    );
  }

  // --- Die Entscheidung selbst --------------------------------------------
  if (shouldBePrivate) {
    if (pkg.private !== true) {
      add("private", String(pkg.private), "true (intentionally unpublished)");
    }
    if (pkg.publishConfig !== undefined) {
      add("publishConfig", JSON.stringify(pkg.publishConfig), "unset (package is private)");
    }
    return { name: pkg.name, dir, pkg, findings, published };
  }

  if (pkg.private === true) {
    add("private", "true", "false; this package is intended for publication");
  }
  if (pkg.publishConfig?.access !== "public") {
    add("publishConfig.access", String(pkg.publishConfig?.access), "public");
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    add("files", JSON.stringify(pkg.files), "a non-empty file list");
  }
  if (pkg.exports === undefined && pkg.bin === undefined) {
    add("exports|bin", "both missing", "at least one of the two");
  }

  // --- WP-220: der Veroeffentlichungsweg muss erzwungen sein ---------------
  // Eine Fussnote in der README haelt niemanden davon ab, `npm publish` zu
  // tippen; der prepack-Guard schon (npm und pnpm fuehren `prepack` beide vor
  // dem Packen aus).
  if (pkg.scripts?.prepack !== PREPACK_COMMAND) {
    add(
      "scripts.prepack",
      String(pkg.scripts?.prepack),
      `${PREPACK_COMMAND}; reject non-pnpm packing, which would retain "workspace:*"`,
    );
  }

  // --- WP-221: die Lizenz muss beim Empfaenger ankommen --------------------
  for (const name of SYNCED_FILES) {
    const target = path.join(REPO_ROOT, dir, name);
    if (!existsSync(target)) {
      add(name, "missing", `${dir}/${name}; create a regular copy with \`pnpm sync-licenses\``);
      continue;
    }
    if (lstatSync(target).isSymbolicLink()) {
      add(name, "Symlink", "a regular file; npm excludes symlinks from tarballs");
      continue;
    }
    if (!readFileSync(target).equals(rootFiles.get(name))) {
      add(
        name,
        "differs from the root file",
        `byte-identical to ./${name} (\`pnpm sync-licenses\`)`,
      );
    }
  }

  const thirdParty = path.join(REPO_ROOT, dir, "THIRD_PARTY_LICENSES.md");
  if (!existsSync(thirdParty)) {
    add(
      "THIRD_PARTY_LICENSES.md",
      "missing",
      "generate with `pnpm third-party-licenses` (BUILD_PLAN R6: release gate)",
    );
  }

  const readmePath = path.join(REPO_ROOT, dir, "README.md");
  if (!existsSync(readmePath)) {
    add("README.md", "missing", `${dir}/README.md; npm displays it as the package page`);
  } else if (!readFileSync(readmePath, "utf8").includes(EXPECTED_LICENSE)) {
    add(
      "README.md",
      `does not name "${EXPECTED_LICENSE}"`,
      "a section naming the license; this README is the npm package page",
    );
  }

  // Ein veroeffentlichtes Paket darf zur LAUFZEIT nicht von einem privaten
  // abhaengen: der Konsument bekaeme eine Abhaengigkeit, die es auf npm nicht
  // gibt. (devDependencies sind davon nicht betroffen — npm installiert sie
  // fuer Konsumenten nicht.)
  for (const depName of Object.keys(pkg.dependencies ?? {}).sort(compareCodepoints)) {
    if (privateNames.has(depName)) {
      add(
        `dependencies.${depName}`,
        "dependency on a private package",
        `entweder ${depName} publishable or remove the dependency`,
      );
    }
  }

  return { name: pkg.name, dir, pkg, findings, published };
}

// ---------------------------------------------------------------------------
// Der Pack-Lauf: die einzige Pruefung, die die realen Blockierer sieht.
// ---------------------------------------------------------------------------

/** Alle Pfade im entpackten Tarball, relativ zum `package/`-Wurzelordner. */
function listExtracted(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort(compareCodepoints);
}

function looksLikeTestScaffold(relPath) {
  const segments = relPath.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  for (const segment of segments.slice(0, -1)) {
    if (TEST_SCAFFOLD_SEGMENTS.has(segment)) return true;
  }
  if (TEST_FILE_PATTERN.test(fileName)) return true;
  const stem = fileName.split(".")[0] ?? "";
  return SCAFFOLD_FILE_STEMS.has(stem);
}

/** Einstiegspunkte aus `exports` und `bin`, relativ zur Paketwurzel. */
function collectEntryPoints(pkg) {
  const entries = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) entries.add(value.slice(2));
      return;
    }
    if (value && typeof value === "object") for (const inner of Object.values(value)) visit(inner);
  };
  visit(pkg.exports);
  visit(pkg.bin);
  return [...entries].sort(compareCodepoints);
}

/**
 * Packt EIN Paket mit pnpm, entpackt das Tarball und prueft es.
 * @returns {Promise<{findings: object[], fileCount: number, bytes: number}>}
 */
async function inspectTarball(result, workDir, signal) {
  signal?.throwIfAborted();
  const findings = [];
  const add = (field, actual, expected) => {
    findings.push({ package: result.name, dir: result.dir, field, actual, expected });
  };

  const packageDir = path.join(REPO_ROOT, result.dir);
  const outDir = path.join(workDir, result.dir.replace("/", "__"));
  execFileSync("mkdir", ["-p", outDir]);

  let stdout;
  try {
    ({ stdout } = await runOwnedCommand("pnpm", ["pack", "--pack-destination", outDir], {
      cwd: packageDir,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      maxOutput: 64 * 1024 * 1024,
      timeoutMs: 120_000,
      signal,
    }));
  } catch (error) {
    throw new Error(
      `pnpm pack for ${result.name} fehlgeschlagen:\n${String(error.stderr ?? error.message)}`,
    );
  }

  const tarballs = readdirSync(outDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `pnpm pack for ${result.name} erzeugte ${String(tarballs.length)} tarballs instead of one. ` +
        `Output:
${stdout}`,
    );
  }
  const tarball = path.join(outDir, tarballs[0]);
  const bytes = statSync(tarball).size;

  const extractDir = path.join(outDir, "extracted");
  execFileSync("mkdir", ["-p", extractDir]);
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir]);
  const packageRoot = path.join(extractDir, "package");
  if (!existsSync(packageRoot)) {
    throw new Error(`Tarball for ${result.name} contains no "package/" directory.`);
  }

  const files = listExtracted(packageRoot);
  const fileSet = new Set(files);

  // --- WP-220 ---------------------------------------------------------------
  const packedManifestText = readFileSync(path.join(packageRoot, "package.json"), "utf8");
  const packedManifest = JSON.parse(packedManifestText);
  const workspaceSpecs = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [depName, spec] of Object.entries(packedManifest[field] ?? {}).sort((a, b) =>
      compareCodepoints(a[0], b[0]),
    )) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        workspaceSpecs.push(`${field}.${depName}=${spec}`);
      }
    }
  }
  if (workspaceSpecs.length > 0) {
    add(
      "Tarball: workspace protocol",
      workspaceSpecs.join(", "),
      "concrete versions; otherwise `npm install <tarball>` fails with EUNSUPPORTEDPROTOCOL",
    );
  }

  // --- WP-221 ---------------------------------------------------------------
  for (const required of REQUIRED_TARBALL_FILES) {
    if (!fileSet.has(required)) {
      add(
        `Tarball: ${required}`,
        "missing from the tarball",
        required === "LICENSE" || required === "NOTICE"
          ? "AGPL-3.0-only §4/§5; every recipient receives the license"
          : "include in the manifest's `files` list",
      );
    }
  }

  // --- Einstiegspunkte ------------------------------------------------------
  for (const entry of collectEntryPoints(result.pkg)) {
    if (!fileSet.has(entry)) {
      add(
        `Tarball: ${entry}`,
        "missing from the tarball",
        "the `exports`/`bin` entry point must be inside it",
      );
    }
  }

  // --- WP-224: Testgeruest --------------------------------------------------
  const scaffold = files.filter(looksLikeTestScaffold);
  if (scaffold.length > 0) {
    add(
      "Tarball: test harness",
      `${String(scaffold.length)} file(s), for example ${scaffold.slice(0, 3).join(", ")}`,
      "no test harness in a production tarball (tsconfig `exclude` / `files` negation)",
    );
  }

  // --- WP-224: tote Source-Maps --------------------------------------------
  // Eine Map, deren `sources` nicht mitgeliefert werden, ist unbenutzbar.
  // Entschieden wurde, `src` MITZULIEFERN statt die Maps wegzulassen (siehe
  // README „Was im Tarball liegt"); diese Pruefung haelt die Entscheidung
  // dicht: jede Map muss ihre Quellen im selben Tarball finden.
  const deadMaps = [];
  for (const file of files) {
    if (!file.endsWith(".map")) continue;
    let map;
    try {
      map = JSON.parse(readFileSync(path.join(packageRoot, file), "utf8"));
    } catch {
      deadMaps.push(`${file} (unreadable)`);
      continue;
    }
    if (Array.isArray(map.sourcesContent) && map.sourcesContent.length > 0) continue;
    for (const source of map.sources ?? []) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
      if (!fileSet.has(resolved)) deadMaps.push(`${file} -> ${resolved}`);
    }
  }
  if (deadMaps.length > 0) {
    add(
      "Tarball: broken source maps",
      `${String(deadMaps.length)} broken reference(s), for example ${deadMaps.slice(0, 3).join(", ")}`,
      "either include sources or do not generate maps",
    );
  }

  return { findings, fileCount: files.length, bytes, tarball, manifest: packedManifest };
}

/** Fuehrt `worker` ueber `items` mit begrenzter Nebenlaeufigkeit aus. */
async function mapPooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** The caller owns workDir; release-smoke installs these exact inspected bytes. */
export async function checkPublishable({ withPack = true, workDir, signal } = {}) {
  if (withPack && !workDir) throw new Error("Packing requires a caller-owned workDir.");
  signal?.throwIfAborted();

  const rootFiles = new Map();
  for (const name of SYNCED_FILES) {
    const rootPath = path.join(REPO_ROOT, name);
    if (!existsSync(rootPath)) {
      throw new Error(
        `${name} is missing from the repository root; no package can be published without it.`,
      );
    }
    rootFiles.set(name, readFileSync(rootPath));
  }

  const manifests = collectManifests();
  if (manifests.length === 0) {
    throw new Error("No package found; check the repository path.");
  }

  const results = manifests.map((entry) => checkManifest(entry, PRIVATE_PACKAGES, rootFiles));
  const findings = results.flatMap((r) => r.findings);
  const tarballs = [];
  const artifacts = [];

  if (withPack) {
    const toPack = results.filter((r) => r.published);
    // Ein Paket, das sich nicht packen laesst, ist ein BEFUND dieses Pakets —
    // kein Abbruch des ganzen Laufs. Sonst verstecken die uebrigen 18 Pakete
    // sich hinter dem ersten kaputten (BUILD_PLAN E4).
    const packed = await mapPooled(toPack, 4, async (result) => {
      try {
        return await inspectTarball(result, workDir, signal);
      } catch (error) {
        return {
          findings: [
            {
              package: result.name,
              dir: result.dir,
              field: "pnpm pack",
              actual: String(error.message).split("\n")[0],
              expected: "a tarball that can be packed and unpacked",
            },
          ],
          fileCount: 0,
          bytes: 0,
        };
      }
    });
    for (let i = 0; i < toPack.length; i += 1) {
      findings.push(...packed[i].findings);
      tarballs.push({
        package: toPack[i].name,
        files: packed[i].fileCount,
        bytes: packed[i].bytes,
      });
      if (packed[i].tarball) {
        artifacts.push({
          dir: toPack[i].dir,
          tarball: packed[i].tarball,
          manifest: packed[i].manifest,
        });
      }
    }
    tarballs.sort((a, b) => compareCodepoints(a.package, b.package));
  }
  signal?.throwIfAborted();

  // WORKSPACE-WEITE PRUEFUNGEN. Bis hierher wurde je Paket geprueft, ob eine
  // THIRD_PARTY_LICENSES.md DA ist — nicht, ob sie STIMMT. Eine veraltete
  // Liste ist aber schlimmer als eine fehlende: sie sieht vollstaendig aus.
  // Beide Laeufe hier sind offline und deterministisch.
  for (const probe of [
    {
      field: "THIRD_PARTY_LICENSES.md (freshness)",
      argv: ["scripts/gen-third-party-licenses.mjs", "--check"],
      expected: "current lists; generate with `pnpm third-party-licenses`",
    },
    {
      field: "embedded tree-sitter grammars",
      argv: ["scripts/astgrep-grammar-provenance.mjs"],
      expected: "Record matches the installation; `pnpm grammar-provenance --update`",
    },
  ]) {
    const run = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, probe.argv[0]), ...probe.argv.slice(1)],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    if (run.status !== 0) {
      findings.push({
        package: "(workspace)",
        dir: "scripts",
        field: probe.field,
        actual:
          String(run.stderr || run.stdout || "")
            .split("\n")
            .filter((line) => line.trim() !== "")[0] ?? `Exit ${String(run.status)}`,
        expected: probe.expected,
      });
    }
  }

  findings.sort((a, b) => compareCodepoints(a.dir, b.dir) || compareCodepoints(a.field, b.field));

  const publishedNames = results
    .filter((r) => r.published)
    .map((r) => r.name)
    .sort(compareCodepoints);
  const privateNames = results
    .filter((r) => !r.published)
    .map((r) => r.name)
    .sort(compareCodepoints);

  return {
    schemaVersion: 2,
    packed: withPack,
    checked: results.length,
    published: publishedNames,
    private: privateNames,
    tarballs,
    findings,
    artifacts,
  };
}

function printReport(report, asJson) {
  const { artifacts: _artifacts, ...publicReport } = report;
  const {
    packed: withPack,
    findings,
    published: publishedNames,
    private: privateNames,
    tarballs,
  } = report;
  if (asJson) {
    process.stdout.write(JSON.stringify(publicReport, null, 2) + "\n");
    return findings.length === 0 ? 0 : 2;
  }
  process.stdout.write(`Checked: ${String(report.checked)} packages
`);
  process.stdout.write(
    `  veroeffentlicht (${String(publishedNames.length)}): ${publishedNames.join(", ")}\n`,
  );
  process.stdout.write(
    `  private       (${String(privateNames.length)}): ${privateNames.join(", ")}\n`,
  );
  if (withPack) {
    const totalFiles = tarballs.reduce((sum, t) => sum + t.files, 0);
    process.stdout.write(
      `  packed with pnpm: ${String(tarballs.length)} tarballs, ${String(totalFiles)} files in total
`,
    );
  } else {
    process.stdout.write(
      "  PACK RUN SKIPPED (--no-pack): workspace:* protocol and tarball contents\n" +
        "  remain unverified. These were the cause of the earlier publication failure.\n",
    );
  }
  process.stdout.write("\n");

  if (findings.length === 0) {
    process.stdout.write(
      withPack
        ? "No differences. Every tarball includes its license, sources and npm-required fields.\n"
        : "No differences in manifest and file checks.\n",
    );
    return 0;
  }

  process.stderr.write(`${String(findings.length)} difference(s):\n\n`);
  for (const finding of findings) {
    process.stderr.write(`  ${finding.dir} (${finding.package})\n`);
    process.stderr.write(`    Field   : ${finding.field}\n`);
    process.stderr.write(`    Actual  : ${finding.actual}\n`);
    process.stderr.write(`    Expected: ${finding.expected}\n\n`);
  }
  process.stderr.write(
    "Next step: fix the reported issues and rerun `pnpm check-publishable`.\n" +
      "For license files, run `pnpm sync-licenses`; for\n" +
      "third-party lists: `pnpm third-party-licenses`.\n",
  );
  return 2;
}

async function main(argv) {
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Publishable check interrupted."));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const withPack = !argv.includes("--no-pack");
  const workDir = withPack ? mkdtempSync(path.join(tmpdir(), "untangle-publishable-")) : undefined;
  try {
    return printReport(
      await checkPublishable({ withPack, workDir, signal: controller.signal }),
      argv.includes("--json"),
    );
  } finally {
    try {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    } finally {
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
