import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical-json.js";
import { buildExternalFindingId, buildFindingMatchKey } from "../identity.js";
import { SEVERITY_MAP_VERSION } from "../versions.js";

import type { ComplexitySummaryV1 } from "./complexity.js";
import type {
  ExtensionManifestV1,
  ExternalFindingV1,
  ExternalMeasurementV1,
  SeverityMappingV1,
} from "./extensions.js";
import {
  assertUntangleMetricNumber,
  formatExternalNumber,
  isExternalNumber,
  makeExternalNumber,
  resolveNormalizedSeverity,
  validateExtensionManifest,
} from "./extensions.js";

const MAPPING: SeverityMappingV1 = {
  mappingVersion: SEVERITY_MAP_VERSION,
  rules: [
    { from: "BLOCKER", to: "critical" },
    { from: "MAJOR", to: "high" },
  ],
  fallback: "info",
  caseInsensitive: true,
};

function manifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  return {
    schemaVersion: 1,
    id: "example-analyzer",
    displayName: "Beispiel-Analysewerkzeug",
    category: "sast",
    invocation: ["container"],
    container: {
      image: "example/analyzer",
      digest: `sha256:${"a".repeat(64)}`,
      ports: [{ name: "http", containerPort: 9000, hostPortDefault: 19000 }],
      volumes: [],
      workspaceMount: { mountPath: "/workspace", readOnly: true },
      healthcheck: {
        kind: "http",
        httpPath: "/health",
        intervalMs: 2000,
        timeoutMs: 1000,
        retries: 5,
      },
    },
    resources: { minMemoryMb: 512, recommendedMemoryMb: 2048, recommendedCpus: 2 },
    languages: ["typescript", "python"],
    license: { spdxId: "Apache-2.0", usageRestriction: "none" },
    requiresLicenseAcknowledgment: false,
    secrets: [],
    outputFormat: "sarif",
    severityMapping: MAPPING,
    networkAccess: "none",
    telemetry: { sendsTelemetry: false, disabledByDefault: true },
    ...overrides,
  };
}

function finding(overrides: Partial<ExternalFindingV1> = {}): ExternalFindingV1 {
  return {
    schemaVersion: 1,
    evidenceOnly: true,
    findingId: buildExternalFindingId({
      extensionRunId: "run-1",
      tool: "example-analyzer",
      ruleId: "rule.a",
      relativePath: "src/index.ts",
      startByte: 120,
      ordinalWithinLocation: 0,
    }),
    workspaceId: "workspace-1",
    repoId: "repo-1",
    refId: "repo-1:main",
    fileId: "file-1",
    filePath: "src/index.ts",
    sourceRange: { startLine: 10, endLine: 10, startByte: 120, endByte: 160 },
    symbolId: "symbol-1",
    symbolFqn: "Service.run",
    symbolResolution: "symbol",
    tool: "example-analyzer",
    toolVersion: "1.2.3",
    ruleId: "rule.a",
    severity: {
      normalized: "critical",
      original: "BLOCKER",
      mappingVersion: SEVERITY_MAP_VERSION,
      mappingMatched: true,
    },
    message: "unsafe call",
    confidence: { value: 0.8, basis: "tool", original: "HIGH" },
    isHeuristic: true,
    detectedAt: "2026-09-05T00:00:00.000Z",
    extensionRunId: "run-1",
    provenance: {
      extensionId: "example-analyzer",
      formatParserVersion: "untangle-format-sarif-v1",
      outputFormat: "sarif",
      toolVersion: "1.2.3",
      invocation: "container",
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
    ...overrides,
  };
}

describe("X3: external values can never become Untangle metrics", () => {
  it("wraps external numbers in an object that no metric slot accepts", () => {
    const external = makeExternalNumber(17.5, "percent");
    expect(isExternalNumber(external)).toBe(true);
    expect(formatExternalNumber(external)).toBe("17.5 percent");

    // Untangle-Metriken sind `number`. Ein externer Wert ist ein Objekt und
    // passt strukturell nirgends hinein — das ist X3, im Typsystem verankert.
    // @ts-expect-error Externe Messwerte sind keine Untangle-Metriken (X3).
    const cognitive: number = external;
    expect(isExternalNumber(cognitive)).toBe(true);

    const summary: ComplexitySummaryV1 = {
      metricsScope: "symbol",
      metricsScopeId: "symbol-1",
      metricsVersion: "untangle-metrics-v1",
    };
    // @ts-expect-error Auch in einer Complexity-Summary ist kein externer Wert zulaessig.
    summary.cognitive = external;
  });

  it("rejects an external finding where an Untangle metric contribution is expected", () => {
    const externalFinding = finding();
    // @ts-expect-error Ein externer Befund ist Evidenz, kein Untangle-Messwert.
    const contribution: { line: number; kind: string; value: number } = externalFinding;
    expect(contribution).toBeDefined();
  });

  it("guards the aggregation paths at runtime as well", () => {
    expect(() => assertUntangleMetricNumber(makeExternalNumber(3), "cognitive")).toThrowError(
      /external finding/i,
    );
    expect(assertUntangleMetricNumber(3, "cognitive")).toBe(3);
    expect(() => assertUntangleMetricNumber(Number.NaN, "cognitive")).toThrowError(/finite/);
  });

  it("refuses to build a non-finite external number", () => {
    expect(() => makeExternalNumber(Number.POSITIVE_INFINITY)).toThrowError(/finite/);
  });

  it("keeps external measurements canonically serializable", () => {
    const measurement: ExternalMeasurementV1 = {
      schemaVersion: 1,
      evidenceOnly: true,
      workspaceId: "workspace-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      filePath: "src/index.ts",
      key: "cyclomatic_complexity",
      value: makeExternalNumber(12),
      extensionRunId: "run-1",
      measuredAt: "2026-09-05T00:00:00.000Z",
      provenance: {
        extensionId: "example-analyzer",
        formatParserVersion: "untangle-format-generic-metrics-v1",
        outputFormat: "generic-metrics",
        toolVersion: "1.2.3",
        invocation: "binary",
      },
    };
    expect(JSON.parse(canonicalJson(measurement))).toEqual(measurement);
  });
});

describe("ExternalFindingV1", () => {
  it("survives canonical JSON without loss", () => {
    const value = finding();
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  it("has a stable id and an ordinal that separates identical locations", () => {
    const first = buildExternalFindingId({
      extensionRunId: "run-1",
      tool: "example-analyzer",
      ruleId: "rule.a",
      relativePath: "src/index.ts",
      startByte: 120,
      ordinalWithinLocation: 0,
    });
    expect(first).toBe(finding().findingId);
    expect(first).not.toBe(
      buildExternalFindingId({
        extensionRunId: "run-1",
        tool: "example-analyzer",
        ruleId: "rule.a",
        relativePath: "src/index.ts",
        startByte: 120,
        ordinalWithinLocation: 1,
      }),
    );
  });

  it("matches across runs without line numbers", () => {
    const base = buildFindingMatchKey({
      tool: "example-analyzer",
      ruleId: "rule.a",
      symbolId: "symbol-1",
      relativePath: "src/index.ts",
      message: "unsafe call",
    });
    const moved = buildFindingMatchKey({
      tool: "example-analyzer",
      ruleId: "rule.a",
      symbolId: "symbol-1",
      relativePath: "src/index.ts",
      message: "unsafe   call\n",
    });
    expect(base).toBe(moved);

    const otherRule = buildFindingMatchKey({
      tool: "example-analyzer",
      ruleId: "rule.b",
      symbolId: "symbol-1",
      relativePath: "src/index.ts",
      message: "unsafe call",
    });
    expect(base).not.toBe(otherRule);
  });
});

describe("resolveNormalizedSeverity", () => {
  it("maps declared values and reports when the fallback had to step in", () => {
    expect(resolveNormalizedSeverity(MAPPING, "blocker")).toEqual({
      normalized: "critical",
      matched: true,
    });
    expect(resolveNormalizedSeverity(MAPPING, "WHATEVER")).toEqual({
      normalized: "info",
      matched: false,
    });
  });

  it("honours case sensitivity when declared", () => {
    const strict: SeverityMappingV1 = { ...MAPPING, caseInsensitive: false };
    expect(resolveNormalizedSeverity(strict, "blocker").matched).toBe(false);
    expect(resolveNormalizedSeverity(strict, "BLOCKER").matched).toBe(true);
  });
});

describe("validateExtensionManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateExtensionManifest(manifest())).toEqual([]);
  });

  it("rejects a container image that is not pinned to a full digest (X6)", () => {
    const value = manifest({
      container: { ...manifest().container!, digest: "sha256:abc" },
    });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain(
      "container.digest",
    );
  });

  it("rejects a declared invocation mode without its configuration block", () => {
    const value = manifest({ invocation: ["binary", "container"] });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain("binary");
  });

  it("couples restricted licenses to an explicit acknowledgment (X5)", () => {
    const value = manifest({
      license: { spdxId: "NOASSERTION", usageRestriction: "restricted" },
      requiresLicenseAcknowledgment: false,
    });
    const fields = validateExtensionManifest(value).map((issue) => issue.field);
    expect(fields).toContain("requiresLicenseAcknowledgment");
    expect(fields).toContain("license.restrictionSummary");
  });

  it("demands a justification for any network access", () => {
    const value = manifest({ networkAccess: "internet" });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain(
      "networkJustification",
    );
  });

  it("demands telemetry to be off by default when it can be switched off", () => {
    const value = manifest({
      telemetry: {
        sendsTelemetry: true,
        disableMechanism: "--metrics=off",
        disabledByDefault: false,
      },
    });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain(
      "telemetry.disabledByDefault",
    );
  });

  it("requires a severity mapping for finding formats", () => {
    const { severityMapping: _dropped, ...withoutMapping } = manifest();
    expect(validateExtensionManifest(withoutMapping).map((issue) => issue.field)).toContain(
      "severityMapping",
    );
  });

  it("rejects duplicate severity rules", () => {
    const value = manifest({
      severityMapping: {
        ...MAPPING,
        rules: [
          { from: "BLOCKER", to: "critical" },
          { from: "blocker", to: "high" },
        ],
      },
    });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain(
      "severityMapping.rules",
    );
  });

  it("requires every used ruleset to declare its source and license", () => {
    const value = manifest({ defaultRuleset: "default-set" });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain(
      "rulesetSources",
    );

    const declared = manifest({
      defaultRuleset: "default-set",
      rulesetSources: [
        {
          ruleset: "default-set",
          source: "registry",
          license: "NOASSERTION",
          usageRestriction: "none",
        },
      ],
    });
    expect(validateExtensionManifest(declared)).toEqual([]);
  });

  it("rejects an unknown output format — Untangle knows formats, not tools (X9)", () => {
    const value = manifest({
      outputFormat: "some-tool-native-json" as unknown as ExtensionManifestV1["outputFormat"],
    });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain("outputFormat");
  });

  it("rejects an id that is unusable as a directory name", () => {
    const value = manifest({ id: "../escape" });
    expect(validateExtensionManifest(value).map((issue) => issue.field)).toContain("id");
  });
});
