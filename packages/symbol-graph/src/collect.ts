/**
 * Bruecke vom Parserergebnis zur Graph-Eingabe.
 *
 * `LanguageAdapter` (domain `analysis.ts`) liefert `extractSymbols`,
 * `extractCalls` und `extractImports` ueber einem `ParsedAst`. Diese Datei
 * ruft genau das auf und macht daraus ein {@link SymbolGraphFileInput}.
 *
 * ZWEI FAELLE, DIE KEIN FEHLER SIND:
 * 1. `parseResult.ast === null` (Parse fehlgeschlagen, Textfallback). Dann
 *    gibt es keine Symbole — das ist ein UEBERSPRUNG mit Grund, kein Wurf.
 * 2. Der Adapter liefert eine leere Symbolliste (Markdown, Text,
 *    Konfiguration). Das ist das KORREKTE Ergebnis (vision.md §1c) und
 *    erzeugt bewusst KEINEN Ledger-Eintrag: es wurde nichts uebersprungen,
 *    es war nichts da.
 *
 * Zu E4 im Besonderen: die `catch`-Bloecke hier verschlucken nichts. Jeder
 * gefangene Fehlschlag wird zu einem Ledger-Eintrag mit Grund und Text.
 */
import type {
  LanguageAdapter,
  ParseResult,
  RawCall,
  RawImport,
  ExtractedSymbol,
  SkipLedgerEntryV1,
  SourceFile,
} from "@untangle-code/domain";
import { buildSkipLedgerEntry } from "@untangle-code/domain";

import type { SymbolGraphFileInput } from "./types.js";

export interface CollectSymbolGraphFileInput {
  adapter: LanguageAdapter;
  source: SourceFile;
  parseResult: ParseResult;
  /** Paketname im Monorepo, sofern bekannt. */
  packageName?: string;
}

export interface CollectSymbolGraphFileResult {
  file: SymbolGraphFileInput;
  skipped: SkipLedgerEntryV1[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyFile(
  input: CollectSymbolGraphFileInput,
  symbols: ExtractedSymbol[],
  calls: RawCall[],
  imports: RawImport[],
): SymbolGraphFileInput {
  const file: SymbolGraphFileInput = {
    fileId: input.source.fileId,
    repoId: input.source.repoId,
    refId: input.source.refId,
    path: input.source.path,
    languageId: input.source.languageId,
    content: input.source.content,
    parseQuality: input.parseResult.parseQuality,
    symbols,
    calls,
    imports,
  };
  if (input.packageName !== undefined) file.packageName = input.packageName;
  return file;
}

/**
 * Wandelt ein Parserergebnis in eine Graph-Eingabe. Wirft nie: jeder
 * Fehlschlag wird zu einem begruendeten Ledger-Eintrag.
 */
export function collectSymbolGraphFile(
  input: CollectSymbolGraphFileInput,
): CollectSymbolGraphFileResult {
  const skipped: SkipLedgerEntryV1[] = [];
  const ast = input.parseResult.ast;

  if (ast === null) {
    skipped.push(
      buildSkipLedgerEntry({
        stage: "symbol_graph",
        subjectKind: "file",
        subjectId: input.source.fileId,
        path: input.source.path,
        repoId: input.source.repoId,
        refId: input.source.refId,
        reason: "parse_failed",
        detail: `no AST for "${input.source.path}" (parseQuality "${input.parseResult.parseQuality}", ${String(input.parseResult.errorNodeCount)} error node(s), ${String(input.parseResult.missingNodeCount)} missing node(s)); the file contributes no symbols and no call edges`,
        recoverable: false,
      }),
    );
    return { file: emptyFile(input, [], [], []), skipped };
  }

  const extract = <T>(what: string, run: () => T[]): T[] => {
    try {
      return run();
    } catch (error) {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "symbol_graph",
          subjectKind: "file",
          subjectId: input.source.fileId,
          path: input.source.path,
          repoId: input.source.repoId,
          refId: input.source.refId,
          reason: "parse_failed",
          detail: `adapter "${input.adapter.languageId}" threw during ${what} for "${input.source.path}": ${errorMessage(error)}`,
          recoverable: false,
        }),
      );
      return [];
    }
  };

  const symbols = extract("extractSymbols", () => input.adapter.extractSymbols(ast));
  const calls = extract("extractCalls", () => input.adapter.extractCalls(ast));
  const imports = extract("extractImports", () => input.adapter.extractImports(ast));

  return { file: emptyFile(input, symbols, calls, imports), skipped };
}

/** Sammelt mehrere Dateien; die Ledger-Eintraege werden zusammengefuehrt. */
export function collectSymbolGraphFiles(inputs: readonly CollectSymbolGraphFileInput[]): {
  files: SymbolGraphFileInput[];
  skipped: SkipLedgerEntryV1[];
} {
  const files: SymbolGraphFileInput[] = [];
  const skipped: SkipLedgerEntryV1[] = [];
  for (const input of inputs) {
    const result = collectSymbolGraphFile(input);
    files.push(result.file);
    skipped.push(...result.skipped);
  }
  return { files, skipped };
}
