import type {
  ProductFeatureManifestV1,
  ProductFeatureV1,
  ProductTestEvidenceV1,
} from "@untangle-code/domain";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { analyzeProductAlignment } from "./report.js";
import type { ProductAlignmentOptionsV1 } from "./report.js";

const ROOT = "/report-status";
const EVIDENCE = ".untangle/tests.json";

function feature(id: string): ProductFeatureV1 {
  return {
    id,
    title: id,
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
        id: "exact-search",
        description: "Exact search passes",
        tests: ["src/search.test.ts"],
        testNames: ["exact"],
      },
    ],
    dependsOn: [],
  };
}

function manifest(...features: ProductFeatureV1[]): ProductFeatureManifestV1 {
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
    features,
  };
}

async function project(declaration: ProductFeatureManifestV1): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem(new FakeClock());
  await fs.mkdir(`${ROOT}/src`, { recursive: true });
  await fs.mkdir(`${ROOT}/.untangle`, { recursive: true });
  fs.seedFile(`${ROOT}/.gitignore`, ".untangle/\n");
  fs.seedFile(`${ROOT}/vision.md`, "# Search\nKeep exact search.\n# Ownership\nSearch team.\n");
  fs.seedFile(`${ROOT}/spec.md`, "# Exact retrieval\nReturn exact identifiers.\n");
  if (declaration.features.length > 0) {
    fs.seedFile(
      `${ROOT}/src/search.ts`,
      "export function search(value: number) { return value; }\n",
    );
    fs.seedFile(`${ROOT}/src/search.test.ts`, "export const cases = ['exact'];\n");
  }
  fs.seedFile(`${ROOT}/untangle.features.json`, JSON.stringify(declaration));
  return fs;
}

async function supplyExecution(
  fs: MemoryFileSystem,
  changes: Partial<ProductTestEvidenceV1> = {},
): Promise<void> {
  const report = await analyzeProductAlignment({ root: ROOT, fs });
  const evidence: ProductTestEvidenceV1 = {
    schemaVersion: 1,
    sourceTreeBefore: report.sourceTreeDigest,
    sourceTreeAfter: report.sourceTreeDigest,
    command: ["actual-test-runner", "search"],
    exitCode: 0,
    tests: [{ path: "src/search.test.ts", name: "exact", status: "passed" }],
    ...changes,
  };
  fs.seedFile(`${ROOT}/${EVIDENCE}`, JSON.stringify(evidence));
}

describe("aggregate product report status characterization", () => {
  it("returns evidence_consistent for a fully bound confirmed feature", async () => {
    const fs = await project(manifest(feature("feature.search")));
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("evidence_consistent");
    expect(report.issues).toEqual([]);
    expect(report.features.map((item) => [item.id, item.status])).toEqual([
      ["feature.search", "evidence_consistent"],
    ]);
    expect(report.features[0]!.testEvidence.status).toBe("bound_passed");
    expect(report.coverage.mappedCodeUnion).toEqual(report.features[0]!.code.metrics);
  });

  it("requires every feature to be consistent and preserves sorted identities", async () => {
    const fs = await project(manifest(feature("feature.z"), feature("feature.a")));
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("evidence_consistent");
    expect(report.features.map((item) => [item.id, item.status])).toEqual([
      ["feature.a", "evidence_consistent"],
      ["feature.z", "evidence_consistent"],
    ]);
    expect(report.coverage.sharedFiles).toEqual([
      { path: "src/search.ts", featureIds: ["feature.a", "feature.z"] },
    ]);
    expect(report.issues).toEqual([]);
  });

  it("retains needs_review when one feature is proposed and another is consistent", async () => {
    const proposed = feature("feature.proposed");
    proposed.review = "proposed";
    const fs = await project(manifest(proposed, feature("feature.consistent")));
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("needs_review");
    expect(report.features.map((item) => [item.id, item.status])).toEqual([
      ["feature.consistent", "evidence_consistent"],
      ["feature.proposed", "needs_review"],
    ]);
    expect(report.issues).toEqual([]);
  });

  it("keeps declared ownership under review despite passing bound tests", async () => {
    const declaration = manifest(feature("feature.search"));
    declaration.owners[0]!.status = "declared";
    const fs = await project(declaration);
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("needs_review");
    expect(report.features[0]!.status).toBe("needs_review");
    expect(report.features[0]!.testEvidence.status).toBe("bound_passed");
    expect(report.features[0]!.ownership[0]!.status).toBe("declared");
  });

  it("keeps a planned feature under review beside a consistent implementation", async () => {
    const planned = feature("feature.planned");
    planned.stage = "planned";
    planned.code.include = [];
    planned.tests.include = [];
    planned.criteria = [];
    const fs = await project(manifest(planned, feature("feature.consistent")));
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("needs_review");
    expect(report.features.map((item) => [item.id, item.status])).toEqual([
      ["feature.consistent", "evidence_consistent"],
      ["feature.planned", "needs_review"],
    ]);
    expect(report.features[1]!.code.metrics).toBeNull();
    expect(report.issues).toEqual([]);
  });

  it("makes missing feature evidence incomplete before proposed or consistent features", async () => {
    const incomplete = feature("feature.incomplete");
    incomplete.owners = ["unknown-owner"];
    const proposed = feature("feature.proposed");
    proposed.review = "proposed";
    const fs = await project(manifest(proposed, feature("feature.consistent"), incomplete));
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("incomplete");
    expect(report.features.map((item) => [item.id, item.status])).toEqual([
      ["feature.consistent", "evidence_consistent"],
      ["feature.incomplete", "incomplete"],
      ["feature.proposed", "needs_review"],
    ]);
    expect(report.features[1]!.issues).toContain("Ownership evidence is missing or unresolved.");
    expect(report.issues).toEqual([]);
  });

  it("prioritizes a violated budget over missing ownership and proposed review", async () => {
    const violated = feature("feature.violated");
    violated.budgets = { maxCodeFiles: 0 };
    const incomplete = feature("feature.incomplete");
    incomplete.owners = ["unknown-owner"];
    const proposed = feature("feature.proposed");
    proposed.review = "proposed";
    const fs = await project(manifest(incomplete, proposed, violated));
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("violated");
    expect(report.features.map((item) => [item.id, item.status])).toEqual([
      ["feature.incomplete", "incomplete"],
      ["feature.proposed", "needs_review"],
      ["feature.violated", "violated"],
    ]);
    expect(report.features[2]!.agentHints.some((hint) => hint.code === "code_surface_budget")).toBe(
      true,
    );
  });

  it("prioritizes a violation over global unmapped-source issues", async () => {
    const violated = feature("feature.search");
    violated.budgets = { maxCodeFiles: 0 };
    const fs = await project(manifest(violated));
    fs.seedFile(`${ROOT}/src/unmapped.ts`, "export const unmapped = 1;\n");
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("violated");
    expect(report.features[0]!.status).toBe("violated");
    expect(report.issues).toContain(
      "1 accepted deep-parser candidate files have no declared feature boundary.",
    );
  });

  it("prioritizes an unsuccessful runner over the feature's missing ownership", async () => {
    const incomplete = feature("feature.search");
    incomplete.owners = ["unknown-owner"];
    const fs = await project(manifest(incomplete));
    await supplyExecution(fs, { exitCode: 1 });

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("violated");
    expect(report.features[0]!.status).toBe("violated");
    expect(report.features[0]!.testEvidence.status).toBe("bound_failed");
    expect(report.features[0]!.issues).toContain("Ownership evidence is missing or unresolved.");
  });

  it("does not claim global consistency when all features pass but code remains unassigned", async () => {
    const fs = await project(manifest(feature("feature.search")));
    fs.seedFile(`${ROOT}/src/unmapped.ts`, "export const unmapped = 1;\n");
    await supplyExecution(fs);

    const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

    expect(report.status).toBe("incomplete");
    expect(report.features[0]!.status).toBe("evidence_consistent");
    expect(report.coverage.unmappedCodeFiles).toEqual(["src/unmapped.ts"]);
    expect(report.issues).toEqual([
      "1 accepted deep-parser candidate files have no declared feature boundary.",
    ]);
  });

  it("keeps an empty manifest incomplete instead of vacuous all-feature consistency", async () => {
    const fs = await project(manifest());

    const report = await analyzeProductAlignment({ root: ROOT, fs });

    expect(report.manifest.status).toBe("loaded");
    expect(report.status).toBe("incomplete");
    expect(report.features).toEqual([]);
    expect(report.issues).toEqual([]);
  });

  it.each(["violated", "incomplete", "needs_review"] as const)(
    "retains the global %s verdict when filtering to a consistent feature",
    async (hiddenStatus) => {
      const hidden = feature("feature.hidden");
      if (hiddenStatus === "violated") hidden.budgets = { maxCodeFiles: 0 };
      if (hiddenStatus === "incomplete") hidden.owners = ["unknown-owner"];
      if (hiddenStatus === "needs_review") hidden.review = "proposed";
      const fs = await project(manifest(hidden, feature("feature.visible")));
      await supplyExecution(fs);

      const report = await analyzeProductAlignment({
        root: ROOT,
        fs,
        testEvidencePath: EVIDENCE,
        featureId: "feature.visible",
      });

      expect(report.status).toBe(hiddenStatus);
      expect(report.features.map((item) => [item.id, item.status])).toEqual([
        ["feature.visible", "evidence_consistent"],
      ]);
      expect(report.coverage.sharedFiles).toEqual([
        { path: "src/search.ts", featureIds: ["feature.hidden", "feature.visible"] },
      ]);
      expect(report.issues).toEqual([]);
    },
  );

  it.each(["evidence_consistent", "needs_review", "violated"] as const)(
    "adds an unknown-filter issue before deciding the global verdict for %s features",
    async (featureStatus) => {
      const selected = feature("feature.search");
      if (featureStatus === "violated") selected.budgets = { maxCodeFiles: 0 };
      if (featureStatus === "needs_review") selected.review = "proposed";
      const fs = await project(manifest(selected));
      await supplyExecution(fs);

      const report = await analyzeProductAlignment({
        root: ROOT,
        fs,
        testEvidencePath: EVIDENCE,
        featureId: "feature.unknown",
      });

      expect(report.status).toBe(featureStatus === "violated" ? "violated" : "incomplete");
      expect(report.features).toEqual([]);
      expect(report.issues).toEqual(["Unknown feature: feature.unknown."]);
      expect(report.coverage.mappedCodeFiles).toBe(1);
    },
  );

  it.each(["replace accepted code", "add accepted code"])(
    "invalidates an earlier budget violation and bound tests after sources change: %s",
    async (change) => {
      const violated = feature("feature.search");
      violated.budgets = { maxCodeFiles: 0 };
      const fs = await project(manifest(violated));
      await supplyExecution(fs);
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
        const bytes = await readFile(file, options);
        if (file === `${ROOT}/${EVIDENCE}`) {
          if (change === "replace accepted code")
            fs.seedFile(`${ROOT}/src/search.ts`, "export const replaced = true;\n");
          else fs.seedFile(`${ROOT}/src/added.ts`, "export const added = true;\n");
        }
        return bytes;
      });

      const report = await analyzeProductAlignment({ root: ROOT, fs, testEvidencePath: EVIDENCE });

      expect(report.status).toBe("incomplete");
      expect(report.features[0]!.status).toBe("incomplete");
      expect(report.coverage.mappedCodeUnion).toBeNull();
      expect(report.features[0]!.testEvidence).toMatchObject({ status: "stale", proof: "none" });
      expect(report.features[0]!.criteria[0]!.status).toBe("unverified");
      expect(report.features[0]!.code).toMatchObject({
        complete: false,
        metrics: null,
        hotspots: [],
      });
      expect(report.features[0]!.tests).toMatchObject({ complete: false, metrics: null });
      expect(
        report.features[0]!.agentHints.some(
          (hint) => hint.code.endsWith("_budget") || hint.search !== undefined,
        ),
      ).toBe(false);
      expect(report.issues).toContain(
        "Accepted source inventory changed during analysis, including additions/removals.",
      );
    },
  );

  it("propagates the exact cancellation reason raised while resolving feature evidence", async () => {
    const fs = await project(manifest(feature("feature.search")));
    await supplyExecution(fs);
    const controller = new AbortController();
    const reason = new Error("Stop while resolving feature evidence");
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await readFile(file, options);
      if (file === `${ROOT}/${EVIDENCE}`) controller.abort(reason);
      return bytes;
    });

    await expect(
      analyzeProductAlignment({
        root: ROOT,
        fs,
        testEvidencePath: EVIDENCE,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("checks cancellation after applying the feature filter and preserves the exact reason", async () => {
    const fs = await project(manifest(feature("feature.search")));
    await supplyExecution(fs);
    const controller = new AbortController();
    const reason = { code: "STOP_AT_FILTER", detail: "Keep the caller's reason unchanged" };
    let featureReads = 0;
    const options: ProductAlignmentOptionsV1 = {
      root: ROOT,
      fs,
      testEvidencePath: EVIDENCE,
      signal: controller.signal,
      get featureId() {
        featureReads += 1;
        // The first reads establish a known filter; the next starts final filtering.
        if (featureReads === 3) controller.abort(reason);
        return "feature.search";
      },
    };

    await expect(analyzeProductAlignment(options)).rejects.toBe(reason);
    expect(featureReads).toBe(4);
  });
});
