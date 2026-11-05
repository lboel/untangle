/**
 * Stufen 4 und 5 des Indexlaufs (spec.md §11.1 `parsing_and_chunking`,
 * `computing_metrics`): eine Datei lesen, parsen, verlustfrei chunken, messen
 * und die vorbereiteten Texte bauen.
 *
 * VIER ENTSCHEIDUNGEN, DIE MAN KENNEN MUSS:
 *
 * 1. EINE DATEI OHNE SPRACHADAPTER WIRD TROTZDEM INDIZIERT — als Zeilenfenster
 *    ohne Symbole. Markdown, YAML und Konfiguration sind der groesste Teil des
 *    Kontexts, den ein Mensch sucht; sie stumm fallen zu lassen waere der
 *    teuerste stille Verlust im ganzen Produkt. Dass dabei die Symbolstruktur
 *    fehlt, ist eine ABSTUFUNG und steht als solche im Ledger (E4).
 * 2. EIN BESCHAEDIGTER SYNTAXBAUM VERHINDERT DIE INDIZIERUNG NICHT. Der
 *    Chunker faellt auf Zeilenfenster zurueck und meldet das; die Datei bleibt
 *    auffindbar. Anders als bei `untangle complexity` ist das hier richtig:
 *    dort verfaelscht ein kaputter Baum eine RANGLISTE, hier fehlt nur die
 *    Symbolzuordnung eines Treffers.
 * 3. DIE VERLUSTFREIHEIT WIRD GEPRUEFT, NICHT GEGLAUBT. `validateCoverage`
 *    laeuft ueber jedes Chunk-Ergebnis; eine Luecke wird gemeldet, nicht
 *    ueberschrieben (spec.md §8.4).
 * 4. METRIKEN GEHEN NUR AUS EINEM VOLLSTAENDIGEN BAUM IN DIE PAYLOADS. Bei
 *    `parseQuality !== "complete"` sind Scope-Grenzen nicht belastbar; die
 *    Metrikfelder bleiben dann leer statt falsch (spec.md §16.1).
 */
import { Buffer } from "node:buffer";

import {
  buildPreparedDenseTextForDraft,
  chunkFile,
  resolveChunkerConfig,
  type ChunkerConfig,
  type ChunkFileResult,
} from "@untangle-code/chunker";
import {
  buildSymbolIR,
  computeCognitive,
  computeCyclomatic,
  containsRange,
  withUniqueScopeIds,
} from "@untangle-code/complexity";
import {
  buildChunkCacheKey,
  buildMetricsCacheKey,
  buildParseCacheKey,
  buildSymbolId,
  canonicalJson,
  CHUNKER_VERSION,
  compareCodepoints,
  classifyAdapterFailure,
  COGNITIVE_ALGORITHM_ID,
  METRICS_VERSION,
  PARSER_VERSION,
  parserVersionForLanguage,
  sha256Hex,
  UntangleError,
  validateCoverage,
  type AnalysisIdentityKeyPartsV1,
  type AstRegion,
  type CodeChunkDraft,
  type CodeChunkPayloadV1,
  type ExtractedSymbol,
  type FileSystemPort,
  type LanguageAdapter,
  type ParseDiagnostic,
  type ParsedAst,
  type ParserRegistry,
  type ParseQuality,
  type ParseResult,
  type PortCallOptions,
  type RawCall,
  type RawImport,
  type SourceRange,
} from "@untangle-code/domain";
import type {
  AnalysisStage,
  AnalyzedFileV1,
  PlannedFileV1,
  PreparedTextV1,
} from "@untangle-code/jobs";
import { hashBytes } from "@untangle-code/scanner";

import type { AnalysisCollector } from "../collected.js";
import type { SkipCollector, SkipInput } from "../ledger.js";
import type { AnalysisCacheLike, IndexTargetV1 } from "../types.js";

import type { DiscoveryStateV1 } from "./discovery.js";

/** Metriken eines Symbols, so wie sie in ein Chunk-Payload gehen. */
interface ScopeMetrics {
  cyclomaticClassic: number;
  cyclomaticExtended: number;
  cognitive: number;
  sloc: number;
}

export interface AnalysisStageDeps {
  fs: FileSystemPort;
  parsers: ParserRegistry;
  target: IndexTargetV1;
  /** Vom Jobrunner vergebene Generation; beim Analyselauf bereits stabil. */
  generationId: () => string;
  embeddingProfileId: string;
  documentPrefix: string;
  maxChunkTokens: number | undefined;
  ledger: SkipCollector;
  collector: AnalysisCollector;
  discovery: DiscoveryStateV1;
  counts: {
    chunks: number;
    symbols: number;
    analyzed: number;
    parseCacheHits: number;
    parseCacheMisses: number;
    chunkCacheHits: number;
    chunkCacheMisses: number;
    metricsCacheHits: number;
    metricsCacheMisses: number;
  };
  /** Ohne ihn parst, chunkt und misst jede Datei bei jedem Lauf neu (WP-100). */
  cache?: AnalysisCacheLike | undefined;
}

/** Ein Parseergebnis, das ehrlich sagt: hier wurde nicht geparst. */
const TEXT_ONLY_PARSE: ParseResult = {
  parseQuality: "failed",
  ast: null,
  diagnostics: [],
  errorNodeCount: 0,
  missingNodeCount: 0,
};

export function createAnalysisStage(deps: AnalysisStageDeps): AnalysisStage {
  const chunkerConfig: ChunkerConfig = resolveChunkerConfig({
    ...(deps.maxChunkTokens === undefined ? {} : { maxTokensPerChunk: deps.maxChunkTokens }),
    preparedText: {
      documentPrefix: deps.documentPrefix,
      repoLabel: deps.target.repoLabel,
      refName: deps.target.refName,
    },
  });

  /**
   * Fingerabdruck der WIRKSAMEN Chunker-Konfiguration. Er gehoert in den
   * Chunk-Schluessel, weil Token-Budget, Kopfzeilen-Kontext (Repo-Etikett,
   * Refname, Dokumentprefix) und die Minified-Erkennung den Zuschnitt UND den
   * vorbereiteten Text veraendern, ohne die Chunker-Version zu beruehren.
   * `canonicalJson` sortiert die Schluessel, damit der Abdruck nicht von einer
   * Feldreihenfolge abhaengt.
   */
  const chunkConfigFingerprint = sha256Hex(
    canonicalJson(chunkerConfig as unknown as Record<string, unknown>),
  );

  return {
    async analyze(plannedFile: PlannedFileV1, options?: PortCallOptions): Promise<AnalyzedFileV1> {
      const scanned = deps.discovery.scanned.get(plannedFile.fileId);
      if (scanned === undefined) {
        // Kann nur passieren, wenn jemand einen Plan hereinreicht, der nicht
        // aus dieser Entdeckung stammt. Das ist ein Programmierfehler und wird
        // als solcher gemeldet, nicht als leeres Ergebnis verkleidet.
        throw new UntangleError(
          "ANALYSIS_INCOMPLETE",
          `The planned file "${plannedFile.filePath}" is absent from the discovery result.`,
          { operation: "index.analyze", context: { fileId: plannedFile.fileId } },
        );
      }

      if (scanned.contentHash !== plannedFile.contentHash) {
        throw new UntangleError(
          "ANALYSIS_INCOMPLETE",
          `The analysis plan for "${plannedFile.filePath}" does not match the discovery result.`,
          {
            retryable: false,
            operation: "index.analyze.verify_source",
            context: {
              fileId: plannedFile.fileId,
              plannedContentHash: plannedFile.contentHash,
              discoveredContentHash: scanned.contentHash,
            },
          },
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.fs.readFile(scanned.absolutePath, options);
      } catch (error) {
        deps.ledger.add({
          stage: "parse",
          subjectKind: "file",
          subjectId: plannedFile.fileId,
          path: plannedFile.filePath,
          repoId: deps.target.repoId,
          refId: deps.target.refId,
          reason: "provider_unavailable",
          detail: `Could not read the file: ${messageOf(error)}`,
          recoverable: true,
        });
        throw new UntangleError(
          "ANALYSIS_INCOMPLETE",
          `File "${plannedFile.filePath}" could not be read again after discovery; this run cannot be confirmed as complete.`,
          {
            retryable: true,
            operation: "index.analyze.verify_source",
            context: { fileId: plannedFile.fileId, filePath: plannedFile.filePath },
            cause: error,
          },
        );
      }

      const verifiedContentHash = hashBytes(bytes);
      if (verifiedContentHash !== plannedFile.contentHash) {
        throw new UntangleError(
          "ANALYSIS_INCOMPLETE",
          `File "${plannedFile.filePath}" changed after discovery; rerun with a new scan.`,
          {
            retryable: true,
            operation: "index.analyze.verify_source",
            context: {
              fileId: plannedFile.fileId,
              filePath: plannedFile.filePath,
              expectedContentHash: plannedFile.contentHash,
              actualContentHash: verifiedContentHash,
            },
          },
        );
      }

      // Ab hier ist `file.contentHash` nicht mehr bloss eine Behauptung des
      // Scans, sondern der Hash genau der Bytes, aus denen Cache-Schluessel,
      // Analyse, Payloads, Manifeste und der Corpus-Fingerprint entstehen.
      const file: PlannedFileV1 = { ...plannedFile, contentHash: verifiedContentHash };
      const content = Buffer.from(bytes).toString("utf8");

      const adapter = deps.parsers.getAdapterForPath(file.filePath, content.slice(0, 4096));
      const languageId = adapter === null ? scanned.languageId : adapter.languageId;

      /* ---------------- WP-100: die drei Zwischenspeicher ---------------- */

      const cache = deps.cache;
      const identity: AnalysisIdentityKeyPartsV1 = {
        workspaceId: deps.target.workspaceId,
        repoId: deps.target.repoId,
        refId: deps.target.refId,
        fileId: file.fileId,
        filePath: file.filePath,
        languageId,
      };
      /**
       * WP-220: die `parser_version` haengt an der SPRACHE, nicht am Lauf —
       * Go und Rust laufen ueber das ast-grep-Backend und erzeugen damit eine
       * andere AST-Form als der tree-sitter-Weg. Stuende hier weiter die
       * globale Konstante, lieferten alle drei Caches nach einem
       * Backendwechsel stillschweigend Werte der alten Form (E4). Fuer jede
       * Sprache ohne eigenen Eintrag ist das Ergebnis unveraendert
       * `PARSER_VERSION` — bestehende Indizes bleiben damit gueltig.
       */
      const parserVersion = parserVersionForLanguage(languageId);
      const parseKey = buildParseCacheKey({
        contentHash: file.contentHash,
        parserVersion,
        identity,
      });
      const metricsKey = buildMetricsCacheKey({
        contentHash: file.contentHash,
        metricsVersion: METRICS_VERSION,
        parserVersion,
        cognitiveAlgorithmId: COGNITIVE_ALGORITHM_ID,
        identity,
      });
      const chunkKey = buildChunkCacheKey({
        contentHash: file.contentHash,
        chunkerVersion: CHUNKER_VERSION,
        parserVersion,
        configFingerprint: chunkConfigFingerprint,
        identity,
      });

      const cachedParse =
        cache === undefined ? null : readParseEntry(await cache.get("parse", parseKey, options));
      const cachedMetrics =
        cache === undefined
          ? null
          : readMetricsEntry(await cache.get("metrics", metricsKey, options));
      if (cache !== undefined) {
        if (cachedParse === null) deps.counts.parseCacheMisses++;
        else deps.counts.parseCacheHits++;
        if (cachedMetrics === null) deps.counts.metricsCacheMisses++;
        else deps.counts.metricsCacheHits++;
      }

      let parseResult: ParseResult;
      let regions: AstRegion[];
      let symbols: ExtractedSymbol[];
      let imports: RawImport[];
      let calls: RawCall[];
      let importsMissingReason: string | undefined;
      let metricsByFqn: Map<string, ScopeMetrics>;

      // BEIDE ODER KEINER: Die Metriken brauchen den Syntaxbaum, und ein Baum
      // ist nicht ablegbar (`ParsedAst.root` gehoert dem Adapter). Fehlt der
      // Metrikeintrag, muss ohnehin geparst werden — dann waere es eine Luege,
      // den Parse als "aus dem Zwischenspeicher" zu zaehlen. Genau deshalb
      // traegt auch der Metrikschluessel die `parser_version`.
      if (cachedParse !== null && cachedMetrics !== null) {
        parseResult = {
          parseQuality: cachedParse.parseQuality,
          ast: null,
          diagnostics: cachedParse.diagnostics,
          errorNodeCount: cachedParse.errorNodeCount,
          missingNodeCount: cachedParse.missingNodeCount,
        };
        regions = cachedParse.regions;
        symbols = cachedParse.symbols;
        imports = cachedParse.imports;
        calls = cachedParse.calls;
        importsMissingReason = cachedParse.importsMissingReason;
        metricsByFqn = metricsFromEntry(cachedMetrics);
        // Das Ledger MUSS aussehen wie beim Rechnen (E4): jede Abstufung, die
        // der erste Lauf gemeldet hat, meldet auch der zweite. Ein Cache, der
        // Gruende verschluckt, macht Uebersprungenes unsichtbar.
        for (const skip of cachedParse.skips) {
          deps.ledger.add(skip);
        }
      } else {
        const parsed = runParse({
          target: deps.target,
          file,
          adapter,
          content,
          languageId: scanned.languageId,
          sizeBytes: scanned.sizeBytes,
        });
        parseResult = parsed.parseResult;
        regions = parsed.regions;
        symbols = parsed.symbols;
        imports = parsed.imports;
        calls = parsed.calls;
        importsMissingReason = parsed.importsMissingReason;
        metricsByFqn =
          adapter !== null && parseResult.ast !== null && parseResult.parseQuality === "complete"
            ? metricsOf(adapter, parseResult.ast, file.filePath, calls)
            : new Map<string, ScopeMetrics>();
        for (const skip of parsed.skips) {
          deps.ledger.add(skip);
        }
        if (cache !== undefined) {
          await cache.set("parse", parseKey, toParseEntry(parsed), options);
          await cache.set("metrics", metricsKey, toMetricsEntry(metricsByFqn), options);
        }
      }

      const cachedChunk =
        cache === undefined ? null : readChunkEntry(await cache.get("chunk", chunkKey, options));
      if (cache !== undefined) {
        if (cachedChunk === null) deps.counts.chunkCacheMisses++;
        else deps.counts.chunkCacheHits++;
      }

      let chunked: ChunkFileResult;
      if (cachedChunk !== null) {
        chunked = cachedChunk;
      } else {
        chunked = chunkFile({
          identity: {
            workspaceId: deps.target.workspaceId,
            repoId: deps.target.repoId,
            refId: deps.target.refId,
            fileId: file.fileId,
            filePath: file.filePath,
            languageId,
          },
          content,
          parseResult,
          regions,
          symbols,
          ...(scanned.isMinified ? { isMinified: true } : {}),
          config: {
            maxTokensPerChunk: chunkerConfig.maxTokensPerChunk,
            preparedText: chunkerConfig.preparedText,
            // Damit die Version des tatsaechlich gelaufenen Backends auf JEDEM
            // Chunk steht (`parser_version` im Punkt-Payload), nicht die des
            // Laufs.
            parserVersion,
          },
        });
        if (cache !== undefined) {
          await cache.set("chunk", chunkKey, toChunkEntry(chunked), options);
        }
      }

      for (const degradation of chunked.degradations) {
        deps.ledger.add({
          stage: "chunk",
          subjectKind: "file",
          subjectId: file.fileId,
          path: file.filePath,
          reason: degradation.reason === "minified_content" ? "binary_content" : "parse_failed",
          detail: `Chunker-Abstufung "${degradation.reason}" (Strategie ${degradation.strategy}): ${degradation.detail}`,
          recoverable: false,
        });
      }

      // Die Verlustfreiheit wird auch auf dem Cache-Weg GEPRUEFT, nicht
      // geglaubt: `validateCoverage` laeuft ueber das abgelegte Ledger genauso
      // wie ueber ein frisch gerechnetes (spec.md §8.4).
      const coverage = validateCoverage(chunked.coverage, fileRangeOf(content));
      if (!coverage.complete) {
        deps.ledger.add({
          stage: "chunk",
          subjectKind: "file",
          subjectId: file.fileId,
          path: file.filePath,
          reason: "token_budget_exceeded",
          detail:
            `Coverage has gaps: ${String(coverage.gaps.length)} Luecke(n), ` +
            `${String(coverage.issues.length)} finding(s). First finding: ` +
            `${coverage.issues[0]?.message ?? "(none)"}.`,
          recoverable: false,
        });
      }

      const symbolIds = symbols.map((symbol) =>
        buildSymbolId({
          workspaceId: deps.target.workspaceId,
          repoId: deps.target.repoId,
          refId: deps.target.refId,
          relativePath: file.filePath,
          symbolKind: symbol.kind,
          qualifiedName: symbol.qualifiedName,
          normalizedSignature: symbol.normalizedSignature,
        }),
      );

      const preparedTexts: PreparedTextV1[] = [];
      let estimatedBytes = 0;
      const generationId = deps.generationId();
      if (generationId.trim() === "") {
        throw new UntangleError(
          "INDEX_INCOMPLETE",
          `No index generation was assigned to the payloads for "${file.filePath}".`,
          { retryable: false, operation: "index.analyze" },
        );
      }
      for (const draft of chunked.drafts) {
        const payload = payloadOf(draft, {
          target: deps.target,
          fileHash: file.contentHash,
          embeddingProfileId: deps.embeddingProfileId,
          generationId,
          metrics: draft.symbolFqn === undefined ? undefined : metricsByFqn.get(draft.symbolFqn),
        });
        const text = buildPreparedDenseTextForDraft(chunkerConfig.preparedText, draft);
        preparedTexts.push({
          pointId: draft.chunkId,
          text,
          // Der Payload ist ein `CodeChunkPayloadV1`; die Stufenschnittstelle
          // kennt nur `Record<string, unknown>`. Eine flache Kopie ist die
          // ehrliche Umwandlung — sie behaelt jedes Feld und erfindet keines.
          payload: { ...payload } as Record<string, unknown>,
        });
        estimatedBytes += text.length * 2 + draft.content.length * 2;
      }

      deps.collector.put({
        fileId: file.fileId,
        repoId: deps.target.repoId,
        refId: deps.target.refId,
        filePath: file.filePath,
        languageId,
        contentHash: file.contentHash,
        sizeBytes: scanned.sizeBytes,
        parseQuality: chunked.parseQuality,
        content,
        symbols,
        calls,
        imports,
        ...(importsMissingReason === undefined ? {} : { importsMissingReason }),
        chunkIds: chunked.drafts.map((draft) => draft.chunkId),
        symbolIds,
        metricsScopeId: file.fileId,
      });

      deps.counts.chunks += chunked.drafts.length;
      deps.counts.symbols += symbols.length;
      deps.counts.analyzed++;

      return {
        file,
        parseQuality: chunked.parseQuality,
        chunkCount: chunked.drafts.length,
        symbolCount: symbols.length,
        preparedTexts,
        estimatedBytes,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* WP-100: Parsen als eigene Einheit, damit es ueberspringbar wird      */
/* ------------------------------------------------------------------ */

/**
 * Alles, was ein Parsedurchgang hervorbringt — einschliesslich der
 * Ledger-Eintraege.
 *
 * DIE EINTRAEGE GEHOEREN INS ERGEBNIS, nicht direkt ins Ledger: nur so kann
 * ein zweiter Lauf, der den Parse ueberspringt, DIESELBEN Gruende melden. Ein
 * Cache, der die Gruende verschluckt, macht aus einer gemeldeten Abstufung ein
 * stillschweigendes Ueberspringen (E4).
 */
interface ParseOutcomeV1 {
  parseResult: ParseResult;
  regions: AstRegion[];
  symbols: ExtractedSymbol[];
  imports: RawImport[];
  calls: RawCall[];
  importsMissingReason?: string | undefined;
  skips: SkipInput[];
}

/** Parst eine Datei und sammelt jeden Grund, statt ihn sofort zu melden. */
function runParse(input: {
  target: IndexTargetV1;
  file: PlannedFileV1;
  adapter: LanguageAdapter | null;
  content: string;
  /** Sprache aus der Entdeckung — nur fuer die Meldung "kein Adapter". */
  languageId: string;
  sizeBytes: number;
}): ParseOutcomeV1 {
  const { adapter, content, file, target } = input;
  const skips: SkipInput[] = [];

  let parseResult: ParseResult = TEXT_ONLY_PARSE;
  let regions: AstRegion[] = [];
  let symbols: ExtractedSymbol[] = [];
  let imports: RawImport[] = [];
  let calls: RawCall[] = [];
  let importsMissingReason: string | undefined;

  if (adapter === null) {
    importsMissingReason = `No language adapter for "${input.languageId}".`;
    skips.push({
      stage: "parse",
      subjectKind: "file",
      subjectId: file.fileId,
      path: file.filePath,
      repoId: target.repoId,
      refId: target.refId,
      reason: "unsupported_language",
      detail:
        `No language adapter for "${input.languageId}". The file is indexed as ` +
        "line windows and remains discoverable by text, but has " +
        "no symbols, imports or complexity measurements.",
      recoverable: false,
    });
    return { parseResult, regions, symbols, imports, calls, importsMissingReason, skips };
  }

  try {
    parseResult = adapter.parse({
      fileId: file.fileId,
      repoId: target.repoId,
      refId: target.refId,
      path: file.filePath,
      languageId: adapter.languageId,
      content,
      contentHash: file.contentHash,
      sizeBytes: input.sizeBytes,
    });
  } catch (error) {
    // WP-216: der Ausnahmetext des Adapters ist KEIN Grund. Er wird auf einen
    // benannten Grund abgebildet, bevor er ins Ledger geht (E4).
    const failure = classifyAdapterFailure(error, { sizeBytes: input.sizeBytes });
    parseResult = TEXT_ONLY_PARSE;
    importsMissingReason = `${failure.kind}: ${failure.detail}`;
    skips.push({
      stage: "parse",
      subjectKind: "file",
      subjectId: file.fileId,
      path: file.filePath,
      repoId: target.repoId,
      refId: target.refId,
      reason: failure.reason,
      detail: `${failure.detail}; line windows instead of a syntax tree.`,
      recoverable: failure.recoverable,
    });
  }

  const ast = parseResult.ast;
  for (const diagnostic of parseResult.diagnostics) {
    if (diagnostic.code !== "analysis_scope_limited" || diagnostic.range === undefined) continue;
    skips.push({
      stage: "parse",
      subjectKind: "range",
      subjectId: file.fileId,
      path: file.filePath,
      repoId: target.repoId,
      refId: target.refId,
      range: diagnostic.range,
      reason: "no_metric_defined",
      detail: diagnostic.message,
      recoverable: false,
    });
  }
  if (ast === null) {
    importsMissingReason ??= `The parser returned no tree (parseQuality="${parseResult.parseQuality}").`;
    skips.push({
      stage: "parse",
      subjectKind: "file",
      subjectId: file.fileId,
      path: file.filePath,
      repoId: target.repoId,
      refId: target.refId,
      reason: "parse_failed",
      detail:
        `parseQuality="${parseResult.parseQuality}" has no syntax tree; the file is indexed as ` +
        "line windows without symbols or imports.",
      recoverable: true,
    });
    return { parseResult, regions, symbols, imports, calls, importsMissingReason, skips };
  }

  regions = safely(
    () => adapter.extractChunks(ast),
    [],
    (error) => {
      skips.push({
        stage: "chunk",
        subjectKind: "file",
        subjectId: file.fileId,
        path: file.filePath,
        reason: "parse_failed",
        detail: `extractChunks threw: ${messageOf(error)}; line windows instead of AST chunks.`,
        recoverable: false,
      });
    },
  );
  symbols = safely(
    () => adapter.extractSymbols(ast),
    [],
    (error) => {
      skips.push({
        stage: "parse",
        subjectKind: "symbol",
        subjectId: file.fileId,
        path: file.filePath,
        reason: "parse_failed",
        detail: `extractSymbols threw: ${messageOf(error)}; the file will have no symbols.`,
        recoverable: false,
      });
    },
  );
  imports = safely(
    () => adapter.extractImports(ast),
    [],
    (error) => {
      importsMissingReason = `extractImports threw: ${messageOf(error)}`;
      skips.push({
        stage: "file_graph",
        subjectKind: "file",
        subjectId: file.fileId,
        path: file.filePath,
        reason: "parse_failed",
        detail: `extractImports threw: ${messageOf(error)}; the file will have no graph edges.`,
        recoverable: false,
      });
    },
  );
  calls = safely(
    () => adapter.extractCalls(ast),
    [],
    (error) => {
      skips.push({
        stage: "symbol_graph",
        subjectKind: "file",
        subjectId: file.fileId,
        path: file.filePath,
        reason: "parse_failed",
        detail: `extractCalls threw: ${messageOf(error)}; the file will have no call edges.`,
        recoverable: false,
      });
    },
  );

  return { parseResult, regions, symbols, imports, calls, importsMissingReason, skips };
}

/* ------------------------------------------------------------------ */
/* WP-100: Was abgelegt wird, und wie streng es zurueckgelesen wird     */
/* ------------------------------------------------------------------ */

/**
 * WARUM JEDER EINTRAG BEIM LESEN GEPRUEFT WIRD: Auf der Platte kann alles
 * stehen — ein halb geschriebener Eintrag, ein Rest aus einer aelteren
 * Fassung, eine fremde Datei. Ein ungeprueft uebernommener Eintrag waere
 * genau der Fall "Cache liefert ein falsches Ergebnis", und der ist schlimmer
 * als gar kein Cache, weil ihn niemand sieht. Faellt die Pruefung durch, gilt
 * der Eintrag als NICHT vorhanden — der Lauf rechnet, statt zu raten.
 *
 * Die Pruefung ist bewusst FLACH: sie sichert die Form, die dieses Modul
 * anfasst (Anzahl, Art und Vorhandensein der Felder), nicht jedes Blatt tief
 * im Baum. Was den Schluessel ueberlebt hat, stammt aus derselben Version
 * derselben Rechnung.
 */
const PARSE_QUALITIES = new Set<string>(["complete", "partial", "failed"]);
const CHUNK_STRATEGIES = new Set<string>(["ast", "line_fallback", "minified"]);

interface CachedParseEntryV1 {
  v: 1;
  parseQuality: ParseQuality;
  diagnostics: ParseDiagnostic[];
  errorNodeCount: number;
  missingNodeCount: number;
  regions: AstRegion[];
  symbols: ExtractedSymbol[];
  imports: RawImport[];
  calls: RawCall[];
  importsMissingReason?: string;
  skips: SkipInput[];
}

interface CachedChunkEntryV1 {
  v: 1;
  drafts: CodeChunkDraft[];
  coverage: ChunkFileResult["coverage"];
  strategy: ChunkFileResult["strategy"];
  parseQuality: ParseQuality;
  degradations: ChunkFileResult["degradations"];
}

interface CachedMetricsEntryV1 {
  v: 1;
  entries: { fqn: string; metrics: ScopeMetrics }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isVersionOne(record: Record<string, unknown>): boolean {
  return record["v"] === 1;
}

function isSkipInput(value: unknown): boolean {
  const record = asRecord(value);
  if (record !== null && record["range"] !== undefined) {
    const range = asRecord(record["range"]);
    if (
      range === null ||
      !["startByte", "endByte", "startLine", "endLine"].every((key) =>
        Number.isInteger(range[key]),
      ) ||
      (range["startByte"] as number) < 0 ||
      (range["endByte"] as number) < (range["startByte"] as number) ||
      (range["startLine"] as number) < 1 ||
      (range["endLine"] as number) < (range["startLine"] as number)
    )
      return false;
  }
  return (
    record !== null &&
    typeof record["stage"] === "string" &&
    typeof record["subjectKind"] === "string" &&
    typeof record["reason"] === "string" &&
    typeof record["detail"] === "string" &&
    typeof record["recoverable"] === "boolean"
  );
}

export function toParseEntry(outcome: ParseOutcomeV1): CachedParseEntryV1 {
  return {
    v: 1,
    parseQuality: outcome.parseResult.parseQuality,
    diagnostics: outcome.parseResult.diagnostics,
    errorNodeCount: outcome.parseResult.errorNodeCount,
    missingNodeCount: outcome.parseResult.missingNodeCount,
    regions: outcome.regions,
    symbols: outcome.symbols,
    imports: outcome.imports,
    calls: outcome.calls,
    ...(outcome.importsMissingReason === undefined
      ? {}
      : { importsMissingReason: outcome.importsMissingReason }),
    skips: outcome.skips,
  };
}

export function readParseEntry(value: unknown): CachedParseEntryV1 | null {
  const record = asRecord(value);
  if (record === null || !isVersionOne(record)) return null;
  if (typeof record["parseQuality"] !== "string" || !PARSE_QUALITIES.has(record["parseQuality"])) {
    return null;
  }
  if (
    typeof record["errorNodeCount"] !== "number" ||
    typeof record["missingNodeCount"] !== "number"
  ) {
    return null;
  }
  for (const field of ["diagnostics", "regions", "symbols", "imports", "calls", "skips"]) {
    if (!Array.isArray(record[field])) return null;
  }
  if (!(record["skips"] as unknown[]).every(isSkipInput)) return null;
  const reason = record["importsMissingReason"];
  if (reason !== undefined && typeof reason !== "string") return null;
  return record as unknown as CachedParseEntryV1;
}

export function toChunkEntry(result: ChunkFileResult): CachedChunkEntryV1 {
  return {
    v: 1,
    drafts: result.drafts,
    coverage: result.coverage,
    strategy: result.strategy,
    parseQuality: result.parseQuality,
    degradations: result.degradations,
  };
}

export function readChunkEntry(value: unknown): ChunkFileResult | null {
  const record = asRecord(value);
  if (record === null || !isVersionOne(record)) return null;
  if (typeof record["parseQuality"] !== "string" || !PARSE_QUALITIES.has(record["parseQuality"])) {
    return null;
  }
  if (typeof record["strategy"] !== "string" || !CHUNK_STRATEGIES.has(record["strategy"])) {
    return null;
  }
  for (const field of ["drafts", "coverage", "degradations"]) {
    if (!Array.isArray(record[field])) return null;
  }
  const draftsOk = (record["drafts"] as unknown[]).every((draft) => {
    const entry = asRecord(draft);
    return (
      entry !== null && typeof entry["chunkId"] === "string" && typeof entry["content"] === "string"
    );
  });
  if (!draftsOk) return null;
  return record as unknown as ChunkFileResult;
}

/**
 * Nach Codepoints geordnet — nie `localeCompare`. Der abgelegte Eintrag ist
 * damit byteweise reproduzierbar, und zwei Laeufe erzeugen dieselbe Datei.
 */
export function toMetricsEntry(metrics: Map<string, ScopeMetrics>): CachedMetricsEntryV1 {
  const entries = [...metrics.entries()]
    .map(([fqn, value]) => ({ fqn, metrics: value }))
    .sort((left, right) => compareCodepoints(left.fqn, right.fqn));
  return { v: 1, entries };
}

export function readMetricsEntry(value: unknown): CachedMetricsEntryV1 | null {
  const record = asRecord(value);
  if (record === null || !isVersionOne(record)) return null;
  if (!Array.isArray(record["entries"])) return null;
  const ok = (record["entries"] as unknown[]).every((item) => {
    const entry = asRecord(item);
    if (entry === null || typeof entry["fqn"] !== "string") return false;
    const metrics = asRecord(entry["metrics"]);
    return (
      metrics !== null &&
      typeof metrics["cyclomaticClassic"] === "number" &&
      typeof metrics["cyclomaticExtended"] === "number" &&
      typeof metrics["cognitive"] === "number" &&
      typeof metrics["sloc"] === "number"
    );
  });
  if (!ok) return null;
  return record as unknown as CachedMetricsEntryV1;
}

function metricsFromEntry(entry: CachedMetricsEntryV1): Map<string, ScopeMetrics> {
  const out = new Map<string, ScopeMetrics>();
  for (const item of entry.entries) {
    out.set(item.fqn, item.metrics);
  }
  return out;
}

/* ------------------------------------------------------------------ */

/** `startByte` 0, `endByte` = Bytelaenge — halboffen, wie `SourceRange` es fordert. */
function fileRangeOf(content: string): SourceRange {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content.length === 0 ? 1 : content.split("\n").length;
  return { startLine: 1, endLine: lines, startByte: 0, endByte: bytes };
}

function safely<T>(work: () => T, fallback: T, onError: (error: unknown) => void): T {
  try {
    return work();
  } catch (error) {
    onError(error);
    return fallback;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Metriken je qualifiziertem Symbolnamen.
 *
 * Der INKLUSIVE Wert wird berichtet — derselbe Massstab, den `untangle
 * complexity` anlegt, damit die Zahl im Suchtreffer und die Zahl im
 * Komplexitaetsbericht dieselbe Bedeutung haben.
 *
 * Ueberladungen teilen sich einen qualifizierten Namen. Der ERSTE Eintrag
 * gewinnt, spaetere werden verworfen — bewusst, weil ein Payload-Feld nur eine
 * Zahl traegt und eine willkuerlich ueberschriebene schlechter waere als eine
 * stabile.
 */
function metricsOf(
  adapter: LanguageAdapter,
  ast: ParsedAst,
  relativePath: string,
  fallbackCalls: readonly RawCall[],
): Map<string, ScopeMetrics> {
  const out = new Map<string, ScopeMetrics>();
  try {
    const repaired = withUniqueScopeIds(
      adapter.computeComplexity(ast),
      fallbackCalls,
      relativePath,
    );
    const facts = repaired.facts;
    for (const scope of facts.symbolScopes) {
      const key = scope.qualifiedName;
      if (key === "" || out.has(key)) continue;
      const ir = buildSymbolIR(facts, scope.symbolScopeId, { calls: repaired.calls });
      const subtree = {
        ...facts,
        decisions: facts.decisions.filter((decision) => containsRange(scope.range, decision.range)),
      };
      const cyclomatic = computeCyclomatic(subtree, scope.range.startLine, METRICS_VERSION);
      out.set(key, {
        cyclomaticClassic: cyclomatic.classic,
        cyclomaticExtended: cyclomatic.extended,
        cognitive: ir === undefined ? 0 : computeCognitive(ir, COGNITIVE_ALGORITHM_ID).value,
        sloc: Math.max(1, scope.range.endLine - scope.range.startLine + 1),
      });
    }
  } catch {
    // Eine geworfene Metrikberechnung darf den Index nicht kosten: die Datei
    // wird ohne Metrikfelder abgelegt. Der Verlust ist sichtbar (die Felder
    // fehlen), nicht falsch (es steht keine erfundene Zahl da).
    return out;
  }
  return out;
}

function payloadOf(
  draft: CodeChunkDraft,
  context: {
    target: IndexTargetV1;
    fileHash: string;
    embeddingProfileId: string;
    generationId: string;
    metrics: ScopeMetrics | undefined;
  },
): CodeChunkPayloadV1 {
  const { target, metrics } = context;
  return {
    schema_version: 1,
    point_type: "code_chunk",
    workspace_id: draft.workspaceId,
    repo_id: draft.repoId,
    repo_label: target.repoLabel,
    ref_id: draft.refId,
    ref_name: target.refName,
    ...(target.commitSha === undefined ? {} : { commit_sha: target.commitSha }),
    file_id: draft.fileId,
    file_path: draft.filePath,
    file_hash: context.fileHash,
    language: draft.language,
    parse_quality: draft.parseQuality,
    ...(draft.symbolId === undefined ? {} : { symbol_id: draft.symbolId }),
    ...(draft.symbolName === undefined ? {} : { symbol_name: draft.symbolName }),
    ...(draft.symbolFqn === undefined ? {} : { symbol_fqn: draft.symbolFqn }),
    ...(draft.symbolKind === undefined ? {} : { symbol_kind: draft.symbolKind }),
    ...(draft.signature === undefined ? {} : { signature: draft.signature }),
    chunk_id: draft.chunkId,
    chunk_kind: draft.chunkKind,
    chunk_ordinal: draft.chunkOrdinal,
    ...(draft.fragmentIndex === undefined ? {} : { fragment_index: draft.fragmentIndex }),
    ...(draft.fragmentCount === undefined ? {} : { fragment_count: draft.fragmentCount }),
    start_line: draft.range.startLine,
    end_line: draft.range.endLine,
    start_byte: draft.range.startByte,
    end_byte: draft.range.endByte,
    content: draft.content,
    content_hash: draft.contentHash,
    ...(draft.astHash === undefined ? {} : { ast_hash: draft.astHash }),
    parser_version: draft.parserVersion === "" ? PARSER_VERSION : draft.parserVersion,
    chunker_version: draft.chunkerVersion === "" ? CHUNKER_VERSION : draft.chunkerVersion,
    metrics_version: METRICS_VERSION,
    embedding_profile_id: context.embeddingProfileId,
    generation_id: context.generationId,
    // Wird von der Einbettungsstufe auf die Wahrheit gesetzt; `false` ist hier
    // nur die Ausgangslage, keine Behauptung.
    embedding_truncated: false,
    metrics_scope: draft.metricsScope,
    metrics_scope_id: draft.metricsScopeId,
    ...(metrics === undefined
      ? {}
      : {
          cyclomatic_classic: metrics.cyclomaticClassic,
          cyclomatic_extended: metrics.cyclomaticExtended,
          cognitive: metrics.cognitive,
          sloc: metrics.sloc,
        }),
  };
}
