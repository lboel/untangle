/**
 * Regressionstests zu den Befunden der Welle 3 am SARIF-Parser.
 *
 * Gepruefte Zusicherungen: keine Fundstelle und kein `run` verschwindet ohne
 * Grund (E4), und kein unbrauchbarer Wert wird stillschweigend durch einen
 * erfundenen ersetzt.
 */
import { describe, expect, it } from "vitest";

import { parseSarif } from "./sarif.js";

/** Baut einen SARIF-Log mit genau einem `result`. */
function sarifWith(result: unknown, extraRuns: unknown[] = []): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "t", version: "1.0.0" } }, results: [result] }, ...extraRuns],
  });
}

describe("parseSarif — mehrere locations je result (Befund 2)", () => {
  const result = {
    ruleId: "R1",
    message: { text: "m" },
    level: "error",
    locations: [
      { physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 3 } } },
      { physicalLocation: { artifactLocation: { uri: "src/b.ts" } } },
      { physicalLocation: { region: { startLine: 9 } } },
      { logicalLocations: [{ fullyQualifiedName: "N.M" }] },
    ],
  };

  it("uebernimmt eine Fundstelle ohne region als Datei-Fundstelle statt sie zu verlieren", () => {
    const parsed = parseSarif(sarifWith(result));
    expect(parsed.findings.map((finding) => finding.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("markiert die ersatzweise Verankerung, damit sie nicht wie eine Messung aussieht", () => {
    const parsed = parseSarif(sarifWith(result));
    expect(parsed.findings[0]?.position.lineUnknown).toBeUndefined();
    expect(parsed.findings[1]?.position).toEqual({
      startLine: 1,
      endLine: 1,
      lineUnknown: true,
    });
  });

  it("begruendet JEDE nicht uebernommene Fundstelle einzeln (E4)", () => {
    const parsed = parseSarif(sarifWith(result));
    const pointers = parsed.issues.map((issue) => issue.rawLocation);
    expect(pointers).toEqual(["/runs/0/results/0/locations/2", "/runs/0/results/0/locations/3"]);
    expect(parsed.issues.every((issue) => issue.reason === "no_location")).toBe(true);
    expect(parsed.issues[1]?.detail).toContain("logical location");
  });
});

describe("parseSarif — kaputte runs (Befund 4)", () => {
  const parsed = parseSarif(
    sarifWith(
      {
        ruleId: "R",
        message: { text: "ok" },
        locations: [
          { physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } },
        ],
      },
      [
        { tool: { driver: { name: "t" } }, results: { ruleId: "R2", message: { text: "lost" } } },
        "ich bin kein run",
      ],
    ),
  );

  it("behaelt die gueltigen Ergebnisse der Datei", () => {
    expect(parsed.findings).toHaveLength(1);
  });

  it("meldet ein results-Feld, das kein Array ist, statt es zu verschlucken", () => {
    const issue = parsed.issues.find((entry) => entry.rawLocation === "/runs/1/results");
    expect(issue?.reason).toBe("invalid_entry");
    expect(issue?.detail).toContain("not an array");
  });

  it("meldet ein run-Element, das kein Objekt ist", () => {
    const issue = parsed.issues.find((entry) => entry.rawLocation === "/runs/2");
    expect(issue?.reason).toBe("invalid_entry");
    expect(issue?.detail).toContain("not an object");
  });
});

describe("parseSarif — unbrauchbare Werte werden gemeldet, nicht ersetzt", () => {
  it("meldet eine Confidence ausserhalb von [0,1] und behaelt den Rohwert", () => {
    const parsed = parseSarif(
      sarifWith({
        ruleId: "R",
        message: { text: "m" },
        properties: { confidence: 7, isHeuristic: "ja" },
        locations: [
          { physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } },
        ],
      }),
    );
    expect(parsed.findings[0]?.confidenceValue).toBeUndefined();
    expect(parsed.findings[0]?.originalConfidence).toBe("7");
    expect(parsed.findings[0]?.isHeuristic).toBeUndefined();
    expect(parsed.issues.map((issue) => issue.reason)).toEqual([
      "unreadable_field",
      "unreadable_field",
    ]);
  });

  it("liest eine numerische Confidence auch als Zeichenkette", () => {
    const parsed = parseSarif(
      sarifWith({
        ruleId: "R",
        message: { text: "m" },
        properties: { confidence: "0.25", isHeuristic: "true" },
        locations: [
          { physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } },
        ],
      }),
    );
    expect(parsed.findings[0]?.confidenceValue).toBe(0.25);
    expect(parsed.findings[0]?.isHeuristic).toBe(true);
    expect(parsed.issues).toEqual([]);
  });
});

describe("parseSarif — das Werkzeug meldet seinen eigenen Fehlschlag (SARIF §3.20)", () => {
  it("meldet executionSuccessful=false, statt eine Teilmenge als vollstaendig zu nehmen", () => {
    const parsed = parseSarif(
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "t" } },
            invocations: [{ executionSuccessful: false, exitCode: 3 }],
            results: [],
          },
        ],
      }),
    );
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.reason).toBe("tool_reported_failure");
    expect(parsed.issues[0]?.detail).toContain("exitCode 3");
  });

  it("meldet eine Fehler-Notification des Werkzeugs", () => {
    const parsed = parseSarif(
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "t" } },
            invocations: [
              {
                executionSuccessful: true,
                toolExecutionNotifications: [
                  { level: "error", message: { text: "could not read 41 files" } },
                  { level: "note", message: { text: "irrelevant" } },
                ],
              },
            ],
            results: [],
          },
        ],
      }),
    );
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.reason).toBe("tool_reported_failure");
    expect(parsed.issues[0]?.detail).toContain("could not read 41 files");
  });
});
