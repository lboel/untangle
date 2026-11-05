/**
 * Was aus einer fremden Zahl wird, wenn das Manifest ihr eine Bedeutung gibt.
 *
 * Ohne Deklaration bleibt ein Kennwert Schluessel plus Zahl — brauchbar als
 * Zeitreihe desselben Werkzeugs, sonst nichts. Mit Deklaration traegt er die
 * Bedeutung MIT, und erst dadurch kann eine Gegenprobe (X8) ueberhaupt wissen,
 * ob sie zwei Groessen vergleichen darf.
 *
 * Der Bezug ist dabei so bindend wie die Bedeutung: ein Kennwert, den das
 * Manifest als datei- oder symbolbezogen erklaert, den das Werkzeug aber ohne
 * Pfad geliefert hat, bekommt die Bedeutung NICHT angehaengt. Ihn trotzdem als
 * Dateiwert zu fuehren waere eine Aussage, die das Werkzeug nicht gemacht hat.
 */
import { describe, expect, it } from "vitest";

import { normalizeFindings, type FindingNormalizationContextV1 } from "./normalize.js";

const MAPPING = {
  mappingVersion: "untangle-severity-map-v1",
  fallback: "medium" as const,
  caseInsensitive: true,
  rules: [{ from: "error", to: "high" as const }],
};

function context(
  overrides: Partial<FindingNormalizationContextV1> = {},
): FindingNormalizationContextV1 {
  return {
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    extensionRunId: "run-1",
    extensionId: "metrics-probe",
    tool: "metrics-probe",
    toolVersion: "0.5.7",
    detectedAt: "2026-09-07T00:00:00.000Z",
    outputFormat: "generic-metrics",
    invocation: "binary",
    severityMapping: MAPPING,
    resolveFile: (path: string) => ({ relativePath: path, fileId: `file-${path}` }),
    resolvePosition: () => null,
    ...overrides,
  };
}

const REPO_VALUE = { key: "quality_signal", value: 0.45, rawLocation: "/quality_signal" };
const FILE_VALUE = {
  key: "cognitive_complexity",
  value: 18,
  filePath: "src/a.ts",
  rawLocation: "/0",
};

describe("Complexity-Signale an der Normalisierung", () => {
  it("laesst einen Kennwert ohne Deklaration namenlos", () => {
    const result = normalizeFindings({ findings: [], measurements: [REPO_VALUE] }, context());
    expect(result.measurements[0]?.signal).toBeUndefined();
    expect(result.measurements[0]?.key).toBe("quality_signal");
  });

  it("haengt die deklarierte Bedeutung an den passenden Schluessel", () => {
    const result = normalizeFindings(
      { findings: [], measurements: [REPO_VALUE, FILE_VALUE] },
      context({
        complexitySignals: [
          { key: "quality_signal", kind: "proprietary-composite", scope: "repository" },
          {
            key: "cognitive_complexity",
            kind: "cognitive",
            scope: "file",
            comparableTo: "untangle-metrics-v1",
          },
        ],
      }),
    );

    const byKey = new Map(result.measurements.map((m) => [m.key, m.signal]));
    expect(byKey.get("quality_signal")).toEqual({
      key: "quality_signal",
      kind: "proprietary-composite",
      scope: "repository",
    });
    expect(byKey.get("cognitive_complexity")?.comparableTo).toBe("untangle-metrics-v1");
  });

  it("verweigert eine dateibezogene Bedeutung fuer einen Wert ohne Datei — mit Vermerk", () => {
    const result = normalizeFindings(
      {
        findings: [],
        measurements: [{ key: "cognitive_complexity", value: 18, rawLocation: "/0" }],
      },
      context({
        complexitySignals: [
          {
            key: "cognitive_complexity",
            kind: "cognitive",
            scope: "file",
            comparableTo: "untangle-metrics-v1",
          },
        ],
      }),
    );

    expect(result.measurements[0]?.signal).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("cognitive_complexity");
    expect(result.warnings.join(" ")).toContain("file");
  });

  it("bleibt bei einem Schluessel ohne Deklaration still — nicht jede Zahl ist ein Signal", () => {
    const result = normalizeFindings(
      { findings: [], measurements: [{ key: "timestamp", value: 1788794829, rawLocation: "/t" }] },
      context({
        complexitySignals: [
          { key: "quality_signal", kind: "proprietary-composite", scope: "repository" },
        ],
      }),
    );
    expect(result.measurements[0]?.signal).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});
