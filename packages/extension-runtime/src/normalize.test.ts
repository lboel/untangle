import type { SeverityMappingV1 } from "@untangle-code/domain";
import {
  SEVERITY_MAP_VERSION,
  assertUntangleMetricNumber,
  isExternalNumber,
} from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { parseSarif } from "./formats/sarif.js";
import type { RawFindingV1 } from "./formats/types.js";
import type { FindingNormalizationContextV1 } from "./normalize.js";
import { normalizeFindings } from "./normalize.js";
import { createLineOffsetResolver, createUnresolvedPositionResolver } from "./positions.js";
import { readFixture } from "./test-support/fixtures.js";

const MAPPING: SeverityMappingV1 = {
  mappingVersion: SEVERITY_MAP_VERSION,
  rules: [
    { from: "note", to: "low" },
    { from: "warning", to: "medium" },
    { from: "error", to: "high" },
  ],
  fallback: "info",
  caseInsensitive: true,
};

const FILE_A = ["export function handle(payload) {", "  return payload;", "}", ""].join("\n");

function context(
  overrides: Partial<FindingNormalizationContextV1> = {},
): FindingNormalizationContextV1 {
  return {
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    extensionRunId: "run-1",
    extensionId: "example-sast",
    tool: "example-sast",
    toolVersion: "3.4.1",
    detectedAt: "2026-09-01T00:00:00.000Z",
    outputFormat: "sarif",
    invocation: "binary",
    severityMapping: MAPPING,
    resolveFile: (path) => ({ relativePath: path, fileId: `file-${path}` }),
    resolvePosition: createLineOffsetResolver(new Map([["src/a.ts", FILE_A]])),
    ...overrides,
  };
}

function finding(overrides: Partial<RawFindingV1> = {}): RawFindingV1 {
  return {
    filePath: "src/a.ts",
    position: { startLine: 2, endLine: 2 },
    ruleId: "rules/no-return-payload",
    message: "Do not return the raw payload.",
    originalSeverity: "error",
    rawLocation: "/runs/0/results/0/locations/0",
    ...overrides,
  };
}

describe("normalizeFindings", () => {
  it("hebt einen Rohbefund auf ExternalFindingV1 mit Evidenzmarker (X3)", () => {
    const result = normalizeFindings({ findings: [finding()], measurements: [] }, context());
    const [external] = result.findings;

    expect(external?.evidenceOnly).toBe(true);
    expect(external?.schemaVersion).toBe(1);
    expect(external?.findingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(external?.sourceRange).toEqual({
      startLine: 2,
      endLine: 2,
      startByte: 34,
      endByte: 51,
    });
  });

  it("behaelt die Original-Severity und weist den Treffer der Abbildung aus", () => {
    const result = normalizeFindings({ findings: [finding()], measurements: [] }, context());
    expect(result.findings[0]?.severity).toEqual({
      normalized: "high",
      original: "error",
      mappingVersion: SEVERITY_MAP_VERSION,
      mappingMatched: true,
    });
  });

  it("macht den Severity-Fallback sichtbar, statt ihn zu verschweigen (E4)", () => {
    const result = normalizeFindings(
      { findings: [finding({ originalSeverity: "BLOCKER" })], measurements: [] },
      context(),
    );
    expect(result.findings[0]?.severity.normalized).toBe("info");
    expect(result.findings[0]?.severity.mappingMatched).toBe(false);
    expect(result.severityFallbackCount).toBe(1);
    expect(result.warnings[0]).toContain("BLOCKER");
  });

  it("vergibt die dokumentierten Confidence-Vorgaben (§7.4)", () => {
    const deterministic = normalizeFindings({ findings: [finding()], measurements: [] }, context())
      .findings[0];
    expect(deterministic?.confidence).toEqual({ value: 0.8, basis: "mapped" });

    const heuristic = normalizeFindings(
      { findings: [finding({ isHeuristic: true })], measurements: [] },
      context(),
    ).findings[0];
    expect(heuristic?.confidence.value).toBe(0.5);

    const fromTool = normalizeFindings(
      {
        findings: [finding({ confidenceValue: 0.95, originalConfidence: "HIGH" })],
        measurements: [],
      },
      context(),
    ).findings[0];
    expect(fromTool?.confidence).toEqual({ value: 0.95, basis: "tool", original: "HIGH" });
  });

  it("weist eine fehlende Symbolzuordnung als file_only MIT Grund aus (§7.2)", () => {
    const result = normalizeFindings({ findings: [finding()], measurements: [] }, context());
    expect(result.findings[0]?.symbolResolution).toBe("file_only");
    expect(result.findings[0]?.symbolResolutionNote).toBe("no_enclosing_symbol");
  });

  it("uebernimmt ein aufgeloestes Symbol", () => {
    const result = normalizeFindings(
      { findings: [finding()], measurements: [] },
      context({
        resolveSymbol: () => ({ symbolId: "sym-1", symbolFqn: "src/a.ts::handle" }),
      }),
    );
    expect(result.findings[0]?.symbolResolution).toBe("symbol");
    expect(result.findings[0]?.symbolId).toBe("sym-1");
    expect(result.findings[0]?.symbolResolutionNote).toBeUndefined();
  });

  it("verlangt einen Grund, wenn die Datei nicht im Index ist (E4)", () => {
    const result = normalizeFindings(
      { findings: [finding()], measurements: [] },
      context({
        resolveFile: (path) => ({
          relativePath: path,
          fileIdMissingReason: "excluded by the scanner configuration",
        }),
      }),
    );
    expect(result.findings[0]?.fileId).toBeUndefined();
    expect(result.findings[0]?.fileIdMissingReason).toBe("excluded by the scanner configuration");
  });

  it("verwirft einen unaufloesbaren Befund NICHT still, sondern begruendet ihn (E4)", () => {
    const result = normalizeFindings(
      { findings: [finding()], measurements: [] },
      context({ resolvePosition: createUnresolvedPositionResolver() }),
    );
    expect(result.findings).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.stage).toBe("extension");
    expect(result.skipped[0]?.reason).toBe("missing_index_entry");
    expect(result.skipped[0]?.detail).not.toBe("");
    // Der Rohsatz bleibt erhalten — nichts geht verloren.
    expect(result.unresolved).toHaveLength(1);
  });

  it("begruendet einen Pfad, der nicht repo-relativ gemacht werden konnte", () => {
    const result = normalizeFindings(
      { findings: [finding({ filePath: "/opt/other/x.ts" })], measurements: [] },
      context({ resolveFile: () => ({}) }),
    );
    expect(result.findings).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("resolution_failed");
    expect(result.unresolved[0]?.filePath).toBe("/opt/other/x.ts");
  });

  it("vergibt bei identischer Fundstelle aufsteigende Ordinale und damit eigene IDs", () => {
    const result = normalizeFindings(
      { findings: [finding(), finding()], measurements: [] },
      context(),
    );
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.findingId).not.toBe(result.findings[1]?.findingId);
  });

  it("liefert fuer dieselbe Eingabe dieselben IDs (Determinismus)", () => {
    const first = normalizeFindings({ findings: [finding()], measurements: [] }, context());
    const second = normalizeFindings({ findings: [finding()], measurements: [] }, context());
    expect(first.findings[0]?.findingId).toBe(second.findings[0]?.findingId);
  });

  it("uebersetzt Kennwerte in ExternalNumberV1 und damit an keine Metrikstelle (X3)", () => {
    const result = normalizeFindings(
      {
        findings: [],
        measurements: [
          { key: "duplicated_lines_density", value: 3.4, unit: "percent", rawLocation: "line:1" },
        ],
      },
      context({ outputFormat: "generic-metrics" }),
    );
    const [measurement] = result.measurements;
    expect(measurement?.evidenceOnly).toBe(true);
    expect(isExternalNumber(measurement?.value)).toBe(true);
    // Der Laufzeitwaechter der Aggregationspfade weist den Wert zurueck.
    expect(() => assertUntangleMetricNumber(measurement?.value, "cyclomatic")).toThrow(
      /external measurement/,
    );
  });

  it("traegt die Provenienz mit Formatparser-Version statt Werkzeugadapter (X9)", () => {
    const result = normalizeFindings({ findings: [finding()], measurements: [] }, context());
    expect(result.findings[0]?.provenance).toEqual({
      extensionId: "example-sast",
      formatParserVersion: "untangle-format-sarif-v1",
      outputFormat: "sarif",
      toolVersion: "3.4.1",
      invocation: "binary",
      rawLocation: "/runs/0/results/0/locations/0",
    });
  });

  it("arbeitet Ende zu Ende gegen die SARIF-Fixture", () => {
    const parsed = parseSarif(readFixture("sarif/basic.sarif.json"));
    const result = normalizeFindings(parsed, {
      ...context(),
      resolveFile: (path) => ({
        relativePath: path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path,
        fileId: `file-${path}`,
      }),
      resolvePosition: createLineOffsetResolver(
        new Map([
          ["src/handlers/webhook.ts", ["a", "b", "c"].join("\n").padEnd(60, "\n")],
          ["src/handlers/legacy.ts", ["a", "b", "c", "d"].join("\n")],
        ]),
      ),
    });

    // Der Befund mit Byte-Offsets braucht keinen Dateiinhalt.
    const byOffset = result.findings.find(
      (external) => external.filePath === "src/report/summary.ts",
    );
    expect(byOffset?.sourceRange).toEqual({
      startLine: 4,
      endLine: 6,
      startByte: 87,
      endByte: 111,
    });
    // Was sich nicht aufloesen liess, steht begruendet im Ledger.
    for (const entry of result.skipped) {
      expect(entry.detail).not.toBe("");
    }
    expect(result.findings.length + result.unresolved.length).toBe(parsed.findings.length);
  });
});
