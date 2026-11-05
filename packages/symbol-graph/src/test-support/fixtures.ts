/**
 * Testhilfen: bauen `SymbolGraphFileInput`s aus echtem Quelltext, indem
 * Bereiche ueber Textausschnitte gefunden werden. Damit stehen in den Tests
 * lesbare Programmschnipsel statt handgezaehlter Byteversaetze.
 *
 * Bewusst nur fuer ASCII-Inhalte gedacht: dort ist der Zeichenindex gleich dem
 * Byteversatz. Ein Test mit Nicht-ASCII muss die Bereiche selbst setzen.
 */
import type {
  ExtractedSymbol,
  RawCall,
  RawImport,
  RawImportBinding,
  SourceRange,
} from "@untangle-code/domain";

import type { SymbolGraphFileInput } from "../types.js";

export interface SymbolSpec {
  name: string;
  /** Textausschnitt, dessen Bereich das Symbol umfasst. */
  snippet: string;
  kind?: string;
  qualifiedName?: string;
  signature?: string;
  normalizedSignature?: string;
  exportedNames?: string[];
  visibility?: string;
  /** Nulltes, erstes, … Vorkommen des Ausschnitts. */
  occurrence?: number;
}

export interface CallSpec {
  calleeName: string;
  snippet: string;
  qualifier?: string;
  occurrence?: number;
  argumentCount?: number;
}

export interface ImportSpec {
  specifier: string;
  /**
   * LOKALE Bindungsnamen. Ohne `bindings` bleibt die Alias-Zuordnung
   * unbekannt — genau wie bei einem Adapter, der sie nicht meldet.
   */
  importedNames?: string[];
  /**
   * Vollstaendige Bindungen (lokal → importiert). Kurzform: ein String steht
   * fuer eine gleichnamige `named`-Bindung, `"lokal<-importiert"` fuer einen
   * Alias, `"lokal<-default"` fuer den Vorgabeexport.
   */
  bindings?: (string | RawImportBinding)[];
  snippet?: string;
  typeOnly?: boolean;
}

function toBinding(spec: string | RawImportBinding): RawImportBinding {
  if (typeof spec !== "string") return spec;
  const separator = spec.indexOf("<-");
  if (separator === -1) return { localName: spec, importedName: spec, kind: "named" };
  const localName = spec.slice(0, separator);
  const importedName = spec.slice(separator + 2);
  return {
    localName,
    importedName,
    kind: importedName === "default" ? "default" : "named",
  };
}

export interface FileSpec {
  fileId: string;
  path: string;
  content: string;
  repoId?: string;
  refId?: string;
  languageId?: string;
  symbols?: SymbolSpec[];
  calls?: CallSpec[];
  imports?: ImportSpec[];
}

function indexOfOccurrence(content: string, snippet: string, occurrence: number): number {
  let index = -1;
  for (let round = 0; round <= occurrence; round += 1) {
    index = content.indexOf(snippet, index + 1);
    if (index === -1) {
      throw new Error(
        `fixture snippet not found (occurrence ${String(occurrence)}): ${JSON.stringify(snippet)}`,
      );
    }
  }
  return index;
}

/** Bereich eines Textausschnitts; Zeilen 1-basiert, Bytes halboffen. */
export function rangeOfSnippet(content: string, snippet: string, occurrence = 0): SourceRange {
  const startByte = indexOfOccurrence(content, snippet, occurrence);
  const endByte = startByte + snippet.length;
  const before = content.slice(0, startByte);
  const startLine = before.split("\n").length;
  const endLine = content.slice(0, endByte).split("\n").length;
  return { startLine, endLine, startByte, endByte };
}

function toSymbol(content: string, spec: SymbolSpec): ExtractedSymbol {
  const qualifiedName = spec.qualifiedName ?? spec.name;
  const symbol: ExtractedSymbol = {
    name: spec.name,
    qualifiedName,
    kind: spec.kind ?? "function",
    normalizedSignature: spec.normalizedSignature ?? `${qualifiedName}()`,
    range: rangeOfSnippet(content, spec.snippet, spec.occurrence ?? 0),
    exportedNames: spec.exportedNames ?? [],
    astHash: `ast-${qualifiedName}`,
    tokenFingerprint: `tok-${qualifiedName}`,
  };
  if (spec.signature !== undefined) symbol.signature = spec.signature;
  if (spec.visibility !== undefined) symbol.visibility = spec.visibility;
  return symbol;
}

function toCall(content: string, spec: CallSpec): RawCall {
  const call: RawCall = {
    calleeName: spec.calleeName,
    callerScopeId: "unused-by-this-package",
    range: rangeOfSnippet(content, spec.snippet, spec.occurrence ?? 0),
  };
  if (spec.qualifier !== undefined) call.qualifier = spec.qualifier;
  if (spec.argumentCount !== undefined) call.argumentCount = spec.argumentCount;
  return call;
}

function toImport(content: string, spec: ImportSpec): RawImport {
  const range =
    spec.snippet === undefined
      ? { startLine: 1, endLine: 1, startByte: 0, endByte: 0 }
      : rangeOfSnippet(content, spec.snippet, 0);
  const raw: RawImport = { specifier: spec.specifier, importKind: "import", range };
  if (spec.bindings !== undefined) {
    raw.bindings = spec.bindings.map(toBinding);
    raw.importedNames = raw.bindings.map((binding) => binding.localName);
  }
  if (spec.importedNames !== undefined) raw.importedNames = spec.importedNames;
  if (spec.typeOnly !== undefined) raw.typeOnly = spec.typeOnly;
  return raw;
}

/** Baut eine Graph-Eingabedatei aus echtem Quelltext. */
export function makeFile(spec: FileSpec): SymbolGraphFileInput {
  return {
    fileId: spec.fileId,
    repoId: spec.repoId ?? "repo-1",
    refId: spec.refId ?? "ref-1",
    path: spec.path,
    languageId: spec.languageId ?? "typescript",
    content: spec.content,
    parseQuality: "complete",
    symbols: (spec.symbols ?? []).map((symbol) => toSymbol(spec.content, symbol)),
    calls: (spec.calls ?? []).map((call) => toCall(spec.content, call)),
    imports: (spec.imports ?? []).map((entry) => toImport(spec.content, entry)),
  };
}

/** Grosszuegige Limits fuer Tests, die keine Abschneidung pruefen wollen. */
export const GENEROUS_LIMITS = {
  maxDepth: 20,
  maxNodes: 1000,
  maxEdges: 5000,
  maxWallTimeMs: 60_000,
} as const;

/** Ein Aufruf innerhalb einer erzeugten Funktion. */
export interface GeneratedCall {
  name: string;
  qualifier?: string;
}

/** Eine erzeugte Funktion mit ihren Aufrufen. */
export interface GeneratedFunction {
  name: string;
  calls?: GeneratedCall[];
}

export interface FunctionFileSpec {
  fileId: string;
  path: string;
  functions: GeneratedFunction[];
  repoId?: string;
  refId?: string;
  languageId?: string;
}

/**
 * Erzeugt eine Datei aus Funktionsbeschreibungen und berechnet alle Bereiche
 * mit. Spart in Traversierungstests das Schreiben von Quelltext, ohne die
 * Bereichszuordnung zu umgehen — die Aufrufstellen liegen wirklich innerhalb
 * der Funktionsbereiche.
 */
export function functionFile(spec: FunctionFileSpec): SymbolGraphFileInput {
  let content = "";
  const symbols: ExtractedSymbol[] = [];
  const calls: RawCall[] = [];
  let line = 1;

  for (const fn of spec.functions) {
    const symbolStartByte = content.length;
    const symbolStartLine = line;
    content += `export function ${fn.name}() {\n`;
    line += 1;
    for (const call of fn.calls ?? []) {
      const written =
        call.qualifier === undefined ? `${call.name}()` : `${call.qualifier}.${call.name}()`;
      const callStartByte = content.length + 2;
      content += `  ${written};\n`;
      calls.push({
        calleeName: call.name,
        ...(call.qualifier !== undefined ? { qualifier: call.qualifier } : {}),
        callerScopeId: "unused-by-this-package",
        range: {
          startLine: line,
          endLine: line,
          startByte: callStartByte,
          endByte: callStartByte + written.length,
        },
      });
      line += 1;
    }
    content += "}\n";
    const symbolEndByte = content.length;
    symbols.push({
      name: fn.name,
      qualifiedName: fn.name,
      kind: "function",
      normalizedSignature: `${fn.name}()`,
      range: {
        startLine: symbolStartLine,
        endLine: line,
        startByte: symbolStartByte,
        endByte: symbolEndByte,
      },
      exportedNames: [fn.name],
      astHash: `ast-${spec.fileId}-${fn.name}`,
      tokenFingerprint: `tok-${spec.fileId}-${fn.name}`,
    });
    content += "\n";
    line += 2;
  }

  return {
    fileId: spec.fileId,
    repoId: spec.repoId ?? "repo-1",
    refId: spec.refId ?? "ref-1",
    path: spec.path,
    languageId: spec.languageId ?? "typescript",
    content,
    parseQuality: "complete",
    symbols,
    calls,
    imports: [],
  };
}
