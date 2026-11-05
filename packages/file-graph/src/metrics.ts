/**
 * Graphmetriken des Dateigraphen (spec.md §14.4).
 *
 * Alle Verfahren sind ITERATIV implementiert, nicht rekursiv. Ein Monorepo
 * mit zehntausenden Dateien hat Ketten, die jeden Aufrufstapel sprengen; ein
 * `RangeError` mitten in der Statistik waere ein Totalausfall der Kennzahlen.
 *
 * ZYKLEN: Die Aufzaehlung elementarer Zyklen ist im schlechtesten Fall
 * exponentiell. Sie laeuft deshalb gegen ein Budget — und wenn das Budget
 * greift, steht das in `truncationReason`. Eine abgeschnittene Zyklusliste
 * darf nie wie eine vollstaendige aussehen (E4).
 */
import type {
  FileEdgeV1,
  FileGraphCentralityEntryV1,
  FileGraphMetricsV1,
  FileNodeV1,
} from "@untangle-code/domain";
import { FILE_GRAPH_VERSION, compareCodepoints } from "@untangle-code/domain";

import type { FileGraphLimitsV1 } from "./types.js";

/** Benannte Formel hinter `FileGraphCentralityEntryV1.centrality`. */
export const CENTRALITY_FORMULA =
  "degree-centrality-v1: (inDegree + outDegree) / (2 * max(1, nodeCount - 1)), clamped to [0, 1]";

export const DEFAULT_GRAPH_LIMITS: FileGraphLimitsV1 = {
  maxCycles: 1_000,
  topCentralCount: 25,
  maxCycleSearchNodes: 200_000,
};

/** Gerichtete Nachbarschaftslisten, aus aufgeloesten Kanten gebaut. */
export interface AdjacencyV1 {
  /** fileId → Ziel-fileIds, codepoint-sortiert und dedupliziert. */
  forward: Map<string, string[]>;
  /** fileId → Quell-fileIds, codepoint-sortiert und dedupliziert. */
  reverse: Map<string, string[]>;
}

/**
 * Baut die Nachbarschaft aus den Kanten.
 *
 * Nur `resolved`-Kanten mit einem Ziel INNERHALB der Knotenmenge zaehlen —
 * eine externe Abhaengigkeit hat keinen Knoten, und eine unaufgeloeste erst
 * recht nicht. Beide bleiben als Kante erhalten und in der
 * Import-Resolution-Rate sichtbar, sie sind nur keine Graphverbindung.
 */
export function buildAdjacency(
  nodeIds: readonly string[],
  edges: readonly FileEdgeV1[],
): AdjacencyV1 {
  const known = new Set(nodeIds);
  const forwardSets = new Map<string, Set<string>>();
  const reverseSets = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    forwardSets.set(id, new Set());
    reverseSets.set(id, new Set());
  }
  for (const edge of edges) {
    if (edge.resolution.status !== "resolved") continue;
    const target = edge.resolution.targetFileId;
    if (!known.has(edge.fromFileId) || !known.has(target)) continue;
    forwardSets.get(edge.fromFileId)?.add(target);
    reverseSets.get(target)?.add(edge.fromFileId);
  }
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const id of nodeIds) {
    forward.set(id, [...(forwardSets.get(id) ?? [])].sort(compareCodepoints));
    reverse.set(id, [...(reverseSets.get(id) ?? [])].sort(compareCodepoints));
  }
  return { forward, reverse };
}

/**
 * Stark zusammenhaengende Komponenten nach Tarjan, iterativ.
 *
 * Ergebnis enthaelt NUR Komponenten mit mehr als einem Knoten — eine
 * einelementige Komponente ohne Selbstschleife ist kein Befund. Selbstbezuege
 * kommen ueber `findCycles` als einelementige Zyklen zurueck.
 */
export function stronglyConnectedComponents(
  nodeIds: readonly string[],
  forward: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodeIds) {
    if (index.has(root)) continue;
    const work: { node: string; childIndex: number }[] = [{ node: root, childIndex: 0 }];
    index.set(root, counter);
    lowlink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; childIndex: number };
      const children = forward.get(frame.node) ?? [];
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex] as string;
        frame.childIndex += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          lowlink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, childIndex: 0 });
        } else if (onStack.has(child)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node) as number, index.get(child) as number),
          );
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node) as number, lowlink.get(frame.node) as number),
        );
      }
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop() as string;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) {
          components.push(component.sort(compareCodepoints));
        }
      }
    }
  }

  components.sort((left, right) => compareCodepoints(left[0] as string, right[0] as string));
  return components;
}

/** Ergebnis der Zyklensuche. */
export interface CycleSearchResultV1 {
  /** Jeder Zyklus als geordnete Liste seiner file_ids, ohne Wiederholung des Startknotens. */
  cycles: string[][];
  /** Gesetzt, wenn ein Budget die Suche beendet hat. */
  truncationReason?: string;
}

/**
 * Zaehlt elementare Zyklen auf, komponentenweise und gegen ein Budget.
 *
 * Vorgehen: je stark zusammenhaengender Komponente wird von jedem Knoten aus
 * gesucht, aber nur ueber Knoten, die in der komponenteninternen Ordnung NICHT
 * VOR dem Startknoten liegen. Damit wird jeder Zyklus genau einmal gefunden
 * (an seinem kleinsten Knoten) statt einmal je Rotation.
 */
export function findCycles(
  nodeIds: readonly string[],
  forward: ReadonlyMap<string, readonly string[]>,
  components: readonly (readonly string[])[],
  limits: FileGraphLimitsV1,
): CycleSearchResultV1 {
  const cycles: string[][] = [];
  let steps = 0;
  let truncationReason: string | undefined;

  // Selbstbezuege: eine Datei, die sich selbst importiert. Auch sie zaehlen
  // gegen das Budget — sonst koennte eine Liste voller Selbstbezuege das
  // Limit ueberschreiten, ohne dass es jemand erfaehrt.
  for (const node of nodeIds) {
    if (!(forward.get(node) ?? []).includes(node)) continue;
    if (cycles.length >= limits.maxCycles) {
      truncationReason = `cycle enumeration stopped at maxCycles=${String(limits.maxCycles)}; more elementary cycles exist`;
      break;
    }
    cycles.push([node]);
  }

  for (const component of components) {
    if (truncationReason !== undefined) break;
    const members = [...component].sort(compareCodepoints);
    const rank = new Map(members.map((id, position) => [id, position]));

    for (const start of members) {
      if (truncationReason !== undefined) break;
      const startRank = rank.get(start) as number;
      const path: string[] = [start];
      const onPath = new Set<string>([start]);
      const work: { node: string; childIndex: number }[] = [{ node: start, childIndex: 0 }];

      while (work.length > 0) {
        if (cycles.length >= limits.maxCycles) {
          truncationReason = `cycle enumeration stopped at maxCycles=${String(limits.maxCycles)}; more elementary cycles exist`;
          break;
        }
        if (steps >= limits.maxCycleSearchNodes) {
          truncationReason = `cycle enumeration stopped at maxCycleSearchNodes=${String(limits.maxCycleSearchNodes)}; the cycle list is incomplete`;
          break;
        }
        steps += 1;
        const frame = work[work.length - 1] as { node: string; childIndex: number };
        const children = forward.get(frame.node) ?? [];
        if (frame.childIndex >= children.length) {
          work.pop();
          const removed = path.pop();
          if (removed !== undefined) onPath.delete(removed);
          continue;
        }
        const child = children[frame.childIndex] as string;
        frame.childIndex += 1;
        const childRank = rank.get(child);
        if (childRank === undefined || childRank < startRank) continue;
        if (child === start) {
          if (path.length > 1) {
            cycles.push([...path]);
          }
          continue;
        }
        if (onPath.has(child)) continue;
        path.push(child);
        onPath.add(child);
        work.push({ node: child, childIndex: 0 });
      }
    }
  }

  cycles.sort(
    (left, right) =>
      left.length - right.length || compareCodepoints(left.join("/"), right.join("/")),
  );
  return truncationReason === undefined ? { cycles } : { cycles, truncationReason };
}

/** Berechnet die vollstaendige Metrikaufstellung. */
export function computeFileGraphMetrics(input: {
  workspaceId: string;
  graphGeneration: string;
  nodes: readonly FileNodeV1[];
  edges: readonly FileEdgeV1[];
  adjacency: AdjacencyV1;
  limits: FileGraphLimitsV1;
}): FileGraphMetricsV1 {
  const nodeIds = input.nodes.map((node) => node.fileId).sort(compareCodepoints);
  const components = stronglyConnectedComponents(nodeIds, input.adjacency.forward);
  const cycleSearch = findCycles(nodeIds, input.adjacency.forward, components, input.limits);

  const orphanFileIds: string[] = [];
  const centrality: FileGraphCentralityEntryV1[] = [];
  const denominator = 2 * Math.max(1, nodeIds.length - 1);
  const pathById = new Map(input.nodes.map((node) => [node.fileId, node.filePath]));

  for (const id of nodeIds) {
    const outDegree = (input.adjacency.forward.get(id) ?? []).length;
    const inDegree = (input.adjacency.reverse.get(id) ?? []).length;
    if (outDegree === 0 && inDegree === 0) {
      orphanFileIds.push(id);
    }
    centrality.push({
      fileId: id,
      filePath: pathById.get(id) ?? "",
      inDegree,
      outDegree,
      centrality: Math.min(1, (inDegree + outDegree) / denominator),
    });
  }

  const topCentralFiles = [...centrality]
    .sort(
      (left, right) =>
        right.centrality - left.centrality ||
        right.inDegree - left.inDegree ||
        compareCodepoints(left.fileId, right.fileId),
    )
    .slice(0, Math.max(0, input.limits.topCentralCount));

  let resolvedCount = 0;
  let externalCount = 0;
  let unresolvedCount = 0;
  for (const edge of input.edges) {
    switch (edge.resolution.status) {
      case "resolved":
        resolvedCount += 1;
        break;
      case "external":
        externalCount += 1;
        break;
      case "unresolved":
        unresolvedCount += 1;
        break;
    }
  }
  const total = resolvedCount + externalCount + unresolvedCount;

  const repositoryDistribution: Record<string, number> = {};
  const languageDistribution: Record<string, number> = {};
  for (const node of [...input.nodes].sort((left, right) =>
    compareCodepoints(left.fileId, right.fileId),
  )) {
    repositoryDistribution[node.repoId] = (repositoryDistribution[node.repoId] ?? 0) + 1;
    languageDistribution[node.language] = (languageDistribution[node.language] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    graphGeneration: input.graphGeneration,
    graphVersion: FILE_GRAPH_VERSION,
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    orphanFileIds,
    stronglyConnectedComponents: components,
    cycles: cycleSearch.cycles,
    importResolution: {
      resolvedCount,
      externalCount,
      unresolvedCount,
      rate: total === 0 ? 0 : resolvedCount / total,
    },
    repositoryDistribution: sortRecord(repositoryDistribution),
    languageDistribution: sortRecord(languageDistribution),
    topCentralFiles,
    centralityFormula: CENTRALITY_FORMULA,
    ...(cycleSearch.truncationReason === undefined
      ? {}
      : { truncationReason: cycleSearch.truncationReason }),
  };
}

/**
 * Kanonische Schluesselreihenfolge eines Zaehlerobjekts. Ohne sie haengt die
 * Reihenfolge von der Einfuegereihenfolge ab — und damit das kanonische JSON
 * und jeder daraus abgeleitete Hash.
 */
function sortRecord(record: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(record).sort(compareCodepoints)) {
    sorted[key] = record[key] as number;
  }
  return sorted;
}
