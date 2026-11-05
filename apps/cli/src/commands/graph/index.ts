/**
 * `untangle graph` — der Dateiabhaengigkeitsgraph als Oberflaeche.
 *
 * Er baut nichts. Er LIEST, was `untangle index` gebaut und abgelegt hat
 * (Stufe `building_graphs`), und beantwortet damit vier Fragen:
 *
 *   1. Wovon haengt diese Datei ab, und wer haengt an ihr — transitiv, in
 *      beide Richtungen.
 *   2. Wo hoert die Antwort auf? Jede Traversierung hat ein Budget, und ein
 *      abgeschnittenes Ergebnis sagt DASS und WARUM
 *      (`TRAVERSAL_TRUNCATION_REASONS`).
 *   3. Wo laeuft es im Kreis? Zyklen werden GEMELDET, nie stillschweigend
 *      aufgebrochen.
 *   4. Was liess sich nicht aufloesen? Jeder solche Import steht mit seinem
 *      ROHSTRING und einem benannten Grund da (E4).
 *
 * Und ueber allem die Monorepo-Ebene: welches Paket, welcher Container-Dienst,
 * welche Kante ueberquert welche Grenze. Der Dateigraph traegt das bereits in
 * `FileEdgeBoundaryV1` und in seiner Topologie; dieser Befehl zeigt es.
 */
import path from "node:path";

import type { FileNodeV1, TraversalLimitsV1 } from "@untangle-code/domain";
import { DEFAULT_TRAVERSAL_LIMITS, type RestoredFileGraph } from "@untangle-code/file-graph";
import {
  DEFAULT_MAX_EDGES,
  DEFAULT_MAX_NODES,
  MAX_MAX_EDGES,
  MAX_MAX_NODES,
  writeGraphExplorerHtml,
  type GraphExplorerLayoutKind,
} from "@untangle-code/graph-explorer";

import {
  enumFlag,
  integerFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "../../cli/args.js";
import type { Command, CommandContext } from "../../cli/command.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { loadGraphs } from "../../cli/graphs.js";
import { line, note } from "../../cli/io.js";
import { MAX_GRAPH_QUERY_EDGES } from "../flow/limits.js";

import { runBoundaries } from "./boundaries.js";
import { boundDirectEdges } from "./bounds.js";
import { runFeatureMap } from "./feature-map.js";
import {
  countBoundaries,
  describeNode,
  renderFileView,
  renderIssues,
  renderOverview,
  type GraphDirectionChoice,
} from "./render.js";
import { selectFileNode } from "./select.js";

const FLAGS: FlagSpecs = {
  "feature-map": {
    kind: "string",
    placeholder: "JSON",
    describe: "graph features: explicit declared feature manifest; default untangle.features.json.",
  },
  "test-evidence": {
    kind: "string",
    placeholder: "JSON",
    describe: "graph features: existing source-bound test evidence; does not run tests.",
  },
  services: {
    kind: "string",
    placeholder: "JSON",
    describe:
      "graph boundaries: explicit local HTTP service bindings; default .untangle/services.json.",
  },
  path: {
    kind: "string",
    placeholder: "FILE",
    describe:
      "graph boundaries: one repository-relative file; full route inventory is still analyzed.",
  },
  "max-relations": {
    kind: "number",
    placeholder: "N",
    describe: "graph boundaries: output relations per section (1..1000).",
  },
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Project directory; configuration is discovered from here.",
    defaultLabel: "current directory",
  },
  direction: {
    kind: "string",
    placeholder: "both|dependencies|dependents",
    describe: "Dependencies, dependents, or both.",
    defaultLabel: "both",
  },
  depth: {
    kind: "number",
    placeholder: "N",
    describe: "Transitive depth. Output reports when the limit is reached (max_depth).",
    defaultLabel: "3",
  },
  "max-nodes": {
    kind: "number",
    placeholder: "N",
    describe: "Node budget for traversal or the offline explorer; truncation remains visible.",
    defaultLabel: `${String(DEFAULT_TRAVERSAL_LIMITS.maxNodes)} (query), ${String(DEFAULT_MAX_NODES)} (Explorer)`,
  },
  "max-edges": {
    kind: "number",
    placeholder: "N",
    describe: "Edge budget for a file query or the offline explorer; truncation remains visible.",
    defaultLabel: `${String(MAX_GRAPH_QUERY_EDGES)} (query), ${String(DEFAULT_MAX_EDGES)} (Explorer)`,
  },
  layout: {
    kind: "string",
    placeholder: "repository-lanes|grid|circle",
    describe: "Deterministic initial layout for the offline explorer.",
    defaultLabel: "repository-lanes",
  },
  out: {
    kind: "string",
    placeholder: "FILE",
    describe: "Explicit output target for `graph visualize`; no implicit write target.",
  },
  limit: {
    kind: "number",
    alias: "n",
    placeholder: "N",
    describe: "Maximum individually listed cycles, unresolved imports and ledger entries.",
    defaultLabel: "20",
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Output format. json contains the same information in machine-readable form.",
    defaultLabel: "text",
  },
};

export const graphCommand: Command = {
  spec: {
    name: "graph",
    implementedBy: "commands/graph/index.js",
    summary: "Show file dependencies",
    usage:
      "untangle graph [<file>] [--direction=both] [--depth=N] [--max-edges=N] [--format=text|json]\n  untangle graph visualize --out=<FILE> [--layout=repository-lanes|grid|circle]\n  untangle graph boundaries [--path=FILE] [--services=JSON] [--format=json]\n  untangle graph features [--feature-map=JSON] [--test-evidence=JSON] [--format=json]",
    details: [
      "graph features writes a local interactive feature/code map and source-bound JSON under the target project's .untangle/feature-map directory. It reads current sources without an index or search services. Features, tests, intent, ownership and dependencies remain declarations with explicit evidence gaps. It runs no tests and opens no browser. Zoom, filters, node details and a keyboard-accessible list work offline.",
      "graph boundaries reads current local sources without an index: Vue/TS/JS import context, HTTP requests, FastAPI route registration and declared feature ownership. Explicit service bindings prevent equal paths from silently joining unrelated services. Unknown and ambiguous transport dependencies remain visible; they are not synchronous call edges.",
      "Without a file: overview of nodes, edges, import-resolution rate, monorepo topology (manifest packages, compose services and their edges), cycles, central files, unresolved imports and the graph-build skip ledger.",
      "With a file: dependency and dependent trees in both directions. Each edge identifies its resolution mechanism and any package, repository or container boundary it crosses.",
      "Limits remain visible: transitive depth is bounded (--depth, default 3). Reaching it reports the number of unvisited neighbors and the max_depth reason. Node, edge and time budgets behave likewise. A truncated result never appears complete.",
      "Cycles are reported without breaking them: a closing path is marked at its location and shown in full at the end.",
      "Unresolved imports remain visible with their raw string, reason and checked/rejected candidates.",
      "Reads the stored graph, not the working tree. A missing graph produces exit code 4 and points to `untangle index`; it never claims there are no dependencies.",
      "Offline explorer: `graph visualize` writes only the self-contained HTML artifact explicitly selected with --out. It contains graph metadata, no source text or network requests. Nothing is written without an explicit target.",
    ],
    flags: FLAGS,
    examples: [
      "untangle graph",
      "untangle graph features --format=json",
      "untangle graph packages/domain/src/index.ts --direction=dependents",
      "untangle graph src/app.ts --depth=1",
      "untangle graph --format=json",
      "untangle graph visualize --out=artifacts/graph.html --layout=repository-lanes",
    ],
    exitCodes: [
      [EXIT.ok, "The graph was read and displayed."],
      [EXIT.operational, "Operational error, or the selected file is absent from the graph."],
      [EXIT.usage, "Usage error, or the selected file is ambiguous."],
      [EXIT.environment, "No graph is available; run `untangle index`."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    const format = enumFlag(args, "format", ["text", "json"] as const, "text");
    const target = args.positionals[0];
    if (args.positionals.length > 1) {
      throw new UsageError(
        `The graph command accepts at most one positional argument; received ${String(args.positionals.length)}.`,
        "Use `untangle graph <file>` or `untangle graph visualize --out=<FILE>`.",
      );
    }
    if (target === "boundaries") {
      for (const flag of ["feature-map", "test-evidence"])
        if (args.flags[flag] !== undefined)
          throw new UsageError(`Option --${flag} requires graph features.`);
      return runBoundaries(ctx, { ...args, positionals: [] });
    }
    if (target === "features") {
      for (const flag of [
        "services",
        "path",
        "max-relations",
        "direction",
        "depth",
        "layout",
        "out",
        "limit",
      ])
        if (args.flags[flag] !== undefined)
          throw new UsageError(`Option --${flag} is not supported by graph features.`);
      return runFeatureMap(ctx, { ...args, positionals: [] });
    }
    for (const flag of ["feature-map", "test-evidence"])
      if (args.flags[flag] !== undefined)
        throw new UsageError(`Option --${flag} requires graph features.`);
    for (const flag of ["services", "path", "max-relations"])
      if (args.flags[flag] !== undefined)
        throw new UsageError(`Option --${flag} requires graph boundaries.`);
    const visualizing = target === "visualize";
    validateModeSpecificFlags(args, visualizing, target !== undefined);
    const visualization = visualizing ? readVisualizationOptions(args) : undefined;

    const direction = enumFlag(
      args,
      "direction",
      ["both", "dependencies", "dependents"] as const,
      "both",
    ) as GraphDirectionChoice;
    const depth = integerFlag(args, "depth", 3);
    if (depth < 1) {
      throw new UsageError(
        `Option "--depth" requires at least 1; received "${String(depth)}".`,
        "Example: --depth=3",
      );
    }
    const maxNodes = integerFlag(
      args,
      "max-nodes",
      visualizing ? DEFAULT_MAX_NODES : DEFAULT_TRAVERSAL_LIMITS.maxNodes,
    );
    if (maxNodes < 1 || (visualizing && maxNodes > MAX_MAX_NODES)) {
      throw new UsageError(
        visualizing
          ? `Option "--max-nodes" requires 1 to ${String(MAX_MAX_NODES)}; received "${String(maxNodes)}".`
          : `Option "--max-nodes" requires at least 1; received "${String(maxNodes)}".`,
        visualizing ? "Example: --max-nodes=600" : "Example: --max-nodes=1000",
      );
    }
    const queryMaxEdges = visualizing ? undefined : readQueryMaxEdges(args);
    const limit = integerFlag(args, "limit", 20);
    const rootFlag = stringFlag(args, "root");

    const loaded = await loadGraphs({
      cwd: ctx.cwd,
      env: ctx.env,
      signal: ctx.signal,
      ...(rootFlag === undefined ? {} : { root: path.resolve(ctx.cwd, rootFlag) }),
    });
    for (const issue of renderIssues(loaded.issues)) note(ctx.io, issue);

    const graph = loaded.fileGraph;
    if (visualization !== undefined) {
      return writeVisualization(ctx, format, maxNodes, visualization, loaded);
    }
    const limits: Partial<TraversalLimitsV1> = {
      maxDepth: depth,
      maxNodes,
      ...(queryMaxEdges === undefined ? {} : { maxEdges: queryMaxEdges }),
    };

    /* ------------------------------ Uebersicht ------------------------ */

    if (target === undefined) {
      if (format === "json") {
        line(
          ctx.io,
          JSON.stringify(overviewJson(loaded.generationId, graph, loaded.issues), null, 2),
        );
        return EXIT.ok;
      }
      for (const text of renderOverview({
        graph,
        generationId: loaded.generationId,
        issues: loaded.issues,
        unresolvedLimit: limit,
      })) {
        line(ctx.io, text);
      }
      return EXIT.ok;
    }

    /* ------------------------------ Dateisicht ------------------------ */

    const node = resolveNode(graph, target);
    const dependencies =
      direction === "dependents" ? undefined : graph.dependenciesOf(node.fileId, limits);
    const dependents =
      direction === "dependencies" ? undefined : graph.dependentsOf(node.fileId, limits);

    if (format === "json") {
      const directEdges = boundDirectEdges(
        graph.snapshot.edges,
        node.fileId,
        queryMaxEdges ?? MAX_GRAPH_QUERY_EDGES,
      );
      line(
        ctx.io,
        JSON.stringify(
          {
            generationId: loaded.generationId,
            workspaceId: graph.workspaceId,
            node,
            edges: directEdges.edges,
            truncated: directEdges.truncated,
            omittedCount: directEdges.omittedCount,
            ...(dependencies === undefined ? {} : { dependencies: expand(graph, dependencies) }),
            ...(dependents === undefined ? {} : { dependents: expand(graph, dependents) }),
            issues: loaded.issues,
          },
          null,
          2,
        ),
      );
      return EXIT.ok;
    }

    for (const text of renderFileView({
      graph,
      node,
      direction,
      ...(dependencies === undefined ? {} : { dependencies }),
      ...(dependents === undefined ? {} : { dependents }),
    })) {
      line(ctx.io, text);
    }
    return EXIT.ok;
  },
};

/* ------------------------------------------------------------------ */

async function writeVisualization(
  ctx: CommandContext,
  format: "text" | "json",
  maxNodes: number,
  options: {
    out: string;
    maxEdges: number;
    layout: GraphExplorerLayoutKind;
  },
  loaded: Awaited<ReturnType<typeof loadGraphs>>,
): Promise<number> {
  const outputPath = path.resolve(ctx.cwd, options.out);
  ctx.signal.throwIfAborted();

  let artifact;
  try {
    artifact = await writeGraphExplorerHtml(
      outputPath,
      {
        fileGraph: loaded.fileGraph.snapshot,
        symbolGraph: loaded.symbolGraph?.graph ?? null,
        workspace: {
          workspaceId: loaded.view.workspaceId,
          label: loaded.view.config.projectId ?? loaded.view.workspaceId,
          generationId: loaded.generationId,
          repositories: (loaded.view.config.repositories ?? []).map((repository) => ({
            repoId: repository.id,
            label: repository.label ?? repository.id,
            ...(repository.ref === undefined ? {} : { refName: repository.ref }),
          })),
        },
      },
      { maxNodes, maxEdges: options.maxEdges, initialLayout: options.layout },
    );
  } catch (error) {
    throw new OperationalError(
      `Could not write the offline explorer to "${outputPath}": ${errorMessage(error)}`,
      "Check the target directory and write permissions; Untangle does not create missing parent directories.",
      { cause: error },
    );
  }

  const result = {
    generationId: loaded.generationId,
    workspaceId: loaded.fileGraph.workspaceId,
    artifact,
    symbolGraph: {
      available: loaded.symbolGraph !== null,
      ...(loaded.symbolGraphMissingReason === undefined
        ? {}
        : { missingReason: loaded.symbolGraphMissingReason }),
    },
    issues: loaded.issues,
  };
  if (format === "json") {
    line(ctx.io, JSON.stringify(result, null, 2));
    return EXIT.ok;
  }

  line(ctx.io, `Offline explorer: ${artifact.path}`);
  line(ctx.io, `Generation: ${loaded.generationId}`);
  line(ctx.io, `SHA-256: ${artifact.sha256}`);
  line(ctx.io, `Size: ${String(artifact.bytes)} Bytes`);
  line(
    ctx.io,
    `File graph: ${String(artifact.views.file?.shownNodeCount ?? 0)} nodes, ${String(artifact.views.file?.shownLinkCount ?? 0)} visible edges`,
  );
  if (artifact.views.symbol === null) {
    note(
      ctx.io,
      `Symbol graph missing: ${loaded.symbolGraphMissingReason ?? "no persisted snapshot"}`,
    );
  } else {
    line(
      ctx.io,
      `Symbol graph: ${String(artifact.views.symbol.shownNodeCount)} nodes, ${String(artifact.views.symbol.shownLinkCount)} visible edges`,
    );
  }
  return EXIT.ok;
}

function readVisualizationOptions(args: ParsedArgs): {
  out: string;
  maxEdges: number;
  layout: GraphExplorerLayoutKind;
} {
  const out = stringFlag(args, "out")?.trim();
  if (out === undefined || out === "") {
    throw new UsageError(
      "`untangle graph visualize` requires an explicit --out target.",
      "Example: untangle graph visualize --out=artifacts/graph.html",
    );
  }
  const maxEdges = integerFlag(args, "max-edges", DEFAULT_MAX_EDGES);
  if (maxEdges < 1 || maxEdges > MAX_MAX_EDGES) {
    throw new UsageError(
      `Option "--max-edges" requires 1 to ${String(MAX_MAX_EDGES)}; received "${String(maxEdges)}".`,
      "Example: --max-edges=1200",
    );
  }
  const layout = enumFlag(
    args,
    "layout",
    ["repository-lanes", "grid", "circle"] as const,
    "repository-lanes",
  ) as GraphExplorerLayoutKind;
  return { out, maxEdges, layout };
}

function readQueryMaxEdges(args: ParsedArgs): number {
  const maxEdges = integerFlag(args, "max-edges", MAX_GRAPH_QUERY_EDGES);
  if (maxEdges < 1 || maxEdges > MAX_GRAPH_QUERY_EDGES) {
    throw new UsageError(
      `Option "--max-edges" requires 1 to ${String(MAX_GRAPH_QUERY_EDGES)}; received "${String(maxEdges)}".`,
      `Example: --max-edges=${String(DEFAULT_TRAVERSAL_LIMITS.maxEdges)}`,
    );
  }
  return maxEdges;
}

function validateModeSpecificFlags(
  args: ParsedArgs,
  visualizing: boolean,
  hasTarget: boolean,
): void {
  const visualizationOnly = ["out", "layout"] as const;
  const queryOnly = ["direction", "depth", "limit"] as const;
  const invalid: string[] = (visualizing ? queryOnly : visualizationOnly).filter(
    (name) => args.flags[name] !== undefined,
  );
  if (!visualizing && !hasTarget && args.flags["max-edges"] !== undefined) {
    invalid.push("max-edges");
  }
  if (invalid.length === 0) return;
  const mode = visualizing ? "graph visualize" : "graph";
  throw new UsageError(
    `Option${invalid.length === 1 ? "" : "s"} ${invalid.map((name) => `--${name}`).join(", ")} ${invalid.length === 1 ? "does" : "do"} not apply to \`${mode}\`.`,
    visualizing
      ? "Explorer budgets use --max-nodes and --max-edges; --layout selects the initial layout."
      : invalid.includes("max-edges")
        ? "Use --max-edges with `untangle graph <file>` or `untangle graph visualize --out=<FILE>`."
        : "Use these options only with `untangle graph visualize --out=<FILE>`.",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Der Knoten zur Nutzereingabe — oder ein Abbruch, der die Kandidaten nennt.
 *
 * Mehrdeutigkeit wird NICHT aufgeloest: bei zwei passenden Dateien waehlt der
 * Befehl keine aus, sondern zeigt beide und laesst den Nutzer entscheiden.
 */
function resolveNode(graph: RestoredFileGraph, query: string): FileNodeV1 {
  const selection = selectFileNode(graph.nodes(), query);
  if (selection.status === "found") return selection.node;
  if (selection.status === "ambiguous") {
    throw new UsageError(
      `"${query}" matches ${String(selection.candidates.length)} files: ` +
        selection.candidates.map((node) => node.filePath).join(", "),
      "Specify the complete repository-relative path.",
    );
  }
  const near =
    selection.near.length === 0
      ? ""
      : ` Similar names: ${selection.near.map((node) => node.filePath).join(", ")}.`;
  throw new OperationalError(
    `File "${query}" is absent from the file graph. Nothing was evaluated; ` +
      `this does not mean there are no dependencies.${near}`,
    "Check the path or run `untangle index` again. `untangle graph` without an argument lists the graph contents.",
  );
}

/** Traversierungsergebnis mit Pfaden angereichert — JSON soll lesbar sein. */
function expand(
  graph: RestoredFileGraph,
  result: ReturnType<RestoredFileGraph["dependenciesOf"]>,
): Record<string, unknown> {
  return {
    ...result,
    visitedPaths: result.visitedFileIds.map((id) => graph.node(id)?.filePath ?? id),
    cyclePaths: result.cycles.map((cycle) => cycle.map((id) => graph.node(id)?.filePath ?? id)),
  };
}

function overviewJson(
  generationId: string,
  graph: RestoredFileGraph,
  issues: unknown,
): Record<string, unknown> {
  const metrics = graph.metrics();
  return {
    generationId,
    workspaceId: graph.workspaceId,
    metrics,
    boundaries: countBoundaries(graph),
    topology: graph.topology,
    cyclePaths: metrics.cycles.map((cycle) => cycle.map((id) => graph.node(id)?.filePath ?? id)),
    unresolved: graph
      .edges()
      .filter((edge) => edge.resolution.status === "unresolved")
      .map((edge) => ({
        fromPath: edge.fromPath,
        rawSpecifier: edge.rawSpecifier,
        resolution: edge.resolution,
        sites: edge.sites,
      })),
    orphanPaths: metrics.orphanFileIds.map((id) => graph.node(id)?.filePath ?? id),
    nodes: graph.nodes().map((node) => ({
      fileId: node.fileId,
      filePath: node.filePath,
      label: describeNode(node),
      packageName: node.packageName ?? null,
      containerService: node.containerService ?? null,
      dependencies: node.dependencies.length,
      dependents: node.dependents.length,
      unresolvedImportCount: node.unresolvedImportCount,
    })),
    skipped: graph.skipLedger(),
    issues,
  };
}
