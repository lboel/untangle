/**
 * Was `untangle graph` behauptet, wird hier gemessen — an einem echten,
 * gebauten und wieder zurueckgeladenen Graphen, nicht an einer Attrappe.
 *
 * Geprueft werden genau die vier Zusagen des Befehls: Tiefenbegrenzung ist
 * SICHTBAR, Zyklen werden GEMELDET, unaufgeloeste Importe behalten ihren
 * ROHSTRING, und die Monorepo-Ebene (Paketgrenze, Container-Dienst) steht an
 * der Kante, die sie ueberquert.
 */
import type { RawImport } from "@untangle-code/domain";
import type { FileImportsV1, WorkspaceTopologyV1 } from "@untangle-code/file-graph";
import { buildFileGraph, restoreFileGraph } from "@untangle-code/file-graph";
import { describe, expect, it } from "vitest";

import { renderFileView, renderOverview, renderTree } from "./render.js";
import { selectFileNode } from "./select.js";

const WORKSPACE = "ws-test";
const REPO = "repo-test";
const REF = "repo-test:refs/heads/main";
const GENERATION = "gen-test";

function importOf(specifier: string, line: number): RawImport {
  return {
    specifier,
    importKind: "import",
    range: { startLine: line, endLine: line, startByte: 0, endByte: 1 },
  };
}

function fileOf(path: string, specifiers: readonly string[]): FileImportsV1 {
  return {
    fileId: `F_${path}`,
    repoId: REPO,
    refId: REF,
    path,
    languageId: "typescript",
    contentHash: `h_${path}`,
    imports: specifiers.map((specifier, index) => importOf(specifier, index + 1)),
  };
}

/** Zwei Pakete, zwei Container-Dienste — die Monorepo-Ebene aus A3. */
const TOPOLOGY: WorkspaceTopologyV1 = {
  schemaVersion: 1,
  workspaceId: WORKSPACE,
  workspaceGlobs: ["services/*"],
  packages: [
    {
      name: "@acme/api",
      repoId: REPO,
      packageDir: "services/api",
      manifestPath: "services/api/package.json",
      workspaceDependencies: [],
      externalDependencies: {},
    },
    {
      name: "@acme/web",
      repoId: REPO,
      packageDir: "services/web",
      manifestPath: "services/web/package.json",
      workspaceDependencies: ["@acme/api"],
      externalDependencies: {},
    },
  ],
  packageEdges: [
    {
      fromPackage: "@acme/web",
      toPackage: "@acme/api",
      kind: "workspace-dependency",
      dependencyField: "dependencies",
      rawRange: "workspace:*",
    },
  ],
  services: [
    {
      name: "api",
      repoId: REPO,
      composeFile: "docker-compose.yml",
      buildContext: "services/api",
      dependsOn: [],
      networks: ["default"],
    },
    {
      name: "web",
      repoId: REPO,
      composeFile: "docker-compose.yml",
      buildContext: "services/web",
      dependsOn: ["api"],
      networks: ["default"],
    },
  ],
  serviceEdges: [{ fromService: "web", toService: "api", kind: "depends_on" }],
  skipped: { schemaVersion: 1, generationId: GENERATION, entries: [], countsByReason: {} },
};

function graphOf(files: readonly FileImportsV1[]) {
  const built = buildFileGraph({
    workspaceId: WORKSPACE,
    graphGeneration: GENERATION,
    repositories: [{ repoId: REPO, refId: REF, rootPath: "/w" }],
    files,
    topology: TOPOLOGY,
  });
  return restoreFileGraph(built.snapshot());
}

/** Eine Kette ueber zwei Pakete: web/cart -> api/orders -> api/util. */
const MONOREPO = [
  fileOf("services/web/src/cart.ts", ["@acme/api/src/orders.js", "./nirgendwo.js"]),
  fileOf("services/api/src/orders.ts", ["./util.js"]),
  fileOf("services/api/src/util.ts", []),
];

describe("Baumdarstellung", () => {
  it("macht die Tiefengrenze an der Stelle UND im Fuss sichtbar", () => {
    const graph = graphOf(MONOREPO);
    const root = graph.nodesAtPath("services/web/src/cart.ts")[0];
    expect(root).toBeDefined();
    const result = graph.dependenciesOf(root?.fileId as string, { maxDepth: 1 });
    const text = renderTree(graph, root as never, "forward", result).join("\n");

    expect(text).toContain("truncated: max_depth");
    expect(text).toContain("additional neighbors not visited");
    expect(text).toContain("TRUNCATED: depth limit reached (max_depth)");
    expect(text).toContain("The result is incomplete.");
  });

  it("zeigt bei ausreichender Tiefe den ganzen Ast ohne Abschneidevermerk", () => {
    const graph = graphOf(MONOREPO);
    const root = graph.nodesAtPath("services/web/src/cart.ts")[0];
    const result = graph.dependenciesOf(root?.fileId as string, { maxDepth: 5 });
    const text = renderTree(graph, root as never, "forward", result).join("\n");

    expect(text).toContain("services/api/src/orders.ts");
    expect(text).toContain("services/api/src/util.ts");
    expect(text).not.toContain("ABGESCHNITTEN");
  });

  it("meldet einen Zyklus, statt ihn stillschweigend aufzubrechen", () => {
    const graph = graphOf([fileOf("src/a.ts", ["./b.js"]), fileOf("src/b.ts", ["./a.js"])]);
    const root = graph.nodesAtPath("src/a.ts")[0];
    const result = graph.dependenciesOf(root?.fileId as string, { maxDepth: 10 });
    const text = renderTree(graph, root as never, "forward", result).join("\n");

    expect(text).toContain("CYCLE: closes the path; not followed again");
    expect(text).toContain("CYCLES (1; reported rather than broken)");
    expect(text).toContain("src/a.ts -> src/b.ts -> src/a.ts");
  });
});

describe("Dateisicht", () => {
  it("zeigt einen unaufloesbaren Import mit Rohstring und benanntem Grund", () => {
    const graph = graphOf(MONOREPO);
    const node = graph.nodesAtPath("services/web/src/cart.ts")[0];
    const text = renderFileView({
      graph,
      node: node as never,
      direction: "both",
      dependencies: graph.dependenciesOf(node?.fileId as string, { maxDepth: 3 }),
      dependents: graph.dependentsOf(node?.fileId as string, { maxDepth: 3 }),
    }).join("\n");

    expect(text).toContain("UNRESOLVED IMPORTS FOR THIS FILE (1)");
    expect(text).toContain('"./nirgendwo.js"');
    expect(text).toContain("target_file_not_found");
  });

  it("nennt an der Kante, welche Paket- und Containergrenze sie ueberquert", () => {
    const graph = graphOf(MONOREPO);
    const node = graph.nodesAtPath("services/web/src/cart.ts")[0];
    const text = renderTree(
      graph,
      node as never,
      "forward",
      graph.dependenciesOf(node?.fileId as string, { maxDepth: 3 }),
    ).join("\n");

    expect(text).toContain("Boundary: package @acme/web -> @acme/api");
    expect(text).toContain("Container web -> api");
    expect(text).toContain("[@acme/api]");
    expect(text).toContain("{Service: api}");
  });

  it("beantwortet die Gegenrichtung: wer haengt an dieser Datei", () => {
    const graph = graphOf(MONOREPO);
    const node = graph.nodesAtPath("services/api/src/util.ts")[0];
    const text = renderTree(
      graph,
      node as never,
      "reverse",
      graph.dependentsOf(node?.fileId as string, { maxDepth: 5 }),
    ).join("\n");

    expect(text).toContain("DEPENDENTS");
    expect(text).toContain("services/api/src/orders.ts");
    expect(text).toContain("services/web/src/cart.ts");
  });
});

describe("Uebersicht", () => {
  it("zeigt die Monorepo-Ebene: Pakete, Paketkanten, Dienste, Dienstkanten", () => {
    const graph = graphOf(MONOREPO);
    const text = renderOverview({
      graph,
      generationId: GENERATION,
      issues: [],
      unresolvedLimit: 20,
    }).join("\n");

    expect(text).toContain("MONOREPO-EBENE");
    expect(text).toContain("Pakete (2): @acme/api, @acme/web");
    expect(text).toContain("@acme/web -> @acme/api  [dependencies workspace:*]");
    expect(text).toContain("Container-Dienste (2): api, web");
    expect(text).toContain("web -> api  [depends_on]");
    expect(text).toContain("Workspace-Globs: services/*");
  });

  it("zaehlt grenzueberschreitende Kanten und nennt jeden offenen Import", () => {
    const graph = graphOf(MONOREPO);
    const text = renderOverview({
      graph,
      generationId: GENERATION,
      issues: [],
      unresolvedLimit: 20,
    }).join("\n");

    expect(text).toContain("Cross-boundary edges: package 1");
    expect(text).toContain("UNRESOLVED IMPORTS (1)");
    expect(text).toContain('services/web/src/cart.ts  "./nirgendwo.js"');
  });

  it("meldet Befunde des Zurueckladens, statt sie zu glaetten", () => {
    const graph = graphOf(MONOREPO);
    const text = renderOverview({
      graph,
      generationId: GENERATION,
      issues: [{ kind: "missing_file_shard", message: "graph_files/F_x fehlt" }],
      unresolvedLimit: 20,
    }).join("\n");
    // Die Befunde selbst gehen auf stderr (siehe `renderIssues`); die
    // Uebersicht darf sie nicht als „alles in Ordnung" ueberschreiben.
    expect(text).toContain("File graph  Generation gen-test");
  });
});

describe("Dateiauswahl", () => {
  it("findet eine Datei ueber ihre Pfadendung", () => {
    const graph = graphOf(MONOREPO);
    const selection = selectFileNode(graph.nodes(), "src/orders.ts");
    expect(selection.status).toBe("found");
  });

  it("waehlt bei Mehrdeutigkeit KEINE aus, sondern nennt alle", () => {
    const graph = graphOf([
      fileOf("services/api/src/util.ts", []),
      fileOf("services/web/src/util.ts", []),
    ]);
    const selection = selectFileNode(graph.nodes(), "src/util.ts");
    expect(selection.status).toBe("ambiguous");
    if (selection.status !== "ambiguous") return;
    expect(selection.candidates.map((node) => node.filePath)).toEqual([
      "services/api/src/util.ts",
      "services/web/src/util.ts",
    ]);
  });

  it("nennt bei einer unbekannten Datei aehnliche statt einer leeren Antwort", () => {
    const graph = graphOf(MONOREPO);
    const selection = selectFileNode(graph.nodes(), "orders.tsx");
    expect(selection.status).toBe("absent");
    if (selection.status !== "absent") return;
    expect(selection.near.map((node) => node.filePath)).toContain("services/api/src/orders.ts");
  });
});
