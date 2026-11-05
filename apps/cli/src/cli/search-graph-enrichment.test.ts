import type { ExtractedSymbol, RawCall, RawImport, SourceRange } from "@untangle-code/domain";
import {
  buildFileGraph,
  fileGraphFileShardId,
  writeGraphSnapshot,
  type FileImportsV1,
  type ImportResolverV1,
  type WorkspaceTopologyV1,
} from "@untangle-code/file-graph";
import { SEARCH_GRAPH_OMISSION_DETAIL_LIMIT } from "@untangle-code/search";
import { buildSymbolGraph, writeSymbolGraphSnapshot } from "@untangle-code/symbol-graph";
import { InMemoryGraphStore } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { createSearchGraphEnrichment } from "./search-graph-enrichment.js";

const WORKSPACE = "workspace-search-graphs";
const GENERATION = "generation-search-graphs";
const ROOT_FILE = "file-root";

const RANGE: SourceRange = {
  startLine: 1,
  endLine: 1,
  startByte: 0,
  endByte: 1,
};

function rawImport(specifier: string): RawImport {
  return { specifier, importKind: "import", range: RANGE };
}

function buildPersistedFileGraph(unresolvedCount = 1) {
  const files: FileImportsV1[] = [
    {
      fileId: ROOT_FILE,
      repoId: "repo-a",
      refId: "ref-a",
      path: "src/root.ts",
      languageId: "typescript",
      contentHash: "hash-root",
      imports: [
        rawImport("out"),
        ...Array.from({ length: unresolvedCount }, (_, index) =>
          rawImport(`ghost-${String(index)}`),
        ),
      ],
    },
    {
      fileId: "file-out",
      repoId: "repo-b",
      refId: "ref-b",
      path: "lib/out.ts",
      languageId: "typescript",
      contentHash: "hash-out",
      imports: [],
    },
    {
      fileId: "file-in",
      repoId: "repo-b",
      refId: "ref-b",
      path: "lib/in.ts",
      languageId: "typescript",
      contentHash: "hash-in",
      imports: [rawImport("root")],
    },
  ];
  const resolver: ImportResolverV1 = {
    name: "persisted-test-resolver",
    supports: () => true,
    resolve(specifier) {
      if (specifier === "out") {
        return {
          status: "resolved",
          mechanism: "workspace-package",
          targetRepoId: "repo-b",
          targetPath: "lib/out.ts",
        };
      }
      if (specifier === "root") {
        return {
          status: "resolved",
          mechanism: "workspace-package",
          targetRepoId: "repo-a",
          targetPath: "src/root.ts",
        };
      }
      return {
        status: "unresolved",
        reason: "target_file_not_found",
        detail: `fixture has no target for ${specifier}`,
      };
    },
  };
  const topology: WorkspaceTopologyV1 = {
    schemaVersion: 1,
    workspaceId: WORKSPACE,
    workspaceGlobs: [],
    packages: [],
    packageEdges: [],
    services: [],
    serviceEdges: [],
    skipped: { schemaVersion: 1, generationId: GENERATION, entries: [], countsByReason: {} },
  };
  return buildFileGraph({
    workspaceId: WORKSPACE,
    graphGeneration: GENERATION,
    repositories: [
      { repoId: "repo-a", refId: "ref-a", rootPath: "a" },
      { repoId: "repo-b", refId: "ref-b", rootPath: "b" },
    ],
    files,
    topology,
    pipeline: [resolver],
  }).snapshot();
}

function rangeOf(content: string, snippet: string, occurrence = 0): SourceRange {
  let startByte = -1;
  for (let index = 0; index <= occurrence; index++) {
    startByte = content.indexOf(snippet, startByte + 1);
  }
  if (startByte < 0) throw new Error(`fixture snippet not found: ${snippet}`);
  const endByte = startByte + snippet.length;
  return {
    startLine: content.slice(0, startByte).split("\n").length,
    endLine: content.slice(0, endByte).split("\n").length,
    startByte,
    endByte,
  };
}

function extracted(content: string, name: string, snippet: string): ExtractedSymbol {
  return {
    name,
    qualifiedName: name,
    kind: "function",
    normalizedSignature: `${name}()`,
    range: rangeOf(content, snippet),
    exportedNames: [name],
    astHash: `ast-${name}`,
    tokenFingerprint: `token-${name}`,
  };
}

function call(content: string, calleeName: string, occurrence = 0): RawCall {
  return {
    calleeName,
    callerScopeId: "unused-by-symbol-graph",
    range: rangeOf(content, `${calleeName}();`, occurrence),
  };
}

function buildPersistedSymbolGraph() {
  const rootContent =
    'import { target } from "lib";\n' +
    "export function root() { target(); shared(); unique(); ghost(); }\n" +
    "export function incoming() { root(); }\n";
  const targetContent = "export function target() {}\n";
  const sharedContent = "export function shared() {}\n";
  const uniqueContent = "export function unique() {}\n";
  return buildSymbolGraph({
    workspaceId: WORKSPACE,
    graphGeneration: GENERATION,
    files: [
      {
        fileId: ROOT_FILE,
        repoId: "repo-a",
        refId: "ref-a",
        path: "src/root.ts",
        languageId: "typescript",
        content: rootContent,
        parseQuality: "complete",
        symbols: [
          extracted(
            rootContent,
            "root",
            "export function root() { target(); shared(); unique(); ghost(); }",
          ),
          extracted(rootContent, "incoming", "export function incoming() { root(); }"),
        ],
        calls: [
          call(rootContent, "target"),
          call(rootContent, "shared"),
          call(rootContent, "unique"),
          call(rootContent, "ghost"),
          call(rootContent, "root"),
        ],
        imports: [
          {
            specifier: "lib",
            importKind: "import",
            range: rangeOf(rootContent, 'import { target } from "lib";'),
            importedNames: ["target"],
            bindings: [{ localName: "target", importedName: "target", kind: "named" }],
          },
        ],
      },
      symbolFile("file-target", "repo-b", "ref-b", "lib/target.ts", targetContent, "target"),
      symbolFile("file-shared-a", "repo-b", "ref-b", "lib/shared-a.ts", sharedContent, "shared"),
      symbolFile("file-shared-b", "repo-c", "ref-c", "other/shared-b.ts", sharedContent, "shared"),
      symbolFile("file-unique", "repo-b", "ref-b", "lib/unique.ts", uniqueContent, "unique"),
    ],
    resolvedImports: [{ fromFileId: ROOT_FILE, specifier: "lib", toFileId: "file-target" }],
  });
}

function symbolFile(
  fileId: string,
  repoId: string,
  refId: string,
  path: string,
  content: string,
  name: string,
) {
  return {
    fileId,
    repoId,
    refId,
    path,
    languageId: "typescript",
    content,
    parseQuality: "complete" as const,
    symbols: [extracted(content, name, content.trim())],
    calls: [],
    imports: [],
  };
}

async function seededStore() {
  const store = new InMemoryGraphStore();
  const fileGraph = buildPersistedFileGraph();
  const symbolGraph = buildPersistedSymbolGraph();
  await writeGraphSnapshot(store, fileGraph, "write-files");
  await writeSymbolGraphSnapshot(store, symbolGraph, "write-symbols");
  const rootSymbol = symbolGraph.nodes.find(
    (node) => node.fileId === ROOT_FILE && node.name === "root",
  );
  if (rootSymbol === undefined) throw new Error("root symbol fixture missing");
  return { store, fileGraph, symbolGraph, rootSymbol };
}

function requestTarget(symbolId?: string) {
  return {
    targetId: "hit-1",
    workspaceId: WORKSPACE,
    generationId: GENERATION,
    repoId: "repo-a",
    refId: "ref-a",
    fileId: ROOT_FILE,
    filePath: "src/root.ts",
    ...(symbolId === undefined ? {} : { symbolId }),
  };
}

describe("persistierte Such-Graphanreicherung", () => {
  it("liefert direkte File-Kanten in beide Richtungen mit expliziter Cross-Repo-Provenienz", async () => {
    const { store, rootSymbol } = await seededStore();
    const result = await createSearchGraphEnrichment(store).enrich({
      includeContext: true,
      includeLinked: false,
      relationLimit: 32,
      targets: [requestTarget(rootSymbol.id)],
    });
    const context = result.entries[0]?.graphContext;
    expect(context?.relations.map((relation) => relation.direction)).toEqual([
      "incoming",
      "outgoing",
    ]);
    expect(context?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "incoming",
          repoId: "repo-b",
          refId: "ref-b",
          fileId: "file-in",
          path: "lib/in.ts",
          edgeKind: "import",
          crossRepository: true,
        }),
        expect.objectContaining({
          direction: "outgoing",
          repoId: "repo-b",
          refId: "ref-b",
          fileId: "file-out",
          path: "lib/out.ts",
          edgeKind: "import",
          crossRepository: true,
        }),
      ]),
    );
    expect(context?.omissions).toContainEqual(
      expect.objectContaining({ reason: "unresolved_endpoint", count: 1 }),
    );
  });

  it("liefert nur exakte Symbol-Endpunkte und benennt heuristic/ambiguous/unresolved", async () => {
    const { store, rootSymbol } = await seededStore();
    const result = await createSearchGraphEnrichment(store).enrich({
      includeContext: false,
      includeLinked: true,
      relationLimit: 32,
      targets: [requestTarget(rootSymbol.id)],
    });
    const linked = result.entries[0]?.linkedSymbols;
    expect(
      linked?.relations.map((relation) => `${relation.direction}:${relation.symbol?.name}`),
    ).toEqual(["incoming:incoming", "outgoing:target"]);
    expect(linked?.relations.find((relation) => relation.symbol?.name === "target")).toMatchObject({
      repoId: "repo-b",
      refId: "ref-b",
      fileId: "file-target",
      path: "lib/target.ts",
      edgeKind: "calls",
      crossRepository: true,
    });
    expect(linked?.omissions.map((omission) => omission.reason)).toEqual([
      "ambiguous_endpoint",
      "heuristic_endpoint",
      "unresolved_endpoint",
    ]);
  });

  it("raet ohne symbolId oder bei einem unbekannten Symbol nie nach Namen", async () => {
    const { store } = await seededStore();
    const result = await createSearchGraphEnrichment(store).enrich({
      includeContext: false,
      includeLinked: true,
      relationLimit: 32,
      targets: [requestTarget(), { ...requestTarget("does-not-exist"), targetId: "hit-2" }],
    });
    expect(result.entries[0]?.linkedSymbols?.omissions[0]?.reason).toBe("symbol_id_missing");
    expect(result.entries[1]?.linkedSymbols?.omissions[0]?.reason).toBe("source_not_in_graph");
    expect(result.entries.flatMap((entry) => entry.linkedSymbols?.relations ?? [])).toEqual([]);
  });

  it("begrenzt deterministisch und macht abgeschnittene direkte Beziehungen sichtbar", async () => {
    const { store, rootSymbol } = await seededStore();
    const run = () =>
      createSearchGraphEnrichment(store).enrich({
        includeContext: true,
        includeLinked: false,
        relationLimit: 1,
        targets: [requestTarget(rootSymbol.id)],
      });
    const first = await run();
    const second = await run();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.entries[0]?.graphContext?.relations).toHaveLength(1);
    expect(first.entries[0]?.graphContext?.truncated).toBe(true);
    expect(first.entries[0]?.graphContext?.omissions).toContainEqual(
      expect.objectContaining({ reason: "relation_limit", count: 1 }),
    );
  });

  it("aggregiert adversarial viele unresolved File-Kanten mit wahrem Gesamtzaehler", async () => {
    const store = new InMemoryGraphStore();
    await writeGraphSnapshot(store, buildPersistedFileGraph(400), "write-many-unresolved");
    const result = await createSearchGraphEnrichment(store).enrich({
      includeContext: true,
      includeLinked: false,
      relationLimit: 32,
      targets: [requestTarget()],
    });
    const unresolved = result.entries[0]?.graphContext?.omissions.filter(
      (omission) => omission.reason === "unresolved_endpoint",
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved?.[0]?.count).toBe(400);
    expect(unresolved?.[0]?.detail).toContain("aggregated deterministically");
    expect(result.entries[0]?.graphContext?.omissions.length).toBeLessThanOrEqual(2);
  });

  it("liefert bei einem fehlenden Zielshard Teilresultate plus endpoint_missing und Warnung", async () => {
    const { store, rootSymbol } = await seededStore();
    await store.deleteShards("graph_files", [fileGraphFileShardId(WORKSPACE, "file-out")]);
    const result = await createSearchGraphEnrichment(store).enrich({
      includeContext: true,
      includeLinked: false,
      relationLimit: 32,
      targets: [requestTarget(rootSymbol.id)],
    });
    expect(result.entries[0]?.graphContext?.relations).toHaveLength(1);
    expect(result.entries[0]?.graphContext?.omissions.map((omission) => omission.reason)).toEqual(
      expect.arrayContaining(["endpoint_missing", "graph_partial", "unresolved_endpoint"]),
    );
    expect(result.warnings.map((warning) => warning.code)).toContain("GRAPH_CONTEXT_PARTIAL");
  });

  it("verwirft eingehende Kanten, deren persistierte Zielmetadaten dem Treffer widersprechen", async () => {
    const store = new InMemoryGraphStore();
    const fileGraph = buildPersistedFileGraph();
    const symbolGraph = buildPersistedSymbolGraph();
    const rootSymbol = symbolGraph.nodes.find(
      (node) => node.fileId === ROOT_FILE && node.name === "root",
    );
    if (rootSymbol === undefined) throw new Error("root symbol fixture missing");

    await writeGraphSnapshot(
      store,
      {
        ...fileGraph,
        edges: fileGraph.edges.map((edge) =>
          edge.fromFileId === "file-in" && edge.resolution.status === "resolved"
            ? {
                ...edge,
                resolution: { ...edge.resolution, targetPath: "src/not-root.ts" },
              }
            : edge,
        ),
      },
      "write-inconsistent-files",
    );
    await writeSymbolGraphSnapshot(
      store,
      {
        ...symbolGraph,
        edges: symbolGraph.edges.map((edge) =>
          edge.fromSymbolId !== rootSymbol.id && edge.target?.symbolId === rootSymbol.id
            ? { ...edge, target: { ...edge.target, filePath: "src/not-root.ts" } }
            : edge,
        ),
      },
      "write-inconsistent-symbols",
    );

    const result = await createSearchGraphEnrichment(store).enrich({
      includeContext: true,
      includeLinked: true,
      relationLimit: 32,
      targets: [requestTarget(rootSymbol.id)],
    });
    expect(
      result.entries[0]?.graphContext?.relations.map((relation) => relation.direction),
    ).toEqual(["outgoing"]);
    expect(
      result.entries[0]?.linkedSymbols?.relations.map((relation) => relation.direction),
    ).toEqual(["outgoing"]);
    expect(result.entries[0]?.graphContext?.omissions).toContainEqual(
      expect.objectContaining({ reason: "endpoint_missing", count: 1 }),
    );
    expect(result.entries[0]?.linkedSymbols?.omissions).toContainEqual(
      expect.objectContaining({ reason: "endpoint_missing", count: 1 }),
    );
  });

  it("liest nur die angeforderte Graphart und meldet eine fehlende Generation praezise", async () => {
    const { store, rootSymbol } = await seededStore();
    const read = vi.spyOn(store, "readShard");
    await createSearchGraphEnrichment(store).enrich({
      includeContext: false,
      includeLinked: true,
      relationLimit: 32,
      targets: [requestTarget(rootSymbol.id)],
    });
    expect(read).toHaveBeenCalledTimes(1);

    const missing = await createSearchGraphEnrichment(store).enrich({
      includeContext: true,
      includeLinked: true,
      relationLimit: 32,
      targets: [{ ...requestTarget(rootSymbol.id), generationId: "generation-missing" }],
    });
    expect(missing.entries[0]?.graphContext?.omissions[0]?.reason).toBe("graph_unavailable");
    expect(missing.entries[0]?.linkedSymbols?.omissions[0]?.reason).toBe("graph_unavailable");
    expect(missing.warnings.map((warning) => warning.code)).toEqual([
      "GRAPH_CONTEXT_UNAVAILABLE",
      "LINKED_ARTIFACTS_UNAVAILABLE",
    ]);
    expect(missing.warnings[0]?.details).toMatchObject({
      workspaceId: WORKSPACE,
      generationId: "generation-missing",
    });
  });

  it("begrenzt auch freie Fehlermeldungen des Graphspeichers", async () => {
    const store = new InMemoryGraphStore();
    vi.spyOn(store, "readShard").mockRejectedValue(new Error("x".repeat(5_000)));
    const result = await createSearchGraphEnrichment(store).enrich({
      includeContext: true,
      includeLinked: false,
      relationLimit: 32,
      targets: [requestTarget()],
    });
    expect(result.warnings[0]?.message.length).toBeLessThanOrEqual(
      SEARCH_GRAPH_OMISSION_DETAIL_LIMIT,
    );
    expect(result.entries[0]?.graphContext?.omissions[0]?.detail.length).toBeLessThanOrEqual(
      SEARCH_GRAPH_OMISSION_DETAIL_LIMIT,
    );
  });
});
