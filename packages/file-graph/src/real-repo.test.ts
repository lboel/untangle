/**
 * Der Ernstfall: der Dateigraph gegen DIESES Repository.
 *
 * Kein Fixture, kein Mock, keine handgeschriebene Importliste — echter
 * Scanner, echte Parseradapter, echte `package.json`-, `tsconfig.json`- und
 * Kompositionsdateien. Ein Monorepo mit vierzehn Paketen, `workspace:`-
 * Protokoll, `exports`-Karten, geerbten Projektkonfigurationen und
 * ESM-Endungen im TypeScript-Quelltext ist genau die Kombination, an der
 * eine nur an Fixtures gepruefte Aufloesung auseinanderfaellt (E5).
 */
import { fileURLToPath } from "node:url";

import { validateFileEdge, validateSkipLedger } from "@untangle-code/domain";
import { discoverFiles } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";
import { beforeAll, describe, expect, it } from "vitest";

import { FileDependencyGraph } from "./graph.js";
import { normalizeSeparators } from "./paths.js";
import { fileImportsOf } from "./test-support/parse.js";
import { aliasRulesFromConfigs, loadWorkspaceTopology } from "./topology/load.js";
import type { AliasRuleV1, FileImportsV1, RepositoryInputV1 } from "./types.js";

const REPO_ROOT = normalizeSeparators(
  fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, ""),
);
const WORKSPACE_ID = "ws-untangle";
const REPO_ID = "repo-untangle";
const REF_ID = `${REPO_ID}:refs/heads/main`;
const GENERATION = "gen-real";

/** Nur die TypeScript-Quellen der Pakete — sie tragen die interessanten Kanten. */
const SOURCE_PATTERN = /^packages\/[^/]+\/src\/.*\.(ts|tsx|mts|cts)$/;

interface RealWorkspace {
  files: FileImportsV1[];
  projectAliases: AliasRuleV1[];
  graph: FileDependencyGraph;
  repositories: RepositoryInputV1[];
  topologyPackages: string[];
}

let workspace: RealWorkspace;
/**
 * Ein ZWEITER, unabhaengiger Aufbau desselben Standes. Er wird von der
 * Determinismus- und der Fortschreibungspruefung geteilt, weil ein weiterer
 * Durchlauf ueber alle Quellen dieses Repositories rund zwanzig Sekunden
 * kostet — und beide Pruefungen genau dasselbe brauchen.
 */
let secondWorkspace: RealWorkspace;

async function buildRealWorkspace(): Promise<RealWorkspace> {
  const fs = new NodeFileSystem();
  const repositories: RepositoryInputV1[] = [
    { repoId: REPO_ID, refId: REF_ID, rootPath: REPO_ROOT },
  ];
  const loaded = await loadWorkspaceTopology(fs, {
    workspaceId: WORKSPACE_ID,
    generationId: GENERATION,
    repositories,
  });

  const files: FileImportsV1[] = [];
  for await (const scanned of discoverFiles({
    fs,
    roots: [REPO_ROOT],
    repoRoot: REPO_ROOT,
  })) {
    if (!SOURCE_PATTERN.test(scanned.relativePath)) continue;
    const content = await fs.readTextFile(scanned.absolutePath);
    files.push(
      fileImportsOf({
        workspaceId: WORKSPACE_ID,
        repoId: REPO_ID,
        refId: REF_ID,
        path: scanned.relativePath,
        content,
      }),
    );
  }

  const projectAliases = aliasRulesFromConfigs(loaded.projectConfigs);
  const graph = FileDependencyGraph.build({
    workspaceId: WORKSPACE_ID,
    graphGeneration: GENERATION,
    repositories,
    files,
    topology: loaded.topology,
    projectAliases,
  });

  return {
    files,
    projectAliases,
    graph,
    repositories,
    topologyPackages: loaded.topology.packages.map((entry) => entry.name),
  };
}

beforeAll(async () => {
  workspace = await buildRealWorkspace();
  secondWorkspace = await buildRealWorkspace();
}, 300_000);

describe("Dateigraph gegen dieses Repository", () => {
  it("findet die Quelldateien aller Pakete", () => {
    expect(workspace.files.length).toBeGreaterThan(100);
    expect(workspace.graph.nodes().length).toBe(workspace.files.length);
  });

  it("liest die Monorepo-Topologie: pnpm-workspace.yaml und alle Paketmanifeste", () => {
    expect(workspace.topologyPackages).toContain("@untangle-code/domain");
    expect(workspace.topologyPackages).toContain("@untangle-code/file-graph");
    expect(workspace.topologyPackages).toContain("@untangle-code/parser-registry");
    // Vierzehn Pakete plus das Wurzelmanifest plus fixtures/benchmarks.
    expect(workspace.topologyPackages.length).toBeGreaterThanOrEqual(15);
  });

  it("erkennt die Paketebene: workspace-Abhaengigkeiten sind Kanten", () => {
    const topology = workspace.graph.snapshot().topology;
    expect(topology.workspaceGlobs).toContain("packages/*");
    const fromFileGraph = topology.packageEdges.filter(
      (edge) => edge.fromPackage === "@untangle-code/file-graph",
    );
    expect(fromFileGraph.map((edge) => edge.toPackage)).toContain("@untangle-code/domain");
    expect(fromFileGraph.every((edge) => edge.rawRange.startsWith("workspace:"))).toBe(true);
  });

  it("erkennt die Dienstebene aus der echten Kompositionsdatei", () => {
    const topology = workspace.graph.snapshot().topology;
    const names = topology.services.map((service) => service.name);
    expect(names).toContain("qdrant");
    expect(names).toContain("ollama");
    expect(
      topology.services.every((service) => service.composeFile.endsWith("docker-compose.yml")),
    ).toBe(true);
    // Beide Dienste haben keine eigene `networks`-Angabe, liegen also im
    // impliziten default-Netzwerk und koennen einander erreichen.
    expect(topology.serviceEdges).toContainEqual({
      fromService: "ollama",
      toService: "qdrant",
      kind: "shared-network",
      network: "default",
    });
  });

  it("loest die ESM-Endungen des TypeScript-Quelltextes auf", () => {
    const relativeEdges = workspace.graph
      .edges()
      .filter((edge) => edge.rawSpecifier.startsWith("./") || edge.rawSpecifier.startsWith("../"));
    expect(relativeEdges.length).toBeGreaterThan(200);
    const resolved = relativeEdges.filter((edge) => edge.resolution.status === "resolved");
    // Ein `./x.js`, das in Wirklichkeit `x.ts` ist, MUSS aufgeloest werden —
    // sonst waere in diesem Repository fast jede interne Kante blind.
    expect(resolved.length / relativeEdges.length).toBeGreaterThan(0.95);
  });

  it("meldet einen relativen Import nur dann als unaufgeloest, wenn das Ziel wirklich fehlt", () => {
    // Die Gegenprobe zur Quote: KEINE unaufgeloeste Kante darf einen Kandidaten
    // nennen, den der Index in Wirklichkeit kennt. Genau das waere der stille
    // Fehler, den E4 verbietet — „nicht gefunden", obwohl die Datei da ist.
    const knownPaths = new Set(workspace.files.map((file) => file.path));
    const lies: string[] = [];
    for (const edge of workspace.graph.edges()) {
      if (edge.resolution.status !== "unresolved") continue;
      for (const candidate of edge.resolution.rejectedCandidates ?? []) {
        if (knownPaths.has(candidate)) {
          lies.push(`${edge.fromPath} -> ${edge.rawSpecifier}: ${candidate} exists`);
        }
      }
    }
    expect(lies).toEqual([]);
  });

  it("loest Workspace-Pakete ueber exports und die dist→src-Rueckabbildung auf", () => {
    const domainEdges = workspace.graph
      .edges()
      .filter((edge) => edge.rawSpecifier === "@untangle-code/domain");
    expect(domainEdges.length).toBeGreaterThan(20);
    for (const edge of domainEdges) {
      expect(edge.resolution).toMatchObject({
        status: "resolved",
        targetPath: "packages/domain/src/index.ts",
        viaPackageName: "@untangle-code/domain",
      });
      expect(edge.boundary.crossPackage).toBe(true);
      expect(edge.boundary.crossRepo).toBe(false);
    }
  });

  it("erreicht eine hohe Import-Resolution-Rate und meldet den Rest benannt", () => {
    const metrics = workspace.graph.metrics();
    const internalOrExternal =
      metrics.importResolution.resolvedCount + metrics.importResolution.externalCount;
    const total = internalOrExternal + metrics.importResolution.unresolvedCount;
    // Jeder Import ist entweder aufgeloest oder als externes Paket benannt.
    expect(internalOrExternal / total).toBeGreaterThan(0.99);
    for (const edge of workspace.graph.edges()) {
      if (edge.resolution.status !== "unresolved") continue;
      expect(edge.resolution.detail.trim().length).toBeGreaterThan(0);
      expect(edge.rawSpecifier.trim().length).toBeGreaterThan(0);
    }
  });

  it("erfuellt fuer JEDE Kante des echten Repositories die domain-Invarianten", () => {
    for (const edge of workspace.graph.edges()) {
      expect(validateFileEdge(edge), `${edge.fromPath} -> ${edge.rawSpecifier}`).toEqual([]);
    }
    expect(validateSkipLedger(workspace.graph.snapshot().skipped)).toEqual([]);
  });

  it("beantwortet die Wirkungsfrage: wer bricht, wenn domain sich aendert", () => {
    const domainIndex = workspace.graph
      .nodes()
      .find((node) => node.filePath === "packages/domain/src/index.ts");
    expect(domainIndex).toBeDefined();
    const impact = workspace.graph.dependentsOf(domainIndex?.fileId as string, {
      maxNodes: 10_000,
      maxDepth: 32,
    });
    expect(impact.truncated).toBe(false);
    const packages = new Set(
      impact.visitedFileIds.map((id) => workspace.graph.node(id)?.packageName ?? "?"),
    );
    // Die Wirkung reicht ueber Paketgrenzen — das ist der Punkt der Uebung.
    expect(packages.size).toBeGreaterThan(5);
    expect(packages.has("@untangle-code/file-graph")).toBe(true);
  });

  it("beantwortet die Gegenrichtung: woran haengt der Dateigraph selbst", () => {
    const entry = workspace.graph
      .nodes()
      .find((node) => node.filePath === "packages/file-graph/src/index.ts");
    const dependencies = workspace.graph.dependenciesOf(entry?.fileId as string, {
      maxNodes: 10_000,
      maxDepth: 32,
    });
    const paths = dependencies.visitedFileIds.map((id) => workspace.graph.node(id)?.filePath);
    expect(paths).toContain("packages/file-graph/src/graph.ts");
    expect(paths).toContain("packages/file-graph/src/metrics.ts");
    expect(paths).toContain("packages/domain/src/index.ts");
  });

  it("ist deterministisch: ein zweiter Lauf liefert byteweise dasselbe Abbild", () => {
    expect(JSON.stringify(secondWorkspace.graph.snapshot())).toBe(
      JSON.stringify(workspace.graph.snapshot()),
    );
  });

  it("schreibt eine geaenderte echte Datei fort wie ein Neubau", () => {
    // Der zweite Aufbau wird hier VERAENDERT — deshalb steht die
    // Determinismuspruefung oben, vor dieser.
    const fresh = secondWorkspace;
    const target = fresh.files.find((file) => file.path === "packages/file-graph/src/metrics.ts");
    expect(target).toBeDefined();
    const stripped: FileImportsV1 = { ...(target as FileImportsV1), imports: [] };
    fresh.graph.applyChanges([{ kind: "modified", file: stripped }]);

    const rebuiltFiles = fresh.files.map((file) =>
      file.fileId === stripped.fileId ? stripped : file,
    );
    const rebuilt = FileDependencyGraph.build({
      workspaceId: WORKSPACE_ID,
      graphGeneration: GENERATION,
      repositories: fresh.repositories,
      files: rebuiltFiles,
      topology: fresh.graph.snapshot().topology,
      projectAliases: fresh.projectAliases,
    });
    expect(JSON.stringify(fresh.graph.snapshot())).toBe(JSON.stringify(rebuilt.snapshot()));
  });
});
