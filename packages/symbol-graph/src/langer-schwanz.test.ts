/**
 * Der lange Schwanz aus BUILD_PLAN §25 fuer `symbol-graph`: WP-179.
 *
 * Die Kante behauptete `exact`, Konfidenz 1, `deterministic` und das Signal
 * `unique_export` — auch dann, wenn der Treffer allein ueber `node.name`
 * zustande kam und die Zieldatei diesen Namen nirgends exportiert. Der
 * Namenstreffer ist eine Vermutung; als Beweis ausgegeben ist er eine falsche
 * Aussage ueber fremden Code.
 */
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { analyzeImpact } from "./impact.js";
import { makeFile } from "./test-support/fixtures.js";
import type { ResolvedImportTargetV1, SymbolGraphBuildInput } from "./types.js";

const MAIN = 'import { run } from "./lib";\n\nexport function main() {\n  run();\n}\n';

function mainFile() {
  return makeFile({
    fileId: "file-main",
    path: "src/main.ts",
    content: MAIN,
    symbols: [{ name: "main", snippet: "export function main() {\n  run();\n}" }],
    calls: [{ calleeName: "run", snippet: "run();" }],
    imports: [{ specifier: "./lib", bindings: ["run<-run"] }],
  });
}

function input(files: SymbolGraphBuildInput["files"]): SymbolGraphBuildInput {
  const resolved: ResolvedImportTargetV1[] = [
    { fromFileId: "file-main", specifier: "./lib", toFileId: "file-lib" },
  ];
  return { workspaceId: "ws-1", graphGeneration: "gen-1", files, resolvedImports: resolved };
}

describe("WP-179 — 'unique_export' verlangt einen Export, nicht nur einen Namen", () => {
  it("behauptet NICHT exact, wenn die Zieldatei den Namen nirgends exportiert", () => {
    const lib = makeFile({
      fileId: "file-lib",
      path: "src/lib.ts",
      content: "function run() {\n  return 1;\n}\n",
      // Ein Symbol namens `run` — aber OHNE exportierten Namen.
      symbols: [{ name: "run", snippet: "function run() {\n  return 1;\n}" }],
    });
    const graph = buildSymbolGraph(input([mainFile(), lib]));
    const edge = graph.edges.find((candidate) => candidate.toName === "run");

    expect(edge).toBeDefined();
    expect(edge?.resolution, "ein Namenstreffer ist kein Beweis").not.toBe("exact");
    expect(edge?.confidence.basis).toBe("heuristic");
    expect(edge?.confidence.signals).not.toContain("unique_export");
    // Die Unsicherheit wird BENANNT, nicht nur weggelassen.
    expect(edge?.confidence.signals).toContain("export_not_declared");
  });

  it("behauptet weiterhin exact, wenn die Zieldatei den Namen wirklich exportiert", () => {
    const lib = makeFile({
      fileId: "file-lib",
      path: "src/lib.ts",
      content: "export function run() {\n  return 1;\n}\n",
      symbols: [
        {
          name: "run",
          snippet: "export function run() {\n  return 1;\n}",
          exportedNames: ["run"],
        },
      ],
    });
    const graph = buildSymbolGraph(input([mainFile(), lib]));
    const edge = graph.edges.find((candidate) => candidate.toName === "run");

    expect(edge?.resolution).toBe("exact");
    expect(edge?.confidence.basis).toBe("deterministic");
    expect(edge?.confidence.signals).toContain("unique_export");
  });

  it("waehlt das EXPORTIERTE Symbol, wenn daneben ein gleichnamiges internes steht", () => {
    const lib = makeFile({
      fileId: "file-lib",
      path: "src/lib.ts",
      content: "function run() {\n  return 1;\n}\n\nfunction inner() {\n  return 2;\n}\n",
      symbols: [
        { name: "run", snippet: "function run() {\n  return 1;\n}" },
        {
          name: "inner",
          snippet: "function inner() {\n  return 2;\n}",
          exportedNames: ["run"],
        },
      ],
    });
    const graph = buildSymbolGraph(input([mainFile(), lib]));
    const edge = graph.edges.find((candidate) => candidate.toName === "run");

    expect(edge?.resolution).toBe("exact");
    expect(edge?.target?.qualifiedName).toBe("inner");
  });
});

describe("WP-180 — ein Zeitbudget, das ohne Uhr schweigend nicht gilt, ist keine Grenze", () => {
  const lib = () =>
    makeFile({
      fileId: "file-lib",
      path: "src/lib.ts",
      content: "export function run() {\n  return 1;\n}\n",
      symbols: [
        { name: "run", snippet: "export function run() {\n  return 1;\n}", exportedNames: ["run"] },
      ],
    });

  it("greift auch OHNE uebergebene Uhr", () => {
    const graph = buildSymbolGraph(input([mainFile(), lib()]));
    const index = createSymbolGraphIndex(graph);
    const roots = graph.nodes.map((node) => node.id);

    // maxWallTimeMs: -1 ist schon beim ERSTEN Blick ueberschritten, egal wie
    // schnell die Maschine ist. Frueher blieb das folgenlos, weil `now`
    // fehlte — die Grenze stand im Vertrag und tat nichts.
    const result = analyzeImpact(index, {
      rootSymbolIds: roots,
      limits: { maxDepth: 8, maxNodes: 1000, maxEdges: 1000, maxWallTimeMs: -1 },
    });

    expect(result.traversal.truncated).toBe(true);
    expect(result.traversal.truncationReason).toBe("max_wall_time");
  });

  it("laesst ein ausreichendes Budget unangetastet", () => {
    const graph = buildSymbolGraph(input([mainFile(), lib()]));
    const index = createSymbolGraphIndex(graph);
    const result = analyzeImpact(index, {
      rootSymbolIds: graph.nodes.map((node) => node.id),
      limits: { maxDepth: 8, maxNodes: 1000, maxEdges: 1000, maxWallTimeMs: 60_000 },
    });
    expect(result.traversal.truncated).toBe(false);
  });
});
