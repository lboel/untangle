/**
 * Die Zusage dieses Arbeitspakets als Test: `untangle --help` funktioniert,
 * und JEDER Unterbefehl antwortet auf `--help`.
 *
 * Sie steht hier und nicht nur im Bericht, weil ein Bericht keinen Testlauf
 * ersetzt (BUILD_PLAN E5) — und weil ein neu hinzugefuegter Unterbefehl, der
 * seine Hilfe vergisst, sonst erst dem Nutzer auffiele.
 */
import { describe, expect, it } from "vitest";

import { EXIT } from "./cli/exit.js";
import { BufferIo } from "./cli/io.js";

import { CLI_VERSION, COMMANDS, run } from "./index.js";

/**
 * Die Befehlsliste wird aus dem Einstiegspunkt GELESEN, nicht hier
 * abgeschrieben. Eine zweite Liste waere eine zweite Wahrheit — und genau die
 * ist beim Bau von `watch` auseinandergelaufen.
 */
const SUBCOMMANDS = COMMANDS.map((command) => command.spec.name);

/** Die Befehle, die sich selbst als „noch nicht gebaut" ausweisen. */
const NOT_YET_BUILT = COMMANDS.filter((command) => command.spec.notYetBuilt === true).map(
  (command) => command.spec.name,
);

async function invoke(argv: readonly string[]): Promise<{ code: number; io: BufferIo }> {
  const io = new BufferIo();
  const code = await run(argv, {
    io,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  });
  return { code, io };
}

describe("untangle", () => {
  it("--help nennt jeden Unterbefehl", async () => {
    const { code, io } = await invoke(["--help"]);
    expect(code).toBe(EXIT.ok);
    for (const name of SUBCOMMANDS) {
      expect(io.outText).toContain(name);
    }
    expect(io.errText).toBe("");
  });

  it("--version gibt die Version auf stdout", async () => {
    const { code, io } = await invoke(["--version"]);
    expect(code).toBe(EXIT.ok);
    expect(io.outText.trim()).toBe(CLI_VERSION);
  });

  it("kennt die registrierten Unterbefehle", () => {
    expect(SUBCOMMANDS).toEqual([
      "init",
      "index",
      "query",
      "complexity",
      "product",
      "scan",
      "graph",
      "flow",
      "mcp",
      "watch",
      "doctor",
      "extensions",
    ]);
  });

  it.each(SUBCOMMANDS)("%s --help antwortet auf stdout mit Exit-Code 0", async (name) => {
    const { code, io } = await invoke([name, "--help"]);
    expect(code).toBe(EXIT.ok);
    expect(io.outText).toContain(`untangle ${name}`);
    expect(io.outText).toContain("USAGE");
    expect(io.outText).toContain("EXIT-CODES");
    // Hilfe ist eine Nutzdatenausgabe, kein Fehler.
    expect(io.errText).toBe("");
  });

  it("lehnt einen unbekannten Befehl mit Exit-Code 2 ab und schlaegt einen vor", async () => {
    const { code, io } = await invoke(["quer"]);
    expect(code).toBe(EXIT.usage);
    expect(io.outText).toBe("");
    expect(io.errText).toContain("Unknown command");
    expect(io.errText).toContain("untangle query");
  });

  it("lehnt eine unbekannte Option mit Exit-Code 2 ab", async () => {
    const { code, io } = await invoke(["query", "test", "--explaine"]);
    expect(code).toBe(EXIT.usage);
    expect(io.errText).toContain("Unknown option");
  });

  it("verlangt bei query einen Suchtext", async () => {
    const { code, io } = await invoke(["query"]);
    expect(code).toBe(EXIT.usage);
    expect(io.errText).toContain("Search text");
  });
});

describe("noch nicht gebaute Faehigkeiten", () => {
  // E4: kein stilles Ueberspringen, kein vorgetaeuschter Erfolg, kein
  // Betriebsfehler — ein EIGENER Code und eine pruefbare Begruendung.
  //
  // MIT WP-229 IST DIESE LISTE LEER: `graph` und `flow` waren die letzten
  // beiden Platzhalter. Der Test bleibt trotzdem stehen, und zwar in zwei
  // Haelften: die erste haelt fest, DASS nichts mehr aussteht (und wird rot,
  // wenn jemand einen neuen Platzhalter einfuehrt, ohne es hier zu sagen),
  // die zweite prueft weiterhin jeden Platzhalter, den es doch wieder gibt.
  it("keine — jede angelegte Faehigkeit ist auch gebaut", () => {
    expect(NOT_YET_BUILT).toEqual([]);
  });

  it("graph und flow zeigen nicht mehr auf den Platzhalter-Bauplan", () => {
    for (const name of ["graph", "flow"]) {
      const command = COMMANDS.find((entry) => entry.spec.name === name);
      expect(command?.spec.notYetBuilt, `${name} gibt sich noch als ungebaut aus.`).toBeUndefined();
      expect(command?.spec.implementedBy).not.toBe("commands/unavailable.js");
    }
  });

  it.each(NOT_YET_BUILT)(
    "%s endet mit Exit-Code 3 und nennt genau einen naechsten Schritt",
    async (name) => {
      const { code, io } = await invoke([name]);
      expect(code).toBe(EXIT.unavailable);
      expect(io.outText).toBe("");
      expect(io.errText).toContain("not available yet");
      expect(io.errText).toContain("Next step:");
    },
  );
});
