import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { analyzeProductAlignment } from "@untangle-code/core";
import type { ProductFeatureManifestV1, ProductTestEvidenceV1 } from "@untangle-code/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DefaultUntangleMcpRuntime, DEFAULT_MCP_AVAILABLE_TOOLS } from "./default-runtime.js";
import { mcpSuccess } from "./envelope.js";
import { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } from "./output-schemas.js";
import { createUntangleMcpServer, executeMcpToolInvocation } from "./server.js";
import { UNTANGLE_MCP_TOOLS } from "./tools.js";
import type { UntangleMcpRuntime } from "./types.js";

const MANIFEST: ProductFeatureManifestV1 = {
  schemaVersion: 1,
  owners: [
    {
      id: "search-team",
      label: "Search team",
      kind: "team",
      status: "confirmed",
      confirmedBy: "project-review",
      sources: [{ path: "vision.md", heading: "Search" }],
    },
  ],
  features: [
    {
      id: "search.local",
      title: "Local search",
      stage: "implemented",
      review: "confirmed",
      confirmedBy: "project-review",
      intent: [
        { role: "vision", path: "vision.md", heading: "Search" },
        { role: "specification", path: "spec.md", heading: "Contract" },
      ],
      owners: ["search-team"],
      code: { include: ["src/search.ts"] },
      tests: { include: ["src/search.test.ts"] },
      criteria: [
        {
          id: "find",
          description: "Find a target",
          tests: ["src/search.test.ts"],
          testNames: ["finds the target"],
        },
      ],
      dependsOn: [],
    },
  ],
};

describe("product MCP contract and local runtime", () => {
  let temporary: string;
  let root: string;

  beforeEach(() => {
    temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-product-mcp-")));
    root = path.join(temporary, "project");
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, ".untangle"));
    writeFileSync(path.join(root, ".gitignore"), ".untangle/\n");
    writeFileSync(path.join(root, "vision.md"), "# Search\n\nFind local targets.\n");
    writeFileSync(path.join(root, "spec.md"), "# Contract\n\nReturn a declared target.\n");
    writeFileSync(
      path.join(root, "src", "search.ts"),
      "export function localSearch(query: string): string {\n  if (query.length === 0) return 'empty';\n  return query;\n}\n",
    );
    writeFileSync(
      path.join(root, "src", "search.test.ts"),
      "export function testLocalSearch(): boolean {\n  return true;\n}\n",
    );
    writeFileSync(path.join(root, "untangle.features.json"), JSON.stringify(MANIFEST));
  });

  afterEach(() => rmSync(temporary, { recursive: true, force: true }));

  function invocationContext(signal = new AbortController().signal) {
    return { cwd: root, env: {}, signal };
  }

  async function bindEvidence(): Promise<void> {
    const baseline = await analyzeProductAlignment({ root });
    const evidence: ProductTestEvidenceV1 = {
      schemaVersion: 1,
      sourceTreeBefore: baseline.sourceTreeDigest,
      sourceTreeAfter: baseline.sourceTreeDigest,
      command: ["vitest", "run", "src/search.test.ts"],
      exitCode: 0,
      tests: [{ path: "src/search.test.ts", name: "finds the target", status: "passed" }],
    };
    writeFileSync(path.join(root, ".untangle", "tests.json"), JSON.stringify(evidence));
  }

  async function withClient(
    runtime: UntangleMcpRuntime | undefined,
    callback: (client: Client) => Promise<void>,
  ): Promise<void> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createUntangleMcpServer({
      cwd: temporary,
      env: {},
      workspaceRoots: [root],
      ...(runtime === undefined ? {} : { runtime }),
    });
    const client = new Client({ name: "untangle-product-contract-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await callback(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  function definition() {
    const result = UNTANGLE_MCP_TOOLS.find((tool) => tool.name === "untangle_product");
    if (result === undefined) throw new Error("Product tool was not registered.");
    return result;
  }

  it("advertises the executable additive tool and its strict input/output schema over the actual MCP transport", async () => {
    expect(DEFAULT_MCP_AVAILABLE_TOOLS).toContain("untangle_product");
    await withClient(undefined, async (client) => {
      const tool = (await client.listTools()).tools.find(
        (entry) => entry.name === "untangle_product",
      );
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool?.outputSchema).toBeDefined();
      expect(definition().pathFields).toEqual(["root", "manifest", "testEvidence"]);
    });
  });

  it("returns current metrics, declared ownership and actionable missing-test evidence without writing files", async () => {
    const beforeFiles = readdirSync(root);
    const beforeManifest = readFileSync(path.join(root, "untangle.features.json"));
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_product",
      { root, featureId: "search.local" },
      invocationContext(),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        status: "needs_review",
        semanticConformance: "not_independently_proven",
        ownershipAuthority: "manifest_declarations",
        features: [
          {
            id: "search.local",
            ownership: [{ id: "search-team", status: "confirmed" }],
            code: {
              complete: true,
              metrics: { files: 1, cognitive: { execution_unit: 1, self: 1, top_level: 2 } },
            },
            testEvidence: { status: "not_run", proof: "none" },
          },
        ],
      },
    });
    expect(UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_product.safeParse(result.data).success).toBe(
      true,
    );
    const data = result.data as { features: { agentHints: unknown[] }[] };
    expect(data.features[0]?.agentHints.length).toBeGreaterThan(0);
    expect(readdirSync(root)).toEqual(beforeFiles);
    expect(readFileSync(path.join(root, "untangle.features.json"))).toEqual(beforeManifest);
    expect(existsSync(path.join(root, "untangle.toml"))).toBe(false);
    expect(readdirSync(path.join(root, ".untangle"))).toEqual([]);
  });

  it("round-trips source-bound passed evidence over MCP without claiming independent semantic proof", async () => {
    await bindEvidence();
    await withClient(undefined, async (client) => {
      const result = await client.callTool({
        name: "untangle_product",
        arguments: {
          root,
          manifest: "untangle.features.json",
          testEvidence: ".untangle/tests.json",
          requireComplete: true,
        },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: {
          status: "evidence_consistent",
          semanticConformance: "not_independently_proven",
          features: [
            {
              testEvidence: { status: "bound_passed", proof: "supplied_source_bound_report" },
              criteria: [{ id: "find", status: "passed" }],
            },
          ],
        },
      });
      const first = result.content[0];
      expect(first?.type).toBe("text");
      if (first?.type === "text") expect(JSON.parse(first.text)).toEqual(result.structuredContent);
    });
  });

  it("preserves the honest report inside a failed require-complete envelope", async () => {
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_product",
      { root, requireComplete: true },
      invocationContext(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "QUALITY_GATE_FAILED",
        retryable: false,
        details: {
          exitCode: 5,
          data: { status: "needs_review", features: [{ testEvidence: { status: "not_run" } }] },
        },
      },
    });
  });

  it("does not promote a previously passing report after the bound code changes", async () => {
    await bindEvidence();
    writeFileSync(path.join(root, "src", "search.ts"), "export const changedAfterTests = true;\n");
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_product",
      { root, testEvidence: ".untangle/tests.json", requireComplete: true },
      invocationContext(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { details: { data: { features: [{ testEvidence: { status: "stale" } }] } } },
    });
  });

  it("preserves all three metric readings and rejects unknown nested data and semantic authority upgrades", async () => {
    const report = await analyzeProductAlignment({ root });
    const schema = UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_product;
    expect(schema.parse(report)).toEqual(report);
    const feature = report.features[0];
    expect(feature).toBeDefined();
    expect(schema.safeParse({ ...report, semanticConformance: "proven" }).success).toBe(false);
    expect(schema.safeParse({ ...report, ownershipAuthority: "inferred" }).success).toBe(false);
    expect(
      schema.safeParse({
        ...report,
        features: [{ ...feature, code: { ...feature?.code, hiddenMetric: 1 } }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...report, inventory: { ...report.inventory, hiddenCount: 1 } }).success,
    ).toBe(false);
    const metrics = feature?.code.metrics;
    expect(
      schema.safeParse({
        ...report,
        features: [
          {
            ...feature,
            code: {
              ...feature?.code,
              metrics: { ...metrics, cognitive: { execution_unit: 1, self: 1 } },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    { maxCognitive: -1 },
    { maxCognitive: Infinity },
    { manifest: "" },
    { featureId: "" },
    { testEvidence: "" },
    { hiddenFlag: true },
  ])("rejects invalid tool input %j before runtime invocation", async (input) => {
    const runtime: UntangleMcpRuntime = { invoke: vi.fn() };
    const result = await executeMcpToolInvocation(definition(), input, {
      cwd: root,
      env: {},
      runtime,
      workspaceRoots: [root],
      signal: new AbortController().signal,
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(runtime.invoke).not.toHaveBeenCalled();
  });

  it.each(["manifest", "testEvidence"])(
    "rejects an escaping %s path before invoking the runtime",
    async (field) => {
      const runtime: UntangleMcpRuntime = { invoke: vi.fn() };
      const result = await executeMcpToolInvocation(
        definition(),
        { root, [field]: "../outside.json" },
        {
          cwd: temporary,
          env: {},
          runtime,
          workspaceRoots: [root],
          signal: new AbortController().signal,
        },
      );
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "PATH_OUTSIDE_WORKSPACE" },
      });
      expect(runtime.invoke).not.toHaveBeenCalled();
    },
  );

  it("resolves manifest and test evidence relative to an explicit project root before dispatch", async () => {
    const report = await analyzeProductAlignment({ root });
    const invoke = vi.fn().mockResolvedValue(mcpSuccess("untangle_product", report));
    const runtime = { invoke };
    const result = await executeMcpToolInvocation(
      definition(),
      { root: "project", manifest: "untangle.features.json", testEvidence: ".untangle/tests.json" },
      {
        cwd: temporary,
        env: {},
        runtime,
        workspaceRoots: [root],
        signal: new AbortController().signal,
      },
    );
    expect(result.isError).toBe(false);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      root,
      manifest: path.join(root, "untangle.features.json"),
      testEvidence: path.join(root, ".untangle", "tests.json"),
    });
  });

  it("maps a real mid-flight analysis abort to CANCELLED instead of success", async () => {
    const controller = new AbortController();
    const pending = new DefaultUntangleMcpRuntime().invoke(
      "untangle_product",
      { root },
      invocationContext(controller.signal),
    );
    controller.abort(new Error("cancel local product analysis"));
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  });

  it.each(["untangle_complexity", "untangle_hotspots"] as const)(
    "%s preserves the actual CLI execution-unit reading over built stdio and accepts legacy payloads",
    async (operation) => {
      const binary = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
      const cli = JSON.parse(
        execFileSync(process.execPath, [binary, "complexity", "--root", root, "--format=json"], {
          encoding: "utf8",
          timeout: 20_000,
        }),
      ) as { totalsReading: unknown; totals: Record<string, unknown> };
      const schema = UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS[operation];
      expect(cli.totalsReading).toBe("execution_unit");
      expect(cli.totals["executionUnitRoots"]).toBeGreaterThan(0);
      expect(schema.safeParse(cli).success).toBe(true);
      const legacy = { ...cli, totals: { ...cli.totals } };
      Reflect.deleteProperty(legacy, "totalsReading");
      Reflect.deleteProperty(legacy.totals, "executionUnitRoots");
      expect(schema.safeParse(legacy).success).toBe(true);
      expect(schema.safeParse({ ...cli, totalsReading: "unproven_reading" }).success).toBe(false);
      expect(
        schema.safeParse({ ...cli, totals: { ...cli.totals, executionUnitRoots: -1 } }).success,
      ).toBe(false);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [binary, "mcp", "--stdio", "--root", root],
        cwd: root,
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const client = new Client({ name: "legacy-complexity-regression", version: "1.0.0" });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: operation, arguments: { root } });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          ok: true,
          operation,
          data: { totalsReading: cli.totalsReading, totals: cli.totals },
        });
        const first = result.content[0];
        expect(first?.type).toBe("text");
        if (first?.type === "text")
          expect(JSON.parse(first.text)).toEqual(result.structuredContent);
      } finally {
        await client.close();
      }
      expect(stderr).toBe("");
    },
    30_000,
  );
});
