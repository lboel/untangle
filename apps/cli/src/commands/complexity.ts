/**
 * `untangle complexity` — die einzige Analyse, die HEUTE vollstaendig laeuft.
 *
 * Sie braucht keinen Index und keinen Dienst: der Scanner findet die Dateien,
 * die parser-registry parst sie, @untangle-code/complexity rechnet. Alles im
 * Prozess, alles deterministisch.
 *
 * ZWEI ENTSCHEIDUNGEN, DIE MAN KENNEN MUSS:
 *
 * 1. Eine Datei mit beschaedigtem Syntaxbaum (`parseQuality !== "complete"`)
 *    geht in KEINE Zahl ein. Ein kaputter Baum liefert falsche Scope-Grenzen,
 *    und eine falsche Hotspot-Liste ist schlimmer als eine kurze: nach ihr
 *    wird priorisiert. Die Datei steht dafuer im Skip-Ledger.
 * 2. Die Summen sind die FUNKTIONS-LESART: aeusserste Ausfuehrungseinheiten
 *    gehen mit ihrem INKLUSIVEN Wert ein.
 *    Innere Funktionen sind darin enthalten; Scopes ausserhalb einer
 *    Ausfuehrungseinheit tragen nur ihren Eigenanteil bei (execution_unit).
 *
 * 3. PROSA WIRD NICHT MIT CODE VERRECHNET (WP-217, vision.md §1c). Ein
 *    Markdown-Dokument hat keine Entscheidungspunkte und keine
 *    Ausfuehrungseinheiten; zyklomatische Komplexitaet darueber ist keine
 *    schlechte Zahl, sondern gar keine. Prosa bekommt deshalb eine EIGENE
 *    Auswertung mit eigenen Massen (Struktur- und Verweislast) und eine
 *    eigene Liste. Die beiden Summen beruehren einander nie — die
 *    Prosa-Messwerte sind `ProseNumberV1`-Objekte und passen gar nicht in
 *    eine Code-Summe.
 * 4. WAS UEBERSPRUNGEN WIRD, BEKOMMT DEN RICHTIGEN GRUND. Eine
 *    `untangle.toml` ist nicht "unsupported_language" — sie ist verstanden
 *    (Stufe `text`), es ist nur keine Komplexitaetsmetrik dafuer definiert:
 *    `no_metric_defined`. Eine `pnpm-lock.yaml` ist `generated_content`.
 *    Ein falscher Grund ist ein stiller Datenverlust mit Etikett.
 *
 * Fuer „continuous complexity monitoring": `--max-cognitive` und
 * `--max-cyclomatic` machen daraus ein Gate mit Exit-Code 5.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  aggregateScopeTree,
  buildSymbolIR,
  compareProseByStructureLoad,
  computeCognitive,
  computeCyclomatic,
  computeProseMetrics,
  containsRange,
  selectSymbolFacts,
  withUniqueScopeIds,
  type ScopeMetricNodeV1,
} from "@untangle-code/complexity";
import {
  COGNITIVE_ALGORITHM_ID,
  METRICS_VERSION,
  buildSkipLedgerEntry,
  classifyAdapterFailure,
  classifyTextFormat,
  compareCodepoints,
  formatProseNumber,
  type LanguageAdapter,
  type ParsedAst,
  type ProseMetricsV1,
  type SkipLedgerEntryV1,
  type SkipReason,
} from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import { discoverFiles } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import {
  enumFlag,
  integerFlag,
  numberFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { EXIT, OperationalError } from "../cli/exit.js";
import { line, note } from "../cli/io.js";
import { errorMessage } from "../cli/workspace.js";

/**
 * Scope-Arten, die eine eigene Ausfuehrungseinheit sind. `kind` ist ein
 * adapterspezifischer String; @untangle-code/complexity dokumentiert bewusst
 * keine Sprach-Taxonomie, also steht die Zuordnung hier.
 */
const EXECUTION_UNIT_KINDS = new Set(["function", "method", "constructor", "lambda"]);

interface SymbolEntry {
  readonly filePath: string;
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly executionUnit: boolean;
  readonly cognitive: number;
  readonly cyclomatic: number;
  readonly sloc: number;
}

export interface AnalysisResult {
  readonly root: string;
  readonly filesDiscovered: number;
  readonly filesAnalyzed: number;
  /** Dokumente mit Prosa-Metriken; getrennt gezaehlt, weil getrennt gemessen. */
  readonly proseAnalyzed: number;
  readonly symbols: readonly SymbolEntry[];
  /** Prosa-Dokumente mit ihrer eigenen Metrikfamilie; NIE Teil von `totals`. */
  readonly prose: readonly ProseMetricsV1[];
  readonly skipped: readonly SkipLedgerEntryV1[];
  readonly totalsReading: "execution_unit";
  readonly totals: {
    /** All function-like scopes, including nested functions shown as hotspots. */
    readonly executionUnits: number;
    /** Outermost execution units that contribute inclusive values to totals. */
    readonly executionUnitRoots: number;
    readonly cognitive: number;
    readonly cyclomatic: number;
  };
}

const FLAGS: FlagSpecs = {
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Directory to analyze.",
    defaultLabel: "current directory",
  },
  top: {
    kind: "number",
    placeholder: "N",
    describe: "Maximum hotspot entries.",
    defaultLabel: "20",
  },
  format: {
    kind: "string",
    placeholder: "text|json|jsonl",
    describe: "Output format.",
    defaultLabel: "text",
  },
  "max-cognitive": {
    kind: "number",
    placeholder: "N",
    describe: "Gate: no symbol may exceed this cognitive value.",
  },
  "max-cyclomatic": {
    kind: "number",
    placeholder: "N",
    describe: "Gate: no symbol may exceed this cyclomatic value.",
  },
  "include-nested": {
    kind: "boolean",
    describe: "Also show scopes that are not separate execution units.",
  },
  prose: {
    kind: "boolean",
    describe: "Show only prose analysis (documents instead of symbols).",
  },
};

export const complexityCommand: Command = {
  spec: {
    name: "complexity",
    implementedBy: "commands/complexity.js",
    summary: "Measure complexity without an index or services",
    usage: "untangle complexity [--root=<PATH>] [--top=<N>] [--max-cognitive=<N>]",
    details: [
      "Reads files directly, parses them with real language adapters and computes cognitive and cyclomatic complexity per symbol. No index, Qdrant or Ollama is required.",
      "Totals use execution_unit: outermost functions contribute inclusive values; outside them, only self contributions count. Nested functions are not added twice. executionUnits counts all functions; executionUnitRoots counts only outermost functions. Individual hotspots remain visible.",
      "Files with damaged syntax trees contribute to no measurement and appear in the skip ledger. This prevents an incorrect hotspot ranking from appearing valid.",
      "--max-cognitive and --max-cyclomatic turn the run into a gate, producing exit code 5 on a violation for monitoring loops or CI.",
    ],
    flags: FLAGS,
    examples: [
      "untangle complexity",
      "untangle complexity --top=5 --format=json",
      "untangle complexity --max-cognitive=25",
    ],
    exitCodes: [
      [EXIT.ok, "Analysis completed without a gate violation."],
      [EXIT.operational, "Unreadable directory or no built language adapter."],
      [EXIT.usage, "Invalid arguments."],
      [EXIT.gate, "A threshold was exceeded; analysis itself completed."],
      [EXIT.cancelled, "Cancelled."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    const format = enumFlag(args, "format", ["text", "json", "jsonl"] as const, "text");
    const top = integerFlag(args, "top", 20);
    const includeNested = args.flags["include-nested"] === true;
    const root = path.resolve(ctx.cwd, stringFlag(args, "root") ?? ".");
    const maxCognitive = numberFlag(args, "max-cognitive");
    const maxCyclomatic = numberFlag(args, "max-cyclomatic");

    const result = await analyze(root, ctx.signal);
    ctx.signal.throwIfAborted();

    const shown = includeNested ? result.symbols : result.symbols.filter((s) => s.executionUnit);
    const hotspots = [...shown]
      .sort(
        (a, b) =>
          b.cognitive - a.cognitive ||
          b.cyclomatic - a.cyclomatic ||
          compareCodepoints(a.filePath, b.filePath) ||
          a.line - b.line,
      )
      .slice(0, top);

    const violations = collectViolations(shown, maxCognitive, maxCyclomatic);
    // Eigene Ordnung, eigene Liste: Prosa steht nie in derselben Rangfolge
    // wie Code, weil die Zahlen nicht dieselbe Bedeutung haben.
    const proseRanked = [...result.prose].sort(compareProseByStructureLoad).slice(0, top);
    const proseOnly = args.flags["prose"] === true;

    if (format === "json") {
      line(
        ctx.io,
        JSON.stringify(
          {
            schemaVersion: 1,
            root: result.root,
            filesDiscovered: result.filesDiscovered,
            filesAnalyzed: result.filesAnalyzed,
            filesProse: result.proseAnalyzed,
            totalsReading: result.totalsReading,
            totals: result.totals,
            hotspots,
            violations,
            // Getrenntes Feld, getrennte Familie: die Werte sind Objekte mit
            // Einheit (`ProseNumberV1`), keine blanken Zahlen — sie lassen
            // sich gar nicht versehentlich zu `totals` addieren.
            prose: proseRanked.map(proseSummary),
            skipped: result.skipped,
          },
          null,
          2,
        ),
      );
    } else if (format === "jsonl") {
      line(
        ctx.io,
        JSON.stringify({
          schemaVersion: 1,
          kind: "header",
          root: result.root,
          filesDiscovered: result.filesDiscovered,
          filesAnalyzed: result.filesAnalyzed,
          totalsReading: result.totalsReading,
          totals: result.totals,
          filesProse: result.proseAnalyzed,
          skippedCount: result.skipped.length,
        }),
      );
      // `record` steht vorn, `kind` des Symbols bleibt erhalten — zwei
      // verschiedene Begriffe, also zwei verschiedene Feldnamen.
      for (const entry of hotspots) line(ctx.io, JSON.stringify({ record: "symbol", ...entry }));
      for (const entry of violations)
        line(ctx.io, JSON.stringify({ record: "violation", ...entry }));
      for (const entry of proseRanked)
        line(ctx.io, JSON.stringify({ record: "document", ...proseSummary(entry) }));
    } else {
      renderText(ctx, result, hotspots, includeNested, proseRanked, proseOnly);
    }

    if (violations.length > 0) {
      note(ctx.io, "");
      note(ctx.io, `${String(violations.length)} threshold violation(s):`);
      for (const violation of violations) {
        note(
          ctx.io,
          `  ${violation.filePath}:${String(violation.line)}  ${violation.name}  ` +
            `${violation.metric}=${String(violation.value)} > ${String(violation.threshold)}`,
        );
      }
      note(ctx.io, "");
      note(ctx.io, "Next step: `untangle complexity --top=5` shows the largest hotspots first.");
      return EXIT.gate;
    }

    return EXIT.ok;
  },
};

/* --------------------------------------------------------------------- */

interface Violation {
  readonly filePath: string;
  readonly line: number;
  readonly name: string;
  readonly metric: "cognitive" | "cyclomatic";
  readonly value: number;
  readonly threshold: number;
}

function collectViolations(
  symbols: readonly SymbolEntry[],
  maxCognitive: number | undefined,
  maxCyclomatic: number | undefined,
): Violation[] {
  const out: Violation[] = [];
  for (const symbol of symbols) {
    if (maxCognitive !== undefined && symbol.cognitive > maxCognitive) {
      out.push({
        filePath: symbol.filePath,
        line: symbol.line,
        name: symbol.name,
        metric: "cognitive",
        value: symbol.cognitive,
        threshold: maxCognitive,
      });
    }
    if (maxCyclomatic !== undefined && symbol.cyclomatic > maxCyclomatic) {
      out.push({
        filePath: symbol.filePath,
        line: symbol.line,
        name: symbol.name,
        metric: "cyclomatic",
        value: symbol.cyclomatic,
        threshold: maxCyclomatic,
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.value - a.value ||
      compareCodepoints(a.filePath, b.filePath) ||
      a.line - b.line ||
      compareCodepoints(a.metric, b.metric),
  );
}

/**
 * Die serialisierbare Kurzform eines Prosa-Ergebnisses.
 *
 * Die Belegfelder (`sections`, `links`) bleiben absichtlich draussen: sie
 * sind bei `spec.md` vierstellig lang und wuerden die Ausgabe unbrauchbar
 * machen. Was hier steht, sind die Messwerte selbst — als Objekte mit
 * Einheit, damit auch im JSON sichtbar bleibt, dass es eine ANDERE Familie
 * ist als `totals`.
 */
function proseSummary(metrics: ProseMetricsV1): Record<string, unknown> {
  return {
    path: metrics.path,
    metricsVersion: metrics.metricsVersion,
    structureLoad: metrics.structureLoad,
    sectionCount: metrics.sectionCount,
    sectionDepth: metrics.sectionDepth,
    maxSectionLines: metrics.maxSectionLines,
    linkDensity: metrics.linkDensity,
    unresolvedLinkRatio: metrics.unresolvedLinkRatio,
    repetitionRatio: metrics.repetitionRatio,
    contentLines: metrics.contentLines,
  };
}

function renderText(
  ctx: CommandContext,
  result: AnalysisResult,
  hotspots: readonly SymbolEntry[],
  includeNested: boolean,
  prose: readonly ProseMetricsV1[],
  proseOnly: boolean,
): void {
  line(ctx.io, `Root:             ${result.root}`);
  line(ctx.io, `Files discovered: ${String(result.filesDiscovered)}`);
  line(ctx.io, `Files measured:   ${String(result.filesAnalyzed)}  (Code)`);
  line(ctx.io, `Documents:        ${String(result.proseAnalyzed)}  (prose)`);
  line(
    ctx.io,
    `Skipped:          ${String(result.skipped.length)}  (with reasons; see --format=json)`,
  );

  if (!proseOnly) {
    line(ctx.io, "");
    line(
      ctx.io,
      `Execution units: ${String(result.totals.executionUnits)}` +
        `   Cognitive total: ${String(result.totals.cognitive)}` +
        `   Cyclomatic total: ${String(result.totals.cyclomatic)}`,
    );
    line(ctx.io, "");
    line(
      ctx.io,
      `Totals: execution_unit; ${String(result.totals.executionUnitRoots)} outermost units; nested functions are not added twice.`,
    );
    line(ctx.io, `HOTSPOTS (${includeNested ? "all scopes" : "execution units only"})`);
    if (hotspots.length === 0) {
      line(ctx.io, "  (none)");
    } else {
      line(ctx.io, "  cognitive  cyclomatic  sloc  location");
      for (const entry of hotspots) {
        line(
          ctx.io,
          `  ${String(entry.cognitive).padStart(9)}  ${String(entry.cyclomatic).padStart(10)}  ` +
            `${String(entry.sloc).padStart(4)}  ${entry.filePath}:${String(entry.line)}  ${entry.name}`,
        );
      }
    }
  }

  renderProse(ctx, prose);
}

/**
 * Die Prosa-Tafel. Sie steht bewusst UNTER einer eigenen Ueberschrift und
 * mit eigenen Spaltennamen: kein Wert aus dieser Tabelle darf mit einem Wert
 * aus der Hotspot-Tabelle verglichen oder addiert werden, und die Ausgabe
 * soll das auch optisch klarmachen.
 */
function renderProse(ctx: CommandContext, prose: readonly ProseMetricsV1[]): void {
  line(ctx.io, "");
  line(ctx.io, "PROSE (separate metric family; never combined with code metrics)");
  if (prose.length === 0) {
    line(ctx.io, "  (no documents)");
    return;
  }
  line(ctx.io, "  Structural load = sum of all section heading levels.");
  line(ctx.io, "");
  line(ctx.io, "   load  sectns  depth  max-lines  links/100  unresolved  repeats  document");
  for (const entry of prose) {
    line(
      ctx.io,
      `  ${String(entry.structureLoad.value).padStart(5)}` +
        `  ${String(entry.sectionCount.value).padStart(6)}` +
        `  ${String(entry.sectionDepth.value).padStart(5)}` +
        `  ${String(entry.maxSectionLines.value).padStart(9)}` +
        `  ${entry.linkDensity.value.toFixed(1).padStart(12)}` +
        `  ${(entry.unresolvedLinkRatio === null
          ? "n/a"
          : formatProseNumber(entry.unresolvedLinkRatio)
        ).padStart(7)}` +
        `  ${formatProseNumber(entry.repetitionRatio).padStart(7)}` +
        `  ${entry.path}`,
    );
  }
}

/* --------------------------------------------------------------------- */

/** Shared local analysis for complexity and scan; every excluded file has a ledger entry. */
export async function analyze(root: string, signal: AbortSignal): Promise<AnalysisResult> {
  const registry = createParserRegistry();
  const fs = new NodeFileSystem();
  if ((await fs.stat(root))?.kind !== "directory") {
    throw new OperationalError(
      `Directory "${root}" does not exist or is not a directory.`,
      "Check --root and read permissions.",
    );
  }
  const totals = { executionUnits: 0, executionUnitRoots: 0, cognitive: 0, cyclomatic: 0 };
  const skipped: SkipLedgerEntryV1[] = [];
  const symbols: SymbolEntry[] = [];
  const prose: ProseMetricsV1[] = [];
  let filesDiscovered = 0;
  let filesAnalyzed = 0;
  let proseAnalyzed = 0;

  /**
   * Aufloeser fuer relative Dateiverweise in Prosa. Er sieht auf die Platte —
   * deshalb steht er HIER und nicht in @untangle-code/complexity, das
   * I/O-frei bleibt. Ohne ihn bliebe `unresolvedLinkRatio` `null`, und das
   * waere ein Zustandsvermerk statt eines Messwerts (vision.md §1d).
   */
  const resolveLink = (documentPath: string, targetFilePath: string): boolean => {
    const base = path.dirname(path.resolve(root, documentPath));
    return existsSync(path.resolve(base, targetFilePath));
  };

  const stream = discoverFiles({
    fs,
    roots: [root],
    repoRoot: root,
    onSkip: (skip) => {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "scan",
          subjectKind: "file",
          path: skip.relativePath,
          reason: scannerSkipReason(skip.reason),
          detail:
            `Excluded by the scanner (${skip.reason})` +
            (skip.detail === undefined ? "." : `: ${skip.detail}`),
          recoverable: skip.reason === "unreadable",
        }),
      );
    },
  });

  try {
    for await (const file of stream) {
      // Ein Abbruch ist kein erfolgreiches Teilergebnis. Insbesondere MCP
      // muss CANCELLED statt `ok: true` mit einer zufaelligen Praefixmenge
      // erhalten.
      signal.throwIfAborted();
      filesDiscovered++;

      // Maschinell erzeugte Dateien werden VOR der Adapterfrage aussortiert:
      // eine `pnpm-lock.yaml` ist gueltiges YAML, aber niemandes Text. Der
      // Grund gehoert deshalb an den Inhalt, nicht an die Sprache.
      if (classifyTextFormat(file.relativePath) === "generated") {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "parse",
            subjectKind: "file",
            path: file.relativePath,
            reason: "generated_content",
            detail:
              "Generated file (such as a lockfile). It contains no authored " +
              "statement to measure and contributes to no measurement.",
            recoverable: false,
          }),
        );
        continue;
      }

      const adapter = registry.getAdapterForPath(file.relativePath);
      if (adapter === null) {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "parse",
            subjectKind: "file",
            path: file.relativePath,
            reason: "unsupported_language",
            detail: `No language adapter for "${file.languageId}"; this file contributes to no measurement.`,
            recoverable: false,
          }),
        );
        continue;
      }

      let content: string;
      try {
        content = readFileSync(file.absolutePath, "utf8");
      } catch (error) {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "scan",
            subjectKind: "file",
            path: file.relativePath,
            reason: "provider_unavailable",
            detail: `Cannot read file: ${errorMessage(error)}`,
            recoverable: true,
          }),
        );
        continue;
      }

      // WP-217: Stufe `text` heisst NICHT "weniger Code", sondern "kein
      // Code". Der Weg trennt sich hier, damit nie eine Prosa-Zahl in eine
      // Code-Summe und nie eine Code-Metrik auf ein Dokument geraet.
      if (adapter.supportLevel === "text") {
        if (classifyTextFormat(file.relativePath) === "prose") {
          prose.push(computeProseMetrics(file.relativePath, content, { resolveLink }));
          proseAnalyzed++;
        } else {
          skipped.push(
            buildSkipLedgerEntry({
              stage: "parse",
              subjectKind: "file",
              path: file.relativePath,
              reason: "no_metric_defined",
              detail:
                `Format "${file.languageId}" is supported (tier "text": chunks and search ` +
                "work), but structured configuration has no control flow or " +
                "section structure; neither a code metric nor a prose metric is " +
                "defined for it.",
              recoverable: false,
            }),
          );
        }
        continue;
      }

      let parsed;
      try {
        parsed = adapter.parse({
          fileId: file.relativePath,
          repoId: "cli",
          refId: "cli:working-tree",
          path: file.relativePath,
          languageId: file.languageId,
          content,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
        });
      } catch (error) {
        // WP-216: NIE `errorMessage(error)` als Grund durchreichen. "Invalid
        // argument" ist keine Diagnose — `classifyAdapterFailure` bildet jede
        // Adapterausnahme auf einen BENANNTEN Grund samt Messwerten ab, der
        // Rohtext ueberlebt nur als Anhang im Detail (E4).
        const failure = classifyAdapterFailure(error, { sizeBytes: file.sizeBytes });
        skipped.push(
          buildSkipLedgerEntry({
            stage: "parse",
            subjectKind: "file",
            path: file.relativePath,
            reason: failure.reason,
            detail: failure.detail,
            recoverable: failure.recoverable,
          }),
        );
        continue;
      }

      if (parsed.ast === null || parsed.parseQuality !== "complete") {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "parse",
            subjectKind: "file",
            path: file.relativePath,
            reason: "parse_failed",
            detail:
              `parseQuality="${parsed.parseQuality}"; scope boundaries and decision points ` +
              "are therefore unreliable, so this file contributes to no measurement.",
            recoverable: true,
          }),
        );
        continue;
      }

      for (const diagnostic of parsed.diagnostics) {
        if (diagnostic.code !== "analysis_scope_limited" || diagnostic.range === undefined)
          continue;
        skipped.push(
          buildSkipLedgerEntry({
            stage: "parse",
            subjectKind: "range",
            path: file.relativePath,
            range: diagnostic.range,
            reason: "no_metric_defined",
            detail: diagnostic.message,
            recoverable: false,
          }),
        );
      }
      filesAnalyzed++;
      const measured = symbolsOfFile(adapter, parsed.ast, file.relativePath);
      symbols.push(...measured.symbols);
      totals.executionUnits += measured.symbols.filter((entry) => entry.executionUnit).length;
      totals.executionUnitRoots += measured.executionUnitRoots;
      totals.cognitive += measured.cognitive;
      totals.cyclomatic += measured.cyclomatic;
    }
  } catch (error) {
    signal.throwIfAborted();
    throw new OperationalError(
      `Directory "${root}" could not be read completely: ${errorMessage(error)}`,
      "Check the path and read permissions, or select another directory with --root.",
      { cause: error },
    );
  }

  signal.throwIfAborted();

  symbols.sort(
    (a, b) =>
      compareCodepoints(a.filePath, b.filePath) ||
      a.line - b.line ||
      compareCodepoints(a.name, b.name),
  );
  skipped.sort(
    (a, b) =>
      compareCodepoints(a.path ?? "", b.path ?? "") || compareCodepoints(a.reason, b.reason),
  );

  prose.sort((a, b) => compareCodepoints(a.path, b.path));

  return {
    root,
    filesDiscovered,
    filesAnalyzed,
    proseAnalyzed,
    symbols,
    prose,
    skipped,
    totalsReading: "execution_unit",
    totals,
  };
}

/**
 * Metriken je Scope einer Datei.
 *
 * Der INKLUSIVE Wert wird berichtet: der Wert eines Symbols einschliesslich
 * seiner verschachtelten Scopes. Das ist die Zahl, die zur Frage „wie schwer
 * ist diese Funktion zu lesen?" passt — der Leser liest die inneren Scopes ja
 * mit. Fuer cyclomatic wird die erweiterte Variante genommen (spec.md §16.3).
 */
function symbolsOfFile(
  adapter: LanguageAdapter,
  ast: ParsedAst,
  relativePath: string,
): { symbols: SymbolEntry[]; executionUnitRoots: number; cognitive: number; cyclomatic: number } {
  const repaired = withUniqueScopeIds(
    adapter.computeComplexity(ast),
    adapter.extractCalls(ast),
    relativePath,
  );
  const facts = repaired.facts;
  const calls = repaired.calls;

  const out: SymbolEntry[] = [];
  const cognitive: ScopeMetricNodeV1[] = [];
  const cyclomatic: ScopeMetricNodeV1[] = [];
  for (const scope of facts.symbolScopes) {
    const id = scope.symbolScopeId;
    const inclusiveIr = buildSymbolIR(facts, id, { calls });
    const subtreeFacts = {
      ...facts,
      decisions: facts.decisions.filter((decision) => containsRange(scope.range, decision.range)),
    };
    const ownFacts = selectSymbolFacts(facts, id);
    const ownIr = buildSymbolIR(ownFacts, id, { calls });
    const shared = {
      metricsScopeId: id,
      executionUnit: EXECUTION_UNIT_KINDS.has(scope.kind),
      ...(scope.parentScopeId === undefined ? {} : { parentScopeId: scope.parentScopeId }),
    };
    const inclusiveCognitive =
      inclusiveIr === undefined ? 0 : computeCognitive(inclusiveIr, COGNITIVE_ALGORITHM_ID).value;
    const inclusiveCyclomatic = computeCyclomatic(
      subtreeFacts,
      scope.range.startLine,
      METRICS_VERSION,
    ).extended;
    cognitive.push({
      ...shared,
      inclusiveValue: inclusiveCognitive,
      selfValue: ownIr === undefined ? 0 : computeCognitive(ownIr, COGNITIVE_ALGORITHM_ID).value,
    });
    cyclomatic.push({
      ...shared,
      inclusiveValue: inclusiveCyclomatic,
      selfValue: computeCyclomatic(ownFacts, scope.range.startLine, METRICS_VERSION).extended,
    });
    out.push({
      filePath: relativePath,
      name: scope.qualifiedName || scope.name || `(${scope.kind})`,
      kind: scope.kind,
      line: scope.range.startLine,
      executionUnit: EXECUTION_UNIT_KINDS.has(scope.kind),
      cognitive: inclusiveCognitive,
      cyclomatic: inclusiveCyclomatic,
      sloc: Math.max(1, scope.range.endLine - scope.range.startLine + 1),
    });
  }
  const cognitiveTotals = aggregateScopeTree(cognitive);
  const cyclomaticTotals = aggregateScopeTree(cyclomatic, { perScopeBase: 1 });
  return {
    symbols: out,
    executionUnitRoots: cognitiveTotals.executionUnitRootCount,
    cognitive: cognitiveTotals.executionUnitSum,
    cyclomatic: cyclomaticTotals.executionUnitSum,
  };
}

/**
 * Der Scanner kennt eigene Ausschlussgruende; der Ledger kennt seine eigenen.
 * Diese Abbildung ist die Uebersetzung — sie wirft nichts weg, sie benennt es
 * nur in der Sprache des Ledgers.
 */
function scannerSkipReason(reason: string): SkipReason {
  switch (reason) {
    case "binary":
      return "binary_content";
    case "size-limit":
      return "file_too_large";
    case "unreadable":
      return "provider_unavailable";
    default:
      // config-exclude, untangleignore, gitignore, default-exclude, security,
      // symlink-cycle, symlink-escape
      return "excluded_by_configuration";
  }
}
