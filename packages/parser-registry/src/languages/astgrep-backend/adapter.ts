/**
 * Die Adapterfabrik des ast-grep-Backends.
 *
 * Sie baut aus einer Sprachtabelle (`shared/table-profile.ts`) einen
 * vollstaendigen `LanguageAdapter` (domain `analysis.ts`) — mit DEMSELBEN
 * Walk, DENSELBEN Diagnosen, DENSELBEN Fingerabdruecken und DEMSELBEN
 * Regionenbau wie der tree-sitter-Weg. `chunker`, `complexity`, `file-graph`
 * und `symbol-graph` koennen nicht erkennen, welches Backend gelaufen ist;
 * genau das ist die Zusage.
 *
 * WAS SICH ZWISCHEN DEN BACKENDS UNTERSCHEIDET, und wo es steht:
 *
 *  1. GROESSENGRENZE. Die 32-KiB-Puffergrenze der nativen tree-sitter-Bindung
 *     (`shared/parse-limits.ts`, WP-215) gibt es hier NICHT: ast-grep nimmt
 *     84 KB, 167 KB, 1 MB und 4 MB ohne jede Option. Dafuer kostet der Walk
 *     mehr Speicher, also gilt eine EIGENE, niedrigere Obergrenze
 *     ({@link MAX_ASTGREP_SOURCE_BYTES}) — begruendet unten.
 *
 *  2. FEHLENDE KNOTEN. tree-sitter misst sie (`nodeIsMissing`), ast-grep hat
 *     dafuer nichts. Der Cursor liefert hier eine Heuristik, und JEDE daraus
 *     entstehende Diagnose sagt das in ihrem Text
 *     (`collectParseDiagnostics(..., "heuristic")`). `missingNodeCount` bleibt
 *     eine Zahl — aber eine, deren Herkunft in der Ausgabe steht (E4).
 *
 *  3. VERSIONIERUNG. Ein anderer Parser erzeugt eine andere AST-Form und damit
 *     andere Chunk-IDs und Fingerabdruecke. Sichtbar wird das ueber
 *     `parserVersionForLanguage` (domain `versions.ts`), das fuer jede
 *     ast-grep-Sprache eine eigene `parser_version` liefert. Ohne sie lieferten
 *     die inhaltsadressierten Caches aus WP-100 stillschweigend Altes.
 */
import type {
  AstRegion,
  ComplexityFacts,
  HalsteadTokens,
  LanguageAdapter,
  ParsedAst,
  ParseResult,
  RawCall,
  RawImport,
  SourceFile,
} from "@untangle-code/domain";
import { AdapterParseError } from "@untangle-code/domain";

import { buildByteOffsetTable } from "../../text/byte-offset-table.js";
import { buildFileRegion } from "../shared/chunks.js";
import type { AnalysisResult } from "../shared/engine.js";
import { analyzeTree } from "../shared/engine.js";
import { extractedSymbolsOf } from "../shared/extract-symbols.js";
import type { FileTextContext } from "../shared/node-utils.js";
import { collectParseDiagnostics } from "../shared/parse-diagnostics.js";
import type { LanguageProfile } from "../shared/profile.js";
import type { SyntaxNode } from "../shared/syntax.js";
import type { LanguageKindTable } from "../shared/table-profile.js";
import { createTableProfile, fieldNamesOf } from "../shared/table-profile.js";

import { astGrepParse, registerAstGrepLanguage } from "./napi.js";
import { AstGrepSyntaxNode } from "./syntax.js";

/**
 * Obergrenze fuer eine einzelne Quelldatei, in Bytes — 5 MiB.
 *
 * WARUM NIEDRIGER ALS BEIM TREE-SITTER-WEG (8 MiB, `shared/parse-limits.ts`):
 * der Walk kostet hier mehr Speicher, weil jeder Abstieg ueber `children()`
 * geht und dabei je Knoten JS-Wrapper entstehen. SELBST GEMESSEN ueber diesen
 * Adapter (`parse()` + `computeComplexity()`, generierter Go-Quelltext, je
 * Groesse ein EIGENER Prozess, `maxRSS` aus `process.resourceUsage()`,
 * darwin/arm64, Node 26.7.0):
 *
 *     Bytes     Knoten      parse     walk      Spitzen-RSS
 *     1 MiB       490.959   1.897 ms  12.289 ms   1.048 MiB
 *     2 MiB       976.521   3.087 ms  11.699 ms   2.719 MiB
 *     4 MiB     1.937.712   5.803 ms  45.863 ms   2.098 MiB
 *
 * Die RSS-Spalte ist ERKENNBAR VERRAUSCHT (4 MiB unter 2 MiB), weil die
 * napi-Finalisierer auf der Ereignisschleife laufen und ein synchroner Lauf
 * sie nicht drankommen laesst — dieselbe Beobachtung machte die Erkundung.
 * Verlaesslich ist nur die Groessenordnung: rund ein Gigabyte je Megabyte
 * Quelltext, und damit rund das Vierfache des tree-sitter-Weges.
 *
 * DIE GRENZE IST DESHALB DIE SCANNERGRENZE: 5 MiB, genau die Vorgabe aus
 * `packages/scanner/src/discovery.ts`. Damit ist der Parser bei
 * Standardkonfiguration NIE die engere, unausgesprochene Grenze — jede Datei,
 * die der Scanner durchlaesst, nimmt er auch an —, und zugleich bleibt der
 * Speicherbedarf im messbaren Bereich. Wer die Scannergrenze bewusst anhebt,
 * bekommt hier einen benannten Grund (`file_too_large`) statt eines Absturzes.
 *
 * NICHT GELOEST, und hier ausdruecklich vermerkt: 12 bis 46 Sekunden Walk je
 * Megabyte sind ein eigener Leistungsdefekt dieses Weges (der tree-sitter-Weg
 * misst an vergleichbarer Stelle rund sechs Sekunden je Megabyte). Diese
 * Grenze verhindert nur, dass er in einen Speicherabsturz umschlaegt.
 */
export const MAX_ASTGREP_SOURCE_BYTES = 5 * 1024 * 1024;

/** Der undurchsichtige Inhalt von `ParsedAst.root` fuer dieses Backend. */
interface AstGrepAstRoot {
  root: AstGrepSyntaxNode;
  ctx: FileTextContext;
  fileId: string;
  profile: LanguageProfile;
}

const analysisCache = new WeakMap<ParsedAst, AnalysisResult>();

/**
 * Wie in `shared/create-adapter.ts`: `ComplexityFacts.parseDiagnostics` ist der
 * EINZIGE Kanal, ueber den nachgelagerte Rechnungen von einem beschaedigten
 * Baum erfahren. `analyzeTree` sieht die Diagnosen nicht — sie entstehen in
 * `parse()` und haengen am `ParsedAst`.
 */
function getAnalysis(ast: ParsedAst): AnalysisResult {
  const cached = analysisCache.get(ast);
  if (cached !== undefined) return cached;
  const root = ast.root as AstGrepAstRoot;
  const analyzed = analyzeTree(root.root, root.ctx, root.fileId, root.profile);
  const result: AnalysisResult = {
    ...analyzed,
    facts: { ...analyzed.facts, parseDiagnostics: ast.diagnostics },
  };
  analysisCache.set(ast, result);
  return result;
}

/** Welches npm-Paket die Grammatik einer Sprache liefert. */
export interface AstGrepLanguageSource {
  /** Name, unter dem ast-grep die Sprache fuehrt (`parse(name, ...)`). */
  languageName: string;
  /** Sprachpaket, EINZELN aufgenommen — nie eine Sammelabhaengigkeit (450 MB fuer 22 Sprachen). */
  moduleName: string;
}

/**
 * Haken fuer eine Sprache, deren Regeln eine Tabelle NICHT ausdrueckt.
 *
 * WOFUER, an einem echten Fall: Python bindet den Doc-Kommentar nicht an ein
 * Kommentarzeichen, sondern an die erste Anweisung des Rumpfes; seine
 * Sichtbarkeit steht in einer Namenskonvention statt in einem Modifikator;
 * und `__all__` gilt je DATEI, nicht je Knoten. Das erste und zweite koennte
 * eine Tabelle notfalls noch beschreiben, das dritte nicht: es braucht einen
 * Zustand, den es erst gibt, wenn die Datei geparst ist.
 *
 * Deshalb DIESER Zuschnitt und kein anderer: der Haken bekommt das fertige
 * Tabellenprofil, den Wurzelknoten und die Datei und darf daraus ein
 * VERFEINERTES Profil bauen. Er laeuft genau einmal je Parse — nicht je
 * Knoten —, und wer ihn nicht setzt, bezahlt nichts.
 */
export interface AstGrepAdapterHooks {
  readonly profileForFile?: (
    base: LanguageProfile,
    root: SyntaxNode,
    file: SourceFile,
  ) => LanguageProfile;
}

/**
 * Baut einen `LanguageAdapter` ueber ast-grep. Die Anmeldung der Sprache
 * kostet hier nichts: kein `require`, keine Grammatik, kein natives Modul —
 * das passiert erst beim ersten `parse()` einer ast-grep-Sprache, und dann
 * fuer alle angemeldeten auf einmal (`napi.ts`, Eigenheit 1).
 */
export function createAstGrepAdapter(
  table: LanguageKindTable,
  source: AstGrepLanguageSource,
  hooks: AstGrepAdapterHooks = {},
): LanguageAdapter {
  const profile = createTableProfile(table);
  const fieldNames = fieldNamesOf(table);
  registerAstGrepLanguage(source.languageName, source.moduleName);

  return {
    languageId: table.languageId,
    extensions: [...table.extensions],
    supportLevel: table.supportLevel,

    parse(file: SourceFile): ParseResult {
      const byteLength = Buffer.byteLength(file.content, "utf8");
      if (byteLength > MAX_ASTGREP_SOURCE_BYTES) {
        throw new AdapterParseError(
          "file_too_large",
          `Source text with ${String(byteLength)} bytes exceeds the ast-grep parser limit of ` +
            `${String(MAX_ASTGREP_SOURCE_BYTES)} Bytes.`,
          {
            measurements: { sizeBytes: byteLength, limitBytes: MAX_ASTGREP_SOURCE_BYTES },
          },
        );
      }

      // KEIN `bufferSize` und keine 32-KiB-Grenze: die gibt es nur in der
      // nativen tree-sitter-Bindung (`shared/parse-limits.ts`). Nachgeprueft
      // an 84 KB, 167 KB, 1 MB und 4 MB — ast-grep nimmt sie ohne Option an.
      const rootNode = astGrepParse(source.languageName, file.content);
      const root = new AstGrepSyntaxNode(rootNode, fieldNames);

      const byteTable = buildByteOffsetTable(file.content);
      const ctx: FileTextContext = { sourceText: file.content, byteTable };
      const { parseQuality, diagnostics, errorNodeCount, missingNodeCount } =
        collectParseDiagnostics(root, ctx, "heuristic");

      if (parseQuality === "failed") {
        return { parseQuality, ast: null, diagnostics, errorNodeCount, missingNodeCount };
      }

      const fileProfile = hooks.profileForFile?.(profile, root, file) ?? profile;
      const astRoot: AstGrepAstRoot = { root, ctx, fileId: file.fileId, profile: fileProfile };
      return {
        parseQuality,
        ast: { languageId: table.languageId, parseQuality, root: astRoot, diagnostics },
        diagnostics,
        errorNodeCount,
        missingNodeCount,
      };
    },

    extractChunks(ast): AstRegion[] {
      const { scopeTree } = getAnalysis(ast);
      const root = ast.root as AstGrepAstRoot;
      return [buildFileRegion(scopeTree, root.ctx, root.profile)];
    },

    extractSymbols(ast) {
      return extractedSymbolsOf(getAnalysis(ast).scopeTree);
    },

    extractImports(ast): RawImport[] {
      return getAnalysis(ast).imports;
    },

    extractCalls(ast): RawCall[] {
      return getAnalysis(ast).calls;
    },

    computeComplexity(ast): ComplexityFacts {
      return getAnalysis(ast).facts;
    },

    tokenizeForHalstead(ast): HalsteadTokens {
      const { facts } = getAnalysis(ast);
      return { operators: facts.operators, operands: facts.operands };
    },
  };
}
