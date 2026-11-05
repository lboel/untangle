/**
 * Regressionen der Welle-3b-Nachpruefung.
 *
 * Alle vier Faelle haben dieselbe Bauart: eine konkurrierende oder
 * uebergangene Auskunft verschwand, ohne dass irgendwo etwas davon stand —
 * einmal als falsch sicheres Kantenziel, einmal als Luecke im Skip-Ledger der
 * Impact-Analyse. E4 verlangt in beiden Faellen den BENANNTEN Eintrag.
 */
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { analyzeImpact } from "./impact.js";
import { functionFile, GENEROUS_LIMITS, makeFile } from "./test-support/fixtures.js";
import type { SymbolGraphFileInput, SymbolGraphV1 } from "./types.js";

function idOf(graph: SymbolGraphV1, name: string): string {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`fixture symbol "${name}" missing`);
  return node.id;
}

// ---------------------------------------------------------------------------
// Lokale Deklaration gegen Importbindung desselben Namens
// ---------------------------------------------------------------------------

/**
 * `pkg/main.py` deklariert `run` SELBST und importiert danach `run` aus
 * `pkg/alpha.py`. Zur Laufzeit bindet der spaetere Satz den Namen neu; welcher
 * der beiden gilt, entscheidet allein die Reihenfolge im Quelltext.
 */
const PY_MAIN = `def run():
    return 9

from alpha import run

def main():
    return run()
`;

function pythonShadowFiles(): SymbolGraphFileInput[] {
  return [
    makeFile({
      fileId: "file-main",
      path: "pkg/main.py",
      languageId: "python",
      content: PY_MAIN,
      symbols: [
        { name: "run", snippet: "def run():\n    return 9", exportedNames: ["run"] },
        { name: "main", snippet: "def main():\n    return run()", exportedNames: ["main"] },
      ],
      calls: [{ calleeName: "run", snippet: "run()", occurrence: 1 }],
      imports: [{ specifier: "alpha", snippet: "from alpha import run", bindings: ["run"] }],
    }),
    makeFile({
      fileId: "file-alpha",
      path: "pkg/alpha.py",
      languageId: "python",
      content: "def run():\n    return 1\n",
      symbols: [{ name: "run", snippet: "def run():\n    return 1", exportedNames: ["run"] }],
    }),
  ];
}

describe("lokale Deklaration und Importbindung desselben Namens", () => {
  it("behauptet KEIN exact auf die lokale Deklaration, wenn ein Import denselben Namen bindet", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: pythonShadowFiles(),
      resolvedImports: [{ fromFileId: "file-main", specifier: "alpha", toFileId: "file-alpha" }],
    });
    const edge = graph.edges.find((candidate) => candidate.toName === "run");
    expect(edge?.resolution).toBe("ambiguous");
    expect(edge?.confidence.basis).toBe("heuristic");
    expect(edge?.confidence.value).toBeLessThan(1);
    expect(edge?.confidence.signals).toContain("shadowed_local_declaration");
    expect(edge?.target).toBeUndefined();
    expect((edge?.candidates ?? []).map((candidate) => candidate.filePath).sort()).toEqual([
      "pkg/alpha.py",
      "pkg/main.py",
    ]);
  });

  it("begruendet die konkurrierende Bindung im Skip-Ledger", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: pythonShadowFiles(),
      resolvedImports: [{ fromFileId: "file-main", specifier: "alpha", toFileId: "file-alpha" }],
    });
    const entry = graph.skipped.entries.find((candidate) =>
      candidate.detail.includes("is BOTH declared in this file"),
    );
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("ambiguous_resolution");
    expect(entry?.detail).toContain('"alpha"');
  });

  it("bleibt exact, wenn die Importbindung gar keinen Kandidaten beisteuert", () => {
    // Gegenprobe zur Regel: `from alpha import *` bindet nur EXPORTIERTE
    // Namen. `alpha` exportiert `other`, nicht `run` — die lokale Deklaration
    // hat also keine Konkurrenz und bleibt bewiesen.
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        makeFile({
          fileId: "file-main",
          path: "pkg/main.py",
          languageId: "python",
          content:
            "def run():\n    return 9\n\nfrom alpha import *\n\ndef main():\n    return run()\n",
          symbols: [
            { name: "run", snippet: "def run():\n    return 9", exportedNames: ["run"] },
            { name: "main", snippet: "def main():\n    return run()", exportedNames: ["main"] },
          ],
          calls: [{ calleeName: "run", snippet: "run()", occurrence: 1 }],
          imports: [{ specifier: "alpha", snippet: "from alpha import *", importedNames: ["*"] }],
        }),
        makeFile({
          fileId: "file-alpha",
          path: "pkg/alpha.py",
          languageId: "python",
          content: "def other():\n    return 1\n",
          symbols: [
            { name: "other", snippet: "def other():\n    return 1", exportedNames: ["other"] },
          ],
        }),
      ],
      resolvedImports: [{ fromFileId: "file-main", specifier: "alpha", toFileId: "file-alpha" }],
    });
    const edge = graph.edges.find((candidate) => candidate.toName === "run");
    expect(edge?.resolution).toBe("exact");
    expect(edge?.confidence.signals).toEqual(["same_file_declaration"]);
    expect(edge?.target?.filePath).toBe("pkg/main.py");
  });
});

// ---------------------------------------------------------------------------
// `named`/`default` ohne `importedName`
// ---------------------------------------------------------------------------

/** `main.ts` ruft `go()`; `lib.ts` exportiert `run` UND `go`. */
function aliasFiles(kind: "named" | "default"): SymbolGraphFileInput[] {
  return [
    makeFile({
      fileId: "file-main",
      path: "src/main.ts",
      content: "import { go } from './lib';\nexport function main() {\n  go();\n}\n",
      symbols: [{ name: "main", snippet: "export function main() {\n  go();\n}" }],
      calls: [{ calleeName: "go", snippet: "go();" }],
      imports: [
        {
          specifier: "./lib",
          snippet: "import { go } from './lib';",
          // Der Adapter meldet die BINDUNGSFORM, aber nicht den Namen im
          // Zielmodul. `RawImportBinding.importedName` ist optional, dieser
          // Fall ist also vertragskonform.
          bindings: [{ localName: "go", kind }],
        },
      ],
    }),
    makeFile({
      fileId: "file-lib",
      path: "src/lib.ts",
      content: "export function run() {}\nexport function go() {}\n",
      symbols: [
        { name: "run", snippet: "export function run() {}", exportedNames: ["run"] },
        { name: "go", snippet: "export function go() {}", exportedNames: ["go"] },
      ],
    }),
  ];
}

describe("Importbindung ohne Namen im Zielmodul", () => {
  for (const kind of ["named", "default"] as const) {
    it(`behauptet bei kind "${kind}" ohne importedName kein exact`, () => {
      const graph = buildSymbolGraph({
        workspaceId: "ws-1",
        graphGeneration: "gen-1",
        files: aliasFiles(kind),
        resolvedImports: [{ fromFileId: "file-main", specifier: "./lib", toFileId: "file-lib" }],
      });
      const edge = graph.edges.find((candidate) => candidate.toName === "go");
      expect(edge?.resolution).toBe("heuristic");
      expect(edge?.confidence.basis).toBe("heuristic");
      expect(edge?.confidence.value).toBeLessThan(1);
      expect(edge?.confidence.signals).toContain("import_alias_unreported");
      expect(edge?.confidence.signals).not.toContain("unique_export");
    });
  }

  it("bleibt exact, sobald der Adapter den Namen im Zielmodul liefert", () => {
    const files = aliasFiles("named");
    const caller = files[0];
    if (caller === undefined) throw new Error("fixture missing");
    const withAlias: SymbolGraphFileInput = {
      ...caller,
      imports: caller.imports.map((entry) => ({
        ...entry,
        bindings: [{ localName: "go", importedName: "run", kind: "named" as const }],
      })),
    };
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [withAlias, files[1] as SymbolGraphFileInput],
      resolvedImports: [{ fromFileId: "file-main", specifier: "./lib", toFileId: "file-lib" }],
    });
    const edge = graph.edges.find((candidate) => candidate.toName === "go");
    expect(edge?.resolution).toBe("exact");
    expect(edge?.confidence.signals).toContain("unique_export");
    expect(edge?.target?.qualifiedName).toBe("run");
  });
});

// ---------------------------------------------------------------------------
// Budgets der Impact-Analyse
// ---------------------------------------------------------------------------

/** R wird von A, B und C aufgerufen; sonst ruft niemand jemanden. */
function fanInGraph(): SymbolGraphV1 {
  return buildSymbolGraph({
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      functionFile({
        fileId: "file-fan",
        path: "src/fan.ts",
        functions: [
          { name: "A", calls: [{ name: "R" }] },
          { name: "B", calls: [{ name: "R" }] },
          { name: "C", calls: [{ name: "R" }] },
          { name: "R" },
        ],
      }),
    ],
  });
}

describe("Impact-Budgets lassen niemanden spurlos zurueck", () => {
  it("benennt bei maxNodes JEDEN erreichbaren Aufrufer, der nicht im Ergebnis steht", () => {
    const graph = fanInGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "R")],
      limits: { ...GENEROUS_LIMITS, maxNodes: 2 },
    });
    expect(impact.traversal.truncated).toBe(true);
    expect(impact.traversal.truncationReason).toBe("max_nodes");
    const reported = new Set(impact.affected.map((entry) => entry.symbolId));
    const named = new Set(impact.skipped.map((entry) => entry.subjectId));
    for (const caller of ["A", "B", "C"]) {
      const symbolId = idOf(graph, caller);
      expect(
        reported.has(symbolId) || named.has(symbolId),
        `${caller} steht weder im Ergebnis noch im Skip-Ledger`,
      ).toBe(true);
    }
  });

  it("benennt bei maxEdges JEDEN erreichbaren Aufrufer, der nicht im Ergebnis steht", () => {
    const graph = fanInGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "R")],
      limits: { ...GENEROUS_LIMITS, maxEdges: 2 },
    });
    expect(impact.traversal.truncated).toBe(true);
    expect(impact.traversal.truncationReason).toBe("max_edges");
    expect(impact.skipped.length).toBeGreaterThan(0);
    const reported = new Set(impact.affected.map((entry) => entry.symbolId));
    const named = new Set(impact.skipped.map((entry) => entry.subjectId));
    for (const caller of ["A", "B", "C"]) {
      const symbolId = idOf(graph, caller);
      expect(
        reported.has(symbolId) || named.has(symbolId),
        `${caller} steht weder im Ergebnis noch im Skip-Ledger`,
      ).toBe(true);
    }
    expect(impact.skipped.some((entry) => entry.detail.includes("edge budget of 2 edges"))).toBe(
      true,
    );
  });

  it("benennt eine Wurzel, die nie expandiert wurde", () => {
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: [
        functionFile({
          fileId: "file-roots",
          path: "src/roots.ts",
          functions: [{ name: "Q", calls: [{ name: "R2" }] }, { name: "R1" }, { name: "R2" }],
        }),
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "R1"), idOf(graph, "R2")],
      limits: { ...GENEROUS_LIMITS, maxNodes: 1 },
    });
    expect(impact.traversal.truncated).toBe(true);
    const unexpanded = impact.traversal.visitedSymbolIds.includes(idOf(graph, "R1"))
      ? idOf(graph, "R2")
      : idOf(graph, "R1");
    const entry = impact.skipped.find((candidate) => candidate.subjectId === unexpanded);
    expect(entry).toBeDefined();
    expect(entry?.detail).toContain("was never expanded");
  });

  it("meldet nichts, wenn kein Budget etwas gekostet hat", () => {
    const graph = fanInGraph();
    const index = createSymbolGraphIndex(graph);
    const impact = analyzeImpact(index, {
      rootSymbolIds: [idOf(graph, "R")],
      limits: GENEROUS_LIMITS,
    });
    expect(impact.traversal.truncated).toBe(false);
    expect(impact.skipped).toEqual([]);
    expect(impact.affected.map((entry) => entry.qualifiedName).sort()).toEqual(["A", "B", "C"]);
  });
});
