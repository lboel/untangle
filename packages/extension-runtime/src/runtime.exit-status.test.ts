/**
 * Regressionstests zu den Befunden 1 und 5 der Welle 3.
 *
 * Kern beider Befunde: ein ABGEBROCHENES Werkzeug galt als erfolgreicher Lauf.
 * Der Nutzer sah „completed, 0 Befunde" und schloss daraus auf eine saubere
 * Codebasis — die schaedlichste Form von E4.
 */
import { describe, expect, it } from "vitest";

import { evaluateLicenseGate } from "./license-gate.js";
import type { LoadedExtensionV1 } from "./manifest/load.js";
import { parseExtensionManifest } from "./manifest/shape.js";
import { createLineOffsetResolver } from "./positions.js";
import type {
  HttpResultV1,
  HttpRunnerPort,
  ProcessResultV1,
  ProcessRunnerPort,
} from "./process/types.js";
import { defaultProcessLimits } from "./process/types.js";
import { detectExtension, runExtension } from "./runtime.js";
import { countingRandom, fixedClock, readFixture } from "./test-support/fixtures.js";
import type { ExtensionHealthV1 } from "./types.js";

const GENERIC_BINARY = readFixture("manifests/generic-binary.manifest.toml");
const GENERIC_HTTP = readFixture("manifests/generic-http.manifest.toml");

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
  return {
    run: () => Promise.resolve(queue.shift() ?? processResult()),
  };
}

function fakeHttp(response: Partial<HttpResultV1>): HttpRunnerPort {
  return {
    request: () =>
      Promise.resolve({
        outcome: "completed",
        status: 200,
        body: "",
        bodyBytes: 0,
        bodyTruncated: false,
        wallTimeMs: 4,
        ...response,
      }),
  };
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

function deps(
  processRunner: ProcessRunnerPort,
  httpRunner?: HttpRunnerPort,
): Parameters<typeof runExtension>[0] {
  return {
    clock: fixedClock(1_767_225_600_000, 7),
    random: countingRandom(),
    processRunner,
    ...(httpRunner === undefined ? {} : { httpRunner }),
  };
}

const ONE_FINDING = JSON.stringify({
  path: "src/a.ts",
  startLine: 2,
  ruleId: "r",
  message: "m",
  severity: "error",
});

describe("runExtension — Werkzeugabbruch (Befund 1)", () => {
  it("meldet einen Abbruch mit leerer Ausgabe als gescheiterten Lauf, nicht als 0 Befunde", async () => {
    const extension = loaded(GENERIC_BINARY);
    const result = await runExtension(
      deps(
        fakeRunner([
          processResult({
            exitCode: 1,
            stderr: "FATAL: configuration file not found, analysis aborted",
          }),
        ]),
      ),
      runInput(extension),
    );

    expect(result.run.exitStatus).toBe("failed");
    expect(result.run.errorCode).toBe("EXTENSION_FAILED");
    expect(result.error?.message).toContain("exit_status");
    expect(result.error?.message).toContain("status 1");
    expect(result.error?.message).toContain("FATAL: configuration file not found");
  });

  it("erkennt auch ein durch ein Signal getoetetes Werkzeug als Abbruch", async () => {
    const extension = loaded(GENERIC_BINARY);
    const result = await runExtension(
      deps(fakeRunner([processResult({ exitCode: null, signal: "SIGKILL", stderr: "" })])),
      runInput(extension),
    );

    expect(result.run.exitStatus).toBe("failed");
    expect(result.error?.message).toContain("SIGKILL");
  });

  it("laesst einen Lauf MIT Eintraegen bestehen, haelt den Exit-Status aber fest", async () => {
    const extension = loaded(GENERIC_BINARY);
    const result = await runExtension(
      deps(
        fakeRunner([
          processResult({
            stdout: ONE_FINDING,
            exitCode: 2,
            stderr: "ERROR: could not analyze 41 files (out of memory)",
          }),
        ]),
      ),
      runInput(extension),
    );

    // Ein von Null verschiedener Exit-Status heisst bei vielen Werkzeugen
    // „ich habe etwas gefunden" — der Lauf scheitert deshalb nicht.
    expect(result.run.exitStatus).toBe("completed");
    expect(result.run.findingsTotal).toBe(1);
    const recorded = result.run.errors.find((entry) => entry.code === "TOOL_EXIT_NONZERO");
    expect(recorded?.message).toContain("status 2");
    expect(recorded?.message).toContain("out of memory");
  });

  it("redigiert Geheimnisse in der festgehaltenen stderr-Ausgabe", async () => {
    const extension = loaded(GENERIC_BINARY);
    const result = await runExtension(
      deps(
        fakeRunner([
          processResult({ stdout: ONE_FINDING, exitCode: 3, stderr: "token=s3cr3t rejected" }),
        ]),
      ),
      { ...runInput(extension), secretValues: ["s3cr3t"] },
    );
    const recorded = result.run.errors.find((entry) => entry.code === "TOOL_EXIT_NONZERO");
    expect(recorded?.message).toContain("***");
    expect(recorded?.message).not.toContain("s3cr3t");
  });

  it("laesst einen sauberen Lauf unberuehrt", async () => {
    const extension = loaded(GENERIC_BINARY);
    const result = await runExtension(
      deps(fakeRunner([processResult({ stdout: ONE_FINDING })])),
      runInput(extension),
    );
    expect(result.run.exitStatus).toBe("completed");
    expect(result.run.errors).toEqual([]);
  });
});

describe("runExtension — HTTP-Status (Befund 5)", () => {
  it("meldet 401 als gescheiterten Lauf, nicht als Lauf mit 0 Befunden", async () => {
    const extension = loaded(GENERIC_HTTP);
    const result = await runExtension(
      deps(fakeRunner([]), fakeHttp({ status: 401, body: '{"error":"unauthorized"}' })),
      runInput(extension),
    );

    expect(result.run.exitStatus).toBe("failed");
    expect(result.run.errorCode).toBe("EXTENSION_FAILED");
    expect(result.error?.message).toContain("http_error");
    expect(result.error?.message).toContain("401");
  });

  it("meldet auch 404 statt es als Erfolg zu nehmen", async () => {
    const extension = loaded(GENERIC_HTTP);
    const result = await runExtension(
      deps(fakeRunner([]), fakeHttp({ status: 404, body: "not found" })),
      runInput(extension),
    );
    expect(result.run.exitStatus).toBe("failed");
    expect(result.error?.message).toContain("404");
  });

  it("nimmt eine 2xx-Antwort an und normalisiert ihren Koerper", async () => {
    const extension = loaded(GENERIC_HTTP);
    const result = await runExtension(
      deps(fakeRunner([]), fakeHttp({ status: 200, body: ONE_FINDING })),
      runInput(extension),
    );
    expect(result.run.exitStatus).toBe("completed");
    expect(result.run.findingsTotal).toBe(1);
  });
});

describe("detectExtension — die Verfuegbarkeitspruefung im HTTP-Modus", () => {
  it("nennt einen Dienst mit 401 nicht verfuegbar und sagt warum", async () => {
    const extension = loaded(GENERIC_HTTP);
    const result = await detectExtension(deps(fakeRunner([]), fakeHttp({ status: 401 })), {
      extension,
      licenseGate: "not_required",
    });
    expect(result.available).toBe(false);
    expect(result.unavailableReasons[0]?.detail).toContain("401");
    expect(result.unavailableReasons[0]?.detail).toContain("credentials");
  });

  it("akzeptiert eine 404 auf der Wurzel-URL — der Dienst antwortet ja", async () => {
    // APIs, die nur Unterpfade bedienen, antworten auf `/` regelmaessig mit
    // 404. Das als „nicht verfuegbar" zu werten waere die falsche Aussage;
    // der eigentliche Analyselauf prueft seinen Status selbst.
    const extension = loaded(GENERIC_HTTP);
    const result = await detectExtension(deps(fakeRunner([]), fakeHttp({ status: 404 })), {
      extension,
      licenseGate: "not_required",
    });
    expect(result.available).toBe(true);
  });
});
