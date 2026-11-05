/**
 * `authSecretName` war ein Feld ohne Wirkung.
 *
 * Das Manifest durfte einen Eintrag aus `secrets` als Zugangsgeheimnis
 * benennen, und die HTTP-Grenze kann Header senden — nur verband die beiden
 * nichts. Eine Extension gegen eine tokengeschuetzte API war damit nicht
 * betreibbar: die Anfrage ging ohne Authorization hinaus und kam als 401
 * zurueck, und der Grund stand nirgends.
 *
 * Das Schema wird hier festgelegt, weil extensions.md es offenliess:
 * `Authorization: Bearer <wert>`. Der Wert kommt aus der Umgebung, nie aus dem
 * Manifest, und steht in `secretValues` — damit ihn jede Fehlermeldung
 * redigiert.
 */
import { describe, expect, it } from "vitest";

import { evaluateLicenseGate } from "./license-gate.js";
import type { LoadedExtensionV1 } from "./manifest/load.js";
import { parseExtensionManifest } from "./manifest/shape.js";
import { createLineOffsetResolver } from "./positions.js";
import type { HttpInvocationV1, HttpRunnerPort, ProcessRunnerPort } from "./process/types.js";
import { defaultProcessLimits } from "./process/types.js";
import { buildHttpAuthHeaders, detectExtension, runExtension } from "./runtime.js";
import { countingRandom, fixedClock } from "./test-support/fixtures.js";
import type { ExtensionHealthV1 } from "./types.js";

const TOKEN = "squ_s3cret_token_value";

const MANIFEST = `schemaVersion = 1
id = "guarded-api"
displayName = "Guarded Metrics API"
category = "quality-platform"
invocation = ["http"]
languages = []
outputFormat = "generic-metrics"
networkAccess = "loopback"
networkJustification = "the platform exposes its API on a loopback port only"
requiresLicenseAcknowledgment = false

[http]
defaultUrl = "http://127.0.0.1:19001"
analyzePath = "/api/measures"
analyzeMethod = "GET"
authSecretName = "api-token"

[outputMapping]
container = "component.measures"
key = "metric"

[[secrets]]
name = "api-token"
envVar = "PLATFORM_TOKEN"
purpose = "read-only access to the measures API"
required = true

[resources]
minMemoryMb = 128
recommendedMemoryMb = 256
recommendedCpus = 1

[license]
spdxId = "Apache-2.0"
usageRestriction = "none"

[telemetry]
sendsTelemetry = false
disabledByDefault = true
`;

function loaded(text = MANIFEST): LoadedExtensionV1 {
  const parsed = parseExtensionManifest(text);
  if (parsed.manifest === null) {
    throw new Error(`manifest is invalid: ${JSON.stringify(parsed.issues)}`);
  }
  return {
    manifest: parsed.manifest,
    origin: "user-data-dir",
    manifestPath: "/home/dev/.untangle/extensions/guarded-api/manifest.toml",
    manifestSha256: "0".repeat(64),
  };
}

function recordingHttp(body: string, status = 200): HttpRunnerPort & { calls: HttpInvocationV1[] } {
  const calls: HttpInvocationV1[] = [];
  return {
    calls,
    request(invocation) {
      calls.push(invocation);
      return Promise.resolve({
        outcome: "completed" as const,
        status,
        body,
        bodyBytes: body.length,
        bodyTruncated: false,
        wallTimeMs: 4,
      });
    },
  };
}

const NO_PROCESS: ProcessRunnerPort = {
  run: () => {
    throw new Error("an http extension must not start a process");
  },
};

const BODY = JSON.stringify({
  component: { measures: [{ metric: "cognitive_complexity", value: "4284" }] },
});

function deps(httpRunner: HttpRunnerPort) {
  return {
    clock: fixedClock(1_767_225_600_000, 7),
    random: countingRandom(),
    processRunner: NO_PROCESS,
    httpRunner,
  };
}

function health(): ExtensionHealthV1 {
  return {
    schemaVersion: 1,
    extensionId: "guarded-api",
    checkedAt: "2026-09-07T00:00:00.000Z",
    available: true,
    effectiveInvocation: "http",
    endpoint: "http://127.0.0.1:19001",
    licenseGate: "not_required",
    unavailableReasons: [],
  };
}

describe("buildHttpAuthHeaders", () => {
  it("baut den Bearer-Header aus der Umgebung", () => {
    expect(buildHttpAuthHeaders(loaded().manifest, { PLATFORM_TOKEN: TOKEN })).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("baut keinen Header ohne gesetztes Geheimnis — und erfindet keinen leeren", () => {
    expect(buildHttpAuthHeaders(loaded().manifest, {})).toEqual({});
    expect(buildHttpAuthHeaders(loaded().manifest, { PLATFORM_TOKEN: "" })).toEqual({});
  });

  it("baut keinen Header, wenn das Manifest kein Zugangsgeheimnis benennt", () => {
    const without = MANIFEST.replace('authSecretName = "api-token"\n', "");
    expect(buildHttpAuthHeaders(loaded(without).manifest, { PLATFORM_TOKEN: TOKEN })).toEqual({});
  });
});

describe("das Manifest bindet authSecretName an einen erklaerten Eintrag", () => {
  it("lehnt einen Verweis auf ein nicht deklariertes Geheimnis ab", () => {
    const broken = MANIFEST.replace('authSecretName = "api-token"', 'authSecretName = "absent"');
    const parsed = parseExtensionManifest(broken);
    expect(parsed.manifest).toBeNull();
    expect(parsed.issues.map((i) => i.field)).toContain("http.authSecretName");
  });
});

describe("die Anfrage traegt das Geheimnis, die Ausgabe nie", () => {
  it("sendet den Header bei der Verfuegbarkeitsprobe", async () => {
    const httpRunner = recordingHttp(BODY);
    await detectExtension(deps(httpRunner), {
      extension: loaded(),
      licenseGate: "not_required",
      httpHeaders: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(httpRunner.calls[0]?.headers?.["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("sendet den Header beim Analyselauf und liest die verschachtelte Liste", async () => {
    const httpRunner = recordingHttp(BODY);
    const extension = loaded();
    const result = await runExtension(deps(httpRunner), {
      extension,
      health: health(),
      gate: evaluateLicenseGate({ extension, acknowledgments: [] }),
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "ref-1",
      workspacePath: "/work/repo",
      httpHeaders: { Authorization: `Bearer ${TOKEN}` },
      secretValues: [TOKEN],
      resolveFile: (path: string) => ({ relativePath: path, fileId: `file-${path}` }),
      resolvePosition: createLineOffsetResolver(new Map()),
      limits: defaultProcessLimits(),
    });

    expect(httpRunner.calls[0]?.headers?.["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(result.run.exitStatus).toBe("completed");
    expect(result.measurements.map((m) => m.key)).toEqual(["cognitive_complexity"]);
  });

  it("laesst das Geheimnis nicht in die Fehlermeldung eines abgelehnten Endpunkts", async () => {
    const httpRunner = recordingHttp(`unauthorized for token ${TOKEN}`, 401);
    const extension = loaded();
    const result = await runExtension(deps(httpRunner), {
      extension,
      health: health(),
      gate: evaluateLicenseGate({ extension, acknowledgments: [] }),
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "ref-1",
      workspacePath: "/work/repo",
      httpHeaders: { Authorization: `Bearer ${TOKEN}` },
      secretValues: [TOKEN],
      resolveFile: (path: string) => ({ relativePath: path, fileId: `file-${path}` }),
      resolvePosition: createLineOffsetResolver(new Map()),
      limits: defaultProcessLimits(),
    });

    expect(result.run.exitStatus).not.toBe("completed");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
