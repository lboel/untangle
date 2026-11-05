/**
 * Zwei Auslassungen derselben Klasse wie die Welle-3-Befunde, die kein
 * Pruefer gezeigt hat: eine Grenze laesst etwas zurueck und nur ein
 * `truncated`-Flag deutet darauf hin, bzw. zwei widersprechende Auskuenfte
 * werden stumm auf eine reduziert. E4 verlangt in beiden Faellen den
 * BENANNTEN Eintrag.
 */
import { validateSkipLedger } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { functionFile, GENEROUS_LIMITS, makeFile } from "./test-support/fixtures.js";
import { traverseSymbolGraph } from "./traverse.js";
import type { SymbolGraphV1 } from "./types.js";

function chain(): SymbolGraphV1 {
  return buildSymbolGraph({
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      functionFile({
        fileId: "file-chain",
        path: "src/chain.ts",
        functions: [
          { name: "one", calls: [{ name: "two" }] },
          { name: "two", calls: [{ name: "three" }] },
          { name: "three" },
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

describe("traverseSymbolGraph benennt, was eine Grenze zurueckliess", () => {
  it("benennt die wegen maxNodes nie besuchte Wurzel", () => {
    const graph = chain();
    const index = createSymbolGraphIndex(graph);
    const roots = [idOf(graph, "one"), idOf(graph, "two"), idOf(graph, "three")].sort();
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: roots,
      direction: "forward",
      limits: { ...GENEROUS_LIMITS, maxNodes: 2 },
    });
    expect(traversal.result.truncated).toBe(true);
    expect(traversal.result.truncationReason).toBe("max_nodes");
    const named = traversal.skipped.map((entry) => entry.subjectId);
    const visited = new Set(traversal.result.visitedSymbolIds);
    expect(named.length).toBeGreaterThan(0);
    for (const entry of traversal.skipped) {
      expect(visited.has(entry.subjectId ?? "")).toBe(false);
      expect(entry.reason).toBe("excluded_by_configuration");
      expect(entry.detail).toContain("node limit of 2");
    }
    expect(
      validateSkipLedger({
        schemaVersion: 1,
        generationId: "gen-1",
        entries: traversal.skipped,
        countsByReason: {},
      }).length,
    ).toBeLessThanOrEqual(1);
  });

  it("benennt das Symbol jenseits der Tiefengrenze statt nur truncated zu setzen", () => {
    const graph = chain();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "one")],
      direction: "forward",
      limits: { ...GENEROUS_LIMITS, maxDepth: 1 },
    });
    expect(traversal.result.truncated).toBe(true);
    expect(traversal.skipped.map((entry) => entry.subjectId)).toEqual([idOf(graph, "three")]);
    expect(traversal.skipped[0]?.detail).toContain("depth limit of 1 hops");
  });

  it("meldet nichts, wenn keine Grenze etwas gekostet hat", () => {
    const graph = chain();
    const index = createSymbolGraphIndex(graph);
    const traversal = traverseSymbolGraph(index, {
      rootSymbolIds: [idOf(graph, "one")],
      direction: "forward",
      limits: GENEROUS_LIMITS,
    });
    expect(traversal.result.truncated).toBe(false);
    expect(traversal.skipped).toEqual([]);
  });
});

describe("zwei widersprechende Modulauskuenfte", () => {
  const CALLER = 'import { helper } from "./b";\n\nexport function caller() {\n  helper();\n}\n';

  function graphWith(
    resolvedImports: { fromFileId: string; specifier: string; toFileId: string | null }[],
  ): SymbolGraphV1 {
    return buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        makeFile({
          fileId: "file-a",
          path: "src/a.ts",
          content: CALLER,
          symbols: [{ name: "caller", snippet: "export function caller() {\n  helper();\n}" }],
          calls: [{ calleeName: "helper", snippet: "helper();" }],
          imports: [{ specifier: "./b", bindings: ["helper"] }],
        }),
        makeFile({
          fileId: "file-b",
          path: "src/b.ts",
          content: "export function helper() {}\n",
          symbols: [
            { name: "helper", snippet: "export function helper() {}", exportedNames: ["helper"] },
          ],
        }),
      ],
      resolvedImports,
    });
  }

  it("waehlt die aussagekraeftigere Auskunft unabhaengig von der Eingabereihenfolge", () => {
    const informative = { fromFileId: "file-a", specifier: "./b", toFileId: "file-b" };
    const empty = { fromFileId: "file-a", specifier: "./b", toFileId: null };
    const first = graphWith([informative, empty]);
    const second = graphWith([empty, informative]);
    expect(first.edges[0]?.resolution).toBe("exact");
    expect(second.edges[0]?.resolution).toBe("exact");
    expect(first.edges[0]?.target?.symbolId).toBe(second.edges[0]?.target?.symbolId);
  });

  it("begruendet die verdraengte Auskunft im Ledger", () => {
    const graph = graphWith([
      { fromFileId: "file-a", specifier: "./b", toFileId: "file-b" },
      { fromFileId: "file-a", specifier: "./b", toFileId: null },
    ]);
    const entry = graph.skipped.entries.find(
      (candidate) => candidate.reason === "ambiguous_resolution",
    );
    expect(entry?.detail).toContain("two module resolutions were supplied");
    expect(entry?.detail).toContain('"./b"');
  });
});
