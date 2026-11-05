/**
 * Testhilfe: ein vollstaendiger Miniatur-Workspace im Speicher.
 *
 * Baut aus einer Datei-Landkarte ein `MemoryFileSystem`, laedt die Topologie
 * darueber (also ueber denselben Codepfad, den ein echtes Repository nimmt)
 * und parst alle Quelldateien mit den echten Adaptern.
 */
import { MemoryFileSystem, FakeClock } from "@untangle-code/testkit";

import { FileDependencyGraph } from "../graph.js";
import { dirnameOf, normalizePath } from "../paths.js";
import { aliasRulesFromConfigs, loadWorkspaceTopology } from "../topology/load.js";
import type {
  AliasRuleV1,
  FileGraphLimitsV1,
  FileImportsV1,
  RepositoryInputV1,
  WorkspaceTopologyV1,
} from "../types.js";

import { fileImportsOf } from "./parse.js";

export const TEST_WORKSPACE_ID = "ws-test";
export const TEST_REPO_ID = "repo-test";
export const TEST_REF_ID = "repo-test:refs/heads/main";
export const TEST_GENERATION = "gen-test";
export const TEST_ROOT = "/w";

export interface MiniWorkspaceV1 {
  fs: MemoryFileSystem;
  repositories: RepositoryInputV1[];
  files: FileImportsV1[];
  projectAliases: AliasRuleV1[];
  topology: WorkspaceTopologyV1;
  graph: FileDependencyGraph;
}

/** Dateien, die als Quelltext geparst werden (alles andere ist nur Konfiguration). */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".vue",
];

/** Baut Dateisystem, Topologie und Graph aus einer Pfad→Inhalt-Landkarte. */
export async function buildMiniWorkspace(
  fileMap: Readonly<Record<string, string>>,
  limits?: Partial<FileGraphLimitsV1>,
): Promise<MiniWorkspaceV1> {
  const fs = new MemoryFileSystem(new FakeClock(0));
  fs.seedDirectory(TEST_ROOT);
  for (const [path, content] of Object.entries(fileMap)) {
    const relative = normalizePath(path);
    let directory = dirnameOf(relative);
    const parents: string[] = [];
    while (directory !== "") {
      parents.unshift(directory);
      directory = dirnameOf(directory);
    }
    for (const parent of parents) {
      fs.seedDirectory(`${TEST_ROOT}/${parent}`);
    }
    fs.seedFile(`${TEST_ROOT}/${relative}`, content);
  }

  const repositories: RepositoryInputV1[] = [
    { repoId: TEST_REPO_ID, refId: TEST_REF_ID, rootPath: TEST_ROOT },
  ];
  const loaded = await loadWorkspaceTopology(fs, {
    workspaceId: TEST_WORKSPACE_ID,
    generationId: TEST_GENERATION,
    repositories,
  });

  const files: FileImportsV1[] = [];
  for (const [path, content] of Object.entries(fileMap)) {
    const relative = normalizePath(path);
    if (!SOURCE_EXTENSIONS.some((extension) => relative.endsWith(extension))) continue;
    files.push(
      fileImportsOf({
        workspaceId: TEST_WORKSPACE_ID,
        repoId: TEST_REPO_ID,
        refId: TEST_REF_ID,
        path: relative,
        content,
      }),
    );
  }

  const projectAliases = aliasRulesFromConfigs(loaded.projectConfigs);
  const graph = FileDependencyGraph.build({
    workspaceId: TEST_WORKSPACE_ID,
    graphGeneration: TEST_GENERATION,
    repositories,
    files,
    topology: loaded.topology,
    projectAliases,
    ...(limits === undefined ? {} : { limits }),
  });

  return { fs, repositories, files, projectAliases, topology: loaded.topology, graph };
}
