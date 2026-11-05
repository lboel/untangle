/**
 * REGRESSION fuer `scripts/complexity-report.mjs` (Welle-3-Befunde 1 und 3).
 *
 * Der Report ist das Werkzeug, mit dem sich dieses Repo SELBST misst und nach
 * dem die Reparaturreihenfolge priorisiert wird. Zwei Loecher darin waren
 * belegt:
 *
 * 1. `parseQuality` wurde je Datei eingesammelt und danach nie wieder gelesen.
 *    Zwei Dateien mit ERROR-Knoten gingen mit kaputtem Syntaxbaum in JEDE
 *    Kennzahl ein — drei echte Methoden fehlten in der Analyse, und Hotspot
 *    #22 trug den Wert 54 statt 7. Weder Ledger noch Ausgabe erwaehnten das.
 * 2. `duplicatesDropped` — der einzige Zaehler, der stillen Inhaltsverlust
 *    durch Id-duplicatesn sichtbar macht — kam in der Ausgabe nicht vor;
 *    stattdessen stand dort eine fest verdrahtete "0".
 *
 * Geprueft wird gegen den ECHTEN Lauf des Skripts auf einem eigenen kleinen
 * Wurzelverzeichnis, nicht gegen nachgebaute Zwischenstufen: beide Defekte
 * sassen genau in der Verdrahtung zwischen Sammeln und Ausgeben.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "complexity-report.mjs");

/** Gueltiges TypeScript mit genug Kontrollfluss fuer einen Hotspot-Eintrag. */
const CLEAN_TS = `export function classify(value: number, flag: boolean): string {
  if (value > 10) {
    if (flag) {
      return "big-flagged";
    }
    return "big";
  }
  for (let index = 0; index < value; index += 1) {
    if (index % 2 === 0 && flag) {
      return "even";
    }
  }
  return "small";
}
`;

/**
 * Ueberwiegend gueltiges TypeScript mit EINER kaputten Anweisung. Der Baum
 * bleibt nutzbar (`parseQuality: "partial"`), traegt aber error nodes —
 * genau die Lage, in der der Report frueher stillschweigend weiterrechnete.
 * `damaged` ist bewusst die komplexeste Funktion beider Dateien: waere sie in
 * den Zahlen, stuende sie an der Spitze der Hotspot-Liste.
 */
const BROKEN_TS = `export function damaged(values: number[], flag: boolean): number {
  let total = 0;
  for (const value of values) {
    if (value > 0) {
      if (flag) {
        total += value;
      } else if (value % 2 === 0) {
        total -= value;
      } else {
        total += 1;
      }
    }
  }
  return total;
}

export const oops = ;

export function tail(a: number): number {
  return a * 2;
}
`;

interface DegradedParse {
  relativePath: string;
  parseQuality: string;
  errorNodeCount: number;
  missingNodeCount: number;
  damagedBytes: number;
  totalBytes: number;
}

interface ReportJson {
  files: number;
  fileAccounting: { discovered: number; analyzed: number; ledgered: number; unaccounted: number };
  degradedParses: DegradedParse[];
  duplicatesDropped: { cognitive: number; cyclomatic: number };
  invariants: {
    cognitiveValueViolations: number;
    cyclomaticValueViolations: number;
    cognitiveCoverageViolations: number;
    cyclomaticCoverageViolations: number;
  };
  hotspots: { relativePath?: string; name?: string; value: number }[];
  skipLedger: { entries: { path?: string; reason: string; detail: string }[] };
  skipLedgerIssues: unknown[];
}

let fixtureRoot: string;

function run(args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return { status: result.status ?? -1, stdout: result.stdout };
}

beforeAll(() => {
  // Das Skript laeuft gegen die GEBAUTEN dists der Pakete (wie
  // scripts/e2e-smoke.mjs). Fehlen sie, soll das laut scheitern und nicht
  // still uebersprungen werden — ein uebersprungener Test ist kein Test.
  const requiredDist = path.join(REPO_ROOT, "packages", "complexity", "dist", "index.js");
  if (!existsSync(requiredDist)) {
    throw new Error(
      `${requiredDist} fehlt. Dieser Test laeuft gegen die gebauten dists; bitte zuerst ` +
        `"pnpm -r build" ausfuehren.`,
    );
  }
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "untangle-report-"));
  writeFileSync(path.join(fixtureRoot, "clean.ts"), CLEAN_TS, "utf8");
  writeFileSync(path.join(fixtureRoot, "broken.ts"), BROKEN_TS, "utf8");
});

afterAll(() => {
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("complexity-report: Dateien mit beschaedigtem Syntaxbaum", () => {
  function report(): ReportJson {
    const { status, stdout } = run([`--root=${fixtureRoot}`, "--json"]);
    expect(status).toBe(0);
    return JSON.parse(stdout) as ReportJson;
  }

  it("weist die beschaedigte Datei einzeln aus, statt sie stillschweigend mitzurechnen", () => {
    const json = report();
    expect(json.degradedParses).toHaveLength(1);
    const degraded = json.degradedParses[0];
    expect(degraded?.relativePath).toBe("broken.ts");
    expect(degraded?.parseQuality).toBe("partial");
    expect(degraded?.errorNodeCount).toBeGreaterThan(0);
    expect(degraded?.damagedBytes).toBeGreaterThan(0);
    expect(degraded?.totalBytes).toBeGreaterThan(degraded?.damagedBytes ?? 0);
  });

  it("traegt sie mit Grund und Detailtext in den Skip-Ledger ein (E4)", () => {
    const json = report();
    const entry = json.skipLedger.entries.find((e) => e.path === "broken.ts");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("parse_failed");
    expect(entry?.detail).toContain("parseQuality");
    expect(entry?.detail).toContain("error nodes");
    expect(entry?.detail).toContain("no complexity measurement");
    expect(json.skipLedgerIssues).toEqual([]);
  });

  it("laesst sie aus jeder Zahl heraus — auch aus der Hotspot-Liste", () => {
    const json = report();
    expect(json.files).toBe(1);
    // `damaged` ist die komplexeste Funktion der Fixture. Stuende sie in der
    // Liste, waere die Datei mitgerechnet worden.
    expect(json.hotspots.map((h) => h.relativePath)).not.toContain("broken.ts");
    expect(json.hotspots.map((h) => h.name)).not.toContain("damaged");
    expect(json.hotspots.some((h) => h.relativePath === "clean.ts")).toBe(true);
  });

  it("rechnet die Dateibuchfuehrung auf: nichts verschwindet spurlos", () => {
    const json = report();
    expect(json.fileAccounting.discovered).toBe(2);
    expect(json.fileAccounting.analyzed).toBe(1);
    expect(json.fileAccounting.ledgered).toBe(1);
    expect(json.fileAccounting.unaccounted).toBe(0);
  });

  it("nennt die beschaedigte Datei auch in der Textausgabe, nicht nur im Ledger", () => {
    const { status, stdout } = run([`--root=${fixtureRoot}`]);
    expect(status).toBe(0);
    expect(stdout).toContain("PARSE QUALITY");
    // Nicht irgendwo im Text (unter einem Mutanten stuende die Datei in der
    // Hotspot-Liste und das genuegte schon), sondern in der Zeile von
    // Abschnitt 0b, die sie als beschaedigt ausweist.
    expect(stdout).toMatch(/^broken\.ts\s+partial\s+\d+\s+\d+\s+\d+\/\d+$/m);
    expect(stdout).toContain("contribute to no measurement in this report");
  });

  it("ist zwischen zwei Laeufen byte-gleich", () => {
    const first = run([`--root=${fixtureRoot}`]);
    const second = run([`--root=${fixtureRoot}`]);
    expect(first.stdout).toBe(second.stdout);
  });
});

describe("complexity-report: Zaehler, die frueher auf dem Weg zur Ausgabe verlorengingen", () => {
  it("gibt duplicatesDropped aus, statt eine fest verdrahtete 0 zu drucken", () => {
    const { status, stdout } = run([`--root=${fixtureRoot}`, "--json"]);
    expect(status).toBe(0);
    const json = JSON.parse(stdout) as ReportJson;
    expect(json.duplicatesDropped).toEqual({ cognitive: 0, cyclomatic: 0 });
    const text = run([`--root=${fixtureRoot}`]).stdout;
    expect(text).toContain("discarded ID duplicates");
  });

  it("weist die Zaehlpruefung je Lesart getrennt von der Wertschranke aus", () => {
    const { stdout } = run([`--root=${fixtureRoot}`, "--json"]);
    const json = JSON.parse(stdout) as ReportJson;
    expect(json.invariants.cognitiveCoverageViolations).toBe(0);
    expect(json.invariants.cyclomaticCoverageViolations).toBe(0);
    const text = run([`--root=${fixtureRoot}`]).stdout;
    expect(text).toContain("coverage count");
    // Die alte Ausgabe las sich als Zusicherung der Doppelzaehlungsfreiheit.
    // Sie muss jetzt sagen, was die Wertschranke NICHT leistet.
    expect(text).toContain("This does not detect");
  });

  it("bricht mit Exit 2 ab, wenn eine wertgleiche Id-Dublette verworfen wuerde", () => {
    // E5: der Abbruchpfad wird vorgefuehrt, nicht behauptet.
    const { status, stdout } = run([`--root=${fixtureRoot}`, "--selftest-duplicate"]);
    expect(status).toBe(2);
    expect(stdout).toContain("duplicates");
    expect(stdout).toContain("ABORT");
  });

  it("bricht mit Exit 2 ab, wenn eine Invariante verletzt ist", () => {
    const { status, stdout } = run([`--root=${fixtureRoot}`, "--selftest-violation"]);
    expect(status).toBe(2);
    expect(stdout).toContain("children_exceed_parent");
    expect(stdout).toContain("ABORT");
  });
});
