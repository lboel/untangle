/**
 * Bruecke vom DATEIGRAPHEN zum Symbolgraphen.
 *
 * Der Symbolgraph loest Modulspezifizierer nicht selbst auf (siehe
 * `resolve.ts`). Er nimmt das Ergebnis des Dateigraphen entgegen — und zwar
 * ueber den DOMAINTYP `FileEdgeV1`, nicht ueber ein Paket. So haengt dieses
 * Paket nicht am Dateigraph-Paket, und beide Seiten sprechen trotzdem denselben
 * Vertrag.
 *
 * Mehrere Kanten koennen denselben Spezifizierer derselben Datei betreffen
 * (`occurrenceOrdinal` > 0). Fuer die Namensbindung zaehlt aber nur EIN Ziel je
 * Spezifizierer. Die Auswahl ist deterministisch und bevorzugt die
 * aussagekraeftigere Auskunft: `resolved` vor `external` vor `unresolved`, bei
 * Gleichstand die kleinere Ziel-/Detailangabe nach Codepoints.
 */
import type { FileEdgeV1 } from "@untangle-code/domain";
import { ID_COMPONENT_SEPARATOR, compareCodepoints } from "@untangle-code/domain";

import type { ResolvedImportTargetV1 } from "./types.js";

function rankOf(target: ResolvedImportTargetV1): number {
  if (target.toFileId !== null) return 2;
  if (target.external === true) return 1;
  return 0;
}

function tieBreakerOf(target: ResolvedImportTargetV1): string {
  return target.toFileId ?? target.unresolvedDetail ?? "";
}

function toTarget(edge: FileEdgeV1): ResolvedImportTargetV1 {
  switch (edge.resolution.status) {
    case "resolved":
      return {
        fromFileId: edge.fromFileId,
        specifier: edge.rawSpecifier,
        toFileId: edge.resolution.targetFileId,
      };
    case "external":
      return {
        fromFileId: edge.fromFileId,
        specifier: edge.rawSpecifier,
        toFileId: null,
        external: true,
        unresolvedDetail: `resolved to the external package "${edge.resolution.packageName}"`,
      };
    case "unresolved":
      return {
        fromFileId: edge.fromFileId,
        specifier: edge.rawSpecifier,
        toFileId: null,
        unresolvedDetail: `${edge.resolution.reason}: ${edge.resolution.detail}`,
      };
  }
}

/**
 * Wandelt Dateigraph-Kanten in die Zusatzeingabe von `buildSymbolGraph` um.
 * Reihenfolgeunabhaengig: dieselbe Kantenmenge ergibt immer dasselbe Ergebnis.
 */
export function resolvedImportsFromFileEdges(
  edges: readonly FileEdgeV1[],
): ResolvedImportTargetV1[] {
  const best = new Map<string, ResolvedImportTargetV1>();
  for (const edge of edges) {
    const target = toTarget(edge);
    const key = [target.fromFileId, target.specifier].join(ID_COMPONENT_SEPARATOR);
    const known = best.get(key);
    if (known === undefined) {
      best.set(key, target);
      continue;
    }
    const knownRank = rankOf(known);
    const rank = rankOf(target);
    if (
      rank > knownRank ||
      (rank === knownRank && compareCodepoints(tieBreakerOf(target), tieBreakerOf(known)) < 0)
    ) {
      best.set(key, target);
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      compareCodepoints(a.fromFileId, b.fromFileId) || compareCodepoints(a.specifier, b.specifier),
  );
}
