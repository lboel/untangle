/**
 * Der Lesepfad muss DIESELBEN Antworten geben wie der gebaute Graph.
 *
 * Das ist die ganze Zusage von `restore.ts`: ein Graph, der aus dem Abbild
 * zurueckkommt, ist fuer jede Lesefrage nicht von dem zu unterscheiden, der
 * ihn geschrieben hat — inklusive Zyklenmeldung und Abschneidegrund. Ein
 * Lesepfad, der „fast" dasselbe sagt, waere schlimmer als keiner: die
 * Abweichung fiele erst dem Nutzer auf.
 */
import { describe, expect, it } from "vitest";

import { restoreFileGraph } from "./restore.js";
import { buildMiniWorkspace } from "./test-support/workspace.js";

const CHAIN = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
  "src/b.ts": 'import "./c.js";\nexport const b = 1;\n',
  "src/c.ts": 'import "./d.js";\nexport const c = 1;\n',
  "src/d.ts": "export const d = 1;\n",
};

/** a → b → c → a, dazu ein unaufloesbarer Import. */
const CYCLIC = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nimport "./nirgendwo.js";\nexport const a = 1;\n',
  "src/b.ts": 'import "./c.js";\nexport const b = 1;\n',
  "src/c.ts": 'import "./a.js";\nexport const c = 1;\n',
};

describe("restoreFileGraph", () => {
  it("liefert Knoten, Kanten, Metriken und Topologie unveraendert zurueck", async () => {
    const workspace = await buildMiniWorkspace(CHAIN);
    const restored = restoreFileGraph(workspace.graph.snapshot());

    expect(restored.nodes()).toEqual(workspace.graph.nodes());
    expect(restored.edges()).toEqual(workspace.graph.edges());
    expect(restored.metrics()).toEqual(workspace.graph.metrics());
    expect(restored.topology).toEqual(workspace.graph.snapshot().topology);
    expect(restored.workspaceId).toBe(workspace.graph.workspaceId);
    expect(restored.graphGeneration).toBe(workspace.graph.graphGeneration);
  });

  it("traversiert vorwaerts und rueckwaerts wie der gebaute Graph", async () => {
    const workspace = await buildMiniWorkspace(CHAIN);
    const restored = restoreFileGraph(workspace.graph.snapshot());
    const a = workspace.graph.nodes().find((node) => node.filePath === "src/a.ts")
      ?.fileId as string;
    const d = workspace.graph.nodes().find((node) => node.filePath === "src/d.ts")
      ?.fileId as string;

    expect(restored.dependenciesOf(a)).toEqual(workspace.graph.dependenciesOf(a));
    expect(restored.dependentsOf(d)).toEqual(workspace.graph.dependentsOf(d));
    // Und die Traversierung ist nicht leer — sonst wuerde der Vergleich oben
    // zwei Nichtse vergleichen.
    expect(restored.dependenciesOf(a).visitedFileIds.length).toBe(3);
  });

  it("meldet die Tiefengrenze mit Grund, statt sie zu verschweigen", async () => {
    const workspace = await buildMiniWorkspace(CHAIN);
    const restored = restoreFileGraph(workspace.graph.snapshot());
    const a = workspace.graph.nodes().find((node) => node.filePath === "src/a.ts")
      ?.fileId as string;

    const result = restored.dependenciesOf(a, { maxDepth: 1 });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_depth");
    expect(result.visitedFileIds).toHaveLength(1);
    expect(result).toEqual(workspace.graph.dependenciesOf(a, { maxDepth: 1 }));
  });

  it("meldet Zyklen und behaelt den Rohstring unaufgeloester Kanten", async () => {
    const workspace = await buildMiniWorkspace(CYCLIC);
    const restored = restoreFileGraph(workspace.graph.snapshot());
    const a = workspace.graph.nodes().find((node) => node.filePath === "src/a.ts")
      ?.fileId as string;

    const result = restored.dependenciesOf(a);
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result).toEqual(workspace.graph.dependenciesOf(a));

    const unresolved = restored
      .edgesFrom(a)
      .filter((edge) => edge.resolution.status === "unresolved");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.rawSpecifier).toBe("./nirgendwo.js");
  });

  it("findet Knoten ueber ihren Pfad, ohne bei Mehrdeutigkeit zu waehlen", async () => {
    const workspace = await buildMiniWorkspace(CHAIN);
    const restored = restoreFileGraph(workspace.graph.snapshot());

    expect(restored.nodesAtPath("src/b.ts")).toHaveLength(1);
    expect(restored.nodesAtPath("src/b.ts")[0]?.filePath).toBe("src/b.ts");
    expect(restored.nodesAtPath("src/gibtesnicht.ts")).toEqual([]);
  });
});
