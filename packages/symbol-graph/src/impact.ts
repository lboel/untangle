/**
 * Impact-Analyse (spec.md §15.3 „Impact rueckwaerts traversieren").
 *
 * Frage: welche Symbole sind von einer Aenderung an X transitiv betroffen?
 * Antwort: alle Symbole, die X direkt oder ueber Zwischenschritte aufrufen —
 * gewichtet nach der Confidence der Bindungen auf dem Weg.
 *
 * GEWICHTUNG: die Confidence eines betroffenen Symbols ist das PRODUKT der
 * Bindungsgewichte auf dem besten Weg. Das Produkt (nicht das Minimum) ist
 * gewaehlt, weil jede weitere unsichere Bindung die Aussage schwaecht: drei
 * heuristische Schritte hintereinander sind weniger belastbar als einer.
 * Gesucht wird der Weg mit dem GROESSTEN Produkt, nicht der kuerzeste —
 * ein langer sicherer Weg ist eine bessere Begruendung als ein kurzer vager.
 *
 * ZWEI ZIELGROESSEN, NICHT EINE (Welle-3-Befund): „konfidentester Weg" und
 * „kuerzester Weg" sind verschiedene Wege zum selben Symbol. Eine Suche, die
 * nur nach Confidence settelt, verliert erreichbare Symbole: ein Knoten, der
 * auf dem konfidentesten Weg in 3 Spruengen liegt, wird bei `maxDepth` 3 nicht
 * mehr expandiert — obwohl er ueber einen kuerzeren, schwaecheren Weg nur
 * EINEN Sprung entfernt ist und alles dahinter innerhalb der Grenze laege.
 * Deshalb haelt dieses Modul je Symbol eine PARETO-MENGE von Etiketten:
 * behalten wird ein Weg genau dann, wenn kein bereits gefundener Weg
 * gleichzeitig konfidenter (oder gleich konfident) UND nicht laenger ist. Die
 * Menge ist durch `maxDepth` beschraenkt (je Symbol hoechstens ein Etikett je
 * Tiefe), die Suche bleibt endlich und deterministisch.
 *
 * AUSWEISPFLICHT: enthaelt das Ergebnis Wege ueber mehrdeutige Kanten, ist
 * `containsAmbiguousEdges` true und die beteiligten Kanten stehen in
 * `ambiguousEdgeIds`. Ein Impact-Ergebnis darf nie sicherer aussehen, als es
 * ist (architecture.md §17.2).
 *
 * SKIP-LEDGER (E4): jedes Symbol, das erreichbar ist und trotzdem nicht im
 * Ergebnis steht, bekommt einen benannten Eintrag — unter der Confidence-
 * Schranke, jenseits der Tiefengrenze, oder von einem Budget abgeschnitten.
 * Die Eintraege entstehen ERST AM ENDE gegen das fertige Ergebnis: ein Symbol,
 * das zuerst ueber einen schwachen und spaeter ueber einen starken Weg
 * gefunden wird, darf nicht gleichzeitig als ausgeschlossen und als betroffen
 * gemeldet werden.
 */
import type {
  SkipLedgerEntryV1,
  TraversalLimitsV1,
  TraversalTruncationReason,
} from "@untangle-code/domain";
import {
  buildSkipLedgerEntry,
  compareCodepoints,
  sortByCodepoints,
  uniqueSortedByCodepoints,
} from "@untangle-code/domain";

import { weakerResolution } from "./bindings.js";
import type { SymbolGraphIndex } from "./graph-index.js";
import type { ImpactResultV1, ImpactedSymbolV1, SymbolBindingV1 } from "./types.js";

export interface AnalyzeImpactOptions {
  /** Die geaenderten Symbole. */
  rootSymbolIds: readonly string[];
  limits: TraversalLimitsV1;
  /**
   * Untere Schranke der Wegconfidence. Symbole, deren bester Weg darunter
   * liegt, werden nicht aufgenommen — mit Ledger-Eintrag (E4). Vorgabe 0.
   */
  minConfidence?: number;
  /**
   * Zeitquelle fuer `maxWallTimeMs`. Injizierbar, damit Tests nicht auf echte
   * Zeit warten muessen.
   *
   * WP-180: Ohne uebergebene Uhr wurde das Zeitbudget frueher GAR NICHT
   * geprueft — `limits.maxWallTimeMs` stand im Vertrag, der Aufrufer setzte es,
   * und es tat nichts. Eine Grenze, die schweigend nicht gilt, ist schlimmer
   * als keine: sie verspricht eine Schranke, auf die sich jemand verlaesst.
   * Ohne diese Angabe gilt jetzt die monotone Prozessuhr (wie in
   * `file-graph/src/traverse.ts`); ihr Wert geht ausschliesslich in die
   * Budgetentscheidung ein und nie in Ergebnisdaten.
   */
  now?: () => number;
}

/** Ein Weg zu einem Symbol: Confidence UND Laenge, beide zaehlen. */
interface Reached {
  symbolId: string;
  confidence: number;
  depth: number;
  viaEdgeIds: string[];
  weakestResolution: ImpactedSymbolV1["weakestResolution"];
  throughAmbiguous: boolean;
}

/** Schluessel eines Etiketts in der Frontier: je Symbol EIN Eintrag je Tiefe. */
function labelKey(entry: Reached): string {
  return `${entry.symbolId} ${String(entry.depth)}`;
}

/**
 * Wird `entry` von einem bereits gesettelten Etikett verdraengt? Das ist der
 * Fall, wenn ein gefundener Weg mindestens so konfident und hoechstens so
 * lang ist — dann traegt `entry` nichts bei, weder zur Aussage noch zur
 * Reichweite.
 */
function isDominated(entry: Reached, known: readonly Reached[]): boolean {
  return known.some((label) => label.confidence >= entry.confidence && label.depth <= entry.depth);
}

/**
 * Waehlt den naechsten zu expandierenden Eintrag: groesste Confidence, bei
 * Gleichstand kleinere Tiefe, dann kleinere `symbolId` nach Codepoints.
 * Lineare Suche statt Heap — bewusst: sie ist offensichtlich deterministisch,
 * und die Grenzen aus `TraversalLimitsV1` halten die Menge klein.
 */
function takeBest(frontier: Map<string, Reached>): Reached | null {
  let best: Reached | null = null;
  let bestKey: string | null = null;
  for (const [key, entry] of frontier) {
    if (
      best === null ||
      entry.confidence > best.confidence ||
      (entry.confidence === best.confidence &&
        (entry.depth < best.depth ||
          (entry.depth === best.depth && compareCodepoints(entry.symbolId, best.symbolId) < 0)))
    ) {
      best = entry;
      bestKey = key;
    }
  }
  if (bestKey !== null) frontier.delete(bestKey);
  return best;
}

function extend(current: Reached, binding: SymbolBindingV1): Reached {
  return {
    symbolId: binding.symbolId,
    confidence: current.confidence * binding.weight,
    depth: current.depth + 1,
    viaEdgeIds: [...current.viaEdgeIds, binding.edgeId],
    weakestResolution: weakerResolution(current.weakestResolution, binding.resolution),
    throughAmbiguous: current.throughAmbiguous || binding.ambiguous,
  };
}

/** Das konfidenteste Etikett einer Pareto-Menge; bei Gleichstand das kuerzeste. */
function bestOf(labels: readonly Reached[]): Reached | null {
  let best: Reached | null = null;
  for (const label of labels) {
    if (
      best === null ||
      label.confidence > best.confidence ||
      (label.confidence === best.confidence && label.depth < best.depth)
    ) {
      best = label;
    }
  }
  return best;
}

/** Berechnet die transitiv betroffenen Symbole. */
export function analyzeImpact(
  index: SymbolGraphIndex,
  options: AnalyzeImpactOptions,
): ImpactResultV1 {
  const { limits } = options;
  const minConfidence = options.minConfidence ?? 0;
  const skipped: SkipLedgerEntryV1[] = [];
  // WP-180: Vorgabe statt „ungeprueft" — `performance.now()` ist monoton.
  const now = options.now ?? ((): number => performance.now());
  const startedAt = now();

  const roots = uniqueSortedByCodepoints([...options.rootSymbolIds]);
  const rootSet = new Set<string>();
  const frontier = new Map<string, Reached>();
  /** Pareto-Menge je Symbol; das erste Etikett ist das konfidenteste. */
  const settled = new Map<string, Reached[]>();
  const visitedOrder: string[] = [];
  const seenEdges = new Set<string>();
  const edgeIds: string[] = [];
  const ambiguousEdgeIds = new Set<string>();
  const revisitSkipped = new Set<string>();
  /** Symbol → beste (hoechste) Wegconfidence, die unter der Schranke lag. */
  const belowMinConfidence = new Map<string, number>();
  /** Symbole, die nur jenseits der Tiefengrenze erreichbar waren. */
  const beyondMaxDepth = new Set<string>();
  /**
   * Symbole, deren Bindung wegen des erschoepften KANTENBUDGETS nie verfolgt
   * wurde. Gegenstueck zu `beyondMaxDepth`: ohne dieses Gegenstueck blieb von
   * `maxEdges` nur das `truncated`-Flag, und E4 verlangt den benannten
   * Eintrag, nicht ein Flag.
   */
  const beyondMaxEdges = new Set<string>();

  let truncated = false;
  let truncationReason: TraversalTruncationReason | undefined;
  let depthReached = 0;

  const truncate = (reason: TraversalTruncationReason): void => {
    if (truncated) return;
    truncated = true;
    truncationReason = reason;
  };

  for (const root of roots) {
    if (index.node(root) === null) {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "symbol_graph",
          subjectKind: "symbol",
          subjectId: root,
          reason: "missing_index_entry",
          detail: `impact root "${root}" is not a node of this symbol graph; nothing downstream of it can be reported`,
          recoverable: true,
        }),
      );
      continue;
    }
    rootSet.add(root);
    const label: Reached = {
      symbolId: root,
      confidence: 1,
      depth: 0,
      viaEdgeIds: [],
      weakestResolution: "exact",
      throughAmbiguous: false,
    };
    frontier.set(labelKey(label), label);
  }

  while (frontier.size > 0) {
    if (now() - startedAt > limits.maxWallTimeMs) {
      truncate("max_wall_time");
      break;
    }
    const current = takeBest(frontier);
    if (current === null) break;

    const known = settled.get(current.symbolId);
    if (known !== undefined && isDominated(current, known)) {
      revisitSkipped.add(current.symbolId);
      continue;
    }
    if (known === undefined) {
      if (settled.size >= limits.maxNodes) {
        // `takeBest` hat diesen Eintrag bereits AUS der Frontier entfernt. Die
        // Schlussbilanz sammelt die Ausschlusskandidaten aber genau aus der
        // Frontier — ohne die Rueckgabe faellt dieses Symbol aus dem Ergebnis
        // UND aus dem Ledger heraus, waehrend gleich gelagerte Geschwister,
        // die noch in der Frontier liegen, benannt werden. Der Ledger wirkt
        // dann vollstaendig und ist es nicht.
        frontier.set(labelKey(current), current);
        truncate("max_nodes");
        break;
      }
      settled.set(current.symbolId, [current]);
      visitedOrder.push(current.symbolId);
    } else {
      // Kuerzerer Weg zu einem schon erreichten Symbol: er erweitert die
      // Reichweite, auch wenn er weniger konfident ist.
      known.push(current);
    }
    if (current.depth > depthReached) depthReached = current.depth;

    const callers = index.callers(current.symbolId);
    if (callers.length === 0) continue;
    if (current.depth >= limits.maxDepth) {
      // NICHT hier abschneiden: dasselbe Symbol kann spaeter ueber einen
      // kuerzeren Weg doch noch innerhalb der Grenze auftauchen. Ob die
      // Tiefengrenze wirklich etwas gekostet hat, steht erst am Ende fest.
      for (const binding of callers) {
        if (settled.has(binding.symbolId)) continue;
        beyondMaxDepth.add(binding.symbolId);
      }
      continue;
    }

    for (let position = 0; position < callers.length; position += 1) {
      const binding = callers[position];
      if (binding === undefined) continue;
      if (!seenEdges.has(binding.edgeId)) {
        if (edgeIds.length >= limits.maxEdges) {
          truncate("max_edges");
          // Der Abbruch laesst JEDEN verbliebenen Aufrufer dieses Symbols
          // liegen, nicht nur den, an dem das Budget riss. Alle werden hier
          // vermerkt; ob sie wirklich fehlen, entscheidet erst die
          // Schlussbilanz gegen das fertige Ergebnis.
          for (const abandoned of callers.slice(position)) {
            beyondMaxEdges.add(abandoned.symbolId);
          }
          break;
        }
        seenEdges.add(binding.edgeId);
        edgeIds.push(binding.edgeId);
      }
      if (binding.ambiguous) ambiguousEdgeIds.add(binding.edgeId);

      const next = extend(current, binding);
      if (next.confidence < minConfidence) {
        const best = belowMinConfidence.get(binding.symbolId);
        if (best === undefined || next.confidence > best) {
          belowMinConfidence.set(binding.symbolId, next.confidence);
        }
        continue;
      }
      const knownLabels = settled.get(binding.symbolId);
      if (knownLabels !== undefined && isDominated(next, knownLabels)) {
        revisitSkipped.add(binding.symbolId);
        continue;
      }
      const key = labelKey(next);
      const queued = frontier.get(key);
      if (queued === undefined || next.confidence > queued.confidence) {
        frontier.set(key, next);
      }
    }
  }

  const affected: ImpactedSymbolV1[] = [];
  for (const [symbolId, labels] of settled) {
    if (rootSet.has(symbolId)) continue;
    const node = index.node(symbolId);
    if (node === null) continue;
    const best = bestOf(labels);
    if (best === null) continue;
    let minDepth = best.depth;
    for (const label of labels) if (label.depth < minDepth) minDepth = label.depth;
    affected.push({
      symbolId,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      repoId: node.repoId,
      depth: best.depth,
      minDepth,
      confidence: best.confidence,
      weakestResolution: best.weakestResolution,
      // Rueckwaerts gesammelt, in Aufrufrichtung ausgegeben (siehe
      // `ImpactedSymbolV1.viaEdgeIds`).
      viaEdgeIds: [...best.viaEdgeIds].reverse(),
      throughAmbiguous: best.throughAmbiguous,
    });
  }
  affected.sort((a, b) => compareCodepoints(a.symbolId, b.symbolId));

  // Erst JETZT, gegen das fertige Ergebnis, entstehen die Ledger-Eintraege:
  // ein Symbol, das ueber einen spaeteren, starken Weg doch aufgenommen wurde,
  // darf nicht als ausgeschlossen gelten.
  const reported = new Set(affected.map((entry) => entry.symbolId));
  const isMissing = (symbolId: string): boolean =>
    !reported.has(symbolId) && !rootSet.has(symbolId);

  for (const symbolId of sortByCodepoints([...belowMinConfidence.keys()])) {
    if (!isMissing(symbolId)) continue;
    skipped.push(
      buildSkipLedgerEntry({
        stage: "symbol_graph",
        subjectKind: "symbol",
        subjectId: symbolId,
        reason: "excluded_by_configuration",
        detail: `caller "${symbolId}" reaches the changed symbol at best with path confidence ${(belowMinConfidence.get(symbolId) ?? 0).toFixed(6)}, below the requested minimum of ${String(minConfidence)}`,
        recoverable: true,
      }),
    );
  }
  const missingBeyondDepth = sortByCodepoints([...beyondMaxDepth]).filter(isMissing);
  // `truncated` erst jetzt: eine Tiefengrenze, die am Ende nichts gekostet
  // hat, darf das Ergebnis nicht als unvollstaendig ausweisen.
  if (missingBeyondDepth.length > 0) truncate("max_depth");
  for (const symbolId of missingBeyondDepth) {
    skipped.push(
      buildSkipLedgerEntry({
        stage: "symbol_graph",
        subjectKind: "symbol",
        subjectId: symbolId,
        reason: "excluded_by_configuration",
        detail: `caller "${symbolId}" is reachable, but every path to it leaves the depth limit of ${String(limits.maxDepth)} hops; it is not reported`,
        recoverable: true,
      }),
    );
  }
  const missingBeyondEdges = sortByCodepoints([...beyondMaxEdges]).filter(isMissing);
  for (const symbolId of missingBeyondEdges) {
    skipped.push(
      buildSkipLedgerEntry({
        stage: "symbol_graph",
        subjectKind: "symbol",
        subjectId: symbolId,
        reason: "excluded_by_configuration",
        detail: `caller "${symbolId}" is reachable, but the edge budget of ${String(limits.maxEdges)} edges was exhausted before its binding was followed; it is not reported`,
        recoverable: true,
      }),
    );
  }

  if (truncated) {
    const named = new Set<string>([...missingBeyondDepth, ...missingBeyondEdges]);
    const unexplored = new Set<string>();
    for (const entry of frontier.values()) {
      // Ein WURZELSYMBOL steht nie in `affected` — es fehlt hier trotzdem,
      // wenn die Traversierung es nie expandiert hat: dann ist ueber seine
      // Aufrufer nichts bekannt, und das Ergebnis nennt es dennoch als Wurzel.
      // Deshalb `settled` statt `rootSet` als Abgrenzung.
      if (reported.has(entry.symbolId) || settled.has(entry.symbolId)) continue;
      if (named.has(entry.symbolId)) continue;
      unexplored.add(entry.symbolId);
    }
    for (const symbolId of sortByCodepoints([...unexplored])) {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "symbol_graph",
          subjectKind: "symbol",
          subjectId: symbolId,
          reason: "excluded_by_configuration",
          detail: rootSet.has(symbolId)
            ? `impact root "${symbolId}" was never expanded: the traversal stopped on "${truncationReason ?? "unknown"}"; no caller of it is reported`
            : `caller "${symbolId}" was already reached but no longer explored: the traversal stopped on "${truncationReason ?? "unknown"}"`,
          recoverable: true,
        }),
      );
    }
  }

  const ambiguousOnKeptPaths = new Set<string>();
  for (const entry of affected) {
    if (!entry.throughAmbiguous) continue;
    for (const edgeId of entry.viaEdgeIds) {
      if (ambiguousEdgeIds.has(edgeId)) ambiguousOnKeptPaths.add(edgeId);
    }
  }

  return {
    schemaVersion: 1,
    rootSymbolIds: roots,
    affected,
    containsAmbiguousEdges: ambiguousOnKeptPaths.size > 0,
    ambiguousEdgeIds: sortByCodepoints([...ambiguousOnKeptPaths]),
    minConfidence,
    traversal: {
      schemaVersion: 1,
      direction: "reverse",
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
