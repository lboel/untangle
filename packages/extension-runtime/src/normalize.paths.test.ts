/**
 * Regressionstests zu Befund 8: ein Kennwert mit unaufloesbarem Pfad darf
 * seinen Pfad nicht ungeprueft in `ExternalMeasurementV1.filePath` tragen.
 *
 * Dieselbe Pruefung gilt fuer Befunde — und sie muss auch `../`-Pfade fassen,
 * nicht nur absolute.
 */
import type { SeverityMappingV1 } from "@untangle-code/domain";
import { SEVERITY_MAP_VERSION } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import type { RawFindingV1, RawMeasurementV1 } from "./formats/types.js";
import type { FindingNormalizationContextV1 } from "./normalize.js";
import { normalizeFindings } from "./normalize.js";
import { createLineOffsetResolver } from "./positions.js";

const MAPPING: SeverityMappingV1 = {
  mappingVersion: SEVERITY_MAP_VERSION,
  rules: [{ from: "error", to: "high" }],
  fallback: "info",
  caseInsensitive: true,
};

function context(
  overrides: Partial<FindingNormalizationContextV1> = {},
): FindingNormalizationContextV1 {
  return {
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    extensionRunId: "run-1",
    extensionId: "x",
    tool: "x",
    toolVersion: "1.0.0",
    detectedAt: "2026-09-01T00:00:00.000Z",
    outputFormat: "generic-metrics",
    invocation: "binary",
    severityMapping: MAPPING,
    // Der Aufloeser kann den Pfad bewusst nicht abbilden.
    resolveFile: () => ({}),
    resolvePosition: createLineOffsetResolver(new Map([["src/a.ts", "a\nb\nc\n"]])),
    ...overrides,
  };
}

const measurement: RawMeasurementV1 = {
  key: "duplicated_lines",
  value: 3,
  filePath: "/etc/passwd",
  rawLocation: "line:1",
};

describe("normalizeFindings — Kennwerte mit unaufloesbarem Pfad", () => {
  const result = normalizeFindings({ findings: [], measurements: [measurement] }, context());

  it("uebernimmt keinen Pfad, den kein Untangle-Vertrag zulaesst", () => {
    expect(result.measurements).toEqual([]);
  });

  it("begruendet den Verlust im Skip-Ledger (E4)", () => {
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("resolution_failed");
    expect(result.skipped[0]?.path).toBe("/etc/passwd");
    expect(result.skipped[0]?.detail).toContain("duplicated_lines");
  });

  it("behaelt den Rohsatz, damit nichts verloren geht (E4)", () => {
    expect(result.unresolvedMeasurements).toEqual([measurement]);
  });

  it("laesst einen Kennwert ohne Dateibezug unberuehrt", () => {
    const global = normalizeFindings(
      { findings: [], measurements: [{ key: "k", value: 1, rawLocation: "line:1" }] },
      context(),
    );
    expect(global.measurements).toHaveLength(1);
    expect(global.skipped).toEqual([]);
  });
});

describe("normalizeFindings — Pfade, die aus dem Repository hinausfuehren", () => {
  const escaping: RawFindingV1 = {
    filePath: "../other-repo/x.ts",
    position: { startLine: 1, endLine: 1 },
    ruleId: "r",
    message: "m",
    originalSeverity: "error",
    rawLocation: "/runs/0/results/0/locations/0",
  };

  it("uebernimmt einen ../-Pfad nicht als repo-relativen Pfad", () => {
    const result = normalizeFindings(
      { findings: [escaping], measurements: [] },
      context({ resolveFile: (path) => ({ relativePath: path }) }),
    );
    expect(result.findings).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("resolution_failed");
    expect(result.unresolved).toEqual([escaping]);
  });
});

describe("normalizeFindings — nicht gemessene Zeilen bleiben erkennbar", () => {
  it("vermerkt im Lauf, dass eine Position nur eine Ersatzverankerung ist", () => {
    const result = normalizeFindings(
      {
        findings: [
          {
            filePath: "src/a.ts",
            position: { startLine: 1, endLine: 1, lineUnknown: true },
            ruleId: "r",
            message: "m",
            originalSeverity: "error",
            rawLocation: "/testsuite[0]/testcase[0]/failure[0]",
          },
        ],
        measurements: [],
      },
      context({ resolveFile: (path) => ({ relativePath: path, fileId: `file-${path}` }) }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("anchored at the start"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("/testsuite[0]/testcase[0]"))).toBe(
      true,
    );
  });

  it("schweigt, wenn jede Position gemessen ist", () => {
    const result = normalizeFindings(
      {
        findings: [
          {
            filePath: "src/a.ts",
            position: { startLine: 2, endLine: 2 },
            ruleId: "r",
            message: "m",
            originalSeverity: "error",
            rawLocation: "/x",
          },
        ],
        measurements: [],
      },
      context({ resolveFile: (path) => ({ relativePath: path, fileId: `file-${path}` }) }),
    );
    expect(result.warnings).toEqual([]);
  });
});
