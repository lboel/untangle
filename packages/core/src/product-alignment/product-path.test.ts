import type { ProductFeatureManifestV1 } from "@untangle-code/domain";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { collectProductInventory } from "./analysis.js";
import { analyzeProductAlignment } from "./report.js";

async function project(): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem(new FakeClock());
  await fs.mkdir("/foreign/src", { recursive: true });
  fs.seedFile("/foreign/.gitignore", "ignored.ts\n.untangle/\n");
  fs.seedFile("/foreign/vision.md", "# Intent\nFind users.\n# Ownership\nAccounts team.\n");
  fs.seedFile("/foreign/spec.md", "# Contract\nLookup a user.\n");
  fs.seedFile(
    "/foreign/src/lookup.ts",
    "function privateHelper(n: number) { if (n) return n; return 0; }\nexport function lookup(n: number) { return privateHelper(n); }",
  );
  fs.seedFile("/foreign/src/other.ts", "export const other = 1;");
  fs.seedFile("/foreign/src/lookup.test.ts", "export const regression = 1;");
  fs.seedFile("/foreign/ignored.ts", "export const hidden = 1;");
  const manifest: ProductFeatureManifestV1 = {
    schemaVersion: 1,
    owners: [
      {
        id: "accounts",
        label: "Accounts",
        kind: "team",
        status: "declared",
        sources: [{ path: "vision.md", heading: "Ownership" }],
      },
    ],
    features: ["accounts.lookup", "accounts.shared"].map((id) => ({
      id,
      title: id,
      stage: "implemented",
      review: "proposed",
      intent: [
        { role: "vision", path: "vision.md", heading: "Intent" },
        { role: "specification", path: "spec.md", heading: "Contract" },
      ],
      owners: ["accounts"],
      code: { include: ["src/lookup.ts", ...(id === "accounts.lookup" ? ["src/other.ts"] : [])] },
      tests: { include: ["src/lookup.test.ts"] },
      criteria: [
        { id: "regression", description: "All regression cases", tests: ["src/lookup.test.ts"] },
      ],
      dependsOn: [],
    })),
  };
  fs.seedFile("/foreign/untangle.features.json", JSON.stringify(manifest));
  return fs;
}

describe("literal search hit to complete declared feature context", () => {
  it("returns every shared association without shrinking code, helpers, coverage or metrics", async () => {
    const fs = await project();
    const full = await analyzeProductAlignment({ root: "/foreign", fs });
    const selected = await analyzeProductAlignment({ root: "/foreign", fs, path: "src/lookup.ts" });
    expect(selected.selection).toEqual({
      path: "src/lookup.ts",
      status: "matched",
      matches: [
        { featureId: "accounts.lookup", roles: ["code"] },
        { featureId: "accounts.shared", roles: ["code"] },
      ],
    });
    expect(selected.features).toEqual(full.features);
    expect(selected.features[0]!.code.files).toHaveLength(2);
    expect(selected.features[0]!.code.metrics!.cognitive.execution_unit).toBeGreaterThan(0);
    expect(selected.coverage).toEqual(full.coverage);
    expect(selected.coverage.sharedFiles).toEqual([
      { path: "src/lookup.ts", featureIds: ["accounts.lookup", "accounts.shared"] },
    ]);
  });

  it("selects test and document/owner associations explicitly", async () => {
    const fs = await project();
    const tests = await analyzeProductAlignment({
      root: "/foreign",
      fs,
      path: "src/lookup.test.ts",
    });
    expect(tests.selection!.matches.every((match) => match.roles.join() === "test")).toBe(true);
    const docs = await analyzeProductAlignment({ root: "/foreign", fs, path: "vision.md" });
    expect(
      docs.selection!.matches.every((match) => match.roles.join() === "intent,ownership"),
    ).toBe(true);
    expect(docs.features[0]!.ownership[0]!.status).toBe("declared");
    expect(docs.features[0]!.testEvidence.status).toBe("not_run");
  });

  it.each([
    ["notes.md", "unmapped"],
    ["absent.ts", "missing"],
    ["ignored.ts", "not_in_scan"],
  ] as const)("keeps %s explicit as %s, never a fabricated association", async (path, status) => {
    const fs = await project();
    fs.seedFile("/foreign/notes.md", "Unassigned document");
    const result = await analyzeProductAlignment({ root: "/foreign", fs, path });
    expect(result.selection).toEqual({ path, status, matches: [] });
    expect(result.features).toEqual([]);
    expect(result.issues.join()).toContain(`Selected path ${path}: ${status}`);
    expect(result.coverage.mappedCodeFiles).toBe(2);
  });

  it.each([
    "../outside.ts",
    "/foreign/src/lookup.ts",
    "src/**/*.ts",
    "src/../lookup.ts",
    "src\\lookup.ts",
    "",
  ])("rejects invalid literal selection %j", async (path) => {
    await expect(
      analyzeProductAlignment({ root: "/foreign", fs: await project(), path }),
    ).rejects.toThrow("literal file path");
  });

  it("does not attach a stale hit from an accepted census to current feature evidence", async () => {
    const fs = await project();
    const inventory = await collectProductInventory({ root: "/foreign", fs });
    fs.seedFile("/foreign/src/lookup.ts", "export const replaced = 1;");
    const result = await analyzeProductAlignment({
      root: "/foreign",
      fs,
      files: inventory.files,
      path: "src/lookup.ts",
    });
    expect(result.selection).toEqual({ path: "src/lookup.ts", status: "changed", matches: [] });
    expect(result.features).toEqual([]);
    expect(result.coverage.mappedCodeUnion).toBeNull();
  });

  it("keeps all shared associations visible when an explicit feature filter is also requested", async () => {
    const result = await analyzeProductAlignment({
      root: "/foreign",
      fs: await project(),
      path: "src/lookup.ts",
      featureId: "accounts.lookup",
    });
    expect(result.features.map((feature) => feature.id)).toEqual(["accounts.lookup"]);
    expect(result.selection!.matches).toHaveLength(2);
    expect(result.coverage.sharedFiles[0]!.featureIds).toHaveLength(2);
  });

  it("reports a known feature/path mismatch explicitly instead of a consistent empty selection", async () => {
    const result = await analyzeProductAlignment({
      root: "/foreign",
      fs: await project(),
      path: "src/other.ts",
      featureId: "accounts.shared",
    });
    expect(result.selection).toEqual({
      path: "src/other.ts",
      status: "matched",
      matches: [{ featureId: "accounts.lookup", roles: ["code"] }],
    });
    expect(result.features).toEqual([]);
    expect(result.status).toBe("incomplete");
    expect(result.issues).toContain(
      "Selected path src/other.ts is not associated with requested feature accounts.shared.",
    );
    expect(result.coverage.sharedFiles).toHaveLength(1);
    expect(result.coverage.mappedCodeUnion).not.toBeNull();
  });
});
