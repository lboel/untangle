/**
 * `untangle flow` — der Symbolgraph als Oberflaeche: wer ruft wen, auf
 * welchem Weg, und wie sicher ist das.
 *
 * Er baut nichts. Er liest den Shard `symbol-graph`, den `untangle index`
 * abgelegt hat, und beantwortet vier Fragen:
 *
 *   1. WEG: Welche Aufrufpfade fuehren von einem Symbol zu einem anderen —
 *      der kuerzeste, und alle bis Tiefe N.
 *   2. ANFANG: Welche Symbole sind Einstiegspunkte (WP-88: verwaiste Symbole,
 *      konventionelle Namen, Testdateien, Routenverzeichnisse)?
 *   3. SICHERHEIT: Jede Kante auf jedem Weg traegt ihre Aufloesungsart
 *      (exact/heuristic/ambiguous/unresolved) und ihre Confidence mit Basis
 *      und Signalen. Eine MEHRDEUTIGE Kante zeigt ALLE Kandidaten — es wird
 *      keiner ausgewaehlt.
 *   4. WIRKUNG: Welche Symbole sind von einer Aenderung an X betroffen, und
 *      wie sicher ist diese Aussage (`--impact`)?
 *
 * DETERMINISMUS: Dieser Befehl gibt den Traversierungen bewusst KEINE
 * Zeitquelle mit. Das Zeitbudget waere die einzige Groesse, die zwei Laeufe
 * ueber denselben Index verschieden ausgehen liesse; Tiefe, Knoten- und
 * Kantenbudget begrenzen die Arbeit ohnehin. Zwei Aufrufe liefern damit
 * dieselbe Ausgabe.
 */
import path from "node:path";

import type { SymbolNodeV1, TraversalLimitsV1 } from "@untangle-code/domain";
import { DEFAULT_TRAVERSAL_LIMITS } from "@untangle-code/file-graph";
import {
  analyzeImpact,
  createSymbolGraphIndex,
  detectEntryPoints,
  findAllCallPaths,
  findShortestCallPath,
  type SymbolGraphIndex,
} from "@untangle-code/symbol-graph";

import {
  boolFlag,
  enumFlag,
  integerFlag,
  numberFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "../../cli/args.js";
import type { Command, CommandContext } from "../../cli/command.js";
import { EXIT, EnvironmentError, OperationalError, UsageError } from "../../cli/exit.js";
import { loadGraphs, type LoadedGraphsV1 } from "../../cli/graphs.js";
import { line, note } from "../../cli/io.js";
import { renderIssues } from "../graph/render.js";

import {
  DEFAULT_FLOW_DEPTH,
  DEFAULT_FLOW_RESULT_LIMIT,
  MAX_FLOW_DEPTH,
  MAX_FLOW_EDGES,
  MAX_FLOW_NODES,
  MAX_FLOW_RESULT_LIMIT,
} from "./limits.js";
import { limitItems } from "./output.js";
import {
  renderAllPaths,
  renderEntryPoints,
  renderImpact,
  renderShortest,
  renderSymbolGraphHeader,
  renderSymbolOverview,
} from "./render.js";
import { describeSymbol, selectSymbolNode } from "./select.js";

const FLAGS: FlagSpecs = {
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Project directory; configuration is discovered from here.",
    defaultLabel: "current directory",
  },
  depth: {
    kind: "number",
    placeholder: "N",
    describe: "Maximum path length or impact-analysis depth.",
    defaultLabel: String(DEFAULT_FLOW_DEPTH),
  },
  limit: {
    kind: "number",
    alias: "n",
    placeholder: "N",
    describe: "Maximum number of displayed paths, entry points or affected symbols.",
    defaultLabel: String(DEFAULT_FLOW_RESULT_LIMIT),
  },
  "entry-points": {
    kind: "boolean",
    describe: "List entry points instead of searching paths (heuristic, with evidence).",
  },
  impact: {
    kind: "boolean",
    describe: "Impact analysis: which symbols depend on the selected symbol.",
  },
  "min-confidence": {
    kind: "number",
    placeholder: "X",
    describe: "Minimum path confidence for --impact; excluded paths remain reported.",
    defaultLabel: "0",
  },
  "max-nodes": {
    kind: "number",
    placeholder: "N",
    describe: "Traversal node budget.",
    defaultLabel: String(DEFAULT_TRAVERSAL_LIMITS.maxNodes),
  },
  "max-edges": {
    kind: "number",
    placeholder: "N",
    describe: "Traversal edge budget.",
    defaultLabel: String(DEFAULT_TRAVERSAL_LIMITS.maxEdges),
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Output format. json contains the same information in machine-readable form.",
    defaultLabel: "text",
  },
};

export const flowCommand: Command = {
  spec: {
    name: "flow",
    implementedBy: "commands/flow/index.js",
    summary: "Show call paths between symbols",
    usage:
      "untangle flow <from> [<to>] | untangle flow --entry-points | untangle flow <symbol> --impact",
    details: [
      "Three forms: `flow <from> <to>` finds call paths, including the shortest and all paths up to depth N. `flow <symbol>` shows its callers and callees. `flow <symbol> --impact` identifies dependent symbols and the confidence of each relationship.",
      "`--entry-points` lists detected entry points: orphan symbols, conventional start names, test symbols and symbols in route directories. Detection is heuristic; each entry includes its evidence and individual weights.",
      "Every edge includes its resolution and confidence: exact (proven), heuristic (plausible), ambiguous (multiple candidates), unresolved (no target, with a reason). Ambiguous edges show all weighted candidates without selecting one.",
      "A name matching multiple symbols is never guessed: candidates are shown with file and line, and the command exits with code 2. Use `path/file.ts:name` or a qualified name to select one.",
      "Reads the stored graph. A missing graph produces exit code 4 and points to `untangle index`; it never claims there are no calls.",
    ],
    flags: FLAGS,
    examples: [
      "untangle flow --entry-points",
      "untangle flow main calculateDiscount",
      "untangle flow services/api/src/orders.ts:calculateDiscount --impact",
      "untangle flow calculateDiscount --format=json",
    ],
    exitCodes: [
      [EXIT.ok, "The symbol graph was read and displayed."],
      [EXIT.operational, "Operational error, or the selected symbol is absent from the graph."],
      [EXIT.usage, "Usage error, or an ambiguous symbol name."],
      [EXIT.environment, "No symbol graph is available; run `untangle index`."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    const format = enumFlag(args, "format", ["text", "json"] as const, "text");
    const depth = integerFlag(args, "depth", DEFAULT_FLOW_DEPTH);
    if (depth < 1 || depth > MAX_FLOW_DEPTH) {
      throw new UsageError(
        `Option "--depth" requires 1 to ${String(MAX_FLOW_DEPTH)}; received "${String(depth)}".`,
        "Example: --depth=6",
      );
    }
    const limit = integerFlag(args, "limit", DEFAULT_FLOW_RESULT_LIMIT);
    if (limit < 1 || limit > MAX_FLOW_RESULT_LIMIT) {
      throw new UsageError(
        `Option "--limit" requires 1 to ${String(MAX_FLOW_RESULT_LIMIT)}; received "${String(limit)}".`,
        "Example: --limit=20",
      );
    }
    const maxNodes = integerFlag(args, "max-nodes", DEFAULT_TRAVERSAL_LIMITS.maxNodes);
    if (maxNodes < 1 || maxNodes > MAX_FLOW_NODES) {
      throw new UsageError(
        `Option "--max-nodes" requires 1 to ${String(MAX_FLOW_NODES)}; received "${String(maxNodes)}".`,
        `Example: --max-nodes=${String(DEFAULT_TRAVERSAL_LIMITS.maxNodes)}`,
      );
    }
    const maxEdges = integerFlag(args, "max-edges", DEFAULT_TRAVERSAL_LIMITS.maxEdges);
    if (maxEdges < 1 || maxEdges > MAX_FLOW_EDGES) {
      throw new UsageError(
        `Option "--max-edges" requires 1 to ${String(MAX_FLOW_EDGES)}; received "${String(maxEdges)}".`,
        `Example: --max-edges=${String(DEFAULT_TRAVERSAL_LIMITS.maxEdges)}`,
      );
    }
    const wantEntryPoints = boolFlag(args, "entry-points");
    const wantImpact = boolFlag(args, "impact");
    const minConfidence = numberFlag(args, "min-confidence") ?? 0;
    if (minConfidence < 0 || minConfidence > 1) {
      throw new UsageError(
        `Option "--min-confidence" requires a value in [0, 1]; received "${String(minConfidence)}".`,
        "Example: --min-confidence=0.5",
      );
    }
    const rootFlag = stringFlag(args, "root");

    const positionals = args.positionals;
    if (!wantEntryPoints && positionals.length === 0) {
      throw new UsageError(
        "A symbol is required.",
        "Use `untangle flow <from> <to>`, `untangle flow <symbol> [--impact]`, or `untangle flow --entry-points`.",
      );
    }
    if (wantEntryPoints && positionals.length > 0) {
      throw new UsageError(
        "`--entry-points` lists the entire graph and does not accept a symbol.",
        "Omit the argument, or query a symbol without --entry-points.",
      );
    }
    if (positionals.length > 2) {
      throw new UsageError(
        `Expected at most two symbols; received ${String(positionals.length)}.`,
        "Use `untangle flow <from> <to>`.",
      );
    }
    if (wantImpact && positionals.length === 2) {
      throw new UsageError(
        "`--impact` examines the impact of one symbol, not a path between two symbols.",
        "Omit the second symbol, or query the path without --impact.",
      );
    }

    const loaded = await loadGraphs({
      cwd: ctx.cwd,
      env: ctx.env,
      signal: ctx.signal,
      ...(rootFlag === undefined ? {} : { root: path.resolve(ctx.cwd, rootFlag) }),
    });
    for (const issue of renderIssues(loaded.issues)) note(ctx.io, issue);

    const symbolGraph = requireSymbolGraph(loaded);
    const index = createSymbolGraphIndex(symbolGraph.graph);
    const limits: TraversalLimitsV1 = {
      maxDepth: depth,
      maxNodes,
      maxEdges,
      maxWallTimeMs: DEFAULT_TRAVERSAL_LIMITS.maxWallTimeMs,
    };

    const header = renderSymbolGraphHeader(index, loaded.generationId, symbolGraph.ledgerInShard);

    /* --------------------------- Einstiegspunkte ---------------------- */

    if (wantEntryPoints) {
      const set = detectEntryPoints(index);
      if (format === "json") {
        line(
          ctx.io,
          JSON.stringify({ generationId: loaded.generationId, entryPoints: set }, null, 2),
        );
        return EXIT.ok;
      }
      for (const text of [...header, "", ...renderEntryPoints(set, limit)]) line(ctx.io, text);
      return EXIT.ok;
    }

    const from = resolveSymbol(index, positionals[0] as string);

    /* ------------------------------ Wirkung --------------------------- */

    if (wantImpact) {
      const result = analyzeImpact(index, {
        rootSymbolIds: [from.id],
        limits,
        minConfidence,
      });
      if (format === "json") {
        const affected = limitItems(result.affected, limit);
        line(
          ctx.io,
          JSON.stringify(
            {
              generationId: loaded.generationId,
              root: from,
              impact: { ...result, affected: affected.items },
              truncated: affected.truncated,
              omittedCount: affected.omittedCount,
            },
            null,
            2,
          ),
        );
        return EXIT.ok;
      }
      for (const text of [
        ...header,
        "",
        `IMPACT OF A CHANGE TO  ${describeSymbol(from)}`,
        "",
        ...renderImpact(index, result, limit),
      ]) {
        line(ctx.io, text);
      }
      return EXIT.ok;
    }

    /* --------------------------- Einzelnes Symbol --------------------- */

    if (positionals.length === 1) {
      if (format === "json") {
        const outgoing = limitItems(index.outgoingEdges(from.id), limit);
        const callers = limitItems(index.callers(from.id), limit);
        const omittedCount = outgoing.omittedCount + callers.omittedCount;
        line(
          ctx.io,
          JSON.stringify(
            {
              generationId: loaded.generationId,
              symbol: from,
              outgoing: outgoing.items,
              callers: callers.items,
              truncated: omittedCount > 0,
              omittedCount,
            },
            null,
            2,
          ),
        );
        return EXIT.ok;
      }
      for (const text of [...header, "", ...renderSymbolOverview(index, from)]) line(ctx.io, text);
      return EXIT.ok;
    }

    /* ------------------------------- Pfade ---------------------------- */

    const to = resolveSymbol(index, positionals[1] as string);
    const shortest = findShortestCallPath(index, {
      fromSymbolId: from.id,
      toSymbolId: to.id,
      limits,
    });
    const all = findAllCallPaths(index, {
      fromSymbolId: from.id,
      toSymbolId: to.id,
      maxDepth: depth,
      maxPaths: limit,
      maxNodes,
      maxEdges,
    });

    if (format === "json") {
      line(
        ctx.io,
        JSON.stringify({ generationId: loaded.generationId, from, to, shortest, all }, null, 2),
      );
      return EXIT.ok;
    }

    for (const text of [
      ...header,
      "",
      `VON   ${describeSymbol(from)}`,
      `TO    ${describeSymbol(to)}`,
      "",
      // `false`: siehe Kopfkommentar — dieser Befehl gibt der Suche keine
      // Zeitquelle, das Zeitbudget ist also nicht durchgesetzt und sagt das.
      ...renderShortest(index, shortest, false),
      "",
      ...renderAllPaths(index, all),
    ]) {
      line(ctx.io, text);
    }
    return EXIT.ok;
  },
};

/* ------------------------------------------------------------------ */

function requireSymbolGraph(loaded: LoadedGraphsV1): NonNullable<LoadedGraphsV1["symbolGraph"]> {
  if (loaded.symbolGraph !== null) return loaded.symbolGraph;
  throw new EnvironmentError(
    `No symbol graph is available: ${loaded.symbolGraphMissingReason ?? "no reason given"} ` +
      "Nothing was searched; this does not mean there are no calls.",
    "Run `untangle index` to store the symbol-graph shard.",
  );
}

/**
 * Das Symbol zur Nutzereingabe — oder ein Abbruch, der die Kandidaten nennt.
 * Geraten wird nie (architecture.md §17.2 gilt auch fuer die Oberflaeche).
 */
function resolveSymbol(index: SymbolGraphIndex, query: string): SymbolNodeV1 {
  const selection = selectSymbolNode(index.nodes(), query);
  if (selection.status === "found") return selection.node;
  if (selection.status === "ambiguous") {
    const list = selection.candidates.map((node) => `\n    ${describeSymbol(node)}`).join("");
    throw new UsageError(
      `"${query}" matches ${String(selection.candidates.length)} symbols (${selection.matchedBy}) — ` +
        `no candidate is selected:${list}`,
      "Select one using `path/file.ts:name` or the qualified name.",
    );
  }
  const near =
    selection.near.length === 0
      ? ""
      : ` Similar names: ${selection.near.map((node) => node.qualifiedName).join(", ")}.`;
  throw new OperationalError(
    `Symbol "${query}" is absent from the symbol graph. Nothing was evaluated; ` +
      `this does not mean there are no calls.${near}`,
    "Check the name or run `untangle index` again. `untangle flow --entry-points` lists known symbols.",
  );
}
