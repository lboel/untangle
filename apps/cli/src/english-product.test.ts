import { describe, expect, it } from "vitest";

import { BufferIo } from "./cli/io.js";
import { COMMANDS, run } from "./index.js";

const LEGACY_COPY =
  /\b(?:AUFRUF|BEFEHLE|OPTIONEN|BEISPIELE|STANDARDWERT|PFAD|Abgebrochen|Naechster|Faehigkeit|Betriebsfehler|Aufruffehler|Dateien|Knoten|Uebersicht|Verzeichnis|Konfiguration|Durchsuchen|ausgeben|benoetigt|gewaehlt|pruefen|fuer|ueber)\b|[äöüÄÖÜß]/u;

describe("English product language", () => {
  it.each(["root", ...COMMANDS.map((command) => command.spec.name)])(
    "renders %s help in English through the public CLI",
    async (name) => {
      const io = new BufferIo();
      const exitCode = await run(name === "root" ? ["--help"] : [name, "--help"], { io });
      expect(exitCode).toBe(0);
      expect(io.errText).toBe("");
      expect(io.outText).toContain("USAGE");
      expect(
        io.outText.match(LEGACY_COPY)?.[0] ?? null,
        `${name} help contains legacy copy`,
      ).toBeNull();
      if (name === "root") {
        expect(io.outText).toContain("COMMANDS");
        expect(io.outText).toContain("GLOBAL OPTIONS");
      } else {
        expect(io.outText).toContain("OPTIONS");
        expect(io.outText).toContain("EXAMPLES");
      }
    },
  );

  it("reports command errors and recovery in English without changing exit contracts", async () => {
    const io = new BufferIo();
    expect(await run(["not-a-command"], { io })).toBe(2);
    expect(io.outText).toBe("");
    expect(io.errText).toContain('Error: Unknown command "not-a-command".');
    expect(io.errText).toContain("Next step:");
    expect(io.errText).not.toMatch(LEGACY_COPY);
  });
});
