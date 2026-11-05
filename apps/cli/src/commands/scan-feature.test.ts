import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { analyzeProductAlignment } from "@untangle-code/core";
import type { ExternalMeasurementV1, ProductFeatureManifestV1 } from "@untangle-code/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../cli/args.js";
import { EXIT, UsageError } from "../cli/exit.js";

import type { ScanFeatureContext } from "./extensions/feature-scan.js";
import { cliStatePath, saveCliState } from "./extensions/state.js";
import {
  createHarness,
  httpManifest,
  writeFixture,
  type HarnessV1,
} from "./extensions/test-support.js";
import { runScan, scanCommand } from "./scan.js";

const fixtures: HarnessV1[] = [];
const MANIFEST: ProductFeatureManifestV1 = {
  schemaVersion: 1,
  owners: [
    {
      id: "team.checkout",
      label: "Checkout maintainers",
      kind: "role",
      status: "declared",
      sources: [{ path: "vision.md", heading: "Ownership" }],
    },
  ],
  features: [
    {
      id: "checkout",
      title: "Complete a checkout",
      stage: "implemented",
      review: "proposed",
      owners: ["team.checkout"],
      intent: [{ role: "vision", path: "vision.md", heading: "Checkout" }],
      code: { include: ["src/checkout.ts"] },
      tests: { include: ["src/checkout.test.ts"] },
      criteria: [
        {
          id: "reject-invalid",
          description: "Reject invalid orders",
          tests: ["src/checkout.test.ts"],
        },
      ],
      dependsOn: [],
    },
  ],
};

interface Report {
  ownMetrics: { totals: { cognitive: number } };
  externalSignals: {
    extensionId: string;
    measurements: ExternalMeasurementV1[];
    run: { exitStatus: string; outputHash?: string; toolVersion: string };
    skipped: unknown[];
  }[];
  notMeasured: { reason: string }[];
  featureAlignment?: ScanFeatureContext;
}

async function project(
  options: { manifest?: boolean; unsupported?: boolean } = {},
): Promise<HarnessV1> {
  const h = await createHarness();
  fixtures.push(h);
  await writeFixture(
    join(h.project, "src/checkout.ts"),
    "function validate(ok: boolean) { if (ok) return 1; return 0; }\nexport function checkout(ok: boolean) { return validate(ok); }\n",
  );
  await writeFixture(
    join(h.project, "src/checkout.test.ts"),
    "export const cases = ['reject invalid order'];\n",
  );
  await writeFixture(join(h.project, "src/other.ts"), "export const other = 2;\n");
  await writeFixture(
    join(h.project, "vision.md"),
    "# Checkout\nComplete a valid order.\n# Ownership\nCheckout maintainers.\n",
  );
  if (options.unsupported) await writeFixture(join(h.project, "src/unknown.odd"), "opaque format");
  if (options.manifest !== false) {
    const manifest = structuredClone(MANIFEST);
    if (options.unsupported) manifest.features[0]!.code.include.push("src/unknown.odd");
    await writeFixture(join(h.project, "untangle.features.json"), JSON.stringify(manifest));
  }
  return h;
}

async function install(h: HarnessV1, id: string, suffix: string, enabled = true): Promise<void> {
  await writeFixture(
    join(h.extensionsHome, id, "manifest.toml"),
    httpManifest({ id, port: 19999 }).replace(
      'outputFormat = "generic-findings"',
      'outputFormat = "generic-metrics"',
    ) + suffix,
  );
  let prior: string[] = [];
  try {
    prior = (
      JSON.parse(await readFile(cliStatePath(h.environment.userDataDir), "utf8")) as {
        enabled: string[];
      }
    ).enabled;
  } catch {
    /* first extension */
  }
  await saveCliState(h.environment.fs, h.environment.userDataDir, {
    schemaVersion: 1,
    enabled: enabled ? [...prior, id] : prior,
    lastRuns: {},
  });
}

async function scan(
  h: HarnessV1,
  fetchImpl: typeof fetch,
  flags = ["--feature=checkout"],
): Promise<Report> {
  expect(
    await runScan(
      { cwd: h.project, env: h.env, io: h.io, signal: new AbortController().signal },
      parseArgs(["--format=json", ...flags], scanCommand.spec.flags),
      { fetchImpl },
    ),
  ).toBe(EXIT.ok);
  return JSON.parse(h.io.outText) as Report;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((h) => rm(dirname(h.home), { recursive: true, force: true })),
  );
});

describe("scan declared feature workflow", () => {
  it("keeps the default output contract and does not inspect product declarations without the flag", async () => {
    const h = await project();
    const analyzeProduct = vi.fn<typeof analyzeProductAlignment>();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await runScan(
        { cwd: h.project, env: h.env, io: h.io, signal: new AbortController().signal },
        parseArgs(["--format=json"], scanCommand.spec.flags),
        { fetchImpl, analyzeProduct },
      ),
    ).toBe(EXIT.ok);
    expect(Object.keys(JSON.parse(h.io.outText) as Report)).toEqual([
      "command",
      "root",
      "ownMetrics",
      "externalSignals",
      "notMeasured",
      "warnings",
    ]);
    expect(analyzeProduct).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shows complete own feature metrics, declared responsibility and missing tests without requiring services", async () => {
    const h = await project();
    const fetchImpl = vi.fn<typeof fetch>();
    const report = await scan(h, fetchImpl);
    const feature = report.featureAlignment!;
    expect(feature.sourceBinding.status).toBe("unchanged");
    expect(feature.sourceBinding.beforeDigest).toBe(feature.sourceBinding.afterDigest);
    expect(feature.report.features[0]).toMatchObject({
      id: "checkout",
      review: "proposed",
      code: {
        complete: true,
        metrics: { cognitive: { execution_unit: 1, self: 1, top_level: 2 } },
      },
      ownership: [{ id: "team.checkout", status: "declared" }],
      testEvidence: { status: "not_run" },
      criteria: [{ status: "not_run" }],
    });
    expect(feature.report.semanticConformance).toBe("not_independently_proven");
    expect(feature.externalEvidence).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes feature scope, source status and missing external evidence visible in text output", async () => {
    const h = await project();
    await runScan(
      { cwd: h.project, env: h.env, io: h.io, signal: new AbortController().signal },
      parseArgs(["--feature=checkout"], scanCommand.spec.flags),
    );
    expect(h.io.outText).toContain("checkout — Complete a checkout");
    expect(h.io.outText).toContain("team.checkout:declared");
    expect(h.io.outText).toContain("Local source binding: unchanged");
    expect(h.io.outText).toContain("External feature evidence: not measured");
    expect(h.io.outText).toContain("Test evidence: not_run");
  });

  it("keeps flat repository quality signals separate from feature measurements and preserves provenance", async () => {
    const h = await project();
    await install(
      h,
      "structural",
      '\n[outputMapping]\nshape = "flat-object"\n[[complexitySignals]]\nkey = "quality_signal"\nkind = "proprietary-composite"\nscope = "repository"\n',
    );
    const report = await scan(
      h,
      async () => new Response('{"quality_signal":0.45,"cycle_count":3}'),
    );
    const context = report.featureAlignment!;
    expect(report.ownMetrics.totals.cognitive).toBe(1);
    expect(context.report.features[0]!.code.metrics!.cognitive.execution_unit).toBe(1);
    expect(context.externalEvidence[0]).toMatchObject({
      status: "available",
      analyzerSourceIdentity: "not_independently_proven",
      bindings: [{ relation: "unscoped" }, { relation: "repository_context" }],
    });
    expect(
      report.externalSignals[0]!.measurements.find(
        (measurement) => measurement.key === "quality_signal",
      ),
    ).toMatchObject({
      evidenceOnly: true,
      value: { value: 0.45 },
      provenance: { extensionId: "structural" },
      signal: { scope: "repository" },
    });
    expect(context).not.toHaveProperty("total");
  });

  it("parses declarative nested HTTP measures while refusing to infer remote freshness from a successful request", async () => {
    const h = await project();
    await install(
      h,
      "platform",
      '\n[outputMapping]\ncontainer = "component.measures"\nkey = "metric"\nvalue = "value"\n[[complexitySignals]]\nkey = "cognitive_complexity"\nkind = "cognitive"\nscope = "repository"\n',
    );
    const report = await scan(
      h,
      async () =>
        new Response(
          '{"component":{"key":"old-project","measures":[{"metric":"cognitive_complexity","value":"934"}]}}',
        ),
    );
    expect(report.externalSignals[0]!.measurements[0]).toMatchObject({
      key: "cognitive_complexity",
      value: { value: 934 },
      provenance: { extensionId: "platform" },
    });
    expect(report.featureAlignment!.externalEvidence[0]).toMatchObject({
      analyzerSourceIdentity: "not_independently_proven",
      bindings: [{ relation: "repository_context" }],
    });
    expect(report.featureAlignment!.sourceBinding.detail).toContain(
      "not an atomic snapshot or proof of a remote analysis revision",
    );
  });

  it("binds only explicitly scoped file measurements, preserving outside-feature and unknown evidence", async () => {
    const h = await project();
    await install(
      h,
      "files",
      '\n[[complexitySignals]]\nkey = "cognitive"\nkind = "cognitive"\nscope = "file"\n',
    );
    const report = await scan(
      h,
      async () =>
        new Response(
          JSON.stringify({
            metrics: [
              { key: "cognitive", value: 7, path: "src/checkout.ts" },
              { key: "cognitive", value: 8, path: "src/other.ts" },
              { key: "cognitive", value: 9 },
              { key: "mystery", value: 10, path: "src/checkout.ts" },
            ],
          }),
        ),
    );
    expect(report.featureAlignment!.externalEvidence[0]!.bindings).toEqual([
      {
        kind: "measurement",
        index: 0,
        relation: "declared_feature_file",
        filePath: "src/checkout.ts",
      },
      { kind: "measurement", index: 1, relation: "other_file", filePath: "src/other.ts" },
      { kind: "measurement", index: 2, relation: "unscoped" },
      { kind: "measurement", index: 3, relation: "unscoped", filePath: "src/checkout.ts" },
    ]);
  });

  it.each(['{"metrics":[]}', '{"metrics":[{"key":"broken","value":"NaN"}]}'])(
    "does not count empty or rejected output as a passed feature check: %s",
    async (body) => {
      const h = await project();
      await install(h, "empty", "");
      const report = await scan(h, async () => new Response(body));
      expect(report.featureAlignment!.externalEvidence[0]).toMatchObject({
        status: "not_measured",
        bindings: [],
      });
      expect(report.featureAlignment!.externalEvidence[0]!.nextStep).toContain(
        "empty output is not a passed feature check",
      );
    },
  );

  it("keeps HTTP failure visible beside the feature report", async () => {
    const h = await project();
    await install(h, "unavailable", "");
    const report = await scan(h, async () => new Response("unavailable", { status: 503 }));
    expect(report.featureAlignment!.externalEvidence[0]!.status).toBe("not_measured");
    expect(report.notMeasured).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "run_failed" })]),
    );
    expect(report.externalSignals[0]!.run.exitStatus).not.toBe("completed");
  });

  it("marks source edits during the analyzer call as changed without concealing the original report", async () => {
    const h = await project();
    await install(h, "mutating", "");
    const report = await scan(h, async () => {
      await writeFixture(
        join(h.project, "src/checkout.ts"),
        "export const checkout = 'changed';\n",
      );
      return new Response('{"metrics":[{"key":"count","value":1}]}');
    });
    expect(report.featureAlignment!.sourceBinding.status).toBe("changed");
    expect(report.featureAlignment!.sourceBinding.beforeDigest).not.toBe(
      report.featureAlignment!.sourceBinding.afterDigest,
    );
    expect(report.featureAlignment!.externalEvidence[0]!.status).toBe("source_changed");
    expect(
      report.featureAlignment!.report.features[0]!.code.metrics!.cognitive.execution_unit,
    ).toBe(1);
  });

  it("exposes shared file membership without splitting or adding external measurements", async () => {
    const h = await project();
    const manifest = structuredClone(MANIFEST);
    manifest.features.push({
      ...structuredClone(manifest.features[0]!),
      id: "checkout.preview",
      title: "Preview checkout",
    });
    await writeFixture(join(h.project, "untangle.features.json"), JSON.stringify(manifest));
    await install(
      h,
      "shared",
      '\n[[complexitySignals]]\nkey = "cognitive"\nkind = "cognitive"\nscope = "file"\n',
    );
    const report = await scan(
      h,
      async () =>
        new Response('{"metrics":[{"key":"cognitive","value":13,"path":"src/checkout.ts"}]}'),
    );
    expect(report.featureAlignment!.externalEvidence[0]!.bindings).toEqual([
      {
        kind: "measurement",
        index: 0,
        relation: "declared_feature_file",
        filePath: "src/checkout.ts",
        sharedWithFeatures: ["checkout", "checkout.preview"],
      },
    ]);
    expect(report.externalSignals[0]!.measurements[0]!.value).toMatchObject({ value: 13 });
    expect(
      report.featureAlignment!.report.features[0]!.code.metrics!.cognitive.execution_unit,
    ).toBe(1);
  });

  it("marks feature declaration edits changed and preserves both manifest hashes", async () => {
    const h = await project();
    await install(h, "manifest-edit", "");
    const report = await scan(h, async () => {
      const changed = structuredClone(MANIFEST);
      changed.features[0]!.title = "Changed declaration";
      await writeFixture(join(h.project, "untangle.features.json"), JSON.stringify(changed));
      return new Response('{"metrics":[]}');
    });
    expect(report.featureAlignment!.sourceBinding.status).toBe("changed");
    expect(report.featureAlignment!.sourceBinding.beforeManifestHash).not.toBe(
      report.featureAlignment!.sourceBinding.afterManifestHash,
    );
  });

  it("marks an unavailable final source check unverified and preserves the original feature evidence", async () => {
    const h = await project();
    const analyzeProduct = vi
      .fn<typeof analyzeProductAlignment>()
      .mockImplementationOnce(analyzeProductAlignment)
      .mockRejectedValueOnce(new Error("final inventory unavailable"));
    await runScan(
      { cwd: h.project, env: h.env, io: h.io, signal: new AbortController().signal },
      parseArgs(["--feature=checkout", "--format=json"], scanCommand.spec.flags),
      { analyzeProduct },
    );
    const report = JSON.parse(h.io.outText) as Report;
    expect(report.featureAlignment!.sourceBinding).toMatchObject({
      status: "unverified",
      detail: "The final local source check failed: final inventory unavailable",
    });
    expect(report.featureAlignment!.report.features[0]!.id).toBe("checkout");
    expect(report.featureAlignment!.nextSteps).toEqual(
      expect.arrayContaining([expect.stringContaining("stable working tree")]),
    );
  });

  it("does not convert cancellation during the final source check into a completed report", async () => {
    const h = await project();
    const controller = new AbortController();
    const reason = new Error("stop final scan");
    const analyzeProduct = vi
      .fn<typeof analyzeProductAlignment>()
      .mockImplementationOnce(analyzeProductAlignment)
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw reason;
      });
    await expect(
      runScan(
        { cwd: h.project, env: h.env, io: h.io, signal: controller.signal },
        parseArgs(["--feature=checkout", "--format=json"], scanCommand.spec.flags),
        { analyzeProduct },
      ),
    ).rejects.toBe(reason);
    expect(h.io.outText).toBe("");
  });

  it("reports missing, unknown and unsupported feature scope honestly", async () => {
    const missing = await project({ manifest: false });
    const missingReport = await scan(missing, vi.fn<typeof fetch>());
    expect(missingReport.featureAlignment!.report.status).toBe("needs_manifest");
    const unknown = await project();
    const unknownReport = await scan(unknown, vi.fn<typeof fetch>(), ["--feature=missing"]);
    expect(unknownReport.featureAlignment!.report.features).toEqual([]);
    expect(unknownReport.featureAlignment!.report.issues).toContain("Unknown feature: missing.");
    const unsupported = await project({ unsupported: true });
    const unsupportedReport = await scan(unsupported, vi.fn<typeof fetch>());
    expect(unsupportedReport.featureAlignment!.report.features[0]!.code).toMatchObject({
      complete: false,
      metrics: null,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "src/unknown.odd", status: "unsupported" }),
      ]),
    });
  });

  it("resolves a custom manifest from the selected root and never runs disabled extensions", async () => {
    const h = await project();
    await writeFixture(join(h.project, "maps/features.json"), JSON.stringify(MANIFEST));
    await install(h, "disabled", "", false);
    const fetchImpl = vi.fn<typeof fetch>();
    const report = await scan(h, fetchImpl, [
      "--feature=checkout",
      "--manifest=maps/features.json",
    ]);
    expect(report.featureAlignment!.report.manifest.path).toBe("maps/features.json");
    expect(report.notMeasured).toEqual([expect.objectContaining({ reason: "not_enabled" })]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["--feature="],
    ["--manifest=map.json"],
    ["--feature=checkout", "--manifest= "],
    ["--test-evidence=report.json"],
  ])("rejects invalid feature options before executing analyzers: %s", async (...argv) => {
    const h = await project();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runScan(
        { cwd: h.project, env: h.env, io: h.io, signal: new AbortController().signal },
        parseArgs(argv, scanCommand.spec.flags),
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(UsageError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
