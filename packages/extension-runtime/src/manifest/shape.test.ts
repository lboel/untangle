import { describe, expect, it } from "vitest";

import { readFixture } from "../test-support/fixtures.js";

import { parseExtensionManifest } from "./shape.js";

const VALID = readFixture("manifests/valid-sarif.manifest.toml");
const RESTRICTED = readFixture("manifests/restricted.manifest.toml");
const MOVING_TAG = readFixture("manifests/moving-tag.manifest.toml");

describe("parseExtensionManifest", () => {
  it("liest ein gueltiges SARIF-Manifest vollstaendig", () => {
    const result = parseExtensionManifest(VALID);
    expect(result.issues).toEqual([]);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest?.id).toBe("example-sast");
    expect(result.manifest?.outputFormat).toBe("sarif");
    expect(result.manifest?.invocation).toEqual(["binary"]);
    expect(result.manifest?.binary?.analyzeArgs).toEqual([
      "scan",
      "--sarif",
      "--config",
      "{ruleset}",
      "{target}",
    ]);
    expect(result.manifest?.severityMapping?.rules).toHaveLength(4);
  });

  it("liest ein Container-Manifest mit gepinntem Digest", () => {
    const result = parseExtensionManifest(RESTRICTED);
    expect(result.issues).toEqual([]);
    expect(result.manifest?.container?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.manifest?.container?.ports).toEqual([
      { name: "api", containerPort: 9000, hostPortDefault: 19000 },
    ]);
    expect(result.manifest?.container?.workspaceMount.readOnly).toBe(true);
    expect(result.manifest?.requiresLicenseAcknowledgment).toBe(true);
  });

  it("lehnt ein bewegliches Image-Tag ab (X6)", () => {
    const result = parseExtensionManifest(MOVING_TAG);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("container.digest");
  });

  it("lehnt ungueltiges TOML mit Begruendung ab", () => {
    const result = parseExtensionManifest("id = ");
    expect(result.manifest).toBeNull();
    expect(result.issues[0]?.message).toMatch(/not valid TOML/);
  });

  it("nennt jedes fehlende Pflichtfeld mit Feldpfad", () => {
    const result = parseExtensionManifest('schemaVersion = 1\nid = "x"\n');
    expect(result.manifest).toBeNull();
    const fields = result.issues.map((issue) => issue.field);
    expect(fields).toContain("displayName");
    expect(fields).toContain("category");
    expect(fields).toContain("outputFormat");
    expect(fields).toContain("resources");
    expect(fields).toContain("license");
    expect(fields).toContain("telemetry");
  });

  it("lehnt ein Kommando mit Shell-Metazeichen ab (X4)", () => {
    const text = VALID.replace('command = "example-sast"', 'command = "example-sast && curl evil"');
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("binary.command");
  });

  it("lehnt ein Manifest ab, das einen Geheimniswert mitfuehrt", () => {
    const text = `${VALID}\n[[secrets]]\nname = "token"\nenvVar = "EXAMPLE_TOKEN"\nrequired = true\npurpose = "API access"\nvalue = "s3cret"\n`;
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.some((issue) => issue.message.includes("must not carry values"))).toBe(
      true,
    );
  });

  it("verlangt bei eingeschraenkter Lizenz eine Bestaetigung (X5)", () => {
    const text = RESTRICTED.replace(
      "requiresLicenseAcknowledgment = true",
      "requiresLicenseAcknowledgment = false",
    );
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("requiresLicenseAcknowledgment");
  });

  it("verlangt eine Severity-Abbildung fuer befundliefernde Formate", () => {
    const text = VALID.replace(/\[severityMapping\][\s\S]*?\n\n/, "\n");
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("severityMapping");
  });

  it("lehnt Telemetrie ab, die trotz Abschaltmechanismus aktiv bleibt", () => {
    const text = RESTRICTED.replace("disabledByDefault = true", "disabledByDefault = false");
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("telemetry.disabledByDefault");
  });

  it("verlangt eine Begruendung fuer jeden Netzzugriff", () => {
    const text = RESTRICTED.replace(/networkJustification = ".*"\n/, "");
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("networkJustification");
  });

  it("lehnt ein unbekanntes Ausgabeformat ab (X9)", () => {
    const text = VALID.replace('outputFormat = "sarif"', 'outputFormat = "vendor-json"');
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("outputFormat");
  });

  it("verlangt, dass defaultRuleset in rulesetSources deklariert ist", () => {
    const text = VALID.replace('ruleset = "curated/default"', 'ruleset = "curated/other"');
    const result = parseExtensionManifest(text);
    expect(result.manifest).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain("rulesetSources");
  });
});
