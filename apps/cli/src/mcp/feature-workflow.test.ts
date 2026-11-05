import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DefaultUntangleMcpRuntime } from "./default-runtime.js";
import { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } from "./output-schemas.js";
import { UNTANGLE_MCP_TOOLS } from "./tools.js";

describe("search-hit to declared feature MCP workflow", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-feature-path-mcp-")));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "vision.md"), "# Lookup\nFind accounts locally.\n");
    writeFileSync(
      path.join(root, "src/lookup.ts"),
      "export function lookup(id: string) { return id.trim(); }\n",
    );
    writeFileSync(
      path.join(root, "src/helper.ts"),
      "export function normalize(id: string) { if (!id) return ''; return id; }\n",
    );
    writeFileSync(path.join(root, "src/other.ts"), "export const other = 1;\n");
    writeFileSync(
      path.join(root, "untangle.features.json"),
      JSON.stringify({
        schemaVersion: 1,
        owners: [
          {
            id: "accounts",
            label: "Accounts role",
            kind: "role",
            status: "declared",
            sources: [{ path: "vision.md", heading: "Lookup" }],
          },
        ],
        features: ["lookup", "audit"].map((id) => ({
          id,
          title: id,
          stage: "implemented",
          review: "proposed",
          intent: [{ role: "vision", path: "vision.md", heading: "Lookup" }],
          owners: ["accounts"],
          code: {
            include: id === "lookup" ? ["src/lookup.ts", "src/helper.ts"] : ["src/helper.ts"],
          },
          tests: { include: [] },
          criteria: [],
          dependsOn: [],
        })),
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function inspect(selectedPath: string) {
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_product",
      { root, path: selectedPath },
      { cwd: root, env: {}, signal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
    return UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_product.parse(result.data);
  }

  it("accepts a literal hit without enabling command execution", () => {
    const definition = UNTANGLE_MCP_TOOLS.find((tool) => tool.name === "untangle_product");
    expect(definition?.inputSchema.safeParse({ path: "src/lookup.ts" }).success).toBe(true);
    expect(
      definition?.inputSchema.safeParse({ path: "src/lookup.ts", runTests: true }).success,
    ).toBe(false);
  });

  it("keeps helper metrics and shared ownership when selecting a single hit", async () => {
    const report = await inspect("src/lookup.ts");
    expect(report.selection).toEqual({
      path: "src/lookup.ts",
      status: "matched",
      matches: [{ featureId: "lookup", roles: ["code"] }],
    });
    expect(report.features.map((feature) => feature.id)).toEqual(["lookup"]);
    expect(report.features[0]?.code.files.map((file) => file.path)).toEqual([
      "src/helper.ts",
      "src/lookup.ts",
    ]);
    expect(report.features[0]?.code.metrics?.executionUnitRoots).toBe(2);
    expect(report.coverage.sharedFiles).toEqual([
      { path: "src/helper.ts", featureIds: ["audit", "lookup"] },
    ]);
    expect(report.features[0]?.ownership[0]?.status).toBe("declared");
    expect(report.semanticConformance).toBe("not_independently_proven");
  });

  it("returns every matching feature for a shared source or intent document", async () => {
    expect((await inspect("src/helper.ts")).features.map((feature) => feature.id).sort()).toEqual([
      "audit",
      "lookup",
    ]);
    const report = await inspect("vision.md");
    expect(report.selection?.matches).toEqual([
      { featureId: "audit", roles: ["intent", "ownership"] },
      { featureId: "lookup", roles: ["intent", "ownership"] },
    ]);
  });

  it("exposes unmapped and missing paths instead of inventing a feature", async () => {
    const unmapped = await inspect("src/other.ts");
    expect(unmapped.selection?.status).toBe("unmapped");
    expect(unmapped.features).toEqual([]);
    expect((await inspect("src/missing.ts")).selection?.status).toBe("missing");
  });
});
