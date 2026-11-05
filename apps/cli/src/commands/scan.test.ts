import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExternalMeasurementV1 } from "@untangle-code/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../cli/args.js";
import { EXIT, UsageError } from "../cli/exit.js";
import { BufferIo } from "../cli/io.js";

import { analyze } from "./complexity.js";
import { provisionContainer } from "./extensions/provision.js";
import { cliStatePath, saveCliState } from "./extensions/state.js";
import {
  containerManifest,
  createHarness,
  httpManifest,
  writeFixture,
  type HarnessV1,
} from "./extensions/test-support.js";
import { runScan, scanCommand } from "./scan.js";

vi.mock("./extensions/provision.js", () => ({ provisionContainer: vi.fn() }));
const PIN = `sha256:${"1".repeat(64)}`;
const fixtures: HarnessV1[] = [];

interface Report {
  root: string;
  ownMetrics: {
    totals: { executionUnits: number; cognitive: number; cyclomatic: number };
    skipped: { reason: string; detail: string }[];
  };
  externalSignals: {
    extensionId: string;
    evidenceOnly: boolean;
    measurements: ExternalMeasurementV1[];
    skipped: { reason: string; detail: string }[];
    run: {
      exitStatus: string;
      findingsTotal: number;
      errorCode?: string;
      ruleset?: string;
      errors: { code: string; message: string }[];
    };
  }[];
  notMeasured: { extensionId: string; reason: string; detail: string; nextStep?: string }[];
}

async function harness(): Promise<HarnessV1> {
  const h = await createHarness();
  fixtures.push(h);
  await writeFixture(
    join(h.project, "main.ts"),
    "export function f(x: boolean) { if (x) return 1; return 0; }\n",
  );
  return h;
}

async function install(h: HarnessV1, id: string, manifest: string, enabled = true): Promise<void> {
  await writeFixture(join(h.extensionsHome, id, "manifest.toml"), manifest);
  if (enabled) {
    const statePath = cliStatePath(h.environment.userDataDir);
    let enabledIds: string[] = [];
    try {
      enabledIds = (JSON.parse(await readFile(statePath, "utf8")) as { enabled: string[] }).enabled;
    } catch {
      /* first install */
    }
    await saveCliState(h.environment.fs, h.environment.userDataDir, {
      schemaVersion: 1,
      enabled: [...enabledIds, id],
      lastRuns: {},
    });
  }
}

function containerHttp(id: string): string {
  return (
    containerManifest({ id, digest: PIN }).replace(
      'invocation = ["container"]',
      'invocation = ["http"]',
    ) +
    '\n[http]\ndefaultUrl = "http://127.0.0.1:19999"\nanalyzePath = "/analyze"\nanalyzeMethod = "GET"\n'
  );
}

function context(h: HarnessV1, signal = new AbortController().signal) {
  return { cwd: h.project, env: h.env, io: h.io, signal };
}

async function scan(h: HarnessV1, fetchImpl: typeof fetch, argv: string[] = []): Promise<Report> {
  expect(
    await runScan(context(h), parseArgs(["--format=json", ...argv], scanCommand.spec.flags), {
      fetchImpl,
    }),
  ).toBe(EXIT.ok);
  return JSON.parse(h.io.outText) as Report;
}

beforeEach(() => {
  vi.mocked(provisionContainer).mockReset();
});
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((h) => rm(dirname(h.home), { recursive: true, force: true })),
  );
});

describe("scan", () => {
  it("composes own analysis and keeps an empty profile offline", async () => {
    const h = await harness();
    await writeFixture(join(h.project, "settings.toml"), "enabled = true\n");
    const fetchImpl = vi.fn<typeof fetch>();
    const expected = await analyze(h.project, new AbortController().signal);
    const report = await scan(h, fetchImpl);
    expect(report.ownMetrics.totals).toEqual(expected.totals);
    expect(report.ownMetrics.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "no_metric_defined", detail: expect.any(String) }),
      ]),
    );
    expect(report.externalSignals).toEqual([]);
    expect(report.notMeasured).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provisionContainer).not.toHaveBeenCalled();
  });

  it("continues past rejected, missing, disabled, gated and unavailable extensions", async () => {
    const h = await harness();
    await install(h, "a-rejected", "schemaVersion = 999\n");
    await install(h, "b-disabled", httpManifest({ id: "b-disabled", port: 19001 }), false);
    await install(h, "c-gated", httpManifest({ id: "c-gated", port: 19002, restricted: true }));
    await install(h, "d-container", containerHttp("d-container"));
    await install(
      h,
      "e-secret",
      httpManifest({ id: "e-secret", port: 19003 }) +
        '\n[[secrets]]\nname = "token"\nenvVar = "MISSING_TOKEN"\nrequired = true\npurpose = "API access"\n',
    );
    await install(h, "f-unavailable", httpManifest({ id: "f-unavailable", port: 19004 }));
    await install(h, "z-working", httpManifest({ id: "z-working", port: 19005 }));
    const statePath = cliStatePath(h.environment.userDataDir);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: 1;
      enabled: string[];
      lastRuns: Record<string, never>;
    };
    state.enabled.push("gone");
    await saveCliState(h.environment.fs, h.environment.userDataDir, state);
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes(":19004")) throw new Error("offline");
      return new Response('{"findings": []}', { status: 200 });
    });
    const report = await scan(h, fetchImpl);
    expect(
      Object.fromEntries(report.notMeasured.map((entry) => [entry.extensionId, entry.reason])),
    ).toEqual({
      "a-rejected": "manifest_rejected",
      "b-disabled": "not_enabled",
      "c-gated": "license_gate_open",
      "d-container": "consent_withheld",
      "e-secret": "secret_missing",
      "f-unavailable": "run_failed",
      gone: "extension_missing",
    });
    expect(report.notMeasured.every((entry) => entry.detail.length > 0 && entry.nextStep)).toBe(
      true,
    );
    expect(
      report.externalSignals.find((entry) => entry.extensionId === "z-working")?.run.exitStatus,
    ).toBe("completed");
    expect(fetchImpl.mock.calls.every(([url]) => /:1900[45]/u.test(String(url)))).toBe(true);
    expect(provisionContainer).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(statePath, "utf8")) as {
      lastRuns: Record<string, { exitStatus: string }>;
    };
    expect(saved.lastRuns["z-working"]?.exitStatus).toBe("completed");
    expect(saved.lastRuns["f-unavailable"]?.exitStatus).not.toBe("completed");
  });

  it("preserves external values, provenance and parser skips separately from own totals", async () => {
    const h = await harness();
    const manifest =
      httpManifest({ id: "metrics", port: 19001 }).replace(
        'outputFormat = "generic-findings"',
        'outputFormat = "generic-metrics"',
      ) +
      '\n[[complexitySignals]]\nkey = "cognitive"\nkind = "cognitive"\nscope = "repository"\ncomparableTo = "untangle-metrics-v1"\n';
    await install(h, "metrics", manifest);
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            metrics: [
              { key: "cognitive", value: 987654 },
              { key: "bad", value: "invalid" },
            ],
          }),
          { status: 200 },
        ),
    );
    const report = await scan(h, fetchImpl);
    expect(report.ownMetrics.totals.cognitive).toBe(1);
    const external = report.externalSignals[0];
    expect(external?.evidenceOnly).toBe(true);
    expect(external?.measurements[0]).toMatchObject({
      evidenceOnly: true,
      key: "cognitive",
      signal: { kind: "cognitive", scope: "repository" },
      provenance: { extensionId: "metrics" },
    });
    expect(external?.run.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "OUTPUT_ENTRY_SKIPPED" })]),
    );
    expect(report.notMeasured).toEqual([]);
    h.io = new BufferIo();
    await runScan(context(h), parseArgs([], scanCommand.spec.flags), { fetchImpl });
    const ownBlock = h.io.outText.split("# External signals")[0];
    expect(ownBlock).not.toContain("987654");
    expect(h.io.outText).toContain("987654");
    expect(h.io.errText).toContain("metrics:");
  });

  it("discloses each container's cost before scan-wide provisioning and keeps the licence gate closed", async () => {
    const h = await harness();
    for (const id of ["a-one", "b-two", "c-gated"]) {
      let manifest = containerHttp(id);
      if (id === "c-gated")
        manifest = manifest.replace(
          "requiresLicenseAcknowledgment = false",
          "requiresLicenseAcknowledgment = true",
        );
      await install(h, id, manifest);
    }
    vi.mocked(provisionContainer).mockImplementation(async (_deps, input) => {
      expect(h.io.errText).toContain(
        `Provisioning: ${input.manifest.id}: memory at least ${input.manifest.resources.minMemoryMb} MB`,
      );
      expect(h.io.errText).toContain(PIN);
      expect(input.workspacePath).toBe(h.environment.cwd);
      return {
        healthy: true,
        steps: [],
        detail: "ready",
        state: {
          exists: true,
          running: true,
          ownedByUntangle: true,
          detail: "ready",
          imageDigest: PIN,
        },
      };
    });
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{"findings": []}', { status: 200 }),
    );
    const report = await scan(h, fetchImpl, ["--yes"]);
    expect(provisionContainer).toHaveBeenCalledTimes(2);
    expect(report.externalSignals.map((entry) => entry.run.exitStatus)).toEqual([
      "completed",
      "completed",
    ]);
    expect(report.notMeasured).toEqual([
      expect.objectContaining({ extensionId: "c-gated", reason: "license_gate_open" }),
    ]);
  });

  it.each(["none", "restricted"] as const)(
    "uses and checks the default ruleset (%s)",
    async (restriction) => {
      const h = await harness();
      const manifest =
        httpManifest({ id: "rules", port: 19001 }).replace(
          "languages = []",
          'languages = []\ndefaultRuleset = "rules/default"',
        ) +
        `
[[rulesetSources]]
ruleset = "rules/default"
source = "bundled"
license = "Apache-2.0"
usageRestriction = "${restriction}"
${restriction === "restricted" ? 'restrictionSummary = "Separate terms"' : ""}
`;
      await install(h, "rules", manifest);
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"findings": []}'));
      const report = await scan(h, fetchImpl);
      if (restriction === "restricted") {
        expect(report.notMeasured[0]?.reason).toBe("license_gate_open");
        expect(fetchImpl).not.toHaveBeenCalled();
      } else {
        expect(report.externalSignals[0]?.run.ruleset).toBe("rules/default");
        expect(report.notMeasured).toEqual([]);
      }
    },
  );

  it("records a provisioning exception, redacts secrets, and runs the next extension", async () => {
    const h = await harness();
    h.env["SCAN_TOKEN"] = "private-test-token";
    await install(
      h,
      "a-broken",
      containerHttp("a-broken") +
        '\n[[secrets]]\nname = "token"\nenvVar = "SCAN_TOKEN"\nrequired = true\npurpose = "API access"\n',
    );
    await install(h, "z-working", httpManifest({ id: "z-working", port: 19001 }));
    vi.mocked(provisionContainer).mockRejectedValue(new Error("write failed private-test-token"));
    const report = await scan(h, async () => new Response('{"findings": []}'), ["--yes"]);
    expect(report.notMeasured[0]).toMatchObject({
      extensionId: "a-broken",
      reason: "invocation_failed",
    });
    expect(h.io.outText + h.io.errText).not.toContain("private-test-token");
    expect(report.externalSignals[0]?.extensionId).toBe("z-working");
  });

  it("rejects a digest mismatch before requesting analyzer output", async () => {
    const h = await harness();
    await install(h, "mismatch", containerHttp("mismatch"));
    vi.mocked(provisionContainer).mockResolvedValue({
      healthy: true,
      steps: [],
      detail: "ready",
      state: {
        exists: true,
        running: true,
        ownedByUntangle: true,
        detail: "ready",
        imageDigest: `sha256:${"2".repeat(64)}`,
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"findings": []}'));
    const report = await scan(h, fetchImpl, ["--yes"]);
    expect(report.externalSignals[0]?.run.errorCode).toBe("EXTENSION_IMAGE_MISMATCH");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/analyze"))).toBe(false);
  });

  it("protects --root as the project boundary even when invoked elsewhere", async () => {
    const h = await harness();
    const localRoot = join(h.project, "tools");
    await writeFixture(
      join(localRoot, "local", "manifest.toml"),
      httpManifest({ id: "local", port: 19001 }),
    );
    h.env["UNTANGLE_EXTENSIONS_HOME"] = localRoot;
    const fetchImpl = vi.fn<typeof fetch>();
    await runScan(
      { ...context(h), cwd: h.home },
      parseArgs([`--root=${h.project}`, "--format=json"], scanCommand.spec.flags),
      { fetchImpl },
    );
    const report = JSON.parse(h.io.outText) as Report;
    expect(report.notMeasured.some((entry) => entry.reason === "manifest_ignored")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates cancellation without reporting success or running later extensions", async () => {
    const h = await harness();
    await install(h, "a-first", httpManifest({ id: "a-first", port: 19001 }));
    await install(h, "z-later", httpManifest({ id: "z-later", port: 19002 }));
    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      runScan(context(h, controller.signal), parseArgs([], scanCommand.spec.flags), { fetchImpl }),
    ).rejects.toBe(reason);
    expect(h.io.outText).toBe("");
    expect(fetchImpl.mock.calls.every(([url]) => String(url).includes(":19001"))).toBe(true);
  });

  it.each([{ argv: ["--format=yaml"] }, { argv: ["unexpected-path"] }])(
    "validates argv before doing any analysis: %j",
    async ({ argv }) => {
      const h = await harness();
      await expect(
        runScan(context(h), parseArgs(argv, scanCommand.spec.flags)),
      ).rejects.toBeInstanceOf(UsageError);
      expect(h.io.outText).toBe("");
    },
  );
});
