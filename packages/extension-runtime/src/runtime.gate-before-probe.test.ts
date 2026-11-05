/**
 * X5 an der Laufzeitgrenze, nicht in der Aufreihung des Aufrufers.
 *
 * `detectExtension` startet fuer den Modus `binary` einen Prozess (die
 * Versionsabfrage) und spricht fuer `http` einen Endpunkt an. Beides ist ein
 * Zugriff auf ein fremdes Werkzeug. Solange das Lizenz-Gate offen ist, darf
 * nach X5 nichts davon passieren — „nicht einmal gepullt werden".
 *
 * Bis Welle 10 war das nur die Reihenfolge in `runRun`: erst Gate, dann
 * `detect`. Wer `detect` anderswo aufruft — `status`, ein MCP-Tool, ein Job —
 * bekaeme die Verletzung zurueck. Diese Tests binden die Regel an die
 * Funktion selbst.
 */
import { describe, expect, it } from "vitest";

import type { LoadedExtensionV1 } from "./manifest/load.js";
import { parseExtensionManifest } from "./manifest/shape.js";
import type { HttpRunnerPort, ProcessInvocationV1, ProcessRunnerPort } from "./process/types.js";
import { detectExtension } from "./runtime.js";
import { countingRandom, fixedClock, readFixture } from "./test-support/fixtures.js";

const RESTRICTED_BINARY = readFixture("manifests/restricted-binary.manifest.toml");
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

function refusingRunner(): ProcessRunnerPort & { calls: ProcessInvocationV1[] } {
  const calls: ProcessInvocationV1[] = [];
  return {
    calls,
    run(invocation) {
      calls.push(invocation);
      throw new Error("the process boundary was crossed although the license gate was open");
    },
  };
}

function refusingHttpRunner(): HttpRunnerPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request(request) {
      calls.push(request.url);
      throw new Error("the HTTP boundary was crossed although the license gate was open");
    },
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

describe("detectExtension und das Lizenz-Gate (X5)", () => {
  it("fragt die Version eines nicht bestaetigten Werkzeugs nicht ab", async () => {
    const runner = refusingRunner();
    const health = await detectExtension(deps(runner), {
      extension: loaded(RESTRICTED_BINARY),
      licenseGate: "unacknowledged",
      env: { PATH: "/usr/bin" },
    });

    expect(runner.calls).toEqual([]);
    expect(health.available).toBe(false);
    expect(health.effectiveInvocation).toBeUndefined();
    expect(health.licenseGate).toBe("unacknowledged");
    expect(health.unavailableReasons).toHaveLength(1);
    expect(health.unavailableReasons[0]?.detail).toContain("license gate");
  });

  it("behandelt einen Widerruf genauso wie eine fehlende Bestaetigung", async () => {
    const runner = refusingRunner();
    const health = await detectExtension(deps(runner), {
      extension: loaded(RESTRICTED_BINARY),
      licenseGate: "revoked",
      env: { PATH: "/usr/bin" },
    });

    expect(runner.calls).toEqual([]);
    expect(health.available).toBe(false);
    expect(health.licenseGate).toBe("revoked");
  });

  it("spricht auch keinen HTTP-Endpunkt an, solange das Gate offen ist", async () => {
    const runner = refusingRunner();
    const httpRunner = refusingHttpRunner();
    const health = await detectExtension(deps(runner, httpRunner), {
      extension: loaded(GENERIC_HTTP),
      licenseGate: "unacknowledged",
      httpUrl: "http://127.0.0.1:19000",
    });

    expect(httpRunner.calls).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(health.available).toBe(false);
    expect(health.endpoint).toBeUndefined();
  });

  it("prueft weiter, sobald das Gate erfuellt oder nicht noetig ist", async () => {
    const runner: ProcessRunnerPort & { calls: ProcessInvocationV1[] } = {
      calls: [],
      run(invocation) {
        this.calls.push(invocation);
        return Promise.resolve({
          outcome: "completed" as const,
          exitCode: 0,
          signal: null,
          stdout: "restricted-analyzer 2.1.0",
          stderr: "",
          stdoutBytes: 25,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          wallTimeMs: 5,
        });
      },
    };
    const health = await detectExtension(deps(runner), {
      extension: loaded(RESTRICTED_BINARY),
      licenseGate: "acknowledged",
      env: { PATH: "/usr/bin" },
    });

    expect(runner.calls).toHaveLength(1);
    expect(health.available).toBe(true);
    expect(health.toolVersion).toBe("2.1.0");
  });
});
