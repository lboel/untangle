/**
 * Die Messung einer Datei — die Stelle, an der parser-registry, chunker und
 * complexity zu EINER Messung zusammenlaufen.
 *
 * Der Weg einer Datei durch dieses Modul:
 *
 *   Inhalt
 *     -> `ParserRegistry.getAdapterForPath` (parser-registry)
 *     -> `adapter.parse` / `extractChunks` / `extractSymbols` / `extractCalls`
 *        / `computeComplexity`
 *     -> `chunkFile` (chunker)            .... semantische Ladung
 *     -> `withUniqueScopeIds` (complexity) .... eindeutige metrics_scope_id
 *     -> `computeStructural` / `computeCyclomatic` / `computeCognitive`
 *     -> `checkScopeTreeInvariants` + `checkAllScopeCoverage`
 *     -> `aggregateScopeTree` / `selectScopeEntries` (scope-aggregate)
 *
 * ## Die vier Metriken (vision.md §1b)
 *
 * DREI davon sind Scope-Metriken und werden ueber `metrics_scope_id`
 * aggregiert, ohne Doppelzaehlung — die ausgewiesene Zahl ist die Lesart
 * `"execution_unit"` aus `packages/complexity/src/scope-aggregate.ts`: jede
 * aeusserste Ausfuehrungseinheit genau einmal, verschachtelte Closures darin
 * enthalten.
 *
 * - `cognitive`  — `computeCognitive` ueber die IR (`untangle-cognitive-v1`,
 *   spec.md §16.4).
 * - `cyclomatic` — `computeCyclomatic(...).extended` (spec.md §16.3).
 * - `structural` — `parameter_count + return_count + exit_point_count` aus
 *   `computeStructural` (spec.md §16.5). WARUM GENAU DIESE DREI: die Lesarten
 *   der Scope-Aggregation SUMMIEREN. Summierbar und ueberschneidungsfrei
 *   zerlegbar sind von den strukturellen Metriken nur die zaehlenden; `sloc`
 *   und `max_nesting` sind es nicht (`sloc` eines Elternscopes enthaelt die
 *   Zeilen seiner Kinder, `max_nesting` ist ein Maximum, keine Summe) — sie
 *   waeren als Summe entweder doppelt gezaehlt oder bedeutungslos. Die drei
 *   gewaehlten zaehlen die strukturelle Oberflaeche eines Scopes: wie viele
 *   Groessen hineingehen und wie viele Wege hinausfuehren.
 *
 * DIE VIERTE ist bewusst KEINE Scope-Metrik:
 *
 * - `semantic` — die semantische Ladung der Datei: die Summe der
 *   Token-Schaetzungen ueber alle Chunks, die der chunker fuer die Datei
 *   erzeugt (`CodeChunkDraft.tokenEstimate`, architecture.md §14.4).
 *   Sie beantwortet "wie viel Kontext muss geladen werden, um diese Datei zu
 *   verstehen" und faellt genau dann, wenn dieselbe Aussage mit weniger
 *   Bedeutungseinheiten auskommt (vision.md §1d). Sie wird ueber CHUNKS
 *   summiert, nicht ueber Scopes; deshalb traegt sie die Lesart
 *   `"file_chunks"` und niemals `"execution_unit"`.
 *
 *   OFFEN GESAGT: spec.md §16 kennt keine Metrik "semantisch". Dies ist eine
 *   untangle-lokale Lesart mit ausgewiesener Herkunft, keine
 *   Spezifikationsmetrik — sie wird als solche benannt und nicht als §16-Wert
 *   ausgegeben.
 *
 * ## Warum eine Messung scheitern DARF
 *
 * Jeder Fehlschlag endet als `SkipLedgerEntryV1` mit Grund und Detailtext,
 * nie als stiller `continue` (E4). Insbesondere geht eine Datei mit
 * `parseQuality !== "complete"` NICHT in die Zahlen ein: ein beschaedigter
 * Syntaxbaum liefert nachweislich falsche Scope-Grenzen (siehe
 * `scripts/complexity-report.mjs`, Kopfkommentar Punkt 5). Sie erscheint
 * stattdessen als `unanalyzed`-Ereignis im Strom.
 */
import { chunkFile } from "@untangle-code/chunker";
import {
  buildSymbolIR,
  checkAllScopeCoverage,
  checkScopeTreeInvariants,
  computeCognitive,
  computeCyclomatic,
  computeStructural,
  containsRange,
  selectScopeEntries,
  selectSymbolFacts,
  withUniqueScopeIds,
  type ScopeInvariantViolationV1,
  type ScopeMetricNodeV1,
} from "@untangle-code/complexity";
import {
  buildSkipLedgerEntry,
  classifyAdapterFailure,
  classifyTextFormat,
  compareCodepoints,
  COGNITIVE_ALGORITHM_ID,
  METRICS_VERSION,
  sha256Hex,
  type ComplexityFacts,
  type ParseQuality,
  type ParserRegistry,
  type SkipLedgerEntryV1,
} from "@untangle-code/domain";

import { METRIC_KEYS, zeroMetricValues, type MetricKey, type MetricValues } from "./events.js";

/**
 * Scope-Arten, die eine eigene Ausfuehrungseinheit sind.
 * `SymbolScopeFact.kind` ist ein adapterspezifischer String;
 * `packages/complexity` kennt bewusst keine Sprach-Taxonomie, die Zuordnung
 * trifft deshalb der Aufrufer (siehe `ScopeMetricNodeV1.executionUnit`).
 * Identisch zu `scripts/complexity-report.mjs`, damit Waechter und Report
 * dieselbe Zahl meinen.
 */
const EXECUTION_UNIT_KINDS = new Set(["function", "method", "constructor", "lambda"]);

/** Ein gemessener Scope, so wie ihn der Waechter zwischen zwei Staenden vergleicht. */
export interface ScopeReadingV1 {
  /** `metrics_scope_id` (spec.md §16.10) — eindeutig INNERHALB dieser Messung. */
  metricsScopeId: string;
  /**
   * Schluessel fuer den Vergleich ZWISCHEN zwei Messungen.
   *
   * WARUM NICHT `metricsScopeId`: `withUniqueScopeIds` bildet die eindeutige
   * Id aus der Byte-Range des Scopes. Das ist innerhalb einer Messung genau
   * richtig und ueber zwei Messungen hinweg unbrauchbar — schon eine
   * eingefuegte Zeile verschiebt jede Range und damit jede Id, und der
   * Waechter meldete dann fuer jede Aenderung "alle Scopes weg, alle Scopes
   * neu". Der Vergleichsschluessel ist deshalb die urspruengliche
   * Adapter-Id (qualifizierter Name plus Ordinal) plus ein Ordinal fuer den
   * Fall, dass der Adapter dieselbe Id mehrfach vergeben hat.
   */
  matchKey: string;
  label: string;
  kind: string;
  line: number;
  /** Wert je Metrik in der Lesart `"execution_unit"`; nur ausgewaehlte Scopes haben einen. */
  values: MetricValues;
  /** True, wenn dieser Scope in der Lesart `"execution_unit"` ein Summand ist. */
  selected: boolean;
}

/** Das Messergebnis EINER Datei. */
export interface FileReadingV1 {
  path: string;
  languageId: string;
  contentHash: string;
  parseQuality: ParseQuality;
  totals: MetricValues;
  scopes: ScopeReadingV1[];
  /** Anzahl der Chunks, in die der chunker die Datei zerlegt. */
  chunkUnits: number;
  /** Wie viele davon `symbol_fragment` sind: ein Symbol passte nicht in einen Chunk. */
  chunkFragments: number;
  scopeCount: number;
  scopeIdCollisions: number;
  nodeKindFallbacks: number;
  /** Einschraenkungen dieser Messung im Klartext; leer heisst: keine. */
  notes: string[];
}

export type AnalysisOutcomeV1 =
  { ok: true; reading: FileReadingV1 } | { ok: false; entry: SkipLedgerEntryV1 };

export interface FileAnalyzerOptions {
  registry: ParserRegistry;
  repoId: string;
  refId: string;
  workspaceId: string;
  /** Menschenlesbares Ref-Label fuer den Chunker-Kopf (spec.md §8.6). */
  refName: string;
  repoLabel: string;
}

/**
 * Baut den Analysator EINMAL (die Grammatiken laden faul beim ersten
 * `parse()`) und liefert eine reine Funktion `analyze(path, content)`.
 */
export function createFileAnalyzer(
  options: FileAnalyzerOptions,
): (relativePath: string, content: string) => AnalysisOutcomeV1 {
  return (relativePath, content) => analyzeFile(options, relativePath, content);
}

function skip(
  relativePath: string,
  reason: SkipLedgerEntryV1["reason"],
  stage: SkipLedgerEntryV1["stage"],
  detail: string,
  recoverable: boolean,
): AnalysisOutcomeV1 {
  return {
    ok: false,
    entry: buildSkipLedgerEntry({
      stage,
      subjectKind: "file",
      path: relativePath,
      reason,
      detail,
      recoverable,
    }),
  };
}

function analyzeFile(
  options: FileAnalyzerOptions,
  relativePath: string,
  content: string,
): AnalysisOutcomeV1 {
  const adapter = options.registry.getAdapterForPath(relativePath);
  if (adapter === null) {
    return skip(
      relativePath,
      "unsupported_language",
      "parse",
      `No language adapter is registered for "${relativePath}"; the file contributes to no ` +
        `complexity measurement and its change produces no delta.`,
      false,
    );
  }

  if (classifyTextFormat(relativePath) === "generated") {
    return skip(
      relativePath,
      "generated_content",
      "parse",
      `"${relativePath}" is generated content (such as a lockfile). It contains no ` +
        `authored statement; its change produces no delta.`,
      false,
    );
  }

  // WP-217: Stufe `text` hat keine Scopes und keine Entscheidungspunkte. Die
  // vier Metriken dieses Moduls (cognitive, cyclomatic, structural, semantic)
  // sind Code-Metriken; sie auf ein Dokument anzuwenden ergaebe vier Nullen,
  // die wie eine Messung aussehen. Der Watcher sagt deshalb, was er NICHT
  // gerechnet hat — samt der Stelle, an der es gerechnet wird.
  if (adapter.supportLevel === "text") {
    const prose = classifyTextFormat(relativePath) === "prose";
    return skip(
      relativePath,
      "no_metric_defined",
      "parse",
      prose
        ? `"${relativePath}" is prose (tier "text"). Prose metrics are defined and ` +
            `computed by "untangle complexity --prose"; this watcher path does not compute ` +
            `them yet. Cognitive, cyclomatic and structural metrics would show zeros ` +
            `that could be mistaken for measurements; this note is emitted ` +
            `instead of a delta.`
        : `"${relativePath}" is structured configuration (tier "text"): supported ` +
            `for chunks and search, but without control flow or section structure. ` +
            `Neither a code metric nor a prose metric is defined for it.`,
      false,
    );
  }

  const contentHash = sha256Hex(content);
  const source = {
    fileId: relativePath,
    repoId: options.repoId,
    refId: options.refId,
    path: relativePath,
    languageId: adapter.languageId,
    content,
    contentHash,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };

  let parseResult;
  try {
    parseResult = adapter.parse(source);
  } catch (error) {
    // WP-216: benannter Grund statt durchgereichtem Ausnahmetext (E4).
    const failure = classifyAdapterFailure(error, { sizeBytes: source.sizeBytes });
    return skip(
      relativePath,
      failure.reason,
      "parse",
      `Adapter "${adapter.languageId}": ${failure.detail}`,
      failure.recoverable,
    );
  }

  if (parseResult.ast === null) {
    return skip(
      relativePath,
      "parse_failed",
      "parse",
      `parseQuality="${parseResult.parseQuality}" has no syntax tree; no facts can be derived.`,
      false,
    );
  }

  if (parseResult.parseQuality !== "complete") {
    const damagedBytes = parseResult.diagnostics.reduce(
      (sum, diagnostic) => sum + (diagnostic.range.endByte - diagnostic.range.startByte),
      0,
    );
    return skip(
      relativePath,
      "parse_failed",
      "parse",
      `parseQuality="${parseResult.parseQuality}": ${String(parseResult.errorNodeCount)} ` +
        `error nodes and ${String(parseResult.missingNodeCount)} missing nodes ` +
        `(${String(damagedBytes)} of ${String(source.sizeBytes)} bytes fall below ` +
        `error nodes). Scope boundaries and decision points would be unreliable; ` +
        `the file therefore contributes to no measurement rather than silently distorting deltas.`,
      true,
    );
  }

  const ast = parseResult.ast;
  let rawFacts: ComplexityFacts;
  let regions;
  let symbols;
  let rawCalls;
  try {
    regions = adapter.extractChunks(ast);
    symbols = adapter.extractSymbols(ast);
    rawCalls = adapter.extractCalls(ast);
    rawFacts = adapter.computeComplexity(ast);
  } catch (error) {
    return skip(
      relativePath,
      "parse_failed",
      "parse",
      `The adapter for "${adapter.languageId}" failed while evaluating the syntax tree: ` +
        `geworfen: ${messageOf(error)}`,
      false,
    );
  }

  // --- semantische Ladung: der chunker ---------------------------------
  let chunkResult;
  try {
    chunkResult = chunkFile({
      identity: {
        workspaceId: options.workspaceId,
        repoId: options.repoId,
        refId: options.refId,
        fileId: relativePath,
        filePath: relativePath,
        languageId: adapter.languageId,
      },
      content,
      parseResult,
      regions,
      symbols,
      config: {
        preparedText: {
          documentPrefix: "search_document:",
          repoLabel: options.repoLabel,
          refName: options.refName,
        },
      },
    });
  } catch (error) {
    return skip(
      relativePath,
      "parse_failed",
      "chunk",
      `The chunker failed: ${messageOf(error)}`,
      false,
    );
  }

  const notes: string[] = parseResult.diagnostics
    .filter((diagnostic) => diagnostic.code === "analysis_scope_limited")
    .map((diagnostic) => diagnostic.message);
  for (const degradation of chunkResult.degradations) {
    notes.push(
      `Chunker fallback (${degradation.reason}, strategy "${degradation.strategy}"): ` +
        degradation.detail,
    );
  }

  const semantic = chunkResult.drafts.reduce((sum, draft) => sum + draft.tokenEstimate, 0);
  const chunkFragments = chunkResult.drafts.filter(
    (draft) => draft.chunkKind === "symbol_fragment",
  ).length;

  // --- Scope-Metriken: complexity ---------------------------------------
  const repaired = withUniqueScopeIds(rawFacts, rawCalls, relativePath);
  const facts = repaired.facts;
  const calls = repaired.calls;

  if (repaired.collisions.length > 0) {
    const scopes = repaired.collisions.reduce((sum, c) => sum + c.scopeCount, 0);
    notes.push(
      `${String(repaired.collisions.length)} ambiguous adapter scope ID(s) across ` +
        `${String(scopes)} scopes remapped to unique metrics_scope_id values (WP-82).`,
    );
  }
  if (repaired.nodeKindsAttributedByFallback > 0) {
    notes.push(
      `${String(repaired.nodeKindsAttributedByFallback)} NodeKindFact(s) without SourceRange ` +
        `could only be assigned through a fallback; this file's structural metric ` +
        `therefore has only approximate scope precision.`,
    );
  }

  const subtreeIds = subtreeIdsOf(facts);
  const perMetricNodes: Record<Exclude<MetricKey, "semantic">, ScopeMetricNodeV1[]> = {
    structural: [],
    cyclomatic: [],
    cognitive: [],
  };
  const meta = new Map<string, { matchKey: string; label: string; kind: string; line: number }>();
  const matchOrdinals = new Map<string, number>();

  for (const scope of facts.symbolScopes) {
    const id = scope.symbolScopeId;
    const ownFacts = selectSymbolFacts(facts, id);
    const ids = subtreeIds.get(id) ?? new Set([id]);
    const shared = {
      metricsScopeId: id,
      executionUnit: EXECUTION_UNIT_KINDS.has(scope.kind),
      sloc: Math.max(1, scope.range.endLine - scope.range.startLine + 1),
      ...(scope.parentScopeId === undefined ? {} : { parentScopeId: scope.parentScopeId }),
    };

    // cognitive: derselbe Calculator, einmal auf den ungefilterten Datei-Facts
    // (der IR-Builder zieht alle Nachfahren hinein) und einmal auf den
    // eigenen Facts des Scopes.
    const inclusiveIr = buildSymbolIR(facts, id, { calls });
    const ownIr = buildSymbolIR(ownFacts, id, { calls });
    perMetricNodes.cognitive.push({
      ...shared,
      inclusiveValue:
        inclusiveIr === undefined ? 0 : computeCognitive(inclusiveIr, COGNITIVE_ALGORITHM_ID).value,
      selfValue: ownIr === undefined ? 0 : computeCognitive(ownIr, COGNITIVE_ALGORITHM_ID).value,
    });

    // cyclomatic: Entscheidungspunkte des Scopes UND aller Nachfahren
    // (Byte-Containment), damit "inclusive" dasselbe bedeutet wie bei cognitive.
    const subtreeDecisionFacts: ComplexityFacts = {
      ...facts,
      decisions: facts.decisions.filter((d) => containsRange(scope.range, d.range)),
    };
    perMetricNodes.cyclomatic.push({
      ...shared,
      inclusiveValue: computeCyclomatic(
        subtreeDecisionFacts,
        scope.range.startLine,
        METRICS_VERSION,
      ).extended,
      selfValue: computeCyclomatic(ownFacts, scope.range.startLine, METRICS_VERSION).extended,
    });

    // structural: die zaehlenden Metriken aus §16.5. `NodeKindFact`s tragen
    // eine `symbolScopeId`, also ist die Zerlegung ueber die Scope-Ids des
    // Teilbaums exakt: inclusive = self + Summe der Kinder, per Konstruktion.
    const subtreeNodeKindFacts: ComplexityFacts = {
      ...facts,
      nodeKinds: facts.nodeKinds.filter((fact) => ids.has(fact.symbolScopeId)),
    };
    perMetricNodes.structural.push({
      ...shared,
      inclusiveValue: structuralLoad(subtreeNodeKindFacts, content, scope.range),
      selfValue: structuralLoad(ownFacts, content, scope.range),
    });

    const adapterId = repaired.originalScopeIds.get(id) ?? id;
    const ordinal = matchOrdinals.get(adapterId) ?? 0;
    matchOrdinals.set(adapterId, ordinal + 1);
    meta.set(id, {
      matchKey: `${adapterId}#${String(ordinal)}`,
      label: scope.qualifiedName || scope.name || `(${scope.kind})`,
      kind: scope.kind,
      line: scope.range.startLine,
    });
  }

  // --- Invarianten: erst pruefen, dann summieren ------------------------
  const violations: ScopeInvariantViolationV1[] = [];
  for (const metric of ["structural", "cyclomatic", "cognitive"] as const) {
    const nodes = perMetricNodes[metric];
    violations.push(...checkScopeTreeInvariants(nodes, treeOptionsFor(metric)));
    violations.push(...checkAllScopeCoverage(nodes));
  }
  if (violations.length > 0) {
    const first = violations
      .slice()
      .sort((a, b) => compareCodepoints(a.metricsScopeId, b.metricsScopeId))
      .slice(0, 3)
      .map((v) => `${v.code} @ ${v.metricsScopeId}: ${v.detail}`)
      .join(" | ");
    return skip(
      relativePath,
      "parse_failed",
      "parse",
      `${String(violations.length)} invariant violation(s) in the scope tree; a total ` +
        `over an inconsistent tree would be meaningless. First: ${first}`,
      false,
    );
  }

  const totals: Record<MetricKey, number> = { ...zeroMetricValues(), semantic };
  const selectedValues = new Map<string, Record<MetricKey, number>>();
  for (const metric of ["structural", "cyclomatic", "cognitive"] as const) {
    const entries = selectScopeEntries(perMetricNodes[metric], "execution_unit");
    let sum = 0;
    for (const entry of entries) {
      sum += entry.value;
      const bucket = selectedValues.get(entry.metricsScopeId) ?? { ...zeroMetricValues() };
      bucket[metric] = entry.value;
      selectedValues.set(entry.metricsScopeId, bucket);
    }
    totals[metric] = sum;
  }

  const scopes: ScopeReadingV1[] = [];
  for (const [id, info] of meta) {
    const values = selectedValues.get(id);
    scopes.push({
      metricsScopeId: id,
      matchKey: info.matchKey,
      label: info.label,
      kind: info.kind,
      line: info.line,
      values: values ?? zeroMetricValues(),
      selected: values !== undefined,
    });
  }
  scopes.sort((a, b) => compareCodepoints(a.matchKey, b.matchKey));

  return {
    ok: true,
    reading: {
      path: relativePath,
      languageId: adapter.languageId,
      contentHash,
      parseQuality: parseResult.parseQuality,
      totals,
      scopes,
      chunkUnits: chunkResult.drafts.length,
      chunkFragments,
      scopeCount: facts.symbolScopes.length,
      scopeIdCollisions: repaired.collisions.length,
      nodeKindFallbacks: repaired.nodeKindsAttributedByFallback,
      notes,
    },
  };
}

/**
 * `perScopeBase` je Metrik. `computeCyclomatic` legt IMMER den
 * `M = 1 + decision_points`-Sockel an; ohne diese Angabe meldete die
 * Eltern/Kind-Pruefung Scheinverstoesse, sobald ein Scope mehr als ein Kind
 * hat (siehe `ScopeTreeOptions.perScopeBase`).
 */
function treeOptionsFor(metric: "structural" | "cyclomatic" | "cognitive"): {
  perScopeBase: number;
} {
  return { perScopeBase: metric === "cyclomatic" ? 1 : 0 };
}

/**
 * Die strukturelle Last eines Scopes: `parameter_count + return_count +
 * exit_point_count` aus `computeStructural` (spec.md §16.5) — siehe
 * Modul-Doku fuer die Begruendung, warum genau diese drei.
 */
function structuralLoad(
  facts: ComplexityFacts,
  content: string,
  range: { startLine: number; endLine: number; startByte: number; endByte: number },
): number {
  const metrics = computeStructural(facts, content, range).metrics;
  return (
    (metrics["parameter_count"] ?? 0) +
    (metrics["return_count"] ?? 0) +
    (metrics["exit_point_count"] ?? 0)
  );
}

/**
 * Fuer jeden Scope die Menge seiner eigenen Id plus aller Nachfahren-Ids.
 * Die Elternkette ist nach `checkScopeTreeInvariants` zyklenfrei; hier wird
 * trotzdem gegen Zyklen abgesichert, weil diese Funktion VOR der Pruefung
 * laeuft.
 */
function subtreeIdsOf(facts: ComplexityFacts): Map<string, Set<string>> {
  const children = new Map<string, string[]>();
  const all: string[] = [];
  for (const scope of facts.symbolScopes) {
    all.push(scope.symbolScopeId);
    const parent = scope.parentScopeId;
    if (parent === undefined) continue;
    const bucket = children.get(parent) ?? [];
    bucket.push(scope.symbolScopeId);
    children.set(parent, bucket);
  }
  const result = new Map<string, Set<string>>();
  for (const id of all) {
    const collected = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (collected.has(current)) continue;
      collected.add(current);
      for (const child of children.get(current) ?? []) stack.push(child);
    }
    result.set(id, collected);
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Die Metrik-Reihenfolge, an die sich jede Darstellung haelt. */
export const ORDERED_METRICS: readonly MetricKey[] = METRIC_KEYS;
