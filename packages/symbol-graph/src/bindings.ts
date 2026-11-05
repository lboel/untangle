/**
 * Von der Kante zur BINDUNG.
 *
 * Eine `SymbolEdgeV1` beschreibt eine Aufrufstelle; eine Bindung beschreibt
 * genau eine moegliche Zielverknuepfung. Der Unterschied ist der Kern von E4
 * fuer Graphen: eine MEHRDEUTIGE Kante erzeugt EINE Bindung JE KANDIDAT.
 * Keine Traversierung dieses Pakets waehlt bei Mehrdeutigkeit heimlich einen
 * Kandidaten aus — sie folgt allen und weist die Mehrdeutigkeit im Ergebnis
 * aus. Eine `unresolved`-Kante erzeugt KEINE Bindung; sie bleibt trotzdem im
 * Graphen und in den Kennzahlen sichtbar.
 */
import type { SymbolEdgeV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

import type { SymbolBindingV1 } from "./types.js";

/** Alle Bindungen einer Kante, aufsteigend nach Ziel-`symbolId` (Codepoints). */
export function bindingsOfEdge(edge: SymbolEdgeV1): SymbolBindingV1[] {
  const bindings: SymbolBindingV1[] = [];
  if (edge.resolution === "ambiguous") {
    for (const candidate of edge.candidates ?? []) {
      bindings.push({
        symbolId: candidate.symbolId,
        edgeId: edge.edgeId,
        resolution: "ambiguous",
        weight: candidate.weight,
        ambiguous: true,
      });
    }
  } else if (edge.target !== undefined) {
    bindings.push({
      symbolId: edge.target.symbolId,
      edgeId: edge.edgeId,
      resolution: edge.resolution,
      weight: edge.confidence.value,
      ambiguous: false,
    });
  }
  bindings.sort((a, b) => compareCodepoints(a.symbolId, b.symbolId));
  return bindings;
}

/**
 * Rangfolge der Aufloesungsarten von stark nach schwach. Wird gebraucht, um
 * die SCHWAECHSTE Art auf einem Pfad zu bestimmen — ein Pfad ist nie besser
 * als sein schwaechstes Glied.
 */
const RESOLUTION_STRENGTH = {
  exact: 3,
  heuristic: 2,
  ambiguous: 1,
  unresolved: 0,
} as const satisfies Record<SymbolEdgeV1["resolution"], number>;

/** Liefert die schwaechere der beiden Aufloesungsarten. */
export function weakerResolution(
  a: SymbolEdgeV1["resolution"],
  b: SymbolEdgeV1["resolution"],
): SymbolEdgeV1["resolution"] {
  return RESOLUTION_STRENGTH[a] <= RESOLUTION_STRENGTH[b] ? a : b;
}
