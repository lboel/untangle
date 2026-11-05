/**
 * Traversierung: Limits, Zyklenschutz und die Regel, dass ein abgeschnittenes
 * Ergebnis nie wie ein vollstaendiges aussieht (architecture.md §17.4).
 */
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { functionFile, GENEROUS_LIMITS } from "./test-support/fixtures.js";
import { traverseSymbolGraph } from "./traverse.js";
import type { SymbolGraphV1 } from "./types.js";

function chainGraph(): SymbolGraphV1 {
  return buildSymbolGraph({
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      functionFile({
        fileId: "file-chain",
        path: "src/chain.ts",
        functions: [
          { name: "entry", calls: [{ name: "first" }] },
          { name: "first", calls: [{ name: "second" }] },
          { name: "second", calls: [{ name: "third" }] },
          { name: "third", calls: [{ name: "first" }] },
        ],
      }),
    ],
  });
}

function idOf(graph: SymbolGraphV1, name: string): string {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`fixture symbol "${name}" missing`);
  return node.id;
}

describe("traverseSymbolGraph", () => {
  it("walks forward from a root and reports the depth reached", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "entry")],
      direction: "forward",
      limits: GENEROUS_LIMITS,
    });
    expect(traversal.result.visitedSymbolIds).toHaveLength(4);
    expect(traversal.result.depthReached).toBe(3);
    expect(traversal.result.truncated).toBe(false);
    expect(traversal.skipped).toEqual([]);
  });

  it("walks backward to find the callers of a symbol", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "third")],
      direction: "reverse",
      limits: GENEROUS_LIMITS,
    });
    expect(traversal.result.direction).toBe("reverse");
    expect(traversal.result.visitedSymbolIds).toContain(idOf(graph, "entry"));
  });

  it("marks a cycle as a skipped revisit instead of looping forever", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "first")],
      direction: "forward",
      limits: GENEROUS_LIMITS,
    });
    expect(traversal.result.revisitSkippedSymbolIds).toEqual([idOf(graph, "first")]);
  });

  it("truncates on max_depth with a reason", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "entry")],
      direction: "forward",
      limits: { ...GENEROUS_LIMITS, maxDepth: 1 },
    });
    expect(traversal.result.truncated).toBe(true);
    expect(traversal.result.truncationReason).toBe("max_depth");
    expect(traversal.result.visitedSymbolIds).toHaveLength(2);
  });

  it("truncates on max_nodes with a reason", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "entry")],
      direction: "forward",
      limits: { ...GENEROUS_LIMITS, maxNodes: 2 },
    });
    expect(traversal.result.truncated).toBe(true);
    expect(traversal.result.truncationReason).toBe("max_nodes");
  });

  it("truncates on max_edges with a reason", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "entry")],
      direction: "forward",
      limits: { ...GENEROUS_LIMITS, maxEdges: 1 },
    });
    expect(traversal.result.truncated).toBe(true);
    expect(traversal.result.truncationReason).toBe("max_edges");
  });

  it("enforces the wall-time budget with the injected clock only", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    let tick = 0;
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "entry")],
      direction: "forward",
      limits: { ...GENEROUS_LIMITS, maxWallTimeMs: 5 },
      now: () => {
        tick += 10;
        return tick;
      },
    });
    expect(traversal.result.truncated).toBe(true);
    expect(traversal.result.truncationReason).toBe("max_wall_time");
  });

  it("puts an unknown root into the skip ledger instead of ignoring it", () => {
    const graph = chainGraph();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: ["not-a-symbol"],
      direction: "forward",
      limits: GENEROUS_LIMITS,
    });
    expect(traversal.result.visitedSymbolIds).toEqual([]);
    expect(traversal.skipped).toHaveLength(1);
    expect(traversal.skipped[0]?.reason).toBe("missing_index_entry");
    expect(traversal.skipped[0]?.detail).toContain("not-a-symbol");
  });

  it("follows every candidate of an ambiguous edge", () => {
    const caller = functionFile({
      fileId: "file-caller",
      path: "src/caller.ts",
      functions: [{ name: "caller", calls: [{ name: "target" }] }],
    });
    const one = functionFile({
      fileId: "file-one",
      path: "src/one.ts",
      functions: [{ name: "target" }],
    });
    const two = functionFile({
      fileId: "file-two",
      path: "other/two.ts",
      functions: [{ name: "target" }],
    });
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [caller, one, two],
    });
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "caller")],
      direction: "forward",
      limits: GENEROUS_LIMITS,
    });
    expect(traversal.result.visitedSymbolIds).toHaveLength(3);
    expect(traversal.result.edgeIds).toHaveLength(1);
  });
});
