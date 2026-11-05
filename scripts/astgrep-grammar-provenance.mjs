#!/usr/bin/env node
/**
 * `pnpm grammar-provenance` — WP-245 / BUILD_PLAN Risiko R6.
 *
 * DAS PROBLEM. Die Pakete `@ast-grep/lang-*` liefern FREMDE
 * tree-sitter-Grammatiken aus. Ihre eigene `LICENSE` nennt nur ast-grep:
 *
 *     MIT License
 *     Copyright (c) 2025 ast-grep
 *
 * Der Inhalt von `src/parser.c` und `src/scanner.c` stammt aber nicht von
 * ast-grep, sondern aus der jeweiligen Grammatik — bei den geprueften Paketen
 * BYTEGLEICH (siehe `parserSha256` unten). `scanner.c` ist dabei kein
 * Generat, sondern handgeschriebener Quelltext des Grammatikautors. Wer nur
 * die Datei `LICENSE` des Sprachpakets liest, erfaehrt weder den Namen noch
 * den Urheberrechtsvermerk dieser Autoren.
 *
 * Erschwerend: die Sprachpakete deklarieren im `package.json`
 * `"license": "ISC"`, legen aber einen MIT-Text als `LICENSE` bei. Beides
 * kann nicht gleichzeitig stimmen. Diese Abweichung wird hier festgehalten
 * (`declaredLicense` gegen `licenseFileHeader`), nicht stillschweigend
 * aufgeloest — welche der beiden Angaben ast-grep meint, koennen wir nicht
 * entscheiden, und eine Entscheidung zu erfinden waere schlimmer als die
 * offene Frage (BUILD_PLAN E4).
 *
 * DIE QUELLE IST NIE EINE HANDLISTE. Jedes Feld unten stammt aus einem Lauf:
 *
 *   - `grammar` / `grammarVersion`   aus den `devDependencies` des installierten
 *                                    Sprachpakets (offline lesbar).
 *   - `license` / `copyright`        aus der `LICENSE` IM TARBALL genau dieser
 *                                    Grammatikversion, von der npm-Registry
 *                                    geladen — nicht aus dem `license`-Feld
 *                                    der Registry-Metadaten, das nur eine
 *                                    Behauptung des Veroeffentlichenden ist.
 *   - `parserSha256` / `parserMatch` Vergleich des ausgelieferten
 *                                    `src/parser.c` gegen die Grammatik.
 *
 * ZWEI BETRIEBSARTEN.
 *
 *   --update   (Netz noetig) Erhebt alles neu und schreibt
 *              `scripts/astgrep-grammar-provenance.json`.
 *   (ohne)     (offline) Prueft, ob die installierten Sprachpakete noch die
 *              aufgezeichneten Grammatikversionen nennen. Genau das bricht,
 *              wenn jemand `@ast-grep/lang-*` hochzieht und die Lizenzliste
 *              nicht mitzieht — der Fall, den R6 zum Release-Blocker macht.
 *
 * Exit-Codes:
 *   0  Aufgezeichnet (--update) bzw. deckungsgleich (Pruefung).
 *   1  Betriebsfehler (Netz, fehlende Installation, kaputtes Tarball).
 *   2  Nur ohne --update: Aufzeichnung weicht von der Installation ab.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECORD_PATH = path.join(REPO_ROOT, "scripts", "astgrep-grammar-provenance.json");
const REGISTRY_PACKAGE = "@untangle-code/parser-registry";

/** Sortierung nach Codepoints — nie `localeCompare` (Determinismus-Regel). */
function compareCodepoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Loest ein installiertes Paket so auf, wie Node es zur Laufzeit taete.
 * Gleiche Mechanik wie in `gen-third-party-licenses.mjs`.
 */
function resolveInstalledPackage(depName, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", depName, "package.json");
    if (existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Die Sprachpakete, um die es geht: die optionalen `peerDependencies` von
 * `packages/parser-registry` im Namensraum `@ast-grep/lang-*`, plus alles,
 * was dort als echte `dependencies` steht. Die Liste wird NICHT hier
 * gepflegt — sie wird aus dem Manifest gelesen, damit ein neu aufgenommenes
 * Sprachpaket nicht vergessen werden kann.
 */
function collectLanguagePackages() {
  const manifestPath = path.join(REPO_ROOT, "packages", "parser-registry", "package.json");
  const manifest = readJson(manifestPath);
  const names = new Set();
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith("@ast-grep/lang-")) names.add(name);
    }
  }
  return [...names].sort(compareCodepoints);
}

/** Der Grammatikname steckt in den `devDependencies` des Sprachpakets. */
function grammarOf(langManifest) {
  const dev = langManifest.devDependencies ?? {};
  const names = Object.keys(dev)
    .filter((name) => name.startsWith("tree-sitter") && name !== "tree-sitter-cli")
    .sort(compareCodepoints);
  if (names.length !== 1) return undefined;
  return { name: names[0], version: dev[names[0]] };
}

function npmView(spec, field) {
  return execFileSync("npm", ["view", spec, field], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

/** Laedt das Tarball einer exakten Version und liefert das Arbeitsverzeichnis. */
async function fetchTarball(spec, workDir) {
  const url = npmView(spec, "dist.tarball");
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`No tarball URL for ${spec} (erhalten: ${url})`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Tarball ${spec} could not be loaded: HTTP ${String(response.status)}`);
  }
  const file = path.join(workDir, "pkg.tgz");
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

function tarList(tarball) {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

function tarRead(tarball, member) {
  return execFileSync("tar", ["-xzOf", tarball, member], { maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Erster nicht-leerer Text der Lizenzdatei plus alle Urheberrechtszeilen.
 * Bewusst WOERTLICH uebernommen: eine Zusammenfassung waere eine Deutung.
 *
 * Gesucht wird der VERMERK, nicht das Wort. Ein MIT-Text enthaelt "copyright"
 * dreimal: im Vermerk, im Weitergabesatz ("The above copyright notice …") und
 * im Haftungsausschluss ("… THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE …").
 * Nur der erste ist eine Urheberangabe; die beiden anderen als solche zu
 * fuehren waere eine Falschaussage ueber den Rechteinhaber. Das Muster
 * verlangt deshalb die Form "Copyright <(c)|©> <Jahr>".
 */
const COPYRIGHT_NOTICE = /^copyright\s+(\((c|©)\)|©)\s*\d{4}/i;

function licenseFacts(text) {
  const lines = text.split(/\r?\n/);
  const header = lines.find((line) => line.trim() !== "")?.trim() ?? "";
  const copyright = lines.map((line) => line.trim()).filter((line) => COPYRIGHT_NOTICE.test(line));
  return { header, copyright };
}

/**
 * SPDX-Kennung aus dem Lizenztext — nur fuer die Formen, die eindeutig sind.
 * Alles andere bleibt `null` und faellt damit im Bericht auf, statt geraten
 * zu werden.
 */
function spdxFromText(header, text) {
  if (/^(the\s+)?mit license( \(mit\))?$/i.test(header)) return "MIT";
  if (/^apache license$/i.test(header) && /version 2\.0/i.test(text)) return "Apache-2.0";
  if (/^isc license$/i.test(header)) return "ISC";
  return null;
}

async function update() {
  const langNames = collectLanguagePackages();
  if (langNames.length === 0) {
    process.stderr.write(
      `grammar-provenance: ${REGISTRY_PACKAGE} lists no @ast-grep/lang-* package.
`,
    );
    return 1;
  }
  const fromDir = path.join(REPO_ROOT, "packages", "parser-registry");
  const workDir = mkdtempSync(path.join(tmpdir(), "grammar-prov-"));
  const entries = [];

  try {
    for (const langName of langNames) {
      const langDir = resolveInstalledPackage(langName, fromDir);
      if (langDir === undefined) {
        process.stderr.write(
          `grammar-provenance: ${langName} is not installed.
` + "Next step: run `pnpm install` and try again.\n",
        );
        return 1;
      }
      const langManifest = readJson(path.join(langDir, "package.json"));
      const grammar = grammarOf(langManifest);
      if (grammar === undefined) {
        process.stderr.write(
          `grammar-provenance: ${langName} declares no unambiguous tree-sitter grammar in devDependencies.
`,
        );
        return 1;
      }

      // Die eigene Lizenzlage des Sprachpakets — Feld gegen Datei.
      const langLicenseFile = path.join(langDir, "LICENSE");
      const langLicenseText = existsSync(langLicenseFile)
        ? readFileSync(langLicenseFile, "utf8")
        : "";
      const langFacts = licenseFacts(langLicenseText);

      // Die Grammatik selbst, aus dem Tarball genau dieser Version.
      const spec = `${grammar.name}@${grammar.version}`;
      process.stdout.write(`  erhebe ${langName} -> ${spec}\n`);
      const tarball = await fetchTarball(spec, workDir);
      const members = tarList(tarball);

      const licenseMember = members.find((m) =>
        /^package\/(LICENSE|LICENCE|COPYING)(\.\w+)?$/i.test(m),
      );
      if (licenseMember === undefined) {
        process.stderr.write(`grammar-provenance: ${spec} contains no license file.
`);
        return 1;
      }
      const grammarLicenseText = tarRead(tarball, licenseMember).toString("utf8");
      const grammarFacts = licenseFacts(grammarLicenseText);

      // Beweis statt Behauptung: ist das ausgelieferte parser.c das der
      // Grammatik? Der Fundort variiert (tree-sitter-php fuehrt zwei
      // Grammatiken in Unterverzeichnissen), deshalb wird ueber ALLE
      // parser.c des Tarballs verglichen statt einen Pfad zu raten.
      const shippedParser = path.join(langDir, "src", "parser.c");
      const shippedSha = existsSync(shippedParser) ? sha256(readFileSync(shippedParser)) : null;
      let parserMatch = false;
      let parserMemberMatched = null;
      for (const member of members.filter((m) => m.endsWith("/src/parser.c"))) {
        if (sha256(tarRead(tarball, member)) === shippedSha) {
          parserMatch = true;
          parserMemberMatched = member.replace(/^package\//, "");
          break;
        }
      }

      entries.push({
        languagePackage: langName,
        languagePackageVersion: String(langManifest.version ?? "unbekannt"),
        declaredLicense: String(langManifest.license ?? "UNBEKANNT"),
        licenseFileHeader: langFacts.header,
        licenseFileCopyright: langFacts.copyright,
        grammar: grammar.name,
        grammarVersion: grammar.version,
        grammarLicense: spdxFromText(grammarFacts.header, grammarLicenseText),
        grammarLicenseHeader: grammarFacts.header,
        grammarCopyright: grammarFacts.copyright,
        grammarRepository: npmView(spec, "repository.url")
          .replace(/^git\+/, "")
          .replace(/\.git$/, ""),
        parserSha256: shippedSha,
        parserMatchesGrammar: parserMatch,
        parserMemberMatched,
      });
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  entries.sort((a, b) => compareCodepoints(a.languagePackage, b.languagePackage));
  const record = {
    $comment:
      "Generated by `pnpm grammar-provenance --update`. Do not edit manually. " +
      "Every field comes from a run against the installed language packages and the " +
      "npm tarballs of the listed grammar versions; see the header of " +
      "scripts/astgrep-grammar-provenance.mjs.",
    entries,
  };
  writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `grammar-provenance: ${String(entries.length)} language packages recorded -> scripts/${path.basename(RECORD_PATH)}\n`,
  );
  const unclear = entries.filter((e) => e.grammarLicense === null);
  const unproven = entries.filter((e) => !e.parserMatchesGrammar);
  if (unclear.length > 0) {
    process.stdout.write(
      `  OPEN: ${String(unclear.length)} grammar(s) without an unambiguous SPDX identifier: ` +
        `${unclear.map((e) => e.grammar).join(", ")}\n`,
    );
  }
  if (unproven.length > 0) {
    process.stdout.write(
      `  OPEN: ${String(unproven.length)} language package(s) without byte-level proof against the grammar: ` +
        `${unproven.map((e) => e.languagePackage).join(", ")}\n`,
    );
  }
  return 0;
}

/** Offline-Pruefung: nennt die Installation noch dieselben Grammatikversionen? */
function check() {
  if (!existsSync(RECORD_PATH)) {
    process.stderr.write(
      "grammar-provenance: no record available.\n" +
        "Next step: run `pnpm grammar-provenance --update` (requires network access).\n",
    );
    return 2;
  }
  const record = readJson(RECORD_PATH);
  const byName = new Map(record.entries.map((entry) => [entry.languagePackage, entry]));
  const fromDir = path.join(REPO_ROOT, "packages", "parser-registry");
  const deviations = [];

  for (const langName of collectLanguagePackages()) {
    const entry = byName.get(langName);
    if (entry === undefined) {
      deviations.push(`${langName}: listed in manifest, absent from the record`);
      continue;
    }
    byName.delete(langName);
    const langDir = resolveInstalledPackage(langName, fromDir);
    if (langDir === undefined) {
      deviations.push(`${langName}: not installed; record cannot be verified`);
      continue;
    }
    const langManifest = readJson(path.join(langDir, "package.json"));
    if (String(langManifest.version) !== entry.languagePackageVersion) {
      deviations.push(
        `${langName}: installed ${String(langManifest.version)}, recorded ${entry.languagePackageVersion}`,
      );
    }
    const grammar = grammarOf(langManifest);
    if (grammar === undefined) {
      deviations.push(`${langName}: no unambiguous grammar in devDependencies`);
      continue;
    }
    if (grammar.name !== entry.grammar || grammar.version !== entry.grammarVersion) {
      deviations.push(
        `${langName}: grammar ${grammar.name}@${grammar.version}, ` +
          `recorded ${entry.grammar}@${entry.grammarVersion}`,
      );
    }
  }
  for (const leftover of [...byName.keys()].sort(compareCodepoints)) {
    deviations.push(`${leftover}: recorded, but no longer in the manifest`);
  }

  if (deviations.length > 0) {
    process.stderr.write(`grammar-provenance: ${String(deviations.length)} difference(s):\n\n`);
    for (const line of deviations) process.stderr.write(`  ${line}\n`);
    process.stderr.write("\nNext step: run `pnpm grammar-provenance --update`.\n");
    return 2;
  }
  process.stdout.write(
    `grammar-provenance: ${String(record.entries.length)} language packages; the record matches the installation.
`,
  );
  return 0;
}

const wantsUpdate = process.argv.slice(2).includes("--update");
process.exitCode = wantsUpdate ? await update() : check();
