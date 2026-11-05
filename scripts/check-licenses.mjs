#!/usr/bin/env node
/**
 * Fails CI when a production dependency anywhere in the workspace carries a
 * license outside the allowlist.
 *
 * Rationale (docs/BUILD_PLAN.md, risk R6 / architecture.md §2.4 clean-room
 * boundary): Untangle is built clean-room, and grammars/libraries with
 * copyleft licenses (GPL family) must never end up in a published npm
 * package. This check is the automated backstop for that rule; per-package
 * `THIRD_PARTY_LICENSES.md` files (owned by the packages embedding native
 * grammars, e.g. parser-registry) remain the human-readable record.
 *
 * Uses `pnpm licenses list --json --prod` (no extra dependency needed) and
 * only inspects production dependencies — dev tooling licenses do not ship.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "BlueOak-1.0.0",
]);

// Some registries report multi-license expressions like "(MIT OR Apache-2.0)"
// or "MIT AND ISC". Treat the whole set as allowed only if EVERY alternative
// resolves to an allowed license — conservative by design.
function licenseIsAllowed(licenseField) {
  if (!licenseField || licenseField === "Unknown") {
    return false;
  }
  const tokens = licenseField
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => ALLOWED_LICENSES.has(token));
}

const NO_DEPENDENCIES_MARKER = "No licenses in packages found";

function loadLicenseReport() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // `pnpm licenses list --json` still prints this plain-text sentinel (not
  // JSON) when there are zero production dependencies anywhere in the
  // workspace, e.g. a fresh scaffold with only devDependencies.
  if (raw.trim() === "" || raw.includes(NO_DEPENDENCIES_MARKER)) {
    return {};
  }
  return JSON.parse(raw);
}

function collectViolations(report) {
  const violations = [];
  // `pnpm licenses list --json` shape: { [licenseName]: LicensePackage[] }
  for (const [licenseName, packages] of Object.entries(report)) {
    if (licenseIsAllowed(licenseName)) {
      continue;
    }
    for (const pkg of packages) {
      violations.push({
        license: licenseName,
        name: pkg.name,
        version: pkg.versions?.[0] ?? pkg.version ?? "unknown",
      });
    }
  }
  return violations;
}

/**
 * ZWEITER DURCHGANG: die eingebetteten tree-sitter-Grammatiken (WP-245).
 *
 * `pnpm licenses list --prod` sieht sie NICHT — gemessen. Die Sprachpakete
 * `@ast-grep/lang-*` haengen als OPTIONALE `peerDependencies` an
 * `packages/parser-registry`; im Workspace sind sie zusaetzlich
 * devDependencies, und `--prod` blendet beides aus. Ohne diesen Durchgang
 * pruefte der Waechter genau die dreizehn Pakete nicht, die zuletzt
 * dazugekommen sind.
 *
 * Zweitens — und wichtiger — waere selbst ein Treffer im ersten Durchgang
 * irrefuehrend: dort erschiene die Lizenz, die das SPRACHPAKET fuer sich
 * deklariert (ISC). Die Grammatik darin ist ein fremdes Werk mit eigener
 * Lizenz. Genau die prueft dieser Durchgang, aus der Aufzeichnung von
 * `pnpm grammar-provenance --update`.
 */
function collectGrammarViolations() {
  const file = path.join(REPO_ROOT, "scripts", "astgrep-grammar-provenance.json");
  if (!existsSync(file)) {
    return {
      fatal:
        "check-licenses: scripts/astgrep-grammar-provenance.json is missing; embedded\n" +
        "grammars therefore remain unverified.\n" +
        "Next step: run `pnpm grammar-provenance --update` (requires network access).",
      violations: [],
      checked: 0,
    };
  }
  const record = JSON.parse(readFileSync(file, "utf8"));
  const violations = [];
  for (const entry of record.entries) {
    // Eine ungeklaerte Lizenz ist KEIN Freibrief. Sie faellt hier durch, damit
    // niemand sie fuer geprueft haelt (BUILD_PLAN E4).
    if (entry.grammarLicense === null) {
      violations.push({
        name: `${entry.grammar}@${entry.grammarVersion} (in ${entry.languagePackage})`,
        version: entry.grammarVersion,
        license: `UNRESOLVED — header "${entry.grammarLicenseHeader}"`,
      });
      continue;
    }
    if (!licenseIsAllowed(entry.grammarLicense)) {
      violations.push({
        name: `${entry.grammar}@${entry.grammarVersion} (in ${entry.languagePackage})`,
        version: entry.grammarVersion,
        license: entry.grammarLicense,
      });
    }
  }
  return { fatal: undefined, violations, checked: record.entries.length };
}

function main() {
  let report;
  try {
    report = loadLicenseReport();
  } catch (error) {
    // No production dependencies yet (fresh scaffold) is not a failure.
    if (error.stdout && String(error.stdout).trim() === "{}") {
      console.log("check-licenses: no production dependencies found, nothing to check.");
      process.exit(0);
    }
    console.error("check-licenses: failed to run `pnpm licenses list`.");
    console.error(String(error.stderr ?? error.message ?? error));
    process.exit(1);
  }

  const violations = collectViolations(report);
  const grammars = collectGrammarViolations();

  if (grammars.fatal !== undefined) {
    console.error(grammars.fatal);
    process.exit(1);
  }

  const all = [...violations, ...grammars.violations];
  if (all.length > 0) {
    console.error("check-licenses: disallowed license(s) found:\n");
    for (const violation of violations) {
      console.error(`  - ${violation.name}@${violation.version} — license: ${violation.license}`);
    }
    for (const violation of grammars.violations) {
      console.error(`  - embedded grammar ${violation.name} — license: ${violation.license}`);
    }
    console.error(
      `\nAllowlist: ${[...ALLOWED_LICENSES].join(", ")}\n` +
        "See docs/BUILD_PLAN.md (risk R6) and architecture.md §2.4.",
    );
    process.exit(1);
  }

  console.log(
    "check-licenses: all production dependency licenses are allowed " +
      `(plus ${String(grammars.checked)} embedded tree-sitter grammars).`,
  );
}

main();
