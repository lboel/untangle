/**
 * Die Traversierung des Dateigraphen als FREIE FUNKTION — losgeloest von der
 * Frage, ob der Graph gerade gebaut oder aus einem Abbild zurueckgeladen
 * wurde.
 *
 * WARUM SIE HIER STEHT UND NICHT MEHR IN `graph.ts`: Der Lesepfad
 * (`readGraphSnapshot` → `restoreFileGraph`) braucht exakt dieselbe
 * Traversierung wie der Schreibpfad. Eine zweite, „nur fuer die Anzeige"
 * geschriebene Fassung waere eine zweite Wahrheit ueber Zyklen und Budgets —
 * und Zyklenmeldung wie Abschneidegrund sind genau die Aussagen, an denen ein
 * Werkzeug luegt, wenn es sie zweimal implementiert. `FileDependencyGraph`
 * und `RestoredFileGraph` rufen deshalb DIESELBE Funktion.
 *
 * Die drei Zusagen der Traversierung sind unveraendert:
 *
 * 1. Tiefensuche, nicht Breitensuche: nur ein Pfadstapel kann echte Zyklen
 *    BENENNEN statt bloss „hier war ich schon" zu vermerken.
 * 2. Ein Zyklus wird gemeldet, nicht aufgebrochen.
 * 3. Ein abgeschnittenes Ergebnis sagt, DASS und WARUM es abgeschnitten ist
 *    (`truncated` + `truncationReason`, E4). Die Tiefengrenze beschneidet nur
 *    den betrachteten Ast; ein erschoepftes GLOBALES Budget beendet den Lauf
 *    und nennt die nie angefassten Wurzeln.
 */
import type { TraversalDirection, TraversalLimitsV1 } from "@untangle-code/domain";
import { uniqueSortedByCodepoints } from "@untangle-code/domain";

import type { AdjacencyV1 } from "./metrics.js";
import type { FileTraversalResultV1 } from "./types.js";

/** Standardbudgets einer Traversierung. */
export const DEFAULT_TRAVERSAL_LIMITS: TraversalLimitsV1 = {
  maxDepth: 16,
  maxNodes: 5_000,
  maxEdges: 20_000,
  maxWallTimeMs: 5_000,
};

/** Uhr fuer Zeitbudgets. Injizierbar, damit Tests nicht auf echte Zeit warten. */
export type MonotonicClock = () => number;

/**
 * Was die Traversierung vom Graphen wissen muss — und sonst nichts.
 *
 * `edgeIdBetween` ist bewusst eine Funktion und keine fertige Karte: der
 * gebaute Graph beantwortet sie ueber seinen Kantenindex, der
 * zurueckgeladene ueber die Kanten des Abbilds. Beide antworten dasselbe.
 */
export interface FileGraphNeighborhoodV1 {
  readonly adjacency: AdjacencyV1;
  edgeIdBetween(from: string, to: string, direction: TraversalDirection): string | null;
}

export interface TraverseFileGraphOptionsV1 {
  direction: TraversalDirection;
  limits?: Partial<TraversalLimitsV1>;
  now?: MonotonicClock;
}

function defaultClock(): number {
  // `performance.now()` ist monoton und wird ausschliesslich fuer die
  // Budgetentscheidung benutzt — kein Zeitwert landet je in Ergebnisdaten.
  return performance.now();
}

/** Tiefensuche mit Budget und Zyklenmeldung. */
export function traverseFileGraph(
  neighborhood: FileGraphNeighborhoodV1,
  rootFileIds: readonly string[],
  options: TraverseFileGraphOptionsV1,
): FileTraversalResultV1 {
  const limits: TraversalLimitsV1 = { ...DEFAULT_TRAVERSAL_LIMITS, ...options.limits };
  const now = options.now ?? defaultClock;
  const startedAt = now();
  const neighbors =
    options.direction === "forward"
      ? neighborhood.adjacency.forward
      : neighborhood.adjacency.reverse;

  const roots = uniqueSortedByCodepoints([...rootFileIds]);
  const visited = new Set<string>(roots);
  const visitedOrder: string[] = [];
  const edgeIds: string[] = [];
  const revisitSkipped: string[] = [];
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();
  let depthReached = 0;
  let truncated = false;
  let truncationReason: FileTraversalResultV1["truncationReason"];
  /**
   * GLOBALES Budget erschoepft (Knoten, Kanten, Zeit) — im Unterschied zur
   * Tiefengrenze, die NUR den gerade betrachteten Ast beschneidet. Beides in
   * einem Flag zu fuehren war der Fehler: eine erreichte Tiefe in der ersten
   * Wurzel warf alle weiteren Wurzeln weg, obwohl auf deren Aesten die
   * Tiefengrenze noch gar nicht erreicht war.
   */
  let budgetExhausted = false;

  const stop = (reason: NonNullable<FileTraversalResultV1["truncationReason"]>): void => {
    truncated = true;
    // WP-196: NICHT der erste Grund, sondern der, an dem tatsaechlich etwas
    // verloren ging. `max_depth` beschneidet nur den gerade betrachteten Ast
    // und laesst die Traversierung weiterlaufen; ein erschoepftes GLOBALES
    // Budget beendet sie. Wer beide in der Reihenfolge ihres Auftretens
    // aufhebt, meldet bei „erst Tiefe, dann Knotenbudget" die Tiefe — und
    // schickt den Leser damit an die falsche Stellschraube, waehrend die
    // Wurzeln in `unvisitedRootFileIds` von einem Budget erzaehlen, das im
    // Abschneidegrund gar nicht vorkommt.
    if (
      truncationReason === undefined ||
      (truncationReason === "max_depth" && reason !== "max_depth")
    ) {
      truncationReason = reason;
    }
    if (reason !== "max_depth") budgetExhausted = true;
  };

  /**
   * WP-194: Wurzeln, die der Graph GAR NICHT KENNT.
   *
   * `buildAdjacency` legt fuer jeden Knoten einen Eintrag an — auch fuer einen
   * ohne jede Kante. Ein fehlender Eintrag heisst deshalb nicht „isolierter
   * Knoten", sondern „diese Datei ist im Graphen nicht vorhanden". Bisher
   * landete eine solche Wurzel unbesehen in `rootFileIds` und sah dort aus wie
   * jede andere bearbeitete Wurzel: null Nachbarn, kein Hinweis. Wer nach
   * einem Tippfehler im Pfad sucht, bekam ein leeres, unauffaelliges Ergebnis
   * — die Frage wurde nie gestellt, und niemand sagte es.
   */
  const unknownRoots: string[] = [];

  const unvisitedRoots: string[] = [];
  for (const root of roots) {
    if (!neighborhood.adjacency.forward.has(root)) {
      unknownRoots.push(root);
      continue;
    }
    if (budgetExhausted) {
      // Nicht stillschweigend fallen lassen: diese Wurzeln wurden nie
      // angefasst, und `rootFileIds` allein saehe so aus, als waeren sie
      // bearbeitet worden (E4).
      unvisitedRoots.push(root);
      continue;
    }
    const path: string[] = [root];
    const onPath = new Set<string>([root]);
    const work: { node: string; childIndex: number; depth: number }[] = [
      { node: root, childIndex: 0, depth: 0 },
    ];

    while (work.length > 0) {
      if (now() - startedAt > limits.maxWallTimeMs) {
        stop("max_wall_time");
        break;
      }
      const frame = work[work.length - 1] as { node: string; childIndex: number; depth: number };
      const children = neighbors.get(frame.node) ?? [];
      if (frame.childIndex >= children.length) {
        work.pop();
        const removed = path.pop();
        if (removed !== undefined) onPath.delete(removed);
        continue;
      }
      const child = children[frame.childIndex] as string;
      frame.childIndex += 1;

      if (onPath.has(child)) {
        // Zyklus GEFUNDEN — nicht aufgebrochen, sondern benannt.
        const cycle = path.slice(path.indexOf(child));
        const key = cycle.join("/");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cycle);
        }
        revisitSkipped.push(child);
        continue;
      }

      const edgeId = neighborhood.edgeIdBetween(frame.node, child, options.direction);
      if (edgeId !== null) {
        if (edgeIds.length >= limits.maxEdges) {
          stop("max_edges");
          break;
        }
        edgeIds.push(edgeId);
      }

      if (visited.has(child)) {
        revisitSkipped.push(child);
        continue;
      }
      if (visitedOrder.length >= limits.maxNodes) {
        stop("max_nodes");
        break;
      }
      visited.add(child);
      visitedOrder.push(child);

      const childDepth = frame.depth + 1;
      depthReached = Math.max(depthReached, childDepth);
      if (childDepth >= limits.maxDepth) {
        // Die Tiefengrenze ist erreicht: der Knoten zaehlt als besucht, seine
        // Nachbarn werden nicht mehr betrachtet — und genau das wird gemeldet.
        if ((neighbors.get(child) ?? []).length > 0) {
          stop("max_depth");
        }
        continue;
      }
      path.push(child);
      onPath.add(child);
      work.push({ node: child, childIndex: 0, depth: childDepth });
    }
  }

  return {
    schemaVersion: 1,
    direction: options.direction,
    rootFileIds: roots,
    visitedFileIds: visitedOrder,
    edgeIds,
    depthReached,
    truncated,
    ...(truncationReason === undefined ? {} : { truncationReason }),
    revisitSkippedFileIds: uniqueSortedByCodepoints(revisitSkipped),
    cycles,
    ...(unvisitedRoots.length === 0
      ? {}
      : { unvisitedRootFileIds: uniqueSortedByCodepoints(unvisitedRoots) }),
    ...(unknownRoots.length === 0
      ? {}
      : { unknownRootFileIds: uniqueSortedByCodepoints(unknownRoots) }),
    limits,
  };
}
