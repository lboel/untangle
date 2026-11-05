/**
 * Nachbarschaftsindex ueber einen gebauten Symbolgraphen (architecture.md
 * §17.3): Vorwaerts- (`callees`) und Rueckwaertskanten (`callers`) in
 * deterministischer Reihenfolge.
 *
 * Der Index materialisiert die Nachbarschaft einmal und beantwortet danach
 * jede Traversierung ohne erneutes Durchlaufen aller Kanten. Er ist
 * unveraenderlich: ein neuer Graph braucht einen neuen Index.
 */
import type { SymbolEdgeV1, SymbolNodeV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

import { bindingsOfEdge } from "./bindings.js";
import type { SymbolBindingV1, SymbolGraphV1 } from "./types.js";

/** Leseschnittstelle auf Knoten, Kanten und Nachbarschaft. */
export interface SymbolGraphIndex {
  readonly graph: SymbolGraphV1;
  /** Alle Knoten, aufsteigend nach `id`. */
  nodes(): readonly SymbolNodeV1[];
  node(symbolId: string): SymbolNodeV1 | null;
  edge(edgeId: string): SymbolEdgeV1 | null;
  /** Wen ruft dieses Symbol? Bindungen aufsteigend nach (`symbolId`, `edgeId`). */
  callees(symbolId: string): readonly SymbolBindingV1[];
  /** Wer ruft dieses Symbol? Bindungen aufsteigend nach (`symbolId`, `edgeId`). */
  callers(symbolId: string): readonly SymbolBindingV1[];
  /** Alle von diesem Symbol ausgehenden Kanten, auch unaufgeloeste. */
  outgoingEdges(symbolId: string): readonly SymbolEdgeV1[];
  inDegree(symbolId: string): number;
  outDegree(symbolId: string): number;
}

function compareBindings(a: SymbolBindingV1, b: SymbolBindingV1): number {
  return compareCodepoints(a.symbolId, b.symbolId) || compareCodepoints(a.edgeId, b.edgeId);
}

function appendBinding(
  map: Map<string, SymbolBindingV1[]>,
  key: string,
  binding: SymbolBindingV1,
): void {
  const bucket = map.get(key);
  if (bucket === undefined) {
    map.set(key, [binding]);
    return;
  }
  bucket.push(binding);
}

/** Baut den Nachbarschaftsindex. Rein und deterministisch. */
export function createSymbolGraphIndex(graph: SymbolGraphV1): SymbolGraphIndex {
  const nodeById = new Map<string, SymbolNodeV1>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  const edgeById = new Map<string, SymbolEdgeV1>();
  const forward = new Map<string, SymbolBindingV1[]>();
  const reverse = new Map<string, SymbolBindingV1[]>();
  const outgoing = new Map<string, SymbolEdgeV1[]>();

  for (const edge of graph.edges) {
    edgeById.set(edge.edgeId, edge);
    const bucket = outgoing.get(edge.fromSymbolId);
    if (bucket === undefined) outgoing.set(edge.fromSymbolId, [edge]);
    else bucket.push(edge);

    for (const binding of bindingsOfEdge(edge)) {
      appendBinding(forward, edge.fromSymbolId, binding);
      appendBinding(reverse, binding.symbolId, {
        symbolId: edge.fromSymbolId,
        edgeId: binding.edgeId,
        resolution: binding.resolution,
        weight: binding.weight,
        ambiguous: binding.ambiguous,
      });
    }
  }

  for (const bucket of forward.values()) bucket.sort(compareBindings);
  for (const bucket of reverse.values()) bucket.sort(compareBindings);
  for (const bucket of outgoing.values()) {
    bucket.sort((a, b) => compareCodepoints(a.edgeId, b.edgeId));
  }

  const empty: readonly SymbolBindingV1[] = Object.freeze([]);
  const noEdges: readonly SymbolEdgeV1[] = Object.freeze([]);

  return {
    graph,
    nodes: () => graph.nodes,
    node: (symbolId) => nodeById.get(symbolId) ?? null,
    edge: (edgeId) => edgeById.get(edgeId) ?? null,
    callees: (symbolId) => forward.get(symbolId) ?? empty,
    callers: (symbolId) => reverse.get(symbolId) ?? empty,
    outgoingEdges: (symbolId) => outgoing.get(symbolId) ?? noEdges,
    inDegree: (symbolId) => (reverse.get(symbolId) ?? empty).length,
    outDegree: (symbolId) => (forward.get(symbolId) ?? empty).length,
  };
}
