import { describe, expect, it } from "vitest";

import {
  boolFlag,
  enumFlag,
  integerFlag,
  listFlag,
  numberFlag,
  parseArgs,
  type FlagSpecs,
} from "./args.js";
import { UsageError } from "./exit.js";

const SPECS: FlagSpecs = {
  limit: { kind: "number", alias: "n", describe: "" },
  path: { kind: "list", describe: "" },
  explain: { kind: "boolean", describe: "" },
  content: { kind: "boolean", describe: "" },
  format: { kind: "string", describe: "" },
  context: { kind: "boolean-or-number", alias: "C", describe: "" },
};

describe("parseArgs", () => {
  it("nimmt Positionsargumente, --name=wert und --name wert", () => {
    const args = parseArgs(["hallo welt", "--limit=5", "--format", "json"], SPECS);
    expect(args.positionals).toEqual(["hallo welt"]);
    expect(numberFlag(args, "limit")).toBe(5);
    expect(args.flags["format"]).toBe("json");
  });

  it("sammelt Listen-Optionen statt sie zu ueberschreiben", () => {
    const args = parseArgs(["--path", "src/**", "--path=test/**"], SPECS);
    expect(listFlag(args, "path")).toEqual(["src/**", "test/**"]);
  });

  it("kennt Kurzformen", () => {
    const args = parseArgs(["-n", "3", "-C", "2"], SPECS);
    expect(numberFlag(args, "limit")).toBe(3);
    expect(integerFlag(args, "context", 0)).toBe(2);
  });

  it("unterscheidet einen bloßen dualen Schalter von seinem Zahlenwert", () => {
    const enabled = parseArgs(["--context", "frage"], SPECS);
    expect(boolFlag(enabled, "context")).toBe(true);
    expect(enabled.positionals).toEqual(["frage"]);

    const numbered = parseArgs(["--context=3"], SPECS);
    expect(integerFlag(numbered, "context", 0)).toBe(3);
    expect(boolFlag(numbered, "context")).toBe(false);
  });

  it("negiert Schalter mit --no-", () => {
    const args = parseArgs(["--explain", "--no-content"], SPECS);
    expect(boolFlag(args, "explain")).toBe(true);
    expect(boolFlag(args, "content", true)).toBe(false);
  });

  it("behandelt alles nach -- als Positionsargument", () => {
    const args = parseArgs(["--", "--limit=5"], SPECS);
    expect(args.positionals).toEqual(["--limit=5"]);
  });

  // Der eigentliche Grund fuer einen eigenen Parser (E4): eine unbekannte
  // Option darf NIE stillschweigend zu einem Positionsargument werden.
  it("LEHNT eine unbekannte Option ab, statt sie zu verschlucken", () => {
    expect(() => parseArgs(["--explaine"], SPECS)).toThrow(UsageError);
  });

  it("lehnt eine Option ohne Wert ab", () => {
    expect(() => parseArgs(["--format"], SPECS)).toThrow(UsageError);
  });

  it("lehnt eine Zahl ab, die keine ist", () => {
    expect(() => parseArgs(["--limit=viele"], SPECS)).toThrow(UsageError);
  });

  it("lehnt einen unzulaessigen Aufzaehlungswert ab, statt auf den Default zu fallen", () => {
    const args = parseArgs(["--format=yaml"], SPECS);
    expect(() => enumFlag(args, "format", ["text", "json"] as const, "text")).toThrow(UsageError);
  });

  it("lehnt eine negative Ganzzahl dort ab, wo nur >= 0 sinnvoll ist", () => {
    const args = parseArgs(["-C", "-1"], SPECS);
    expect(() => integerFlag(args, "context", 0)).toThrow(UsageError);
  });
});
