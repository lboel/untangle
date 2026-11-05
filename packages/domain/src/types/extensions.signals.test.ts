/**
 * Der Vertrag, der eine fremde Zahl von einer eigenen trennt (X3, X8).
 *
 * Ein Kennwert ohne erklaerte Bedeutung ist ein Schluessel und eine Zahl.
 * `quality_signal = 0,45` und `cognitive_complexity = 4284` sehen im System
 * gleich aus, obwohl das eine ein herstellereigener Mischwert und das andere
 * dieselbe Groesse ist, die Untangle selbst berechnet. Genau daraus entsteht
 * der Fehler, den X3 verbietet.
 *
 * `complexitySignals` gibt dem Schluessel eine Bedeutung aus geschlossener
 * Menge — und `comparableTo` ist die einzige Tuer zu einer Gegenprobe. Fuer
 * einen Mischwert bleibt sie zu.
 */
import { describe, expect, it } from "vitest";

import { validateExtensionManifest, type ExtensionManifestV1 } from "./extensions.js";

function manifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  return {
    schemaVersion: 1,
    id: "metrics-probe",
    displayName: "Metrics Probe",
    category: "complexity",
    invocation: ["binary"],
    binary: {
      command: "probe",
      versionArgs: ["--version"],
      versionPattern: "([0-9.]+)",
      analyzeArgs: ["scan"],
    },
    resources: { minMemoryMb: 64, recommendedMemoryMb: 128, recommendedCpus: 1 },
    languages: [],
    license: { spdxId: "MIT", usageRestriction: "none" },
    requiresLicenseAcknowledgment: false,
    secrets: [],
    outputFormat: "generic-metrics",
    networkAccess: "none",
    telemetry: { sendsTelemetry: false, disabledByDefault: true },
    ...overrides,
  } as ExtensionManifestV1;
}

function fields(m: ExtensionManifestV1): string[] {
  return validateExtensionManifest(m).map((issue) => issue.field);
}

describe("complexitySignals", () => {
  it.each([
    ["sloc", "repository", "untangle-metrics-v1"],
    ["duplication", "file", "untangle-metrics-v1"],
    ["dependency-cycles", "symbol", "untangle-metrics-v1"],
    ["cognitive", "repository", "future-metrics-v99"],
  ] as const)("refuses an unavailable counterpart: %s/%s/%s", (kind, scope, comparableTo) => {
    const issues = validateExtensionManifest(
      manifest({ complexitySignals: [{ key: "metric", kind, scope, comparableTo }] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("complexitySignals[0].comparableTo");
    expect(issues[0]?.message).toContain("does not produce");
    expect(fields(manifest({ complexitySignals: [{ key: "metric", kind, scope }] }))).toEqual([]);
  });

  it.each(["dependency-cycles", "dependency-depth", "cognitive", "cyclomatic"] as const)(
    "retains existing repository counterparts: %s",
    (kind) => {
      expect(
        fields(
          manifest({
            complexitySignals: [
              { key: "metric", kind, scope: "repository", comparableTo: "untangle-metrics-v1" },
            ],
          }),
        ),
      ).toEqual([]);
    },
  );

  it("nimmt eine vergleichbare Groesse mit comparableTo an", () => {
    expect(
      fields(
        manifest({
          complexitySignals: [
            {
              key: "cognitive_complexity",
              kind: "cognitive",
              scope: "file",
              comparableTo: "untangle-metrics-v1",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("nimmt einen Mischwert ohne comparableTo an — als reine Evidenz", () => {
    expect(
      fields(
        manifest({
          complexitySignals: [
            { key: "quality_signal", kind: "proprietary-composite", scope: "repository" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("verweigert comparableTo fuer einen herstellereigenen Mischwert", () => {
    const issues = validateExtensionManifest(
      manifest({
        complexitySignals: [
          {
            key: "quality_signal",
            kind: "proprietary-composite",
            scope: "repository",
            comparableTo: "untangle-metrics-v1",
          },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("complexitySignals[0].comparableTo");
    expect(issues[0]?.message).toContain("nothing to compare");
  });

  it("verweigert eine unbekannte Bedeutung statt sie durchzureichen", () => {
    expect(
      fields(
        manifest({
          complexitySignals: [{ key: "x", kind: "maintainability-index" as never, scope: "file" }],
        }),
      ),
    ).toEqual(["complexitySignals[0].kind"]);
  });

  it("verweigert einen unbekannten Bezug", () => {
    expect(
      fields(
        manifest({
          complexitySignals: [{ key: "x", kind: "cognitive", scope: "module" as never }],
        }),
      ),
    ).toEqual(["complexitySignals[0].scope"]);
  });

  it("verweigert zwei Bedeutungen fuer denselben Ausgabeschluessel", () => {
    expect(
      fields(
        manifest({
          complexitySignals: [
            { key: "complexity", kind: "cyclomatic", scope: "file" },
            { key: "complexity", kind: "cognitive", scope: "file" },
          ],
        }),
      ),
    ).toEqual(["complexitySignals"]);
  });
});

describe("outputMapping", () => {
  it("laesst `flat-object` nur fuer generic-metrics zu", () => {
    expect(fields(manifest({ outputMapping: { shape: "flat-object" } }))).toEqual([]);
    expect(
      fields(
        manifest({
          outputFormat: "sarif",
          severityMapping: {
            mappingVersion: "v1",
            fallback: "medium",
            caseInsensitive: true,
            rules: [{ from: "error", to: "high" }],
          },
          outputMapping: { shape: "flat-object" },
        }),
      ),
    ).toEqual(["outputMapping.shape"]);
  });
});
