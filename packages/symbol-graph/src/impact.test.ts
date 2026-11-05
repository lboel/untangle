/**
 * Impact-Analyse: wer ist von einer Aenderung betroffen — und wie sicher ist
 * diese Aussage? Ein Ergebnis mit mehrdeutigen Kanten MUSS das ausweisen.
 */
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { analyzeImpact } from "./impact.js";
import { functionFile, GENEROUS_LIMITS } from "./test-support/fixtures.js";
import type { SymbolGraphV1 } from "./types.js";

function idOf(graph: SymbolGraphV1, name: string): string {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`fixture symbol "${name}" missing`);
  return node.id;
}

/** top → middle → leaf; unrelated haengt an nichts. */
function layeredGraph(): SymbolGraphV1 {
  return buildSymbolGraph({
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      functionFile({
        fileId: "file-layers",
        path: "src/layers.ts",
        functions: [
          { name: "top", calls: [{ name: "middle" }] },
          { name: "middle", calls: [{ name: "leaf" }] },
          { name: "leaf" },
          { name: "unrelated" },
        ],
      }),
    ],
  });
}

describe("analyzeImpact", () => {
  it("reports every transitive caller of the changed symbol", () => {
    const graph = layeredGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "leaf")],
      limits: GENEROUS_LIMITS,
    });
    expect(impact.affected.map((entry) => entry.qualifiedName).sort()).toEqual(["middle", "top"]);
    expect(impact.affected.find((entry) => entry.qualifiedName === "top")?.depth).toBe(2);
    expect(impact.affected.find((entry) => entry.qualifiedName === "middle")?.depth).toBe(1);
  });

  it("excludes the changed symbol itself from the affected list", () => {
    const graph = layeredGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "leaf")],
      limits: GENEROUS_LIMITS,
    });
    expect(impact.affected.map((entry) => entry.symbolId)).not.toContain(idOf(graph, "leaf"));
    expect(impact.traversal.visitedSymbolIds).toContain(idOf(graph, "leaf"));
  });

  it("returns an empty affected list for a symbol nobody calls", () => {
    const graph = layeredGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "unrelated")],
      limits: GENEROUS_LIMITS,
    });
    expect(impact.affected).toEqual([]);
    expect(impact.containsAmbiguousEdges).toBe(false);
  });

  it("keeps confidence 1 along a chain of exact edges", () => {
    const graph = layeredGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "leaf")],
      limits: GENEROUS_LIMITS,
    });
    for (const entry of impact.affected) {
      expect(entry.confidence).toBe(1);
      expect(entry.weakestResolution).toBe("exact");
      expect(entry.throughAmbiguous).toBe(false);
    }
  });

  it("MUST flag a result that travelled over ambiguous edges", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        functionFile({
          fileId: "file-caller",
          path: "src/caller.ts",
          functions: [{ name: "caller", calls: [{ name: "shared" }] }],
        }),
        functionFile({
          fileId: "file-one",
          path: "src/one.ts",
          functions: [{ name: "shared" }],
        }),
        functionFile({
          fileId: "file-two",
          path: "other/two.ts",
          functions: [{ name: "shared" }],
        }),
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const ambiguousTarget = graph.nodes.find(
      (node) => node.name === "shared" && node.filePath === "src/one.ts",
    );
    const impact = analyzeImpact(index, {
      rootSymbolIds: [ambiguousTarget?.id ?? ""],
      limits: GENEROUS_LIMITS,
    });
    expect(impact.affected).toHaveLength(1);
    expect(impact.affected[0]?.throughAmbiguous).toBe(true);
    expect(impact.affected[0]?.weakestResolution).toBe("ambiguous");
    expect(impact.affected[0]?.confidence).toBeLessThan(1);
    expect(impact.containsAmbiguousEdges).toBe(true);
    expect(impact.ambiguousEdgeIds).toHaveLength(1);
  });

  it("drops callers below the confidence floor WITH a ledger entry", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        functionFile({
          fileId: "file-caller",
          path: "src/caller.ts",
          functions: [{ name: "caller", calls: [{ name: "shared" }] }],
        }),
        functionFile({ fileId: "file-one", path: "src/one.ts", functions: [{ name: "shared" }] }),
        functionFile({ fileId: "file-two", path: "other/two.ts", functions: [{ name: "shared" }] }),
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const ambiguousTarget = graph.nodes.find(
      (node) => node.name === "shared" && node.filePath === "other/two.ts",
    );
    const impact = analyzeImpact(index, {
      rootSymbolIds: [ambiguousTarget?.id ?? ""],
      limits: GENEROUS_LIMITS,
      minConfidence: 0.9,
    });
    expect(impact.affected).toEqual([]);
    expect(impact.skipped).toHaveLength(1);
    expect(impact.skipped[0]?.reason).toBe("excluded_by_configuration");
    expect(impact.skipped[0]?.detail).toContain("below the requested minimum");
  });

  it("prefers the more confident path over the shorter one", () => {
    // sink wird direkt von "weak" (mehrdeutig) und ueber "strongMid" (exakt)
    // von "strong" erreicht. Fuer "strong" ist der laengere, sichere Weg der
    // bessere.
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        functionFile({
          fileId: "file-main",
          path: "src/main.ts",
          functions: [
            { name: "strong", calls: [{ name: "strongMid" }] },
            { name: "strongMid", calls: [{ name: "sink" }] },
            { name: "sink" },
          ],
        }),
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "sink")],
      limits: GENEROUS_LIMITS,
    });
    const strong = impact.affected.find((entry) => entry.qualifiedName === "strong");
    expect(strong?.confidence).toBe(1);
    expect(strong?.viaEdgeIds).toHaveLength(2);
  });

  it("orders viaEdgeIds in call direction, ending at the changed symbol", () => {
    const graph = layeredGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "leaf")],
      limits: GENEROUS_LIMITS,
    });
    const top = impact.affected.find((entry) => entry.qualifiedName === "top");
    const middle = impact.affected.find((entry) => entry.qualifiedName === "middle");
    expect(top?.viaEdgeIds).toHaveLength(2);
    expect(middle?.viaEdgeIds).toHaveLength(1);
    // top -> middle -> leaf: die letzte Kante von "top" ist die einzige von "middle".
    expect(top?.viaEdgeIds[1]).toBe(middle?.viaEdgeIds[0]);
  });

  it("puts an unknown root into the skip ledger", () => {
    const graph = layeredGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: ["ghost"],
      limits: GENEROUS_LIMITS,
    });
    expect(impact.affected).toEqual([]);
    expect(impact.skipped[0]?.reason).toBe("missing_index_entry");
  });

  it("truncates on the depth budget with a reason", () => {
    const graph = layeredGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "leaf")],
      limits: { ...GENEROUS_LIMITS, maxDepth: 1 },
    });
    expect(impact.traversal.truncated).toBe(true);
    expect(impact.traversal.truncationReason).toBe("max_depth");
    expect(impact.affected.map((entry) => entry.qualifiedName)).toEqual(["middle"]);
  });
});
