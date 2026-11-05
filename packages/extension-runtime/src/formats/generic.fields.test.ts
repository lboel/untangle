/**
 * Regressionstests zu Befund 6: ein VORHANDENES, unbrauchbares Feld darf nicht
 * stillschweigend durch einen Vorgabewert ersetzt werden.
 */
import { describe, expect, it } from "vitest";

import { parseGenericFindings } from "./generic-findings.js";
import { parseGenericMetrics } from "./generic-metrics.js";

function lines(...entries: Record<string, unknown>[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

const BASE = { path: "a.ts", ruleId: "r", message: "m", severity: "error" };

describe("parseGenericFindings — Confidence und isHeuristic", () => {
  it("meldet eine Confidence ausserhalb von [0,1] und behaelt sie als Rohwert", () => {
    const parsed = parseGenericFindings(lines({ ...BASE, startLine: 1, confidence: 7 }));
    expect(parsed.findings[0]?.confidenceValue).toBeUndefined();
    expect(parsed.findings[0]?.originalConfidence).toBe("7");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.reason).toBe("unreadable_field");
    expect(parsed.issues[0]?.detail).toContain("confidence");
  });

  it("liest eine Confidence auch als numerische Zeichenkette (wie jede andere Zahl)", () => {
    const parsed = parseGenericFindings(lines({ ...BASE, startLine: 2, confidence: "0.9" }));
    expect(parsed.findings[0]?.confidenceValue).toBe(0.9);
    expect(parsed.issues).toEqual([]);
  });

  it("meldet ein isHeuristic, das weder true noch false ist", () => {
    const parsed = parseGenericFindings(lines({ ...BASE, startLine: 3, isHeuristic: "ja" }));
    expect(parsed.findings[0]?.isHeuristic).toBeUndefined();
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.reason).toBe("unreadable_field");
    expect(parsed.issues[0]?.detail).toContain("isHeuristic");
  });

  it('liest isHeuristic auch als JSON-Schreibweise "true"/"false"', () => {
    const parsed = parseGenericFindings(
      lines(
        { ...BASE, startLine: 4, isHeuristic: "true" },
        { ...BASE, startLine: 5, isHeuristic: "false" },
      ),
    );
    expect(parsed.findings.map((finding) => finding.isHeuristic)).toEqual([true, false]);
    expect(parsed.issues).toEqual([]);
  });

  it("schweigt ueber ein FEHLENDES Feld — nur ein kaputtes ist ein Befund", () => {
    const parsed = parseGenericFindings(lines({ ...BASE, startLine: 6 }));
    expect(parsed.issues).toEqual([]);
    expect(parsed.findings[0]?.confidenceValue).toBeUndefined();
  });

  it("meldet ein unlesbares endLine, statt es stumm auf startLine zu setzen", () => {
    const parsed = parseGenericFindings(lines({ ...BASE, startLine: 7, endLine: "spaeter" }));
    expect(parsed.findings[0]?.position).toEqual({ startLine: 7, endLine: 7 });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.reason).toBe("unreadable_field");
  });

  it("meldet einen unlesbaren byteOffset", () => {
    const parsed = parseGenericFindings(lines({ ...BASE, startLine: 8, byteOffset: -4 }));
    expect(parsed.findings[0]?.position.byteOffset).toBeUndefined();
    expect(parsed.issues[0]?.reason).toBe("unreadable_field");
  });
});

describe("parseGenericMetrics — unbrauchbarer Dateibezug", () => {
  it("meldet einen path, der keine Zeichenkette ist, statt den Dateibezug stumm zu verlieren", () => {
    const parsed = parseGenericMetrics(lines({ key: "k", value: 1, path: 42 }));
    expect(parsed.measurements[0]?.filePath).toBeUndefined();
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.reason).toBe("unreadable_field");
    expect(parsed.issues[0]?.detail).toContain("loses its file scope");
  });
});
