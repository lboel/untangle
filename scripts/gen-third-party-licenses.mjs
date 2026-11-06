#!/usr/bin/env node
/**
 * `pnpm third-party-licenses` — WP-221 / BUILD_PLAN Risiko R6.
 *
 * R6 erklaert eine `THIRD_PARTY_LICENSES.md` JE PAKET ausdruecklich zum
 * "Release-Blocker bei npm-Publish". Es existierte keine einzige. Zwei Wege
 * standen offen: R6 begruendet zurueckziehen oder die Dateien erzeugen.
 * Entschieden wurde das Erzeugen — die Dateien sind die menschenlesbare
 * Seite dessen, was `scripts/check-licenses.mjs` maschinell erzwingt, und
 * genau das braucht ein Empfaenger eines Tarballs: er sieht die npm-Paketseite
 * und die Dateien im Tarball, nicht unser CI-Log.
 *
 * Quelle ist NICHT eine handgepflegte Liste, sondern der tatsaechlich
 * aufgeloeste Produktions-Abhaengigkeitsbaum:
 *
 *   pnpm licenses list --json --prod --filter <paketname>
 *
 * Damit steht in der Datei nichts Erfundenes. Workspace-eigene Pakete
 * (`@untangle-code/*`) tauchen dort nicht auf — sie sind Teil desselben
 * Werks und stehen unter AGPL-3.0-only (LICENSE, NOTICE).
 *
 * Ein Paket OHNE Drittabhaengigkeiten bekommt trotzdem eine Datei, die das
 * ausdruecklich sagt. Eine fehlende Datei und eine leere Liste sind zwei
 * verschiedene Aussagen (BUILD_PLAN E4: kein stilles Ueberspringen).
 *
 * Exit-Codes:
 *   0  Alle Dateien geschrieben (bzw. mit --check: aktuell).
 *   1  Betriebsfehler.
 *   2  Nur mit --check: mindestens eine Datei fehlt oder ist veraltet.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE_NAME = "THIRD_PARTY_LICENSES.md";
const WORKSPACE_SCOPE = "@untangle-code/";

/** Sortierung nach Codepoints — nie `localeCompare` (Determinismus-Regel). */
function compareCodepoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function collectWorkspacePackages() {
  const byName = new Map();
  const dirs = [];
  for (const group of ["packages", "apps"]) {
    const groupDir = path.join(REPO_ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const manifestPath = path.join(groupDir, entry, "package.json");
      if (!existsSync(manifestPath)) continue;
      const pkg = readJson(manifestPath);
      const record = {
        dir: `${group}/${entry}`,
        absDir: path.join(groupDir, entry),
        name: pkg.name,
        pkg,
      };
      byName.set(pkg.name, record);
      dirs.push(record);
    }
  }
  dirs.sort((a, b) => compareCodepoints(a.dir, b.dir));
  return { byName, dirs };
}

/**
 * Loest `depName` von `fromDir` aus so auf, wie Node es zur Laufzeit taete:
 * `node_modules/<depName>` aufwaerts suchen, Symlinks aufloesen (pnpm legt
 * je Paket eigene `node_modules` mit Links in den Store). Liefert den ECHTEN
 * Ordner des installierten Pakets oder undefined.
 */
function resolveInstalledPackage(depName, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", depName, "package.json");
    if (existsSync(candidate)) return path.dirname(realpathSync(candidate));
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** npm erlaubt String, Objekt und (veraltet) ein Array. Alles drei abdecken. */
function normalizeLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l) => (typeof l === "string" ? l : (l?.type ?? "")))
      .filter(Boolean);
    if (types.length > 0) return types.join(" OR ");
  }
  return "UNBEKANNT";
}

function normalizeHomepage(pkg) {
  if (typeof pkg.homepage === "string" && pkg.homepage !== "") return pkg.homepage;
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return typeof url === "string" ? url.replace(/^git\+/, "").replace(/\.git$/, "") : "";
}

/**
 * Produktionsabschluss EINES Workspace-Pakets: `dependencies` transitiv,
 * durch Workspace-Pakete HINDURCH (deren `dependencies` gehoeren zum selben
 * Installationsbaum eines Nutzers), `devDependencies` nirgends.
 *
 * `pnpm licenses list --filter` taugt dafuer nicht: mit `<name>` sieht es
 * nicht durch Workspace-Kanten hindurch (apps/cli haette dann NULL
 * Drittabhaengigkeiten, obwohl `npm i @untangle-code/cli` tree-sitter
 * installiert), mit `<name>...` zieht es die devDependencies der
 * Workspace-Nachbarn mit herein (vitest, rollup, esbuild). Beides waere eine
 * Unwahrheit im Tarball; deshalb wird der Abschluss hier selbst gebildet.
 *
 * @returns {{rows: {name:string,version:string,license:string,homepage:string}[], unresolved: string[]}}
 */
export function collectProductionClosure(record, workspaceByName) {
  const rows = new Map();
  const unresolved = new Set();
  const seenWorkspace = new Set();
  const seenExternal = new Set();
  const optionalPeers = new Set();
  const nativeVariants = new Map();
  const resolvedNativeVariants = new Map();

  function visitLanceNativeVariants(pkg, installDir) {
    const provenance = readJson(path.join(REPO_ROOT, "scripts/lancedb-native-provenance.json"));
    if (
      provenance.package !== pkg.name ||
      provenance.version !== pkg.version ||
      provenance.schemaVersion !== 1
    )
      throw new Error("LanceDB native optional provenance does not match the installed SDK.");
    const declarations = Object.entries(pkg.optionalDependencies ?? {}).sort(([a], [b]) =>
      compareCodepoints(a, b),
    );
    const expected = provenance.variants
      .map((variant) => [variant.name, variant.version])
      .sort(([a], [b]) => compareCodepoints(a, b));
    if (JSON.stringify(declarations) !== JSON.stringify(expected))
      throw new Error(
        "LanceDB optional dependency declarations changed; refresh source-bound native provenance before releasing.",
      );
    for (const variant of provenance.variants) {
      if (
        !/^[a-f0-9]{64}$/.test(variant.manifestSha256) ||
        variant.source !==
          `https://registry.npmjs.org/${encodeURIComponent(variant.name)}/${variant.version}` ||
        typeof variant.license !== "string"
      )
        throw new Error("Invalid published LanceDB native package provenance.");
      nativeVariants.set(`${variant.name}@${variant.version}`, variant);
      const nativeDir = resolveInstalledPackage(variant.name, installDir);
      if (nativeDir === undefined) continue;
      const installed = readJson(path.join(nativeDir, "package.json"));
      if (
        installed.name !== variant.name ||
        installed.version !== variant.version ||
        normalizeLicense(installed) !== variant.license ||
        JSON.stringify(installed.dependencies ?? {}) !== JSON.stringify(variant.dependencies) ||
        JSON.stringify(installed.optionalDependencies ?? {}) !==
          JSON.stringify(variant.optionalDependencies)
      )
        throw new Error(
          `Installed native metadata differs from published provenance: ${variant.name}`,
        );
      resolvedNativeVariants.set(variant.name, {
        name: installed.name,
        version: installed.version,
        license: normalizeLicense(installed),
      });
      for (const dependency of Object.keys(installed.dependencies ?? {}).sort(compareCodepoints))
        visitExternal(dependency, nativeDir);
    }
  }

  /** @param {string} depName @param {string} fromDir */
  function visitExternal(depName, fromDir) {
    const installDir = resolveInstalledPackage(depName, fromDir);
    if (installDir === undefined) {
      unresolved.add(depName);
      return;
    }
    if (seenExternal.has(installDir)) return;
    seenExternal.add(installDir);

    const pkg = readJson(path.join(installDir, "package.json"));
    const key = `${String(pkg.name ?? depName)}@${String(pkg.version ?? "unknown")}`;
    rows.set(key, {
      name: String(pkg.name ?? depName),
      version: String(pkg.version ?? "unknown"),
      license: normalizeLicense(pkg),
      homepage: normalizeHomepage(pkg),
    });
    for (const next of Object.keys(pkg.dependencies ?? {}).sort(compareCodepoints)) {
      visitExternal(next, installDir);
    }
    // The SDK's optional dependencies are platform-native runtime packages,
    // not optional peer integrations. Keep all declarations deterministic,
    // verify every installed variant and retain its transitive attribution.
    if (pkg.name === "@lancedb/lancedb") visitLanceNativeVariants(pkg, installDir);
  }

  function visitWorkspace(current) {
    if (seenWorkspace.has(current.name)) return;
    seenWorkspace.add(current.name);
    // Optionale `peerDependencies` sind KEINE Abhaengigkeiten dieses Tarballs —
    // npm installiert sie nachweislich nicht mit (gemessen, WP-245). Sie
    // gehoeren trotzdem in die Liste: wer sie installiert, um eine Sprache
    // freizuschalten, holt sich fremde Grammatiken ins Projekt, und diese
    // Datei ist der Ort, an dem er ihre Lizenz findet. Sie stehen deshalb in
    // einem EIGENEN Abschnitt, getrennt von dem, was wirklich mitkommt.
    const peerMeta = current.pkg.peerDependenciesMeta ?? {};
    for (const depName of Object.keys(current.pkg.peerDependencies ?? {}).sort(compareCodepoints)) {
      if (peerMeta[depName]?.optional === true) optionalPeers.add(depName);
    }
    for (const depName of Object.keys(current.pkg.dependencies ?? {}).sort(compareCodepoints)) {
      if (depName.startsWith(WORKSPACE_SCOPE)) {
        const next = workspaceByName.get(depName);
        if (next === undefined) {
          unresolved.add(depName);
          continue;
        }
        visitWorkspace(next);
        continue;
      }
      visitExternal(depName, current.absDir);
    }
  }

  visitWorkspace(record);

  return {
    rows: [...rows.values()].sort(
      (a, b) => compareCodepoints(a.name, b.name) || compareCodepoints(a.version, b.version),
    ),
    unresolved: [...unresolved].sort(compareCodepoints),
    optionalPeers: [...optionalPeers].sort(compareCodepoints),
    nativeVariants: [...nativeVariants.values()].sort((a, b) => compareCodepoints(a.name, b.name)),
    resolvedNativeVariants: [...resolvedNativeVariants.values()].sort((a, b) =>
      compareCodepoints(a.name, b.name),
    ),
  };
}

export function renderLanceNativeSection(variants) {
  if (variants.length === 0) return "";
  return [
    "",
    "## LanceDB platform-native runtime packages",
    "",
    "The SDK declares the following native optional dependencies. Package names, pinned versions",
    "and SPDX license declarations come from the published version manifests recorded with hashes",
    "in `scripts/lancedb-native-provenance.json`. Every native variant actually resolved on the",
    "generating platform is checked against that metadata; its dependencies are included above.",
    "This table is a declaration inventory, not a claim that all seven binaries were installed or",
    "inspected. The release's installed production SBOM records the actual platform selection.",
    "Upstream package license files and notices continue to apply and remain distributed by npm.",
    "",
    "| Native package | Version | Declared license | Published manifest |",
    "| --- | --- | --- | --- |",
    ...variants.map(
      (variant) =>
        `| \`${variant.name}\` | ${variant.version} | ${variant.license} | <${variant.source}> |`,
    ),
    "",
  ].join("\n");
}

/**
 * Die Grammatik-Herkunft aus `scripts/astgrep-grammar-provenance.json`
 * (erzeugt von `pnpm grammar-provenance --update`, siehe dort).
 *
 * WARUM DIESER ABSCHNITT EXISTIEREN MUSS: die Pakete `@ast-grep/lang-*`
 * liefern fremde tree-sitter-Grammatiken aus — `src/parser.c` ist bei allen
 * zwoelf geprueften Paketen BYTEGLEICH mit dem der jeweiligen Grammatik —,
 * nennen in ihrer eigenen `LICENSE` aber nur "Copyright (c) 2025 ast-grep".
 * Weder der Name noch der Urheberrechtsvermerk der Grammatikautoren steht
 * dort. Wer diese Pakete weitergibt, gibt deren Werk mit weiter und schuldet
 * ihnen die Nennung; deshalb traegt Untangle sie hier selbst nach.
 */
function loadGrammarProvenance() {
  const file = path.join(REPO_ROOT, "scripts", "astgrep-grammar-provenance.json");
  if (!existsSync(file)) return undefined;
  return readJson(file);
}

function renderGrammarSection(provenance, optionalPeers, closureNames) {
  const relevant = provenance.entries.filter(
    (entry) =>
      optionalPeers.includes(entry.languagePackage) || closureNames.has(entry.languagePackage),
  );
  if (relevant.length === 0) return "";

  const lines = [
    ``,
    `## Embedded tree-sitter grammars (${String(relevant.length)})`,
    ``,
    `The \`@ast-grep/lang-*\` packages distribute third-party tree-sitter grammars:`,
    `their \`src/parser.c\` files are byte-identical to the listed grammar versions,`,
    `as verified by \`pnpm grammar-provenance --update\``,
    `(field \`parserMatchesGrammar\`). However, their own \`LICENSE\` only names`,
    `\`Copyright (c) 2025 ast-grep\`; the grammar authors are not listed there.`,
    `Untangle therefore records their notices here.`,
    ``,
    `| Language package | Dependency | Grammar | License | Copyright notice |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const entry of relevant) {
    const kind = closureNames.has(entry.languagePackage)
      ? "Dependency"
      : "optional; install separately";
    const license =
      entry.grammarLicense ?? `**unresolved** (header: \`${entry.grammarLicenseHeader}\`)`;
    const holders =
      entry.grammarCopyright.length > 0
        ? entry.grammarCopyright.join("<br>")
        : "**not identifiable**";
    lines.push(
      `| \`${entry.languagePackage}\` | ${kind} | \`${entry.grammar}\` ${entry.grammarVersion} | ${license} | ${holders} |`,
    );
  }
  lines.push(
    ``,
    `**An unresolved question that Untangle cannot decide.** All language packages above`,
    `declare \`"license": "ISC"\` in \`package.json\`, but include an **MIT** license text.`,
    `Both declarations cannot apply simultaneously. Which declaration ast-grep intends`,
    `cannot be determined externally; this file records`,
    `the contradiction instead of inventing a resolution. For the embedded`,
    `grammars, the license is unambiguous: the table uses the license text`,
    `inside each grammar version's tarball rather than its`,
    `registry metadata's \`license\` field.`,
    ``,
    `Packages marked *optional* are not included in an Untangle installation:`,
    `they are optional \`peerDependencies\`, which npm`,
    `does not install automatically. They are listed for users who`,
    `add them to enable the corresponding language.`,
    ``,
  );
  return lines.join("\n");
}

function renderMarkdown(packageName, rows, grammarSection) {
  const head =
    `# Third-party licenses — ${packageName}\n` +
    `\n` +
    `Generated by \`pnpm third-party-licenses\` from this package's installed
` +
    `production dependency tree: transitive \`dependencies\`, across
` +
    `workspace edges, with no \`devDependencies\` included. The generator reads
` +
    `each resolved package's \`package.json\` in \`node_modules\`; nothing is maintained by hand
` +
    `or estimated.
` +
    `\n` +
    `Do not edit manually: \`pnpm third-party-licenses --check\` fails on drift,
` +
    `and \`pnpm check-publishable\` rejects packages without a current file.
` +
    `\n` +
    `This file exists because \`docs/BUILD_PLAN.md\`, risk R6, makes
` +
    `per-package \`THIRD_PARTY_LICENSES.md\` a release gate for npm publication.
` +
    `\n` +
    `Untangle itself is **AGPL-3.0-only** (see \`LICENSE\` and \`NOTICE\` in
` +
    `this package). The packages below are third-party works; their own
` +
    `licenses and copyright notices continue to apply unchanged. Workspace
` +
    `packages (\`@untangle-code/*\`) are not listed here; they belong to the same
` +
    `work and use the same AGPL-3.0-only license.
` +
    `\n`;

  if (rows.length === 0) {
    return (
      head +
      `## Result: no third-party dependencies
` +
      `\n` +
      `This package has no production dependencies outside the workspace.
` +
      `The list is empty because none exist, not because they were not checked.
` +
      grammarSection
    );
  }

  const lines = [
    `## Production dependencies (transitive, ${String(rows.length)})`,
    ``,
    `| Package | Version | License | Project |`,
    `| --- | --- | --- | --- |`,
  ];
  for (const row of rows) {
    // Nur echte http(s)-Adressen als Link — npm-Kurzformen wie
    // "github:owner/repo" sind keine URL und wuerden als toter Link erscheinen.
    const home =
      row.homepage === ""
        ? "—"
        : /^https?:\/\//.test(row.homepage)
          ? `<${row.homepage}>`
          : `\`${row.homepage}\``;
    lines.push(`| \`${row.name}\` | ${row.version} | ${row.license} | ${home} |`);
  }
  lines.push("");
  lines.push(
    `The allowlist (MIT / Apache-2.0 / BSD / ISC / …) is checked by`,
    `\`scripts/check-licenses.mjs\` against this exact tree on every run;`,
    `the GPL family is excluded (architecture.md §2.4, BUILD_PLAN R6).`,
    ``,
  );
  return head + lines.join("\n") + grammarSection;
}

function main(argv) {
  const checkOnly = argv.includes("--check");
  const selectors = argv.filter((arg) => arg.startsWith("--package="));
  if (
    selectors.length > 1 ||
    argv.some((arg) => arg !== "--check" && !arg.startsWith("--package="))
  ) {
    process.stderr.write(
      "third-party-licenses: use --check and at most one --package=<public-package-name>.\n",
    );
    return 1;
  }
  const selectedName = selectors[0]?.slice("--package=".length);
  const { byName, dirs } = collectWorkspacePackages();
  const publishable = dirs.filter(
    (record) =>
      record.pkg.private !== true && (selectedName === undefined || record.name === selectedName),
  );
  if (publishable.length === 0) {
    process.stderr.write(
      selectedName === undefined
        ? "third-party-licenses: no publishable package found.\n"
        : `third-party-licenses: unknown or private package ${JSON.stringify(selectedName)}.\n`,
    );
    return 1;
  }

  const stale = [];
  let written = 0;

  const provenance = loadGrammarProvenance();
  if (provenance === undefined) {
    // Ohne die Aufzeichnung waere die Grammatiktabelle still weg, und die
    // Datei behauptete Vollstaendigkeit, die sie nicht hat (E4).
    process.stderr.write(
      "third-party-licenses: scripts/astgrep-grammar-provenance.json is missing.\n" +
        "Next step: run `pnpm grammar-provenance --update` (requires network access).\n",
    );
    return 1;
  }

  for (const record of publishable) {
    const { rows, unresolved, optionalPeers, nativeVariants } = collectProductionClosure(
      record,
      byName,
    );

    // Eine nicht aufloesbare Abhaengigkeit darf NICHT stillschweigend aus der
    // Liste fallen — die Datei behauptete sonst Vollstaendigkeit, die sie
    // nicht hat (BUILD_PLAN E4).
    if (unresolved.length > 0) {
      process.stderr.write(
        `third-party-licenses: ${record.name} — ${String(unresolved.length)} dependency/dependencies ` +
          `could not be resolved: ${unresolved.join(", ")}\n` +
          `Next step: run \`pnpm install\` and try again.
`,
      );
      return 1;
    }

    const closureNames = new Set(rows.map((row) => row.name));
    const markdown = renderMarkdown(
      record.name,
      rows,
      renderGrammarSection(provenance, optionalPeers, closureNames) +
        renderLanceNativeSection(nativeVariants),
    );
    const target = path.join(REPO_ROOT, record.dir, FILE_NAME);
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;

    if (current === markdown) continue;

    if (checkOnly) {
      stale.push(
        current === undefined
          ? `${record.dir}/${FILE_NAME}: missing`
          : `${record.dir}/${FILE_NAME}: outdated`,
      );
      continue;
    }
    writeFileSync(target, markdown);
    written += 1;
    process.stdout.write(
      `  written: ${record.dir}/${FILE_NAME} (${String(rows.length)} entries)\n`,
    );
  }

  if (checkOnly) {
    if (stale.length === 0) {
      process.stdout.write(
        `third-party-licenses --check: ${String(publishable.length)} packages have a current ${FILE_NAME}.\n`,
      );
      return 0;
    }
    process.stderr.write(
      `third-party-licenses --check: ${String(stale.length)} difference(s):\n\n`,
    );
    for (const entry of stale) process.stderr.write(`  ${entry}\n`);
    process.stderr.write("\nNext step: run `pnpm third-party-licenses`.\n");
    return 2;
  }

  process.stdout.write(
    `third-party-licenses: ${String(written)} file(s) written, ` +
      `${String(publishable.length)} packages checked.
`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
