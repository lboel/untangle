/**
 * Test scaffolding for the extension commands.
 *
 * Everything happens inside a temporary directory tree: a fake user profile
 * (extension root, acknowledgment file, CLI state) and a fake project
 * directory. Nothing is written into the real user profile or sent to a live
 * container runtime. HTTP uses injected `fetch`; process tests explicitly
 * supply their own temporary fixture executables.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock, Random } from "@untangle-code/domain";

import { BufferIo } from "../../cli/io.js";

import { createExtensionEnvironment, type ExtensionEnvironmentV1 } from "./environment.js";

/** A fixed clock; the runtime must never call the wall clock itself. */
export function fixedClock(startMs = 1_767_225_600_000): Clock {
  return {
    nowEpochMs: () => startMs,
    nowIso: () => new Date(startMs).toISOString(),
  };
}

/** Countable randomness, so run ids are reproducible in assertions. */
export function countingRandom(): Random {
  let counter = 0;
  return {
    nextFloat: () => 0.5,
    nextInt: (maxExclusive: number) => (maxExclusive === 0 ? 0 : 1 % maxExclusive),
    bytes: (length: number) => new Uint8Array(length),
    uuid: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
  };
}

export interface HarnessV1 {
  /** Fake user profile root. */
  home: string;
  /** Extension root inside the fake profile. */
  extensionsHome: string;
  /** A directory that counts as a project (it carries a `.git` marker). */
  project: string;
  env: Record<string, string | undefined>;
  environment: ExtensionEnvironmentV1;
  io: BufferIo;
}

/** Builds a fresh, isolated harness. */
export async function createHarness(): Promise<HarnessV1> {
  const base = await mkdtemp(join(tmpdir(), "untangle-cli-ext-"));
  const home = join(base, "home");
  const extensionsHome = join(home, ".untangle", "extensions");
  const project = join(base, "project");
  await mkdir(extensionsHome, { recursive: true });
  await mkdir(join(project, ".git"), { recursive: true });

  const env: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    UNTANGLE_EXTENSIONS_HOME: extensionsHome,
    // Unit tests must not depend on the host's Docker daemon or its latency.
    UNTANGLE_CONTAINER_CLI: join(home, "no-container-runtime"),
    PATH: process.env["PATH"] ?? "",
  };
  const environment = await createExtensionEnvironment({
    cwd: project,
    env,
    clock: fixedClock(),
    random: countingRandom(),
    homeDir: home,
    userName: "test-user",
  });
  return { home, extensionsHome, project, env, environment, io: new BufferIo() };
}

/** Writes a file below the harness, creating parent directories. */
export async function writeFixture(path: string, content: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

/**
 * A minimal manifest for a tool reachable over a loopback HTTP API.
 *
 * The tool name is a placeholder chosen here, in test data — exactly where a
 * tool name belongs. No production source file in this repository names a
 * third-party analyzer (E2).
 */
export function httpManifest(options: { id: string; port: number; restricted?: boolean }): string {
  const restricted = options.restricted ?? false;
  return `schemaVersion = 1
id = "${options.id}"
displayName = "Example HTTP Analyzer"
category = "sast"
invocation = ["http"]
languages = []
outputFormat = "generic-findings"
networkAccess = "loopback"
networkJustification = "the analyzer exposes its API on a loopback port only"
requiresLicenseAcknowledgment = ${String(restricted)}

[http]
defaultUrl = "http://127.0.0.1:${String(options.port)}"
analyzePath = "/analyze"
analyzeMethod = "GET"

[resources]
minMemoryMb = 128
recommendedMemoryMb = 256
recommendedCpus = 1

[license]
spdxId = "${restricted ? "LicenseRef-source-available-1.0" : "Apache-2.0"}"
usageRestriction = "${restricted ? "restricted" : "none"}"
${restricted ? 'restrictionSummary = "Analyzers may only be used under the vendor\'s source-available terms."\n' : ""}
[severityMapping]
mappingVersion = "untangle-severity-map-v1"
fallback = "medium"
caseInsensitive = true
rules = [
  { from = "error", to = "high" },
  { from = "warning", to = "medium" },
]

[telemetry]
sendsTelemetry = false
disabledByDefault = true
`;
}

/** A manifest whose container image is pinned to a moving tag — invalid (X6). */
export function movingTagManifest(id: string): string {
  return `schemaVersion = 1
id = "${id}"
displayName = "Moving Tag Analyzer"
category = "lint"
invocation = ["container"]
languages = []
outputFormat = "generic-findings"
networkAccess = "none"
requiresLicenseAcknowledgment = false

[container]
image = "registry.example.invalid/moving"
digest = "sha256:latest"

[container.workspaceMount]
mountPath = "/workspace"
readOnly = true

[container.healthcheck]
kind = "command"
command = ["true"]
intervalMs = 1000
timeoutMs = 500
retries = 3

[resources]
minMemoryMb = 128
recommendedMemoryMb = 256
recommendedCpus = 1

[license]
spdxId = "MIT"
usageRestriction = "none"

[severityMapping]
mappingVersion = "untangle-severity-map-v1"
fallback = "low"
caseInsensitive = true
rules = []

[telemetry]
sendsTelemetry = false
disabledByDefault = true
`;
}

/**
 * A manifest whose container image IS correctly pinned to a full sha256
 * digest — the counterpart to `movingTagManifest`, used to show that `status`
 * reports the pin it would enforce.
 */
export function containerManifest(options: { id: string; digest: string }): string {
  return `schemaVersion = 1
id = "${options.id}"
displayName = "Example Container Analyzer"
category = "quality-platform"
invocation = ["container"]
languages = []
outputFormat = "generic-findings"
networkAccess = "loopback"
networkJustification = "the analyzer exposes its API on a loopback port only"
requiresLicenseAcknowledgment = false

[container]
image = "registry.example.invalid/example-analyzer"
digest = "${options.digest}"
analyzeArgs = ["analyze", "{workspace}"]

[container.workspaceMount]
mountPath = "/workspace"
readOnly = true

[container.healthcheck]
kind = "command"
command = ["true"]
intervalMs = 1000
timeoutMs = 500
retries = 3

[resources]
minMemoryMb = 2048
recommendedMemoryMb = 4096
recommendedCpus = 4

[license]
spdxId = "Apache-2.0"
usageRestriction = "none"

[severityMapping]
mappingVersion = "untangle-severity-map-v1"
fallback = "info"
caseInsensitive = true
rules = [{ from = "error", to = "high" }]

[telemetry]
sendsTelemetry = false
disabledByDefault = true
`;
}

/** Builds a `fetch` stand-in that answers every request with one body. */
export function fakeFetch(status: number, body: string): typeof fetch {
  const impl = (): Promise<unknown> =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      url: "http://127.0.0.1:19999/analyze",
      body: null,
      text: () => Promise.resolve(body),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
    });
  return impl as unknown as typeof fetch;
}
