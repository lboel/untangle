/**
 * Der Mehr-Repository-Fall — und zwar der unbequeme davon.
 *
 * Ein Workspace darf aus mehreren Repositories bestehen. Paketnamen sind dann
 * NICHT eindeutig: zwei Repositories duerfen beide ein `shared-lib` fuehren.
 * Ein Katalog, der nach Namen allein schluesselt, verliert in diesem Moment
 * das frueher eingefuegte Paket ersatzlos — mit drei sichtbaren Folgen, die
 * hier je einzeln geprueft werden:
 *
 * 1. die Abhaengigkeiten eines Pakets kommen aus dem Manifest des anderen;
 * 2. ein Import auf den Namen loest ins FALSCHE Repository auf und wird als
 *    Erfolg gezaehlt;
 * 3. `boundary.crossPackage` ist false, obwohl eine Repositorygrenze
 *    ueberquert wird.
 */
import { MemoryFileSystem, FakeClock } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { FileDependencyGraph } from "./graph.js";
import { dirnameOf, normalizePath } from "./paths.js";
import { fileImportsOf } from "./test-support/parse.js";
import { aliasRulesFromConfigs, loadWorkspaceTopology } from "./topology/load.js";
import type {
  FileImportsV1,
  ImportResolverV1,
  RepositoryInputV1,
  WorkspaceTopologyV1,
} from "./types.js";

const WORKSPACE_ID = "ws-multi";
const GENERATION = "gen-multi";

interface RepoSeedV1 {
  repoId: string;
  root: string;
  files: Readonly<Record<string, string>>;
}

interface MultiRepoWorkspaceV1 {
  graph: FileDependencyGraph;
  topology: WorkspaceTopologyV1;
  files: FileImportsV1[];
}

async function buildMultiRepoWorkspace(
  seeds: readonly RepoSeedV1[],
  pipeline?: readonly ImportResolverV1[],
): Promise<MultiRepoWorkspaceV1> {
  const fs = new MemoryFileSystem(new FakeClock(0));
  const repositories: RepositoryInputV1[] = seeds.map((seed) => ({
    repoId: seed.repoId,
    refId: `${seed.repoId}:refs/heads/main`,
    rootPath: seed.root,
  }));

  for (const seed of seeds) {
    fs.seedDirectory(seed.root);
    for (const [path, content] of Object.entries(seed.files)) {
      const relative = normalizePath(path);
      let directory = dirnameOf(relative);
      const parents: string[] = [];
      while (directory !== "") {
        parents.unshift(directory);
        directory = dirnameOf(directory);
      }
      for (const parent of parents) fs.seedDirectory(`${seed.root}/${parent}`);
      fs.seedFile(`${seed.root}/${relative}`, content);
    }
  }

  const loaded = await loadWorkspaceTopology(fs, {
    workspaceId: WORKSPACE_ID,
    generationId: GENERATION,
    repositories,
  });

  const files: FileImportsV1[] = [];
  for (const seed of seeds) {
    for (const [path, content] of Object.entries(seed.files)) {
      const relative = normalizePath(path);
      if (!relative.endsWith(".ts")) continue;
      files.push(
        fileImportsOf({
          workspaceId: WORKSPACE_ID,
          repoId: seed.repoId,
          refId: `${seed.repoId}:refs/heads/main`,
          path: relative,
          content,
        }),
      );
    }
  }

  const graph = FileDependencyGraph.build({
    workspaceId: WORKSPACE_ID,
    graphGeneration: GENERATION,
    repositories,
    files,
    topology: loaded.topology,
    projectAliases: aliasRulesFromConfigs(loaded.projectConfigs),
    ...(pipeline === undefined ? {} : { pipeline }),
  });
  return { graph, topology: loaded.topology, files };
}

/** Zwei Repositories, beide mit einem Paket namens `shared-lib`. */
const COLLIDING = [
  {
    repoId: "rA",
    root: "/w/a",
    files: {
      "package.json": JSON.stringify({
        name: "shared-lib",
        version: "1.0.0",
        main: "src/index.ts",
        dependencies: { "left-only": "^1.0.0" },
      }),
      "src/index.ts": "export const fromA = 1;\n",
      "src/app.ts": 'import "shared-lib";\nexport const app = 1;\n',
    },
  },
  {
    repoId: "rB",
    root: "/w/b",
    files: {
      "package.json": JSON.stringify({
        name: "shared-lib",
        version: "2.0.0",
        main: "src/index.ts",
        dependencies: { "right-only": "^2.0.0" },
      }),
      "src/index.ts": "export const fromB = 1;\n",
    },
  },
] as const;

describe("Paketkatalog ueber Repositorygrenzen", () => {
  it("laesst gleichnamige Pakete zweier Repositories NICHT einander verdecken", async () => {
    const { topology } = await buildMultiRepoWorkspace(COLLIDING);
    const shared = topology.packages.filter((entry) => entry.name === "shared-lib");
    expect(shared.map((entry) => entry.repoId)).toEqual(["rA", "rB"]);
    // Regression: jedes Paket bekommt die Abhaengigkeiten SEINES Manifests.
    expect(shared[0]?.externalDependencies).toEqual({ "left-only": "^1.0.0" });
    expect(shared[1]?.externalDependencies).toEqual({ "right-only": "^2.0.0" });
    expect(shared[0]?.version).toBe("1.0.0");
    expect(shared[1]?.version).toBe("2.0.0");
  });

  it("meldet die Namensgleichheit im Skip-Ledger, statt sie stillschweigend hinzunehmen", async () => {
    const { topology } = await buildMultiRepoWorkspace(COLLIDING);
    const entry = topology.skipped.entries.find((candidate) =>
      candidate.detail.includes('package name "shared-lib"'),
    );
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("ambiguous_resolution");
    expect(entry?.detail).toContain("rA");
    expect(entry?.detail).toContain("rB");
  });

  it("loest einen Import auf den Namen im EIGENEN Repository auf, nicht im fremden", async () => {
    const { graph } = await buildMultiRepoWorkspace(COLLIDING);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "shared-lib");
    expect(edge?.resolution.status).toBe("resolved");
    if (edge?.resolution.status !== "resolved") return;
    expect(edge.resolution.targetRepoId).toBe("rA");
    expect(edge.resolution.targetPath).toBe("src/index.ts");
    expect(edge.boundary.crossRepo).toBe(false);
  });

  it("nennt eine Kante ins andere Repository auch dann eine Paketgrenze, wenn die Namen gleich sind", async () => {
    // `crossPackage` darf nicht am NAMEN haengen: `rA/shared-lib` und
    // `rB/shared-lib` sind verschiedene Pakete, und eine Kante zwischen ihnen
    // ueberquert sehr wohl eine Paketgrenze.
    //
    // Erreicht wird der Fall ueber die vorgesehene Erweiterungsstelle
    // (`BuildFileGraphInputV1.pipeline`): der Standardkatalog bevorzugt seit
    // der Reparatur das eigene Repository und kann diese Kante gar nicht mehr
    // erzeugen — ein fremder Resolver darf es.
    const crossRepoResolver: ImportResolverV1 = {
      name: "test-cross-repo",
      supports: (specifier) => specifier === "shared-lib",
      resolve: () => ({
        status: "resolved",
        mechanism: "workspace-package",
        targetRepoId: "rB",
        targetPath: "src/index.ts",
        viaPackageName: "shared-lib",
      }),
    };
    const { graph } = await buildMultiRepoWorkspace(COLLIDING, [crossRepoResolver]);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "shared-lib");
    expect(edge?.resolution.status).toBe("resolved");
    if (edge?.resolution.status !== "resolved") return;
    expect(edge.resolution.targetRepoId).toBe("rB");
    expect(edge.boundary.crossRepo).toBe(true);
    expect(edge.boundary.fromPackageName).toBe("shared-lib");
    expect(edge.boundary.toPackageName).toBe("shared-lib");
    expect(edge.boundary.crossPackage).toBe(true);
  });

  it("raet bei mehreren fremden Repositories nicht, sondern meldet Mehrdeutigkeit", async () => {
    const { graph } = await buildMultiRepoWorkspace([
      {
        repoId: "rApp",
        root: "/w/app",
        files: {
          "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
          "src/app.ts": 'import "shared-lib";\nexport const app = 1;\n',
        },
      },
      {
        repoId: "rA",
        root: "/w/a",
        files: {
          "package.json": JSON.stringify({
            name: "shared-lib",
            version: "1.0.0",
            main: "src/index.ts",
          }),
          "src/index.ts": "export const fromA = 1;\n",
        },
      },
      {
        repoId: "rB",
        root: "/w/b",
        files: {
          "package.json": JSON.stringify({
            name: "shared-lib",
            version: "2.0.0",
            main: "src/index.ts",
          }),
          "src/index.ts": "export const fromB = 1;\n",
        },
      },
    ]);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "shared-lib");
    expect(edge?.resolution.status).toBe("unresolved");
    if (edge?.resolution.status !== "unresolved") return;
    expect(edge.resolution.reason).toBe("ambiguous_candidates");
    expect(edge.resolution.detail).toContain("rA");
    expect(edge.resolution.detail).toContain("rB");
    expect(edge.resolution.rejectedCandidates).toBeDefined();
  });

  it("fuellt targetRefId aufgeloester Cross-Repo-Kanten aus dem Repositoryeintrag", async () => {
    const { graph } = await buildMultiRepoWorkspace([
      {
        repoId: "rApp",
        root: "/w/app",
        files: {
          "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
          "src/app.ts": 'import "shared-lib";\nexport const app = 1;\n',
        },
      },
      {
        repoId: "rLib",
        root: "/w/lib",
        files: {
          "package.json": JSON.stringify({
            name: "shared-lib",
            version: "1.0.0",
            main: "src/index.ts",
          }),
          "src/index.ts": "export const lib = 1;\n",
        },
      },
    ]);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "shared-lib");
    expect(edge?.resolution.status).toBe("resolved");
    if (edge?.resolution.status !== "resolved") return;
    expect(edge.resolution.targetRepoId).toBe("rLib");
    expect(edge.resolution.targetRefId).toBe("rLib:refs/heads/main");
    expect(edge.boundary.crossRepo).toBe(true);
  });
});

/**
 * EIN Repository, ZWEI Manifeste mit demselben Paketnamen.
 *
 * Der Bestand ist fehlerhaft — aber genau deshalb darf der Graph ihn nicht
 * glaetten: `packages/app` verlangt `^2.0.0` (das waere `packages/beta`),
 * und wer stillschweigend das in kanonischer Ordnung erste Paket
 * (`packages/alpha`, Version 1.0.0) nimmt, hat GERATEN und den Fehlgriff als
 * Erfolg gezaehlt.
 */
const DUPLICATE_IN_ONE_REPO = [
  {
    repoId: "rA",
    root: "/w/a",
    files: {
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
      }),
      "packages/alpha/package.json": JSON.stringify({
        name: "shared-lib",
        version: "1.0.0",
        main: "src/index.ts",
      }),
      "packages/alpha/src/index.ts": "export const alpha = 1;\n",
      "packages/beta/package.json": JSON.stringify({
        name: "shared-lib",
        version: "2.0.0",
        main: "src/index.ts",
      }),
      "packages/beta/src/index.ts": "export const beta = 1;\n",
      "packages/app/package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "shared-lib": "^2.0.0" },
      }),
      "packages/app/src/main.ts": 'import "shared-lib";\nexport const main = 1;\n',
    },
  },
] as const;

describe("Namensgleichheit INNERHALB eines Repositories", () => {
  it("meldet zwei gleichnamige Manifeste desselben Repositories im Skip-Ledger", async () => {
    const { topology } = await buildMultiRepoWorkspace(DUPLICATE_IN_ONE_REPO);
    const entry = topology.skipped.entries.find((candidate) =>
      candidate.detail.includes('package name "shared-lib"'),
    );
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("ambiguous_resolution");
    expect(entry?.detail).toContain("packages/alpha/package.json");
    expect(entry?.detail).toContain("packages/beta/package.json");
  });

  it("raet NICHT auf das erste der beiden gleichnamigen Pakete", async () => {
    const { graph } = await buildMultiRepoWorkspace(DUPLICATE_IN_ONE_REPO);
    const edge = graph.edges().find((candidate) => candidate.rawSpecifier === "shared-lib");
    expect(edge).toBeDefined();
    expect(edge?.resolution.status).toBe("unresolved");
    if (edge?.resolution.status !== "unresolved") return;
    expect(edge.resolution.reason).toBe("ambiguous_candidates");
  });

  it("fuehrt beide gleichnamigen Pakete des Repositories im Katalog", async () => {
    const { topology } = await buildMultiRepoWorkspace(DUPLICATE_IN_ONE_REPO);
    const shared = topology.packages.filter((entry) => entry.name === "shared-lib");
    expect(shared.map((entry) => entry.packageDir)).toEqual(["packages/alpha", "packages/beta"]);
    expect(shared.map((entry) => entry.version)).toEqual(["1.0.0", "2.0.0"]);
  });
});
