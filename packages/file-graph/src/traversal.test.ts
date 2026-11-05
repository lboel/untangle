import { describe, expect, it } from "vitest";

import { buildMiniWorkspace } from "./test-support/workspace.js";

const BASE = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
  "src/b.ts": 'import "./c.js";\nexport const b = 1;\n',
  "src/c.ts": 'import "./d.js";\nexport const c = 1;\n',
  "src/d.ts": "export const d = 1;\n",
};

/** Zwei voneinander unabhaengige Aeste — zwei Wurzeln, die sich nicht treffen. */
const TWO_ROOTS = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
  "src/b.ts": 'import "./c.js";\nexport const b = 1;\n',
  "src/c.ts": "export const c = 1;\n",
  "src/x.ts": 'import "./y.js";\nexport const x = 1;\n',
  "src/y.ts": 'import "./z.js";\nexport const y = 1;\n',
  "src/z.ts": "export const z = 1;\n",
};

/** Ein echter Zyklus: a → b → c → a. */
const CYCLIC = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
  "src/b.ts": 'import "./c.js";\nexport const b = 1;\n',
  "src/c.ts": 'import "./a.js";\nexport const c = 1;\n',
};

async function idsByPath(fileMap: Readonly<Record<string, string>>) {
  const workspace = await buildMiniWorkspace(fileMap);
  const byPath = new Map(workspace.graph.nodes().map((node) => [node.filePath, node.fileId]));
  return { workspace, byPath };
}

describe("Traversierung mit mehreren Wurzeln", () => {
  it("verwirft die zweite Wurzel NICHT, wenn nur die Tiefengrenze erreicht ist", async () => {
    // Regression: die Tiefengrenze beschneidet einen AST, sie ist kein
    // globales Budget. Sie hat vorher `truncated` gesetzt und damit die
    // Schleife ueber die Wurzeln beendet — die zweite Wurzel wurde nie
    // angefasst, obwohl auf ihrem Ast noch Luft war.
    const { workspace, byPath } = await idsByPath(TWO_ROOTS);
    const roots = [byPath.get("src/a.ts") as string, byPath.get("src/x.ts") as string];
    const result = workspace.graph.traverse(roots, {
      direction: "forward",
      limits: { maxDepth: 1 },
    });
    const visitedPaths = result.visitedFileIds
      .map((id) => workspace.graph.node(id)?.filePath ?? id)
      .sort();
    // Beide Wurzeln wurden bearbeitet; auf beiden Aesten endet die Tiefe bei 1.
    expect(visitedPaths).toEqual(["src/b.ts", "src/y.ts"]);
    expect(result.truncationReason).toBe("max_depth");
    expect(result.unvisitedRootFileIds).toBeUndefined();
  });

  it("nennt die Wurzeln, die ein erschoepftes GLOBALES Budget nie erreicht hat", async () => {
    // Bleibt eine Wurzel unbearbeitet, sagt `rootFileIds` allein das Gegenteil.
    const { workspace, byPath } = await idsByPath(TWO_ROOTS);
    const roots = [byPath.get("src/a.ts") as string, byPath.get("src/x.ts") as string].sort();
    const result = workspace.graph.traverse(roots, {
      direction: "forward",
      limits: { maxNodes: 1 },
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_nodes");
    expect(result.unvisitedRootFileIds).toEqual([roots[1]]);
  });
});

describe("Traversierung", () => {
  it("findet vorwaerts alle transitiven Abhaengigkeiten", async () => {
    const { workspace, byPath } = await idsByPath(BASE);
    const result = workspace.graph.dependenciesOf(byPath.get("src/a.ts") as string);
    const visitedPaths = result.visitedFileIds.map(
      (id) => workspace.graph.node(id)?.filePath ?? id,
    );
    expect(visitedPaths).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(result.truncated).toBe(false);
    expect(result.depthReached).toBe(3);
    expect(result.cycles).toEqual([]);
  });

  it("findet rueckwaerts alle Dateien, die brechen wuerden", async () => {
    const { workspace, byPath } = await idsByPath(BASE);
    const result = workspace.graph.dependentsOf(byPath.get("src/d.ts") as string);
    const visitedPaths = result.visitedFileIds
      .map((id) => workspace.graph.node(id)?.filePath ?? id)
      .sort();
    expect(visitedPaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(result.direction).toBe("reverse");
  });

  it("MELDET einen Zyklus, statt ihn stillschweigend aufzubrechen", async () => {
    const { workspace, byPath } = await idsByPath(CYCLIC);
    const start = byPath.get("src/a.ts") as string;
    const result = workspace.graph.dependenciesOf(start);
    expect(result.cycles).toHaveLength(1);
    const cyclePaths = (result.cycles[0] as string[]).map(
      (id) => workspace.graph.node(id)?.filePath ?? id,
    );
    expect(cyclePaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    // Der Zyklenschutz verhindert nur die Endlosschleife — der wiedergetroffene
    // Knoten ist sichtbar, das Ergebnis gilt trotzdem als vollstaendig.
    expect(result.revisitSkippedFileIds).toContain(start);
    expect(result.truncated).toBe(false);
  });

  it("bricht bei erreichter Tiefengrenze ab UND nennt den Grund", async () => {
    const { workspace, byPath } = await idsByPath(BASE);
    const result = workspace.graph.dependenciesOf(byPath.get("src/a.ts") as string, {
      maxDepth: 2,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_depth");
    expect(result.visitedFileIds).toHaveLength(2);
  });

  it("bricht bei erreichter Knotengrenze ab UND nennt den Grund", async () => {
    const { workspace, byPath } = await idsByPath(BASE);
    const result = workspace.graph.dependenciesOf(byPath.get("src/a.ts") as string, {
      maxNodes: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_nodes");
  });

  it("bricht bei erschoepftem Zeitbudget ab UND nennt den Grund", async () => {
    const { workspace, byPath } = await idsByPath(BASE);
    // Injizierte Uhr: jeder Aufruf springt um 1000 ms weiter, das Budget ist 1 ms.
    let tick = 0;
    const result = workspace.graph.dependenciesOf(
      byPath.get("src/a.ts") as string,
      { maxWallTimeMs: 1 },
      () => {
        tick += 1000;
        return tick;
      },
    );
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_wall_time");
  });

  it("gibt die Budgets im Ergebnis zurueck, damit eine Zahl lesbar bleibt", async () => {
    const { workspace, byPath } = await idsByPath(BASE);
    const result = workspace.graph.dependenciesOf(byPath.get("src/a.ts") as string, {
      maxDepth: 7,
    });
    expect(result.limits.maxDepth).toBe(7);
    expect(result.rootFileIds).toEqual([byPath.get("src/a.ts")]);
  });
});

describe("Graphmetriken", () => {
  it("meldet Zyklen und stark zusammenhaengende Komponenten", async () => {
    const { workspace, byPath } = await idsByPath(CYCLIC);
    const metrics = workspace.graph.metrics();
    expect(metrics.stronglyConnectedComponents).toHaveLength(1);
    expect(metrics.stronglyConnectedComponents[0]).toHaveLength(3);
    expect(metrics.cycles).toHaveLength(1);
    const cyclePaths = (metrics.cycles[0] as string[]).map(
      (id) => workspace.graph.node(id)?.filePath ?? id,
    );
    expect(cyclePaths.sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(metrics.truncationReason).toBeUndefined();
    expect(byPath.size).toBe(3);
  });

  it("meldet einen Selbstbezug als einelementigen Zyklus", async () => {
    const { workspace } = await idsByPath({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "src/self.ts": 'import "./self.js";\nexport const self = 1;\n',
    });
    expect(workspace.graph.metrics().cycles).toHaveLength(1);
    expect(workspace.graph.metrics().cycles[0]).toHaveLength(1);
  });

  it("zaehlt Orphans, Grade und die Import-Resolution-Rate", async () => {
    const { workspace } = await idsByPath({
      ...BASE,
      "src/lonely.ts": "export const lonely = 1;\n",
      "src/broken.ts": 'import "./ghost.js";\nexport const broken = 1;\n',
    });
    const metrics = workspace.graph.metrics();
    const lonely = workspace.graph.nodes().find((node) => node.filePath === "src/lonely.ts");
    expect(metrics.orphanFileIds).toContain(lonely?.fileId);
    expect(metrics.importResolution.resolvedCount).toBe(3);
    expect(metrics.importResolution.unresolvedCount).toBe(1);
    expect(metrics.importResolution.rate).toBeCloseTo(3 / 4, 10);
    expect(metrics.languageDistribution["typescript"]).toBe(6);
    expect(metrics.centralityFormula).toContain("degree-centrality-v1");
  });

  it("meldet eine abgeschnittene Zyklenliste, statt sie vollstaendig aussehen zu lassen", async () => {
    const limited = await buildMiniWorkspace(CYCLIC, { maxCycles: 0 });
    const metrics = limited.graph.metrics();
    expect(metrics.cycles).toEqual([]);
    expect(metrics.truncationReason).toContain("maxCycles=0");
  });
});
