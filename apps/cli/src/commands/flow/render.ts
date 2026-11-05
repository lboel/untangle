/**
 * Die Darstellung des Symbolgraphen — reine Funktionen, kein I/O.
 *
 * DIE ZUSAGE DIESER DATEI, in einem Satz: KEINE KANTE OHNE IHRE
 * AUFLOESUNGSART UND IHRE CONFIDENCE.
 *
 * Der Symbolgraph unterscheidet vier Auspraegungen (`exact`, `heuristic`,
 * `ambiguous`, `unresolved`) und traegt zu jeder eine Confidence mit Basis und
 * Signalen. Diese Unterschiede sind der eigentliche Wert des Graphen: ein
 * Aufrufpfad, der ueber eine geratene Namensgleichheit fuehrt, ist eine ANDERE
 * Aussage als einer ueber einen aufgeloesten Import. Wer beide gleich
 * darstellt, hat die Information weggeworfen, fuer die der Graph gebaut wurde.
 *
 * Deshalb gilt hier zusaetzlich: EINE MEHRDEUTIGE KANTE ZEIGT ALLE
 * KANDIDATEN, mit ihrem Gewicht. Es wird keiner ausgewaehlt — auch nicht
 * „der wahrscheinlichste".
 */
import type { SkipLedgerEntryV1, SymbolEdgeV1, SymbolNodeV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";
import type {
  AllCallPathsResultV1,
  CallPathV1,
  EntryPointSetV1,
  ImpactResultV1,
  ShortestCallPathResultV1,
  SymbolGraphIndex,
} from "@untangle-code/symbol-graph";

import { describeSymbol } from "./select.js";

/** Kurzform einer Kanten-Confidence: Wert, Basis, Signale. */
export function describeConfidence(edge: SymbolEdgeV1): string {
  return (
    `Confidence ${edge.confidence.value.toFixed(3)} (${edge.confidence.basis}` +
    `${edge.confidence.signals.length === 0 ? "" : `; ${edge.confidence.signals.join(", ")}`})`
  );
}

/**
 * Eine Kante in einer Zeile — und, wenn sie mehrdeutig oder unaufgeloest ist,
 * in mehreren.
 */
export function describeEdge(edge: SymbolEdgeV1, indent: string): string[] {
  const lines: string[] = [];
  const qualifier = edge.toQualifier === undefined ? "" : `${edge.toQualifier}.`;
  lines.push(
    `${indent}${edge.kind} "${qualifier}${edge.toName}"  [${edge.resolution}]  ${describeConfidence(edge)}` +
      (edge.crossRepo ? "  >> crosses a repository boundary" : ""),
  );
  if (edge.resolution === "exact" || edge.resolution === "heuristic") {
    const target = edge.target;
    if (target !== undefined) {
      lines.push(`${indent}  -> ${target.qualifiedName}  ${target.filePath}`);
    }
  }
  if (edge.resolution === "ambiguous") {
    const candidates = [...(edge.candidates ?? [])].sort(
      (left, right) =>
        right.weight - left.weight || compareCodepoints(left.symbolId, right.symbolId),
    );
    lines.push(`${indent}  AMBIGUOUS: ${String(candidates.length)} candidates; none selected:`);
    for (const candidate of candidates) {
      lines.push(
        `${indent}    ${candidate.weight.toFixed(3)}  ${candidate.qualifiedName}  ${candidate.filePath}`,
      );
    }
  }
  if (edge.resolution === "unresolved") {
    lines.push(
      `${indent}  UNRESOLVED: ${edge.unresolvedReason ?? "no reason given"} — ${edge.unresolvedDetail ?? ""}`.trimEnd(),
    );
  }
  for (const site of edge.sites) {
    lines.push(`${indent}  Location: ${site.filePath}:${String(site.range.startLine)}`);
  }
  if (edge.sites.length === 0 && edge.sitesMissingReason !== undefined) {
    lines.push(`${indent}  no source location: ${edge.sitesMissingReason}`);
  }
  return lines;
}

/** Ein Aufrufpfad: Knoten, Kanten, und was den Pfad schwaecht. */
export function renderPath(index: SymbolGraphIndex, path: CallPathV1, title: string): string[] {
  const lines: string[] = [];
  lines.push(
    `${title}  Depth ${String(path.depth)}  Confidence ${path.confidence.toFixed(3)}  ` +
      `weakest resolution: ${path.weakestResolution}` +
      (path.containsAmbiguous ? "  INCLUDES AMBIGUOUS EDGES" : ""),
  );
  for (let i = 0; i < path.symbolIds.length; i++) {
    const node = index.node(path.symbolIds[i] as string);
    lines.push(`  ${node === null ? (path.symbolIds[i] as string) : describeSymbol(node)}`);
    const edgeId = path.edgeIds[i];
    if (edgeId === undefined) continue;
    const edge = index.edge(edgeId);
    if (edge === null) {
      lines.push(`    (edge ${edgeId} missing from snapshot)`);
      continue;
    }
    lines.push(...describeEdge(edge, "    "));
  }
  return lines;
}

/**
 * Der kuerzeste Pfad — oder der benannte Grund, warum es keinen gibt.
 *
 * `wallTimeEnforced` ist kein Zierrat: das Zeitbudget der Suche wird nur
 * geprueft, wenn ihr eine Zeitquelle mitgegeben wurde. Ohne sie steht in
 * `limits.maxWallTimeMs` eine Zahl, an die sich nichts haelt — und eine
 * Budgetzeile, die eine nicht durchgesetzte Grenze wie eine durchgesetzte
 * ausgibt, ist genau die stille Unwahrheit, die E4 verbietet.
 */
export function renderShortest(
  index: SymbolGraphIndex,
  result: ShortestCallPathResultV1,
  wallTimeEnforced = true,
): string[] {
  const lines: string[] = ["SHORTEST CALL PATH"];
  if (result.path === null) {
    lines.push(
      `  NO PATH: ${result.missReason ?? "no reason given"}` +
        (result.missDetail === undefined ? "" : ` — ${result.missDetail}`),
    );
  } else {
    lines.push(...renderPath(index, result.path, "  Path"));
  }
  if (result.truncated) {
    lines.push(`  TRUNCATED: ${result.truncationReason ?? "unknown"}; the search was incomplete.`);
  }
  lines.push(
    `  Budgets: maxDepth=${String(result.limits.maxDepth)} maxNodes=${String(result.limits.maxNodes)} ` +
      `maxEdges=${String(result.limits.maxEdges)} maxWallTimeMs=${String(result.limits.maxWallTimeMs)}` +
      (wallTimeEnforced
        ? ""
        : " (maxWallTimeMs is not enforced: the search deliberately receives no " +
          "clock, so repeated runs over the same index produce identical output)"),
  );
  return lines;
}

/** Alle Pfade bis Tiefe N — samt der verworfenen, die nie stumm verschwinden. */
export function renderAllPaths(index: SymbolGraphIndex, result: AllCallPathsResultV1): string[] {
  const lines: string[] = [`ALL CALL PATHS UP TO DEPTH ${String(result.maxDepth)}`];
  if (result.paths.length === 0) {
    lines.push(
      `  NO PATH: ${result.missReason ?? "no reason given"}` +
        (result.missDetail === undefined ? "" : ` — ${result.missDetail}`),
    );
  }
  for (let i = 0; i < result.paths.length; i++) {
    lines.push(...renderPath(index, result.paths[i] as CallPathV1, `  Path ${String(i + 1)}`));
  }
  if (result.pathLimitReached) {
    const count = result.droppedPathCountExact
      ? String(result.droppedPathCount)
      : `at least ${String(result.droppedPathCount)}`;
    lines.push(
      `  PATH LIMIT REACHED: ${count} additional paths were discarded ` +
        "(increase the limit with --limit).",
    );
  }
  if (result.truncated) {
    lines.push(`  TRUNCATED: ${result.truncationReason ?? "unknown"}.`);
  }
  lines.push(...renderLedgerEntries(result.skipped, "  "));
  return lines;
}

/** Einstiegspunkte — als das, was sie sind: Heuristik mit Belegen. */
export function renderEntryPoints(set: EntryPointSetV1, limit: number): string[] {
  const lines: string[] = [
    `ENTRY POINTS (${String(set.entryPoints.length)}) — heuristic, not a measurement`,
  ];
  const sorted = [...set.entryPoints].sort(
    (left, right) =>
      right.confidence.value - left.confidence.value ||
      compareCodepoints(left.filePath, right.filePath) ||
      compareCodepoints(left.symbolId, right.symbolId),
  );
  for (const entry of sorted.slice(0, limit)) {
    lines.push(
      `  ${entry.confidence.value.toFixed(3)}  ${entry.qualifiedName}  ${entry.filePath}  ` +
        `[${entry.kinds.join(", ")}]`,
    );
    for (const signal of entry.signals) {
      lines.push(`      ${signal.kind} (+${signal.weight.toFixed(2)}): ${signal.reason}`);
    }
  }
  if (sorted.length > limit) {
    lines.push(`  … ${String(sorted.length - limit)} more (increase --limit).`);
  }
  const kinds = Object.keys(set.countsByKind).sort(compareCodepoints);
  lines.push(
    `  by kind: ${kinds.map((kind) => `${kind} ${String(set.countsByKind[kind as keyof typeof set.countsByKind] ?? 0)}`).join(", ")}`,
  );
  return lines;
}

/** Impact: wer ist betroffen, wie sicher ist das, und was fehlt trotzdem. */
export function renderImpact(
  index: SymbolGraphIndex,
  result: ImpactResultV1,
  limit: number,
): string[] {
  const lines: string[] = [
    `AFFECTED SYMBOLS (${String(result.affected.length)}) — confidence threshold ${result.minConfidence.toFixed(3)}`,
  ];
  const sorted = [...result.affected].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.minDepth - right.minDepth ||
      compareCodepoints(left.symbolId, right.symbolId),
  );
  for (const affected of sorted.slice(0, limit)) {
    lines.push(
      `  ${affected.confidence.toFixed(3)}  ${affected.qualifiedName}  ${affected.filePath}  ` +
        `Depth ${String(affected.depth)} (shortest path ${String(affected.minDepth)})  ` +
        `weakest resolution: ${affected.weakestResolution}` +
        (affected.throughAmbiguous ? "  VIA AMBIGUOUS EDGE" : ""),
    );
    for (const edgeId of affected.viaEdgeIds) {
      const edge = index.edge(edgeId);
      if (edge === null) {
        lines.push(`      (edge ${edgeId} missing from snapshot)`);
        continue;
      }
      lines.push(...describeEdge(edge, "      "));
    }
  }
  if (sorted.length > limit) {
    lines.push(`  … ${String(sorted.length - limit)} more (increase --limit).`);
  }
  lines.push(
    `  Ambiguous edges involved: ${result.containsAmbiguousEdges ? `yes (${String(result.ambiguousEdgeIds.length)})` : "no"}`,
  );
  if (result.traversal.truncated) {
    lines.push(
      `  TRUNCATED: ${result.traversal.truncationReason ?? "unknown"}; the result is incomplete.`,
    );
  }
  lines.push(...renderLedgerEntries(result.skipped, "  "));
  return lines;
}

/** Was ein Symbol ruft und wer es ruft — jede Kante mit Art und Confidence. */
export function renderSymbolOverview(index: SymbolGraphIndex, node: SymbolNodeV1): string[] {
  const lines: string[] = [];
  lines.push(`Symbol  ${describeSymbol(node)}`);
  lines.push(
    `  Repository ${node.repoId}  Lines ${String(node.startLine)}-${String(node.endLine)}  ` +
      `incoming ${String(index.inDegree(node.id))}, outgoing ${String(index.outDegree(node.id))}`,
  );
  lines.push("");

  const outgoing = index.outgoingEdges(node.id);
  lines.push(`CALLEES (${String(outgoing.length)} edges, including unresolved edges)`);
  if (outgoing.length === 0) lines.push("  (none)");
  for (const edge of outgoing) {
    lines.push(...describeEdge(edge, "  "));
  }
  lines.push("");

  const callers = index.callers(node.id);
  lines.push(`CALLERS (${String(callers.length)} bindings)`);
  if (callers.length === 0) {
    lines.push("  (no callers in the index; this may be an entry point, see --entry-points)");
  }
  for (const binding of callers) {
    const caller = index.node(binding.symbolId);
    lines.push(
      `  ${binding.weight.toFixed(3)}  [${binding.resolution}${binding.ambiguous ? ", ambiguous" : ""}]  ` +
        `${caller === null ? binding.symbolId : describeSymbol(caller)}`,
    );
  }
  return lines;
}

/** Ledger-Eintraege: jede Auslassung mit Grund (E4). */
export function renderLedgerEntries(
  entries: readonly SkipLedgerEntryV1[],
  indent: string,
): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [`${indent}SKIPPED (${String(entries.length)}):`];
  for (const entry of entries) {
    lines.push(
      `${indent}  ${entry.subjectId ?? entry.path ?? "(no item)"}  ${entry.reason}: ${entry.detail}`,
    );
  }
  return lines;
}

/** Kennzahlen des Symbolgraphen, als Kopfzeile jeder Ausgabe. */
export function renderSymbolGraphHeader(
  index: SymbolGraphIndex,
  generationId: string,
  ledgerInShard: boolean,
): string[] {
  const metrics = index.graph.metrics;
  const lines: string[] = [];
  lines.push(`Symbol graph  Generation ${generationId}`);
  lines.push(
    `  ${String(metrics.nodeCount)} symbols, ${String(metrics.edgeCount)} edges from ${String(metrics.fileCount)} files`,
  );
  lines.push(
    `  Resolution: exact ${(metrics.exactEdgeRate * 100).toFixed(1)} %, ` +
      `ambiguous ${(metrics.ambiguousEdgeRate * 100).toFixed(1)} %, ` +
      `unresolved ${(metrics.unresolvedEdgeRate * 100).toFixed(1)} %`,
  );
  if (!ledgerInShard) {
    lines.push(
      "  Note: the stored shard has no skip ledger; skipped " +
        "graph-build items appear in the `untangle index` report.",
    );
  }
  return lines;
}
