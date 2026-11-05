import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  createCategoryClusterLayout,
  type CategoryClusterDimension,
  type CategoryClusterNode,
} from "./category-clusters.js";
import { projectFeaturePoint } from "./feature-3d.js";
import type { FeatureMapEdgeV1, FeatureMapGraphV1 } from "./feature-model.js";

type Edge = Pick<FeatureMapEdgeV1, "from" | "to" | "kind">;
const nodes: readonly CategoryClusterNode[] = [
  { id: "feature-a", kind: "feature" },
  { id: "feature-b", kind: "feature" },
  { id: "code-a", kind: "code", path: "packages/alpha/src/a.ts" },
  { id: "code-b", kind: "code", path: "packages/beta/src/b.ts" },
  {
    id: "mixed",
    kind: "code",
    path: "packages/shared/src/scope.test.ts",
    details: { roles: ["code", "test"] },
  },
  { id: "test-a", kind: "test", path: "packages/alpha/src/a.test.ts" },
  { id: "owner-a", kind: "owner", label: "Role A", status: "declared" },
  { id: "owner-b", kind: "owner", label: "role.missing", status: "missing" },
  { id: "vision", kind: "intent", path: "vision.md" },
  { id: "spec", kind: "intent", path: "spec.md" },
  { id: "unmapped", kind: "unmapped", path: "apps/web/src/loose.ts" },
];
const edges: readonly Edge[] = [
  { from: "feature-a", to: "code-a", kind: "code" },
  { from: "feature-b", to: "code-b", kind: "code" },
  { from: "feature-a", to: "mixed", kind: "code" },
  { from: "feature-b", to: "mixed", kind: "test" },
  { from: "feature-a", to: "test-a", kind: "test" },
  { from: "feature-a", to: "owner-a", kind: "ownership" },
  { from: "feature-b", to: "owner-b", kind: "ownership" },
  { from: "feature-a", to: "vision", kind: "intent" },
  { from: "feature-a", to: "spec", kind: "intent" },
  { from: "feature-b", to: "spec", kind: "intent" },
  { from: "feature-a", to: "feature-b", kind: "dependency" },
];
const dimensions: CategoryClusterDimension[] = ["code", "test", "owner", "intent", "unmapped"];

describe("factual category grouping", () => {
  it("groups actual code areas including unassigned paths and leaves primary files in their own directory", () => {
    const layout = createCategoryClusterLayout(nodes, edges, "code");
    expect(
      layout.groups.filter((group) => group.kind === "category").map((group) => group.label),
    ).toEqual(["apps/web", "packages/alpha", "packages/beta", "packages/shared"]);
    expect(layout.memberships["code-a"]).toEqual(["code:packages/alpha"]);
    expect(layout.memberships["mixed"]).toEqual(["code:packages/shared"]);
    expect(layout.memberships["unmapped"]).toEqual(["code:apps/web"]);
    expect(layout.memberships["feature-a"]).toEqual([
      "code:packages/alpha",
      "code:packages/shared",
    ]);
    expect(layout.memberships["feature-b"]).toEqual(["code:packages/beta"]);
    expect(layout.memberships["owner-b"]).toEqual(["code:packages/beta"]);
    expect(layout.groups.find((group) => group.kind === "shared")!.memberIds).toContain("test-a");
  });

  it("uses declared test edges and preserves files with merged code and test roles", () => {
    const layout = createCategoryClusterLayout(nodes, edges, "test");
    expect(layout.memberships["mixed"]).toEqual(["test:packages/shared"]);
    expect(layout.memberships["test-a"]).toEqual(["test:packages/alpha"]);
    expect(layout.memberships["feature-a"]).toEqual(["test:packages/alpha"]);
    expect(layout.memberships["feature-b"]).toEqual(["test:packages/shared"]);
    expect(layout.memberships["code-a"]).toEqual(["test:packages/alpha"]);
    expect(layout.memberships["unmapped"]).toEqual([]);
    expect(layout.groups.find((group) => group.kind === "unassigned")!.label).toBe(
      "Outside declared test context",
    );
  });

  it("shows declared ownership context without turning a missing role into confirmed ownership", () => {
    const layout = createCategoryClusterLayout(nodes, edges, "owner");
    expect(layout.groups.find((group) => group.id === "owner:owner-b")!.label).toBe(
      "role.missing (missing ownership)",
    );
    expect(layout.memberships["code-a"]).toEqual(["owner:owner-a"]);
    expect(layout.memberships["code-b"]).toEqual(["owner:owner-b"]);
    expect(layout.memberships["mixed"]).toEqual(["owner:owner-a", "owner:owner-b"]);
    expect(layout.memberships["owner-a"]).toEqual(["owner:owner-a"]);
    expect(layout.description).toContain("do not establish file ownership");
    expect(layout.groups.find((group) => group.kind === "unassigned")!.label).toBe(
      "No declared ownership context",
    );
  });

  it("groups vision and specification anchors by source path and keeps multi-source context shared", () => {
    const layout = createCategoryClusterLayout(nodes, edges, "intent");
    expect(
      layout.groups.filter((group) => group.kind === "category").map((group) => group.label),
    ).toEqual(["spec.md", "vision.md"]);
    expect(layout.memberships["vision"]).toEqual(["intent:vision.md"]);
    expect(layout.memberships["spec"]).toEqual(["intent:spec.md"]);
    expect(layout.memberships["feature-a"]).toEqual(["intent:spec.md", "intent:vision.md"]);
    expect(layout.memberships["feature-b"]).toEqual(["intent:spec.md"]);
    expect(layout.memberships["mixed"]).toEqual(["intent:spec.md", "intent:vision.md"]);
    expect(layout.description).toContain("not semantic similarity");
  });

  it("groups only actual unassigned files and keeps every declared node as separate context", () => {
    const layout = createCategoryClusterLayout(nodes, edges, "unmapped");
    expect(layout.groups.map((group) => [group.label, group.memberIds])).toEqual([
      ["apps/web", ["unmapped"]],
      [
        "Declared context",
        nodes
          .filter((node) => node.id !== "unmapped")
          .map((node) => node.id)
          .sort(),
      ],
    ]);
    for (const node of nodes.filter((node) => node.id !== "unmapped"))
      expect(layout.memberships[node.id]).toEqual([]);
  });

  it("does not derive category context from dependencies, incompatible roles or missing endpoints", () => {
    const wrong: Edge[] = [
      { from: "feature-b", to: "owner-a", kind: "test" },
      { from: "feature-b", to: "vision", kind: "ownership" },
      { from: "feature-b", to: "code-a", kind: "dependency" },
      { from: "code-a", to: "owner-b", kind: "code" },
      { from: "missing", to: "code-a", kind: "code" },
      { from: "feature-b", to: "missing", kind: "ownership" },
    ];
    for (const dimension of dimensions) {
      const baseline = createCategoryClusterLayout(nodes, edges, dimension);
      expect(createCategoryClusterLayout(nodes, [...edges, ...wrong], dimension)).toEqual(baseline);
      expect(
        createCategoryClusterLayout(
          nodes,
          edges.filter((edge) => edge.kind !== "dependency"),
          dimension,
        ),
      ).toEqual(baseline);
    }
  });

  it("keeps real shared and unassigned directory names distinct from context group identities", () => {
    const namedDirectories: CategoryClusterNode[] = [
      { id: "feature", kind: "feature" },
      { id: "one", kind: "code", path: "shared/a.ts" },
      { id: "two", kind: "code", path: "unassigned/b.ts" },
      { id: "outside", kind: "owner" },
    ];
    const declared: Edge[] = [
      { from: "feature", to: "one", kind: "code" },
      { from: "feature", to: "two", kind: "code" },
    ];
    const layout = createCategoryClusterLayout(namedDirectories, declared, "code");
    expect(layout.groups).toHaveLength(4);
    expect(new Set(layout.groups.map((group) => group.id)).size).toBe(4);
    expect(layout.groups.find((group) => group.label === "shared")!.memberIds).toEqual(["one"]);
    expect(layout.groups.find((group) => group.label === "unassigned")!.memberIds).toEqual(["two"]);
    expect(layout.groups.find((group) => group.kind === "shared")!.memberIds).toEqual(["feature"]);
    expect(layout.groups.find((group) => group.kind === "unassigned")!.memberIds).toEqual([
      "outside",
    ]);
  });

  it.each(["code", "test", "intent", "unmapped"] as const)(
    "keeps literal missing-path names separate from absent %s paths in either input order",
    (dimension) => {
      for (const emptyPath of [false, true]) {
        const missing: CategoryClusterNode = {
          id: "a-pathless",
          kind: dimension,
          ...(emptyPath ? { path: "" } : {}),
        };
        const literal: CategoryClusterNode = {
          id: "z-literal",
          kind: dimension,
          path: dimension === "intent" ? "(no source path)" : "(no source path)/entry.ts",
        };
        const layout = createCategoryClusterLayout([missing, literal], [], dimension);
        const reversed = createCategoryClusterLayout([literal, missing], [], dimension);
        expect(reversed).toEqual(layout);
        expect(layout.groups).toHaveLength(2);
        expect(new Set(layout.groups.map((group) => group.id)).size).toBe(2);
        expect(
          layout.groups.find((group) => group.id === `missing:${dimension}`)!.memberIds,
        ).toEqual(["a-pathless"]);
        expect(
          layout.groups.find((group) => group.id === `${dimension}:(no source path)`)!.memberIds,
        ).toEqual(["z-literal"]);
        expect(layout.memberships["a-pathless"]).toEqual([`missing:${dimension}`]);
        expect(layout.memberships["z-literal"]).toEqual([`${dimension}:(no source path)`]);
      }
    },
  );

  it("keeps ownership identities independent of missing or literal source paths", () => {
    const owners: CategoryClusterNode[] = [
      { id: "literal-role", kind: "owner", path: "(no source path)" },
      { id: "pathless-role", kind: "owner" },
    ];
    const layout = createCategoryClusterLayout(owners, [], "owner");
    expect(layout.groups.map((group) => group.id)).toEqual([
      "owner:literal-role",
      "owner:pathless-role",
    ]);
    expect(layout.memberships["literal-role"]).toEqual(["owner:literal-role"]);
    expect(layout.memberships["pathless-role"]).toEqual(["owner:pathless-role"]);
    expect(createCategoryClusterLayout([...owners].reverse(), [], "owner")).toEqual(layout);
  });

  it("uses only file role facts for merged files and labels unknown paths explicitly", () => {
    const special: CategoryClusterNode[] = [
      { id: "root", kind: "code", path: "entry.ts" },
      { id: "windows", kind: "code", path: "src\\settings\\entry.ts" },
      { id: "unknown", kind: "code" },
      {
        id: "merged",
        kind: "test",
        path: "tests/cases/a.ts",
        details: { roles: ["code", "test"] },
      },
      { id: "owner", kind: "owner", details: { roles: ["code"] } },
    ];
    const layout = createCategoryClusterLayout(special, [], "code");
    expect(
      layout.groups.filter((group) => group.kind === "category").map((group) => group.label),
    ).toEqual(["Files without a source path", "Repository root", "src/settings", "tests/cases"]);
    expect(layout.memberships["owner"]).toEqual([]);
    expect(layout.memberships["merged"]).toEqual(["code:tests/cases"]);
  });

  it("preserves frozen inputs and is independent of input and edge direction order", () => {
    const frozenNodes = Object.freeze(nodes.map((node) => Object.freeze({ ...node })));
    const frozenEdges = Object.freeze(edges.map((edge) => Object.freeze({ ...edge })));
    const original = JSON.stringify({ nodes: frozenNodes, edges: frozenEdges });
    for (const dimension of dimensions) {
      const layout = createCategoryClusterLayout(frozenNodes, frozenEdges, dimension);
      expect(
        createCategoryClusterLayout(
          [...frozenNodes].reverse(),
          [...frozenEdges].reverse(),
          dimension,
        ),
      ).toEqual(layout);
      expect(
        createCategoryClusterLayout(
          frozenNodes,
          frozenEdges.map((edge) => ({ ...edge, from: edge.to, to: edge.from })),
          dimension,
        ),
      ).toEqual(layout);
      expect(layout.groups.flatMap((group) => group.memberIds).sort()).toEqual(
        nodes.map((node) => node.id).sort(),
      );
    }
    expect(JSON.stringify({ nodes: frozenNodes, edges: frozenEdges })).toBe(original);
  });

  it("keeps empty and anchorless graphs explicit and rejects an unknown category", () => {
    for (const dimension of dimensions) {
      const empty = createCategoryClusterLayout([], [], dimension);
      expect(empty.positions).toEqual({});
      expect(empty.groups).toEqual([]);
      expect(empty.memberships).toEqual({});
      const anchorless = createCategoryClusterLayout(
        [{ id: "only-feature", kind: "feature" }],
        [],
        dimension,
      );
      expect(anchorless.groups).toHaveLength(1);
      expect(anchorless.groups[0]!.kind).toBe("unassigned");
      expect(anchorless.groups[0]!.memberIds).toEqual(["only-feature"]);
    }
    expect(() =>
      createCategoryClusterLayout(nodes, edges, "unknown" as CategoryClusterDimension),
    ).toThrow("Unknown grouping category");
  });

  it("runs independently after serialization into the offline browser client", () => {
    for (const dimension of dimensions) {
      const actual = runInNewContext(
        `(${createCategoryClusterLayout.toString()})(nodes,edges,dimension)`,
        { nodes, edges, dimension },
      ) as unknown;
      expect(JSON.parse(JSON.stringify(actual))).toEqual(
        JSON.parse(JSON.stringify(createCategoryClusterLayout(nodes, edges, dimension))),
      );
    }
  });

  it("keeps 2000 category anchors distinct and outside the perspective camera", () => {
    for (const dimension of ["code", "owner", "intent", "unmapped"] as const) {
      const many: CategoryClusterNode[] = Array.from({ length: 2000 }, (_, index) => ({
        id: `node-${index}`,
        kind: dimension,
        path: `area-${index}/scope/file.ts`,
      }));
      const layout = createCategoryClusterLayout(many, [], dimension);
      expect(Object.keys(layout.positions)).toHaveLength(2000);
      expect(
        new Set(Object.values(layout.positions).map((point) => JSON.stringify(point))).size,
      ).toBe(2000);
      for (const point of Object.values(layout.positions)) {
        expect(Math.hypot(point.x, point.y, point.z)).toBeLessThan(550);
        expect(
          Object.values(projectFeaturePoint(point, { yaw: Math.PI / 2, pitch: 1.45 })).every(
            Number.isFinite,
          ),
        ).toBe(true);
      }
    }
  });

  it("preserves every real Untangle node, edge, measurement and status in every category", async () => {
    const { graph } = JSON.parse(
      await readFile(
        new URL("../../../../website/src/untangle-example.json", import.meta.url),
        "utf8",
      ),
    ) as { graph: FeatureMapGraphV1 };
    const before = JSON.stringify(graph);
    for (const dimension of dimensions) {
      const layout = createCategoryClusterLayout(graph.nodes, graph.edges, dimension);
      expect(Object.keys(layout.positions)).toHaveLength(1095);
      const ids = layout.groups.flatMap((group) => group.memberIds);
      expect(ids).toHaveLength(1095);
      expect(new Set(ids).size).toBe(1095);
      expect(ids.sort()).toEqual(graph.nodes.map((node) => node.id).sort());
      expect(
        new Set(Object.values(layout.positions).map((point) => JSON.stringify(point))).size,
      ).toBe(1095);
      for (const point of Object.values(layout.positions)) {
        expect(Math.hypot(point.x, point.y, point.z)).toBeLessThan(550);
        const projected = projectFeaturePoint(point, { yaw: 0.35, pitch: -0.22 });
        expect(projected.x).toBeGreaterThan(20);
        expect(projected.x).toBeLessThan(1280);
        expect(projected.y).toBeGreaterThan(20);
        expect(projected.y).toBeLessThan(800);
      }
      if (dimension === "owner")
        expect(layout.groups.filter((group) => group.kind === "category")).toHaveLength(25);
      if (dimension === "intent")
        expect(
          layout.groups.filter((group) => group.kind === "category").map((group) => group.label),
        ).toEqual(["extensions.md", "spec.md", "vision.md"]);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });
});
