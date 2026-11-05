/**
 * Aufrufpfade: kuerzester Pfad, alle Pfade bis Tiefe N — und ein leeres
 * Ergebnis NIE ohne benannten Grund (E4).
 */
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { findAllCallPaths, findShortestCallPath } from "./paths.js";
import { functionFile, GENEROUS_LIMITS } from "./test-support/fixtures.js";
import type { SymbolGraphV1 } from "./types.js";

/**
 * entry → a → target
 * entry → b → c → target
 * entry → target (direkt)
 */
function diamondGraph(): SymbolGraphV1 {
  return buildSymbolGraph({
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      functionFile({
        fileId: "file-d",
        path: "src/d.ts",
        functions: [
          { name: "entry", calls: [{ name: "a" }, { name: "b" }, { name: "target" }] },
          { name: "a", calls: [{ name: "target" }] },
          { name: "b", calls: [{ name: "c" }] },
          { name: "c", calls: [{ name: "target" }] },
          { name: "target" },
          { name: "unreachable" },
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

describe("findShortestCallPath", () => {
  it("finds the shortest path and reports its confidence and weakest resolution", () => {
    const graph = diamondGraph();
    const index = createSymbolGraphIndex(graph);
    const result = findShortestCallPath(index, {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      limits: GENEROUS_LIMITS,
    });
    expect(result.path?.depth).toBe(1);
    expect(result.path?.symbolIds).toEqual([idOf(graph, "entry"), idOf(graph, "target")]);
    expect(result.path?.weakestResolution).toBe("exact");
    expect(result.path?.confidence).toBe(1);
    expect(result.path?.containsAmbiguous).toBe(false);
  });

  it("names the reason when there is no path", () => {
    const graph = diamondGraph();
    const index = createSymbolGraphIndex(graph);
    const result = findShortestCallPath(index, {
      fromSymbolId: idOf(graph, "unreachable"),
      toSymbolId: idOf(graph, "target"),
      limits: GENEROUS_LIMITS,
    });
    expect(result.path).toBeNull();
    expect(result.missReason).toBe("no_path_within_limits");
    expect(result.missDetail).toContain("no call path");
  });

  it("names the reason when an endpoint is unknown", () => {
    const graph = diamondGraph();
    const index = createSymbolGraphIndex(graph);
    expect(
      findShortestCallPath(index, {
        fromSymbolId: "nope",
        toSymbolId: idOf(graph, "target"),
        limits: GENEROUS_LIMITS,
      }).missReason,
    ).toBe("unknown_source_symbol");
    expect(
      findShortestCallPath(index, {
        fromSymbolId: idOf(graph, "entry"),
        toSymbolId: "nope",
        limits: GENEROUS_LIMITS,
      }).missReason,
    ).toBe("unknown_target_symbol");
  });

  it("reports truncation when the depth budget cuts the search", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        functionFile({
          fileId: "file-line",
          path: "src/line.ts",
          functions: [
            { name: "one", calls: [{ name: "two" }] },
            { name: "two", calls: [{ name: "three" }] },
            { name: "three", calls: [{ name: "four" }] },
            { name: "four" },
          ],
        }),
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const result = findShortestCallPath(index, {
      fromSymbolId: idOf(graph, "one"),
      toSymbolId: idOf(graph, "four"),
      limits: { ...GENEROUS_LIMITS, maxDepth: 1 },
    });
    expect(result.path).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_depth");
    expect(result.missDetail).toContain("budget");
  });
});

describe("findAllCallPaths", () => {
  it("returns every path up to the depth bound, deterministically ordered", () => {
    const graph = diamondGraph();
    const index = createSymbolGraphIndex(graph);
    const result = findAllCallPaths(index, {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 5,
      maxPaths: 100,
      maxNodes: 1_000,
      maxEdges: 5_000,
    });
    expect(result.paths.map((path) => path.depth)).toEqual([1, 2, 3]);
    expect(result.droppedPathCount).toBe(0);
    expect(result.pathLimitReached).toBe(false);
    const again = findAllCallPaths(index, {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 5,
      maxPaths: 100,
      maxNodes: 1_000,
      maxEdges: 5_000,
    });
    expect(JSON.stringify(again.paths)).toBe(JSON.stringify(result.paths));
  });

  it("stops at the first confirmed path omitted by the path limit", () => {
    const graph = diamondGraph();
    const index = createSymbolGraphIndex(graph);
    const result = findAllCallPaths(index, {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 5,
      maxPaths: 1,
      maxNodes: 1_000,
      maxEdges: 5_000,
    });
    expect(result.paths).toHaveLength(1);
    expect(result.droppedPathCount).toBe(1);
    expect(result.droppedPathCountExact).toBe(false);
    expect(result.pathLimitReached).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_paths");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("excluded_by_configuration");
    expect(result.skipped[0]?.detail).toContain("maxPaths");
  });

  it("does not revisit a symbol within one path but may reuse it across paths", () => {
    const graph = diamondGraph();
    const index = createSymbolGraphIndex(graph);
    const result = findAllCallPaths(index, {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 5,
      maxPaths: 100,
      maxNodes: 1_000,
      maxEdges: 5_000,
    });
    for (const path of result.paths) {
      expect(new Set(path.symbolIds).size).toBe(path.symbolIds.length);
    }
  });

  it("finds a cycle back to the start symbol", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        functionFile({
          fileId: "file-cycle",
          path: "src/cycle.ts",
          functions: [
            { name: "loopA", calls: [{ name: "loopB" }] },
            { name: "loopB", calls: [{ name: "loopA" }] },
          ],
        }),
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const result = findAllCallPaths(index, {
      fromSymbolId: idOf(graph, "loopA"),
      toSymbolId: idOf(graph, "loopA"),
      maxDepth: 4,
      maxPaths: 10,
      maxNodes: 1_000,
      maxEdges: 5_000,
    });
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.depth).toBe(2);
  });

  it("marks a path through an ambiguous edge as ambiguous", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        functionFile({
          fileId: "file-src",
          path: "src/src.ts",
          functions: [{ name: "start", calls: [{ name: "shared" }] }],
        }),
        functionFile({
          fileId: "file-one",
          path: "src/one.ts",
          functions: [{ name: "shared", calls: [{ name: "sink" }] }],
        }),
        functionFile({
          fileId: "file-two",
          path: "other/two.ts",
          functions: [{ name: "shared" }],
        }),
        functionFile({ fileId: "file-sink", path: "src/sink.ts", functions: [{ name: "sink" }] }),
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const sink = graph.nodes.find((node) => node.name === "sink");
    const start = graph.nodes.find((node) => node.name === "start");
    const result = findAllCallPaths(index, {
      fromSymbolId: start?.id ?? "",
      toSymbolId: sink?.id ?? "",
      maxDepth: 5,
      maxPaths: 10,
      maxNodes: 1_000,
      maxEdges: 5_000,
    });
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.containsAmbiguous).toBe(true);
    expect(result.paths[0]?.weakestResolution).toBe("ambiguous");
    expect(result.paths[0]?.confidence).toBeLessThan(1);
  });

  it("names the reason when nothing was found", () => {
    const graph = diamondGraph();
    const index = createSymbolGraphIndex(graph);
    const result = findAllCallPaths(index, {
      fromSymbolId: idOf(graph, "unreachable"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 3,
      maxPaths: 10,
      maxNodes: 1_000,
      maxEdges: 5_000,
    });
    expect(result.paths).toEqual([]);
    expect(result.missReason).toBe("no_path_within_limits");
    expect(result.missDetail).toBeDefined();
  });

  it("stops a branching search at the global node budget", () => {
    const graph = diamondGraph();
    const result = findAllCallPaths(createSymbolGraphIndex(graph), {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 5,
      maxPaths: 100,
      maxNodes: 2,
      maxEdges: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_nodes");
    expect(result.droppedPathCountExact).toBe(false);
  });

  it("stops a branching search at the global edge budget", () => {
    const graph = diamondGraph();
    const result = findAllCallPaths(createSymbolGraphIndex(graph), {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 5,
      maxPaths: 100,
      maxNodes: 100,
      maxEdges: 1,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_edges");
    expect(result.droppedPathCountExact).toBe(false);
  });

  it("stops at the optional wall-time budget", () => {
    const graph = diamondGraph();
    let tick = 0;
    const result = findAllCallPaths(createSymbolGraphIndex(graph), {
      fromSymbolId: idOf(graph, "entry"),
      toSymbolId: idOf(graph, "target"),
      maxDepth: 5,
      maxPaths: 100,
      maxNodes: 100,
      maxEdges: 100,
      maxWallTimeMs: 1,
      now: () => tick++,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_wall_time");
  });
});
