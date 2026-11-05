import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { projectFeaturePoint } from "./feature-3d.js";
import { createFeatureClusterLayout } from "./feature-clusters.js";
import type { FeatureMapEdgeV1, FeatureMapGraphV1, FeatureMapNodeV1 } from "./feature-model.js";

type Node = Pick<FeatureMapNodeV1, "id" | "kind">;
type Edge = Pick<FeatureMapEdgeV1, "from" | "to" | "kind">;
const nodes: readonly Node[] = [
  { id: "a", kind: "feature" },
  { id: "b", kind: "feature" },
  { id: "implementation", kind: "code" },
  { id: "test", kind: "test" },
  { id: "owner", kind: "owner" },
  { id: "intent", kind: "intent" },
  { id: "orphan", kind: "unmapped" },
];
const edges: readonly Edge[] = [
  { from: "a", to: "implementation", kind: "code" },
  { from: "a", to: "test", kind: "test" },
  { from: "owner", to: "a", kind: "ownership" },
  { from: "a", to: "intent", kind: "intent" },
  { from: "a", to: "b", kind: "dependency" },
];

describe("declared feature cluster layout", () => {
  it("groups only declared scope members and keeps each feature anchor distinct", () => {
    const layout = createFeatureClusterLayout(nodes, edges);
    expect(layout.groups.map((group) => [group.kind, group.featureId, group.memberIds])).toEqual([
      ["feature", "a", ["a", "implementation", "intent", "owner", "test"]],
      ["feature", "b", ["b"]],
      ["unassigned", undefined, ["orphan"]],
    ]);
    expect(layout.memberships).toEqual({
      a: ["a"],
      b: ["b"],
      implementation: ["a"],
      intent: ["a"],
      owner: ["a"],
      test: ["a"],
      orphan: [],
    });
    expect(layout.positions["a"]).not.toEqual(layout.positions["b"]);
    expect(layout.positions["a"]).not.toBe(layout.groups[0]!.center);
  });

  it("keeps shared code, tests, owners and intent in shared context with every membership", () => {
    const sharedEdges: Edge[] = [
      ...edges,
      { from: "b", to: "implementation", kind: "code" },
      { from: "b", to: "test", kind: "test" },
      { from: "b", to: "owner", kind: "ownership" },
      { from: "b", to: "intent", kind: "intent" },
      { from: "b", to: "implementation", kind: "code" },
    ];
    const layout = createFeatureClusterLayout(nodes, sharedEdges);
    expect(
      layout.groups.filter((group) => group.kind === "feature").map((group) => group.memberIds),
    ).toEqual([["a"], ["b"]]);
    expect(layout.groups.find((group) => group.kind === "shared")!.memberIds).toEqual([
      "implementation",
      "intent",
      "owner",
      "test",
    ]);
    for (const id of ["implementation", "intent", "owner", "test"])
      expect(layout.memberships[id]).toEqual(["a", "b"]);
    expect(layout.groups.flatMap((group) => group.memberIds).sort()).toEqual(
      nodes.map((node) => node.id).sort(),
    );
  });

  it("preserves a merged file reused as another feature's test", () => {
    const layout = createFeatureClusterLayout(nodes, [
      ...edges,
      { from: "b", to: "implementation", kind: "test" },
    ]);
    expect(layout.memberships["implementation"]).toEqual(["a", "b"]);
    expect(layout.groups.find((group) => group.kind === "shared")!.memberIds).toEqual([
      "implementation",
    ]);
  });

  it("does not infer scope from dependencies, file-to-file edges, incompatible roles or missing endpoints", () => {
    const extra: Edge[] = [
      { from: "b", to: "implementation", kind: "dependency" },
      { from: "b", to: "owner", kind: "test" },
      { from: "b", to: "implementation", kind: "ownership" },
      { from: "implementation", to: "test", kind: "code" },
      { from: "b", to: "missing", kind: "code" },
      { from: "missing", to: "owner", kind: "ownership" },
    ];
    expect(createFeatureClusterLayout(nodes, [...edges, ...extra])).toEqual(
      createFeatureClusterLayout(nodes, edges),
    );
  });

  it("is input-order independent and preserves frozen node and edge evidence", () => {
    const frozenNodes = nodes.map((node) =>
      Object.freeze({
        ...node,
        status: "missing",
        cognitive: 23,
        details: Object.freeze({ role: "declared" }),
      }),
    );
    const frozenEdges = edges.map((edge) => Object.freeze({ ...edge }));
    const before = JSON.stringify({ nodes: frozenNodes, edges: frozenEdges });
    const layout = createFeatureClusterLayout(
      Object.freeze(frozenNodes),
      Object.freeze(frozenEdges),
    );
    expect(
      createFeatureClusterLayout([...frozenNodes].reverse(), [...frozenEdges].reverse()),
    ).toEqual(layout);
    expect(JSON.stringify({ nodes: frozenNodes, edges: frozenEdges })).toBe(before);
  });

  it("keeps a featureless graph explicitly unassigned and handles an empty snapshot", () => {
    const orphanNodes = nodes.filter((node) => node.kind !== "feature");
    const layout = createFeatureClusterLayout(orphanNodes, edges);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]!.kind).toBe("unassigned");
    expect(layout.groups[0]!.memberIds).toHaveLength(orphanNodes.length);
    expect(Object.values(layout.memberships).every((membership) => membership.length === 0)).toBe(
      true,
    );
    expect(createFeatureClusterLayout([], [])).toEqual({
      positions: {},
      groups: [],
      memberships: {},
    });
  });

  it("runs independently when serialized into the shipped browser client", () => {
    const layout = createFeatureClusterLayout(nodes, edges);
    const result = runInNewContext(`(${createFeatureClusterLayout.toString()})(nodes, edges)`, {
      nodes,
      edges,
    }) as unknown;
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(JSON.stringify(layout)));
  });

  it("keeps all 2000 nodes distinct and outside the perspective camera", () => {
    for (const kind of ["feature", "unmapped"] as const) {
      const many = Array.from({ length: 2000 }, (_, index) => ({ id: `node-${index}`, kind }));
      const layout = createFeatureClusterLayout(many, []);
      expect(Object.keys(layout.positions)).toHaveLength(2000);
      expect(
        new Set(Object.values(layout.positions).map((point) => JSON.stringify(point))).size,
      ).toBe(2000);
      for (const point of Object.values(layout.positions)) {
        expect(Math.hypot(point.x, point.y, point.z)).toBeLessThan(550);
        for (const camera of [
          { yaw: 0.35, pitch: -0.22 },
          { yaw: Math.PI / 2, pitch: 1.45 },
        ]) {
          expect(Object.values(projectFeaturePoint(point, camera)).every(Number.isFinite)).toBe(
            true,
          );
        }
      }
    }
  });

  it("retains every node of the real Untangle sample with actual shared and unassigned scope", async () => {
    const envelope = JSON.parse(
      await readFile(
        new URL("../../../../website/src/untangle-example.json", import.meta.url),
        "utf8",
      ),
    ) as { graph: FeatureMapGraphV1 };
    const graph = envelope.graph;
    const before = JSON.stringify(graph);
    const layout = createFeatureClusterLayout(graph.nodes, graph.edges);
    expect(layout.groups.filter((group) => group.kind === "feature")).toHaveLength(25);
    expect(layout.groups.find((group) => group.kind === "shared")!.memberIds).toHaveLength(55);
    expect(layout.groups.find((group) => group.kind === "unassigned")!.memberIds).toHaveLength(101);
    expect(Object.keys(layout.positions)).toHaveLength(1095);
    const memberIds = layout.groups.flatMap((group) => group.memberIds);
    expect(memberIds).toHaveLength(1095);
    expect(new Set(memberIds).size).toBe(1095);
    expect(memberIds.sort()).toEqual(graph.nodes.map((node) => node.id).sort());
    expect(
      new Set(Object.values(layout.positions).map((point) => JSON.stringify(point))).size,
    ).toBe(1095);
    expect(
      Object.values(layout.positions).every((point) => Math.hypot(point.x, point.y, point.z) < 550),
    ).toBe(true);
    for (const point of Object.values(layout.positions)) {
      const projected = projectFeaturePoint(point, { yaw: 0.35, pitch: -0.22 });
      expect(projected.x).toBeGreaterThan(20);
      expect(projected.x).toBeLessThan(1280);
      expect(projected.y).toBeGreaterThan(20);
      expect(projected.y).toBeLessThan(800);
    }
    expect(JSON.stringify(graph)).toBe(before);
  });
});
