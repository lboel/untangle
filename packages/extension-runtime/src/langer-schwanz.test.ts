/**
 * Der lange Schwanz aus BUILD_PLAN §25 fuer `extension-runtime`:
 * WP-182, WP-183, WP-184, WP-199.
 *
 * Alle vier haben dieselbe Form — das Ergebnis sieht vollstaendig aus und ist
 * es nicht. Eine erfundene Zeile 1 ohne Marke, eine gekuerzte Ausgabe ohne
 * Vermerk, eine leere Zeichenkette als Messwert 0, ein gueltiger leerer
 * Bericht mit falscher Begruendung abgelehnt.
 */
import { describe, expect, it } from "vitest";

import { parseGenericMetrics } from "./formats/generic-metrics.js";
import { parseJUnitXml } from "./formats/junit-xml.js";
import { parseSarif } from "./formats/sarif.js";
import { evaluateLicenseGate } from "./license-gate.js";
import type { LoadedExtensionV1 } from "./manifest/load.js";
import { parseExtensionManifest } from "./manifest/shape.js";
import { createLineOffsetResolver } from "./positions.js";
import type { ProcessResultV1, ProcessRunnerPort } from "./process/types.js";
import { defaultProcessLimits } from "./process/types.js";
import { runExtension } from "./runtime.js";
import { countingRandom, fixedClock, readFixture } from "./test-support/fixtures.js";
import type { ExtensionHealthV1 } from "./types.js";

const GENERIC_BINARY = readFixture("manifests/generic-binary.manifest.toml");

function loaded(tomlText: string): LoadedExtensionV1 {
  const parsed = parseExtensionManifest(tomlText);
  if (parsed.manifest === null) {
    throw new Error(`fixture manifest is invalid: ${JSON.stringify(parsed.issues)}`);
  }
  return {
    manifest: parsed.manifest,
    origin: "user-data-dir",
    manifestPath: "/home/dev/.untangle/extensions/x/manifest.toml",
    manifestSha256: "0".repeat(64),
  };
}

function processResult(overrides: Partial<ProcessResultV1> = {}): ProcessResultV1 {
  return {
    outcome: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    wallTimeMs: 12,
    ...overrides,
  };
}

function fakeRunner(results: ProcessResultV1[]): ProcessRunnerPort {
  const queue = [...results];
  return { run: () => Promise.resolve(queue.shift() ?? processResult()) };
}

function health(extension: LoadedExtensionV1): ExtensionHealthV1 {
  return {
    schemaVersion: 1,
    extensionId: extension.manifest.id,
    checkedAt: "2026-09-01T00:00:00.000Z",
    available: true,
    effectiveInvocation: extension.manifest.invocation[0] ?? "binary",
    toolVersion: "9.9.9",
    licenseGate: "not_required",
    unavailableReasons: [],
  };
}

function runInput(extension: LoadedExtensionV1) {
  return {
    extension,
    health: health(extension),
    gate: evaluateLicenseGate({ extension, acknowledgments: [] }),
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    workspacePath: "/work/repo",
    resolveFile: (path: string) => ({ relativePath: path, fileId: `file-${path}` }),
    resolvePosition: createLineOffsetResolver(new Map([["src/a.ts", "a\nb\nc\nd\ne\n"]])),
    limits: defaultProcessLimits(),
  };
}

function deps(processRunner: ProcessRunnerPort): Parameters<typeof runExtension>[0] {
  return {
    clock: fixedClock(1_767_225_600_000, 7),
    random: countingRandom(),
    processRunner,
  };
}

describe("WP-182 — eine Region mit NUR byteOffset bekommt keine erfundene Zeile ohne Marke", () => {
  const log = (region: Record<string, unknown>): string =>
    JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "example", rules: [] } },
          results: [
            {
              ruleId: "r1",
              level: "error",
              message: { text: "m" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/a.ts" },
                    region,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

  it("setzt lineUnknown und vermerkt die Ersatzangabe", () => {
    const result = parseSarif(log({ byteOffset: 4096, byteLength: 12 }));
    const finding = result.findings[0];
    expect(finding?.position?.startLine).toBe(1);
    expect(
      finding?.position?.lineUnknown,
      "Zeile 1 ohne lineUnknown ist von einer gemessenen Zeile nicht zu unterscheiden",
    ).toBe(true);
    expect(finding?.position?.byteOffset).toBe(4096);
    expect(result.issues.some((issue) => issue.detail.includes("byteOffset 4096"))).toBe(true);
  });

  it("laesst eine gemessene Zeile unmarkiert", () => {
    const result = parseSarif(log({ startLine: 3, byteOffset: 4096 }));
    const finding = result.findings[0];
    expect(finding?.position?.startLine).toBe(3);
    expect(finding?.position?.lineUnknown).toBeUndefined();
  });
});

describe("WP-183 — eine gekuerzte Ausgabe wird gemeldet, nicht geparst", () => {
  const ONE_FINDING = JSON.stringify({
    path: "src/a.ts",
    startLine: 2,
    ruleId: "r",
    message: "m",
    severity: "error",
  });

  it("lehnt eine gekuerzte stdout-Ausgabe des Werkzeugs ab, statt eine Teilmenge zu melden", async () => {
    const extension = loaded(GENERIC_BINARY);
    // Ein Runner, der `completed` meldet UND kuerzt: genau das, was ein
    // anderer Adapter dieses Ports tun darf.
    const result = await runExtension(
      deps(
        fakeRunner([
          processResult({ stdout: ONE_FINDING, stdoutBytes: 9_000_000, stdoutTruncated: true }),
        ]),
      ),
      runInput(extension),
    );

    expect(result.run.exitStatus).toBe("failed");
    expect(result.error?.message).toContain("truncated");
    expect(result.error?.message).toContain("9000000");
    expect(result.findings).toHaveLength(0);
  });

  it("laesst eine ungekuerzte Ausgabe unveraendert durch", async () => {
    const extension = loaded(GENERIC_BINARY);
    const result = await runExtension(
      deps(fakeRunner([processResult({ stdout: ONE_FINDING, stdoutBytes: 120 })])),
      runInput(extension),
    );
    expect(result.run.exitStatus).toBe("completed");
    expect(result.findings).toHaveLength(1);
  });
});

describe("WP-184 — ein leerer value ist keine Null", () => {
  it("lehnt einen leeren und einen nur aus Leerzeichen bestehenden Wert ab", () => {
    for (const value of ["", "   ", "\t"]) {
      const result = parseGenericMetrics(JSON.stringify({ key: "duplicated_lines", value }));
      expect(result.measurements, `value=${JSON.stringify(value)} wurde zur Zahl`).toHaveLength(0);
      expect(result.issues[0]?.reason).toBe("invalid_number");
    }
  });

  it("liest eine echte Null weiterhin als Null", () => {
    const result = parseGenericMetrics(JSON.stringify({ key: "duplicated_lines", value: 0 }));
    expect(result.measurements[0]?.value).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it("liest eine Zahl im String weiterhin", () => {
    const result = parseGenericMetrics(JSON.stringify({ key: "x", value: " 3.5 " }));
    expect(result.measurements[0]?.value).toBe(3.5);
  });
});

describe("WP-199 — ein gueltiger, LEERER Bericht ist kein fehlender Bericht", () => {
  it("erkennt einen leeren JUnit-Bericht als Bericht", () => {
    const parsed = parseJUnitXml("<testsuites></testsuites>");
    expect(parsed.entriesSeen).toBe(0);
    expect(parsed.recognizedReport).toBe(true);
  });

  it("erkennt einen leeren SARIF-Log als Bericht", () => {
    const parsed = parseSarif(JSON.stringify({ version: "2.1.0", runs: [] }));
    expect(parsed.entriesSeen).toBe(0);
    expect(parsed.recognizedReport).toBe(true);
  });

  it("laesst ein zeilenweises Format ohne Berichtshuelle ungesetzt", () => {
    expect(parseGenericMetrics("").recognizedReport).toBeUndefined();
  });

  it("laesst einen gueltigen, leeren SARIF-Bericht bestehen und haelt den Widerspruch fest", async () => {
    const extension = loaded(readFixture("manifests/valid-sarif.manifest.toml"));
    const result = await runExtension(
      deps(
        fakeRunner([
          processResult({
            stdout: JSON.stringify({ version: "2.1.0", runs: [] }),
            exitCode: 1,
            stderr: "no issues, but exiting 1",
          }),
        ]),
      ),
      { ...runInput(extension), ruleset: "curated/default" },
    );

    // Der Befund: frueher scheiterte dieser Lauf mit „die Ausgabe enthielt
    // ueberhaupt keine Eintraege" — ueber eine Ausgabe, die ein einwandfreier
    // SARIF-Log war. Jetzt besteht er, und der Widerspruch steht dabei.
    expect(result.run.exitStatus).toBe("completed");
    expect(result.run.errors.map((error) => error.code)).toContain(
      "EMPTY_REPORT_AFTER_NONZERO_EXIT",
    );
    expect(result.run.errors.map((error) => error.code)).toContain("TOOL_EXIT_NONZERO");
    expect(result.findings).toHaveLength(0);
  });

  it("scheitert bei leerer, NICHT als Bericht erkennbarer Ausgabe mit einer wahren Begruendung", async () => {
    const extension = loaded(GENERIC_BINARY);
    const result = await runExtension(
      deps(fakeRunner([processResult({ exitCode: 1, stderr: "boom" })])),
      runInput(extension),
    );
    expect(result.run.exitStatus).toBe("failed");
    expect(result.error?.message).toContain("not recognizable as a generic-findings report");
  });
});
