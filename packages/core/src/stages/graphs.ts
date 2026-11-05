/**
 * Stufe 9 des Indexlaufs (spec.md §11.1 `building_graphs`): Dateigraph und
 * Symbolgraph bauen und ablegen.
 *
 * DIE ENTSCHEIDUNG, DIE HIER ZAEHLT — VOLLSTAENDIGKEIT VOR SPARSAMKEIT:
 * Ein inkrementeller Lauf analysiert nur die GEAENDERTEN Dateien. Ein Graph
 * aus nur diesen Dateien waere jedoch kein „aktualisierter" Graph, sondern ein
 * FALSCHER: jede Kante auf eine unveraenderte Datei fehlte, und die
 * Kennzahlen (Zyklen, Abhaengige, Aufloesungsrate) waeren stumm falsch. Diese
 * Stufe holt deshalb die unveraenderten Dateien nach — sie liest und parst sie,
 * aber sie chunkt, misst, bettet und speichert sie NICHT. Der teure Teil des
 * Laufs (Einbettung, Upsert) bleibt uebersprungen; nachgeholt wird nur, was der
 * Graph zwingend braucht.
 *
 * Die Alternative — den Graphen der Vorgeneration laden und fortschreiben —
 * ist in `@untangle-code/file-graph` als `applyChanges` vorhanden, braucht aber
 * einen aus einem Abbild WIEDERHERGESTELLTEN Graphen; das Paket bietet dafuer
 * heute keinen Einstiegspunkt (`FileDependencyGraph.build` ist der einzige).
 * Solange das so ist, waere die einzige billigere Variante ein Graph mit
 * unsichtbaren Loechern, und die ist ausgeschlossen (E4).
 */
import { Buffer } from "node:buffer";

import {
  classifyAdapterFailure,
  compareCodepoints,
  UntangleError,
  type FileSystemPort,
  type ParserRegistry,
  type GraphStore,
  type PortCallOptions,
  type Random,
} from "@untangle-code/domain";
import {
  buildFileGraph,
  loadWorkspaceTopology,
  writeGraphSnapshot,
  type FileImportsV1,
  type RepositoryInputV1,
  type WorkspaceTopologyV1,
} from "@untangle-code/file-graph";
import type { GraphBuildResultV1, GraphStage } from "@untangle-code/jobs";
import { hashBytes } from "@untangle-code/scanner";
import {
  buildSymbolGraph,
  resolvedImportsFromFileEdges,
  writeSymbolGraphSnapshot,
  type SymbolGraphFileInput,
} from "@untangle-code/symbol-graph";

import type { AnalysisCollector, CollectedFileV1 } from "../collected.js";
import type { SkipCollector } from "../ledger.js";
import type { IndexTargetV1 } from "../types.js";

import type { DiscoveryStateV1 } from "./discovery.js";

export interface GraphStageDeps {
  fs: FileSystemPort;
  parsers: ParserRegistry;
  graphStore: GraphStore;
  random: Random;
  target: IndexTargetV1;
  collector: AnalysisCollector;
  discovery: DiscoveryStateV1;
  ledger: SkipCollector;
  generationId: () => string;
  counts: {
    fileGraphNodes: number;
    fileGraphEdges: number;
    symbolGraphNodes: number;
    symbolGraphEdges: number;
  };
}

export function createGraphStage(deps: GraphStageDeps): GraphStage {
  return {
    async buildGraphs(options?: PortCallOptions): Promise<GraphBuildResultV1[]> {
      const generationId = deps.generationId();
      const files = await gatherFiles(deps, options);

      const repositories: RepositoryInputV1[] = [
        {
          repoId: deps.target.repoId,
          refId: deps.target.refId,
          rootPath: deps.target.rootPath,
        },
      ];

      let topology: WorkspaceTopologyV1 = emptyTopology(deps.target.workspaceId, generationId);
      try {
        const loaded = await loadWorkspaceTopology(deps.fs, {
          workspaceId: deps.target.workspaceId,
          generationId,
          repositories,
        });
        topology = loaded.topology;
        deps.ledger.addAll(loaded.topology.skipped.entries);
      } catch (error) {
        deps.ledger.add({
          stage: "file_graph",
          subjectKind: "file",
          repoId: deps.target.repoId,
          refId: deps.target.refId,
          reason: "resolution_failed",
          detail:
            `Could not read topology (packages, aliases, services): ${messageOf(error)} — ` +
            "the file graph therefore resolves only relative imports.",
          recoverable: true,
        });
      }

      const fileImports: FileImportsV1[] = files.map((file) => ({
        fileId: file.fileId,
        repoId: file.repoId,
        refId: file.refId,
        path: file.filePath,
        languageId: file.languageId,
        contentHash: file.contentHash,
        imports: file.imports,
        ...(file.importsMissingReason === undefined
          ? {}
          : { importsMissingReason: file.importsMissingReason }),
      }));

      const fileGraph = buildFileGraph({
        workspaceId: deps.target.workspaceId,
        graphGeneration: generationId,
        repositories,
        files: fileImports,
        topology,
      });
      deps.ledger.addAll(fileGraph.skipLedger().entries);

      await writeGraphSnapshot(deps.graphStore, fileGraph.snapshot(), deps.random.uuid(), options);

      const symbolFiles: SymbolGraphFileInput[] = files.map((file) => ({
        fileId: file.fileId,
        repoId: file.repoId,
        refId: file.refId,
        path: file.filePath,
        languageId: file.languageId,
        content: file.content,
        parseQuality: file.parseQuality,
        symbols: file.symbols,
        calls: file.calls,
        imports: file.imports,
      }));

      const symbolGraph = buildSymbolGraph({
        workspaceId: deps.target.workspaceId,
        graphGeneration: generationId,
        files: symbolFiles,
        resolvedImports: resolvedImportsFromFileEdges(fileGraph.edges()),
      });
      deps.ledger.addAll(symbolGraph.skipped.entries);

      // Dieser Shard ist zugleich der Publish-Marker des Graphpaares: der
      // Dateigraph ist zu diesem Zeitpunkt vollstaendig geschrieben, und der
      // Symbolgraph wird atomar als ein Shard samt Skip-Ledger abgelegt. Der
      // Lesepfad waehlt seine Generation ueber genau diesen namespaceten
      // Shard und kann deshalb nie einen halb geschriebenen neueren
      // Dateigraphen mit einem aelteren Symbolgraphen mischen.
      await writeSymbolGraphSnapshot(deps.graphStore, symbolGraph, deps.random.uuid(), options);

      const fileMetrics = fileGraph.metrics();
      deps.counts.fileGraphNodes = fileGraph.nodes().length;
      deps.counts.fileGraphEdges = fileGraph.edges().length;
      deps.counts.symbolGraphNodes = symbolGraph.nodes.length;
      deps.counts.symbolGraphEdges = symbolGraph.edges.length;

      return [
        {
          graph: "file",
          nodeCount: fileGraph.nodes().length,
          edgeCount: fileMetrics.edgeCount,
        },
        {
          graph: "symbol",
          nodeCount: symbolGraph.nodes.length,
          edgeCount: symbolGraph.edges.length,
        },
      ];
    },
  };
}

/* ------------------------------------------------------------------ */

/**
 * Alle Dateien des Refs — analysierte aus dem Sammler, unveraenderte frisch
 * geparst. Reihenfolge kanonisch nach Pfad, damit zwei Laeufe ueber denselben
 * Stand denselben Graphen ergeben.
 */
async function gatherFiles(
  deps: GraphStageDeps,
  options: PortCallOptions | undefined,
): Promise<CollectedFileV1[]> {
  const out: CollectedFileV1[] = [];
  for (const [fileId, scanned] of deps.discovery.scanned) {
    if (options?.signal?.aborted === true) break;
    const analyzed = deps.collector.get(fileId);
    if (analyzed !== undefined) {
      out.push(analyzed);
      continue;
    }
    out.push(await reparseForGraph(deps, fileId, scanned, options));
  }
  out.sort((a, b) => compareCodepoints(a.filePath, b.filePath));
  return out;
}

async function reparseForGraph(
  deps: GraphStageDeps,
  fileId: string,
  scanned: {
    absolutePath: string;
    relativePath: string;
    languageId: string;
    contentHash: string;
    sizeBytes: number;
  },
  options: PortCallOptions | undefined,
): Promise<CollectedFileV1> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.fs.readFile(scanned.absolutePath, options);
  } catch (error) {
    deps.ledger.add({
      stage: "file_graph",
      subjectKind: "file",
      subjectId: fileId,
      path: scanned.relativePath,
      repoId: deps.target.repoId,
      refId: deps.target.refId,
      reason: "provider_unavailable",
      detail:
        `Could not read an unchanged file for graph construction: ${messageOf(error)} — ` +
        "the run cannot be confirmed as complete.",
      recoverable: true,
    });
    throw new UntangleError(
      "ANALYSIS_INCOMPLETE",
      `Unchanged file "${scanned.relativePath}" could not be read again for graph construction; the run cannot be confirmed as complete.`,
      {
        retryable: true,
        operation: "index.graph.verify_source",
        context: { fileId, filePath: scanned.relativePath },
        cause: error,
      },
    );
  }

  const verifiedContentHash = hashBytes(bytes);
  if (verifiedContentHash !== scanned.contentHash) {
    throw new UntangleError(
      "ANALYSIS_INCOMPLETE",
      `Unchanged file "${scanned.relativePath}" changed after discovery; rerun with a new scan.`,
      {
        retryable: true,
        operation: "index.graph.verify_source",
        context: {
          fileId,
          filePath: scanned.relativePath,
          expectedContentHash: scanned.contentHash,
          actualContentHash: verifiedContentHash,
        },
      },
    );
  }

  const content = Buffer.from(bytes).toString("utf8");
  const adapter = deps.parsers.getAdapterForPath(scanned.relativePath, content.slice(0, 4096));
  const base: CollectedFileV1 = {
    fileId,
    repoId: deps.target.repoId,
    refId: deps.target.refId,
    filePath: scanned.relativePath,
    languageId: scanned.languageId,
    contentHash: verifiedContentHash,
    sizeBytes: bytes.byteLength,
    parseQuality: "failed",
    content,
    symbols: [],
    calls: [],
    imports: [],
    chunkIds: [],
    symbolIds: [],
    metricsScopeId: fileId,
  };

  if (adapter === null) {
    return {
      ...base,
      importsMissingReason: `No language adapter for "${scanned.languageId}".`,
    };
  }

  try {
    const parsed = adapter.parse({
      fileId,
      repoId: deps.target.repoId,
      refId: deps.target.refId,
      path: scanned.relativePath,
      languageId: adapter.languageId,
      content,
      contentHash: verifiedContentHash,
      sizeBytes: bytes.byteLength,
    });
    if (parsed.ast === null) {
      return {
        ...base,
        parseQuality: parsed.parseQuality,
        importsMissingReason: `No syntax tree (parseQuality="${parsed.parseQuality}").`,
      };
    }
    return {
      ...base,
      languageId: adapter.languageId,
      parseQuality: parsed.parseQuality,
      symbols: adapter.extractSymbols(parsed.ast),
      calls: adapter.extractCalls(parsed.ast),
      imports: adapter.extractImports(parsed.ast),
    };
  } catch (error) {
    // WP-216: benannter Grund statt durchgereichtem Bibliothekstext (E4).
    const failure = classifyAdapterFailure(error, { sizeBytes: bytes.byteLength });
    deps.ledger.add({
      stage: "file_graph",
      subjectKind: "file",
      subjectId: fileId,
      path: scanned.relativePath,
      reason: failure.reason,
      detail: `While reparsing for the graph: ${failure.detail}`,
      recoverable: failure.recoverable,
    });
    return { ...base, importsMissingReason: `${failure.kind}: ${failure.detail}` };
  }
}

function emptyTopology(workspaceId: string, generationId: string): WorkspaceTopologyV1 {
  return {
    schemaVersion: 1,
    workspaceId,
    workspaceGlobs: [],
    packages: [],
    packageEdges: [],
    services: [],
    serviceEdges: [],
    skipped: { schemaVersion: 1, generationId, entries: [], countsByReason: {} },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
