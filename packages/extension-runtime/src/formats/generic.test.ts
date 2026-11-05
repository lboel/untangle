import { describe, expect, it } from "vitest";

import { readFixture } from "../test-support/fixtures.js";

import { parseGenericFindings } from "./generic-findings.js";
import { parseGenericMetrics } from "./generic-metrics.js";
import { FormatParseError } from "./types.js";

const FINDINGS = readFixture("generic/findings.jsonl");
const METRICS = readFixture("generic/metrics.jsonl");

describe("parseGenericFindings", () => {
  it("liest JSON-Zeilen und behaelt gueltige Eintraege trotz kaputter Zeilen (E4)", () => {
    const result = parseGenericFindings(FINDINGS);
    expect(result.findings).toHaveLength(2);
    // Eine unlesbare Zeile, eine ohne startLine, eine ohne path.
    expect(result.issues).toHaveLength(3);
    expect(result.issues.map((issue) => issue.reason).sort()).toEqual([
      "invalid_entry",
      "invalid_number",
      "missing_required_field",
    ]);
    for (const issue of result.issues) {
      expect(issue.detail).not.toBe("");
    }
  });

  it("normalisiert Pfade und behaelt den Severity-String unveraendert", () => {
    const findings = parseGenericFindings(FINDINGS).findings;
    expect(findings[0]?.filePath).toBe("src/a.ts");
    expect(findings[1]?.filePath).toBe("src/b.ts");
    expect(findings[1]?.originalSeverity).toBe("BLOCKER");
    expect(findings[1]?.confidenceValue).toBe(0.4);
    expect(findings[1]?.originalConfidence).toBe("LOW");
    expect(findings[1]?.isHeuristic).toBe(true);
  });

  it("uebernimmt Regelsatz und Regelsatzversion, wenn der Eintrag sie fuehrt", () => {
    const [first] = parseGenericFindings(FINDINGS).findings;
    expect(first?.ruleset).toBe("house-style");
    expect(first?.rulesetVersion).toBe("2026.1");
  });

  it("wendet ein deklaratives Feld-Mapping mit Punktpfaden an", () => {
    const text = JSON.stringify({
      results: [
        {
          location: { file: "src/x.ts", line: 7 },
          check: "custom/rule",
          text: "Something is off",
          extra: { level: "WARN" },
        },
      ],
    });
    const result = parseGenericFindings(text, {
      path: "location.file",
      startLine: "location.line",
      ruleId: "check",
      message: "text",
      severity: "extra.level",
    });
    // Ein Objekt ohne `findings`-Array ist genau ein Eintrag.
    expect(result.findings).toHaveLength(0);
    expect(result.issues[0]?.reason).toBe("missing_required_field");

    const wrapped = JSON.stringify({
      findings: [
        {
          location: { file: "src/x.ts", line: 7 },
          check: "custom/rule",
          text: "Something is off",
          extra: { level: "WARN" },
        },
      ],
    });
    const mapped = parseGenericFindings(wrapped, {
      path: "location.file",
      startLine: "location.line",
      ruleId: "check",
      message: "text",
      severity: "extra.level",
    });
    expect(mapped.findings).toHaveLength(1);
    expect(mapped.findings[0]?.ruleId).toBe("custom/rule");
    expect(mapped.findings[0]?.originalSeverity).toBe("WARN");
    expect(mapped.findings[0]?.position.startLine).toBe(7);
  });

  it("liest auch ein JSON-Array als Eintragsliste", () => {
    const result = parseGenericFindings(
      JSON.stringify([
        { path: "src/a.ts", startLine: 1, ruleId: "r", message: "m", severity: "info" },
      ]),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rawLocation).toBe("/0");
  });

  it("behandelt leere Ausgabe als nichts gefunden", () => {
    const result = parseGenericFindings("   \n\n");
    expect(result.findings).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it("wirft, wenn keine einzige Zeile lesbar ist", () => {
    expect(() => parseGenericFindings("nope\nalso nope\n")).toThrow(FormatParseError);
  });
});

describe("parseGenericMetrics", () => {
  it("liest Kennwerte und begruendet unbrauchbare Eintraege", () => {
    const result = parseGenericMetrics(METRICS);
    expect(result.measurements).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toBe("invalid_number");
  });

  it("behaelt Schluessel, Wert, Einheit und Pfad unveraendert", () => {
    const [first, second] = parseGenericMetrics(METRICS).measurements;
    expect(first).toMatchObject({
      key: "duplicated_lines_density",
      value: 3.4,
      unit: "percent",
      filePath: "src/a.ts",
    });
    expect(second).toMatchObject({ key: "comment_lines", value: 128 });
    expect(second?.filePath).toBeUndefined();
  });

  it("wendet ein deklaratives Feld-Mapping an", () => {
    const result = parseGenericMetrics(
      JSON.stringify({ metrics: [{ metric: "ccn", amount: 12, scope: "src/a.ts" }] }),
      { key: "metric", value: "amount", path: "scope" },
    );
    expect(result.measurements[0]).toMatchObject({ key: "ccn", value: 12, filePath: "src/a.ts" });
  });
});
