/**
 * Die Darstellung des Dateigraphen — reine Funktionen, kein I/O.
 *
 * Sie stehen getrennt vom Befehl, weil genau hier die Aussagen entstehen, die
 * ein Nutzer glaubt: „das sind alle Abhaengigkeiten", „hier ist Schluss",
 * „dieser Import zeigt ins Leere". Als reine Funktionen sind sie gegen ein
 * Abbild pruefbar, ohne Speicher und ohne Netz.
 *
 * VIER REGELN, DIE JEDE ZEILE HIER EINHAELT:
 *
 * 1. EIN ABGESCHNITTENER BAUM SAGT ES — an der Stelle, an der abgeschnitten
 *    wurde, UND im Fuss mit dem benannten Grund aus
 *    `TRAVERSAL_TRUNCATION_REASONS`.
 * 2. EIN ZYKLUS WIRD GEMELDET, nicht aufgebrochen: der wiedergetroffene Knoten
 *    steht da, mit Markierung, und der geschlossene Weg steht im Fuss.
 * 3. EIN UNAUFGELOESTER IMPORT WIRD MIT SEINEM ROHSTRING GEZEIGT, dazu der
 *    benannte Grund. Er verschwindet nie (E4).
 * 4. GRENZEN SIND SICHTBAR: Paket-, Repository- und Containergrenze stehen an
 *    der Kante, die sie ueberquert.
 */
import type {
  FileEdgeV1,
  FileNodeV1,
  SkipLedgerV1,
  TraversalDirection,
} from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";
import type {
  FileTraversalResultV1,
  RestoredFileGraph,
  SnapshotReadIssue,
  WorkspaceTopologyV1,
} from "@untangle-code/file-graph";

/** Die Richtung, wie der Nutzer sie nennt. */
export type GraphDirectionChoice = "dependencies" | "dependents" | "both";

export interface FileViewInputV1 {
  graph: RestoredFileGraph;
  node: FileNodeV1;
  direction: GraphDirectionChoice;
  dependencies?: FileTraversalResultV1;
  dependents?: FileTraversalResultV1;
}

const DIRECTION_TITLE: Record<TraversalDirection, string> = {
  forward: "DEPENDENCIES (transitive)",
  reverse: "DEPENDENTS (transitive)",
};

/** Warum abgeschnitten wurde, in Worten — die Codes bleiben trotzdem sichtbar. */
const TRUNCATION_TEXT: Record<string, string> = {
  max_depth: "depth limit reached",
  max_nodes: "node budget exhausted",
  max_edges: "edge budget exhausted",
  max_wall_time: "time budget exhausted",
  cancelled: "cancelled",
};

/* ------------------------------------------------------------------ */
/* Bausteine                                                           */
/* ------------------------------------------------------------------ */

/** Kurzbeschreibung eines Knotens: Pfad, Paket, Dienst, offene Importe. */
export function describeNode(node: FileNodeV1): string {
  const parts: string[] = [node.filePath];
  if (node.packageName !== undefined) parts.push(`[${node.packageName}]`);
  if (node.containerService !== undefined) parts.push(`{Service: ${node.containerService}}`);
  if (node.unresolvedImportCount > 0) {
    parts.push(`(${String(node.unresolvedImportCount)} unresolved)`);
  }
  return parts.join("  ");
}

/** Welche Grenzen eine Kante ueberquert, als Kurzform. */
export function describeBoundary(edge: FileEdgeV1): string {
  const crossed: string[] = [];
  if (edge.boundary.crossRepo) crossed.push("Repository");
  if (edge.boundary.crossPackage) {
    crossed.push(
      `package ${edge.boundary.fromPackageName ?? "?"} -> ${edge.boundary.toPackageName ?? "?"}`,
    );
  }
  if (edge.boundary.crossContainer) {
    crossed.push(
      `Container ${edge.boundary.fromContainerService ?? "?"} -> ${edge.boundary.toContainerService ?? "?"}`,
    );
  }
  return crossed.length === 0 ? "" : `>> Boundary: ${crossed.join(", ")}`;
}

/** Die Kante zwischen zwei benachbarten Dateien, in Traversierungsrichtung. */
function edgeBetween(
  graph: RestoredFileGraph,
  from: string,
  to: string,
  direction: TraversalDirection,
): FileEdgeV1 | null {
  const source = direction === "forward" ? from : to;
  const target = direction === "forward" ? to : from;
  for (const edge of graph.edgesFrom(source)) {
    if (edge.resolution.status === "resolved" && edge.resolution.targetFileId === target) {
      return edge;
    }
  }
  return null;
}

function annotateEdge(edge: FileEdgeV1 | null): string {
  if (edge === null) return "";
  const parts: string[] = [];
  if (edge.resolution.status === "resolved") parts.push(edge.resolution.mechanism);
  parts.push(`"${edge.rawSpecifier}"`);
  const boundary = describeBoundary(edge);
  if (boundary !== "") parts.push(boundary);
  return `  <- ${parts.join(" ")}`;
}

/* ------------------------------------------------------------------ */
/* Baumdarstellung                                                     */
/* ------------------------------------------------------------------ */

interface TreeContext {
  graph: RestoredFileGraph;
  direction: TraversalDirection;
  maxDepth: number;
  /** Genau die Knoten, die die Traversierung wirklich besucht hat. */
  visited: Set<string>;
  shown: Set<string>;
  lines: string[];
}

/**
 * Zeichnet den Baum unter `fileId`.
 *
 * Der Baum zeigt NUR, was die Traversierung auch besucht hat — jedes Kind
 * ausserhalb dieser Menge wird trotzdem GENANNT, mit dem Vermerk, dass ein
 * Budget es zurueckliess. Ein Baum, der solche Kinder weglaesst, waere die
 * bequemste Form des stillen Ueberspringens.
 */
function renderBranch(
  context: TreeContext,
  fileId: string,
  depth: number,
  onPath: readonly string[],
  prefix: string,
): void {
  const children = [...context.graph.neighborsOf(fileId, context.direction)];
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as string;
    const last = i === children.length - 1;
    const branch = last ? "`-- " : "|-- ";
    const childPrefix = prefix + (last ? "    " : "|   ");
    const node = context.graph.node(child);
    const label = node === null ? `${child} (node missing from snapshot)` : describeNode(node);
    const edge = edgeBetween(context.graph, fileId, child, context.direction);
    const head = `${prefix}${branch}${label}${annotateEdge(edge)}`;

    if (onPath.includes(child)) {
      context.lines.push(`${head}  ## CYCLE: closes the path; not followed again`);
      continue;
    }
    if (!context.visited.has(child)) {
      context.lines.push(`${head}  ## not visited: traversal budget exhausted`);
      continue;
    }
    if (context.shown.has(child)) {
      const own = context.graph.neighborsOf(child, context.direction).length;
      context.lines.push(
        own === 0 ? head : `${head}  ## already shown above (${String(own)} neighbors there)`,
      );
      continue;
    }
    context.shown.add(child);

    const grandchildren = context.graph.neighborsOf(child, context.direction).length;
    if (depth + 1 >= context.maxDepth && grandchildren > 0) {
      context.lines.push(
        `${head}  ## truncated: max_depth (${String(grandchildren)} additional neighbors not visited)`,
      );
      continue;
    }
    context.lines.push(head);
    renderBranch(context, child, depth + 1, [...onPath, child], childPrefix);
  }
}

/** Ein Baum je Richtung, samt Fussnote zu Abschneidung und Zyklen. */
export function renderTree(
  graph: RestoredFileGraph,
  node: FileNodeV1,
  direction: TraversalDirection,
  result: FileTraversalResultV1,
): string[] {
  const lines: string[] = [];
  lines.push(DIRECTION_TITLE[direction]);
  lines.push(`  ${describeNode(node)}`);
  const context: TreeContext = {
    graph,
    direction,
    maxDepth: result.limits.maxDepth,
    visited: new Set([node.fileId, ...result.visitedFileIds]),
    shown: new Set([node.fileId]),
    lines: [],
  };
  renderBranch(context, node.fileId, 0, [node.fileId], "  ");
  if (context.lines.length === 0) {
    lines.push(
      direction === "forward" ? "  (no resolved dependencies)" : "  (no dependents for this file)",
    );
  } else {
    lines.push(...context.lines);
  }

  lines.push(
    `  Reached: ${String(result.visitedFileIds.length)} files, depth ${String(result.depthReached)} of ${String(result.limits.maxDepth)}.`,
  );
  if (result.truncated) {
    const reason = result.truncationReason ?? "unknown";
    lines.push(
      `  TRUNCATED: ${TRUNCATION_TEXT[reason] ?? reason} (${reason}). The result is incomplete.`,
    );
    lines.push(
      `  Budgets: maxDepth=${String(result.limits.maxDepth)} maxNodes=${String(result.limits.maxNodes)} maxEdges=${String(result.limits.maxEdges)} maxWallTimeMs=${String(result.limits.maxWallTimeMs)}`,
    );
  }
  if (result.cycles.length > 0) {
    lines.push(`  CYCLES (${String(result.cycles.length)}; reported rather than broken):`);
    for (const cycle of result.cycles) {
      const path = cycle.map((id) => graph.node(id)?.filePath ?? id);
      lines.push(`    ${[...path, path[0] ?? ""].join(" -> ")}`);
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Unaufgeloeste und externe Importe                                   */
/* ------------------------------------------------------------------ */

/** Die unaufgeloesten Kanten einer Datei — Rohstring, Grund, geprueftes. */
export function renderUnresolvedOf(graph: RestoredFileGraph, node: FileNodeV1): string[] {
  const unresolved = graph
    .edgesFrom(node.fileId)
    .filter((edge) => edge.resolution.status === "unresolved");
  if (unresolved.length === 0) return [];
  const lines: string[] = [`UNRESOLVED IMPORTS FOR THIS FILE (${String(unresolved.length)})`];
  for (const edge of unresolved) {
    if (edge.resolution.status !== "unresolved") continue;
    lines.push(`  "${edge.rawSpecifier}"  ${edge.resolution.reason}`);
    lines.push(`    ${edge.resolution.detail}`);
    const rejected = edge.resolution.rejectedCandidates ?? [];
    if (rejected.length > 0) {
      lines.push(`    checked and rejected: ${rejected.join(", ")}`);
    }
    for (const site of edge.sites) {
      lines.push(`    Location: line ${String(site.range.startLine)}`);
    }
    if (edge.sites.length === 0 && edge.sitesMissingReason !== undefined) {
      lines.push(`    no source location: ${edge.sitesMissingReason}`);
    }
  }
  return lines;
}

/** Die externen (workspace-fremden) Abhaengigkeiten einer Datei. */
export function renderExternalOf(graph: RestoredFileGraph, node: FileNodeV1): string[] {
  const external = graph
    .edgesFrom(node.fileId)
    .filter((edge) => edge.resolution.status === "external");
  if (external.length === 0) return [];
  const lines: string[] = [`OUTSIDE THE WORKSPACE (${String(external.length)})`];
  for (const edge of external) {
    if (edge.resolution.status !== "external") continue;
    const version =
      edge.resolution.declaredVersion === undefined ? "" : ` @ ${edge.resolution.declaredVersion}`;
    lines.push(
      `  "${edge.rawSpecifier}" -> ${edge.resolution.packageName}${version}  [${edge.resolution.mechanism}]`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Die Dateisicht                                                      */
/* ------------------------------------------------------------------ */

export function renderFileView(input: FileViewInputV1): string[] {
  const lines: string[] = [];
  lines.push(`File  ${input.node.filePath}`);
  lines.push(
    `  Repository ${input.node.repoId}  Language ${input.node.language}` +
      (input.node.packageName === undefined ? "" : `  package ${input.node.packageName}`) +
      (input.node.containerService === undefined
        ? ""
        : `  Container-Dienst ${input.node.containerService}`),
  );
  lines.push(
    `  Raw imports ${String(input.node.imports.length)}, including workspace-resolved ${String(input.node.dependencies.length)}, unresolved ${String(input.node.unresolvedImportCount)}`,
  );
  lines.push("");

  if (input.dependencies !== undefined) {
    lines.push(...renderTree(input.graph, input.node, "forward", input.dependencies));
    lines.push("");
  }
  if (input.dependents !== undefined) {
    lines.push(...renderTree(input.graph, input.node, "reverse", input.dependents));
    lines.push("");
  }
  const unresolved = renderUnresolvedOf(input.graph, input.node);
  if (unresolved.length > 0) lines.push(...unresolved, "");
  const external = renderExternalOf(input.graph, input.node);
  if (external.length > 0) lines.push(...external, "");
  return lines;
}

/* ------------------------------------------------------------------ */
/* Die Uebersicht                                                      */
/* ------------------------------------------------------------------ */

export interface OverviewInputV1 {
  graph: RestoredFileGraph;
  generationId: string;
  issues: readonly SnapshotReadIssue[];
  /** Wie viele unaufgeloeste Importe einzeln genannt werden. */
  unresolvedLimit: number;
}

/** Die Monorepo-Ebene: Pakete, Paketkanten, Container-Dienste, Dienstkanten. */
export function renderTopology(topology: WorkspaceTopologyV1): string[] {
  const lines: string[] = ["MONOREPO-EBENE"];
  if (topology.workspaceGlobs.length > 0) {
    lines.push(
      `  Workspace-Globs: ${[...topology.workspaceGlobs].sort(compareCodepoints).join(", ")}`,
    );
  }
  const packageNames = topology.packages.map((entry) => entry.name).sort(compareCodepoints);
  lines.push(
    `  Pakete (${String(topology.packages.length)}): ${packageNames.join(", ") || "none"}`,
  );
  const packageEdges = [...topology.packageEdges].sort(
    (left, right) =>
      compareCodepoints(left.fromPackage, right.fromPackage) ||
      compareCodepoints(left.toPackage, right.toPackage),
  );
  for (const edge of packageEdges) {
    lines.push(
      `    ${edge.fromPackage} -> ${edge.toPackage}  [${edge.dependencyField} ${edge.rawRange}]`,
    );
  }
  const serviceNames = topology.services.map((entry) => entry.name).sort(compareCodepoints);
  lines.push(
    `  Container-Dienste (${String(topology.services.length)}): ${serviceNames.join(", ") || "none"}`,
  );
  const serviceEdges = [...topology.serviceEdges].sort(
    (left, right) =>
      compareCodepoints(left.fromService, right.fromService) ||
      compareCodepoints(left.toService, right.toService) ||
      compareCodepoints(left.kind, right.kind),
  );
  for (const edge of serviceEdges) {
    const via = edge.network === undefined ? "" : ` (${edge.network})`;
    lines.push(`    ${edge.fromService} -> ${edge.toService}  [${edge.kind}${via}]`);
  }
  if (topology.services.length > 0) {
    for (const service of [...topology.services].sort((left, right) =>
      compareCodepoints(left.name, right.name),
    )) {
      lines.push(
        `    Dienst ${service.name}: ${service.composeFile}` +
          (service.buildContext === undefined ? "" : `  Context ${service.buildContext}`) +
          (service.image === undefined ? "" : `  Abbild ${service.image}`),
      );
    }
  }
  return lines;
}

/** Uebersprungenes aus dem Ledger — mit Grund, nie als blosse Zahl. */
export function renderLedger(ledger: SkipLedgerV1, limit: number): string[] {
  if (ledger.entries.length === 0) return [];
  const lines: string[] = [`SKIPPED DURING GRAPH BUILD (${String(ledger.entries.length)})`];
  const reasons = Object.entries(ledger.countsByReason).sort(([left], [right]) =>
    compareCodepoints(left, right),
  );
  lines.push(
    `  by reason: ${reasons.map(([reason, count]) => `${reason} ${String(count ?? 0)}`).join(", ")}`,
  );
  for (const entry of ledger.entries.slice(0, limit)) {
    lines.push(`  ${entry.path ?? entry.subjectId ?? "(no path)"}  ${entry.reason}`);
    lines.push(`    ${entry.detail}`);
  }
  if (ledger.entries.length > limit) {
    lines.push(`  … ${String(ledger.entries.length - limit)} more (increase --limit).`);
  }
  return lines;
}

export function renderOverview(input: OverviewInputV1): string[] {
  const graph = input.graph;
  const metrics = graph.metrics();
  const lines: string[] = [];
  lines.push(`File graph  Generation ${input.generationId}`);
  lines.push(
    `  ${String(metrics.nodeCount)} nodes, ${String(metrics.edgeCount)} edges, ` +
      `${String(metrics.orphanFileIds.length)} orphan files`,
  );
  const resolution = metrics.importResolution;
  lines.push(
    `  Importaufloesung ${(resolution.rate * 100).toFixed(1)} %  ` +
      `(aufgeloest ${String(resolution.resolvedCount)}, extern ${String(resolution.externalCount)}, ` +
      `unresolved ${String(resolution.unresolvedCount)})`,
  );

  const boundaries = countBoundaries(graph);
  lines.push(
    `  Cross-boundary edges: package ${String(boundaries.crossPackage)}, ` +
      `Repository ${String(boundaries.crossRepo)}, container ${String(boundaries.crossContainer)}`,
  );
  lines.push("");

  lines.push(...renderTopology(graph.topology));
  lines.push("");

  lines.push(`CYCLES (${String(metrics.cycles.length)})`);
  if (metrics.cycles.length === 0) {
    lines.push("  none found");
  } else {
    for (const cycle of metrics.cycles.slice(0, input.unresolvedLimit)) {
      const path = cycle.map((id) => graph.node(id)?.filePath ?? id);
      lines.push(`  ${[...path, path[0] ?? ""].join(" -> ")}`);
    }
    if (metrics.cycles.length > input.unresolvedLimit) {
      lines.push(`  … ${String(metrics.cycles.length - input.unresolvedLimit)} weitere.`);
    }
  }
  lines.push("");

  if (metrics.topCentralFiles.length > 0) {
    lines.push(`CENTRAL FILES (${metrics.centralityFormula})`);
    for (const entry of metrics.topCentralFiles.slice(0, 10)) {
      lines.push(
        `  ${entry.centrality.toFixed(4)}  ${entry.filePath}  ` +
          `(incoming ${String(entry.inDegree)}, outgoing ${String(entry.outDegree)})`,
      );
    }
    lines.push("");
  }

  const unresolved = graph.edges().filter((edge) => edge.resolution.status === "unresolved");
  lines.push(`UNRESOLVED IMPORTS (${String(unresolved.length)})`);
  if (unresolved.length === 0) {
    lines.push("  none");
  } else {
    for (const edge of unresolved.slice(0, input.unresolvedLimit)) {
      if (edge.resolution.status !== "unresolved") continue;
      lines.push(`  ${edge.fromPath}  "${edge.rawSpecifier}"  ${edge.resolution.reason}`);
      lines.push(`    ${edge.resolution.detail}`);
    }
    if (unresolved.length > input.unresolvedLimit) {
      lines.push(
        `  … ${String(unresolved.length - input.unresolvedLimit)} more (increase --limit).`,
      );
    }
  }
  lines.push("");

  const ledger = renderLedger(graph.skipLedger(), input.unresolvedLimit);
  if (ledger.length > 0) lines.push(...ledger, "");

  return lines;
}

/** Zaehlt die Kanten, die eine Grenze ueberqueren. */
export function countBoundaries(graph: RestoredFileGraph): {
  crossPackage: number;
  crossRepo: number;
  crossContainer: number;
} {
  let crossPackage = 0;
  let crossRepo = 0;
  let crossContainer = 0;
  for (const edge of graph.edges()) {
    if (edge.boundary.crossPackage) crossPackage += 1;
    if (edge.boundary.crossRepo) crossRepo += 1;
    if (edge.boundary.crossContainer) crossContainer += 1;
  }
  return { crossPackage, crossRepo, crossContainer };
}

/** Die Befunde des Zurueckladens — sie gehen auf stderr, nie in die Nutzdaten. */
export function renderIssues(issues: readonly SnapshotReadIssue[]): string[] {
  if (issues.length === 0) return [];
  const lines: string[] = [
    `Warning: the file-graph snapshot is incomplete (${String(issues.length)} findings).`,
  ];
  for (const issue of issues) {
    lines.push(`  ${issue.kind}: ${issue.message}`);
  }
  lines.push("The following information may therefore be incomplete.");
  return lines;
}
