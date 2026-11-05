/**
 * Der LESEPFAD des Dateigraphen: aus einem Abbild (`FileGraphSnapshotV1`)
 * wieder einen abfragbaren Graphen machen.
 *
 * WARUM ES DAS BRAUCHT: `untangle index` baut den Graphen und legt ihn ueber
 * `writeGraphSnapshot` ab. Bis hierher gab es nur `FileDependencyGraph.build`
 * — und der braucht die ROHIMPORTE jeder Datei, die im Abbild gar nicht
 * stehen (das Abbild traegt fertige Kanten, keine Spezifizierer mit
 * Quellpositionen). Ein Leser haette den Graphen also neu bauen muessen, was
 * ohne die Quelldateien nicht geht, oder sich eine eigene Traversierung
 * schreiben muessen — die zweite Wahrheit ueber Zyklen und Budgets, die
 * `traverse.ts` gerade verhindert.
 *
 * WAS EIN ZURUECKGELADENER GRAPH KANN UND WAS NICHT — und warum das hier
 * ausdruecklich steht statt in einer Fussnote:
 *
 *   KANN:  Knoten, Kanten, Metriken, Topologie, Skip-Ledger, Traversierung in
 *          beide Richtungen mit Budget, Zyklenmeldung und Abschneidegrund.
 *   KANN NICHT: `applyChanges`. Fortschreiben heisst Kanten NEU AUFLOESEN,
 *          und dafuer braucht es die Rohimporte samt Quellpositionen. Sie
 *          fehlen im Abbild. Der zurueckgeladene Graph bietet die Methode
 *          deshalb gar nicht erst an, statt sie mit halber Eingabe falsch
 *          auszufuehren (E4).
 */
import type {
  FileEdgeV1,
  FileGraphMetricsV1,
  FileNodeV1,
  SkipLedgerV1,
  TraversalDirection,
  TraversalLimitsV1,
} from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

import { compareEdges } from "./edges.js";
import type { AdjacencyV1 } from "./metrics.js";
import { buildAdjacency } from "./metrics.js";
import { normalizePath } from "./paths.js";
import type { FileGraphNeighborhoodV1, MonotonicClock } from "./traverse.js";
import { traverseFileGraph } from "./traverse.js";
import type { FileGraphSnapshotV1, FileTraversalResultV1, WorkspaceTopologyV1 } from "./types.js";

/**
 * Ein aus einem Abbild zurueckgeladener Dateigraph — lesend.
 *
 * Die Abfragemethoden heissen wie die von {@link FileDependencyGraph} und
 * antworten dasselbe; das ist Absicht, damit ein Aufrufer nicht zwei
 * Vokabulare lernen muss.
 */
export class RestoredFileGraph {
  private readonly nodesById: Map<string, FileNodeV1>;
  private readonly edgesById: Map<string, FileEdgeV1>;
  private readonly edgeIdsByFrom: Map<string, string[]>;
  private readonly adjacency: AdjacencyV1;
  private readonly nodeIdsByPath: Map<string, string[]>;

  constructor(readonly snapshot: FileGraphSnapshotV1) {
    this.nodesById = new Map(snapshot.nodes.map((node) => [node.fileId, node]));
    this.edgesById = new Map(snapshot.edges.map((edge) => [edge.edgeId, edge]));
    this.edgeIdsByFrom = new Map();
    for (const edge of [...snapshot.edges].sort(compareEdges)) {
      const list = this.edgeIdsByFrom.get(edge.fromFileId);
      if (list === undefined) this.edgeIdsByFrom.set(edge.fromFileId, [edge.edgeId]);
      else list.push(edge.edgeId);
    }
    const nodeIds = [...this.nodesById.keys()].sort(compareCodepoints);
    // Aus den KANTEN gebaut, nicht aus `node.dependencies` — dieselbe Quelle,
    // aus der der gebaute Graph seine Nachbarschaft nimmt. Zwei Wege zu
    // derselben Aussage waeren zwei Gelegenheiten, verschieden zu antworten.
    this.adjacency = buildAdjacency(nodeIds, snapshot.edges);
    this.nodeIdsByPath = new Map();
    for (const node of snapshot.nodes) {
      const key = normalizePath(node.filePath);
      const list = this.nodeIdsByPath.get(key);
      if (list === undefined) this.nodeIdsByPath.set(key, [node.fileId]);
      else list.push(node.fileId);
    }
  }

  get workspaceId(): string {
    return this.snapshot.workspaceId;
  }

  get graphGeneration(): string {
    return this.snapshot.graphGeneration;
  }

  get topology(): WorkspaceTopologyV1 {
    return this.snapshot.topology;
  }

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

  /**
   * Alle Dateien dieses Pfades — eine LISTE, weil derselbe repo-relative Pfad
   * in mehreren Repositories eines Workspace existieren darf. Wer hier einen
   * einzelnen Knoten zurueckgaebe, muesste heimlich einen auswaehlen.
   */
  nodesAtPath(filePath: string): FileNodeV1[] {
    return (this.nodeIdsByPath.get(normalizePath(filePath)) ?? [])
      .map((fileId) => this.nodesById.get(fileId))
      .filter((node): node is FileNodeV1 => node !== undefined)
      .sort((left, right) => compareCodepoints(left.fileId, right.fileId));
  }

  metrics(): FileGraphMetricsV1 {
    return this.snapshot.metrics;
  }

  skipLedger(): SkipLedgerV1 {
    return this.snapshot.skipped;
  }

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

  traverse(
    rootFileIds: readonly string[],
    options: {
      direction: TraversalDirection;
      limits?: Partial<TraversalLimitsV1>;
      now?: MonotonicClock;
    },
  ): FileTraversalResultV1 {
    const neighborhood: FileGraphNeighborhoodV1 = {
      adjacency: this.adjacency,
      edgeIdBetween: (from, to, direction) => this.edgeIdBetween(from, to, direction),
    };
    return traverseFileGraph(neighborhood, rootFileIds, options);
  }

  /** Direkte Nachbarn in Traversierungsrichtung, codepoint-sortiert. */
  neighborsOf(fileId: string, direction: TraversalDirection): readonly string[] {
    const map = direction === "forward" ? this.adjacency.forward : this.adjacency.reverse;
    return map.get(fileId) ?? [];
  }

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
}

/** Kurzform des Zurueckladens. */
export function restoreFileGraph(snapshot: FileGraphSnapshotV1): RestoredFileGraph {
  return new RestoredFileGraph(snapshot);
}
