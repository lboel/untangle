import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const frontend = (await import(
  pathToFileURL(path.resolve("scripts/release-frontend-consumer.mjs")).href
)) as {
  createFrontendFixture(root: string): {
    root: string;
    vueRoot: string;
    nativeRoot: string;
    incompleteRoot: string;
  };
  frontendSourceRecords(): { path: string; sha256: string }[];
  assertFrontendConsumerPath(root: string, target: string): string;
  assertVueConsumerMetrics(vue: unknown, native: unknown, incomplete: unknown): void;
};
const owned: string[] = [];
function directory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "untangle-frontend-consumer-test-"));
  owned.push(root);
  return root;
}
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("installed frontend consumer fixture guards", () => {
  it("creates distinct Vue, native, incomplete and HTTP sources without overwriting existing evidence", () => {
    const root = directory();
    const fixture = frontend.createFrontendFixture(root);
    expect(frontend.frontendSourceRecords()).toHaveLength(9);
    expect(
      frontend.frontendSourceRecords().every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)),
    ).toBe(true);
    expect(readFileSync(path.join(fixture.root, "src/api.ts"), "utf8")).toContain(
      "encodeURIComponent(id)",
    );
    expect(readFileSync(path.join(fixture.root, "src/api.ts"), "utf8")).toContain("fetch(url)");
    const foreign = path.join(fixture.root, "src/api.ts");
    writeFileSync(foreign, "foreign concurrent content");
    expect(() => frontend.createFrontendFixture(root)).toThrow("fixture exists");
    expect(readFileSync(foreign, "utf8")).toBe("foreign concurrent content");
    expect(existsSync(path.join(fixture.incompleteRoot, "OnlyTemplate.vue"))).toBe(true);
  });

  it("rejects parent and sibling package resolutions rather than accepting a path prefix", () => {
    const root = directory();
    expect(
      frontend.assertFrontendConsumerPath(root, path.join(root, "node_modules/cli/index.js")),
    ).toBe("node_modules/cli/index.js");
    expect(() =>
      frontend.assertFrontendConsumerPath(root, path.join(root, "../outside.js")),
    ).toThrow();
    expect(() => frontend.assertFrontendConsumerPath(root, root + "-foreign/index.js")).toThrow();
  });

  it("does not accept zero metric success or missing private helper and incomplete-script evidence", () => {
    const totals = { executionUnits: 2, executionUnitRoots: 2, cognitive: 2, cyclomatic: 5 };
    const native = {
      filesAnalyzed: 1,
      totals,
      hotspots: [
        { name: "feature", cognitive: 1, cyclomatic: 3 },
        { name: "helper", cognitive: 1, cyclomatic: 2 },
      ],
      skipped: [],
    };
    const incomplete = { filesAnalyzed: 0, hotspots: [], skipped: [] };
    expect(() =>
      frontend.assertVueConsumerMetrics({ ...native, filesAnalyzed: 0 }, native, incomplete),
    ).toThrow();
    expect(() =>
      frontend.assertVueConsumerMetrics(
        { ...native, hotspots: [native.hotspots[0]] },
        native,
        incomplete,
      ),
    ).toThrow();
    expect(() => frontend.assertVueConsumerMetrics(native, native, incomplete)).toThrow();
  });
});
