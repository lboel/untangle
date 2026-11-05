import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const {
  createInitSetupFixture,
  fixtureFeatureManifest,
  assertCancelledPty,
  assertFeatureMapFixture,
} = (await import(new URL("./init-setup-smoke.mjs", import.meta.url).href)) as {
  createInitSetupFixture(root: string, manifest?: boolean): void;
  fixtureFeatureManifest(): {
    owners: { status: string }[];
    features: { id: string; review: string; code: { include: string[] }; dependsOn: string[] }[];
  };
  assertCancelledPty(result: unknown): void;
  assertFeatureMapFixture(result: unknown, root: string): void;
};

const { captureQuickstartTree } = (await import(
  new URL("./quickstart-smoke.mjs", import.meta.url).href
)) as {
  captureQuickstartTree(root: string): { path: string; kind: string }[];
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("interactive setup acceptance integrity", () => {
  it("starts from a real small repository without tool configuration, services or fabricated evidence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "init-setup-gate-"));
    directories.push(root);
    createInitSetupFixture(root);
    const files = captureQuickstartTree(root).map((entry) => entry.path);
    expect(files).not.toContain("untangle.toml");
    expect(files).not.toContain(".untangle");
    expect(files).not.toContain("untangle.features.json");
    expect(files).toContain("src/unmapped.ts");
    expect(readFileSync(path.join(root, "src/accounts.ts"), "utf8")).toContain(
      "function normalizeAccountId",
    );
    expect(readFileSync(path.join(root, "src/accounts.test.ts"), "utf8")).toContain(
      'it("finds an account"',
    );
  });

  it("explicitly declares shared code and a dependency without confirming product authority", () => {
    const manifest = fixtureFeatureManifest();
    expect(manifest.features.map((feature) => feature.id)).toEqual([
      "account.lookup",
      "account.request",
    ]);
    expect(
      manifest.features.every((feature) => feature.code.include.includes("src/shared.ts")),
    ).toBe(true);
    expect(manifest.features[1]?.dependsOn).toEqual(["account.lookup"]);
    expect(manifest.features.every((feature) => feature.review === "proposed")).toBe(true);
    expect(manifest.owners.every((owner) => owner.status === "declared")).toBe(true);
  });

  it("rejects apparent cancellation that timed out, never reached a prompt, leaked raw mode or claimed success", () => {
    const cancelled = {
      timedOut: false,
      actionSent: true,
      exitCode: 130,
      stdout: "",
      terminalRestored: true,
      terminal: "Select a setup action",
    };
    expect(() => assertCancelledPty(cancelled)).not.toThrow();
    for (const change of [
      { timedOut: true },
      { actionSent: false },
      { exitCode: 0 },
      { stdout: "/project/untangle.toml\n" },
      { terminalRestored: false },
    ])
      expect(() => assertCancelledPty({ ...cancelled, ...change })).toThrow();
  });

  it("rejects a pretty graph with incomplete measurements, omitted helpers, inferred test success or outside output", () => {
    const root = path.join(tmpdir(), "map acceptance");
    const result = {
      schemaVersion: 1,
      kind: "feature_map_artifact",
      summary: { features: 2, truncated: false, unmappedCodeFiles: 1 },
      htmlPath: path.join(root, ".untangle/feature-map/map.html"),
      jsonPath: path.join(root, ".untangle/feature-map/map.json"),
      report: {
        semanticConformance: "not_independently_proven",
        ownershipAuthority: "manifest_declarations",
        features: [
          {
            id: "account.lookup",
            code: {
              complete: true,
              metrics: { cognitive: { execution_unit: 3 } },
              hotspots: [{ symbol: "normalizeAccountId" }],
            },
            testEvidence: { status: "not_run" },
            ownership: [{ id: "account-team", status: "declared" }],
          },
        ],
      },
      graph: {
        nodes: [
          { id: "f1", kind: "feature" },
          { id: "f2", kind: "feature" },
          { id: "shared", kind: "code", path: "src/shared.ts" },
          { id: "t1", kind: "test" },
          { id: "o1", kind: "owner" },
          { id: "i1", kind: "intent" },
          { id: "u1", kind: "unmapped" },
        ],
        edges: [
          { from: "f1", to: "shared", kind: "code" },
          { from: "f2", to: "shared", kind: "code" },
          { from: "f2", to: "f1", kind: "dependency" },
        ],
      },
    };
    expect(() => assertFeatureMapFixture(result, root)).not.toThrow();
    const changed = (edit: (copy: typeof result) => void): typeof result => {
      const copy = structuredClone(result);
      edit(copy);
      return copy;
    };
    for (const candidate of [
      changed((copy) => {
        copy.report.features[0]!.code.complete = false;
      }),
      changed((copy) => {
        copy.report.features[0]!.code.hotspots = [];
      }),
      changed((copy) => {
        copy.report.features[0]!.testEvidence.status = "passed";
      }),
      changed((copy) => {
        copy.summary.unmappedCodeFiles = 0;
      }),
      changed((copy) => {
        copy.htmlPath = path.resolve(root, "../outside.html");
      }),
      changed((copy) => {
        copy.graph.edges.shift();
      }),
      changed((copy) => {
        copy.graph.nodes = copy.graph.nodes.filter((node) => node.id !== "f2");
      }),
    ])
      expect(() => assertFeatureMapFixture(candidate, root)).toThrow();
  });
});
