/**
 * Aufbau und Aufloesung: was eine Kante behauptet, muss ihre Herleitung
 * hergeben (E4 / architecture.md §17.2).
 */
import { validateSkipLedger, validateSymbolEdge } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildImportBindings, buildSymbolGraph, findEnclosingSymbol } from "./build.js";
import { makeFile } from "./test-support/fixtures.js";
import type { ResolvedImportTargetV1, SymbolGraphBuildInput } from "./types.js";

const FILE_A = `import { helper } from "./b";

export function alpha() {
  helper();
  beta();
}

export function beta() {
  helper();
}
`;

const FILE_B = `export function helper() {
  return 1;
}
`;

const FILE_C = `export function helper() {
  return 2;
}
`;

const FILE_D = `export function delta() {
  helper();
}
`;

function fileA() {
  return makeFile({
    fileId: "file-a",
    path: "src/a.ts",
    content: FILE_A,
    symbols: [
      {
        name: "alpha",
        snippet: "export function alpha() {\n  helper();\n  beta();\n}",
        exportedNames: ["alpha"],
      },
      {
        name: "beta",
        snippet: "export function beta() {\n  helper();\n}",
        exportedNames: ["beta"],
      },
    ],
    calls: [
      { calleeName: "helper", snippet: "helper();", occurrence: 0 },
      { calleeName: "beta", snippet: "beta();" },
      { calleeName: "helper", snippet: "helper();", occurrence: 1 },
    ],
    imports: [{ specifier: "./b", bindings: ["helper"], snippet: 'import { helper } from "./b";' }],
  });
}

function fileB() {
  return makeFile({
    fileId: "file-b",
    path: "src/b.ts",
    content: FILE_B,
    symbols: [
      {
        name: "helper",
        snippet: "export function helper() {\n  return 1;\n}",
        exportedNames: ["helper"],
      },
    ],
  });
}

function fileC() {
  return makeFile({
    fileId: "file-c",
    path: "other/c.ts",
    content: FILE_C,
    symbols: [
      {
        name: "helper",
        snippet: "export function helper() {\n  return 2;\n}",
        exportedNames: ["helper"],
      },
    ],
  });
}

function fileD() {
  return makeFile({
    fileId: "file-d",
    path: "src/d.ts",
    content: FILE_D,
    symbols: [{ name: "delta", snippet: "export function delta() {\n  helper();\n}" }],
    calls: [{ calleeName: "helper", snippet: "helper();" }],
  });
}

const RESOLVED_IMPORTS: ResolvedImportTargetV1[] = [
  { fromFileId: "file-a", specifier: "./b", toFileId: "file-b" },
];

function buildInput(overrides: Partial<SymbolGraphBuildInput> = {}): SymbolGraphBuildInput {
  return {
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [fileA(), fileB()],
    resolvedImports: RESOLVED_IMPORTS,
    ...overrides,
  };
}

describe("buildSymbolGraph", () => {
  it("builds one node per extracted symbol and stamps the graph version", () => {
    const graph = buildSymbolGraph(buildInput());
    expect(graph.nodes).toHaveLength(3);
    expect(graph.graphVersion).toBe("untangle-symbol-graph-v1");
    expect(graph.nodes.map((node) => node.qualifiedName).sort()).toEqual([
      "alpha",
      "beta",
      "helper",
    ]);
    for (const node of graph.nodes) {
      expect(node.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("hashes the real source bytes of the symbol, not its AST fingerprint", () => {
    const graph = buildSymbolGraph(buildInput());
    const helper = graph.nodes.find((node) => node.name === "helper");
    const changed = buildSymbolGraph(
      buildInput({
        files: [
          fileA(),
          makeFile({
            fileId: "file-b",
            path: "src/b.ts",
            content: "export function helper() {\n  return 99;\n}\n",
            symbols: [
              {
                name: "helper",
                snippet: "export function helper() {\n  return 99;\n}",
                exportedNames: ["helper"],
              },
            ],
          }),
        ],
      }),
    );
    const helperChanged = changed.nodes.find((node) => node.name === "helper");
    expect(helper?.id).toBe(helperChanged?.id);
    expect(helper?.contentHash).not.toBe(helperChanged?.contentHash);
  });

  it("every produced edge satisfies the domain invariants", () => {
    const graph = buildSymbolGraph(buildInput({ files: [fileA(), fileB(), fileC(), fileD()] }));
    for (const edge of graph.edges) {
      expect(validateSymbolEdge(edge)).toEqual([]);
    }
    expect(validateSkipLedger(graph.skipped)).toEqual([]);
  });

  it("resolves a same-file call exactly and deterministically", () => {
    const graph = buildSymbolGraph(buildInput());
    const edge = graph.edges.find((candidate) => candidate.toName === "beta");
    expect(edge?.resolution).toBe("exact");
    expect(edge?.confidence).toEqual({
      value: 1,
      basis: "deterministic",
      signals: ["same_file_declaration"],
    });
    expect(edge?.target?.qualifiedName).toBe("beta");
  });

  it("resolves an import binding exactly ONLY when the file graph resolved the module", () => {
    const withResolution = buildSymbolGraph(buildInput());
    const helperEdges = withResolution.edges.filter((edge) => edge.toName === "helper");
    expect(helperEdges).toHaveLength(2);
    for (const edge of helperEdges) {
      expect(edge.resolution).toBe("exact");
      expect(edge.confidence.signals).toContain("resolved_module");
    }

    const withoutResolution = buildSymbolGraph(buildInput({ resolvedImports: [] }));
    const degraded = withoutResolution.edges.filter((edge) => edge.toName === "helper");
    for (const edge of degraded) {
      expect(edge.resolution).toBe("heuristic");
      expect(edge.confidence.basis).toBe("heuristic");
      expect(edge.confidence.signals).toContain("module_resolution_missing");
    }
  });

  it("keeps ALL candidates of an ambiguous call and never picks one", () => {
    const graph = buildSymbolGraph(
      buildInput({ files: [fileB(), fileC(), fileD()], resolvedImports: [] }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "helper");
    expect(edge?.resolution).toBe("ambiguous");
    expect(edge?.target).toBeUndefined();
    expect(edge?.candidates).toHaveLength(2);
    expect(edge?.confidence.value).toBeLessThan(1);
    expect(edge?.confidence.basis).toBe("heuristic");
    const weights = (edge?.candidates ?? []).map((candidate) => candidate.weight);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeLessThanOrEqual(1);
  });

  it("prefers the nearer candidate in the weighting without discarding the other", () => {
    const graph = buildSymbolGraph(
      buildInput({ files: [fileB(), fileC(), fileD()], resolvedImports: [] }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "helper");
    // src/d.ts liegt im selben Verzeichnis wie src/b.ts, other/c.ts nicht.
    expect(edge?.candidates?.[0]?.filePath).toBe("src/b.ts");
    expect(edge?.candidates?.[1]?.filePath).toBe("other/c.ts");
    expect(edge?.candidates?.[0]?.weight).toBeGreaterThan(edge?.candidates?.[1]?.weight ?? 1);
  });

  it("records an unresolved call with a named reason and a mandatory detail", () => {
    const graph = buildSymbolGraph(buildInput({ files: [fileD()], resolvedImports: [] }));
    const edge = graph.edges.find((candidate) => candidate.toName === "helper");
    expect(edge?.resolution).toBe("unresolved");
    expect(edge?.unresolvedReason).toBe("no_candidate_found");
    expect(edge?.unresolvedDetail).toContain("helper");
    expect(edge?.kind).toBe("calls");
    expect(edge?.toName).toBe("helper");
  });

  it("classifies an import the file graph called external as target_outside_index", () => {
    const graph = buildSymbolGraph(
      buildInput({
        files: [fileA()],
        resolvedImports: [
          { fromFileId: "file-a", specifier: "./b", toFileId: null, external: true },
        ],
      }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "helper");
    expect(edge?.resolution).toBe("unresolved");
    expect(edge?.unresolvedReason).toBe("target_outside_index");
    expect(edge?.unresolvedDetail).toContain("external");
  });

  it("never claims exact for a qualified call", () => {
    const content = "export function gamma() {\n  service.run();\n}\n";
    const graph = buildSymbolGraph(
      buildInput({
        files: [
          makeFile({
            fileId: "file-q",
            path: "src/q.ts",
            content,
            symbols: [{ name: "gamma", snippet: "export function gamma() {\n  service.run();\n}" }],
            calls: [{ calleeName: "run", qualifier: "service", snippet: "service.run();" }],
          }),
          makeFile({
            fileId: "file-r",
            path: "src/r.ts",
            content: "export function run() {}\n",
            symbols: [{ name: "run", snippet: "export function run() {}" }],
          }),
        ],
        resolvedImports: [],
      }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "run");
    expect(edge?.resolution).toBe("heuristic");
    expect(edge?.toQualifier).toBe("service");
    expect(edge?.confidence.basis).toBe("heuristic");
    expect(edge?.confidence.signals).toContain("qualifier_binding");
  });

  it("puts a module-level call into the skip ledger instead of dropping it", () => {
    const content = "helper();\n\nexport function epsilon() {}\n";
    const graph = buildSymbolGraph(
      buildInput({
        files: [
          makeFile({
            fileId: "file-m",
            path: "src/m.ts",
            content,
            symbols: [{ name: "epsilon", snippet: "export function epsilon() {}" }],
            calls: [{ calleeName: "helper", snippet: "helper();" }],
          }),
        ],
        resolvedImports: [],
      }),
    );
    expect(graph.edges).toHaveLength(0);
    const entry = graph.skipped.entries.find(
      (candidate) => candidate.reason === "missing_index_entry",
    );
    expect(entry?.detail).toContain("outside every extracted symbol range");
    expect(graph.skipped.countsByReason.missing_index_entry).toBe(1);
    expect(validateSkipLedger(graph.skipped)).toEqual([]);
  });

  it("numbers repeated identical calls so their ids differ", () => {
    const content = "export function zeta() {\n  helper();\n  helper();\n}\n";
    const graph = buildSymbolGraph(
      buildInput({
        files: [
          makeFile({
            fileId: "file-z",
            path: "src/z.ts",
            content,
            symbols: [
              { name: "zeta", snippet: "export function zeta() {\n  helper();\n  helper();\n}" },
            ],
            calls: [
              { calleeName: "helper", snippet: "helper();", occurrence: 0 },
              { calleeName: "helper", snippet: "helper();", occurrence: 1 },
            ],
          }),
          fileB(),
        ],
        resolvedImports: [],
      }),
    );
    const edges = graph.edges.filter((edge) => edge.toName === "helper");
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((edge) => edge.edgeId)).size).toBe(2);
    expect(edges.map((edge) => edge.occurrenceOrdinal).sort()).toEqual([0, 1]);
  });

  it("keeps edge identity when the resolver improves", () => {
    const heuristic = buildSymbolGraph(buildInput({ resolvedImports: [] }));
    const exact = buildSymbolGraph(buildInput());
    const heuristicIds = heuristic.edges.map((edge) => edge.edgeId).sort();
    const exactIds = exact.edges.map((edge) => edge.edgeId).sort();
    expect(heuristicIds).toEqual(exactIds);
  });

  it("is independent of file input order", () => {
    const forward = buildSymbolGraph(buildInput({ files: [fileA(), fileB(), fileC(), fileD()] }));
    const reversed = buildSymbolGraph(buildInput({ files: [fileD(), fileC(), fileB(), fileA()] }));
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("reports a duplicate file id instead of silently merging it", () => {
    const graph = buildSymbolGraph(buildInput({ files: [fileB(), fileB()] }));
    expect(graph.nodes).toHaveLength(1);
    expect(graph.skipped.countsByReason.duplicate).toBe(1);
  });
});

describe("Sprachagnostik (vision.md §1c)", () => {
  it("returns an empty graph — not an error — for content without symbols", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        makeFile({
          fileId: "file-md",
          path: "docs/readme.md",
          content: "# Titel\n\nText ohne Symbole.\n",
          languageId: "markdown",
        }),
      ],
    });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.skipped.entries).toEqual([]);
    expect(graph.metrics.symbolLessFileCount).toBe(1);
    expect(graph.metrics.fileCount).toBe(1);
  });

  it("mixes symbol-bearing and symbol-less files without penalty", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        fileB(),
        makeFile({
          fileId: "file-txt",
          path: "notes.txt",
          content: "kein Code",
          languageId: "text",
        }),
      ],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.metrics.symbolLessFileCount).toBe(1);
    expect(graph.skipped.entries).toEqual([]);
  });
});

describe("findEnclosingSymbol", () => {
  it("picks the innermost containing symbol", () => {
    const graph = buildSymbolGraph(buildInput());
    const alpha = graph.nodes.find((node) => node.name === "alpha");
    expect(alpha).toBeDefined();
    const callers = graph.nodes
      .filter((node) => node.fileId === "file-a")
      .map((node) => ({ node, startByte: node.startByte, endByte: node.endByte }));
    const betaCallStart = FILE_A.indexOf("beta();");
    expect(
      findEnclosingSymbol(callers, betaCallStart, betaCallStart + "beta();".length)?.name,
    ).toBe("alpha");
  });

  it("returns null when nothing contains the range", () => {
    expect(findEnclosingSymbol([], 0, 1)).toBeNull();
  });
});

describe("buildImportBindings", () => {
  it("lets a value import win over a same-named type-only import", () => {
    const bindings = buildImportBindings([
      {
        specifier: "./types",
        importKind: "import",
        range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
        importedNames: ["Thing"],
        typeOnly: true,
      },
      {
        specifier: "./thing",
        importKind: "import",
        range: { startLine: 2, endLine: 2, startByte: 2, endByte: 3 },
        importedNames: ["Thing"],
        typeOnly: false,
      },
    ]);
    expect(bindings.get("Thing")?.map((binding) => binding.statement.specifier)).toEqual([
      "./thing",
    ]);
  });
});
