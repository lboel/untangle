/**
 * Regressionstests zu den Welle-3-Befunden 6, 7 und 8 — Impact-Analyse.
 *
 * Alle drei haben dieselbe Wurzel: die Suche kannte je Symbol nur EINEN Weg
 * (den konfidentesten) und hat Buchfuehrung waehrend der Suche statt gegen das
 * Ergebnis gefuehrt. Die Graphen hier sind von Hand gebaut, damit
 * Confidence-Reihenfolge und Sprungzahl auseinanderfallen.
 */
import type { SymbolEdgeV1, SymbolNodeV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createSymbolGraphIndex } from "./graph-index.js";
import { analyzeImpact } from "./impact.js";
import type { SymbolGraphV1 } from "./types.js";

const LIMITS = { maxDepth: 10, maxNodes: 1000, maxEdges: 1000, maxWallTimeMs: 60_000 };

function node(id: string): SymbolNodeV1 {
  return {
    id,
    name: id,
    qualifiedName: id,
    kind: "function",
    repoId: "repo-1",
    refId: "ref-1",
    fileId: `file-${id}`,
    filePath: `${id}.ts`,
    language: "typescript",
    startLine: 1,
    endLine: 1,
    startByte: 0,
    endByte: 1,
    contentHash: "h",
  };
}

/** Kante `from` ruft `to` mit Bindungsgewicht `weight`. */
function edge(from: string, to: string, weight: number, ordinal: number): SymbolEdgeV1 {
  return {
    schemaVersion: 1,
    edgeId: `edge-${String(ordinal)}-${from}-${to}`,
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    fromSymbolId: from,
    kind: "calls",
    toName: to,
    resolution: "heuristic",
    target: {
      symbolId: to,
      qualifiedName: to,
      repoId: "repo-1",
      refId: "ref-1",
      filePath: `${to}.ts`,
    },
    confidence: { value: weight, basis: "heuristic", signals: ["fixture"] },
    crossRepo: false,
    sites: [
      {
        repoId: "repo-1",
        refId: "ref-1",
        filePath: `${from}.ts`,
        range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
      },
    ],
    occurrenceOrdinal: 0,
    graphGeneration: "gen-1",
    graphVersion: "untangle-symbol-graph-v1",
  };
}

function graphOf(
  ids: readonly string[],
  calls: readonly [string, string, number][],
): SymbolGraphV1 {
  const edges = calls.map(([from, to, weight], index) => edge(from, to, weight, index));
  return {
    schemaVersion: 1,
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    graphVersion: "untangle-symbol-graph-v1",
    nodes: ids.map(node),
    edges,
    skipped: { schemaVersion: 1, generationId: "gen-1", entries: [], countsByReason: {} },
    metrics: {
      schemaVersion: 1,
      nodeCount: ids.length,
      edgeCount: edges.length,
      fileCount: ids.length,
      symbolLessFileCount: 0,
      edgesByResolution: { exact: 0, heuristic: edges.length, ambiguous: 0, unresolved: 0 },
      edgesByKind: {
        calls: edges.length,
        references: 0,
        extends: 0,
        implements: 0,
        overrides: 0,
        unresolved: 0,
      },
      exactEdgeRate: 0,
      ambiguousEdgeRate: 0,
      unresolvedEdgeRate: 0,
      crossRepoEdgeCount: 0,
      orphanSymbolCount: 0,
      maxInDegree: 0,
      maxOutDegree: 0,
      topCalledSymbolIds: [],
      skippedCount: 0,
    },
  };
}

describe("depth-Vertrag (Befund 8)", () => {
  // X->R1 (0.1), Y->R2 (0.9), Z->Y (0.9), X->Z (0.9); Wurzeln R1 und R2.
  // Der konfidenteste Weg zu X ist X->Z->Y->R2 (3 Spruenge, 0.729), der
  // kuerzeste X->R1 (1 Sprung, 0.1).
  const index = createSymbolGraphIndex(
    graphOf(
      ["R1", "R2", "X", "Y", "Z"],
      [
        ["X", "R1", 0.1],
        ["Y", "R2", 0.9],
        ["Z", "Y", 0.9],
        ["X", "Z", 0.9],
      ],
    ),
  );

  it("meldet depth als Laenge des BERICHTETEN Pfades — passend zu viaEdgeIds", () => {
    const impact = analyzeImpact(index, { rootSymbolIds: ["R1", "R2"], limits: LIMITS });
    for (const entry of impact.affected) {
      expect(entry.depth).toBe(entry.viaEdgeIds.length);
    }
  });

  it("meldet die Sprungzahl zur naechstgelegenen Wurzel als minDepth", () => {
    const impact = analyzeImpact(index, { rootSymbolIds: ["R1", "R2"], limits: LIMITS });
    const x = impact.affected.find((entry) => entry.symbolId === "X");
    expect(x?.depth).toBe(3);
    expect(x?.minDepth).toBe(1);
    for (const entry of impact.affected) {
      expect(entry.minDepth).toBeLessThanOrEqual(entry.depth);
    }
  });
});

describe("Tiefengrenze (Befund 6)", () => {
  // P->R (0.1), Q->R (0.9), S->Q (0.9), P->S (0.9), X->P (0.9).
  // P liegt EINEN Sprung von R entfernt, auf dem konfidentesten Weg aber
  // drei. X ist ueber X->P->R in zwei Spruengen erreichbar.
  const calls: [string, string, number][] = [
    ["P", "R", 0.1],
    ["Q", "R", 0.9],
    ["S", "Q", 0.9],
    ["P", "S", 0.9],
    ["X", "P", 0.9],
  ];

  it("verliert ein innerhalb der Grenze erreichbares Symbol nicht", () => {
    const index = createSymbolGraphIndex(graphOf(["R", "P", "Q", "S", "X"], calls));
    const impact = analyzeImpact(index, {
      rootSymbolIds: ["R"],
      limits: { ...LIMITS, maxDepth: 3 },
    });
    const x = impact.affected.find((entry) => entry.symbolId === "X");
    expect(x).toBeDefined();
    expect(x?.minDepth).toBe(2);
    // Nichts fehlt, also darf das Ergebnis nicht als abgeschnitten gelten.
    expect(impact.traversal.truncated).toBe(false);
    expect(impact.skipped).toEqual([]);
  });

  it("benennt jedes wirklich abgeschnittene Symbol im Ledger statt nur truncated zu setzen", () => {
    const index = createSymbolGraphIndex(graphOf(["R", "P", "Q", "S", "X"], calls));
    const impact = analyzeImpact(index, {
      rootSymbolIds: ["R"],
      limits: { ...LIMITS, maxDepth: 1 },
    });
    expect(impact.affected.map((entry) => entry.symbolId)).toEqual(["P", "Q"]);
    expect(impact.traversal.truncated).toBe(true);
    expect(impact.traversal.truncationReason).toBe("max_depth");
    const named = impact.skipped.map((entry) => entry.subjectId).sort();
    expect(named).toEqual(["S", "X"]);
    for (const entry of impact.skipped) {
      expect(entry.reason).toBe("excluded_by_configuration");
      expect(entry.detail).toContain("depth limit of 1 hops");
    }
  });
});

describe("Confidence-Schranke (Befund 7)", () => {
  // A->R (0.1), B->R (0.9), A->B (0.9): A wird zuerst schwach (0.1) und
  // danach stark (0.81) erreicht.
  const index = createSymbolGraphIndex(
    graphOf(
      ["R", "A", "B"],
      [
        ["A", "R", 0.1],
        ["B", "R", 0.9],
        ["A", "B", 0.9],
      ],
    ),
  );

  it("meldet kein Symbol als ausgeschlossen, das im Ergebnis steht", () => {
    const impact = analyzeImpact(index, {
      rootSymbolIds: ["R"],
      limits: LIMITS,
      minConfidence: 0.5,
    });
    const reported = new Set(impact.affected.map((entry) => entry.symbolId));
    expect(reported).toEqual(new Set(["A", "B"]));
    for (const entry of impact.skipped) {
      expect(reported.has(entry.subjectId ?? "")).toBe(false);
    }
    expect(impact.skipped).toEqual([]);
  });

  it("meldet ein wirklich ausgeschlossenes Symbol mit seiner BESTEN Wegconfidence", () => {
    const impact = analyzeImpact(index, {
      rootSymbolIds: ["R"],
      limits: LIMITS,
      minConfidence: 0.95,
    });
    expect(impact.affected).toEqual([]);
    const subjects = impact.skipped.map((entry) => entry.subjectId).sort();
    expect(subjects).toEqual(["A", "B"]);
    const b = impact.skipped.find((entry) => entry.subjectId === "B");
    expect(b?.detail).toContain("0.900000");
  });
});
