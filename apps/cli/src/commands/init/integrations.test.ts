import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseExtensionManifest,
  parseOutputFormat,
  type ProcessResultV1,
  type ProcessRunnerPort,
} from "@untangle-code/extension-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadIntegrationBinary,
  IntegrationSetupCancelledError,
  verifySelectedBinary,
} from "./integrations-apply.js";
import {
  applyIntegrationSetup,
  integrationCatalog,
  planIntegrationSetup,
  SONAR_IMAGE,
} from "./integrations.js";

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "untangle-init-integrations-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function processResult(stdout = "", exitCode = 0): ProcessResultV1 {
  return {
    outcome: "completed",
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    wallTimeMs: 1,
  };
}
function runner(
  stdout = "",
): ProcessRunnerPort & { run: ReturnType<typeof vi.fn<ProcessRunnerPort["run"]>> } {
  return { run: vi.fn<ProcessRunnerPort["run"]>().mockResolvedValue(processResult(stdout)) };
}

describe("explicit init integration planning", () => {
  it("offers local search, two Sonar modes, Sentrux and universal manifests without vendor runtime dependencies", () => {
    const offers = integrationCatalog();
    expect(offers.map((offer) => offer.id)).toEqual([
      "local-search",
      "sonarqube-local",
      "sonarqube-existing",
      "sentrux",
      "custom",
    ]);
    expect(offers.every((offer) => offer.documentation.startsWith("https://"))).toBe(true);
    expect(offers.find((offer) => offer.id === "sentrux")?.description).toContain(
      "not a normalized",
    );
  });

  it("creates a deterministic pinned loopback-only Sonar plan without executing or writing", () => {
    const options = {
      root: "/a project",
      selections: [
        { id: "sonarqube-local" as const, projectKey: "accounts", acknowledgeLicense: true },
      ],
    };
    const plan = planIntegrationSetup(options);
    expect(plan).toEqual(planIntegrationSetup(options));
    const text = plan.items[0]?.files.find((file) =>
      file.relativePath.endsWith("compose.yml"),
    )?.content;
    expect(text).toContain(SONAR_IMAGE);
    expect(text).toContain("127.0.0.1:19000:9000");
    expect(text).toContain("privileged: false");
    expect(text).not.toContain("workspace:");
    expect(plan.items[0]?.commands[1]?.args.slice(0, 2)).toEqual(["extensions", "add"]);
  });

  it("generates a valid generic metrics HTTP manifest and parses actual API-shaped data", () => {
    const plan = planIntegrationSetup({
      root: "/project",
      selections: [
        {
          id: "sonarqube-existing",
          endpoint: "https://quality.example.invalid",
          projectKey: "team:accounts",
          tokenEnvVar: "QUALITY_TOKEN",
          acknowledgeLicense: true,
        },
      ],
    });
    const text =
      plan.items[0]?.files.find((file) => file.relativePath.endsWith("manifest.toml"))?.content ??
      "";
    const parsed = parseExtensionManifest(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.manifest?.http?.analyzePath).toContain("team%3Aaccounts");
    expect(parsed.manifest?.requiresLicenseAcknowledgment).toBe(true);
    expect(parsed.manifest?.secrets[0]?.envVar).toBe("QUALITY_TOKEN");
    const output = parseOutputFormat(
      "generic-metrics",
      JSON.stringify({
        component: {
          measures: [
            { metric: "cognitive_complexity", value: "13" },
            { metric: "complexity", value: "8" },
          ],
        },
      }),
      { metricFields: parsed.manifest?.outputMapping ?? {} },
    );
    expect(output.measurements.map(({ key, value }) => [key, value])).toEqual([
      ["cognitive_complexity", 13],
      ["complexity", 8],
    ]);
    expect(output.issues).toEqual([]);
  });

  it.each([
    "https://user:password@example.invalid",
    "https://example.invalid?token=secret",
    "https://example.invalid#token",
    "file:///secret",
  ])("refuses credential-bearing or non-HTTP endpoints %s", (endpoint) => {
    expect(() =>
      planIntegrationSetup({ root: "/p", selections: [{ id: "sonarqube-existing", endpoint }] }),
    ).toThrow();
  });

  it("rejects raw token values, duplicate modes and unpinned remote manifests", () => {
    expect(() =>
      planIntegrationSetup({
        root: "/p",
        selections: [{ id: "sonarqube-existing", tokenEnvVar: "sqp_secret-value" }],
      }),
    ).toThrow(/NAME/u);
    expect(() =>
      planIntegrationSetup({
        root: "/p",
        selections: [{ id: "sonarqube-local" }, { id: "sonarqube-existing" }],
      }),
    ).toThrow(/one Sonar/u);
    expect(() =>
      planIntegrationSetup({
        root: "/p",
        selections: [{ id: "custom", manifestPath: "https://example.invalid/manifest.toml" }],
      }),
    ).toThrow(/digest/u);
  });

  it("keeps project-local trust and license acknowledgments explicit for custom imports", () => {
    const plan = planIntegrationSetup({
      root: "/p",
      selections: [{ id: "custom", manifestPath: "adapter.toml" }],
    });
    expect(plan.items[0]?.commands[0]?.args).toEqual([
      "extensions",
      "add",
      "--from=/p/adapter.toml",
    ]);
    expect(JSON.stringify(plan)).not.toContain("--allow-project-local");
    expect(JSON.stringify(plan)).not.toContain("--acknowledge-license");
  });

  it("marks unsupported binary platforms as unavailable and still offers official instructions", () => {
    const plan = planIntegrationSetup({
      root: "/p",
      platform: "darwin",
      arch: "x64",
      selections: [{ id: "sentrux" }],
    });
    expect(plan.items[0]?.downloads).toEqual([]);
    expect(plan.items[0]?.blockers[0]).toContain("darwin/x64");
  });
});

describe("safe integration setup application", () => {
  it("prepares offline artifacts idempotently and never probes, installs or starts a tool", async () => {
    const root = await project();
    const selected = [
      { id: "local-search" as const },
      { id: "sentrux" as const },
      { id: "custom" as const, manifestPath: "adapter.toml" },
    ];
    const plan = planIntegrationSetup({
      root,
      offline: true,
      selections: selected,
      platform: "darwin",
      arch: "arm64",
    });
    const process = runner();
    const fetchImpl = vi.fn<typeof fetch>();
    const extension = vi.fn();
    const first = await applyIntegrationSetup(plan, {
      execute: true,
      runner: process,
      fetchImpl,
      runExtensionCommand: extension,
    });
    const second = await applyIntegrationSetup(plan, {
      execute: true,
      runner: process,
      fetchImpl,
      runExtensionCommand: extension,
    });
    expect(first).toEqual(second);
    expect(first.items.map((item) => item.status)).toEqual(["prepared", "prepared", "prepared"]);
    expect(process.run).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(extension).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        await readFile(
          path.join(root, ".untangle/setup/integrations/local-search/connection.json"),
          "utf8",
        ),
      ).embeddings.url,
    ).toBe("http://127.0.0.1:11435");
  });

  it("preserves a pre-existing conflicting artifact and never starts the selected service", async () => {
    const root = await project();
    const target = path.join(root, ".untangle/setup/integrations/sonarqube-local/connection.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "user-owned\n");
    const process = runner();
    const report = await applyIntegrationSetup(
      planIntegrationSetup({
        root,
        selections: [{ id: "sonarqube-local", acknowledgeLicense: true }],
      }),
      { execute: true, runner: process },
    );
    expect(report.items[0]?.status).toBe("failed");
    expect(await readFile(target, "utf8")).toBe("user-owned\n");
    expect(process.run).not.toHaveBeenCalled();
  });

  it("rejects a metadata symlink without touching files outside the chosen project", async () => {
    const root = await project(),
      outside = await project();
    await writeFile(path.join(outside, "keep"), "unchanged");
    await symlink(outside, path.join(root, ".untangle"), "dir");
    await expect(
      applyIntegrationSetup(planIntegrationSetup({ root, selections: [{ id: "sentrux" }] })),
    ).rejects.toThrow(/symlink/u);
    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("unchanged");
  });

  it("holds the license gate before any Docker or extension action", async () => {
    const root = await project();
    const process = runner();
    const extension = vi.fn();
    const report = await applyIntegrationSetup(
      planIntegrationSetup({
        root,
        selections: [{ id: "sonarqube-local", projectKey: "accounts" }],
      }),
      { execute: true, runner: process, runExtensionCommand: extension },
    );
    expect(report.items[0]?.status).toBe("needs_configuration");
    expect(process.run).not.toHaveBeenCalled();
    expect(extension).not.toHaveBeenCalled();
  });

  it("refuses foreign Compose containers before up and preserves prepared artifact visibility", async () => {
    const root = await project();
    const process = runner();
    process.run
      .mockResolvedValueOnce(processResult("abcdef123456\n"))
      .mockResolvedValueOnce(processResult('{"com.docker.compose.project":"someone-else"}'));
    const report = await applyIntegrationSetup(
      planIntegrationSetup({
        root,
        selections: [{ id: "sonarqube-local", acknowledgeLicense: true }],
      }),
      { execute: true, runner: process },
    );
    expect(report.items[0]?.status).toBe("failed");
    expect(report.items[0]?.detail).toContain("ownership labels");
    expect(report.items[0]?.files.length).toBe(2);
    expect(process.run.mock.calls.every(([invocation]) => !invocation.args.includes("up"))).toBe(
      true,
    );
  });

  it("starts only the owned local-search plan then explicitly pulls the model", async () => {
    const root = await project();
    const process = runner();
    const report = await applyIntegrationSetup(
      planIntegrationSetup({ root, selections: [{ id: "local-search" }] }),
      { execute: true, runner: process },
    );
    expect(report.items[0]?.status).toBe("installed");
    expect(report.items[0]?.detail).toContain("No index");
    expect(process.run.mock.calls.map(([invocation]) => invocation.args[0])).toEqual([
      "ps",
      "compose",
      "compose",
    ]);
    expect(process.run.mock.calls[2]?.[0].args.slice(-3)).toEqual([
      "ollama",
      "pull",
      "nomic-embed-text",
    ]);
  });

  it.each(["timeout", "output_limit_exceeded"] as const)(
    "never accepts %s even when a child exits zero",
    async (outcome) => {
      const root = await project();
      const process = runner();
      process.run
        .mockResolvedValueOnce(processResult())
        .mockResolvedValueOnce({ ...processResult("", 0), outcome });
      const report = await applyIntegrationSetup(
        planIntegrationSetup({ root, selections: [{ id: "local-search" }] }),
        { execute: true, runner: process },
      );
      expect(report.items[0]?.status).toBe("failed");
      expect(process.run).toHaveBeenCalledTimes(2);
      expect(report.items[0]?.executed[1]?.outcome).toBe(outcome);
    },
  );

  it("does not persist token values or raw process exceptions and records unverified configuration honestly", async () => {
    const root = await project();
    const secret = "unit-private-token-never-save";
    const report = await applyIntegrationSetup(
      planIntegrationSetup({
        root,
        selections: [
          { id: "sonarqube-existing", projectKey: "accounts", acknowledgeLicense: true },
        ],
      }),
      {
        execute: true,
        env: { UNTANGLE_EXT_SONAR_TOKEN: secret },
        runExtensionCommand: async () => {
          throw new Error(secret);
        },
      },
    );
    expect(report.items[0]?.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(await readFile(report.reportPath, "utf8")).not.toContain(secret);
  });

  it("reports a real metrics read only after the existing runtime returns numeric measurements", async () => {
    const root = await project();
    const calls: string[][] = [];
    const report = await applyIntegrationSetup(
      planIntegrationSetup({
        root,
        selections: [
          { id: "sonarqube-existing", projectKey: "accounts", acknowledgeLicense: true },
        ],
      }),
      {
        execute: true,
        runExtensionCommand: (args) => {
          calls.push([...args]);
          return Promise.resolve({
            exitCode: 0,
            value: { measurements: args[0] === "run" ? [{ key: "complexity", value: 8 }] : [] },
          });
        },
      },
    );
    expect(calls.map((args) => args[0])).toEqual(["add", "enable", "run"]);
    expect(report.items[0]?.metricsRead).toBe(1);
    expect(report.items[0]?.status).toBe("installed");
    expect(report.items[0]?.detail).toContain("source freshness is not verified");
  });

  it("propagates cancellation without starting a later tool or writing a success report", async () => {
    const root = await project();
    const controller = new AbortController();
    const process = runner();
    process.run.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(processResult());
    });
    await expect(
      applyIntegrationSetup(planIntegrationSetup({ root, selections: [{ id: "local-search" }] }), {
        execute: true,
        runner: process,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(process.run).toHaveBeenCalledTimes(1);
  });
  it("preserves a cancelled partial receipt after a service command and never claims installation", async () => {
    const root = await project();
    const controller = new AbortController();
    const process = runner();
    process.run.mockResolvedValueOnce(processResult()).mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(processResult("private child output that must not be saved"));
    });
    let failure: unknown;
    try {
      await applyIntegrationSetup(
        planIntegrationSetup({ root, selections: [{ id: "local-search" }, { id: "sentrux" }] }),
        { execute: true, runner: process, signal: controller.signal },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(IntegrationSetupCancelledError);
    const reportPath = (failure as IntegrationSetupCancelledError).reportPath;
    expect(reportPath).toBeDefined();
    if (reportPath === undefined) throw new Error("Cancellation receipt missing");
    const raw = await readFile(reportPath, "utf8");
    const report = JSON.parse(raw);
    expect(report.cancelled).toBe(true);
    expect(report.items.map((item: { status: string }) => item.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(report.items[0].files).toHaveLength(2);
    expect(report.items[0].executed).toHaveLength(2);
    expect(report.items[0].executed[1].args).toContain("up");
    expect(raw).not.toContain("private child output");
    expect(process.run).toHaveBeenCalledTimes(2);
  });
});

describe("verified binary downloads", () => {
  const bytes = new TextEncoder().encode("known release bytes");
  const download = {
    url: "https://example.invalid/release",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    relativePath: ".untangle/tools/test",
    maxBytes: 1024,
  };
  it("accepts only the full expected SHA256", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    expect(await downloadIntegrationBinary(download, fetchImpl)).toEqual(Buffer.from(bytes));
    expect(fetchImpl.mock.calls[0]?.[1]?.credentials).toBe("omit");
    await expect(
      downloadIntegrationBinary(
        { ...download, sha256: "0".repeat(64) },
        vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)),
      ),
    ).rejects.toThrow(/SHA256/u);
  });
  it("refuses over-budget content before it can be installed", async () => {
    await expect(
      downloadIntegrationBinary(
        { ...download, maxBytes: 1 },
        vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)),
      ),
    ).rejects.toThrow(/byte limit/u);
  });
  it("rehashes an owned binary and refuses a changed file or symlink immediately before execution", async () => {
    const root = await project();
    const plan = planIntegrationSetup({
      root,
      platform: "darwin",
      arch: "arm64",
      selections: [{ id: "sentrux" }],
    });
    const original = plan.items[0];
    const binary = original?.downloads[0];
    const command = original?.commands[0];
    if (original === undefined || binary === undefined || command === undefined)
      throw new Error("Release plan missing");
    const item = { ...original, downloads: [{ ...binary, sha256: download.sha256 }] };
    await mkdir(path.dirname(command.command), { recursive: true });
    await writeFile(command.command, bytes);
    await expect(verifySelectedBinary(plan, item, command)).resolves.toBeUndefined();
    await writeFile(command.command, "changed after preflight");
    await expect(verifySelectedBinary(plan, item, command)).rejects.toThrow(
      /changed before execution/u,
    );
    await unlink(command.command);
    const other = path.join(root, "outside-binary");
    await writeFile(other, bytes);
    await symlink(other, command.command);
    await expect(verifySelectedBinary(plan, item, command)).rejects.toThrow(/not a regular file/u);
    expect(await readFile(other)).toEqual(Buffer.from(bytes));
  });
});
