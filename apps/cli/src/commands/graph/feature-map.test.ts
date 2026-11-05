import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";

import { analyzeProductAlignment } from "@untangle-code/core";
import type { ProductAlignmentReportV1 } from "@untangle-code/domain";
import { afterEach, describe, expect, it } from "vitest";

import { createCategoryClusterLayout, type CategoryClusterDimension } from "./category-clusters.js";
import { createFeatureThread, createFeatureWoolLayout, projectFeaturePoint } from "./feature-3d.js";
import { createFeatureClusterLayout } from "./feature-clusters.js";
import {
  createFeatureGroupIndex,
  createFeatureLaneLayout,
  createFeatureMapHtml,
} from "./feature-html.js";
import { writeFeatureMap } from "./feature-map.js";
import { buildFeatureMapGraph, featureMapLimits, type FeatureMapGraphV1 } from "./feature-model.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("category-specific untangling in the actual client", () => {
  const choices = [
    ["code", "Untangle code areas"],
    ["test", "Untangle test areas"],
    ["owner", "Untangle ownership"],
    ["intent", "Untangle vision / spec"],
    ["unmapped", "Untangle unassigned"],
  ] as const;

  it.each(choices)(
    "animates %s grouping without changing topology, evidence or reverse endpoints",
    async (dimension, action) => {
      const graph = await clientGraph(),
        frozen = JSON.stringify(graph);
      const document = featureClient(graph),
        grouping = document.getElementById("grouping");
      const feature = graph.nodes.find((node) => node.kind === "feature")!;
      document
        .getElementById("map")
        .querySelector(`[data-graph-node="${feature.id}"]`)!
        .dispatch("click");
      const evidence = document.getElementById("detail").textContent;
      grouping.value = dimension;
      grouping.focus();
      grouping.dispatch("change");
      expect(document.frames.size).toBe(0);
      expect(document.activeElement).toBe(grouping);
      const button = document.getElementById("untangle"),
        map = document.getElementById("map");
      expect(button.textContent).toBe(action);
      expect(map.getAttribute("data-clustered")).toBe("false");
      const nodes = new Map(
        graph.nodes.map((node) => [node.id, map.querySelector(`[data-graph-node="${node.id}"]`)!]),
      );
      const edges = new Map(
        graph.edges.map((edge) => [edge.id, map.querySelector(`[data-edge="${edge.id}"]`)!]),
      );
      const original = new Map(
        [...nodes].map(([id, node]) => [id, node.getAttribute("transform")]),
      );
      button.dispatch("click");
      document.stepAnimation(0);
      document.stepAnimation(1300);
      expect(button.textContent).toBe("Pause untangling");
      document.stepAnimation(2600);
      const target = createCategoryClusterLayout(graph.nodes, graph.edges, dimension);
      expect(button.textContent).toBe("Show tangle");
      expect(map.getAttribute("data-grouping")).toBe(dimension);
      for (const node of graph.nodes) {
        expect(map.querySelector(`[data-graph-node="${node.id}"]`)).toBe(nodes.get(node.id));
        const point = projectFeaturePoint(target.positions[node.id]!, { yaw: 0.35, pitch: -0.22 });
        expect(nodes.get(node.id)!.getAttribute("transform")).toBe(
          `translate(${point.x} ${point.y}) scale(${point.scale * 0.65})`,
        );
      }
      for (const edge of graph.edges)
        expect(map.querySelector(`[data-edge="${edge.id}"]`)).toBe(edges.get(edge.id));
      expect(document.getElementById("detail").textContent).toBe(evidence);
      expect(document.getElementById("untangle-note").textContent).toContain(
        "Code and metrics are unchanged.",
      );
      button.dispatch("click");
      document.stepAnimation(3000);
      document.stepAnimation(5600);
      for (const [id, node] of nodes) expect(node.getAttribute("transform")).toBe(original.get(id));
      expect(button.textContent).toBe(action);
      expect(document.frames.size).toBe(0);
      expect(JSON.stringify(graph)).toBe(frozen);
    },
  );

  it.each(choices)(
    "keeps %s grouping independent of every layer filter under reduced motion",
    async (dimension) => {
      const graph = await clientGraph();
      for (const kind of ["all", "feature", "code", "test", "owner", "intent", "unmapped"]) {
        const document = featureClient(graph, true),
          layer = document.getElementById("kind"),
          grouping = document.getElementById("grouping");
        layer.value = kind;
        layer.dispatch("change");
        grouping.value = dimension;
        grouping.dispatch("change");
        expect(layer.value).toBe(kind);
        expect(document.frames.size).toBe(0);
        document.getElementById("untangle").dispatch("click");
        const visible = graph.nodes.filter(
          (node) =>
            kind === "all" ||
            node.kind === kind ||
            (Array.isArray(node.details["roles"]) && node.details["roles"].includes(kind)),
        );
        const ids = new Set(visible.map((node) => node.id));
        const map = document.getElementById("map");
        for (const node of graph.nodes)
          expect(map.querySelector(`[data-graph-node="${node.id}"]`) !== null).toBe(
            ids.has(node.id),
          );
        for (const edge of graph.edges)
          expect(map.querySelector(`[data-edge="${edge.id}"]`) !== null).toBe(
            ids.has(edge.from) && ids.has(edge.to),
          );
        expect(map.getAttribute("data-clustered")).toBe("true");
        expect(map.getAttribute("data-grouping")).toBe(dimension);
        expect(document.getElementById("visible-count").textContent).toBe(
          `${visible.length} / ${graph.summary.totalNodes} nodes`,
        );
        expect(document.frames.size).toBe(0);
      }
    },
  );

  it("cancels a paused category transition without stale frames or loss of search, zoom, selection or focus", async () => {
    const graph = await clientGraph(),
      document = featureClient(graph);
    const search = document.getElementById("search"),
      layer = document.getElementById("kind");
    search.value = "src/shared.ts";
    search.dispatch("input");
    layer.value = "code";
    layer.dispatch("change");
    const file = graph.nodes.find((node) => node.path === "src/shared.ts")!;
    document
      .getElementById("map")
      .querySelector(`[data-graph-node="${file.id}"]`)!
      .dispatch("click");
    const details = document.getElementById("detail").textContent;
    document.getElementById("zoom-in").dispatch("click");
    const button = document.getElementById("untangle");
    button.dispatch("click");
    document.stepAnimation(0);
    document.stepAnimation(400);
    const stale = [...document.frames.values()][0]!;
    button.dispatch("click");
    const grouping = document.getElementById("grouping");
    grouping.value = "owner";
    grouping.focus();
    grouping.dispatch("change");
    const map = document.getElementById("map"),
      node = map.querySelector(`[data-graph-node="${file.id}"]`)!;
    const point = node.getAttribute("transform");
    stale(50000);
    expect(node.getAttribute("transform")).toBe(point);
    expect(node.className).toContain("selected");
    expect(map.children[0]!.getAttribute("transform")).toContain("scale(1.2)");
    expect(search.value).toBe("src/shared.ts");
    expect(layer.value).toBe("code");
    expect(document.getElementById("detail").textContent).toBe(details);
    expect(document.activeElement).toBe(grouping);
    expect(button.textContent).toBe("Untangle ownership");
    expect(document.frames.size).toBe(0);
    expect(map.getAttribute("data-clustered")).toBe("false");
  });

  it("does not invent anchors in featureless graphs and rejects unknown grouping choices", async () => {
    const { graph } = await writeFeatureMap({ root: await fixture(false) });
    expect(graph.nodes.length).toBeGreaterThan(0);
    const document = featureClient(graph, true),
      grouping = document.getElementById("grouping");
    for (const dimension of [
      "owner",
      "intent",
      "test",
    ] as const satisfies readonly CategoryClusterDimension[]) {
      grouping.value = dimension;
      grouping.dispatch("change");
      document.getElementById("untangle").dispatch("click");
      expect(
        document.getElementById("map").querySelector(".cluster-regions")!.textContent,
      ).toContain("context");
      expect(document.getElementById("node-list").children).toHaveLength(graph.nodes.length);
      expect(document.frames.size).toBe(0);
    }
    grouping.value = "invented";
    grouping.dispatch("change");
    expect(grouping.value).toBe("test");
    expect(document.getElementById("map").getAttribute("data-grouping")).toBe("test");
    expect(document.frames.size).toBe(0);
  });
});

describe("readable grouping index", () => {
  it("keeps complete labels, distinguishes visible/total counts and omits only fully hidden groups", () => {
    const full = "A complete feature name that must remain readable without truncation";
    const groups = [
      { id: "f", kind: "feature" as const, featureId: "a", memberIds: ["a", "b"] },
      { id: "shared", kind: "shared" as const, memberIds: ["c"] },
      {
        id: "outside",
        kind: "unassigned" as const,
        label: "No declared owner context",
        memberIds: ["d"],
      },
    ];
    const nodes = [{ id: "a", label: full }],
      before = JSON.stringify({ groups, nodes });
    expect(createFeatureGroupIndex(groups, nodes, ["a", "c"])).toEqual([
      { id: "f", label: full, visible: 1, total: 2 },
      { id: "shared", label: "Shared context", visible: 1, total: 1 },
    ]);
    expect(createFeatureGroupIndex(groups, nodes, [])).toEqual([]);
    expect(JSON.stringify({ groups, nodes })).toBe(before);
  });

  it.each(["feature", "code", "test", "owner", "intent", "unmapped"] as const)(
    "exposes full %s group names and filtered counts without moving disclosure focus or weakening source evidence",
    async (dimension) => {
      const graph = await clientGraph();
      const long = "Complete ownership label with literal <b>text</b> and no truncation";
      const input = {
        ...graph,
        nodes: graph.nodes.map((node) => (node.kind === "owner" ? { ...node, label: long } : node)),
      };
      const frozen = JSON.stringify(input),
        document = featureClient(input, true);
      const grouping = document.getElementById("grouping");
      grouping.value = dimension;
      grouping.dispatch("change");
      const target =
        dimension === "feature"
          ? createFeatureClusterLayout(input.nodes, input.edges)
          : createCategoryClusterLayout(input.nodes, input.edges, dimension);
      const expected = createFeatureGroupIndex(
        target.groups,
        input.nodes,
        input.nodes.map((node) => node.id),
      );
      const list = document.getElementById("group-list"),
        disclosure = document.getElementById("group-index");
      expect(list.children.map((item) => item.textContent)).toEqual(
        expected.map((group) => `${group.label} · ${group.total} nodes`),
      );
      if (dimension === "owner") {
        expect(list.textContent).toContain(long);
        expect(list.children.every((item) => item.children.length === 0)).toBe(true);
      }
      expect(document.getElementById("group-count").textContent).toBe(`(${expected.length})`);
      disclosure.setAttribute("open", "");
      const layer = document.getElementById("kind");
      layer.value = "code";
      layer.focus();
      layer.dispatch("change");
      const visible = input.nodes.filter(
        (node) =>
          node.kind === "code" ||
          (Array.isArray(node.details["roles"]) && node.details["roles"].includes("code")),
      );
      const filtered = createFeatureGroupIndex(
        target.groups,
        input.nodes,
        visible.map((node) => node.id),
      );
      expect(list.children.map((item) => item.textContent)).toEqual(
        filtered.map(
          (group) =>
            `${group.label} · ${group.visible === group.total ? `${group.total} nodes` : `${group.visible} / ${group.total} nodes visible`}`,
        ),
      );
      expect(document.getElementById("group-index")).toBe(disclosure);
      expect(disclosure.getAttribute("open")).toBe("");
      expect(document.activeElement).toBe(layer);
      expect(JSON.stringify(input)).toBe(frozen);
    },
  );
});

async function fixture(withManifest = true): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "untangle-feature-map ")));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  const files: Record<string, string> = {
    "vision.md": "# Intent\nKeep account lookup understandable.\n",
    "spec.md": "# Contract\nResolve known account identifiers, otherwise return undefined.\n",
    "src/accounts.ts":
      "function normalize(id: string): string { return id.trim(); }\nexport function lookupAccount(id: string): string | undefined { if (!id) return undefined; return normalize(id); }\n",
    "src/handler.ts":
      "import { lookupAccount } from './accounts.js';\nexport function handleAccount(id: string): string { return lookupAccount(id) ?? 'missing'; }\n",
    "src/shared.ts":
      "export function isReady(value: string): boolean { return value.length > 0; }\n",
    "src/other.ts": "export const unassignedCapability = 1;\n",
    "src/accounts.test.ts":
      "import { expect, it } from 'vitest';\nit('resolves an identifier', () => { expect('42').toBe('42'); });\n",
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(root, name), content);
  if (withManifest)
    await writeFile(
      path.join(root, "untangle.features.json"),
      JSON.stringify({
        schemaVersion: 1,
        owners: [
          {
            id: "maintainer",
            label: "Maintainer",
            kind: "role",
            status: "declared",
            sources: [{ path: "vision.md", heading: "Intent" }],
          },
        ],
        features: [
          {
            id: "accounts",
            title: "Account lookup",
            stage: "implemented",
            review: "proposed",
            intent: [
              { path: "vision.md", heading: "Intent", role: "vision" },
              { path: "spec.md", heading: "Contract", role: "specification" },
            ],
            owners: ["maintainer"],
            code: { include: ["src/accounts.ts", "src/shared.ts"] },
            tests: { include: ["src/accounts.test.ts"] },
            criteria: [
              { id: "lookup", description: "Resolve account", tests: ["src/accounts.test.ts"] },
            ],
            dependsOn: [],
          },
          {
            id: "handler",
            title: "Request handling",
            stage: "implemented",
            review: "proposed",
            intent: [{ path: "spec.md", heading: "Contract", role: "specification" }],
            owners: ["maintainer"],
            code: { include: ["src/handler.ts", "src/shared.ts"] },
            tests: { include: [] },
            criteria: [],
            dependsOn: ["accounts"],
          },
        ],
      }),
    );
  return root;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("offline feature map", () => {
  it("renders actual full feature measurements, shared code, tests, intent and declared ownership without running tests", async () => {
    const root = await fixture();
    const artifact = await writeFeatureMap({ root });
    expect(artifact.report.status).toBe("incomplete");
    expect(artifact.report.issues.join(" ")).toContain("no declared feature boundary");
    expect(artifact.summary.features).toBe(2);
    const account = artifact.graph.nodes.find(
      (node) => node.kind === "feature" && node.label === "Account lookup",
    )!;
    expect(account.cognitive).toBe(
      artifact.report.features[0]!.code.metrics!.cognitive.execution_unit,
    );
    expect(account.details["metrics"]).toEqual(artifact.report.features[0]!.code.metrics);
    expect(
      artifact.report.features[0]!.code.hotspots.some((hotspot) => hotspot.symbol === "normalize"),
    ).toBe(true);
    expect(
      artifact.report.features.every((feature) => feature.testEvidence.status === "not_run"),
    ).toBe(true);
    const shared = artifact.graph.nodes.filter((node) => node.path === "src/shared.ts");
    expect(shared).toHaveLength(1);
    expect(
      artifact.graph.edges.filter((edge) => edge.to === shared[0]!.id && edge.kind === "code"),
    ).toHaveLength(2);
    expect(new Set(artifact.graph.edges.map((edge) => edge.kind))).toEqual(
      new Set(["code", "test", "intent", "ownership", "dependency"]),
    );
    expect(artifact.summary.unmappedCodeFiles).toBeGreaterThan(0);
    expect(artifact.graph.limitations.join(" ")).toContain("not code imports or runtime calls");
    expect(artifact.htmlPath.startsWith(path.join(root, ".untangle", "feature-map"))).toBe(true);
    expect(hash(await readFile(artifact.htmlPath))).toBe(artifact.sha256.html);
    expect(hash(await readFile(artifact.jsonPath))).toBe(artifact.sha256.json);
    expect((await lstat(artifact.jsonPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(artifact.jsonPath, "utf8")).report).toEqual(artifact.report);
  });

  it("reuses byte-identical artifacts without replacing them or changing the project source digest", async () => {
    const root = await fixture();
    const first = await writeFeatureMap({ root });
    const identity = await lstat(first.htmlPath);
    const second = await writeFeatureMap({ root });
    expect(second.htmlPath).toBe(first.htmlPath);
    expect((await lstat(second.htmlPath)).ino).toBe(identity.ino);
    expect(second.report.sourceTreeDigest).toBe(first.report.sourceTreeDigest);
    expect(second.sha256).toEqual(first.sha256);
  });

  it("preserves conflicting existing artifact bytes and rolls back only its own newly created counterpart", async () => {
    const root = await fixture();
    const first = await writeFeatureMap({ root });
    await writeFile(first.htmlPath, "owned by someone else");
    await rm(first.jsonPath);
    await expect(writeFeatureMap({ root })).rejects.toThrow("refusing to overwrite");
    expect(await readFile(first.htmlPath, "utf8")).toBe("owned by someone else");
    await expect(lstat(first.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses metadata directory symlinks without creating artifacts outside the project", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "untangle-map-outside-"));
    roots.push(outside);
    await symlink(outside, path.join(root, ".untangle"));
    await expect(writeFeatureMap({ root })).rejects.toThrow("not symlinks");
    await expect(lstat(path.join(outside, "feature-map"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses artifact symlinks rather than following a foreign file", async () => {
    const root = await fixture();
    const first = await writeFeatureMap({ root });
    const outside = path.join(root, "private.txt");
    await writeFile(outside, "not an artifact");
    // A new ordinary file changes the inventory; freeze the original report for this focused I/O check.
    await rm(first.htmlPath);
    await symlink(outside, first.htmlPath);
    await expect(
      writeFeatureMap({ root }, { analyze: async () => first.report }),
    ).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("not an artifact");
  });

  it("supports a root path alias while storing only under the physical chosen project", async () => {
    const root = await fixture();
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias);
    const result = await writeFeatureMap({ root: alias });
    expect(result.htmlPath.startsWith(root + path.sep)).toBe(true);
    expect(result.report.root).toBe(root);
  });

  it("honestly shows unassigned source paths when no feature manifest exists", async () => {
    const root = await fixture(false);
    const result = await writeFeatureMap({ root });
    expect(result.summary.status).toBe("needs_manifest");
    expect(result.summary.features).toBe(0);
    expect(
      result.graph.nodes.some(
        (node) => node.kind === "unmapped" && node.path === "src/accounts.ts",
      ),
    ).toBe(true);
    expect(result.graph.nodes.every((node) => node.cognitive === undefined)).toBe(true);
    expect(result.graph.edges).toEqual([]);
    expect(result.report.draft?.features).toEqual([]);
  });

  it("detects a changed census instead of binding new unassigned paths to an old source digest", async () => {
    const root = await fixture(false);
    const report = await analyzeProductAlignment({ root });
    let calls = 0;
    await expect(
      writeFeatureMap(
        { root },
        {
          analyze: async () => ({
            ...report,
            sourceTreeDigest: calls++ === 0 ? "before" : "after",
          }),
        },
      ),
    ).rejects.toThrow("sources changed");
    await expect(lstat(path.join(root, ".untangle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels before analysis or writes and propagates cancellation after the analyzer", async () => {
    const root = await fixture();
    const before = new AbortController();
    before.abort(new Error("cancel before"));
    await expect(writeFeatureMap({ root, signal: before.signal })).rejects.toThrow("cancel before");
    const after = new AbortController();
    const report = await analyzeProductAlignment({ root });
    await expect(
      writeFeatureMap(
        { root, signal: after.signal },
        {
          analyze: async () => {
            after.abort(new Error("cancel after"));
            return report;
          },
        },
      ),
    ).rejects.toThrow("cancel after");
    await expect(lstat(path.join(root, ".untangle"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid graph budgets before any analysis or artifact write", async () => {
    const root = await fixture();
    for (const maxNodes of [0, -1, 2001, 1.5, NaN])
      await expect(writeFeatureMap({ root, maxNodes })).rejects.toThrow("maxNodes");
    expect(() => featureMapLimits({ maxEdges: 10001 })).toThrow("maxEdges");
    await expect(lstat(path.join(root, ".untangle"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("bounded feature evidence model", () => {
  it("preserves full metric scope when diagram budgets truncate and never leaves dangling edges", async () => {
    const root = await fixture();
    const report = await analyzeProductAlignment({ root });
    const large: ProductAlignmentReportV1 = {
      ...report,
      features: Array.from({ length: 2400 }, (_, index) => ({
        ...report.features[0]!,
        id: `feature-${index}`,
        title: `Feature ${index}`,
      })),
    };
    const graph = buildFeatureMapGraph(large, { maxNodes: 17, maxEdges: 5 });
    expect(graph.summary.totalNodes).toBeGreaterThan(2400);
    expect(graph.summary.shownNodes).toBe(17);
    expect(graph.summary.truncated).toBe(true);
    expect(graph.edges.length).toBeLessThanOrEqual(5);
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
    for (const node of graph.nodes.filter((candidate) => candidate.kind === "feature"))
      expect(node.details["metrics"]).toEqual(report.features[0]!.code.metrics);
    expect(graph).toEqual(buildFeatureMapGraph(large, { maxNodes: 17, maxEdges: 5 }));
  });

  it("retains declared feature cycles without pretending they are code-import cycles", async () => {
    const root = await fixture();
    const report = await analyzeProductAlignment({ root });
    report.features[0]!.dependsOn = ["handler"];
    report.dependencyCycles = [["accounts", "handler"]];
    const graph = buildFeatureMapGraph(report);
    expect(graph.dependencyCycles).toEqual([["accounts", "handler"]]);
    expect(graph.edges.filter((edge) => edge.kind === "dependency")).toHaveLength(2);
  });

  it("never turns a null feature metric into zero", async () => {
    const root = await fixture();
    const report = await analyzeProductAlignment({ root });
    report.features[0]!.code.metrics = null;
    report.features[0]!.code.complete = false;
    const graph = buildFeatureMapGraph(report);
    const feature = graph.nodes.find((node) => node.label === "Account lookup")!;
    expect(feature.cognitive).toBeUndefined();
    expect(feature.details["metrics"]).toBeNull();
    expect(feature.details["codeComplete"]).toBe(false);
  });
});

describe("self-contained feature map HTML", () => {
  it("keeps hostile labels inert and binds executable assets with CSP hashes", async () => {
    const root = await fixture();
    const report = await analyzeProductAlignment({ root });
    const hostile = '</script><img src="https://outside.invalid" onerror="alert(1)">';
    report.features[0]!.title = hostile;
    const html = createFeatureMapHtml(buildFeatureMapGraph(report));
    expect(html).not.toContain(hostile);
    expect(html).toContain("connect-src 'none'");
    const data = html.match(
      /<script type="application\/json" id="map-data">([^<]+)<\/script>/u,
    )![1]!;
    expect(
      JSON.parse(Buffer.from(data, "base64").toString("utf8")).nodes.some(
        (node: { label: string }) => node.label === hostile,
      ),
    ).toBe(true);
    const script = html.match(/<script>([\s\S]+)<\/script>/u)![1]!;
    const style = html.match(/<style>([\s\S]+)<\/style>/u)![1]!;
    expect(() => new Script(script)).not.toThrow();
    for (const [name, content] of [
      ["script", script],
      ["style", style],
    ])
      expect(html).toContain(
        `${name}-src 'sha256-${createHash("sha256").update(content!).digest("base64")}'`,
      );
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("fetch(");
    expect(script).toContain('setAttribute("aria-label","Repository-relative path")');
  });
});

/** Small DOM model: removing a focused descendant blurs it, just as the browser does.
 * It executes the actual shipped script; it does not claim CSS, browser or visual QA.
 */
type MiniListener = (this: MiniElement, event: Record<string, unknown>) => void;
class MiniElement {
  readonly attributes = new Map<string, string>();
  readonly children: MiniElement[] = [];
  readonly listeners = new Map<string, MiniListener[]>();
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  parentElement: MiniElement | null = null;
  value = "";
  readOnly = false;
  disabled = false;
  hidden = false;
  type = "";
  namespace = "";
  pointerCapture = 0;
  selectionStart = 0;
  selectionEnd = 0;
  private ownText = "";
  constructor(
    readonly tagName: string,
    readonly document: MiniDocument,
  ) {}
  get firstChild(): MiniElement | null {
    return this.children[0] ?? null;
  }
  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(value: string) {
    this.attributes.set("class", value);
  }
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.ownText = value;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.document.ids.set(value, this);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child: MiniElement): MiniElement {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: MiniElement): MiniElement {
    if (child.contains(this.document.activeElement))
      this.document.activeElement = this.document.body;
    this.children.splice(this.children.indexOf(child), 1);
    child.parentElement = null;
    return child;
  }
  contains(node: MiniElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
    const attribute = /^\[([a-z-]+)(?:="([^"]*)")?\]$/u.exec(selector);
    if (attribute)
      return attribute[2] === undefined
        ? this.attributes.has(attribute[1]!)
        : this.getAttribute(attribute[1]!) === attribute[2];
    return this.tagName === selector;
  }
  closest(selector: string): MiniElement | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }
  querySelector(selector: string): MiniElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  focus(): void {
    this.document.activeElement = this;
  }
  select(): void {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
  setPointerCapture(id: number): void {
    this.pointerCapture = id;
  }
  getBoundingClientRect(): { width: number; height: number } {
    return { width: 1000, height: 600 };
  }
  addEventListener(name: string, listener: MiniListener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  dispatch(name: string, fields: Record<string, unknown> = {}): void {
    const event = {
      ...fields,
      target: this,
      preventDefault() {
        return undefined;
      },
      stopPropagation() {
        return undefined;
      },
    };
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener.call(this, event);
  }
}
class MiniDocument {
  readonly ids = new Map<string, MiniElement>();
  readonly body = new MiniElement("body", this);
  readonly listeners = new Map<string, (() => void)[]>();
  readonly frames = new Map<number, (timestamp: number) => void>();
  readonly motionListeners: (() => void)[] = [];
  readonly intersectionListeners: ((
    entries: { target: MiniElement; isIntersecting: boolean }[],
  ) => void)[] = [];
  setMapVisible(visible: boolean): void {
    for (const callback of this.intersectionListeners)
      callback([{ target: this.getElementById("viewport"), isIntersecting: visible }]);
  }
  readonly motion = {
    matches: false,
    addEventListener: (_name: string, callback: () => void) => this.motionListeners.push(callback),
  };
  hidden = false;
  now = 0;
  nextFrame = 1;
  activeElement = this.body;
  addEventListener(name: string, callback: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  dispatch(name: string): void {
    for (const callback of this.listeners.get(name) ?? []) callback();
  }
  stepAnimation(timestamp: number): void {
    this.now = timestamp;
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(timestamp);
  }
  setReducedMotion(matches: boolean): void {
    this.motion.matches = matches;
    for (const callback of this.motionListeners) callback();
  }
  createElement(name: string): MiniElement {
    return new MiniElement(name, this);
  }
  createElementNS(namespace: string, name: string): MiniElement {
    const element = this.createElement(name);
    element.namespace = namespace;
    return element;
  }
  getElementById(id: string): MiniElement {
    const element = this.ids.get(id);
    if (!element) throw new Error(`Missing test DOM element ${id}`);
    return element;
  }
}
function featureClient(graph: FeatureMapGraphV1, reducedMotion = false): MiniDocument {
  const html = createFeatureMapHtml(graph);
  const document = new MiniDocument();
  document.motion.matches = reducedMotion;
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gu)) {
    const element = document.createElement(match[1]!);
    element.setAttribute("id", match[2]!);
    document.body.appendChild(element);
  }
  document.getElementById("map-data").textContent = html.match(
    /<script type="application\/json" id="map-data">([^<]+)<\/script>/u,
  )![1]!;
  document.getElementById("viewport").appendChild(document.getElementById("map"));
  const script = html.match(/<script>([\s\S]+)<\/script>/u)![1]!;
  new Script(script).runInNewContext(
    {
      document,
      TextDecoder,
      Uint8Array,
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      matchMedia: () => document.motion,
      IntersectionObserver: class {
        constructor(
          callback: (entries: { target: MiniElement; isIntersecting: boolean }[]) => void,
        ) {
          document.intersectionListeners.push(callback);
        }
        observe() {
          return undefined;
        }
      },
      performance: { now: () => document.now },
      requestAnimationFrame: (callback: (timestamp: number) => void) => {
        const id = document.nextFrame++;
        document.frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => document.frames.delete(id),
    },
    { timeout: 5000 },
  );
  return document;
}

async function clientGraph(): Promise<FeatureMapGraphV1> {
  return buildFeatureMapGraph(await analyzeProductAlignment({ root: await fixture() }));
}

describe("feature map keyboard focus across actual client redraws", () => {
  it.each(["Enter", " "])(
    "restores the selected SVG node after %j activation replaces its DOM element",
    async (key) => {
      const graph = await clientGraph();
      const document = featureClient(graph);
      const id = graph.nodes[0]!.id;
      expect(document.activeElement).toBe(document.body);
      const old = document.getElementById("map").querySelector(`[data-graph-node="${id}"]`)!;
      old.focus();
      old.dispatch("keydown", { key });
      const current = document.getElementById("map").querySelector(`[data-graph-node="${id}"]`)!;
      expect(current).not.toBe(old);
      expect(current.className).toContain("selected");
      expect(document.activeElement).toBe(current);
    },
  );

  it("restores the accessible-list button after native Enter activation dispatches click", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph);
    const id = graph.nodes[0]!.id;
    const list = document.getElementById("node-list");
    const old = list.querySelector(`[data-list-node="${id}"]`)!;
    old.focus();
    old.dispatch("click", { detail: 0 });
    const current = list.querySelector(`[data-list-node="${id}"]`)!;
    expect(current).not.toBe(old);
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(current);
  });

  it("preserves a search field's focus and its value while filtering the graph", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph);
    const input = document.getElementById("search");
    input.focus();
    input.value = "src/other.ts";
    input.dispatch("input");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("src/other.ts");
    expect(document.getElementById("node-list").children).toHaveLength(1);
    expect(document.getElementById("node-list").textContent).toContain("src/other.ts");
  });

  it("keeps the level filter and layout control focused instead of stealing focus to a node", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph);
    const level = document.getElementById("kind");
    level.focus();
    level.value = "code";
    level.dispatch("change");
    expect(document.activeElement).toBe(level);
    const button = document.getElementById("layout");
    button.focus();
    button.dispatch("click");
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Show 3D wool map");
    const expected = createFeatureLaneLayout(graph.nodes);
    expect(document.getElementById("map").getAttribute("viewBox")).toBe(
      `0 0 ${expected.width} ${expected.height}`,
    );
    for (const node of graph.nodes.filter((candidate) => candidate.kind === "code")) {
      const p = expected.positions[node.id]!;
      expect(
        document
          .getElementById("map")
          .querySelector(`[data-graph-node="${node.id}"]`)!
          .getAttribute("transform"),
      ).toBe(`translate(${p.x} ${p.y})`);
    }
  });

  it("moves focus from a replaced relationship control to the newly selected node's list entry", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph);
    const feature = graph.nodes.find((node) => node.kind === "feature")!;
    const first = document
      .getElementById("node-list")
      .querySelector(`[data-list-node="${feature.id}"]`)!;
    first.focus();
    first.dispatch("click");
    const edge = graph.edges.find((candidate) => candidate.from === feature.id)!;
    const relation = document
      .getElementById("detail")
      .querySelector(`[data-relation-node="${edge.to}"]`)!;
    relation.focus();
    relation.dispatch("click", { detail: 0 });
    expect(document.activeElement).toBe(
      document.getElementById("node-list").querySelector(`[data-list-node="${edge.to}"]`),
    );
  });
});

describe("feature map lane layout bounds", () => {
  it("gives every node a unique lane position beyond 22 same-kind entries and fits all columns", () => {
    const nodes = Object.freeze(
      [
        ...Array.from({ length: 600 }, (_, i) => ({ id: `code-${i}`, kind: "code" as const })),
        ...Array.from({ length: 55 }, (_, i) => ({ id: `feature-${i}`, kind: "feature" as const })),
        ...Array.from({ length: 70 }, (_, i) => ({ id: `test-${i}`, kind: "test" as const })),
      ].map((node) => Object.freeze(node)),
    );
    const layout = createFeatureLaneLayout(nodes);
    const points = Object.values(layout.positions);
    expect(points).toHaveLength(nodes.length);
    expect(new Set(points.map((point) => `${point.x}:${point.y}`)).size).toBe(nodes.length);
    expect(layout.width).toBeGreaterThan(1300);
    expect(
      points.every(
        (point) =>
          point.x >= 50 &&
          point.x < layout.width - 30 &&
          point.y >= 50 &&
          point.y < layout.height - 30,
      ),
    ).toBe(true);
    expect(createFeatureLaneLayout([...nodes].reverse())).toEqual(layout);
    expect(
      nodes
        .filter((node) => node.kind === "code")
        .map((node) => layout.positions[node.id]!.x)
        .some((x, _i, xs) => x !== xs[0]),
    ).toBe(true);
  });

  it("applies the same non-overlapping overflow layout through the actual shipped client", () => {
    const nodes = Array.from({ length: 70 }, (_, i) => ({
      id: `code-${i}`,
      kind: "code" as const,
      label: `src/file-${i}.ts`,
      status: "measured",
      details: { roles: ["code"] },
    }));
    const graph: FeatureMapGraphV1 = {
      schemaVersion: 1,
      sourceTreeDigest: "a".repeat(64),
      nodes,
      edges: [],
      summary: {
        status: "needs_review",
        features: 0,
        shownNodes: 70,
        totalNodes: 70,
        shownEdges: 0,
        totalEdges: 0,
        truncated: false,
        mappedCodeFiles: 70,
        unmappedCodeFiles: 0,
        inventoryFiles: 70,
      },
      limits: { maxNodes: 500, maxEdges: 2000 },
      limitations: [],
      issues: [],
      dependencyCycles: [],
    };
    const document = featureClient(graph);
    const button = document.getElementById("layout");
    button.focus();
    button.dispatch("click");
    const transforms = nodes.map((node) =>
      document
        .getElementById("map")
        .querySelector(`[data-graph-node="${node.id}"]`)!
        .getAttribute("transform"),
    );
    expect(new Set(transforms).size).toBe(70);
    expect(document.activeElement).toBe(button);
  });
});

describe("spatial wool layout and perspective", () => {
  it("places every node in real bounded 3D coordinates deterministically without changing graph evidence", async () => {
    const graph = await clientGraph();
    const frozen = JSON.stringify(graph);
    const points = createFeatureWoolLayout(graph.nodes, graph.edges);
    expect(Object.keys(points)).toHaveLength(graph.nodes.length);
    expect(new Set(Object.values(points).map((point) => point.z)).size).toBeGreaterThan(2);
    expect(
      Object.values(points).every((point) =>
        [point.x, point.y, point.z].every(
          (coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) < 410,
        ),
      ),
    ).toBe(true);
    expect(createFeatureWoolLayout([...graph.nodes].reverse(), [...graph.edges].reverse())).toEqual(
      points,
    );
    expect(JSON.stringify(graph)).toBe(frozen);
    const many = Array.from({ length: 2000 }, (_, index) => ({
      id: `source-${index}`,
      kind: "unmapped" as const,
    }));
    const unassigned = Object.values(createFeatureWoolLayout(many, []));
    expect(new Set(unassigned.map((point) => `${point.x}:${point.y}:${point.z}`)).size).toBe(2000);
  });

  it("rotates and projects depth into screen position and scale with a finite external camera", () => {
    const point = { x: 100, y: 20, z: 200 };
    const front = projectFeaturePoint(point, { yaw: 0, pitch: 0 });
    expect(front).toEqual({ x: 775, y: 435, depth: 200, scale: 1.25 });
    const side = projectFeaturePoint(point, { yaw: Math.PI / 2, pitch: 0 });
    expect(side.depth).toBeCloseTo(-100);
    expect(side.scale).toBeCloseTo(1000 / 1100);
    expect(side.x).not.toBe(front.x);
    expect(side.y).not.toBe(front.y);
    const tilted = projectFeaturePoint(point, { yaw: 0, pitch: Math.PI / 2 });
    expect(tilted.depth).toBeCloseTo(20);
    expect(tilted.y).toBeCloseTo(410 - 200 * tilted.scale);
  });

  it("rotates sampled 3D threads with their projected endpoints without inventing graph edges", () => {
    const from = { x: -200, y: 50, z: 130 };
    const to = { x: 160, y: -90, z: -110 };
    const camera = { yaw: 0.35, pitch: -0.22 };
    const path = createFeatureThread(from, to, camera, 0.7);
    const a = projectFeaturePoint(from, camera),
      b = projectFeaturePoint(to, camera);
    expect(path.startsWith(`M${a.x.toFixed(2)},${a.y.toFixed(2)} `)).toBe(true);
    expect(path.endsWith(`L${b.x.toFixed(2)},${b.y.toFixed(2)}`)).toBe(true);
    expect(path.match(/L/gu)).toHaveLength(18);
    expect(path).not.toContain("NaN");
    expect(createFeatureThread(from, to, { ...camera, yaw: 1 }, 0.7)).not.toBe(path);
  });
});

describe("actual 3D client interactions", () => {
  it("starts with English controls, preserved repository content and no automatic motion", async () => {
    const graph = await clientGraph();
    graph.nodes[0]!.label = "Rechnungen prüfen";
    const html = createFeatureMapHtml(graph);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Interactive 3D feature map");
    expect(html).toContain("Spatial proximity is a layout choice");
    const document = featureClient(graph);
    expect(document.frames.size).toBe(0);
    expect(document.getElementById("node-list").textContent).toContain("Rechnungen prüfen");
    document.getElementById("node-list").children[0]!.dispatch("click");
    expect(document.getElementById("detail").textContent).toContain("Complete feature complexity");
    expect(document.getElementById("ready").textContent).toBe(
      "Local 3D map ready. No network connection.",
    );
  });

  it("changes actual projected node and thread geometry with arrow keys while preserving accessible nodes and focus", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph);
    const viewport = document.getElementById("viewport"),
      map = document.getElementById("map");
    const id = graph.nodes[0]!.id;
    const node = map.querySelector(`[data-graph-node="${id}"]`)!;
    const edge = map.querySelector(`[data-edge="${graph.edges[0]!.id}"]`)!;
    const before = node.getAttribute("transform"),
      thread = edge.getAttribute("d");
    const list = document.getElementById("node-list").children.slice();
    viewport.focus();
    viewport.dispatch("keydown", { key: "ArrowRight" });
    expect(node.getAttribute("transform")).not.toBe(before);
    expect(edge.getAttribute("d")).not.toBe(thread);
    expect(document.getElementById("node-list").children).toEqual(list);
    expect(document.activeElement).toBe(viewport);
    expect(map.querySelector(`[data-graph-node="${id}"]`)).toBe(node);
  });

  it("supports drag rotation, Shift-pan and pointer cancellation without changing nodes", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph);
    const viewport = document.getElementById("viewport"),
      map = document.getElementById("map");
    const node = map.querySelector(`[data-graph-node="${graph.nodes[0]!.id}"]`)!;
    const before = node.getAttribute("transform");
    viewport.dispatch("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    viewport.dispatch("pointermove", { pointerId: 1, clientX: 180, clientY: 125 });
    expect(node.getAttribute("transform")).not.toBe(before);
    viewport.dispatch("pointercancel");
    const after = node.getAttribute("transform");
    viewport.dispatch("pointermove", { pointerId: 1, clientX: 400, clientY: 200 });
    expect(node.getAttribute("transform")).toBe(after);
    const world = map.children[0]!;
    const transform = world.getAttribute("transform");
    viewport.dispatch("pointerdown", { pointerId: 2, clientX: 100, clientY: 100, shiftKey: true });
    viewport.dispatch("pointermove", { pointerId: 2, clientX: 130, clientY: 110 });
    expect(world.getAttribute("transform")).not.toBe(transform);
    expect(node.getAttribute("transform")).toBe(after);
  });

  it("bounds opt-in rotation, pauses on node selection and preserves DOM identity during animation", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph);
    const button = document.getElementById("rotation"),
      map = document.getElementById("map");
    const node = map.querySelector(`[data-graph-node="${graph.nodes[0]!.id}"]`)!;
    const transform = node.getAttribute("transform");
    button.focus();
    button.dispatch("click");
    expect(button.textContent).toBe("Pause rotation");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    document.stepAnimation(16);
    document.stepAnimation(66);
    expect(node.getAttribute("transform")).not.toBe(transform);
    expect(map.querySelector(`[data-graph-node="${graph.nodes[0]!.id}"]`)).toBe(node);
    expect(document.activeElement).toBe(button);
    node.dispatch("click");
    expect(document.frames.size).toBe(0);
    expect(button.textContent).toBe("Start rotation");
    button.dispatch("click");
    document.stepAnimation(90100);
    expect(document.frames.size).toBe(0);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps motion disabled for reduced motion and stops when hidden or the preference changes", async () => {
    const graph = await clientGraph();
    const reduced = featureClient(graph, true);
    expect(reduced.getElementById("rotation").disabled).toBe(true);
    reduced.getElementById("rotation").dispatch("click");
    expect(reduced.frames.size).toBe(0);
    const document = featureClient(graph);
    const button = document.getElementById("rotation");
    button.dispatch("click");
    expect(document.frames.size).toBe(1);
    document.hidden = true;
    document.dispatch("visibilitychange");
    expect(document.frames.size).toBe(0);
    document.hidden = false;
    button.dispatch("click");
    document.setReducedMotion(true);
    expect(button.disabled).toBe(true);
    expect(document.frames.size).toBe(0);
    document.setReducedMotion(false);
    expect(button.disabled).toBe(false);
    expect(document.frames.size).toBe(0);
  });
});

describe("actual feature untangling client", () => {
  it("provides a direct link to the map region and keeps the primary action inside it", async () => {
    const html = createFeatureMapHtml(await clientGraph());
    expect(html).toMatch(
      /<section id="untangle-view" class="map-region"[\s\S]*?<button id="untangle"[\s\S]*?<\/section>/u,
    );
    expect(html.match(/id="untangle-view"/gu)).toHaveLength(1);
  });
  it("moves the existing wool nodes and wires into declared clusters without changing evidence, selection, focus or topology", async () => {
    const graph = await clientGraph();
    const frozen = JSON.stringify(graph);
    const document = featureClient(graph);
    const map = document.getElementById("map"),
      button = document.getElementById("untangle");
    const feature = graph.nodes.find((node) => node.kind === "feature")!;
    map.querySelector(`[data-graph-node="${feature.id}"]`)!.dispatch("click");
    const nodes = new Map(
      graph.nodes.map((node) => [node.id, map.querySelector(`[data-graph-node="${node.id}"]`)!]),
    );
    const edges = new Map(
      graph.edges.map((edge) => [edge.id, map.querySelector(`[data-edge="${edge.id}"]`)!]),
    );
    const original = nodes.get(feature.id)!.getAttribute("transform");
    const originalThread = edges.get(graph.edges[0]!.id)!.getAttribute("d");
    const details = document.getElementById("detail").textContent;
    const list = document.getElementById("node-list").children.slice();
    expect(document.frames.size).toBe(0);
    button.focus();
    button.dispatch("click");
    expect(button.textContent).toBe("Pause untangling");
    document.stepAnimation(0);
    document.stepAnimation(1000);
    expect(nodes.get(feature.id)!.getAttribute("transform")).not.toBe(original);
    expect(edges.get(graph.edges[0]!.id)!.getAttribute("d")).not.toBe(originalThread);
    expect(document.getElementById("rotation").disabled).toBe(true);
    document.stepAnimation(2600);
    expect(button.textContent).toBe("Show tangle");
    expect(document.frames.size).toBe(0);
    const target = createFeatureClusterLayout(graph.nodes, graph.edges);
    for (const node of graph.nodes) {
      expect(map.querySelector(`[data-graph-node="${node.id}"]`)).toBe(nodes.get(node.id));
      const point = projectFeaturePoint(target.positions[node.id]!, { yaw: 0.35, pitch: -0.22 });
      expect(nodes.get(node.id)!.getAttribute("transform")).toBe(
        `translate(${point.x} ${point.y}) scale(${point.scale * 0.65})`,
      );
    }
    for (const edge of graph.edges)
      expect(map.querySelector(`[data-edge="${edge.id}"]`)).toBe(edges.get(edge.id));
    expect(nodes.get(feature.id)!.className).toContain("selected");
    expect(document.activeElement).toBe(button);
    expect(document.getElementById("node-list").children).toEqual(list);
    expect(document.getElementById("detail").textContent).toBe(details);
    expect(document.getElementById("untangle-note").textContent).toContain(
      "Code and metrics are unchanged.",
    );
    expect(JSON.stringify(graph)).toBe(frozen);
  });

  it("pauses, resumes and replays back to the exact original wool map with no residual animation", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph),
      button = document.getElementById("untangle"),
      map = document.getElementById("map");
    const node = map.querySelector(`[data-graph-node="${graph.nodes[0]!.id}"]`)!;
    const original = node.getAttribute("transform");
    button.dispatch("click");
    document.stepAnimation(0);
    document.stepAnimation(650);
    button.dispatch("click");
    const paused = node.getAttribute("transform");
    expect(button.textContent).toBe("Resume untangling");
    expect(document.frames.size).toBe(0);
    document.stepAnimation(50000);
    expect(node.getAttribute("transform")).toBe(paused);
    button.dispatch("click");
    document.stepAnimation(60000);
    document.stepAnimation(61950);
    expect(button.textContent).toBe("Show tangle");
    button.dispatch("click");
    document.stepAnimation(62000);
    document.stepAnimation(64600);
    expect(node.getAttribute("transform")).toBe(original);
    expect(button.textContent).toBe("Untangle by feature");
    expect(document.frames.size).toBe(0);
    button.dispatch("click");
    expect(document.frames.size).toBe(1);
  });

  it("preserves grouping as an instant action under reduced motion and settles a changed motion preference", async () => {
    const graph = await clientGraph();
    for (const initial of [true, false]) {
      const document = featureClient(graph, initial),
        button = document.getElementById("untangle");
      button.focus();
      button.dispatch("click");
      if (!initial) {
        document.stepAnimation(0);
        document.stepAnimation(200);
        document.setReducedMotion(true);
      }
      expect(button.textContent).toBe("Show tangle");
      expect(document.frames.size).toBe(0);
      expect(document.getElementById("map").getAttribute("data-clustered")).toBe("true");
      expect(document.activeElement).toBe(button);
      button.dispatch("click");
      expect(document.getElementById("map").getAttribute("data-clustered")).toBe("false");
      expect(document.frames.size).toBe(0);
    }
  });

  it("pauses while hidden or offscreen and requires an explicit resume", async () => {
    const graph = await clientGraph();
    for (const reason of ["hidden", "offscreen"] as const) {
      const document = featureClient(graph),
        button = document.getElementById("untangle");
      button.dispatch("click");
      document.stepAnimation(0);
      document.stepAnimation(500);
      if (reason === "hidden") {
        document.hidden = true;
        document.dispatch("visibilitychange");
      } else document.setMapVisible(false);
      expect(button.textContent).toBe("Resume untangling");
      expect(document.frames.size).toBe(0);
      button.dispatch("click");
      expect(document.frames.size).toBe(0);
      document.hidden = false;
      document.setMapVisible(true);
      document.dispatch("visibilitychange");
      expect(document.frames.size).toBe(0);
      button.dispatch("click");
      document.stepAnimation(50000);
      document.stepAnimation(52100);
      expect(button.textContent).toBe("Show tangle");
      expect(document.frames.size).toBe(0);
    }
  });

  it("settles camera, filters and selection coherently and cancels on the existing lane mode without racing rotation", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph),
      button = document.getElementById("untangle"),
      map = document.getElementById("map");
    const rotation = document.getElementById("rotation");
    rotation.dispatch("click");
    expect(document.frames.size).toBe(1);
    button.dispatch("click");
    expect(rotation.textContent).toBe("Start rotation");
    expect(document.frames.size).toBe(1);
    document.stepAnimation(0);
    document.stepAnimation(200);
    document.getElementById("zoom-in").dispatch("click");
    expect(button.textContent).toBe("Show tangle");
    expect(document.frames.size).toBe(0);
    expect(map.children[0]!.getAttribute("transform")).toContain("scale(1.2)");
    button.dispatch("click");
    document.stepAnimation(300);
    document.stepAnimation(500);
    const input = document.getElementById("search");
    input.value = "src/other.ts";
    input.focus();
    input.dispatch("input");
    expect(document.frames.size).toBe(0);
    expect(document.activeElement).toBe(input);
    expect(document.getElementById("node-list").children).toHaveLength(1);
    button.dispatch("click");
    document.stepAnimation(600);
    document.stepAnimation(800);
    expect(input.value).toBe("src/other.ts");
    document.getElementById("layout").dispatch("click");
    expect(document.frames.size).toBe(0);
    expect(document.getElementById("layout").textContent).toBe("Show 3D wool map");
    expect(button.textContent).toBe("Untangle by feature");
    const expected = createFeatureLaneLayout(graph.nodes).positions;
    const unmapped = graph.nodes.find((node) => node.path === "src/other.ts")!;
    expect(map.querySelector(`[data-graph-node="${unmapped.id}"]`)!.getAttribute("transform")).toBe(
      `translate(${expected[unmapped.id]!.x} ${expected[unmapped.id]!.y})`,
    );
  });

  it("settles a paused transition when selecting a node and preserves keyboard focus and full source details", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph),
      button = document.getElementById("untangle");
    button.dispatch("click");
    document.stepAnimation(0);
    document.stepAnimation(400);
    button.dispatch("click");
    const feature = graph.nodes.find((node) => node.kind === "feature")!;
    const node = document.getElementById("map").querySelector(`[data-graph-node="${feature.id}"]`)!;
    node.focus();
    node.dispatch("focus");
    node.dispatch("keydown", { key: "Enter" });
    const selected = document
      .getElementById("map")
      .querySelector(`[data-graph-node="${feature.id}"]`)!;
    expect(document.activeElement).toBe(selected);
    expect(selected.className).toContain("selected");
    expect(document.getElementById("detail").textContent).toContain("Complete feature complexity");
    expect(document.getElementById("detail").textContent).toContain(
      JSON.stringify(feature.details, null, 2),
    );
    expect(button.textContent).toBe("Show tangle");
    expect(document.frames.size).toBe(0);
    const rotation = document.getElementById("rotation");
    rotation.dispatch("click");
    expect(rotation.textContent).toBe("Pause rotation");
    expect(document.frames.size).toBe(1);
  });

  it("labels shared and unassigned context independently and retains every cross-feature dependency", async () => {
    const graph = await clientGraph();
    const document = featureClient(graph, true),
      map = document.getElementById("map");
    document.getElementById("untangle").dispatch("click");
    const regions = map.querySelector(".cluster-regions")!;
    expect(regions.textContent).toContain("Shared context");
    expect(regions.textContent).toContain("Unassigned");
    const shared = graph.nodes.filter((node) => node.path === "src/shared.ts");
    expect(shared).toHaveLength(1);
    expect(map.querySelector(`[data-graph-node="${shared[0]!.id}"]`)).not.toBeNull();
    for (const edge of graph.edges.filter((candidate) => candidate.kind === "dependency"))
      expect(map.querySelector(`[data-edge="${edge.id}"]`)!.getAttribute("d")).toMatch(/^M.+ L/u);
    const disabled = featureClient({
      ...graph,
      nodes: [],
      edges: [],
      summary: { ...graph.summary, features: 0, totalNodes: 0, shownNodes: 0 },
    });
    expect(disabled.getElementById("untangle").disabled).toBe(true);
    disabled.getElementById("untangle").dispatch("click");
    expect(disabled.frames.size).toBe(0);
  });
});
