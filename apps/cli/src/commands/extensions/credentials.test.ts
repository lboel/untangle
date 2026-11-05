import { chmod, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseExtensionManifest, type ProcessResultV1 } from "@untangle-code/extension-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../../cli/args.js";
import { extensionsCommand } from "../extensions.js";

import { runConfigure } from "./configure.js";
import { loadExtensionContext } from "./context.js";
import { invokeExtension } from "./invoke.js";
import { runLogs } from "./logs.js";
import type * as ProvisionModule from "./provision.js";
import { provisionContainer, type ProvisionResultV1 } from "./provision.js";
import {
  readStoredSecrets,
  resolveSecretEnvironment,
  secretEnvironment,
  secretStorePath,
  withSecretLock,
  writeStoredSecrets,
} from "./secret-store.js";
import { setupCredentials } from "./setup.js";
import { runStatus } from "./status.js";
import { createHarness, containerManifest, writeFixture, type HarnessV1 } from "./test-support.js";

vi.mock("./provision.js", async (original) => ({
  ...(await original<typeof ProvisionModule>()),
  provisionContainer: vi.fn(),
}));
const PIN = `sha256:${"1".repeat(64)}`;
const all: HarnessV1[] = [];
const ready: ProvisionResultV1 = {
  healthy: true,
  steps: [],
  detail: "ready",
  state: { exists: true, running: true, ownedByUntangle: true, imageDigest: PIN, detail: "ready" },
};
const limits = { timeoutMs: 1000, maxOutputBytes: 1024 };

function manifestText(): string {
  return (
    containerManifest({ id: "credentials", digest: PIN }).replace(
      'invocation = ["container"]',
      'invocation = ["http"]',
    ) +
    `
[[container.ports]]
name = "http"
containerPort = 9000
hostPortDefault = 19999
[http]
defaultUrl = "http://127.0.0.1:19999"
analyzePath = "/analyze"
authSecretName = "api-token"
[setup]
command = "node"
args = ["setup.mjs"]
[[secrets]]
name = "api-token"
envVar = "PROBE_TOKEN"
required = true
purpose = "API access"
[[secrets]]
name = "admin-password"
envVar = "PROBE_ADMIN_PASSWORD"
required = false
setupOnly = true
purpose = "Setup only"
`
  );
}

async function harness() {
  const h = await createHarness();
  all.push(h);
  await writeFixture(join(h.extensionsHome, "credentials", "manifest.toml"), manifestText());
  const context = await loadExtensionContext(h.environment);
  const extension = context.discovery.extensions[0];
  if (!extension) throw new Error(JSON.stringify(context.discovery.rejected));
  return { h, context, extension, manifest: extension.manifest };
}
function output(body: unknown): ProcessResultV1 {
  const stdout = JSON.stringify(body);
  return {
    outcome: "completed",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    wallTimeMs: 1,
  };
}
afterEach(async () => {
  vi.mocked(provisionContainer).mockReset();
  await Promise.all(
    all.splice(0).map((h) => rm(dirname(h.home), { recursive: true, force: true })),
  );
});

describe("private extension credentials", () => {
  it("creates a private config template and imports values without printing them", async () => {
    const { h, manifest } = await harness();
    const args = (values: string[]) => parseArgs(values, extensionsCommand.spec.flags);
    await runConfigure(h.environment, args(["configure", "credentials"]), h.io, "text");
    const path = secretStorePath(h.environment, manifest.id);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const source = await writeFixture(
      join(h.home, "private.json"),
      JSON.stringify({ "api-token": "private-token", "admin-password": "private-password" }),
    );
    await runConfigure(
      h.environment,
      args(["configure", "credentials", `--from=${source}`]),
      h.io,
      "json",
    );
    expect(h.io.outText + h.io.errText).not.toContain("private-token");
    expect(h.io.outText + h.io.errText).not.toContain("private-password");
    const stored = await readStoredSecrets(h.environment, manifest);
    expect(stored["api-token"]).toBe("private-token");
    h.env["PROBE_TOKEN"] = "environment-token";
    expect(secretEnvironment(h.environment, manifest, stored)["PROBE_TOKEN"]).toBe(
      "environment-token",
    );
  });

  it("refuses to send stored credentials to another endpoint", async () => {
    const { h, manifest } = await harness();
    await writeStoredSecrets(h.environment, manifest, { "api-token": "private-token" });
    await expect(
      readStoredSecrets(h.environment, manifest, "http://127.0.0.1:20000"),
    ).rejects.toThrow("different endpoint");
    h.env["PROBE_TOKEN"] = "explicit-override";
    const resolved = await resolveSecretEnvironment(
      h.environment,
      manifest,
      "http://127.0.0.1:20000",
    );
    expect(resolved["PROBE_TOKEN"]).toBe("explicit-override");
    expect(resolved["PROBE_ADMIN_PASSWORD"]).toBeUndefined();
  });

  it("refuses permissive files, symlinks and project-local credential stores", async () => {
    const { h, manifest } = await harness();
    await writeStoredSecrets(h.environment, manifest, { "api-token": "private-token" });
    const path = secretStorePath(h.environment, manifest.id);
    await chmod(path, 0o644);
    await expect(readStoredSecrets(h.environment, manifest)).rejects.toThrow("0600");
    await rm(path);
    await symlink(join(h.home, "elsewhere"), path);
    await expect(readStoredSecrets(h.environment, manifest)).rejects.toThrow("safely open");
    await expect(
      writeStoredSecrets({ ...h.environment, userDataDir: h.project }, manifest, {}),
    ).rejects.toThrow("outside project");
  });

  it("withholds malformed credential contents from errors", async () => {
    const { h, manifest } = await harness();
    await writeStoredSecrets(h.environment, manifest, {});
    await writeFile(secretStorePath(h.environment, manifest.id), "{ private-token", {
      mode: 0o600,
    });
    await expect(readStoredSecrets(h.environment, manifest)).rejects.toThrow("Invalid JSON");
    try {
      await readStoredSecrets(h.environment, manifest);
    } catch (error) {
      expect(String(error)).not.toContain("private-token");
    }
  });

  it.each(["text", "json"] as const)(
    "redacts stored and overridden credentials from %s logs",
    async (format) => {
      const { h, manifest } = await harness();
      await writeStoredSecrets(h.environment, manifest, {
        "api-token": "stored-private",
        "admin-password": "bootstrap-private",
      });
      h.env["PROBE_TOKEN"] = "override-private";
      const script = await writeFixture(
        join(h.home, "container-cli"),
        `#!${process.execPath}
if (process.argv[2] === "inspect") {
  console.log("true\\tcredentials\\ttrue\\tregistry.example.invalid/probe@${PIN}");
} else {
  console.log("stored-private bootstrap-private override-private");
}
`,
      );
      await chmod(script, 0o700);
      h.env["UNTANGLE_CONTAINER_CLI"] = script;
      await runLogs(
        h.environment,
        parseArgs(["logs", "credentials"], extensionsCommand.spec.flags),
        h.io,
        format,
      );
      expect(h.io.outText).toContain("*** *** ***");
      expect(h.io.outText + h.io.errText).not.toMatch(
        /stored-private|bootstrap-private|override-private/u,
      );
    },
  );
});

describe("credential setup", () => {
  it("issues once, persists, and reuses credentials on subsequent runs", async () => {
    const { h, manifest } = await harness();
    const processRunner = {
      run: vi.fn(async () =>
        output({ schemaVersion: 1, secrets: { "api-token": "issued-token" } }),
      ),
    };
    const input = {
      environment: h.environment,
      manifest,
      provision: ready,
      consent: true,
      processRunner,
      limits,
    };
    const first = await setupCredentials(input);
    const second = await setupCredentials(input);
    expect(first["PROBE_TOKEN"]).toBe("issued-token");
    expect(second["PROBE_TOKEN"]).toBe("issued-token");
    expect(processRunner.run).toHaveBeenCalledTimes(1);
    expect((await readStoredSecrets(h.environment, manifest))["api-token"]).toBe("issued-token");
  });

  it.each(["consent", "owner", "digest", "endpoint"] as const)(
    "checks %s before the setup process",
    async (condition) => {
      const { h, manifest } = await harness();
      const processRunner = { run: vi.fn() };
      await expect(
        setupCredentials({
          environment: h.environment,
          manifest,
          consent: condition !== "consent",
          provision: {
            ...ready,
            state: {
              ...ready.state,
              ownedByUntangle: condition !== "owner",
              imageDigest: condition === "digest" ? `sha256:${"2".repeat(64)}` : PIN,
            },
          },
          processRunner,
          limits,
          ...(condition === "endpoint" ? { url: "http://127.0.0.1:20000" } : {}),
        }),
      ).rejects.toThrow();
      expect(processRunner.run).not.toHaveBeenCalled();
    },
  );

  it("keeps provider stdout/stderr out of failures and stores nothing on invalid output", async () => {
    const { h, manifest } = await harness();
    const processRunner = {
      run: vi.fn(async () => ({
        ...output({ token: "private-token" }),
        exitCode: 10,
        stderr: "private-password",
      })),
    };
    try {
      await setupCredentials({
        environment: h.environment,
        manifest,
        provision: ready,
        consent: true,
        processRunner,
        limits,
      });
    } catch (error) {
      expect(String(error)).toContain("exit 10");
      expect(String(error)).not.toMatch(/private-token|private-password/u);
    }
    expect(await readStoredSecrets(h.environment, manifest)).toEqual({});
  });

  it("prevents concurrent setup from issuing a second token", async () => {
    const { h, manifest } = await harness();
    const processRunner = { run: vi.fn() };
    await withSecretLock(h.environment, manifest.id, async () => {
      await expect(
        setupCredentials({
          environment: h.environment,
          manifest,
          provision: ready,
          consent: true,
          processRunner,
          limits,
        }),
      ).rejects.toThrow("already locked");
    });
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it("uses stored tokens in the shared run path without exposing setup-only credentials", async () => {
    const { h, manifest, extension, context } = await harness();
    await writeStoredSecrets(h.environment, manifest, {
      "api-token": "stored-token",
      "admin-password": "admin-private",
    });
    vi.mocked(provisionContainer).mockResolvedValue(ready);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      expect(JSON.stringify(options)).toContain("stored-token");
      expect(JSON.stringify(options)).not.toContain("admin-private");
      return new Response('{"findings": []}');
    });
    const result = await invokeExtension({
      environment: h.environment,
      context,
      extension,
      workspacePath: h.project,
      target: h.project,
      provisionConsent: true,
      limits,
      fetchImpl,
      resolveFile: () => ({ status: "outside-workspace", reason: "not used" }) as never,
      resolvePosition: () => null,
    });
    expect(result.status).toBe("ran");
    expect(JSON.stringify(result)).not.toContain("stored-token");
    expect(JSON.stringify(result)).not.toContain("admin-private");
  });

  it("gates automatic setup, runs its process once, then uses the saved token", async () => {
    const { h, manifest, extension, context } = await harness();
    const marker = join(h.home, "setup-calls");
    const script = await writeFixture(
      join(h.home, "setup.mjs"),
      `import { appendFileSync } from "node:fs";
if (process.env.PROBE_ADMIN_PASSWORD !== "bootstrap-private") process.exit(7);
if (process.env.UNTANGLE_SETUP_URL !== "http://127.0.0.1:19999") process.exit(8);
appendFileSync(${JSON.stringify(marker)}, "called\\n");
process.stdout.write(JSON.stringify({schemaVersion:1,secrets:{"api-token":"generated-private"}}));
`,
    );
    manifest.setup = { command: process.execPath, args: [script] };
    await writeStoredSecrets(h.environment, manifest, { "admin-password": "bootstrap-private" });
    vi.mocked(provisionContainer).mockResolvedValue(ready);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      expect(JSON.stringify(options)).toContain("generated-private");
      expect(JSON.stringify(options)).not.toContain("bootstrap-private");
      return new Response('{"findings": []}');
    });
    const input = {
      environment: h.environment,
      context,
      extension,
      workspacePath: h.project,
      target: h.project,
      provisionConsent: true,
      limits: { ...limits, timeoutMs: 10_000 },
      fetchImpl,
      resolveFile: () => ({ status: "outside-workspace", reason: "not used" }) as never,
      resolvePosition: () => null,
    };
    manifest.requiresLicenseAcknowledgment = true;
    expect(await invokeExtension(input)).toMatchObject({ reason: "license_gate_open" });
    manifest.requiresLicenseAcknowledgment = false;
    expect(await invokeExtension({ ...input, provisionConsent: false })).toMatchObject({
      reason: "consent_withheld",
    });
    expect(provisionContainer).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const first = await invokeExtension(input);
    const second = await invokeExtension(input);
    expect(first.status).toBe("ran");
    expect(second.status).toBe("ran");
    expect(await readFile(marker, "utf8")).toBe("called\n");
    expect(JSON.stringify([first, second])).not.toMatch(/generated-private|bootstrap-private/u);
  });

  it("status authenticates from private config without issuing or rewriting credentials", async () => {
    const { h, manifest } = await harness();
    h.env["UNTANGLE_CONTAINER_CLI"] = "__untangle_no_container_runtime__";
    await writeStoredSecrets(h.environment, manifest, { "api-token": "status-private" });
    const before = await stat(secretStorePath(h.environment, manifest.id));
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      expect(JSON.stringify(options)).toContain("status-private");
      return new Response("{}");
    });
    await runStatus(
      h.environment,
      parseArgs(["status", "credentials"], extensionsCommand.spec.flags),
      h.io,
      "json",
      { fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalled();
    expect(h.io.outText + h.io.errText).not.toContain("status-private");
    expect(provisionContainer).not.toHaveBeenCalled();
    expect((await stat(secretStorePath(h.environment, manifest.id))).mtimeMs).toBe(before.mtimeMs);
  });

  it("preserves setupOnly and validates the setup command and authentication contract", () => {
    expect(parseExtensionManifest(manifestText()).manifest?.secrets[1]?.setupOnly).toBe(true);
    const parsed = parseExtensionManifest(
      manifestText().replace('[setup]\ncommand = "node"', '[setup]\ncommand = "node; bad"'),
    );
    expect(parsed.manifest).toBeNull();
    expect(parsed.issues.some((issue) => issue.field === "setup.command")).toBe(true);
    const auth = parseExtensionManifest(
      manifestText().replace('authSecretName = "api-token"', 'authSecretName = "admin-password"'),
    );
    expect(auth.manifest).toBeNull();
    const noService = parseExtensionManifest(
      manifestText().replace(/\[container\][\s\S]*?(?=\[resources\])/u, ""),
    );
    expect(noService.manifest).toBeNull();
  });
});
