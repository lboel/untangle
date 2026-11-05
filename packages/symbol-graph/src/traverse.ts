/**
 * Traversierung mit Limits und Zyklenschutz (spec.md §15.3;
 * architecture.md §17.4).
 *
 * Alle vier Limits sind Pflicht (`TraversalLimitsV1`). Wird eines erreicht,
 * ist `truncated` true UND `truncationReason` gesetzt — ein abgeschnittenes
 * Ergebnis darf nie wie ein vollstaendiges aussehen.
 *
 * `maxWallTimeMs` braucht eine Uhr. Dieses Paket ruft NIE `Date.now()`
 * (Determinismusregel); wer das Zeitbudget durchsetzen will, uebergibt `now`.
 * Ohne `now` wird das Zeitbudget nicht geprueft — dann wird auch nichts
 * abgeschnitten, es bleibt also nichts unbemerkt.
 */
import type {
  SkipLedgerEntryV1,
  TraversalDirection,
  TraversalLimitsV1,
  TraversalTruncationReason,
} from "@untangle-code/domain";
import {
  buildSkipLedgerEntry,
  sortByCodepoints,
  uniqueSortedByCodepoints,
} from "@untangle-code/domain";

import type { SymbolGraphIndex } from "./graph-index.js";
import type { SymbolBindingV1, SymbolGraphTraversalV1 } from "./types.js";

export interface TraverseSymbolGraphOptions {
  rootSymbolIds: readonly string[];
  direction: TraversalDirection;
  limits: TraversalLimitsV1;
  /** Zeitquelle fuer `maxWallTimeMs`; ohne sie wird das Zeitbudget nicht geprueft. */
  now?: () => number;
}

/** Nachbarn in Traversierungsrichtung. */
export function bindingsInDirection(
  index: SymbolGraphIndex,
  symbolId: string,
  direction: TraversalDirection,
): readonly SymbolBindingV1[] {
  return direction === "forward" ? index.callees(symbolId) : index.callers(symbolId);
}

/**
 * Breitensuche ueber den Symbolgraphen.
 *
 * Mehrdeutige Kanten werden ueber ALLE Kandidaten verfolgt (siehe
 * `bindings.ts`) — die Traversierung waehlt nie einen aus.
 */
export function traverseSymbolGraph(
  index: SymbolGraphIndex,
  options: TraverseSymbolGraphOptions,
): SymbolGraphTraversalV1 {
  const { limits, direction } = options;
  const skipped: SkipLedgerEntryV1[] = [];
  const startedAt = options.now?.();

  const roots = uniqueSortedByCodepoints([...options.rootSymbolIds]);
  const visited = new Set<string>();
  const visitedOrder: string[] = [];
  const seenEdges = new Set<string>();
  const edgeIds: string[] = [];
  const revisitSkipped = new Set<string>();
  const queue: { symbolId: string; depth: number }[] = [];

  let truncated = false;
  let truncationReason: TraversalTruncationReason | undefined;
  let depthReached = 0;

  const truncate = (reason: TraversalTruncationReason): void => {
    if (truncated) return;
    truncated = true;
    truncationReason = reason;
  };

  /**
   * Symbole, die eine Grenze zurueckgelassen hat — Grund je Symbol. Die
   * Eintraege werden ERST AM ENDE gegen die Besuchsliste geschrieben: ein
   * Symbol, das spaeter ueber einen anderen Weg doch besucht wird, darf nicht
   * als ausgelassen gemeldet werden. `truncated` allein genuegt nicht, E4
   * verlangt den BENANNTEN Eintrag.
   */
  const leftBehind = new Map<string, string>();
  const noteLeftBehind = (symbolId: string, why: string): void => {
    if (!leftBehind.has(symbolId)) leftBehind.set(symbolId, why);
  };

  for (const root of roots) {
    if (index.node(root) === null) {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "symbol_graph",
          subjectKind: "symbol",
          subjectId: root,
          reason: "missing_index_entry",
          detail: `traversal root "${root}" is not a node of this symbol graph; it contributes no visited symbols`,
          recoverable: true,
        }),
      );
      continue;
    }
    if (visited.size >= limits.maxNodes) {
      truncate("max_nodes");
      noteLeftBehind(
        root,
        `is a requested traversal root, but the node limit of ${String(limits.maxNodes)} was already reached before it could be visited`,
      );
      continue;
    }
    visited.add(root);
    visitedOrder.push(root);
    queue.push({ symbolId: root, depth: 0 });
  }

  let cursor = 0;
  outer: while (cursor < queue.length) {
    if (startedAt !== undefined && options.now !== undefined) {
      if (options.now() - startedAt > limits.maxWallTimeMs) {
        truncate("max_wall_time");
        break;
      }
    }
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) break;

    const bindings = bindingsInDirection(index, current.symbolId, direction);
    if (bindings.length === 0) continue;

    if (current.depth >= limits.maxDepth) {
      for (const binding of bindings) {
        if (visited.has(binding.symbolId)) continue;
        truncate("max_depth");
        noteLeftBehind(
          binding.symbolId,
          `is reachable from "${current.symbolId}", but only beyond the depth limit of ${String(limits.maxDepth)} hops`,
        );
      }
      continue;
    }

    for (const binding of bindings) {
      if (!seenEdges.has(binding.edgeId)) {
        if (edgeIds.length >= limits.maxEdges) {
          truncate("max_edges");
          break outer;
        }
        seenEdges.add(binding.edgeId);
        edgeIds.push(binding.edgeId);
      }
      if (visited.has(binding.symbolId)) {
        revisitSkipped.add(binding.symbolId);
        continue;
      }
      if (visited.size >= limits.maxNodes) {
        truncate("max_nodes");
        for (const remaining of bindings) {
          if (visited.has(remaining.symbolId)) continue;
          noteLeftBehind(
            remaining.symbolId,
            `is reachable from "${current.symbolId}", but the node limit of ${String(limits.maxNodes)} was reached first`,
          );
        }
        break outer;
      }
      visited.add(binding.symbolId);
      visitedOrder.push(binding.symbolId);
      const depth = current.depth + 1;
      if (depth > depthReached) depthReached = depth;
      queue.push({ symbolId: binding.symbolId, depth });
    }
  }

  for (const symbolId of sortByCodepoints([...leftBehind.keys()])) {
    if (visited.has(symbolId)) continue;
    skipped.push(
      buildSkipLedgerEntry({
        stage: "symbol_graph",
        subjectKind: "symbol",
        subjectId: symbolId,
        reason: "excluded_by_configuration",
        detail: `symbol "${symbolId}" ${leftBehind.get(symbolId) ?? "was left behind by a traversal limit"}; it is not part of this result`,
        recoverable: true,
      }),
    );
  }

  return {
    schemaVersion: 1,
    result: {
      schemaVersion: 1,
      direction,
      rootSymbolIds: roots,
      visitedSymbolIds: visitedOrder,
      edgeIds,
      depthReached,
      truncated,
      ...(truncationReason !== undefined ? { truncationReason } : {}),
      revisitSkippedSymbolIds: sortByCodepoints([...revisitSkipped]),
      limits: { ...limits },
    },
    skipped,
  };
}
