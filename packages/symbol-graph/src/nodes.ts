/**
 * Symbolknoten (spec.md §15.1) aus den `ExtractedSymbol`s einer geparsten
 * Datei.
 *
 * Zwei Entscheidungen, die hier festgeschrieben sind:
 *
 * 1. `contentHash` ist der SHA-256 der TATSAECHLICHEN Quellbytes des Symbols,
 *    nicht der AST-Fingerabdruck. `ExtractedSymbol` liefert `astHash` und
 *    `tokenFingerprint` — beide beantworten „hat sich die FORM geaendert",
 *    nicht „hat sich der INHALT geaendert". Deshalb verlangt
 *    `SymbolGraphFileInput` den Dateiinhalt.
 * 2. Zwei Symbole derselben Datei koennen dieselbe ID bekommen (gleiche Art,
 *    gleicher FQN, gleiche normalisierte Signatur — z. B. ueberladene
 *    Deklarationen). Der zweite Treffer wird NICHT still verworfen, sondern
 *    landet mit Grund im Skip-Ledger (E4).
 */
import { Buffer } from "node:buffer";

import type { ExtractedSymbol, SkipLedgerEntryV1, SymbolNodeV1 } from "@untangle-code/domain";
import { buildSkipLedgerEntry, buildSymbolId, sha256Hex } from "@untangle-code/domain";

import type { SymbolGraphFileInput } from "./types.js";

/** Ergebnis von {@link buildFileSymbolNodes}. */
export interface FileSymbolNodesResult {
  /** In Dokumentreihenfolge der Eingabe; die Sortierung passiert im Aufbau. */
  nodes: SymbolNodeV1[];
  /** `SymbolNodeV1` je `ExtractedSymbol`, indexgleich zur Eingabe; null bei Dublette. */
  nodeBySymbolIndex: (SymbolNodeV1 | null)[];
  skipped: SkipLedgerEntryV1[];
}

/**
 * Schneidet die Quellbytes eines Bereichs heraus. `startByte`/`endByte` sind
 * Byteversaetze (halboffen, spec.md `SourceRange`), deshalb wird ueber einen
 * `Buffer` geschnitten und nicht ueber String-Indizes — bei Nicht-ASCII sind
 * das verschiedene Dinge.
 */
export function sliceSourceBytes(buffer: Buffer, startByte: number, endByte: number): string {
  const start = Math.max(0, Math.min(startByte, buffer.length));
  const end = Math.max(start, Math.min(endByte, buffer.length));
  return buffer.subarray(start, end).toString("utf8");
}

function toSymbolNode(
  workspaceId: string,
  file: SymbolGraphFileInput,
  symbol: ExtractedSymbol,
  buffer: Buffer,
): SymbolNodeV1 {
  const id = buildSymbolId({
    workspaceId,
    repoId: file.repoId,
    refId: file.refId,
    relativePath: file.path,
    symbolKind: symbol.kind,
    qualifiedName: symbol.qualifiedName,
    normalizedSignature: symbol.normalizedSignature,
  });
  const node: SymbolNodeV1 = {
    id,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    repoId: file.repoId,
    refId: file.refId,
    fileId: file.fileId,
    filePath: file.path,
    language: file.languageId,
    startLine: symbol.range.startLine,
    endLine: symbol.range.endLine,
    startByte: symbol.range.startByte,
    endByte: symbol.range.endByte,
    contentHash: sha256Hex(sliceSourceBytes(buffer, symbol.range.startByte, symbol.range.endByte)),
  };
  if (symbol.signature !== undefined) {
    node.signature = symbol.signature;
  }
  if (symbol.exportedNames.length > 0) {
    node.exportedAs = [...symbol.exportedNames];
  }
  if (symbol.visibility !== undefined) {
    node.visibility = symbol.visibility;
  }
  return node;
}

/**
 * Baut die Symbolknoten einer Datei.
 *
 * Eine Datei OHNE Symbole liefert ein leeres Ergebnis ohne Ledger-Eintrag —
 * das ist das korrekte Ergebnis fuer Markdown, Text und Konfiguration
 * (vision.md §1c), kein Fehlschlag.
 */
export function buildFileSymbolNodes(
  workspaceId: string,
  file: SymbolGraphFileInput,
): FileSymbolNodesResult {
  const buffer = Buffer.from(file.content, "utf8");
  const nodes: SymbolNodeV1[] = [];
  const nodeBySymbolIndex: (SymbolNodeV1 | null)[] = [];
  const skipped: SkipLedgerEntryV1[] = [];
  const seen = new Set<string>();

  for (const [index, symbol] of file.symbols.entries()) {
    const node = toSymbolNode(workspaceId, file, symbol, buffer);
    if (seen.has(node.id)) {
      nodeBySymbolIndex.push(null);
      skipped.push(
        buildSkipLedgerEntry({
          stage: "symbol_graph",
          subjectKind: "symbol",
          subjectId: node.id,
          path: file.path,
          range: symbol.range,
          repoId: file.repoId,
          refId: file.refId,
          reason: "duplicate",
          detail: `symbol #${String(index)} "${symbol.qualifiedName}" (${symbol.kind}) derives the same symbol id as an earlier symbol in ${file.path}; identity is (kind, qualifiedName, normalizedSignature) per spec.md §5.5, so the later declaration cannot get its own node`,
          recoverable: false,
        }),
      );
      continue;
    }
    seen.add(node.id);
    nodes.push(node);
    nodeBySymbolIndex.push(node);
  }

  return { nodes, nodeBySymbolIndex, skipped };
}
