import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductFeatureManifestV1, ProductTestEvidenceV1 } from "@untangle-code/domain";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectProductInventory } from "./analysis.js";
import { analyzeProductAlignment } from "./report.js";

let directory: string;
let physicalRoot: string;
let aliasRoot: string;
let sourceTreeDigest: string;
const manifestPath = "plans/features.json";
const evidencePath = ".untangle/evidence.json";
const manifest: ProductFeatureManifestV1 = {
  schemaVersion: 1,
  owners: [],
  features: [
    {
      id: "lookup",
      title: "Lookup",
      stage: "implemented",
      review: "proposed",
      intent: [],
      owners: [],
      code: { include: ["src/lookup.ts"] },
      tests: { include: ["src/lookup.test.ts"] },
      criteria: [],
      dependsOn: [],
    },
  ],
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "untangle-product-root-alias-"));
  const project = path.join(directory, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "plans"));
  await mkdir(path.join(project, ".untangle"));
  physicalRoot = await realpath(project);
  aliasRoot = path.join(directory, "project-alias");
  await symlink(physicalRoot, aliasRoot, "dir");
  await writeFile(path.join(physicalRoot, "src/lookup.ts"), "export const lookup = true;\n");
  await writeFile(path.join(physicalRoot, "src/lookup.test.ts"), "export const checked = true;\n");
  await writeFile(path.join(physicalRoot, manifestPath), JSON.stringify(manifest));
  await writeFile(path.join(physicalRoot, "untangle.features.json"), JSON.stringify(manifest));
  sourceTreeDigest = (await collectProductInventory({ root: physicalRoot })).sourceTreeDigest;
  const evidence: ProductTestEvidenceV1 = {
    schemaVersion: 1,
    sourceTreeBefore: sourceTreeDigest,
    sourceTreeAfter: sourceTreeDigest,
    command: ["vitest", "run"],
    exitCode: 0,
    tests: [{ path: "src/lookup.test.ts", name: "Lookup returns a value", status: "passed" }],
  };
  await writeFile(path.join(physicalRoot, evidencePath), JSON.stringify(evidence));
  await mkdir(path.join(directory, "outside"));
  await writeFile(path.join(directory, "outside/evidence.json"), JSON.stringify(evidence));
  await writeFile(path.join(directory, "outside/features.json"), JSON.stringify(manifest));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const modes = ["relative", "alias absolute", "canonical absolute"] as const;
type Mode = (typeof modes)[number];
function selectedPath(mode: Mode, relative: string): string {
  if (mode === "relative") return relative;
  return path.join(mode === "alias absolute" ? aliasRoot : physicalRoot, relative);
}

describe("product inputs addressed through the selected root alias", () => {
  it.each(modes.flatMap((manifest) => modes.map((evidence) => ({ manifest, evidence }))))(
    "binds $manifest manifest and $evidence evidence to the canonical inventory",
    async ({ manifest, evidence }) => {
      const report = await analyzeProductAlignment({
        root: aliasRoot,
        manifestPath: selectedPath(manifest, manifestPath),
        testEvidencePath: selectedPath(evidence, evidencePath),
      });
      expect(report.root).toBe(physicalRoot);
      expect(report.sourceTreeDigest).toBe(sourceTreeDigest);
      expect(report.manifest).toMatchObject({ path: manifestPath, status: "loaded" });
      expect(report.features[0]?.testEvidence).toMatchObject({
        status: "bound_passed",
        passed: 1,
        failed: 0,
        skipped: 0,
      });
    },
  );

  it("binds an alias-absolute report with the default manifest, matching CLI-resolved evidence", async () => {
    const report = await analyzeProductAlignment({
      root: aliasRoot,
      testEvidencePath: path.join(aliasRoot, evidencePath),
    });
    expect(report.manifest).toMatchObject({ path: "untangle.features.json", status: "loaded" });
    expect(report.features[0]?.testEvidence.status).toBe("bound_passed");
  });

  it.each(["relative", "absolute"] as const)(
    "keeps %s evidence outside the selected root invalid",
    async (mode) => {
      const report = await analyzeProductAlignment({
        root: aliasRoot,
        testEvidencePath:
          mode === "relative"
            ? "../outside/evidence.json"
            : path.join(directory, "outside/evidence.json"),
      });
      expect(report.manifest.status).toBe("loaded");
      expect(report.features[0]?.testEvidence.status).toBe("invalid");
      expect(report.issues).toContain("Test evidence must be inside the chosen root.");
    },
  );

  it.each(["relative", "absolute"] as const)(
    "keeps %s manifests outside the selected root invalid",
    async (mode) => {
      const report = await analyzeProductAlignment({
        root: aliasRoot,
        manifestPath:
          mode === "relative"
            ? "../outside/features.json"
            : path.join(directory, "outside/features.json"),
      });
      expect(report.status).toBe("invalid_manifest");
      expect(report.manifest.status).toBe("invalid");
      expect(report.features).toEqual([]);
      expect(report.issues).toContain("Manifest must be inside the chosen root.");
    },
  );

  it("rejects an alias-addressed evidence symlink that escapes the physical project", async () => {
    await symlink(
      path.join(directory, "outside/evidence.json"),
      path.join(physicalRoot, ".untangle/escape.json"),
    );
    const report = await analyzeProductAlignment({
      root: aliasRoot,
      testEvidencePath: path.join(aliasRoot, ".untangle/escape.json"),
    });
    expect(report.features[0]?.testEvidence.status).toBe("invalid");
    expect(report.issues).toContain("Test evidence is unreadable or outside the chosen root.");
  });

  it("rejects an alias-addressed manifest symlink that escapes the physical project", async () => {
    await symlink(
      path.join(directory, "outside/features.json"),
      path.join(physicalRoot, "plans/escape.json"),
    );
    const report = await analyzeProductAlignment({
      root: aliasRoot,
      manifestPath: path.join(aliasRoot, "plans/escape.json"),
    });
    expect(report.manifest.status).toBe("not_in_scan");
    expect(report.features).toEqual([]);
  });

  it("reports a missing alias-addressed manifest as missing rather than outside the root", async () => {
    const report = await analyzeProductAlignment({
      root: aliasRoot,
      manifestPath: path.join(aliasRoot, "plans/missing.json"),
    });
    expect(report.status).toBe("needs_manifest");
    expect(report.manifest).toEqual({ path: "plans/missing.json", status: "missing" });
  });

  it("keeps evidence stale when an actual source changes after capture", async () => {
    await writeFile(path.join(physicalRoot, "src/lookup.ts"), "export const lookup = false;\n");
    const report = await analyzeProductAlignment({
      root: aliasRoot,
      testEvidencePath: path.join(aliasRoot, evidencePath),
    });
    expect(report.features[0]?.testEvidence.status).toBe("stale");
    expect(report.sourceTreeDigest).not.toBe(sourceTreeDigest);
  });

  it("preserves cancellation after the physical evidence path resolves", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel alias evidence read");
    const fs = new NodeFileSystem();
    const realPath = fs.realPath.bind(fs);
    vi.spyOn(fs, "realPath").mockImplementation(async (file, options) => {
      const physical = await realPath(file, options);
      if (file === path.join(physicalRoot, evidencePath)) controller.abort(reason);
      return physical;
    });
    await expect(
      analyzeProductAlignment({
        root: aliasRoot,
        fs,
        signal: controller.signal,
        testEvidencePath: path.join(aliasRoot, evidencePath),
      }),
    ).rejects.toBe(reason);
  });
});
