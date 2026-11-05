/**
 * Inkrementelle Fortschreibung.
 *
 * Der Massstab jeder Behauptung hier ist der VOLLSTAENDIGE NEUBAU: nach jeder
 * Fortschreibung muss das Abbild Zeichen fuer Zeichen dem entsprechen, was ein
 * Neubau desselben Dateistands ergeben haette. Alles andere waere eine
 * Optimierung, die still falsche Graphen erzeugt.
 */
import { summarizeSkipReasons } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { FileDependencyGraph } from "./graph.js";
import { fileImportsOf } from "./test-support/parse.js";
import {
  buildMiniWorkspace,
  TEST_GENERATION,
  TEST_REF_ID,
  TEST_REPO_ID,
  TEST_WORKSPACE_ID,
} from "./test-support/workspace.js";
import type { FileImportsV1 } from "./types.js";

const START = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
  "src/b.ts": "export const b = 1;\n",
  "src/c.ts": 'import "./missing.js";\nexport const c = 1;\n',
};

function parse(path: string, content: string) {
  return fileImportsOf({
    workspaceId: TEST_WORKSPACE_ID,
    repoId: TEST_REPO_ID,
    refId: TEST_REF_ID,
    path,
    content,
  });
}

/** Vergleicht ein fortgeschriebenes Abbild mit dem Neubau desselben Standes. */
async function expectMatchesFullRebuild(
  incrementalSnapshot: unknown,
  fileMap: Readonly<Record<string, string>>,
): Promise<void> {
  const rebuilt = await buildMiniWorkspace(fileMap);
  expect(JSON.stringify(incrementalSnapshot)).toBe(JSON.stringify(rebuilt.graph.snapshot()));
}

describe("FileDependencyGraph.applyChanges", () => {
  it("rechnet bei einer reinen Inhaltsaenderung NUR die geaenderte Datei neu", async () => {
    const { graph } = await buildMiniWorkspace(START);
    const changed = parse("src/a.ts", 'import "./b.js";\nimport "./c.js";\nexport const a = 2;\n');
    const update = graph.applyChanges([{ kind: "modified", file: changed }]);

    expect(update.recomputedFileIds).toEqual([changed.fileId]);
    await expectMatchesFullRebuild(graph.snapshot(), {
      ...START,
      "src/a.ts": 'import "./b.js";\nimport "./c.js";\nexport const a = 2;\n',
    });
  });

  it("loest beim Hinzufuegen einer Datei die vorher unaufgeloeste Kante nach", async () => {
    const { graph } = await buildMiniWorkspace(START);
    const before = graph.edges().find((edge) => edge.rawSpecifier === "./missing.js");
    expect(before?.resolution.status).toBe("unresolved");

    const added = parse("src/missing.ts", "export const missing = 1;\n");
    const update = graph.applyChanges([{ kind: "added", file: added }]);

    // Die geprueften Kandidaten der unaufgeloesten Kante sind der Grund,
    // warum "src/c.ts" ueberhaupt als betroffen erkannt wird (E4 zahlt sich aus).
    const cId = graph.nodes().find((node) => node.filePath === "src/c.ts")?.fileId;
    expect(update.recomputedFileIds).toContain(cId);

    const after = graph.edges().find((edge) => edge.rawSpecifier === "./missing.js");
    expect(after?.resolution).toMatchObject({
      status: "resolved",
      targetPath: "src/missing.ts",
    });
    await expectMatchesFullRebuild(graph.snapshot(), {
      ...START,
      "src/missing.ts": "export const missing = 1;\n",
    });
  });

  it("erkennt die Verdeckung: ein neues .ts uebernimmt von einem bestehenden .js", async () => {
    const shadowMap = {
      "package.json": JSON.stringify({ name: "root", private: true }),
      "src/main.ts": 'import "./util.js";\nexport const main = 1;\n',
      "src/util.js": "export const util = 1;\n",
    };
    const { graph } = await buildMiniWorkspace(shadowMap);
    expect(
      graph.edges().find((edge) => edge.rawSpecifier === "./util.js")?.resolution,
    ).toMatchObject({ status: "resolved", targetPath: "src/util.js" });

    const added = parse("src/util.ts", "export const util = 1;\n");
    graph.applyChanges([{ kind: "added", file: added }]);

    expect(
      graph.edges().find((edge) => edge.rawSpecifier === "./util.js")?.resolution,
    ).toMatchObject({ status: "resolved", targetPath: "src/util.ts" });
    await expectMatchesFullRebuild(graph.snapshot(), {
      ...shadowMap,
      "src/util.ts": "export const util = 1;\n",
    });
  });

  it("macht beim Entfernen einer Datei die abhaengige Kante wieder unaufgeloest", async () => {
    const { graph } = await buildMiniWorkspace(START);
    const bId = graph.nodes().find((node) => node.filePath === "src/b.ts")?.fileId as string;
    const update = graph.applyChanges([{ kind: "removed", fileId: bId }]);

    expect(graph.node(bId)).toBeNull();
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "./b.js");
    expect(edge?.resolution.status).toBe("unresolved");
    expect(update.recomputedFileIds.length).toBeGreaterThan(0);

    const remaining = { ...START } as Record<string, string>;
    delete remaining["src/b.ts"];
    await expectMatchesFullRebuild(graph.snapshot(), remaining);
  });

  it("meldet, welche Kanten entstanden und welche verschwunden sind", async () => {
    const { graph } = await buildMiniWorkspace(START);
    const changed = parse("src/a.ts", "export const a = 2;\n");
    const update = graph.applyChanges([{ kind: "modified", file: changed }]);
    expect(update.addedEdgeIds).toEqual([]);
    expect(update.removedEdgeIds).toHaveLength(1);
    // "src/b.ts" verliert seinen Abhaengigen — das steht in affectedFileIds.
    const bId = graph.nodes().find((node) => node.filePath === "src/b.ts")?.fileId as string;
    expect(update.affectedFileIds).toContain(bId);
  });

  it("laesst das Skip-Ledger bei wiederholter Fortschreibung nicht anwachsen", async () => {
    const { graph } = await buildMiniWorkspace({
      ...START,
      "src/broken.py": "import os\n",
    });
    const unparsable = {
      ...parse("src/unknown.txt", "hello"),
    };
    graph.applyChanges([{ kind: "added", file: unparsable }]);
    const first = graph.snapshot().skipped.entries.length;
    graph.applyChanges([{ kind: "modified", file: unparsable }]);
    graph.applyChanges([{ kind: "modified", file: unparsable }]);
    expect(graph.snapshot().skipped.entries.length).toBe(first);
  });

  it("laesst nach einem PFADWECHSEL keine Kante auf den alten Pfad zurueck", async () => {
    // Regression zum schwersten Befund: `FileGraphChangeV1` kennt kein
    // "renamed", eine Umbenennung kommt also als `modified` mit neuem Pfad an.
    // Blieb der alte Pfad im Dateiverzeichnis stehen, meldete der Graph
    // danach eine "resolved"-Kante auf einen Pfad, den keine Datei mehr hat —
    // mit Aufloesungsrate 1 und leerem Skip-Ledger. Genau das verbietet E4.
    const { graph, files } = await buildMiniWorkspace(START);
    const original = files.find((file) => file.path === "src/b.ts") as FileImportsV1;
    const renamed: FileImportsV1 = { ...original, path: "src/renamed.ts" };
    graph.applyChanges([{ kind: "modified", file: renamed }]);

    expect(graph.node(original.fileId)?.filePath).toBe("src/renamed.ts");

    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "./b.js");
    expect(edge?.resolution.status).toBe("unresolved");

    // Die tragende Invariante, unabhaengig vom Einzelfall: keine aufgeloeste
    // Kante darf auf einen Pfad zeigen, den kein Knoten des Graphen hat.
    const knownPaths = new Set(graph.nodes().map((node) => `${node.repoId}/${node.filePath}`));
    for (const candidate of graph.edges()) {
      if (candidate.resolution.status !== "resolved") continue;
      expect(
        knownPaths.has(`${candidate.resolution.targetRepoId}/${candidate.resolution.targetPath}`),
        `${candidate.fromPath} -> ${candidate.rawSpecifier}`,
      ).toBe(true);
    }
    expect(graph.metrics().importResolution.unresolvedCount).toBeGreaterThan(0);
  });

  it("nimmt die Ledger-Eintraege einer entfernten Datei mit", async () => {
    // Gegenrichtung zu E4: nicht Verschweigen, sondern Ueberberichten. Ein
    // Eintrag ueber eine Datei, die der Graph nicht mehr kennt, macht
    // `countsByReason` dauerhaft falsch.
    const { graph } = await buildMiniWorkspace(START);
    const unparsable = parse("src/unknown.txt", "hello");
    graph.applyChanges([{ kind: "added", file: unparsable }]);
    const withEntry = graph.snapshot().skipped;
    expect(withEntry.entries.some((entry) => entry.path === "src/unknown.txt")).toBe(true);

    graph.applyChanges([{ kind: "removed", fileId: unparsable.fileId }]);
    const after = graph.snapshot().skipped;
    expect(after.entries.some((entry) => entry.path === "src/unknown.txt")).toBe(false);
    expect(after.countsByReason).toEqual(summarizeSkipReasons(after.entries));
  });

  it("nimmt die Ledger-Eintraege des ALTEN Pfades bei einem Pfadwechsel mit", async () => {
    const { graph } = await buildMiniWorkspace(START);
    const unparsable = parse("src/unknown.txt", "hello");
    graph.applyChanges([{ kind: "added", file: unparsable }]);
    graph.applyChanges([{ kind: "modified", file: { ...unparsable, path: "src/moved.txt" } }]);

    const entries = graph.snapshot().skipped.entries;
    expect(entries.some((entry) => entry.path === "src/unknown.txt")).toBe(false);
    expect(entries.filter((entry) => entry.path === "src/moved.txt")).toHaveLength(1);
  });

  it("verarbeitet mehrere Aenderungen in einem Aufruf wie einen Neubau", async () => {
    const { graph } = await buildMiniWorkspace(START);
    const bId = graph.nodes().find((node) => node.filePath === "src/b.ts")?.fileId as string;
    const newA = parse("src/a.ts", 'import "./missing.js";\nexport const a = 3;\n');
    const missing = parse("src/missing.ts", "export const missing = 1;\n");
    graph.applyChanges([
      { kind: "removed", fileId: bId },
      { kind: "modified", file: newA },
      { kind: "added", file: missing },
    ]);

    const expected: Record<string, string> = {
      "package.json": START["package.json"],
      "src/a.ts": 'import "./missing.js";\nexport const a = 3;\n',
      "src/c.ts": START["src/c.ts"],
      "src/missing.ts": "export const missing = 1;\n",
    };
    await expectMatchesFullRebuild(graph.snapshot(), expected);
  });
});

/**
 * Vergleicht ein fortgeschriebenes Abbild mit dem Neubau AUS DENSELBEN
 * Dateieingaben (file_ids eingeschlossen).
 *
 * `expectMatchesFullRebuild` geht ueber die Dateilandkarte und leitet die
 * `file_id` dabei aus dem Pfad ab — eine Umbenennung mit STABILER `file_id`
 * laesst sich damit nicht nachbauen. Genau dieser Fall ist aber der
 * gefaehrliche, also braucht er seinen eigenen Massstab.
 */
function rebuildFrom(
  base: Awaited<ReturnType<typeof buildMiniWorkspace>>,
  files: readonly FileImportsV1[],
): FileDependencyGraph {
  return FileDependencyGraph.build({
    workspaceId: TEST_WORKSPACE_ID,
    graphGeneration: TEST_GENERATION,
    repositories: base.repositories,
    files,
    topology: base.topology,
    projectAliases: base.projectAliases,
  });
}

describe("FileDependencyGraph.applyChanges — Pfadwechsel bei stabiler file_id", () => {
  it("loest eine bisher vergebliche Kante nach, wenn eine Datei AUF den geprueften Pfad zieht", async () => {
    // Regression: ein Pfadwechsel ist fachlich ein Entfernen PLUS ein
    // Hinzufuegen. Wurde nur der ALTE Pfad als betroffen gemeldet, blieb jede
    // fremde Datei ungerechnet, deren Aufloesung vom AUFTAUCHEN des neuen
    // Pfades abhaengt: die Kante blieb `unresolved`, obwohl ihr Ziel da ist.
    const map = {
      "package.json": JSON.stringify({ name: "root", private: true }),
      "src/a.ts": 'import "./c.js";\nexport const a = 1;\n',
      "src/b.ts": "export const b = 1;\n",
    };
    const base = await buildMiniWorkspace(map);
    const { graph } = base;
    expect(graph.edges().find((edge) => edge.rawSpecifier === "./c.js")?.resolution.status).toBe(
      "unresolved",
    );

    const original = base.files.find((file) => file.path === "src/b.ts") as FileImportsV1;
    const moved: FileImportsV1 = { ...original, path: "src/c.ts" };
    graph.applyChanges([{ kind: "modified", file: moved }]);

    expect(graph.edges().find((edge) => edge.rawSpecifier === "./c.js")?.resolution).toMatchObject({
      status: "resolved",
      targetPath: "src/c.ts",
    });

    const files = base.files.map((file) => (file.fileId === original.fileId ? moved : file));
    expect(JSON.stringify(graph.snapshot())).toBe(
      JSON.stringify(rebuildFrom(base, files).snapshot()),
    );
  });

  it("erkennt die Verdeckung, wenn eine Datei per Pfadwechsel eine bestehende verdeckt", async () => {
    // Die stillere Haelfte desselben Fehlers: die Kante zeigt nach dem
    // Pfadwechsel auf eine EXISTIERENDE, aber falsche Datei (src/util.js
    // statt des nun vorrangigen src/util.ts). Aufloesungsrate 1, Ledger leer —
    // ohne diese Pruefung faellt es niemandem auf.
    const map = {
      "package.json": JSON.stringify({ name: "root", private: true }),
      "src/a.ts": 'import "./util.js";\nexport const a = 1;\n',
      "src/util.js": "export const util = 1;\n",
      "src/other.ts": "export const other = 1;\n",
    };
    const base = await buildMiniWorkspace(map);
    const { graph } = base;
    expect(
      graph.edges().find((edge) => edge.rawSpecifier === "./util.js")?.resolution,
    ).toMatchObject({ status: "resolved", targetPath: "src/util.js" });

    const original = base.files.find((file) => file.path === "src/other.ts") as FileImportsV1;
    const moved: FileImportsV1 = { ...original, path: "src/util.ts" };
    graph.applyChanges([{ kind: "modified", file: moved }]);

    expect(
      graph.edges().find((edge) => edge.rawSpecifier === "./util.js")?.resolution,
    ).toMatchObject({ status: "resolved", targetPath: "src/util.ts" });

    const files = base.files.map((file) => (file.fileId === original.fileId ? moved : file));
    expect(JSON.stringify(graph.snapshot())).toBe(
      JSON.stringify(rebuildFrom(base, files).snapshot()),
    );
  });
});
