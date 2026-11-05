/**
 * Kennzahlen und Nachbarschaft.
 */
import { describe, expect, it } from "vitest";

import { bindingsOfEdge, weakerResolution } from "./bindings.js";
import { buildSymbolGraph } from "./build.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { functionFile } from "./test-support/fixtures.js";
import type { SymbolGraphV1 } from "./types.js";

function mixedGraph(): SymbolGraphV1 {
  return buildSymbolGraph({
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      functionFile({
        fileId: "file-a",
        path: "src/a.ts",
        functions: [
          { name: "root", calls: [{ name: "hub" }, { name: "missing" }, { name: "shared" }] },
          { name: "hub" },
        ],
      }),
      functionFile({ fileId: "file-b", path: "src/b.ts", functions: [{ name: "shared" }] }),
      functionFile({ fileId: "file-c", path: "other/c.ts", functions: [{ name: "shared" }] }),
    ],
  });
}

describe("computeSymbolGraphMetrics", () => {
  it("counts nodes, edges and resolutions", () => {
    const graph = mixedGraph();
    expect(graph.metrics.nodeCount).toBe(4);
    expect(graph.metrics.edgeCount).toBe(3);
    expect(graph.metrics.edgesByResolution.exact).toBe(1);
    expect(graph.metrics.edgesByResolution.ambiguous).toBe(1);
    expect(graph.metrics.edgesByResolution.unresolved).toBe(1);
    expect(graph.metrics.edgesByKind.calls).toBe(3);
  });

  it("reports the resolution rates as shares of all edges", () => {
    const graph = mixedGraph();
    expect(graph.metrics.exactEdgeRate).toBeCloseTo(1 / 3, 10);
    expect(graph.metrics.ambiguousEdgeRate).toBeCloseTo(1 / 3, 10);
    expect(graph.metrics.unresolvedEdgeRate).toBeCloseTo(1 / 3, 10);
  });

  it("counts orphans and degrees over BINDINGS, so both ambiguous candidates count", () => {
    const graph = mixedGraph();
    // "root" hat keine Aufrufer; beide "shared" und "hub" haben genau einen.
    expect(graph.metrics.orphanSymbolCount).toBe(1);
    expect(graph.metrics.maxInDegree).toBe(1);
    expect(graph.metrics.maxOutDegree).toBe(2);
    expect(graph.metrics.topCalledSymbolIds).toHaveLength(3);
  });

  it("returns zero rates for an empty graph instead of NaN", () => {
    const graph = buildSymbolGraph({ workspaceId: "ws-1", graphGeneration: "gen-1", files: [] });
    expect(graph.metrics.exactEdgeRate).toBe(0);
    expect(graph.metrics.unresolvedEdgeRate).toBe(0);
    expect(graph.metrics.topCalledSymbolIds).toEqual([]);
  });
});

describe("createSymbolGraphIndex", () => {
  it("answers callees and callers", () => {
    const graph = mixedGraph();
    const index = createSymbolGraphIndex(graph);
    const root = graph.nodes.find((node) => node.name === "root");
    const hub = graph.nodes.find((node) => node.name === "hub");
    expect(index.outDegree(root?.id ?? "")).toBe(3);
    expect(index.callers(hub?.id ?? "")).toHaveLength(1);
    expect(index.callers(hub?.id ?? "")[0]?.symbolId).toBe(root?.id);
  });

  it("exposes outgoing edges including the unresolved one", () => {
    const graph = mixedGraph();
    const index = createSymbolGraphIndex(graph);
    const root = graph.nodes.find((node) => node.name === "root");
    const outgoing = index.outgoingEdges(root?.id ?? "");
    expect(outgoing).toHaveLength(3);
    expect(outgoing.some((edge) => edge.resolution === "unresolved")).toBe(true);
  });

  it("returns null for unknown ids and empty lists for unknown neighbours", () => {
    const index = createSymbolGraphIndex(mixedGraph());
    expect(index.node("nope")).toBeNull();
    expect(index.edge("nope")).toBeNull();
    expect(index.callees("nope")).toEqual([]);
    expect(index.inDegree("nope")).toBe(0);
  });
});

describe("bindingsOfEdge", () => {
  it("produces one binding per candidate of an ambiguous edge", () => {
    const graph = mixedGraph();
    const ambiguous = graph.edges.find((edge) => edge.resolution === "ambiguous");
    expect(ambiguous).toBeDefined();
    const bindings = bindingsOfEdge(ambiguous!);
    expect(bindings).toHaveLength(2);
    expect(bindings.every((binding) => binding.ambiguous)).toBe(true);
  });

  it("produces no binding for an unresolved edge", () => {
    const graph = mixedGraph();
    const unresolved = graph.edges.find((edge) => edge.resolution === "unresolved");
    expect(bindingsOfEdge(unresolved!)).toEqual([]);
  });
});

describe("weakerResolution", () => {
  it("ranks exact strongest and unresolved weakest", () => {
    expect(weakerResolution("exact", "heuristic")).toBe("heuristic");
    expect(weakerResolution("heuristic", "ambiguous")).toBe("ambiguous");
    expect(weakerResolution("ambiguous", "unresolved")).toBe("unresolved");
    expect(weakerResolution("exact", "exact")).toBe("exact");
  });
});
