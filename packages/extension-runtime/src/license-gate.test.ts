import { sha256Hex } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import type { LicenseAcknowledgmentV1 } from "./license-gate.js";
import {
  acknowledgmentFilePath,
  buildAcknowledgment,
  evaluateLicenseGate,
  loadLicenseAcknowledgments,
} from "./license-gate.js";
import type { LoadedExtensionV1 } from "./manifest/load.js";
import { parseExtensionManifest } from "./manifest/shape.js";
import { memoryFileSystem, readFixture } from "./test-support/fixtures.js";

const VALID = readFixture("manifests/valid-sarif.manifest.toml");
const RESTRICTED = readFixture("manifests/restricted.manifest.toml");

function loaded(tomlText: string): LoadedExtensionV1 {
  const parsed = parseExtensionManifest(tomlText);
  if (parsed.manifest === null) {
    throw new Error(`fixture manifest is invalid: ${JSON.stringify(parsed.issues)}`);
  }
  const summary = parsed.manifest.license.restrictionSummary;
  return {
    manifest: parsed.manifest,
    origin: "user-data-dir",
    manifestPath: "/home/dev/.untangle/extensions/x/manifest.toml",
    manifestSha256: sha256Hex(tomlText),
    ...(summary === undefined ? {} : { restrictionSummarySha256: sha256Hex(summary) }),
  };
}

describe("evaluateLicenseGate", () => {
  it("verlangt nichts, wenn Lizenz und Regelsatz unbeschraenkt sind", () => {
    const decision = evaluateLicenseGate({ extension: loaded(VALID), acknowledgments: [] });
    expect(decision.tool.status).toBe("not_required");
    expect(decision.rulesets[0]?.status).toBe("not_required");
    expect(decision.allowed).toBe(true);
    expect(decision.acknowledgeCommands).toEqual([]);
  });

  it("sperrt ein eingeschraenktes Werkzeug ohne Bestaetigung (X5)", () => {
    const decision = evaluateLicenseGate({ extension: loaded(RESTRICTED), acknowledgments: [] });
    expect(decision.tool.status).toBe("unacknowledged");
    expect(decision.allowed).toBe(false);
    expect(decision.acknowledgeCommands).toEqual([
      "untangle extensions enable restricted-tool --acknowledge-license",
    ]);
  });

  it("gibt nach Bestaetigung frei", () => {
    const extension = loaded(RESTRICTED);
    const acknowledgment = buildAcknowledgment({
      manifest: extension.manifest,
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      acknowledgedBy: "dev",
    });
    const decision = evaluateLicenseGate({ extension, acknowledgments: [acknowledgment] });
    expect(decision.tool.status).toBe("acknowledged");
    expect(decision.allowed).toBe(true);
  });

  it("sperrt nach Widerruf wieder", () => {
    const extension = loaded(RESTRICTED);
    const acknowledgment: LicenseAcknowledgmentV1 = {
      ...buildAcknowledgment({
        manifest: extension.manifest,
        acknowledgedAt: "2026-09-01T00:00:00.000Z",
        acknowledgedBy: "dev",
      }),
      revokedAt: "2026-09-02T00:00:00.000Z",
    };
    const decision = evaluateLicenseGate({ extension, acknowledgments: [acknowledgment] });
    expect(decision.tool.status).toBe("revoked");
    expect(decision.allowed).toBe(false);
  });

  it("entwertet die Bestaetigung, wenn sich restrictionSummary aendert (§9.2)", () => {
    const extension = loaded(RESTRICTED);
    const acknowledgment = buildAcknowledgment({
      manifest: extension.manifest,
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      acknowledgedBy: "dev",
    });
    const changed = loaded(
      RESTRICTED.replace(
        "Analyzers may only be used under the vendor's source-available terms.",
        "The terms changed and are now stricter.",
      ),
    );
    const decision = evaluateLicenseGate({
      extension: changed,
      acknowledgments: [acknowledgment],
    });
    expect(decision.tool.status).toBe("unacknowledged");
    expect(decision.tool.reason).toContain("restrictionSummary changed");
  });

  it("sperrt einen nicht deklarierten Regelsatz konservativ (§9.5)", () => {
    const decision = evaluateLicenseGate({
      extension: loaded(VALID),
      acknowledgments: [],
      ruleset: "registry/unknown-pack",
    });
    expect(decision.tool.status).toBe("not_required");
    expect(decision.rulesets[0]?.status).toBe("unacknowledged");
    expect(decision.rulesets[0]?.reason).toContain("not declared in rulesetSources");
    expect(decision.allowed).toBe(false);
    expect(decision.acknowledgeCommands).toEqual([
      "untangle extensions enable example-sast --acknowledge-ruleset registry/unknown-pack",
    ]);
  });

  it("loest fuer rein lokale Regeldateien kein Gate aus (§9.5)", () => {
    const decision = evaluateLicenseGate({
      extension: loaded(VALID),
      acknowledgments: [],
      localRulesetPaths: ["/work/repo/rules"],
    });
    expect(decision.rulesets).toEqual([]);
    expect(decision.allowed).toBe(true);
  });
});

describe("loadLicenseAcknowledgments", () => {
  const userDataDir = "/home/dev/.local/share/untangle";
  const path = acknowledgmentFilePath(userDataDir);

  it("liest die Bestaetigungen aus dem Nutzer-Datenverzeichnis", async () => {
    const fs = memoryFileSystem({
      [path]: JSON.stringify({
        schemaVersion: 1,
        acknowledgments: [
          {
            extensionId: "restricted-tool",
            spdxId: "LicenseRef-source-available-1.0",
            acknowledgedAt: "2026-09-01T00:00:00.000Z",
            acknowledgedBy: "dev",
          },
        ],
      }),
    });
    const result = await loadLicenseAcknowledgments(fs, { userDataDirectory: userDataDir });
    expect(result.acknowledgments).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("behandelt eine fehlende Datei als nichts bestaetigt", async () => {
    const fs = memoryFileSystem({});
    const result = await loadLicenseAcknowledgments(fs, { userDataDirectory: userDataDir });
    expect(result.acknowledgments).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("liest NIE aus einem Projektverzeichnis und warnt (§9.2)", async () => {
    const projectPath = acknowledgmentFilePath("/work/repo/.untangle");
    const fs = memoryFileSystem({
      [projectPath]: JSON.stringify({
        schemaVersion: 1,
        acknowledgments: [
          {
            extensionId: "restricted-tool",
            spdxId: "LicenseRef-source-available-1.0",
            acknowledgedAt: "2026-09-01T00:00:00.000Z",
            acknowledgedBy: "someone-else",
          },
        ],
      }),
    });
    const result = await loadLicenseAcknowledgments(fs, {
      userDataDirectory: "/work/repo/.untangle",
      projectRoots: ["/work/repo"],
    });
    expect(result.acknowledgments).toEqual([]);
    expect(result.warnings[0]).toContain("never read from a project directory");
  });

  it("meldet einen kaputten Eintrag, statt ihn zu verschlucken (E4)", async () => {
    const fs = memoryFileSystem({
      [path]: JSON.stringify({ schemaVersion: 1, acknowledgments: [{ extensionId: "x" }] }),
    });
    const result = await loadLicenseAcknowledgments(fs, { userDataDirectory: userDataDir });
    expect(result.acknowledgments).toEqual([]);
    expect(result.warnings[0]).toContain("malformed");
  });

  it("meldet unlesbares JSON und bestaetigt nichts", async () => {
    const fs = memoryFileSystem({ [path]: "{" });
    const result = await loadLicenseAcknowledgments(fs, { userDataDirectory: userDataDir });
    expect(result.acknowledgments).toEqual([]);
    expect(result.warnings[0]).toContain("not valid JSON");
  });
});
