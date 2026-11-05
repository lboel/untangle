import { describe, expect, it } from "vitest";

import { readFixture } from "../test-support/fixtures.js";
import { SARIF_PARSER_VERSION } from "../versions.js";

import { parseSarif } from "./sarif.js";
import { FormatParseError } from "./types.js";

const BASIC = readFixture("sarif/basic.sarif.json");

describe("parseSarif", () => {
  it("liest Befunde aus einer echten SARIF-2.1.0-Datei", () => {
    const result = parseSarif(BASIC);

    expect(result.parserVersion).toBe(SARIF_PARSER_VERSION);
    // 5 results; einer ohne Fundstelle, einer ohne Regel-ID, einer mit ZWEI
    // Fundstellen: 1 + 1 + 2 = 4 Rohbefunde.
    expect(result.findings).toHaveLength(4);
    expect(result.entriesSeen).toBe(5);
  });

  it("uebernimmt Werkzeugname und -version als Hinweis aus den Nutzerdaten", () => {
    const result = parseSarif(BASIC);
    expect(result.toolNameHint).toBe("example-analyzer");
    expect(result.toolVersionHint).toBe("3.4.1");
  });

  it("behaelt den Severity-String des Werkzeugs unveraendert", () => {
    const [first] = parseSarif(BASIC).findings;
    expect(first?.originalSeverity).toBe("error");
    expect(first?.ruleId).toBe("rules/no-dynamic-eval");
    expect(first?.position).toEqual({
      startLine: 12,
      endLine: 12,
      startColumn: 11,
      endColumn: 33,
    });
  });

  it("uebernimmt die Regel-Vorgabestufe, wenn das Ergebnis keine nennt", () => {
    const finding = parseSarif(BASIC).findings[1];
    // Das zweite Ergebnis nennt nur `ruleIndex`; Stufe und Regel-ID kommen
    // aus `tool.driver.rules[1]`.
    expect(finding?.ruleId).toBe("rules/prefer-const");
    expect(finding?.originalSeverity).toBe("note");
  });

  it("normalisiert file://-URIs zu einem Pfad", () => {
    const finding = parseSarif(BASIC).findings[1];
    expect(finding?.filePath).toBe("/workspace/src/report/summary.ts");
  });

  it("uebernimmt Byte-Offsets des Formats, wenn es sie fuehrt", () => {
    const finding = parseSarif(BASIC).findings[1];
    expect(finding?.position.byteOffset).toBe(87);
    expect(finding?.position.byteLength).toBe(24);
  });

  it("erzeugt je Fundstelle einen Rohbefund statt nur die erste zu nehmen", () => {
    const findings = parseSarif(BASIC).findings;
    expect(findings[2]?.filePath).toBe("src/handlers/webhook.ts");
    expect(findings[3]?.filePath).toBe("src/handlers/legacy.ts");
    expect(findings[2]?.rawLocation).toBe("/runs/0/results/2/locations/0");
    expect(findings[3]?.rawLocation).toBe("/runs/0/results/2/locations/1");
  });

  it("liest die Hilfe der Regel als Behebungshinweis", () => {
    const [first] = parseSarif(BASIC).findings;
    expect(first?.remediationHint).toBe(
      "Replace the dynamic evaluation with an explicit dispatch table.",
    );
  });

  it("uebernimmt eine numerische Confidence aus den Properties", () => {
    const [first] = parseSarif(BASIC).findings;
    expect(first?.confidenceValue).toBe(0.95);
    expect(first?.isHeuristic).toBe(false);
  });

  it("zaehlt und begruendet jedes nicht uebernommene Ergebnis (E4)", () => {
    const result = parseSarif(BASIC);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.reason).sort()).toEqual([
      "missing_required_field",
      "no_location",
    ]);
    for (const issue of result.issues) {
      expect(issue.detail).not.toBe("");
      expect(issue.rawLocation).toMatch(/^\/runs\/0\/results\/\d+$/);
    }
  });

  it("toleriert unbekannte Felder ohne Fehler", () => {
    // Die Fixture enthaelt `unknownFutureField` in Regel- und
    // Invocation-Objekten; das Parsen darf davon nicht beruehrt werden.
    expect(() => parseSarif(BASIC)).not.toThrow();
    expect(parseSarif(BASIC).findings.length).toBeGreaterThan(0);
  });

  it("meldet eine fremde SARIF-Version, liest aber weiter", () => {
    const document = JSON.parse(BASIC) as { version: string };
    document.version = "2.2.0";
    const result = parseSarif(JSON.stringify(document));
    expect(result.issues.some((issue) => issue.reason === "unsupported_version")).toBe(true);
    expect(result.findings).toHaveLength(4);
  });

  it("wirft bei syntaktisch unbrauchbarer Gesamtausgabe", () => {
    expect(() => parseSarif(readFixture("sarif/broken.txt"))).toThrow(FormatParseError);
  });

  it("wirft, wenn das JSON kein SARIF-Log ist", () => {
    expect(() => parseSarif(readFixture("sarif/no-runs.json"))).toThrow(/no "runs" array/);
  });

  it("ist deterministisch: zwei Laeufe liefern dasselbe Ergebnis", () => {
    expect(parseSarif(BASIC)).toEqual(parseSarif(BASIC));
  });
});
