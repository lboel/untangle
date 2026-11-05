/**
 * Was `untangle flow` behauptet, wird hier gemessen — an einem Symbolgraphen,
 * der aus echtem Quelltext mit den echten Sprachadaptern gebaut wurde.
 *
 * Die drei Zusagen, um die es geht:
 *   1. JEDE KANTE ZEIGT IHRE AUFLOESUNGSART UND IHRE CONFIDENCE.
 *   2. EINE MEHRDEUTIGE KANTE ZEIGT ALLE KANDIDATEN — keiner wird gewaehlt.
 *   3. EIN NAME, DER AUF MEHRERE SYMBOLE PASST, WIRD NICHT GERATEN.
 */
import type { SourceFile } from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import {
  buildSymbolGraph,
  collectSymbolGraphFiles,
  createSymbolGraphIndex,
  detectEntryPoints,
  findAllCallPaths,
  findShortestCallPath,
  analyzeImpact,
  type SymbolGraphIndex,
} from "@untangle-code/symbol-graph";
import { describe, expect, it } from "vitest";

import {
  renderAllPaths,
  renderEntryPoints,
  renderImpact,
  renderShortest,
  renderSymbolOverview,
} from "./render.js";
import { selectSymbolNode } from "./select.js";

const WORKSPACE = "ws-test";
const REPO = "repo-test";
const REF = "repo-test:refs/heads/main";
const GENERATION = "gen-test";

const LIMITS = { maxDepth: 8, maxNodes: 1_000, maxEdges: 5_000, maxWallTimeMs: 5_000 };

/** Baut den Symbolgraphen aus echtem Quelltext — kein handgelegtes Abbild. */
function indexOf(fileMap: Readonly<Record<string, string>>): SymbolGraphIndex {
  const registry = createParserRegistry();
  const inputs = Object.entries(fileMap).map(([path, content]) => {
    const adapter = registry.getAdapterForPath(path, content.slice(0, 4096));
    if (adapter === null) throw new Error(`kein Adapter fuer ${path}`);
    const source: SourceFile = {
      fileId: `F_${path}`,
      repoId: REPO,
      refId: REF,
      path,
      languageId: adapter.languageId,
      content,
      contentHash: `h_${path}`,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
    return { adapter, source, parseResult: adapter.parse(source) };
  });
  const collected = collectSymbolGraphFiles(inputs);
  const graph = buildSymbolGraph({
    workspaceId: WORKSPACE,
    graphGeneration: GENERATION,
    files: collected.files,
  });
  return createSymbolGraphIndex(graph);
}

/** main -> handleOrder -> calculateDiscount, alles in einer Datei. */
const CHAIN = {
  "src/app.ts": [
    "export function calculateDiscount(total: number): number {",
    "  return total * 0.9;",
    "}",
    "export function handleOrder(total: number): number {",
    "  return calculateDiscount(total);",
    "}",
    "export function main(): number {",
    "  return handleOrder(100);",
    "}",
    "",
  ].join("\n"),
};

/** Zweimal derselbe Name in zwei Dateien — der Mehrdeutigkeitsfall. */
const AMBIGUOUS = {
  "src/a.ts": "export function run(): number {\n  return 1;\n}\n",
  "src/b.ts": "export function run(): number {\n  return 2;\n}\n",
  "src/main.ts": "export function main(): number {\n  return run();\n}\n",
};

function idOf(index: SymbolGraphIndex, name: string): string {
  const selection = selectSymbolNode(index.nodes(), name);
  if (selection.status !== "found") throw new Error(`${name}: ${selection.status}`);
  return selection.node.id;
}

describe("Aufrufpfade", () => {
  it("zeigt den kuerzesten Pfad mit Aufloesungsart und Confidence jeder Kante", () => {
    const index = indexOf(CHAIN);
    const result = findShortestCallPath(index, {
      fromSymbolId: idOf(index, "main"),
      toSymbolId: idOf(index, "calculateDiscount"),
      limits: LIMITS,
    });
    const text = renderShortest(index, result).join("\n");

    expect(result.path).not.toBeNull();
    expect(text).toContain("SHORTEST CALL PATH");
    expect(text).toContain("weakest resolution:");
    expect(text).toContain("Confidence");
    expect(text).toMatch(/\[(exact|heuristic|ambiguous|unresolved)\]/u);
    expect(text).toContain("handleOrder");
    expect(text).toContain("calculateDiscount");
    expect(text).toContain("Budgets: maxDepth=8");
  });

  it("nennt bei fehlendem Pfad den Grund statt einer leeren Liste", () => {
    const index = indexOf(CHAIN);
    const result = findShortestCallPath(index, {
      fromSymbolId: idOf(index, "calculateDiscount"),
      toSymbolId: idOf(index, "main"),
      limits: LIMITS,
    });
    const text = renderShortest(index, result).join("\n");
    expect(result.path).toBeNull();
    expect(text).toContain("NO PATH: no_path_within_limits");
  });

  it("listet alle Pfade bis Tiefe N und benennt die Pfadgrenze", () => {
    const index = indexOf(CHAIN);
    const result = findAllCallPaths(index, {
      fromSymbolId: idOf(index, "main"),
      toSymbolId: idOf(index, "calculateDiscount"),
      maxDepth: 8,
      maxPaths: 20,
      maxNodes: LIMITS.maxNodes,
      maxEdges: LIMITS.maxEdges,
    });
    const text = renderAllPaths(index, result).join("\n");
    expect(text).toContain("ALL CALL PATHS UP TO DEPTH 8");
    expect(text).toContain("Path 1");
  });
});

describe("Mehrdeutigkeit", () => {
  it("zeigt bei einer mehrdeutigen Kante ALLE Kandidaten", () => {
    const index = indexOf(AMBIGUOUS);
    const main = index.nodes().find((node) => node.name === "main");
    expect(main).toBeDefined();
    const text = renderSymbolOverview(index, main as never).join("\n");

    expect(text).toContain("[ambiguous]");
    expect(text).toContain("AMBIGUOUS: 2 candidates; none selected");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");
  });

  it("waehlt bei einem mehrdeutigen Symbolnamen keines aus", () => {
    const index = indexOf(AMBIGUOUS);
    const selection = selectSymbolNode(index.nodes(), "run");
    expect(selection.status).toBe("ambiguous");
    if (selection.status !== "ambiguous") return;
    expect(selection.candidates).toHaveLength(2);
  });

  it("macht dieselbe Angabe mit Datei eindeutig", () => {
    const index = indexOf(AMBIGUOUS);
    const selection = selectSymbolNode(index.nodes(), "src/a.ts:run");
    expect(selection.status).toBe("found");
    if (selection.status !== "found") return;
    expect(selection.node.filePath).toBe("src/a.ts");
  });
});

describe("Einstiegspunkte", () => {
  it("weist sich als Heuristik aus und belegt jeden Eintrag", () => {
    const index = indexOf(CHAIN);
    const set = detectEntryPoints(index);
    const text = renderEntryPoints(set, 20).join("\n");

    expect(set.isHeuristic).toBe(true);
    expect(text).toContain("heuristic, not a measurement");
    expect(text).toContain("main");
    expect(text).toMatch(/conventional_name \(\+0\.\d\d\):/u);
    expect(text).toContain("by kind:");
  });
});

describe("Wirkung", () => {
  it("nennt betroffene Symbole mit Confidence, Tiefe und Weg", () => {
    const index = indexOf(CHAIN);
    const result = analyzeImpact(index, {
      rootSymbolIds: [idOf(index, "calculateDiscount")],
      limits: LIMITS,
    });
    const text = renderImpact(index, result, 20).join("\n");

    expect(result.affected.length).toBeGreaterThan(0);
    expect(text).toContain("AFFECTED SYMBOLS");
    expect(text).toContain("handleOrder");
    expect(text).toContain("shortest path");
    expect(text).toContain("Ambiguous edges involved:");
  });

  it("macht die Confidence-Schranke sichtbar, statt still zu filtern", () => {
    const index = indexOf(CHAIN);
    const result = analyzeImpact(index, {
      rootSymbolIds: [idOf(index, "calculateDiscount")],
      limits: LIMITS,
      minConfidence: 0.99,
    });
    const text = renderImpact(index, result, 20).join("\n");
    expect(text).toContain("confidence threshold 0.990");
    if (result.skipped.length > 0) {
      expect(text).toContain("UEBERSPRUNGEN");
    }
  });
});
