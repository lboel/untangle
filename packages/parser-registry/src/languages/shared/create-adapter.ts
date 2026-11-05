/**
 * Wires one `Dialect` config into a full `LanguageAdapter` (domain
 * `analysis.ts`), backed by the shared tree-sitter engine.
 *
 * See `engine.ts`'s doc comment for why every extraction method is a
 * projection over one memoized `AnalysisResult`.
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

import { buildByteOffsetTable } from "../../text/byte-offset-table.js";

import { buildFileRegion } from "./chunks.js";
import type { Dialect } from "./dialect.js";
import type { AnalysisResult } from "./engine.js";
import { analyzeTree } from "./engine.js";
import { extractedSymbolsOf } from "./extract-symbols.js";
import { loadGrammar, loadParserCtor } from "./grammar-loader.js";
import { createJsFamilyProfile } from "./js-family-profile.js";
import type { FileTextContext } from "./node-utils.js";
import { collectParseDiagnostics } from "./parse-diagnostics.js";
import { parseWithBuffer } from "./parse-limits.js";
import type { LanguageProfile } from "./profile.js";
import type { TsTree } from "./tree-sitter-types.js";

/** The opaque payload stored in `ParsedAst.root` by this package's `parse()`. */
interface TreeSitterAstRoot {
  tree: TsTree;
  ctx: FileTextContext;
  fileId: string;
  profile: LanguageProfile;
}

const analysisCache = new WeakMap<ParsedAst, AnalysisResult>();

/**
 * `ComplexityFacts.parseDiagnostics` ist der EINZIGE Kanal, ueber den
 * nachgelagerte Rechnungen (`computeSyntactic`, Berichte, Skip-Ledger) davon
 * erfahren, dass der Syntaxbaum einer Datei beschaedigt ist. `analyzeTree`
 * sieht die Diagnosen nicht — sie entstehen in `parse()` und haengen am
 * `ParsedAst`. Wurde das Feld hier nicht befuellt, blieb es AUSNAHMSLOS leer:
 * `parse_error_node_count` und `missing_node_count` meldeten dann fuer jede
 * Datei 0, auch fuer eine mit `parseQuality: "partial"` und 25 Fehlerknoten.
 * Genau dieses stille Verschlucken verbietet E4.
 */
function getAnalysis(ast: ParsedAst): AnalysisResult {
  const cached = analysisCache.get(ast);
  if (cached !== undefined) return cached;
  const root = ast.root as TreeSitterAstRoot;
  const analyzed = analyzeTree(root.tree.rootNode, root.ctx, root.fileId, root.profile);
  const result: AnalysisResult = {
    ...analyzed,
    facts: { ...analyzed.facts, parseDiagnostics: ast.diagnostics },
  };
  analysisCache.set(ast, result);
  return result;
}

export function createTreeSitterAdapter(dialect: Dialect): LanguageAdapter {
  // EIN Profil je Adapter, einmal gebaut: die Mengen darin sind unveraenderlich,
  // und der Walk liest sie je Knoten (`engine.ts`).
  const profile = createJsFamilyProfile(dialect);

  return {
    languageId: dialect.languageId,
    extensions: dialect.extensions,
    supportLevel: dialect.supportLevel,

    parse(source: SourceFile): ParseResult {
      const ParserCtor = loadParserCtor();
      const language = loadGrammar(dialect.grammar);
      const parser = new ParserCtor();
      parser.setLanguage(language);
      // NIE `parser.parse(source.content)` — ohne `bufferSize` wirft die native
      // Bindung fuer jede Datei ueber 32 KiB `Invalid argument` (WP-215).
      // `parseWithBuffer` prueft die Groessengrenze, setzt den Puffer und
      // benennt jede Ausnahme (WP-216).
      const tree = parseWithBuffer(parser, source.content);

      const byteTable = buildByteOffsetTable(source.content);
      const ctx: FileTextContext = { sourceText: source.content, byteTable };
      const { parseQuality, diagnostics, errorNodeCount, missingNodeCount } =
        collectParseDiagnostics(tree.rootNode, ctx);

      if (parseQuality === "failed") {
        return { parseQuality, ast: null, diagnostics, errorNodeCount, missingNodeCount };
      }

      const root: TreeSitterAstRoot = { tree, ctx, fileId: source.fileId, profile };
      return {
        parseQuality,
        ast: { languageId: dialect.languageId, parseQuality, root, diagnostics },
        diagnostics,
        errorNodeCount,
        missingNodeCount,
      };
    },

    extractChunks(ast): AstRegion[] {
      const { scopeTree } = getAnalysis(ast);
      const root = ast.root as TreeSitterAstRoot;
      return [buildFileRegion(scopeTree, root.ctx, root.profile)];
    },

    extractSymbols(ast) {
      const { scopeTree } = getAnalysis(ast);
      return extractedSymbolsOf(scopeTree);
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
