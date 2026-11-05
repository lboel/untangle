/**
 * Kennzahlen des Symbolgraphen.
 *
 * Bewusst NICHT enthalten: Strongly Connected Components, Zyklenzaehlung und
 * Zentralitaet. Die verlangt spec.md §14.4 fuer den DATEIGRAPHEN; sie dort
 * und hier zu berechnen haette zwei Formeln fuer dieselbe Frage ergeben. Der
 * Zyklenschutz der Traversierung bleibt davon unberuehrt: er weist
 * ausgelassene Wiederbesuche in `TraversalResultV1.revisitSkippedSymbolIds`
 * aus.
 */
import type {
  SymbolEdgeKind,
  SymbolEdgeResolution,
  SymbolEdgeV1,
  SymbolNodeV1,
} from "@untangle-code/domain";
import {
  SYMBOL_EDGE_KINDS,
  SYMBOL_EDGE_RESOLUTIONS,
  compareCodepoints,
} from "@untangle-code/domain";

import { bindingsOfEdge } from "./bindings.js";
import type { SymbolGraphMetricsV1 } from "./types.js";

/** Wie viele Symbole in `topCalledSymbolIds` aufgenommen werden. */
export const TOP_CALLED_LIMIT = 20;

export interface SymbolGraphMetricsInput {
  nodes: readonly SymbolNodeV1[];
  edges: readonly SymbolEdgeV1[];
  fileCount: number;
  symbolLessFileCount: number;
  skippedCount: number;
}

function emptyResolutionCounts(): Record<SymbolEdgeResolution, number> {
  const counts = {} as Record<SymbolEdgeResolution, number>;
  for (const resolution of SYMBOL_EDGE_RESOLUTIONS) counts[resolution] = 0;
  return counts;
}

function emptyKindCounts(): Record<SymbolEdgeKind, number> {
  const counts = {} as Record<SymbolEdgeKind, number>;
  for (const kind of SYMBOL_EDGE_KINDS) counts[kind] = 0;
  return counts;
}

/** Berechnet die Kennzahlen. Rein, deterministisch, ohne Uhr. */
export function computeSymbolGraphMetrics(input: SymbolGraphMetricsInput): SymbolGraphMetricsV1 {
  const edgesByResolution = emptyResolutionCounts();
  const edgesByKind = emptyKindCounts();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  let crossRepoEdgeCount = 0;

  for (const node of input.nodes) {
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  }

  for (const edge of input.edges) {
    edgesByResolution[edge.resolution] += 1;
    edgesByKind[edge.kind] += 1;
    if (edge.crossRepo) crossRepoEdgeCount += 1;
    const bindings = bindingsOfEdge(edge);
    if (bindings.length > 0) {
      outDegree.set(edge.fromSymbolId, (outDegree.get(edge.fromSymbolId) ?? 0) + 1);
    }
    for (const binding of bindings) {
      inDegree.set(binding.symbolId, (inDegree.get(binding.symbolId) ?? 0) + 1);
    }
  }

  const edgeCount = input.edges.length;
  const rate = (count: number): number => (edgeCount === 0 ? 0 : count / edgeCount);

  let orphanSymbolCount = 0;
  let maxInDegree = 0;
  let maxOutDegree = 0;
  for (const node of input.nodes) {
    const incoming = inDegree.get(node.id) ?? 0;
    const outgoing = outDegree.get(node.id) ?? 0;
    if (incoming === 0) orphanSymbolCount += 1;
    if (incoming > maxInDegree) maxInDegree = incoming;
    if (outgoing > maxOutDegree) maxOutDegree = outgoing;
  }

  const topCalledSymbolIds = input.nodes
    .map((node) => ({ id: node.id, degree: inDegree.get(node.id) ?? 0 }))
    .filter((entry) => entry.degree > 0)
    .sort((a, b) => b.degree - a.degree || compareCodepoints(a.id, b.id))
    .slice(0, TOP_CALLED_LIMIT)
    .map((entry) => entry.id);

  return {
    schemaVersion: 1,
    nodeCount: input.nodes.length,
    edgeCount,
    fileCount: input.fileCount,
    symbolLessFileCount: input.symbolLessFileCount,
    edgesByResolution,
    edgesByKind,
    exactEdgeRate: rate(edgesByResolution.exact),
    ambiguousEdgeRate: rate(edgesByResolution.ambiguous),
    unresolvedEdgeRate: rate(edgesByResolution.unresolved),
    crossRepoEdgeCount,
    orphanSymbolCount,
    maxInDegree,
    maxOutDegree,
    topCalledSymbolIds,
    skippedCount: input.skippedCount,
  };
}
