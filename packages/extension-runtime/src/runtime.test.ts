import { describe, expect, it } from "vitest";

import { evaluateLicenseGate } from "./license-gate.js";
import type { LoadedExtensionV1 } from "./manifest/load.js";
import { parseExtensionManifest } from "./manifest/shape.js";
import { createLineOffsetResolver } from "./positions.js";
import type {
  HttpRunnerPort,
  ProcessInvocationV1,
  ProcessResultV1,
  ProcessRunnerPort,
} from "./process/types.js";
import { defaultProcessLimits } from "./process/types.js";
import {
  buildExtensionRunId,
  compareVersions,
  detectExtension,
  resolvePlaceholders,
  runExtension,
} from "./runtime.js";
import { countingRandom, fixedClock, readFixture } from "./test-support/fixtures.js";
import type { ExtensionHealthV1 } from "./types.js";

const VALID = readFixture("manifests/valid-sarif.manifest.toml");
const RESTRICTED = readFixture("manifests/restricted.manifest.toml");
const SARIF = readFixture("sarif/basic.sarif.json");

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

/** Aufzeichnender Fake der Prozessgrenze; kein echter Unterprozess. */
function fakeRunner(results: ProcessResultV1[]): ProcessRunnerPort & {
  calls: ProcessInvocationV1[];
} {
  const calls: ProcessInvocationV1[] = [];
  const queue = [...results];
  return {
    calls,
    run(invocation) {
      calls.push(invocation);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("fakeRunner ran out of queued results");
      }
      return Promise.resolve(next);
    },
  };
}

function completed(stdout: string, exitCode = 0): ProcessResultV1 {
  return {
    outcome: "completed",
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    wallTimeMs: 12,
  };
}

function availableHealth(overrides: Partial<ExtensionHealthV1> = {}): ExtensionHealthV1 {
  return {
    schemaVersion: 1,
    extensionId: "example-sast",
    checkedAt: "2026-09-01T00:00:00.000Z",
    available: true,
    effectiveInvocation: "binary",
    toolVersion: "3.4.1",
    licenseGate: "not_required",
    unavailableReasons: [],
    ...overrides,
  };
}

function deps(runner: ProcessRunnerPort, httpRunner?: HttpRunnerPort) {
  return {
    clock: fixedClock(1_767_225_600_000, 7),
    random: countingRandom(),
    processRunner: runner,
    ...(httpRunner === undefined ? {} : { httpRunner }),
  };
}

function runInput(extension: LoadedExtensionV1, overrides: Record<string, unknown> = {}) {
  return {
    extension,
    health: availableHealth({ extensionId: extension.manifest.id }),
    gate: evaluateLicenseGate({ extension, acknowledgments: [] }),
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    workspacePath: "/work/repo",
    ruleset: "curated/default",
    resolveFile: (path: string) => ({
      relativePath: path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path,
      fileId: `file-${path}`,
    }),
    resolvePosition: createLineOffsetResolver(
      new Map([
        [
          "src/handlers/webhook.ts",
          "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\n",
        ],
        ["src/handlers/legacy.ts", "a\nb\nc\nd\n"],
      ]),
    ),
    limits: defaultProcessLimits(),
    ...overrides,
  };
}

describe("resolvePlaceholders", () => {
  it("ersetzt nur die geschlossene Menge der Platzhalter", () => {
    const result = resolvePlaceholders(["scan", "--config", "{ruleset}", "{target}"], {
      "{ruleset}": "curated/default",
      "{target}": "/work/repo",
    });
    expect(result.args).toEqual(["scan", "--config", "curated/default", "/work/repo"]);
    expect(result.missing).toEqual([]);
  });

  it("nennt jeden Platzhalter ohne Wert, statt ihn leer zu lassen (E4)", () => {
    const result = resolvePlaceholders(["--config", "{ruleset}"], {});
    expect(result.missing).toEqual(["{ruleset}"]);
  });
});

describe("compareVersions", () => {
  it("vergleicht numerisch, nicht lexikografisch", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareVersions("v2.0", "2.0.1")).toBe(-1);
  });
});

describe("buildExtensionRunId", () => {
  it("ist eine UUID und haengt am Nonce — zwei Laeufe sind zwei Laeufe", () => {
    const base = {
      workspaceId: "ws-1",
      extensionId: "example-sast",
      runtimeVersion: "untangle-extension-runtime-v1",
      startedAtIso: "2026-09-01T00:00:00.000Z",
    };
    const first = buildExtensionRunId({ ...base, runNonce: "a" });
    const second = buildExtensionRunId({ ...base, runNonce: "b" });
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
    expect(buildExtensionRunId({ ...base, runNonce: "a" })).toBe(first);
  });
});

describe("detectExtension", () => {
  it("liest die Werkzeugversion ueber die Versionsabfrage", async () => {
    const runner = fakeRunner([completed("example-sast 3.4.1\n")]);
    const health = await detectExtension(deps(runner), {
      extension: loaded(VALID),
      licenseGate: "not_required",
    });
    expect(health.available).toBe(true);
    expect(health.effectiveInvocation).toBe("binary");
    expect(health.toolVersion).toBe("3.4.1");
    expect(runner.calls[0]?.args).toEqual(["--version"]);
  });

  it("lehnt eine zu alte Version ab und begruendet es", async () => {
    const runner = fakeRunner([completed("example-sast 1.0.0\n")]);
    const health = await detectExtension(deps(runner), {
      extension: loaded(VALID),
      licenseGate: "not_required",
    });
    expect(health.available).toBe(false);
    expect(health.unavailableReasons[0]?.detail).toContain("below the required minimum");
  });

  it("meldet ein fehlendes Programm als nicht verfuegbar, nicht als Absturz (X2)", async () => {
    const runner = fakeRunner([
      {
        outcome: "spawn_failed",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        wallTimeMs: 1,
        failureDetail: "spawn example-sast ENOENT",
      },
    ]);
    const health = await detectExtension(deps(runner), {
      extension: loaded(VALID),
      licenseGate: "not_required",
    });
    expect(health.available).toBe(false);
    expect(health.unavailableReasons[0]?.detail).toContain("ENOENT");
  });

  it("startet ohne Container-Sonde keinen Container (X1)", async () => {
    const runner = fakeRunner([]);
    // Gate bestaetigt: sonst haelt X5 den Lauf schon vorher an und dieser Test
    // pruefte nicht mehr X1. Beide Regeln sind getrennt gedeckt.
    const health = await detectExtension(deps(runner), {
      extension: loaded(RESTRICTED),
      licenseGate: "acknowledged",
    });
    expect(runner.calls).toEqual([]);
    expect(health.available).toBe(false);
    expect(health.unavailableReasons[0]?.detail).toContain("no container runtime probe");
  });

  it("redigiert Geheimnisse in der Begruendung (§8.5)", async () => {
    const runner = fakeRunner([completed("", 1)]);
    const health = await detectExtension(deps(runner), {
      extension: loaded(VALID),
      licenseGate: "not_required",
      secretValues: ["s3cret-token"],
      env: { PATH: "/usr/bin", EXAMPLE_TOKEN: "s3cret-token" },
    });
    // Das Kommando scheitert; der Text darf kein Geheimnis enthalten.
    expect(JSON.stringify(health)).not.toContain("s3cret-token");
  });
});

describe("runExtension", () => {
  it("startet KEINEN Prozess, solange das Lizenz-Gate offen ist (X5)", async () => {
    const extension = loaded(RESTRICTED);
    const runner = fakeRunner([]);
    const result = await runExtension(
      deps(runner),
      runInput(extension, {
        health: availableHealth({ extensionId: "restricted-tool", licenseGate: "unacknowledged" }),
        gate: evaluateLicenseGate({ extension, acknowledgments: [] }),
        ruleset: undefined,
      }),
    );

    expect(runner.calls).toEqual([]);
    expect(result.run.exitStatus).toBe("failed");
    expect(result.run.errorCode).toBe("EXTENSION_LICENSE_UNACKNOWLEDGED");
    expect(result.error?.message).toContain("untangle extensions enable restricted-tool");
    expect(result.findings).toEqual([]);
  });

  it("startet KEINEN Prozess bei abweichendem Image-Digest (X6)", async () => {
    const extension = loaded(RESTRICTED);
    const runner = fakeRunner([]);
    const result = await runExtension(
      deps(runner),
      runInput(extension, {
        health: availableHealth({
          extensionId: "restricted-tool",
          effectiveInvocation: "container",
          imageDigest: "sha256:" + "f".repeat(64),
          digestMatchesManifest: false,
        }),
        gate: { ...evaluateLicenseGate({ extension, acknowledgments: [] }), allowed: true },
        ruleset: undefined,
      }),
    );
    expect(runner.calls).toEqual([]);
    expect(result.run.errorCode).toBe("EXTENSION_IMAGE_MISMATCH");
  });

  it("meldet eine nicht verfuegbare Extension, ohne zu starten (X2)", async () => {
    const runner = fakeRunner([]);
    const result = await runExtension(
      deps(runner),
      runInput(loaded(VALID), {
        health: {
          ...availableHealth(),
          available: false,
          effectiveInvocation: undefined,
          unavailableReasons: [{ invocation: "binary" as const, detail: "spawn ENOENT" }],
        },
      }),
    );
    expect(runner.calls).toEqual([]);
    expect(result.run.errorCode).toBe("EXTENSION_UNAVAILABLE");
    expect(result.error?.message).toContain("spawn ENOENT");
  });

  it("fuehrt einen SARIF-Lauf durch und normalisiert die Befunde", async () => {
    const runner = fakeRunner([completed(SARIF)]);
    const result = await runExtension(deps(runner), runInput(loaded(VALID)));

    expect(result.error).toBeUndefined();
    expect(result.run.exitStatus).toBe("completed");
    expect(result.run.formatParserVersion).toBe("untangle-format-sarif-v1");
    expect(result.run.runtimeVersion).toBe("untangle-extension-runtime-v1");
    // Werkzeugname und -version stammen aus der AUSGABE, nicht aus dem Quelltext.
    expect(result.run.toolVersion).toBe("3.4.1");
    expect(result.findings.every((finding) => finding.evidenceOnly)).toBe(true);
    expect(result.run.findingsTotal).toBe(result.findings.length);
    expect(result.run.findingCounts.high).toBeGreaterThan(0);
    // Platzhalter aufgeloest, kein Shell-String.
    expect(runner.calls[0]?.args).toEqual([
      "scan",
      "--sarif",
      "--config",
      "curated/default",
      "/work/repo",
    ]);
  });

  it("fuehrt jeden nicht uebernommenen Ausgabeeintrag im Lauf (E4)", async () => {
    const runner = fakeRunner([completed(SARIF)]);
    const result = await runExtension(deps(runner), runInput(loaded(VALID)));
    const skippedEntries = result.run.errors.filter(
      (entry) => entry.code === "OUTPUT_ENTRY_SKIPPED",
    );
    expect(skippedEntries.length).toBeGreaterThan(0);
    for (const entry of skippedEntries) {
      expect(entry.message).not.toBe("");
    }
  });

  it("meldet unbrauchbare Ausgabe als EXTENSION_FAILED/output_parse_failed", async () => {
    const runner = fakeRunner([completed("this is not sarif", 1)]);
    const result = await runExtension(deps(runner), runInput(loaded(VALID)));
    expect(result.run.exitStatus).toBe("failed");
    expect(result.run.errorCode).toBe("EXTENSION_FAILED");
    expect(result.error?.message).toContain("output_parse_failed");
  });

  it("meldet ein ueberschrittenes Zeitbudget als EXTENSION_TIMEOUT", async () => {
    const runner = fakeRunner([
      {
        outcome: "timeout",
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        wallTimeMs: 900_001,
        failureDetail: "time budget exceeded",
      },
    ]);
    const result = await runExtension(deps(runner), runInput(loaded(VALID)));
    expect(result.run.exitStatus).toBe("timeout");
    expect(result.run.errorCode).toBe("EXTENSION_TIMEOUT");
  });

  it("meldet zu grosse Ausgabe als EXTENSION_FAILED/output_too_large", async () => {
    const runner = fakeRunner([
      {
        outcome: "output_limit_exceeded",
        exitCode: null,
        signal: "SIGTERM",
        stdout: "x",
        stderr: "",
        stdoutBytes: 99_999_999,
        stderrBytes: 0,
        stdoutTruncated: true,
        stderrTruncated: false,
        wallTimeMs: 10,
        failureDetail: "output exceeded the limit of 4096 bytes on stdout",
      },
    ]);
    const result = await runExtension(deps(runner), runInput(loaded(VALID)));
    expect(result.run.errorCode).toBe("EXTENSION_FAILED");
    expect(result.error?.message).toContain("output_too_large");
  });

  it("raet keinen Aufruf, wenn das Manifest keine analyzeArgs nennt (X9)", async () => {
    const withoutArgs = loaded(VALID.replace(/analyzeArgs = \[.*\]\n/, ""));
    const runner = fakeRunner([]);
    const result = await runExtension(deps(runner), runInput(withoutArgs));
    expect(runner.calls).toEqual([]);
    expect(result.run.errorCode).toBe("EXTENSION_UNAVAILABLE");
    expect(result.error?.message).toContain("never guesses a tool invocation");
  });

  it("verweigert den Start bei unaufloesbarem Platzhalter", async () => {
    const runner = fakeRunner([]);
    const result = await runExtension(
      deps(runner),
      runInput(loaded(VALID), {
        ruleset: undefined,
        gate: {
          allowed: true,
          extensionId: "example-sast",
          tool: { status: "not_required", reason: "" },
          rulesets: [],
          acknowledgeCommands: [],
        },
      }),
    );
    expect(runner.calls).toEqual([]);
    expect(result.error?.message).toContain("{ruleset}");
  });

  it("kennzeichnet einen Lauf ohne Regelsatzherkunft als nicht vergleichbar", async () => {
    const runner = fakeRunner([completed(SARIF)]);
    const result = await runExtension(deps(runner), runInput(loaded(VALID)));
    expect(result.run.comparabilityLimited).toBe(true);
    expect(result.run.comparabilityNote).toContain("comparison base");
  });

  it("laesst einen Lauf mit Regelsatz-Hash vergleichbar", async () => {
    const runner = fakeRunner([completed(SARIF)]);
    const result = await runExtension(
      deps(runner),
      runInput(loaded(VALID), { rulesetHash: `sha256:${"a".repeat(64)}` }),
    );
    expect(result.run.comparabilityLimited).toBeUndefined();
  });
});
