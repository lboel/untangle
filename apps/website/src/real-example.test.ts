import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

interface Metric {
  cognitive: { top_level: number; execution_unit: number; self: number };
  files: number;
  sloc: number;
}
interface FeatureDetails {
  featureId?: string;
  metrics?: Metric | null;
  testMetrics?: Metric | null;
  testEvidence?: { status: string; passed: number; failed: number; skipped: number; proof: string };
  criteria?: { id: string; matchedFiles: string[]; status: string; description?: string }[];
  agentHints?: Record<string, unknown>[];
  contentHash?: string;
  roles?: string[];
}
interface ExampleNode {
  id: string;
  kind: string;
  label: string;
  path?: string;
  status: string;
  cognitive?: number;
  details: FeatureDetails;
}
interface Example {
  schemaVersion: number;
  kind: string;
  provenance: {
    repository: string;
    revision: string;
    sourceTreeDigest: string;
    publishedGraphSha256: string;
    featureManifest: { path: string; sha256: string };
    sourceFiles: { path: string; sha256: string }[];
    renderer: {
      revision: string;
      node: string;
      gitSourceManifestSha256: string;
      builtDistManifestSha256: string;
      sourceFiles: { path: string; sha256: string }[];
      distFiles: { path: string; sha256: string }[];
      scriptSha256: string;
      styleSha256: string;
      scriptSha256Base64: string;
      styleSha256Base64: string;
    };
    omittedFields: string[];
  };
  graph: {
    sourceTreeDigest: string;
    nodes: ExampleNode[];
    edges: { id: string; from: string; to: string; kind: string }[];
    summary: {
      status: string;
      features: number;
      shownNodes: number;
      totalNodes: number;
      shownEdges: number;
      totalEdges: number;
      truncated: boolean;
      mappedCodeFiles: number;
      unmappedCodeFiles: number;
      inventoryFiles: number;
    };
    limitations: string[];
  };
}

const source = new URL(".", import.meta.url);
const example: Example = JSON.parse(readFileSync(new URL("untangle-example.json", source), "utf8"));
const html = readFileSync(new URL("untangle-example.html", source), "utf8");
const generator = (await import(
  pathToFileURL(fileURLToPath(new URL("../scripts/generate-example.mjs", source))).href
)) as {
  validatePublicExampleProjection(value: unknown): unknown;
  assertFrozenExampleMeasurement(value: unknown): void;
  createPublicExampleProjection(raw: unknown, provenance: unknown): Example;
  PUBLIC_EXAMPLE_LIMITATION: string;
};
const sha256 = (value: string, encoding: "hex" | "base64" = "hex") =>
  createHash("sha256").update(value).digest(encoding);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const feature = (value: Example, id = "untangle.embedding") =>
  value.graph.nodes.find((node) => node.details.featureId === id)!;
function changed(mutator: (value: Example) => void) {
  const value = copy(example);
  mutator(value);
  value.provenance.publishedGraphSha256 = sha256(JSON.stringify(value.graph));
  return value;
}

describe("actual Untangle repository example", () => {
  it("publishes the complete measured topology of the pinned repository, with its real coverage gaps", () => {
    expect(() => generator.validatePublicExampleProjection(example)).not.toThrow();
    expect(example.provenance.revision).toBe("d11bdaf0b474cbe4c09095d59a9da05463cc1134");
    expect(example.provenance.featureManifest.sha256).toBe(
      "853f9f2cac7edd874e801e1e130298b52eb678715c45bf8cf804199f404eef0a",
    );
    expect(example.graph.sourceTreeDigest).toBe(
      "80ff8f7983822d391cae0d32c20ace6bc9174c291079a0ea451de1794571a6e1",
    );
    expect(example.graph.summary).toEqual({
      status: "violated",
      features: 25,
      shownNodes: 1095,
      totalNodes: 1095,
      shownEdges: 1109,
      totalEdges: 1109,
      truncated: false,
      mappedCodeFiles: 545,
      unmappedCodeFiles: 101,
      inventoryFiles: 1261,
    });
    const kinds = Object.fromEntries(
      ["feature", "code", "test", "owner", "intent", "unmapped"].map((kind) => [
        kind,
        example.graph.nodes.filter((node) => node.kind === kind).length,
      ]),
    );
    expect(kinds).toEqual({
      feature: 25,
      code: 545,
      test: 359,
      owner: 25,
      intent: 40,
      unmapped: 101,
    });
    expect(example.provenance.sourceFiles).toHaveLength(1010);
  });

  it("shows the actual embedding feature's complete code and test readings separately", () => {
    const node = feature(example);
    expect(node.id).toBe("cb3aa504-2bd8-5559-a785-f155618a16a9");
    expect(node.cognitive).toBe(163);
    expect(node.details.metrics?.cognitive).toEqual({
      top_level: 282,
      execution_unit: 163,
      self: 139,
    });
    expect(node.details.metrics?.files).toBe(16);
    expect(node.details.metrics?.sloc).toBe(1197);
    expect(node.details.testMetrics?.cognitive).toEqual({
      top_level: 93,
      execution_unit: 67,
      self: 33,
    });
    expect(node.details.testMetrics?.files).toBe(12);
    expect(node.details.testEvidence).toEqual({
      status: "not_run",
      passed: 0,
      failed: 0,
      skipped: 0,
      proof: "none",
    });
    expect(
      example.graph.nodes.filter(
        (entry) => entry.kind === "feature" && entry.details.metrics === null,
      ),
    ).toHaveLength(5);
    expect(
      example.graph.nodes.filter((entry) => entry.kind === "owner" && entry.status === "missing"),
    ).toHaveLength(3);
  });

  it("uses the unchanged existing offline 3D renderer and the exact public graph", () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    const style = html.match(/<style>([\s\S]*?)<\/style>/u)?.[1];
    const encoded = html.match(
      /<script type="application\/json" id="map-data">([A-Za-z0-9+/=]+)<\/script>/u,
    )?.[1];
    expect(script).toBeTruthy();
    expect(style).toBeTruthy();
    expect(encoded).toBeTruthy();
    expect(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"))).toEqual(example.graph);
    expect(sha256(script!)).toBe(
      "fc5c0403406e844823823a63ff86726dc93a431af86724e504a497a902fef248",
    );
    expect(sha256(style!)).toBe("f4a358e3fd98d19305eecc37a07f49f8a3a79d1885c181c7021944735fc409e5");
    expect(html).toContain(`script-src 'sha256-${sha256(script!, "base64")}'`);
    expect(html).toContain(`style-src 'sha256-${sha256(style!, "base64")}'`);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("Untangle's own codebase");
    expect(html).toContain(example.provenance.revision);
    expect(html).toContain(example.provenance.renderer.revision);
    expect(html).toContain("ownership remains declared or missing");
    for (const id of [
      "search",
      "kind",
      "layout",
      "rotation",
      "zoom-in",
      "zoom-out",
      "detail",
      "node-list",
    ])
      expect(html).toContain(`id="${id}"`);
  });

  it("keeps the d11 measurement byte values while identifying the separately built renderer", () => {
    expect(() => generator.assertFrozenExampleMeasurement(example)).not.toThrow();
    expect(sha256(JSON.stringify(example.graph))).toBe(
      "df6495ef685f8d01b5470ea62e4572ca6e39b2e2fefc3e3a19cb5b7c0f7d32e9",
    );
    expect(sha256(JSON.stringify(example.provenance.sourceFiles))).toBe(
      "652e13d418bb0b38d5c0a82be7349c082febb277a60493080170c25c56485d2b",
    );
    const measurement = Object.fromEntries(
      Object.entries(example.provenance).filter(([key]) => key !== "renderer"),
    );
    expect(sha256(JSON.stringify(measurement))).toBe(
      "44346d10b198cdb6157b7235f036d4ff8d2ed9b68e7110c1a95256a0d2f04e1a",
    );
    expect(example.provenance.renderer.revision).toBe("8dfb919d54a698c10034f1ee6576dd16b67f6a89");
    expect(example.provenance.renderer.revision).not.toBe(example.provenance.revision);
    expect(example.provenance.renderer.sourceFiles).toHaveLength(5);
    expect(example.provenance.renderer.distFiles).toHaveLength(5);
    expect(sha256(JSON.stringify(example.provenance.renderer.sourceFiles))).toBe(
      "e78a287cf3fa18242051607f987d099e2f5a0f8f55045892489f23e2cd1f0dc4",
    );
    expect(sha256(JSON.stringify(example.provenance.renderer.distFiles))).toBe(
      "d1500dc1c9cce32f6b8f616c4817acb116c3ecac0e2b283af4d0877579961aac",
    );
  });

  it("rejects changed frozen data and requires an explicit renderer origin", () => {
    const graph = changed((value) => {
      value.graph.nodes[0]!.label = "Changed measurement";
    });
    expect(() => generator.assertFrozenExampleMeasurement(graph)).toThrow(
      "Frozen measurement graph changed",
    );
    const origin = copy(example);
    origin.provenance.renderer.revision = "";
    expect(() => generator.validatePublicExampleProjection(origin)).toThrow(
      "Renderer revision must be explicit",
    );
  });

  it("binds the category layout to the current renderer without rewriting the measured source inventory", () => {
    expect(example.provenance.renderer.sourceFiles.map((record) => record.path).sort()).toEqual([
      "apps/cli/src/commands/graph/category-clusters.ts",
      "apps/cli/src/commands/graph/feature-3d.ts",
      "apps/cli/src/commands/graph/feature-clusters.ts",
      "apps/cli/src/commands/graph/feature-html.ts",
      "apps/cli/src/commands/graph/feature-untangle-motion.ts",
    ]);
    expect(example.provenance.renderer.distFiles.map((record) => record.path).sort()).toEqual([
      "apps/cli/dist/commands/graph/category-clusters.js",
      "apps/cli/dist/commands/graph/feature-3d.js",
      "apps/cli/dist/commands/graph/feature-clusters.js",
      "apps/cli/dist/commands/graph/feature-html.js",
      "apps/cli/dist/commands/graph/feature-untangle-motion.js",
    ]);
    expect(
      example.provenance.sourceFiles.some((record) =>
        record.path.endsWith("/category-clusters.ts"),
      ),
    ).toBe(false);
  });

  it.each([
    ["sourceFiles", "ts", "missing"],
    ["distFiles", "js", "missing"],
    ["sourceFiles", "ts", "substituted"],
    ["distFiles", "js", "substituted"],
  ] as const)(
    "rejects %s provenance with a %s category helper that is %s",
    (field, extension, change) => {
      const origin = copy(example);
      const record = origin.provenance.renderer[field].find((entry) =>
        entry.path.endsWith(`/category-clusters.${extension}`),
      )!;
      expect(record).toBeDefined();
      if (change === "missing") {
        origin.provenance.renderer[field] = origin.provenance.renderer[field].filter(
          (entry) => entry !== record,
        );
      } else record.path = record.path.replace("category-clusters.", "unverified-category.");
      expect(() => generator.validatePublicExampleProjection(origin)).toThrow();
    },
  );

  it("removes private report/prose/hotspots and symbol hints while retaining every identity and complete metric", () => {
    const rawGraph = copy(example.graph);
    rawGraph.limitations = rawGraph.limitations.filter(
      (value) => value !== generator.PUBLIC_EXAMPLE_LIMITATION,
    );
    const rawFeature = feature({ ...example, graph: rawGraph });
    Object.assign(rawFeature.details, {
      hotspots: [{ symbol: "privateImplementation", sourceText: "SECRET_SOURCE_TEXT" }],
    });
    rawFeature.details.criteria![0]!.description = "SECRET_REQUIREMENT_PROSE";
    rawFeature.details.agentHints!.push({
      code: "cognitive_unit_budget",
      severity: "warning",
      message: "privateImplementation has cognitive complexity 999",
      paths: [],
      suggestedAction: "Inspect it",
      search: { symbol: "privateImplementation", path: "private.ts", requireFresh: true },
    });
    const projected = generator.createPublicExampleProjection(
      {
        graph: rawGraph,
        report: { root: "/Users/private/work", sourceText: "SECRET_REPORT_TEXT" },
      },
      example.provenance,
    );
    const serialized = JSON.stringify(projected);
    for (const privateText of [
      "SECRET_SOURCE_TEXT",
      "SECRET_REQUIREMENT_PROSE",
      "SECRET_REPORT_TEXT",
      "privateImplementation",
      "/Users/private",
    ])
      expect(serialized).not.toContain(privateText);
    expect(projected.graph.nodes.map((node) => node.id)).toEqual(
      example.graph.nodes.map((node) => node.id),
    );
    expect(projected.graph.edges).toEqual(example.graph.edges);
    expect(feature(projected).details.metrics).toEqual(feature(example).details.metrics);
    expect(feature(projected).details.testMetrics).toEqual(feature(example).details.testMetrics);
    expect(projected.provenance.omittedFields).toContain("symbolBudgetHints");
  });

  it("retains only feature-level evidence hints, with no hidden symbol-level budget export", () => {
    const hints = example.graph.nodes.flatMap((node) => node.details.agentHints ?? []);
    expect(hints).toHaveLength(66);
    expect(new Set(hints.map((hint) => hint["code"]))).toEqual(
      new Set(["ownership_review", "test_execution_evidence", "shared_code", "missing_evidence"]),
    );
    expect(hints.every((hint) => !Object.hasOwn(hint, "search"))).toBe(true);
    const bad = changed((value) =>
      feature(value).details.agentHints!.push({
        code: "cognitive_unit_budget",
        severity: "warning",
        message: "private function 87",
        paths: [],
        suggestedAction: "Inspect",
      }),
    );
    expect(() => generator.validatePublicExampleProjection(bad)).toThrow(
      "feature-level evidence hints",
    );
  });

  it.each([
    "/Users/private/source.ts",
    "../secret.ts",
    "C:\\private\\source.ts",
    "https://private.invalid/source",
  ])("rejects a private or non-repository path: %s", (privatePath) => {
    const bad = changed((value) => {
      value.graph.nodes.find((node) => node.kind === "code")!.path = privatePath;
    });
    expect(() => generator.validatePublicExampleProjection(bad)).toThrow();
  });

  it("rejects unexpected private fields even when the graph digest is recomputed", () => {
    const bad = changed((value) =>
      Object.assign(feature(value).details, { sourceText: "private body" }),
    );
    expect(() => generator.validatePublicExampleProjection(bad)).toThrow(
      "Unexpected metadata field",
    );
  });

  it("rejects fabricated test success, confirmed ownership and zero-filled missing metrics", () => {
    const passed = changed((value) => {
      feature(value).details.testEvidence!.status = "passed";
    });
    const confirmed = changed((value) => {
      value.graph.nodes.find((node) => node.kind === "owner")!.status = "confirmed";
    });
    const zero = changed((value) => {
      value.graph.nodes.find(
        (node) => node.kind === "feature" && node.details.metrics === null,
      )!.cognitive = 0;
    });
    for (const bad of [passed, confirmed, zero])
      expect(() => generator.validatePublicExampleProjection(bad)).toThrow();
  });

  it("rejects changed source hashes, dangling relations and misleading graph counts", () => {
    const sourceHash = changed((value) => {
      value.graph.nodes.find((node) => node.kind === "code")!.details.contentHash = "0".repeat(64);
    });
    const dangling = changed((value) => {
      value.graph.edges[0]!.to = "00000000-0000-5000-8000-000000000000";
    });
    const counts = changed((value) => {
      value.graph.summary.shownNodes -= 1;
    });
    for (const bad of [sourceHash, dangling, counts])
      expect(() => generator.validatePublicExampleProjection(bad)).toThrow();
  });
});
