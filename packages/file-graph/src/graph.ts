/**
 * Der Dateigraph selbst: Aufbau, Abfrage, Traversierung, Fortschreibung.
 *
 * DREI ENTSCHEIDUNGEN, die hier festgeschrieben sind:
 *
 * 1. `unresolvedImportCount` zaehlt Kanten mit
 *    `resolution.status === "unresolved"`, NICHT solche mit
 *    `kind === "unresolved"`. Die normative Regel von `validateFileEdge`
 *    lautet: ein nicht aufloesbarer Import behaelt `kind: "import"`. Wer nach
 *    der Art zaehlte, bekaeme in jedem realen Lauf die Zahl 0 — und damit
 *    eine Kennzahl, die genau das verschweigt, wofuer sie da ist (E4).
 *
 * 2. Nur AUFGELOESTE Kanten mit Ziel im Workspace sind Graphverbindungen.
 *    Externe und unaufgeloeste Kanten existieren weiter, zaehlen in die
 *    Import-Resolution-Rate und stehen in `imports`, haben aber keinen
 *    Zielknoten — es gibt keinen.
 *
 * 3. Die Traversierung bricht Zyklen NICHT auf, sie meldet sie. Der
 *    Zyklenschutz verhindert nur die Endlosschleife; jeder wiedergetroffene
 *    Knoten landet in `revisitSkippedFileIds` und jeder geschlossene Pfad in
 *    `cycles`.
 */
import type {
  FileEdgeV1,
  FileGraphMetricsV1,
  FileNodeV1,
  SkipLedgerEntryV1,
  SkipLedgerV1,
  TraversalDirection,
  TraversalLimitsV1,
} from "@untangle-code/domain";
import {
  buildSkipLedgerEntry,
  compareCodepoints,
  summarizeSkipReasons,
  uniqueSortedByCodepoints,
} from "@untangle-code/domain";

import { assignContainerService, assignPackage } from "./assignment.js";
import type { EdgeBuildContextV1 } from "./edges.js";
import { buildEdgesForFile, compareEdges } from "./edges.js";
import { FileIndex } from "./file-index.js";
import type { AdjacencyV1 } from "./metrics.js";
import { DEFAULT_GRAPH_LIMITS, buildAdjacency, computeFileGraphMetrics } from "./metrics.js";
import { WorkspacePackageCatalog } from "./package-catalog.js";
import { basenameOf, dirnameOf, extensionOf, normalizePath } from "./paths.js";
import { DEFAULT_EXTENSION_ORDER } from "./resolve/candidates.js";
import type { FileGraphNeighborhoodV1, MonotonicClock } from "./traverse.js";
import { DEFAULT_TRAVERSAL_LIMITS, traverseFileGraph } from "./traverse.js";
import type {
  AliasRuleV1,
  FileGraphLimitsV1,
  FileGraphSnapshotV1,
  FileImportsV1,
  FileTraversalResultV1,
  ImportResolverV1,
  RepositoryInputV1,
  WorkspaceTopologyV1,
} from "./types.js";

/**
 * Standardbudgets und Uhr leben seit dem Bau des Lesepfades in `traverse.ts`
 * — hier stehen sie nur noch als Weiterreichung, damit der bisherige
 * Einstiegspunkt des Pakets unveraendert bleibt.
 */
export { DEFAULT_TRAVERSAL_LIMITS };
export type { MonotonicClock };

export interface BuildFileGraphInputV1 {
  workspaceId: string;
  graphGeneration: string;
  repositories: readonly RepositoryInputV1[];
  files: readonly FileImportsV1[];
  topology: WorkspaceTopologyV1;
  /** Aliasregeln aus Projektkonfigurationen (siehe `aliasRulesFromConfigs`). */
  projectAliases?: readonly AliasRuleV1[];
  /** Aliasregeln aus der Nutzerkonfiguration. */
  configuredAliases?: readonly AliasRuleV1[];
  extensionOrder?: readonly string[];
  limits?: Partial<FileGraphLimitsV1>;
  /** Ersetzt die Standardpipeline; nur fuer Erweiterungen gedacht. */
  pipeline?: readonly ImportResolverV1[];
}

/** Eine Aenderung fuer die inkrementelle Fortschreibung. */
export type FileGraphChangeV1 =
  | { kind: "added"; file: FileImportsV1 }
  | { kind: "modified"; file: FileImportsV1 }
  | { kind: "removed"; fileId: string };

/** Was eine Fortschreibung tatsaechlich angefasst hat. */
export interface FileGraphUpdateResultV1 {
  /** Dateien, deren Kanten neu gebaut wurden, codepoint-sortiert. */
  recomputedFileIds: string[];
  addedEdgeIds: string[];
  removedEdgeIds: string[];
  /** Knoten, deren `dependents` sich geaendert haben. */
  affectedFileIds: string[];
  skipped: SkipLedgerEntryV1[];
}

interface TraverseOptionsV1 {
  direction: TraversalDirection;
  limits?: Partial<TraversalLimitsV1>;
  now?: MonotonicClock;
}

export class FileDependencyGraph {
  private readonly nodesById = new Map<string, FileNodeV1>();
  private readonly edgesById = new Map<string, FileEdgeV1>();
  private readonly edgeIdsByFrom = new Map<string, string[]>();
  private readonly filesById = new Map<string, FileImportsV1>();
  /**
   * Ledger-Eintraege JE DATEI statt in einer flachen Liste.
   *
   * Eine flache Liste laesst sich nur ueber den Pfad aufraeumen — und der ist
   * genau das, was sich bei einer Umbenennung aendert. Ein Eintrag der alten
   * Fassung bliebe dann unter dem ALTEN Pfad stehen, und beim Entfernen einer
   * Datei bliebe er ganz. Beides sind Meldungen ueber Dateien, die der Graph
   * nicht mehr kennt; `countsByReason` waere dauerhaft falsch. Ueber die
   * `file_id` ist das Aufraeumen exakt.
   */
  private readonly skipEntriesByFile = new Map<string, SkipLedgerEntryV1[]>();
  private adjacency: AdjacencyV1 = { forward: new Map(), reverse: new Map() };
  private cachedMetrics: FileGraphMetricsV1 | null = null;

  private constructor(
    readonly workspaceId: string,
    readonly graphGeneration: string,
    private readonly index: FileIndex,
    private readonly edgeContext: EdgeBuildContextV1,
    private readonly topology: WorkspaceTopologyV1,
    private readonly limits: FileGraphLimitsV1,
  ) {}

  static build(input: BuildFileGraphInputV1): FileDependencyGraph {
    const index = FileIndex.fromFiles(input.files);
    const packages = input.topology.packages;
    // Repository-bewusster Katalog: eine Karte nach Namen allein liesse
    // gleichnamige Pakete zweier Repositories einander ersatzlos verdecken.
    const packageCatalog = new WorkspacePackageCatalog(packages);
    const refIdByRepoId = new Map(
      input.repositories.map((repository) => [repository.repoId, repository.refId]),
    );
    const edgeContext: EdgeBuildContextV1 = {
      workspaceId: input.workspaceId,
      graphGeneration: input.graphGeneration,
      packages,
      packageCatalog,
      services: input.topology.services,
      projectAliases: input.projectAliases ?? [],
      configuredAliases: input.configuredAliases ?? [],
      extensionOrder: input.extensionOrder ?? DEFAULT_EXTENSION_ORDER,
      files: index,
      refIdByRepoId,
      resolveFileId: (repoId, path) => index.fileIdOf(repoId, path),
      ...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
    };
    const graph = new FileDependencyGraph(
      input.workspaceId,
      input.graphGeneration,
      index,
      edgeContext,
      input.topology,
      { ...DEFAULT_GRAPH_LIMITS, ...input.limits },
    );

    for (const file of input.files) {
      graph.filesById.set(file.fileId, file);
    }
    for (const file of [...input.files].sort((left, right) =>
      compareCodepoints(left.fileId, right.fileId),
    )) {
      graph.rebuildEdgesOf(file);
    }
    graph.refresh();
    return graph;
  }

  // -------------------------------------------------------------------------
  // Abfragen
  // -------------------------------------------------------------------------

  nodes(): FileNodeV1[] {
    return [...this.nodesById.values()].sort((left, right) =>
      compareCodepoints(left.fileId, right.fileId),
    );
  }

  edges(): FileEdgeV1[] {
    return [...this.edgesById.values()].sort(compareEdges);
  }

  node(fileId: string): FileNodeV1 | null {
    return this.nodesById.get(fileId) ?? null;
  }

  edge(edgeId: string): FileEdgeV1 | null {
    return this.edgesById.get(edgeId) ?? null;
  }

  /** Kanten, deren Quelle `fileId` ist, in kanonischer Ordnung. */
  edgesFrom(fileId: string): FileEdgeV1[] {
    return (this.edgeIdsByFrom.get(fileId) ?? [])
      .map((edgeId) => this.edgesById.get(edgeId))
      .filter((edge): edge is FileEdgeV1 => edge !== undefined)
      .sort(compareEdges);
  }

  metrics(): FileGraphMetricsV1 {
    if (this.cachedMetrics === null) {
      this.cachedMetrics = computeFileGraphMetrics({
        workspaceId: this.workspaceId,
        graphGeneration: this.graphGeneration,
        nodes: this.nodes(),
        edges: this.edges(),
        adjacency: this.adjacency,
        limits: this.limits,
      });
    }
    return this.cachedMetrics;
  }

  /** Alle Ledger-Eintraege des Graphen, in kanonischer Ordnung. */
  private allSkipEntries(): SkipLedgerEntryV1[] {
    const entries: SkipLedgerEntryV1[] = [];
    for (const fileId of [...this.skipEntriesByFile.keys()].sort(compareCodepoints)) {
      entries.push(...(this.skipEntriesByFile.get(fileId) ?? []));
    }
    return entries;
  }

  skipLedger(): SkipLedgerV1 {
    const entries = sortSkipEntries(this.allSkipEntries());
    return {
      schemaVersion: 1,
      generationId: this.graphGeneration,
      entries,
      countsByReason: summarizeSkipReasons(entries),
    };
  }

  /** Vollstaendiges, serialisierbares Abbild inklusive Topologie und Ledger. */
  snapshot(): FileGraphSnapshotV1 {
    const graphEntries = sortSkipEntries([
      ...this.allSkipEntries(),
      ...this.topology.skipped.entries,
    ]);
    return {
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      graphGeneration: this.graphGeneration,
      nodes: this.nodes(),
      edges: this.edges(),
      metrics: this.metrics(),
      topology: this.topology,
      skipped: {
        schemaVersion: 1,
        generationId: this.graphGeneration,
        entries: graphEntries,
        countsByReason: summarizeSkipReasons(graphEntries),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Traversierung
  // -------------------------------------------------------------------------

  /** Woran haenge ich (vorwaerts, ueber `dependencies`). */
  dependenciesOf(
    fileId: string,
    limits?: Partial<TraversalLimitsV1>,
    now?: MonotonicClock,
  ): FileTraversalResultV1 {
    return this.traverse([fileId], {
      direction: "forward",
      ...(limits === undefined ? {} : { limits }),
      ...(now === undefined ? {} : { now }),
    });
  }

  /** Wer haengt an mir (rueckwaerts, ueber `dependents`) — die Wirkungsfrage. */
  dependentsOf(
    fileId: string,
    limits?: Partial<TraversalLimitsV1>,
    now?: MonotonicClock,
  ): FileTraversalResultV1 {
    return this.traverse([fileId], {
      direction: "reverse",
      ...(limits === undefined ? {} : { limits }),
      ...(now === undefined ? {} : { now }),
    });
  }

  /**
   * Tiefensuche mit Budget und Zyklenmeldung.
   *
   * Die Traversierung selbst steht in `traverse.ts` — sie ist wortgleich die,
   * die auch ein aus einem Abbild zurueckgeladener Graph benutzt. Hier bleibt
   * nur die Nachbarschaft: die Adjazenz dieses Graphen und die Frage, welche
   * Kante zwei benachbarte Dateien verbindet.
   */
  traverse(rootFileIds: readonly string[], options: TraverseOptionsV1): FileTraversalResultV1 {
    const neighborhood: FileGraphNeighborhoodV1 = {
      adjacency: this.adjacency,
      edgeIdBetween: (from, to, direction) => this.edgeIdBetween(from, to, direction),
    };
    return traverseFileGraph(neighborhood, rootFileIds, options);
  }

  // -------------------------------------------------------------------------
  // Inkrementelle Fortschreibung
  // -------------------------------------------------------------------------

  /**
   * Schreibt den Graphen fort, ohne ihn neu zu bauen.
   *
   * WELCHE DATEIEN NEU GERECHNET WERDEN — und warum nicht nur die geaenderte:
   *
   * - `modified` (Inhalt geaendert, Pfad gleich): NUR die Datei selbst. Ihre
   *   Existenz hat sich nicht geaendert, also kann sich die Aufloesung keiner
   *   anderen Datei geaendert haben.
   * - `added` / `removed`: zusaetzlich jede Datei, deren Aufloesung von der
   *   Existenz dieses Pfades abhaengt. Die ist exakt bestimmbar, weil jede
   *   unaufgeloeste Kante ihre geprueften Kandidaten mitfuehrt (E4 zahlt sich
   *   hier aus): wer den betroffenen Pfad geprueft und nicht gefunden hat,
   *   findet ihn jetzt. Dazu kommen die bisherigen Abhaengigen und alle
   *   Dateien, die auf denselben Stamm aufgeloest haben (Verdeckungsfall:
   *   ein neues `util.ts` verdeckt ein bestehendes `util.js`).
   */
  applyChanges(changes: readonly FileGraphChangeV1[]): FileGraphUpdateResultV1 {
    const previousEdgeIds = new Set(this.edgesById.keys());
    const dependentsBefore = new Map(
      [...this.adjacency.reverse.entries()].map(([id, sources]) => [id, sources.join("/")]),
    );

    const toRecompute = new Set<string>();
    const affectedPaths: { repoId: string; path: string }[] = [];
    /**
     * WP-195: Ein `removed` fuer eine `file_id`, die dieser Graph gar nicht
     * kennt, verschwand bisher spurlos — `entryById` gab `null`, `dropFile`
     * fand nichts, und der Aufrufer bekam ein Ergebnis, das aussah, als sei
     * die Loeschung ausgefuehrt worden. Genau daran erkennt man aber, dass
     * zwei Zustaende auseinandergelaufen sind: der Waechter meldet die
     * Loeschung einer Datei, die der Graph nie hatte. Das ist ein Befund, kein
     * Nichts.
     */
    const unknownRemovals: string[] = [];

    for (const change of changes) {
      if (change.kind === "removed") {
        const entry = this.index.entryById(change.fileId);
        if (entry !== null) {
          affectedPaths.push({ repoId: entry.repoId, path: entry.path });
        } else {
          unknownRemovals.push(change.fileId);
        }
        this.dropFile(change.fileId);
        continue;
      }
      const file = change.file;
      const nextPath = normalizePath(file.path);
      const previous = this.index.entryById(file.fileId);
      let pathChanged = false;
      if (previous !== null && (previous.path !== nextPath || previous.repoId !== file.repoId)) {
        // Ein Pfadwechsel ist fachlich ein Entfernen plus ein Hinzufuegen —
        // und zwar BEIDES. Der alte Pfad verschwindet:
        pathChanged = true;
        affectedPaths.push({ repoId: previous.repoId, path: previous.path });
      }
      // ... und der neue Pfad entsteht. Nur die erste Haelfte zu melden war
      // der Fehler: wer den neuen Pfad vergeblich geprueft hatte, findet ihn
      // jetzt (A5), und wer auf denselben Stamm mit schwaecherer Endung
      // aufgeloest hatte, wird jetzt verdeckt (A6). Beide Faelle blieben
      // ungerechnet, das Ergebnis wich vom Neubau ab, und weil die Kante auf
      // eine EXISTIERENDE Datei zeigte, meldete auch das Ledger nichts (E4).
      if (change.kind === "added" || previous === null || pathChanged) {
        affectedPaths.push({ repoId: file.repoId, path: nextPath });
      }
      this.filesById.set(file.fileId, file);
      this.index.add({
        fileId: file.fileId,
        repoId: file.repoId,
        refId: file.refId,
        path: nextPath,
        languageId: file.languageId,
        contentHash: file.contentHash,
      });
      toRecompute.add(file.fileId);
    }

    for (const affected of affectedPaths) {
      for (const fileId of this.filesDependingOnPath(affected.repoId, affected.path)) {
        toRecompute.add(fileId);
      }
    }

    const skipped: SkipLedgerEntryV1[] = [];
    for (const fileId of unknownRemovals.sort(compareCodepoints)) {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "file_graph",
          subjectKind: "file",
          subjectId: fileId,
          reason: "missing_index_entry",
          detail: `a removal was reported for file id "${fileId}", but this graph never contained it; nothing was removed`,
          recoverable: true,
        }),
      );
    }
    for (const fileId of [...toRecompute].sort(compareCodepoints)) {
      const file = this.filesById.get(fileId);
      if (file === undefined) continue;
      skipped.push(...this.rebuildEdgesOf(file));
    }

    this.refresh();

    const currentEdgeIds = new Set(this.edgesById.keys());
    const addedEdgeIds = [...currentEdgeIds].filter((id) => !previousEdgeIds.has(id));
    const removedEdgeIds = [...previousEdgeIds].filter((id) => !currentEdgeIds.has(id));
    const affectedFileIds: string[] = [];
    for (const [id, sources] of this.adjacency.reverse) {
      if (dependentsBefore.get(id) !== sources.join("/")) {
        affectedFileIds.push(id);
      }
    }
    for (const id of dependentsBefore.keys()) {
      if (!this.adjacency.reverse.has(id)) {
        affectedFileIds.push(id);
      }
    }

    return {
      recomputedFileIds: [...toRecompute].sort(compareCodepoints),
      addedEdgeIds: addedEdgeIds.sort(compareCodepoints),
      removedEdgeIds: removedEdgeIds.sort(compareCodepoints),
      affectedFileIds: uniqueSortedByCodepoints(affectedFileIds),
      skipped,
    };
  }

  // -------------------------------------------------------------------------
  // intern
  // -------------------------------------------------------------------------

  private edgeIdBetween(from: string, to: string, direction: TraversalDirection): string | null {
    const source = direction === "forward" ? from : to;
    const target = direction === "forward" ? to : from;
    for (const edgeId of this.edgeIdsByFrom.get(source) ?? []) {
      const edge = this.edgesById.get(edgeId);
      if (edge?.resolution.status === "resolved" && edge.resolution.targetFileId === target) {
        return edgeId;
      }
    }
    return null;
  }

  /** Dateien, deren Aufloesung sich durch das Auftauchen/Verschwinden von `path` aendern kann. */
  private filesDependingOnPath(repoId: string, path: string): string[] {
    const stem = stemOf(path);
    const result = new Set<string>();
    for (const edge of this.edgesById.values()) {
      if (edge.resolution.status === "unresolved") {
        if ((edge.resolution.rejectedCandidates ?? []).includes(path)) {
          result.add(edge.fromFileId);
        }
        continue;
      }
      if (edge.resolution.status !== "resolved") continue;
      if (edge.resolution.targetRepoId !== repoId) continue;
      if (edge.resolution.targetPath === path || stemOf(edge.resolution.targetPath) === stem) {
        result.add(edge.fromFileId);
      }
    }
    return [...result].sort(compareCodepoints);
  }

  private dropFile(fileId: string): void {
    this.removeEdgesOf(fileId);
    this.filesById.delete(fileId);
    this.nodesById.delete(fileId);
    // Ohne diese Zeile blieben Ledger-Eintraege ueber eine Datei stehen, die
    // der Graph nicht mehr kennt — Ueberberichten statt Verschweigen, aber
    // `countsByReason` waere trotzdem falsch.
    this.skipEntriesByFile.delete(fileId);
    this.index.remove(fileId);
  }

  private removeEdgesOf(fileId: string): void {
    for (const edgeId of this.edgeIdsByFrom.get(fileId) ?? []) {
      this.edgesById.delete(edgeId);
    }
    this.edgeIdsByFrom.delete(fileId);
  }

  private rebuildEdgesOf(file: FileImportsV1): SkipLedgerEntryV1[] {
    this.removeEdgesOf(file.fileId);
    const built = buildEdgesForFile(file, this.edgeContext);
    const edgeIds: string[] = [];
    for (const edge of built.edges) {
      this.edgesById.set(edge.edgeId, edge);
      edgeIds.push(edge.edgeId);
    }
    this.edgeIdsByFrom.set(file.fileId, edgeIds);
    // Die Eintraege der vorigen Fassung dieser Datei werden ERSETZT, nicht
    // ergaenzt — sonst waechst das Ledger bei jeder Fortschreibung um
    // Duplikate. Ersetzt wird ueber die `file_id`, damit auch ein Pfadwechsel
    // die alten Eintraege mitnimmt.
    if (built.skipped.length === 0) {
      this.skipEntriesByFile.delete(file.fileId);
    } else {
      this.skipEntriesByFile.set(file.fileId, [...built.skipped]);
    }
    return built.skipped;
  }

  /** Baut Knoten, Nachbarschaft und Metrikzwischenspeicher neu auf. */
  private refresh(): void {
    const nodeIds = [...this.filesById.keys()].sort(compareCodepoints);
    this.adjacency = buildAdjacency(nodeIds, [...this.edgesById.values()]);
    this.nodesById.clear();
    for (const fileId of nodeIds) {
      const file = this.filesById.get(fileId) as FileImportsV1;
      const edges = this.edgesFrom(fileId);
      const node: FileNodeV1 = {
        schemaVersion: 1,
        workspaceId: this.workspaceId,
        repoId: file.repoId,
        refId: file.refId,
        fileId,
        filePath: normalizePath(file.path),
        language: file.languageId,
        contentHash: file.contentHash,
        imports: uniqueSortedByCodepoints(edges.map((edge) => edge.rawSpecifier)),
        dependencies: [...(this.adjacency.forward.get(fileId) ?? [])],
        dependents: [...(this.adjacency.reverse.get(fileId) ?? [])],
        graphGeneration: this.graphGeneration,
        unresolvedImportCount: edges.filter((edge) => edge.resolution.status === "unresolved")
          .length,
      };
      // Paket- und Dienstzuordnung direkt bestimmen, NICHT aus einer Kante
      // ableiten: eine Datei ohne Importe hat keine Kante, gehoert aber
      // trotzdem zu einem Paket.
      const owningPackage = assignPackage(this.topology.packages, file.repoId, file.path);
      const owningService = assignContainerService(this.topology.services, file.repoId, file.path);
      if (owningPackage !== null) node.packageName = owningPackage.name;
      if (owningService !== null) node.containerService = owningService.name;
      this.nodesById.set(fileId, node);
    }
    this.cachedMetrics = null;
  }
}

/** Kurzform des Aufbaus. */
export function buildFileGraph(input: BuildFileGraphInputV1): FileDependencyGraph {
  return FileDependencyGraph.build(input);
}

/**
 * Stamm eines Pfades: ohne Erweiterung und ohne abschliessendes `index`.
 * `src/util.ts`, `src/util.js` und `src/util/index.ts` haben denselben Stamm —
 * genau die Dateien, die einander bei der Kandidatenprobe verdecken koennen.
 */
export function stemOf(path: string): string {
  const normalized = normalizePath(path);
  const extension = extensionOf(normalized);
  const withoutExtension =
    extension === "" ? normalized : normalized.slice(0, normalized.length - extension.length);
  return basenameOf(withoutExtension) === "index" ? dirnameOf(withoutExtension) : withoutExtension;
}

/**
 * Kanonische Reihenfolge der Ledger-Eintraege.
 *
 * Ohne sie haengt die Reihenfolge daran, in welcher Folge Dateien verarbeitet
 * wurden — und die haengt beim echten Scanner an der Nebenlaeufigkeit. Zwei
 * Laeufe desselben Standes muessen dasselbe Dokument ergeben, sonst ist jeder
 * daraus abgeleitete Hash wertlos.
 */
function sortSkipEntries(entries: readonly SkipLedgerEntryV1[]): SkipLedgerEntryV1[] {
  return [...entries].sort(
    (left, right) =>
      compareCodepoints(left.stage, right.stage) ||
      compareCodepoints(left.subjectKind, right.subjectKind) ||
      compareCodepoints(left.path ?? "", right.path ?? "") ||
      compareCodepoints(left.reason, right.reason) ||
      compareCodepoints(left.detail, right.detail),
  );
}
