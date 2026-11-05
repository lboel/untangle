import type { ProductFeatureManifestV1, ProductTestEvidenceV1 } from "@untangle-code/domain";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { collectProductInventory } from "./analysis.js";
import { analyzeProductAlignment } from "./report.js";

const ROOT = "/foreign";
function featureManifest(): ProductFeatureManifestV1 {
  return {
    schemaVersion: 1,
    owners: [
      {
        id: "team.search",
        label: "Search team",
        kind: "team",
        status: "confirmed",
        confirmedBy: "declared-reviewer",
        sources: [{ path: "vision.md", heading: "Ownership" }],
      },
    ],
    features: [
      {
        id: "feature.search",
        title: "Search",
        stage: "implemented",
        review: "confirmed",
        confirmedBy: "declared-reviewer",
        intent: [
          { role: "vision", path: "vision.md", heading: "Search" },
          { role: "specification", path: "spec.md", heading: "Exact retrieval" },
        ],
        owners: ["team.search"],
        code: { include: ["src/search.ts"] },
        tests: { include: ["src/search.test.ts"] },
        criteria: [
          {
            id: "all-search-regressions",
            description: "All selected search test-file regressions pass",
            tests: ["src/search.test.ts"],
          },
        ],
        dependsOn: [],
      },
    ],
  };
}

async function project(manifest = featureManifest()): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem(new FakeClock());
  await fs.mkdir(`${ROOT}/src`, { recursive: true });
  await fs.mkdir(`${ROOT}/.untangle`, { recursive: true });
  fs.seedFile(`${ROOT}/.gitignore`, ".untangle/\n");
  fs.seedFile(
    `${ROOT}/vision.md`,
    "# Search\nKeep exact symbols discoverable.\n# Ownership\nSearch team owns the boundary.\n",
  );
  fs.seedFile(
    `${ROOT}/spec.md`,
    "# Exact retrieval\nReturn the exact identifier before fallback.\n",
  );
  fs.seedFile(
    `${ROOT}/src/search.ts`,
    "function helper(v: number) { if(v > 0) return v; return 0; }\nexport function search(v: number) { return helper(v); }\n",
  );
  fs.seedFile(
    `${ROOT}/src/search.test.ts`,
    "export const regressionCases = ['exact', 'fallback'];\n",
  );
  fs.seedFile(`${ROOT}/untangle.features.json`, JSON.stringify(manifest));
  return fs;
}

async function evidence(
  fs: MemoryFileSystem,
  changes: Partial<ProductTestEvidenceV1> = {},
): Promise<void> {
  const baseline = await analyzeProductAlignment({ root: ROOT, fs });
  const report: ProductTestEvidenceV1 = {
    schemaVersion: 1,
    sourceTreeBefore: baseline.sourceTreeDigest,
    sourceTreeAfter: baseline.sourceTreeDigest,
    command: ["actual-test-runner", "search"],
    exitCode: 0,
    tests: [
      { path: "src/search.test.ts", name: "exact", status: "passed" },
      { path: "src/search.test.ts", name: "fallback", status: "passed" },
    ],
    ...changes,
  };
  fs.seedFile(`${ROOT}/.untangle/tests.json`, JSON.stringify(report));
}

describe("vision → feature → full code/tests → ownership", () => {
  it.each(["ignored.ts", "missing/**/*.ts"])(
    "does not substitute zero or a partial union for unresolved code %s",
    async (declaration) => {
      const manifest = featureManifest();
      manifest.features[0]!.code.include.push(declaration);
      const fs = await project(manifest);
      if (declaration === "ignored.ts") {
        fs.seedFile(`${ROOT}/.gitignore`, ".untangle/\nignored.ts\n");
        fs.seedFile(`${ROOT}/ignored.ts`, "export const ignored = 1;");
      }
      const report = await analyzeProductAlignment({ root: ROOT, fs });
      expect(report.features[0]!.code.complete).toBe(false);
      expect(report.features[0]!.code.metrics).toBeNull();
      expect(report.coverage.mappedCodeUnion).toBeNull();
    },
  );
  it("leaves an implemented empty wildcard boundary unmeasured instead of returning zero", async () => {
    const manifest = featureManifest();
    manifest.features[0]!.code.include = ["missing/**/*.ts"];
    const report = await analyzeProductAlignment({ root: ROOT, fs: await project(manifest) });
    expect(report.features[0]!.code.complete).toBe(false);
    expect(report.features[0]!.code.metrics).toBeNull();
    expect(report.coverage.mappedCodeUnion).toBeNull();
  });
  it("revalidates an accepted Init census with exactly its pinned scanner scope", async () => {
    const fs = await project();
    fs.seedFile(`${ROOT}/.gitignore`, ".untangle/\n/generated/\n");
    await fs.mkdir(`${ROOT}/src/generated`, { recursive: true });
    fs.seedFile(`${ROOT}/src/generated/helper.ts`, "export const generated = 1;");
    const scope = {
      additionalDefaultExcludes: ["generated"],
      maxFileSizeBytes: 2048,
      maxFilesScanned: 50_000,
      concurrency: 2,
    };
    const inventory = await collectProductInventory({ root: ROOT, fs, scope });
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      files: inventory.files,
      inventoryScope: scope,
    });
    expect(report.features[0]!.code.complete).toBe(true);
    expect(report.features[0]!.code.metrics).not.toBeNull();
    expect(report.issues.some((issue) => issue.includes("changed during analysis"))).toBe(false);
    expect(report.coverage.unmappedCodeFiles).toEqual([]);
  });
  it("keeps unchanged unassigned UTF-16 text out of false source-change invalidation", async () => {
    const fs = await project();
    fs.seedFile(
      `${ROOT}/notes.txt`,
      new Uint8Array([255, 254, 110, 0, 111, 0, 116, 0, 101, 0, 115, 0]),
    );
    await evidence(fs);
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: ".untangle/tests.json",
    });
    expect(report.status).toBe("evidence_consistent");
    expect(report.features[0]!.code.metrics).not.toBeNull();
    expect(report.features[0]!.testEvidence.status).toBe("bound_passed");
  });
  it("rejects an evidence file which grows beyond the declared parse budget after stat", async () => {
    const fs = await project();
    await evidence(fs);
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await original(file, options);
      return file.endsWith("/.untangle/tests.json")
        ? new TextEncoder().encode(new TextDecoder().decode(bytes) + " ".repeat(16 * 1024 * 1024))
        : bytes;
    });
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: ".untangle/tests.json",
    });
    expect(report.features[0]!.testEvidence.status).toBe("invalid");
    expect(report.status).toBe("incomplete");
  });
  it.each(["src/missing.test.ts", "src/excluded.test.ts", "unmatched/**/*.test.ts"])(
    "requires every criterion selector to resolve within declared tests: %s",
    async (missing) => {
      const manifest = featureManifest();
      manifest.features[0]!.criteria[0]!.tests.push(missing);
      const fs = await project(manifest);
      if (missing === "src/excluded.test.ts")
        fs.seedFile(`${ROOT}/${missing}`, "export const excluded = true;");
      await evidence(fs);
      const report = await analyzeProductAlignment({
        root: ROOT,
        fs,
        testEvidencePath: ".untangle/tests.json",
      });
      expect(report.features[0]!.criteria[0]!.status).toBe("missing_tests");
      expect(report.features[0]!.status).toBe("incomplete");
      expect(report.status).toBe("incomplete");
    },
  );
  it("invalidates all metrics and test bindings when a source file appears after execution evidence is read", async () => {
    const fs = await project();
    await evidence(fs);
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await original(file, options);
      if (file.endsWith("/.untangle/tests.json"))
        fs.seedFile(`${ROOT}/src/new-helper.ts`, "export const added = 1;");
      return bytes;
    });
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: ".untangle/tests.json",
      maxCognitive: 0,
    });
    expect(report.status).toBe("incomplete");
    expect(report.coverage.mappedCodeUnion).toBeNull();
    expect(report.features[0]!.testEvidence.status).toBe("stale");
    expect(report.features[0]!.code.metrics).toBeNull();
    expect(report.features[0]!.criteria[0]!.status).toBe("unverified");
    expect(report.features[0]!.code.hotspots).toEqual([]);
    expect(
      report.features[0]!.agentHints.some(
        (hint) => hint.search !== undefined || hint.code.endsWith("_budget"),
      ),
    ).toBe(false);
  });
  it("requires explicit mapping and returns a reviewable draft for an arbitrary codebase", async () => {
    const fs = new MemoryFileSystem(new FakeClock());
    await fs.mkdir(ROOT, { recursive: true });
    fs.seedFile(`${ROOT}/src.ts`, "export const x = 1;");
    const report = await analyzeProductAlignment({ root: ROOT, fs });
    expect(report.status).toBe("needs_manifest");
    expect(report.draft).toEqual({ schemaVersion: 1, owners: [], features: [] });
    expect(report.features).toEqual([]);
  });
  it("binds full file metrics including private helpers and exact source headings", async () => {
    const fs = await project();
    await evidence(fs);
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: ".untangle/tests.json",
    });
    expect(report.status).toBe("evidence_consistent");
    expect(report.semanticConformance).toBe("not_independently_proven");
    expect(report.ownershipAuthority).toBe("manifest_declarations");
    const feature = report.features[0]!;
    expect(feature.code.metrics!.cognitive.execution_unit).toBeGreaterThan(0);
    expect(feature.code.hotspots.map((item) => item.symbol)).toContain("helper");
    expect(feature.intent.map((item) => item.status)).toEqual(["resolved", "resolved"]);
    expect(feature.criteria[0]!.status).toBe("passed");
    expect(feature.testEvidence).toMatchObject({
      status: "bound_passed",
      passed: 2,
      proof: "supplied_source_bound_report",
    });
  });
  it("never treats an existing test file as executed behavior evidence", async () => {
    const report = await analyzeProductAlignment({ root: ROOT, fs: await project() });
    expect(report.features[0]!.testEvidence.status).toBe("not_run");
    expect(report.features[0]!.criteria[0]!.status).toBe("not_run");
    expect(report.status).toBe("needs_review");
  });
  it("keeps proposed ownership and feature review visible even when tests pass", async () => {
    const manifest = featureManifest();
    manifest.features[0]!.review = "proposed";
    manifest.owners[0]!.status = "declared";
    const fs = await project(manifest);
    await evidence(fs);
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: ".untangle/tests.json",
    });
    expect(report.status).toBe("needs_review");
    expect(report.features[0]!.agentHints.some((hint) => hint.code === "ownership_review")).toBe(
      true,
    );
  });
  it.each(["failed", "skipped"] as const)(
    "does not green a whole-file contract with a %s test",
    async (status) => {
      const fs = await project();
      await evidence(fs, {
        tests: [
          { path: "src/search.test.ts", name: "exact", status: "passed" },
          { path: "src/search.test.ts", name: "fallback", status },
        ],
      });
      const report = await analyzeProductAlignment({
        root: ROOT,
        fs,
        testEvidencePath: ".untangle/tests.json",
      });
      expect(report.features[0]!.criteria[0]!.status).toBe(
        status === "failed" ? "failed" : "unverified",
      );
      expect(report.status).not.toBe("evidence_consistent");
    },
  );
  it("requires criterion-specific case identities when declared", async () => {
    const manifest = featureManifest();
    manifest.features[0]!.criteria[0]!.testNames = ["exact", "cancellation"];
    const fs = await project(manifest);
    await evidence(fs);
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: ".untangle/tests.json",
    });
    expect(report.features[0]!.criteria[0]!.status).toBe("unverified");
    expect(report.status).toBe("needs_review");
  });
  it("invalidates source-bound tests after a same-size source edit", async () => {
    const fs = await project();
    await evidence(fs);
    fs.seedFile(`${ROOT}/src/search.ts`, "export const replaced = true;\n");
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: ".untangle/tests.json",
    });
    expect(report.features[0]!.testEvidence.status).toBe("stale");
    expect(report.status).toBe("incomplete");
  });
  it("counts overlapping full files once in the global union and exposes dependency cycles", async () => {
    const manifest = featureManifest();
    manifest.features.push({
      ...structuredClone(manifest.features[0]!),
      id: "feature.fallback",
      dependsOn: ["feature.search"],
    });
    manifest.features[0]!.dependsOn = ["feature.fallback"];
    const fs = await project(manifest);
    const report = await analyzeProductAlignment({ root: ROOT, fs });
    expect(report.coverage.sharedFiles).toEqual([
      { path: "src/search.ts", featureIds: ["feature.fallback", "feature.search"] },
    ]);
    expect(report.coverage.mappedCodeUnion).toEqual(report.features[0]!.code.metrics);
    expect(report.dependencyCycles).toEqual([["feature.fallback", "feature.search"]]);
    expect(report.status).toBe("incomplete");
  });
  it("exposes unmapped code, unresolved headings and missing owners without fuzzy inference", async () => {
    const manifest = featureManifest();
    manifest.features[0]!.intent[0]!.heading = "Different vision";
    manifest.features[0]!.owners = ["unknown"];
    const fs = await project(manifest);
    fs.seedFile(`${ROOT}/src/unmapped.ts`, "export const unowned = 1;");
    const report = await analyzeProductAlignment({ root: ROOT, fs });
    expect(report.coverage.unmappedCodeFiles).toEqual(["src/unmapped.ts"]);
    expect(report.features[0]!.intent[0]!.status).toBe("missing");
    expect(report.features[0]!.ownership[0]!.status).toBe("missing");
    expect(report.status).toBe("incomplete");
  });
  it("does not show an unbuilt planned feature as zero-complexity implementation", async () => {
    const manifest = featureManifest();
    manifest.features[0]!.stage = "planned";
    manifest.features[0]!.code.include = [];
    manifest.features[0]!.tests.include = [];
    manifest.features[0]!.criteria = [];
    const fs = await project(manifest);
    const report = await analyzeProductAlignment({ root: ROOT, fs });
    expect(report.features[0]!.code.metrics).toBeNull();
    expect(report.features[0]!.status).toBe("needs_review");
  });
  it("gives agents a fresh independent symbol-search hint for a complex private helper", async () => {
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs: await project(),
      maxCognitive: 0,
    });
    expect(
      report.features[0]!.agentHints.find((hint) => hint.code === "cognitive_unit_budget")!.search,
    ).toEqual({ symbol: "helper", path: "src/search.ts", requireFresh: true });
    expect(report.features[0]!.status).toBe("violated");
  });
  it("rejects outside evidence and preserves the caller's cancellation reason", async () => {
    const fs = await project();
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      testEvidencePath: "../outside.json",
    });
    expect(report.features[0]!.testEvidence.status).toBe("invalid");
    const controller = new AbortController();
    const reason = new Error("stop exactly here");
    controller.abort(reason);
    await expect(
      analyzeProductAlignment({ root: ROOT, fs, signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});
