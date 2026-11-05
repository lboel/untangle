/**
 * Aufrufpfade zwischen zwei Symbolen (spec.md §15.3 „Call Flow vorwaerts
 * traversieren").
 *
 * Zwei Fragen, zwei Funktionen:
 * - {@link findShortestCallPath}: der kuerzeste Pfad (Breitensuche).
 * - {@link findAllCallPaths}: alle Pfade bis Tiefe N (Tiefensuche mit
 *   Zyklenschutz ueber den aktuellen Pfad).
 *
 * Beide melden ein leeres Ergebnis NIE stillschweigend: `missReason` benennt,
 * warum kein Pfad gefunden wurde (E4). Und beide fuehren ueber mehrdeutige
 * Kanten ALLE Kandidatenwege — der Pfad traegt dann `containsAmbiguous: true`
 * und seine schwaechste Aufloesungsart.
 */
import type {
  SkipLedgerEntryV1,
  TraversalLimitsV1,
  TraversalTruncationReason,
} from "@untangle-code/domain";
import {
  ID_COMPONENT_SEPARATOR,
  buildSkipLedgerEntry,
  compareCodepoints,
} from "@untangle-code/domain";

import { weakerResolution } from "./bindings.js";
import type { SymbolGraphIndex } from "./graph-index.js";
import { bindingsInDirection } from "./traverse.js";
import type {
  AllCallPathsResultV1,
  AllCallPathsTruncationReason,
  CallPathMissReason,
  CallPathV1,
  ShortestCallPathResultV1,
  SymbolBindingV1,
} from "./types.js";

/** Baut einen Pfad aus Startknoten und Bindungsfolge. */
export function toCallPath(startSymbolId: string, steps: readonly SymbolBindingV1[]): CallPathV1 {
  let confidence = 1;
  let weakest: CallPathV1["weakestResolution"] = "exact";
  let containsAmbiguous = false;
  for (const step of steps) {
    confidence *= step.weight;
    weakest = weakerResolution(weakest, step.resolution);
    if (step.ambiguous) containsAmbiguous = true;
  }
  return {
    schemaVersion: 1,
    symbolIds: [startSymbolId, ...steps.map((step) => step.symbolId)],
    edgeIds: steps.map((step) => step.edgeId),
    depth: steps.length,
    confidence: steps.length === 0 ? 1 : confidence,
    weakestResolution: weakest,
    containsAmbiguous,
  };
}

interface EndpointCheck {
  missReason: CallPathMissReason;
  missDetail: string;
}

function checkEndpoints(
  index: SymbolGraphIndex,
  fromSymbolId: string,
  toSymbolId: string,
): EndpointCheck | null {
  if (index.node(fromSymbolId) === null) {
    return {
      missReason: "unknown_source_symbol",
      missDetail: `source symbol "${fromSymbolId}" is not a node of this symbol graph`,
    };
  }
  if (index.node(toSymbolId) === null) {
    return {
      missReason: "unknown_target_symbol",
      missDetail: `target symbol "${toSymbolId}" is not a node of this symbol graph`,
    };
  }
  return null;
}

export interface ShortestCallPathOptions {
  fromSymbolId: string;
  toSymbolId: string;
  limits: TraversalLimitsV1;
  /** Zeitquelle fuer `maxWallTimeMs`; ohne sie wird das Zeitbudget nicht geprueft. */
  now?: () => number;
}

/**
 * Kuerzester Aufrufpfad von `fromSymbolId` zu `toSymbolId`.
 *
 * Bei mehreren gleich kurzen Pfaden gewinnt der, den die Breitensuche in der
 * deterministischen Bindungsreihenfolge (Ziel-`symbolId`, dann `edgeId`)
 * zuerst erreicht — nicht der zufaellig erste.
 */
export function findShortestCallPath(
  index: SymbolGraphIndex,
  options: ShortestCallPathOptions,
): ShortestCallPathResultV1 {
  const { limits } = options;
  const endpointIssue = checkEndpoints(index, options.fromSymbolId, options.toSymbolId);
  if (endpointIssue !== null) {
    return {
      schemaVersion: 1,
      path: null,
      missReason: endpointIssue.missReason,
      missDetail: endpointIssue.missDetail,
      truncated: false,
      limits: { ...limits },
    };
  }

  const startedAt = options.now?.();
  const predecessor = new Map<string, { from: string; binding: SymbolBindingV1 }>();
  const visited = new Set<string>([options.fromSymbolId]);
  const queue: { symbolId: string; depth: number }[] = [
    { symbolId: options.fromSymbolId, depth: 0 },
  ];
  let truncated = false;
  let truncationReason: TraversalTruncationReason | undefined;
  let edgeBudget = 0;

  const truncate = (reason: TraversalTruncationReason): void => {
    if (truncated) return;
    truncated = true;
    truncationReason = reason;
  };

  if (options.fromSymbolId === options.toSymbolId) {
    return {
      schemaVersion: 1,
      path: toCallPath(options.fromSymbolId, []),
      truncated: false,
      limits: { ...limits },
    };
  }

  let cursor = 0;
  let found = false;
  search: while (cursor < queue.length) {
    if (startedAt !== undefined && options.now !== undefined) {
      if (options.now() - startedAt > limits.maxWallTimeMs) {
        truncate("max_wall_time");
        break;
      }
    }
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) break;
    if (current.depth >= limits.maxDepth) {
      if (bindingsInDirection(index, current.symbolId, "forward").length > 0) {
        truncate("max_depth");
      }
      continue;
    }
    for (const binding of bindingsInDirection(index, current.symbolId, "forward")) {
      edgeBudget += 1;
      if (edgeBudget > limits.maxEdges) {
        truncate("max_edges");
        break search;
      }
      if (visited.has(binding.symbolId)) continue;
      if (visited.size >= limits.maxNodes) {
        truncate("max_nodes");
        break search;
      }
      visited.add(binding.symbolId);
      predecessor.set(binding.symbolId, { from: current.symbolId, binding });
      if (binding.symbolId === options.toSymbolId) {
        found = true;
        break search;
      }
      queue.push({ symbolId: binding.symbolId, depth: current.depth + 1 });
    }
  }

  if (!found) {
    return {
      schemaVersion: 1,
      path: null,
      missReason: "no_path_within_limits",
      missDetail: truncated
        ? `no call path from "${options.fromSymbolId}" to "${options.toSymbolId}" was found before the traversal budget ran out (${String(truncationReason)})`
        : `no call path from "${options.fromSymbolId}" to "${options.toSymbolId}" exists in the resolved graph`,
      truncated,
      ...(truncationReason !== undefined ? { truncationReason } : {}),
      limits: { ...limits },
    };
  }

  const steps: SymbolBindingV1[] = [];
  let node = options.toSymbolId;
  while (node !== options.fromSymbolId) {
    const step = predecessor.get(node);
    if (step === undefined) break;
    steps.push(step.binding);
    node = step.from;
  }
  steps.reverse();

  return {
    schemaVersion: 1,
    path: toCallPath(options.fromSymbolId, steps),
    truncated,
    ...(truncationReason !== undefined ? { truncationReason } : {}),
    limits: { ...limits },
  };
}

export interface AllCallPathsOptions {
  fromSymbolId: string;
  toSymbolId: string;
  /** Hoechstzahl der Kanten eines Pfades. */
  maxDepth: number;
  /** Hoechstzahl behaltener Pfade; Ueberschuss wird gezaehlt und begruendet (E4). */
  maxPaths: number;
  /** Globales Arbeitsbudget: besuchte Pfadzustaende inklusive Start. */
  maxNodes: number;
  /** Globales Arbeitsbudget: untersuchte Bindungen. */
  maxEdges: number;
  /** Zeitquelle fuer `maxWallTimeMs`; nur wirksam zusammen mit `maxWallTimeMs`. */
  now?: () => number;
  maxWallTimeMs?: number;
}

function comparePaths(a: CallPathV1, b: CallPathV1): number {
  return (
    a.depth - b.depth ||
    compareCodepoints(
      a.symbolIds.join(ID_COMPONENT_SEPARATOR),
      b.symbolIds.join(ID_COMPONENT_SEPARATOR),
    ) ||
    compareCodepoints(
      a.edgeIds.join(ID_COMPONENT_SEPARATOR),
      b.edgeIds.join(ID_COMPONENT_SEPARATOR),
    )
  );
}

/**
 * Alle Aufrufpfade von `fromSymbolId` zu `toSymbolId` bis Tiefe `maxDepth`.
 *
 * Zyklenschutz: ein Symbol darf auf DEMSELBEN Pfad nicht zweimal vorkommen.
 * Verschiedene Pfade duerfen dasselbe Symbol enthalten — sonst waeren es
 * nicht „alle Pfade".
 */
export function findAllCallPaths(
  index: SymbolGraphIndex,
  options: AllCallPathsOptions,
): AllCallPathsResultV1 {
  const skipped: SkipLedgerEntryV1[] = [];
  const endpointIssue = checkEndpoints(index, options.fromSymbolId, options.toSymbolId);
  if (endpointIssue !== null) {
    return {
      schemaVersion: 1,
      paths: [],
      missReason: endpointIssue.missReason,
      missDetail: endpointIssue.missDetail,
      truncated: false,
      droppedPathCount: 0,
      droppedPathCountExact: true,
      pathLimitReached: false,
      skipped,
      maxDepth: options.maxDepth,
    };
  }

  const startedAt = options.now?.();
  const found: CallPathV1[] = [];
  const onPath = new Set<string>([options.fromSymbolId]);
  const steps: SymbolBindingV1[] = [];
  let droppedPathCount = 0;
  let droppedPathCountExact = true;
  let truncated = false;
  let truncationReason: AllCallPathsTruncationReason | undefined;
  let hardStopped = false;
  let examinedNodes = 0;
  let examinedEdges = 0;

  const truncate = (reason: AllCallPathsTruncationReason, stop = false): void => {
    truncated = true;
    droppedPathCountExact = false;
    if (
      truncationReason === undefined ||
      (truncationReason === "max_depth" && reason !== "max_depth")
    ) {
      truncationReason = reason;
    }
    if (stop) hardStopped = true;
  };

  const outOfTime = (): boolean => {
    if (
      startedAt === undefined ||
      options.now === undefined ||
      options.maxWallTimeMs === undefined
    ) {
      return false;
    }
    if (options.now() - startedAt > options.maxWallTimeMs) {
      truncate("max_wall_time", true);
      return true;
    }
    return false;
  };

  const visit = (symbolId: string, depth: number): void => {
    if (hardStopped || outOfTime()) return;
    if (examinedNodes >= options.maxNodes) {
      truncate("max_nodes", true);
      return;
    }
    examinedNodes += 1;
    if (symbolId === options.toSymbolId && depth > 0) {
      if (found.length >= options.maxPaths) {
        // Genau EIN weiterer Pfad ist belegt. Danach endet die Suche sofort;
        // der Wert bleibt bewusst eine Untergrenze statt einer teuren
        // Vollzaehlung des restlichen Suchraums.
        droppedPathCount += 1;
        truncate("max_paths", true);
        return;
      }
      found.push(toCallPath(options.fromSymbolId, steps));
      return;
    }
    const bindings = bindingsInDirection(index, symbolId, "forward");
    if (depth >= options.maxDepth) {
      if (bindings.length > 0) truncate("max_depth");
      return;
    }
    for (const binding of bindings) {
      if (hardStopped || outOfTime()) return;
      if (examinedEdges >= options.maxEdges) {
        truncate("max_edges", true);
        return;
      }
      examinedEdges += 1;
      // Sonderfall Zyklus: ist Start gleich Ziel, ist der gesuchte Pfad genau
      // die Rueckkehr zum Startsymbol. Nur dafuer darf der Zyklenschutz
      // durchgelassen werden — sonst bliebe "ruft sich selbst (indirekt)"
      // unbeantwortbar.
      const closesCycleToTarget =
        binding.symbolId === options.toSymbolId && options.toSymbolId === options.fromSymbolId;
      const isNewOnPath = !onPath.has(binding.symbolId);
      if (!isNewOnPath && !closesCycleToTarget) continue;
      if (isNewOnPath) onPath.add(binding.symbolId);
      steps.push(binding);
      visit(binding.symbolId, depth + 1);
      steps.pop();
      if (isNewOnPath) onPath.delete(binding.symbolId);
      if (hardStopped) return;
    }
  };

  visit(options.fromSymbolId, 0);
  found.sort(comparePaths);

  if (droppedPathCount > 0) {
    skipped.push(
      buildSkipLedgerEntry({
        stage: "symbol_graph",
        subjectKind: "symbol_edge",
        subjectId: `${options.fromSymbolId}${ID_COMPONENT_SEPARATOR}${options.toSymbolId}`,
        reason: "excluded_by_configuration",
        detail: `at least ${String(droppedPathCount)} further call path(s) from "${options.fromSymbolId}" to "${options.toSymbolId}" were found but not returned because maxPaths is ${String(options.maxPaths)}; enumeration stopped at the first confirmed omission`,
        recoverable: true,
      }),
    );
  }

  const result: AllCallPathsResultV1 = {
    schemaVersion: 1,
    paths: found,
    truncated,
    ...(truncationReason !== undefined ? { truncationReason } : {}),
    droppedPathCount,
    droppedPathCountExact,
    pathLimitReached: droppedPathCount > 0,
    skipped,
    maxDepth: options.maxDepth,
  };
  if (found.length === 0) {
    result.missReason = "no_path_within_limits";
    result.missDetail = truncated
      ? `no call path from "${options.fromSymbolId}" to "${options.toSymbolId}" was completed within depth ${String(options.maxDepth)} (${String(truncationReason)})`
      : `no call path from "${options.fromSymbolId}" to "${options.toSymbolId}" exists within depth ${String(options.maxDepth)}`;
  }
  return result;
}
