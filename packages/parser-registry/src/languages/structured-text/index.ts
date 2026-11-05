/**
 * `LanguageAdapter` fuer strukturierte, verfasste Daten — JSON, YAML, TOML,
 * XML (vision.md §1c, spec.md §7.1/§7.2, WP-217).
 *
 * DIE ENTSCHEIDUNG, DIE HIER GETROFFEN IST
 *
 * Bei der Selbstanalyse fielen 80 JSON-, 6 TOML-, 4 YAML- und 2 XML-Dateien
 * unter `unsupported_language`. Dieser Grund war falsch: die Formate SIND
 * unterstuetzt, sie haben nur keinen Graphen und keinen Kontrollfluss. Nach
 * spec.md §7.2 gehoeren sie ausdruecklich in die Stufe `text`.
 *
 * Sie bekommen deshalb hier `text` — mit voller Suche und sicheren
 * Textchunks. Eine `package.json`, eine `untangle.toml`, ein Manifest
 * beantworten echte Fragen; sie aus dem Index zu halten waere ein Verlust.
 *
 * WAS SIE NICHT BEKOMMEN, UND WARUM DAS KEINE ABSTUFUNG IST
 *
 * - Keine Symbole und keine `symbolScopes`: ein Schluessel in einer
 *   `package.json` ist kein Symbol mit Signatur, Callern und Callees. Ein
 *   erfundenes Symbol waere schlimmer als keins.
 * - Keine Komplexitaetszahlen: es gibt keine Entscheidungspunkte. Wer diese
 *   Dateien in einer Metrikauswertung uebergeht, benennt das mit dem Grund
 *   `no_metric_defined` (domain `skip-ledger.ts`) — nicht mit
 *   `unsupported_language`, denn verstanden sind sie.
 * - Auch KEINE Prosa-Metriken: eine YAML-Datei hat keine Abschnittstiefe im
 *   Sinne von Ueberschriften und keine Verweisdichte im Sinne von
 *   Querverweisen. Die Prosa-Familie ist fuer Prosa.
 *
 * WIE GESCHNITTEN WIRD
 *
 * Nur an Grenzen, die im Format EXAKT und ohne Parser bestimmbar sind:
 *
 * - TOML: eine Zeile, die (nach Leerraum) mit `[` beginnt, eroeffnet eine
 *   neue Tabelle — das ist die Gliederung des Formats.
 * - YAML: `---` trennt Dokumente in einem Strom.
 *
 * Fuer JSON und XML gibt es keine solche Grenze ohne echten Parser. Sie
 * bekommen EINEN Bereich ueber die ganze Datei, den der Chunker bei Bedarf
 * am Tokenbudget teilt. Das ist die ehrliche Antwort und ausdruecklich
 * KEINE ueberschriftenbewusste Gliederung, wie Markdown sie bekommt — sie
 * zu behaupten, wo das Format sie nicht hergibt, waere die Sorte
 * Beschoenigung, die E4 verbietet.
 */
import type {
  AstRegion,
  ComplexityFacts,
  ExtractedSymbol,
  HalsteadTokens,
  LanguageAdapter,
  ParsedAst,
  ParseResult,
  RawCall,
  RawImport,
  SourceFile,
  SourceRange,
} from "@untangle-code/domain";
import { textFormatExtensions, textFormatExtensionOf } from "@untangle-code/domain";

import { buildLineByteIndex, rangeForLines, type LineByteIndex } from "../prose/line-bytes.js";

/** Sprachkennung dieses Adapters. Bewusst formatuebergreifend: die Behandlung ist dieselbe. */
export const STRUCTURED_TEXT_LANGUAGE_ID = "structured-text";

interface StructuredAstRoot {
  readonly fileId: string;
  readonly index: LineByteIndex;
  readonly blocks: readonly SourceRange[];
}

const TOML_TABLE = /^\s*\[/;
const YAML_DOCUMENT_SEPARATOR = /^---\s*$/;

/** Zeilen, an denen ein neuer Block beginnt (1-basiert), aufsteigend, ohne Zeile 1. */
function blockStartLines(path: string, lines: readonly string[]): number[] {
  const extension = textFormatExtensionOf(path);
  const isToml = extension === ".toml";
  const isYaml = extension === ".yaml" || extension === ".yml";
  if (!isToml && !isYaml) return [];

  const starts: number[] = [];
  for (const [index, rawLine] of lines.entries()) {
    if (index === 0) continue;
    if (isToml && TOML_TABLE.test(rawLine)) starts.push(index + 1);
    if (isYaml && YAML_DOCUMENT_SEPARATOR.test(rawLine)) starts.push(index + 1);
  }
  return starts;
}

function buildBlocks(path: string, content: string, index: LineByteIndex): SourceRange[] {
  const lines = content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const totalLines = Math.max(index.lineCount, 1);
  const starts = [1, ...blockStartLines(path, lines)];
  return starts.map((startLine, position) => {
    const next = starts[position + 1];
    return rangeForLines(index, startLine, next !== undefined ? next - 1 : totalLines);
  });
}

function rootOf(ast: ParsedAst): StructuredAstRoot {
  return ast.root as StructuredAstRoot;
}

export function createStructuredTextAdapter(): LanguageAdapter {
  return {
    languageId: STRUCTURED_TEXT_LANGUAGE_ID,
    extensions: textFormatExtensions("structured_data"),
    supportLevel: "text",

    parse(source: SourceFile): ParseResult {
      const index = buildLineByteIndex(source.content);
      const root: StructuredAstRoot = {
        fileId: source.fileId,
        index,
        blocks: buildBlocks(source.path, source.content, index),
      };
      // Es wird nichts geparst, also kann nichts scheitern. `"complete"` ist
      // hier eine Aussage ueber die Textzerlegung, nicht ueber eine
      // Grammatik: eine ungueltige JSON-Datei wird trotzdem vollstaendig
      // erfasst und durchsuchbar — sie bekommt nur keine Struktur.
      return {
        parseQuality: "complete",
        ast: {
          languageId: STRUCTURED_TEXT_LANGUAGE_ID,
          parseQuality: "complete",
          root,
          diagnostics: [],
        },
        diagnostics: [],
        errorNodeCount: 0,
        missingNodeCount: 0,
      };
    },

    extractChunks(ast: ParsedAst): AstRegion[] {
      const root = rootOf(ast);
      const children: AstRegion[] = root.blocks.map((range, ordinal) => ({
        chunkKind: "configuration",
        range,
        scopeId: `${root.fileId}#block#${String(ordinal)}`,
        splittable: false,
      }));
      return [
        {
          chunkKind: "module",
          range: {
            startLine: 1,
            endLine: root.index.lineCount,
            startByte: 0,
            endByte: root.index.totalBytes,
          },
          scopeId: root.fileId,
          // Ein einziger Block ueber die ganze Datei traegt keine
          // Information; dann bleibt der Wurzelbereich kinderlos und der
          // Chunker schneidet selbst am Tokenbudget.
          splittable: children.length > 1,
          ...(children.length > 1 ? { children } : {}),
        },
      ];
    },

    extractSymbols(_ast: ParsedAst): ExtractedSymbol[] {
      return [];
    },

    extractImports(_ast: ParsedAst): RawImport[] {
      return [];
    },

    extractCalls(_ast: ParsedAst): RawCall[] {
      return [];
    },

    computeComplexity(ast: ParsedAst): ComplexityFacts {
      return {
        symbolScopes: [],
        decisions: [],
        nestingEvents: [],
        operators: [],
        operands: [],
        nodeKinds: [],
        comments: [],
        identifiers: [],
        literals: [],
        parseDiagnostics: ast.diagnostics,
      };
    },

    tokenizeForHalstead(_ast: ParsedAst): HalsteadTokens {
      return { operators: [], operands: [] };
    },
  };
}
