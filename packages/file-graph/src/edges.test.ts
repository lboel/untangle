/**
 * Kantenbau — die Faelle, in denen E4 konkret wird.
 */
import { describe, expect, it } from "vitest";

import { buildMiniWorkspace, TEST_REF_ID, TEST_REPO_ID } from "./test-support/workspace.js";
import type { FileImportsV1 } from "./types.js";

const ROOT_MANIFEST = JSON.stringify({ name: "root", private: true });

describe("Kantenarten", () => {
  it("unterscheidet import, re-export und dynamic-import", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/target.ts": "export const target = 1;\n",
      "src/main.ts":
        'import { target } from "./target.js";\nexport { target } from "./target.js";\nexport const load = () => import("./target.js");\n',
    });
    const kinds = graph
      .edges()
      .filter((edge) => edge.fromPath === "src/main.ts")
      .map((edge) => edge.kind)
      .sort();
    expect(kinds).toEqual(["dynamic-import", "import", "re-export"]);
  });

  it("fuehrt zwei Importe desselben Moduls als zwei Kanten mit laufender Nummer", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/target.ts": "export const a = 1;\nexport const b = 2;\n",
      "src/main.ts": 'import { a } from "./target.js";\nimport { b } from "./target.js";\n',
    });
    const edges = graph
      .edges()
      .filter((edge) => edge.rawSpecifier === "./target.js" && edge.kind === "import");
    expect(edges.map((edge) => edge.occurrenceOrdinal)).toEqual([0, 1]);
    // Zwei Vorkommen, zwei verschiedene IDs — sonst kollidierten sie.
    expect(new Set(edges.map((edge) => edge.edgeId)).size).toBe(2);
  });

  it("markiert den Bezug auf eine Nicht-Code-Ressource als asset-reference", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/main.ts": 'import "./styles.css";\nexport const x = 1;\n',
    });
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "./styles.css");
    expect(edge?.kind).toBe("asset-reference");
  });

  it("behaelt einen nicht statisch auswertbaren dynamischen Import MIT Rohtext", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/main.ts":
        "const name = process.env.MOD;\nexport const load = () => import(`./plugins/${name}.js`);\n",
    });
    const edge = graph.edges().find((candidate) => candidate.kind === "dynamic-import");
    expect(edge).toBeDefined();
    expect(edge?.rawSpecifier.length).toBeGreaterThan(0);
    expect(edge?.resolution).toMatchObject({
      status: "unresolved",
      reason: "dynamic_specifier_not_statically_analyzable",
    });
  });

  it("traegt die Quellstelle mit importierten Namen und dem type-only-Merkmal", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/target.ts": "export interface Target { a: number }\n",
      "src/main.ts": 'import type { Target } from "./target.js";\nexport type X = Target;\n',
    });
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "./target.js");
    expect(edge?.sites).toHaveLength(1);
    expect(edge?.sites[0]?.typeOnly).toBe(true);
    expect(edge?.sites[0]?.importedNames).toEqual(["Target"]);
    expect(edge?.sites[0]?.range.startLine).toBe(1);
  });

  it("schreibt eine nicht extrahierte Importliste mit Grund ins Ledger (E4)", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/main.ts": 'import "./target.js";\n',
      "src/target.ts": "export const a = 1;\n",
    });
    const main = graph.nodes().find((node) => node.filePath === "src/main.ts");
    const unparsed: FileImportsV1 = {
      fileId: main?.fileId as string,
      repoId: TEST_REPO_ID,
      refId: TEST_REF_ID,
      path: "src/main.ts",
      languageId: "typescript",
      contentHash: "h2",
      imports: [],
      importsMissingReason: "parser ran out of its token budget",
    };
    graph.applyChanges([{ kind: "modified", file: unparsed }]);
    const entry = graph
      .snapshot()
      .skipped.entries.find((candidate) => candidate.path === "src/main.ts");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("parse_failed");
    expect(entry?.detail).toContain("token budget");
    expect(entry?.recoverable).toBe(true);
  });

  it("macht einen Import OHNE Spezifizierer zum Ledger-Eintrag statt zur stillen Luecke (E4)", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/main.ts": 'import "./target.js";\n',
      "src/target.ts": "export const a = 1;\n",
    });
    const main = graph.nodes().find((node) => node.filePath === "src/main.ts");
    const withEmptySpecifier: FileImportsV1 = {
      fileId: main?.fileId as string,
      repoId: TEST_REPO_ID,
      refId: TEST_REF_ID,
      path: "src/main.ts",
      languageId: "typescript",
      contentHash: "h3",
      imports: [
        {
          specifier: "",
          importKind: "dynamic_import",
          range: { startLine: 4, endLine: 4, startByte: 10, endByte: 20 },
        },
      ],
    };
    graph.applyChanges([{ kind: "modified", file: withEmptySpecifier }]);
    // Keine Kante — `rawSpecifier` darf nie leer sein —, aber ein Eintrag.
    expect(graph.edgesFrom(main?.fileId as string)).toEqual([]);
    const entry = graph
      .snapshot()
      .skipped.entries.find((candidate) => candidate.subjectKind === "file_edge");
    expect(entry?.reason).toBe("resolution_failed");
    expect(entry?.detail).toContain("without a specifier");
    expect(entry?.range?.startLine).toBe(4);
  });

  it("stempelt Generation und Graphversion auf jede Kante", async () => {
    const { graph } = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/target.ts": "export const a = 1;\n",
      "src/main.ts": 'import "./target.js";\n',
    });
    for (const edge of graph.edges()) {
      expect(edge.graphVersion).toBe("untangle-file-graph-v1");
      expect(edge.graphGeneration).toBe("gen-test");
      expect(edge.schemaVersion).toBe(1);
    }
  });

  it("gibt derselben Importzeile nach einer Verschiebung dieselbe Kanten-ID", async () => {
    const before = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/target.ts": "export const a = 1;\n",
      "src/main.ts": 'import "./target.js";\nexport const x = 1;\n',
    });
    const after = await buildMiniWorkspace({
      "package.json": ROOT_MANIFEST,
      "src/target.ts": "export const a = 1;\n",
      // Dieselbe Importzeile, nur eine Zeile tiefer.
      "src/main.ts": '\nimport "./target.js";\nexport const x = 1;\n',
    });
    const idOf = (graph: typeof before.graph) =>
      graph.edges().find((edge) => edge.rawSpecifier === "./target.js")?.edgeId;
    expect(idOf(after.graph)).toBe(idOf(before.graph));
  });
});
