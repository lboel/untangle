/**
 * Prosa-`LanguageAdapter` (vision.md §1c, WP-110/WP-217).
 *
 * WAS ER LOEST
 *
 * Vor ihm kannte `getAdapterForPath("spec.md")` nur `null`. Jede Stelle, die
 * das fragt — `untangle complexity`, der Watcher, der Selbstanalyse-Report —
 * schrieb daraufhin `unsupported_language` ins Skip-Ledger. Bei der ersten
 * Selbstanalyse dieses Repositories waren das allein 35 Markdown-Dateien,
 * bei 654 KB Markdown gegen 2.006 KB TypeScript. vision.md §1c sagt genau
 * das Gegenteil: Prosa ist erstklassiger Inhalt, und `text` ist kein
 * abgeschwaechtes `deep`.
 *
 * WAS ER LIEFERT — UND WAS BEWUSST NICHT
 *
 * - `extractChunks` liefert ueberschriftenbewusste Abschnitte mit
 *   Breadcrumb. Die Gliederung ist NICHT neu gebaut: es ist dieselbe
 *   `outlineMarkdown()`, die `@untangle-code/context-artifacts` schon fuer
 *   konfigurierte Markdown-Artefakte benutzt hat (WP-110 hat sie nach
 *   domain gehoben). Damit bekommt eine gewoehnliche `.md`-Datei im Chunker
 *   die AST-Strategie statt `line_fallback` — statt willkuerlicher
 *   Zeilenfenster also dieselben semantischen Einheiten wie eine
 *   konfigurierte.
 * - `extractSymbols` liefert je Abschnitt ein Symbol der Art `"section"`.
 *   Das ist die Zuordnung, ueber die der Chunker `symbolId`/`symbolFqn` an
 *   jeden Abschnitt und an jedes Fragment eines zu grossen Abschnitts
 *   haengt (spec.md §8.5).
 * - `extractImports` liefert relative Dateiverweise. Ein Verweis von
 *   `vision.md` auf `spec.md` IST eine Kante im Dateigraphen; sie zu
 *   verschweigen waere derselbe Verlust wie ein verschwiegener Import.
 * - `extractCalls` liefert NICHTS. Prosa hat keine Aufrufe.
 * - `computeComplexity` liefert LEERE Facts: keine `symbolScopes`, keine
 *   `decisions`. Das ist der Kern von WP-217 und keine Nachlaessigkeit —
 *   zyklomatische Komplexitaet ueber ein Dokument ist keine schlechte Zahl,
 *   sondern gar keine. Wer Prosa messen will, nimmt die Prosa-Metriken aus
 *   `@untangle-code/complexity` (`computeProseMetrics`), die als eigene
 *   Metrikfamilie (`ProseNumberV1`) gefuehrt werden und deshalb strukturell
 *   nie in eine Code-Summe geraten koennen.
 * - `tokenizeForHalstead` liefert NICHTS: Halstead zaehlt Operatoren und
 *   Operanden; in Prosa gibt es beides nicht.
 *
 * `parse()` kann nicht scheitern. Markdown hat keine Syntaxfehler — jeder
 * Text ist gueltiges Markdown —, deshalb ist `parseQuality` immer
 * `"complete"` und `ast` nie `null`. Das ist eine Aussage ueber das Format,
 * keine Beschoenigung.
 */
import type {
  AstRegion,
  ComplexityFacts,
  ExtractedSymbol,
  HalsteadTokens,
  LanguageAdapter,
  MarkdownSectionV1,
  ParsedAst,
  ParseResult,
  RawCall,
  RawImport,
  SourceFile,
  SourceRange,
} from "@untangle-code/domain";
import {
  classifyLinkTarget,
  findMarkdownLinks,
  outlineMarkdown,
  sha256Hex,
  textFormatExtensions,
} from "@untangle-code/domain";

import { buildLineByteIndex, rangeForLines, type LineByteIndex } from "./line-bytes.js";

/** Sprachkennung dieses Adapters; identisch mit der Scanner-Klassifikation fuer `.md`. */
export const PROSE_LANGUAGE_ID = "markdown";

/** Symbolart eines Prosa-Abschnitts. Ein Abschnitt ist keine Funktion und heisst auch nicht so. */
export const PROSE_SYMBOL_KIND = "section";

/** Name des Abschnitts vor der ersten Ueberschrift. */
const PREAMBLE_NAME = "(Vorspann)";

/** Der in `ParsedAst.root` abgelegte Nutzinhalt; nur dieser Adapter sieht hinein. */
interface ProseAstRoot {
  readonly fileId: string;
  readonly lines: readonly string[];
  readonly index: LineByteIndex;
  readonly sections: readonly ProseSection[];
}

interface ProseSection extends MarkdownSectionV1 {
  /** Eindeutiger Name innerhalb des Dokuments (siehe `uniqueName`). */
  readonly qualifiedName: string;
  readonly range: SourceRange;
}

/**
 * Physische Zeilen ohne Zeilenende. Ein abschliessendes `\r` faellt weg,
 * damit die Ueberschriften- und Verweiserkennung nicht daran scheitert.
 */
function splitLines(content: string): string[] {
  return content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Zwei Abschnitte koennen denselben Breadcrumb tragen (zweimal dieselbe
 * Ueberschrift unter demselben Elternteil). Der Chunker schluesselt Symbole
 * ueber `qualifiedName` in einer `Map`; ohne Vereindeutigung wuerde der
 * zweite Abschnitt den ersten ueberschreiben und beide dieselbe `symbolId`
 * bekommen. Angehaengt wird deshalb eine laufende Nummer — sichtbar, nicht
 * still.
 */
function uniqueName(breadcrumb: string, seen: Map<string, number>): string {
  const base = breadcrumb === "" ? PREAMBLE_NAME : breadcrumb;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base} (${String(count)})`;
}

function buildSections(lines: readonly string[], index: LineByteIndex): ProseSection[] {
  const seen = new Map<string, number>();
  return outlineMarkdown(lines).map((section) => ({
    ...section,
    qualifiedName: uniqueName(section.breadcrumb, seen),
    range: rangeForLines(index, section.startLine, section.endLine),
  }));
}

function rootOf(ast: ParsedAst): ProseAstRoot {
  return ast.root as ProseAstRoot;
}

function sectionContent(root: ProseAstRoot, section: ProseSection): string {
  return root.lines.slice(section.startLine - 1, section.endLine).join("\n");
}

function headingTextOf(section: ProseSection): string {
  return section.level === 0 ? PREAMBLE_NAME : `${"#".repeat(section.level)} ${section.title}`;
}

function symbolOf(root: ProseAstRoot, section: ProseSection): ExtractedSymbol {
  return {
    name: section.level === 0 ? PREAMBLE_NAME : section.title,
    qualifiedName: section.qualifiedName,
    kind: PROSE_SYMBOL_KIND,
    signature: headingTextOf(section),
    // Die "Signatur" eines Abschnitts ist seine Ueberschriftenebene plus
    // Pfad: was ihn im Dokument identifiziert, unabhaengig von seiner Zeile.
    normalizedSignature: `h${String(section.level)} ${section.qualifiedName}`,
    range: section.range,
    exportedNames: [],
    // Formhash: Ebene und Pfad — aendert sich, wenn der Abschnitt umbenannt
    // oder verschoben wird, nicht wenn sein Text sich aendert.
    astHash: sha256Hex(`prose-section ${String(section.level)} ${section.qualifiedName}`),
    // Inhaltshash: der Rohtext des Abschnitts.
    tokenFingerprint: sha256Hex(sectionContent(root, section)),
  };
}

export function createProseAdapter(): LanguageAdapter {
  return {
    languageId: PROSE_LANGUAGE_ID,
    extensions: textFormatExtensions("prose"),
    supportLevel: "text",

    parse(source: SourceFile): ParseResult {
      const lines = splitLines(source.content);
      const index = buildLineByteIndex(source.content);
      const root: ProseAstRoot = {
        fileId: source.fileId,
        lines,
        index,
        sections: buildSections(lines, index),
      };
      const ast: ParsedAst = {
        languageId: PROSE_LANGUAGE_ID,
        parseQuality: "complete",
        root,
        diagnostics: [],
      };
      return {
        parseQuality: "complete",
        ast,
        diagnostics: [],
        errorNodeCount: 0,
        missingNodeCount: 0,
      };
    },

    extractChunks(ast: ParsedAst): AstRegion[] {
      const root = rootOf(ast);
      const children: AstRegion[] = root.sections.map((section) => ({
        // Der Vorspann vor der ersten Ueberschrift ist genau das, was
        // `file_preamble` beschreibt; alles Weitere ist ein Prosa-Abschnitt.
        chunkKind: section.level === 0 ? "file_preamble" : "prose_section",
        range: section.range,
        scopeId: `${root.fileId}#${section.qualifiedName}`,
        symbolFqn: section.qualifiedName,
        headerText:
          section.level === 0
            ? PREAMBLE_NAME
            : `${"#".repeat(section.level)} ${section.breadcrumb}`,
        // Ein Abschnitt hat keine feineren AST-Grenzen; ist er zu gross,
        // teilt der Chunker ihn an Tokengrenzen in `symbol_fragment`s, die
        // seine `symbolId` erben (spec.md §8.5).
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
          splittable: children.length > 0,
          ...(children.length > 0 ? { children } : {}),
        },
      ];
    },

    extractSymbols(ast: ParsedAst): ExtractedSymbol[] {
      const root = rootOf(ast);
      return root.sections.map((section) => symbolOf(root, section));
    },

    extractImports(ast: ParsedAst): RawImport[] {
      const root = rootOf(ast);
      const imports: RawImport[] = [];
      for (const link of findMarkdownLinks(root.lines)) {
        if (classifyLinkTarget(link.target) !== "relative_file") continue;
        imports.push({
          specifier: link.target,
          importKind: "import",
          range: rangeForLines(root.index, link.line, link.line),
        });
      }
      return imports;
    },

    extractCalls(_ast: ParsedAst): RawCall[] {
      // Prosa hat keine Aufrufe. Eine leere Liste ist hier die vollstaendige
      // Antwort, keine Abstufung.
      return [];
    },

    computeComplexity(ast: ParsedAst): ComplexityFacts {
      // KEINE `symbolScopes` und KEINE `decisions` — siehe Kopfkommentar.
      // Stuende hier je Abschnitt ein Scope, rechnete jede
      // Code-Metrik-Pipeline anschliessend `cyclomatic = 1` je Ueberschrift
      // und addierte das zur Summe des Repositories. Genau das verhindert
      // diese leere Antwort.
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
