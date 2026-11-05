/**
 * WP-218 — DIE VERDRAHTUNG SELBST ALS TEST.
 *
 * Der Fehler, den diese Datei unmoeglich machen soll, sah so aus:
 *
 *   apps/cli/src/commands/init.ts        ein Stub: schreibt eine nackte
 *                                        .untangle.json, keine Erkennung
 *   apps/cli/src/commands/init/index.ts  die fertige Implementierung:
 *                                        Sprachen, Topologie, Dienste,
 *                                        kommentierte untangle.toml
 *
 * Der Einstiegspunkt importierte `./commands/init.js`. Beides uebersetzte,
 * beides war getestet, alles war gruen — und das ausgelieferte Binaer fuehrte
 * den Stub aus. Kein Typfehler, kein Lintfehler, kein fehlschlagender Test
 * konnte das melden, denn BEIDE Module waren gueltig und BEIDE hatten Tests.
 * Nur die Verbindung zwischen ihnen war falsch, und die hatte niemand
 * behauptet — also konnte auch niemand sie pruefen.
 *
 * Deshalb steht die Verbindung jetzt als Behauptung in der Spezifikation
 * jedes Befehls (`CommandSpec.implementedBy`), und dieser Test misst sie an
 * der Wirklichkeit auf der Platte. Drei Aussagen, die zusammen greifen:
 *
 *   1. DIE MENGE. Genau diese Befehle sind registriert — nicht mehr, nicht
 *      weniger. Ein neuer Befehl muss hier eingetragen werden und faellt
 *      damit auf, statt sich einzuschleichen.
 *   2. DIE IDENTITAET. Fuer jeden registrierten Befehl wird das in
 *      `implementedBy` genannte Modul GELADEN, und der registrierte Befehl
 *      muss DASSELBE OBJEKT sein, das dieses Modul exportiert. Ein Import
 *      vom Nachbarmodul faellt hier durch.
 *   3. KEINE SCHATTEN. Jede Datei unter `commands/` wird geladen und auf
 *      exportierte Befehle durchsucht. Jeder gefundene Befehl MUSS einer der
 *      registrierten sein. Ein zurueckgelassener Stub — genau die Datei, die
 *      WP-218 ausgeloest hat — ist damit ein FEHLSCHLAG mit Dateinamen, und
 *      zwar bevor er verdrahtet wird.
 *
 * Punkt 3 ist der teure, aber der einzige, der auch bei einem KUENFTIGEN
 * Befehl greift, den niemand hier eingetragen hat.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareCodepoints } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import type { Command } from "./cli/command.js";

import { COMMANDS } from "./index.js";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(SRC_DIR, "commands");

/**
 * DIE ERWARTETE MENGE — die einzige Liste in dieser Datei, die von Hand
 * gepflegt wird. Wer einen Befehl hinzufuegt oder entfernt, aendert sie
 * bewusst; wer es vergisst, sieht hier rot.
 *
 * Absichtlich nur die NAMEN. Das Modul eines Befehls wandert im Laufe des
 * Baus — `watch` kam aus `unavailable.js` heraus, `index` wird ihm folgen —
 * und eine hier eingefrorene Modulspalte wuerde jeden solchen Umzug zu einem
 * Testfehler machen, ohne dass etwas kaputt waere. Die Zuordnung Befehl ->
 * Modul wird stattdessen STRUKTURELL geprueft (Datei existiert, Identitaet
 * stimmt, Platzhalter geben sich als solche zu erkennen), und der eine Fall,
 * an dem sie schon einmal gebrochen ist — `init` —, ist unten ausdruecklich
 * festgenagelt.
 */
const EXPECTED_NAMES: readonly string[] = [
  "complexity",
  "doctor",
  "extensions",
  "flow",
  "graph",
  "index",
  "init",
  "mcp",
  "product",
  "query",
  "scan",
  "watch",
];

/** Der Platzhalter-Bauplan. Wer hierher zeigt, gibt zu, nichts zu koennen. */
const PLACEHOLDER_MODULE = "commands/unavailable.js";

function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { spec?: unknown; run?: unknown };
  if (typeof candidate.run !== "function") return false;
  const spec = candidate.spec;
  return (
    typeof spec === "object" && spec !== null && typeof (spec as Command["spec"]).name === "string"
  );
}

/** `commands/init/index.js` -> absoluter Pfad der QUELLE `.../commands/init/index.ts`. */
function sourcePathOf(implementedBy: string): string {
  const withoutExtension = implementedBy.replace(/\.js$/u, "");
  return path.join(SRC_DIR, `${withoutExtension}.ts`);
}

/** Jede `.ts`-Datei unter `commands/`, ohne Tests und Testhilfen. */
function commandSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...commandSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry === "test-support.ts") continue;
    found.push(full);
  }
  return found.sort(compareCodepoints);
}

/**
 * Laedt ein Modul und gibt die Befehle zurueck, die es exportiert.
 *
 * Ein Modul, das sich nicht laden laesst, ist ein eigener, benannter Befund
 * — kein Absturz dieser ganzen Testdatei. Der Unterschied ist praktisch:
 * waehrend an einem neuen Befehl gearbeitet wird, liegt sein Modul zeitweise
 * halbfertig im Baum, und eine Fehlermeldung "Unterminated string literal in
 * <Datei>" ist eine Diagnose, ein wortloser Suite-Abbruch nicht.
 */
async function exportedCommands(
  file: string,
): Promise<{ commands: Command[]; loadError?: string }> {
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    return { commands: [], loadError: error instanceof Error ? error.message : String(error) };
  }
  return { commands: Object.values(module).filter(isCommand) };
}

describe("Befehlsverdrahtung (WP-218)", () => {
  it("registriert genau die erwartete Menge von Befehlen", () => {
    // Codepoint-sortiert verglichen: die Reihenfolge im Einstiegspunkt folgt
    // dem Nutzerweg, nicht dem Alphabet, und soll frei bleiben.
    const actual = COMMANDS.map((command) => command.spec.name).sort(compareCodepoints);
    expect(actual).toEqual(EXPECTED_NAMES);
  });

  it("jeder Befehl behauptet ueberhaupt ein Modul", () => {
    for (const command of COMMANDS) {
      expect(
        command.spec.implementedBy,
        `${command.spec.name}: implementedBy fehlt oder ist leer.`,
      ).toMatch(/^commands\/[\w./-]+\.js$/u);
    }
  });

  it("jeder Befehl nennt ein Modul, das es wirklich gibt", () => {
    for (const command of COMMANDS) {
      const source = sourcePathOf(command.spec.implementedBy);
      expect(
        statSync(source, { throwIfNoEntry: false })?.isFile() ?? false,
        `${command.spec.name}: implementedBy zeigt auf "${source}" — die Datei gibt es nicht.`,
      ).toBe(true);
    }
  });

  it.each(COMMANDS.map((command) => command.spec.name))(
    "%s ist DASSELBE OBJEKT, das sein Modul exportiert — kein Nachbarmodul",
    async (name) => {
      const command = COMMANDS.find((entry) => entry.spec.name === name) as Command;
      const loaded = await exportedCommands(sourcePathOf(command.spec.implementedBy));
      expect(
        loaded.loadError,
        `${name}: "${command.spec.implementedBy}" laesst sich nicht laden.`,
      ).toBeUndefined();
      const match = loaded.commands.find((entry) => entry.spec.name === name);
      expect(
        match,
        `${name}: "${command.spec.implementedBy}" exportiert keinen Befehl dieses Namens.`,
      ).toBeDefined();
      // Identitaet, nicht Gleichheit: zwei strukturgleiche Stubs waeren
      // `toEqual`, aber nur einer ist der verdrahtete.
      expect(match).toBe(command);
    },
  );

  it("kein Modul unter commands/ bietet einen Befehl an, der nirgends registriert ist", async () => {
    const registered = new Set<Command>(COMMANDS);
    const orphans: string[] = [];
    const unloadable: string[] = [];
    for (const file of commandSourceFiles(COMMANDS_DIR)) {
      const loaded = await exportedCommands(file);
      if (loaded.loadError !== undefined) {
        unloadable.push(`${path.relative(SRC_DIR, file)}: ${loaded.loadError}`);
        continue;
      }
      for (const command of loaded.commands) {
        if (registered.has(command)) continue;
        orphans.push(`${path.relative(SRC_DIR, file)} -> "${command.spec.name}"`);
      }
    }
    expect(
      unloadable,
      `Diese Module unter commands/ liessen sich nicht laden und konnten deshalb ` +
        `NICHT auf verwaiste Befehle geprueft werden:\n  ${unloadable.join("\n  ")}`,
    ).toEqual([]);
    // Genau so sah WP-218 aus: `commands/init.ts` exportierte einen zweiten,
    // aermeren `initCommand`, und der Einstiegspunkt griff daneben.
    expect(orphans, `Nicht registrierte Befehle gefunden:\n  ${orphans.join("\n  ")}`).toEqual([]);
  });

  it("nur Platzhalter zeigen auf den Platzhalter-Bauplan, und sie geben es zu", () => {
    for (const command of COMMANDS) {
      const isPlaceholderModule = command.spec.implementedBy === PLACEHOLDER_MODULE;
      const claimsNotBuilt = command.spec.notYetBuilt === true;
      expect(
        isPlaceholderModule,
        `${command.spec.name}: notYetBuilt=${String(claimsNotBuilt)}, ` +
          `implementedBy="${command.spec.implementedBy}" — beides muss dasselbe sagen.`,
      ).toBe(claimsNotBuilt);
    }
  });

  it("init zeigt auf die vollstaendige Implementierung, nicht auf einen Stub", async () => {
    const init = COMMANDS.find((command) => command.spec.name === "init") as Command;
    expect(init.spec.implementedBy).toBe("commands/init/index.js");
    expect(init.spec.notYetBuilt).toBeUndefined();
    // Die Merkmale, die der Stub NICHT hatte: er kannte weder --dry-run noch
    // --offline und schrieb .untangle.json statt untangle.toml.
    expect(Object.keys(init.spec.flags)).toEqual(
      expect.arrayContaining(["dry-run", "offline", "embedding-model"]),
    );
    expect(init.spec.details?.join(" ")).toContain("untangle.toml");
  });
});
