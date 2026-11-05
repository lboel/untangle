/**
 * Regressionstests zu den Welle-3-Befunden 1, 2, 3 und 5 — Importbindungen.
 *
 * Die gemeinsame Wurzel dieser vier Befunde: eine Kante hat mehr Genauigkeit
 * behauptet, als ihre Herleitung hergab, weil die Zuordnung „lokaler Name →
 * Name im Zielmodul" gar nicht vorlag. Jeder Test hier faellt ohne die
 * Reparatur um.
 */
import { UntangleError, validateSkipLedger, validateSymbolEdge } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildImportBindings, buildSymbolGraph } from "./build.js";
import { makeFile } from "./test-support/fixtures.js";
import type { ResolvedImportTargetV1, SymbolGraphBuildInput } from "./types.js";

const MAIN = `import { run as go } from "./lib";

export function main() {
  go();
}
`;

const LIB_WITH_BOTH = `export function run() {
  return 1;
}

export function go() {
  return 99;
}
`;

function mainFile(importSpec: Parameters<typeof makeFile>[0]["imports"]) {
  return makeFile({
    fileId: "file-main",
    path: "src/main.ts",
    content: MAIN,
    symbols: [{ name: "main", snippet: "export function main() {\n  go();\n}" }],
    calls: [{ calleeName: "go", snippet: "go();" }],
    ...(importSpec !== undefined ? { imports: importSpec } : {}),
  });
}

function libFile(
  content: string,
  symbols: { name: string; snippet: string; exported: string[] }[],
) {
  return makeFile({
    fileId: "file-lib",
    path: "src/lib.ts",
    content,
    symbols: symbols.map((symbol) => ({
      name: symbol.name,
      snippet: symbol.snippet,
      exportedNames: symbol.exported,
    })),
  });
}

const RESOLVED: ResolvedImportTargetV1[] = [
  { fromFileId: "file-main", specifier: "./lib", toFileId: "file-lib" },
];

function input(overrides: Partial<SymbolGraphBuildInput>): SymbolGraphBuildInput {
  return {
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [],
    resolvedImports: RESOLVED,
    ...overrides,
  };
}

describe("Alias-Importe (Befund 1 und 3)", () => {
  const lib = () =>
    libFile(LIB_WITH_BOTH, [
      { name: "run", snippet: "export function run() {\n  return 1;\n}", exported: ["run"] },
      { name: "go", snippet: "export function go() {\n  return 99;\n}", exported: ["go"] },
    ]);

  it("loest `import { run as go }` auf run auf und NICHT auf das gleichnamige go", () => {
    const graph = buildSymbolGraph(
      input({
        files: [mainFile([{ specifier: "./lib", bindings: ["go<-run"] }]), lib()],
      }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "go");
    expect(edge?.resolution).toBe("exact");
    expect(edge?.confidence.basis).toBe("deterministic");
    // Der Kern des Befundes: das ZIEL, nicht die Form der Kante.
    expect(edge?.target?.qualifiedName).toBe("run");
  });

  it("haelt eine Alias-Kante ohne Namensdoppel fest, statt sie unresolved zu melden", () => {
    const content = "export function run() {\n  return 1;\n}\n";
    const graph = buildSymbolGraph(
      input({
        files: [
          mainFile([{ specifier: "./lib", bindings: ["go<-run"] }]),
          libFile(content, [
            { name: "run", snippet: "export function run() {\n  return 1;\n}", exported: ["run"] },
          ]),
        ],
      }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "go");
    expect(edge?.resolution).toBe("exact");
    expect(edge?.target?.qualifiedName).toBe("run");
  });

  it("bindet einen Default-Import an den Vorgabeexport der Zieldatei", () => {
    const content = "export default function run() {\n  return 1;\n}\n";
    const graph = buildSymbolGraph(
      input({
        files: [
          makeFile({
            fileId: "file-main",
            path: "src/main.ts",
            content: 'import boot from "./lib";\n\nexport function main() {\n  boot();\n}\n',
            symbols: [{ name: "main", snippet: "export function main() {\n  boot();\n}" }],
            calls: [{ calleeName: "boot", snippet: "boot();" }],
            imports: [{ specifier: "./lib", bindings: ["boot<-default"] }],
          }),
          libFile(content, [
            {
              name: "run",
              snippet: "export default function run() {\n  return 1;\n}",
              exported: ["default"],
            },
          ]),
        ],
      }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "boot");
    expect(edge?.resolution).toBe("exact");
    expect(edge?.target?.qualifiedName).toBe("run");
  });

  it("behauptet NIE exact, wenn der Adapter die Alias-Zuordnung nicht gemeldet hat", () => {
    const graph = buildSymbolGraph(
      input({
        files: [
          // Nur `importedNames`: der lokale Name, ohne Zuordnung zum Export.
          mainFile([{ specifier: "./lib", importedNames: ["go"] }]),
          lib(),
        ],
      }),
    );
    const edge = graph.edges.find((candidate) => candidate.toName === "go");
    expect(edge?.resolution).toBe("heuristic");
    expect(edge?.confidence.basis).toBe("heuristic");
    expect(edge?.confidence.value).toBeLessThan(1);
    expect(edge?.confidence.signals).toContain("import_alias_unreported");
  });
});

describe("Import-Shadowing (Befund 2)", () => {
  const CALLER = `from alpha import run
from beta import run


def main():
    return run()
`;

  function shadowedGraph() {
    return buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        makeFile({
          fileId: "file-main",
          path: "pkg/main.py",
          languageId: "python",
          content: CALLER,
          symbols: [{ name: "main", snippet: "def main():\n    return run()" }],
          calls: [{ calleeName: "run", snippet: "run()" }],
          imports: [
            { specifier: "alpha", bindings: ["run"] },
            { specifier: "beta", bindings: ["run"] },
          ],
        }),
        makeFile({
          fileId: "file-alpha",
          path: "pkg/alpha.py",
          languageId: "python",
          content: "def run():\n    return 1\n",
          symbols: [{ name: "run", snippet: "def run():\n    return 1", exportedNames: ["run"] }],
        }),
        makeFile({
          fileId: "file-beta",
          path: "pkg/beta.py",
          languageId: "python",
          content: "def run():\n    return 2\n",
          symbols: [{ name: "run", snippet: "def run():\n    return 2", exportedNames: ["run"] }],
        }),
      ],
      resolvedImports: [
        { fromFileId: "file-main", specifier: "alpha", toFileId: "file-alpha" },
        { fromFileId: "file-main", specifier: "beta", toFileId: "file-beta" },
      ],
    });
  }

  it("behaelt beide Bindungen desselben Namens statt der ersten", () => {
    const bindings = buildImportBindings([
      {
        specifier: "alpha",
        importKind: "import",
        range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
        importedNames: ["run"],
        bindings: [{ localName: "run", importedName: "run", kind: "named" }],
      },
      {
        specifier: "beta",
        importKind: "import",
        range: { startLine: 2, endLine: 2, startByte: 2, endByte: 3 },
        importedNames: ["run"],
        bindings: [{ localName: "run", importedName: "run", kind: "named" }],
      },
    ]);
    expect(bindings.get("run")?.map((binding) => binding.statement.specifier)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("meldet den verdeckten Import als mehrdeutig statt als exakt auf das erste Modul", () => {
    const graph = shadowedGraph();
    const edge = graph.edges.find((candidate) => candidate.toName === "run");
    expect(edge?.resolution).toBe("ambiguous");
    expect(edge?.target).toBeUndefined();
    expect(edge?.confidence.value).toBeLessThan(1);
    expect(edge?.confidence.signals).toContain("shadowed_import_binding");
    expect(edge?.candidates?.map((candidate) => candidate.filePath).sort()).toEqual([
      "pkg/alpha.py",
      "pkg/beta.py",
    ]);
  });

  it("begruendet die Kollision im Skip-Ledger (E4)", () => {
    const graph = shadowedGraph();
    const entry = graph.skipped.entries.find((candidate) =>
      candidate.detail.includes("is bound 2 times in this file"),
    );
    expect(entry?.reason).toBe("ambiguous_resolution");
    expect(entry?.detail).toContain('"alpha"');
    expect(entry?.detail).toContain('"beta"');
    expect(validateSkipLedger(graph.skipped)).toEqual([]);
  });
});

describe("maxCandidates (Befund 5)", () => {
  function ambiguousInput(maxCandidates?: number): SymbolGraphBuildInput {
    const caller = "export function caller() {\n  shared();\n}\n";
    const shared = "export function shared() {}\n";
    return {
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        makeFile({
          fileId: "file-caller",
          path: "a/caller.ts",
          content: caller,
          symbols: [{ name: "caller", snippet: "export function caller() {\n  shared();\n}" }],
          calls: [{ calleeName: "shared", snippet: "shared();" }],
        }),
        makeFile({
          fileId: "file-b",
          path: "b/x.ts",
          content: shared,
          symbols: [{ name: "shared", snippet: "export function shared() {}" }],
        }),
        makeFile({
          fileId: "file-c",
          path: "c/y.ts",
          content: shared,
          symbols: [{ name: "shared", snippet: "export function shared() {}" }],
        }),
      ],
      ...(maxCandidates !== undefined ? { options: { maxCandidates } } : {}),
    };
  }

  it("weist maxCandidates < 2 zurueck, statt die Kante zu loeschen", () => {
    expect(() => buildSymbolGraph(ambiguousInput(1))).toThrowError(UntangleError);
    try {
      buildSymbolGraph(ambiguousInput(1));
      expect.unreachable("buildSymbolGraph must reject maxCandidates = 1");
    } catch (error) {
      expect(error).toBeInstanceOf(UntangleError);
      expect((error as UntangleError).code).toBe("CONFIG_INVALID");
    }
    // Gegenprobe: mit dem kleinsten zulaessigen Wert bleibt die Kante stehen.
    const graph = buildSymbolGraph(ambiguousInput(2));
    expect(graph.metrics.edgeCount).toBe(1);
    expect(graph.edges[0]?.resolution).toBe("ambiguous");
  });

  it("weist eine Confidence-Vorgabe von 1 zurueck (eine Heuristik ist nie gewiss)", () => {
    expect(() =>
      buildSymbolGraph({ ...ambiguousInput(), options: { uniqueNameConfidence: 1 } }),
    ).toThrowError(/uniqueNameConfidence/);
  });

  it("liefert fuer jede zulaessige Option eine vertragskonforme Kante", () => {
    const graph = buildSymbolGraph(ambiguousInput(16));
    for (const edge of graph.edges) expect(validateSymbolEdge(edge)).toEqual([]);
  });
});
