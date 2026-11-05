import { validateFileEdge, validateSkipLedger } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildMiniWorkspace } from "./test-support/workspace.js";

/** Kleiner, aber vollstaendiger Monorepo-Ausschnitt inklusive Compose-Datei. */
const WORKSPACE = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "package.json": JSON.stringify({
    name: "root",
    private: true,
    devDependencies: { vitest: "3.2.7" },
  }),
  "tsconfig.base.json": JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@app/*": ["packages/app/src/*"] } },
  }),
  "packages/core/package.json": JSON.stringify({
    name: "@demo/core",
    version: "1.0.0",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  }),
  "packages/core/tsconfig.json": JSON.stringify({
    extends: "../../tsconfig.base.json",
    compilerOptions: { rootDir: "src", outDir: "dist" },
  }),
  "packages/core/src/index.ts": 'export { helper } from "./helper.js";\n',
  "packages/core/src/helper.ts": 'import fs from "node:fs";\nexport const helper = () => fs;\n',
  "packages/app/package.json": JSON.stringify({
    name: "@demo/app",
    version: "1.0.0",
    dependencies: { "@demo/core": "workspace:*", "left-pad": "1.0.0" },
  }),
  "packages/app/tsconfig.json": JSON.stringify({
    extends: "../../tsconfig.base.json",
    compilerOptions: { rootDir: "src", outDir: "dist" },
  }),
  "packages/app/src/main.ts":
    'import { helper } from "@demo/core";\nimport { util } from "./util.js";\nimport missing from "./nope.js";\nexport const run = () => helper() + util();\n',
  "packages/app/src/util.ts": "export const util = () => 1;\n",
  "docker-compose.yml":
    "services:\n  api:\n    build:\n      context: ./packages/app\n    depends_on:\n      - db\n  db:\n    image: postgres:16\n",
};

describe("FileDependencyGraph — Aufbau an einem Monorepo-Ausschnitt", () => {
  it("baut Knoten fuer jede Quelldatei und ordnet sie ihrem Paket zu", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const byPath = new Map(graph.nodes().map((node) => [node.filePath, node]));
    expect([...byPath.keys()].sort()).toEqual([
      "packages/app/src/main.ts",
      "packages/app/src/util.ts",
      "packages/core/src/helper.ts",
      "packages/core/src/index.ts",
    ]);
    expect(byPath.get("packages/app/src/main.ts")?.packageName).toBe("@demo/app");
    expect(byPath.get("packages/core/src/index.ts")?.packageName).toBe("@demo/core");
  });

  it("erfuellt fuer jede erzeugte Kante die Invarianten aus domain", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    for (const edge of graph.edges()) {
      expect(validateFileEdge(edge), `${edge.fromPath} -> ${edge.rawSpecifier}`).toEqual([]);
    }
  });

  it("loest einen relativen Import ueber die ESM-Endungsrueckabbildung auf", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const edge = graph
      .edges()
      .find(
        (candidate) =>
          candidate.fromPath === "packages/app/src/main.ts" &&
          candidate.rawSpecifier === "./util.js",
      );
    expect(edge?.resolution).toMatchObject({
      status: "resolved",
      mechanism: "relative-path",
      targetPath: "packages/app/src/util.ts",
    });
  });

  it("loest einen Workspace-Import ueber exports UND die dist→src-Rueckabbildung auf", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "@demo/core");
    expect(edge?.resolution).toMatchObject({
      status: "resolved",
      mechanism: "package-exports",
      targetPath: "packages/core/src/index.ts",
      viaPackageName: "@demo/core",
    });
    expect(edge?.boundary).toMatchObject({
      crossRepo: false,
      crossPackage: true,
      fromPackageName: "@demo/app",
      toPackageName: "@demo/core",
    });
  });

  it("meldet ein Laufzeitmodul als extern statt es zu verwerfen", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "node:fs");
    expect(edge?.resolution).toEqual({
      status: "external",
      mechanism: "language-alias",
      packageName: "node:fs",
    });
    expect(edge?.boundary.crossRepo).toBe(false);
  });

  it("behaelt einen nicht aufloesbaren Import ALS KANTE mit Rohstring und Grund (E4)", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "./nope.js");
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe("import");
    expect(edge?.rawSpecifier).toBe("./nope.js");
    expect(edge?.resolution.status).toBe("unresolved");
    if (edge?.resolution.status === "unresolved") {
      expect(edge.resolution.reason).toBe("target_file_not_found");
      expect(edge.resolution.detail.length).toBeGreaterThan(0);
      // Die geprueften Kandidaten sind die Spur, die spaeter die
      // inkrementelle Fortschreibung praezise macht.
      expect(edge.resolution.rejectedCandidates).toContain("packages/app/src/nope.ts");
    }
    const node = graph
      .nodes()
      .find((candidate) => candidate.filePath === "packages/app/src/main.ts");
    expect(node?.unresolvedImportCount).toBe(1);
    expect(node?.imports).toContain("./nope.js");
  });

  it("meldet ein installiertes Paket als extern mit deklarierter Version", async () => {
    const { graph } = await buildMiniWorkspace({
      ...WORKSPACE,
      "packages/app/src/main.ts": 'import pad from "left-pad";\nexport const run = () => pad;\n',
    });
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "left-pad");
    expect(edge?.resolution).toEqual({
      status: "external",
      mechanism: "installed-package",
      packageName: "left-pad",
      declaredVersion: "1.0.0",
    });
  });

  it("liefert ein stimmiges Skip-Ledger", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    expect(validateSkipLedger(graph.snapshot().skipped)).toEqual([]);
  });

  it("erkennt die Container-Dienstebene aus der Kompositionsdatei", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const topology = graph.snapshot().topology;
    expect(topology.services.map((service) => service.name)).toEqual(["api", "db"]);
    expect(topology.serviceEdges).toContainEqual({
      fromService: "api",
      toService: "db",
      kind: "depends_on",
    });
    // Beide Dienste liegen ohne eigene `networks`-Angabe im impliziten
    // default-Netzwerk und koennen einander deshalb erreichen.
    expect(topology.serviceEdges).toContainEqual({
      fromService: "db",
      toService: "api",
      kind: "shared-network",
      network: "default",
    });
    // Nur der Dienst MIT Build-Kontext bekommt Dateien zugeordnet.
    const node = graph
      .nodes()
      .find((candidate) => candidate.filePath === "packages/app/src/main.ts");
    expect(node?.containerService).toBe("api");
    const coreNode = graph
      .nodes()
      .find((candidate) => candidate.filePath === "packages/core/src/index.ts");
    expect(coreNode?.containerService).toBeUndefined();
  });

  it("bildet die Paketebene aus workspace-Abhaengigkeiten ab", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const topology = graph.snapshot().topology;
    expect(topology.packages.map((entry) => entry.name)).toEqual([
      "@demo/app",
      "@demo/core",
      "root",
    ]);
    expect(topology.packageEdges).toContainEqual({
      fromPackage: "@demo/app",
      toPackage: "@demo/core",
      kind: "workspace-dependency",
      dependencyField: "dependencies",
      rawRange: "workspace:*",
    });
  });

  it("ist deterministisch: zwei Laeufe liefern dasselbe Abbild", async () => {
    const first = await buildMiniWorkspace(WORKSPACE);
    const second = await buildMiniWorkspace(WORKSPACE);
    expect(JSON.stringify(second.graph.snapshot())).toBe(JSON.stringify(first.graph.snapshot()));
  });

  it("loest einen Projekt-Alias aus tsconfig paths auf", async () => {
    const { graph } = await buildMiniWorkspace({
      ...WORKSPACE,
      "packages/core/src/helper.ts":
        'import { util } from "@app/util.js";\nexport const helper = () => util;\n',
      "packages/app/src/util.ts": "export const util = () => 1;\n",
    });
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "@app/util.js");
    expect(edge?.resolution).toMatchObject({
      status: "resolved",
      mechanism: "project-alias",
      targetPath: "packages/app/src/util.ts",
    });
  });
});
