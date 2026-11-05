import type { SourceRange } from "@untangle-code/domain";

import type { ByteOffsetTable } from "../../text/byte-offset-table.js";

import type { SyntaxNode, SyntaxCursor } from "./syntax.js";

/** Per-file context threaded through the analysis walk. */
export interface FileTextContext {
  sourceText: string;
  byteTable: ByteOffsetTable;
}

export function rangeOf(node: SyntaxNode, ctx: FileTextContext): SourceRange {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startByte: ctx.byteTable.toByteOffset(node.startIndex),
    endByte: ctx.byteTable.toByteOffset(node.endIndex),
  };
}

/**
 * `rangeOf` for a cursor position — identical result, but WITHOUT
 * materializing a `SyntaxNode` wrapper. `TreeCursor` exposes the same four
 * values (`startPosition`, `endPosition`, `startIndex`, `endIndex`) with the
 * same UTF-16 index convention as `SyntaxNode`, so the two functions are
 * interchangeable per node (WP-95).
 */
export function rangeOfCursor(cursor: SyntaxCursor, ctx: FileTextContext): SourceRange {
  return {
    startLine: cursor.startPosition.row + 1,
    endLine: cursor.endPosition.row + 1,
    startByte: ctx.byteTable.toByteOffset(cursor.startIndex),
    endByte: ctx.byteTable.toByteOffset(cursor.endIndex),
  };
}

/**
 * Kommentarknoten enden semantisch vor dem Zeilenumbruch. Manche Grammatiken
 * halten sich daran nicht: Rusts `///` und `//!` reichen bis zum Anfang der
 * Folgezeile. Da `SourceRange.endLine` INKLUSIV ist, wuerde diese Codezeile
 * sonst als Kommentar gelten und aus SLOC herausfallen (WP-236).
 */
function withoutTrailingLineBreak(
  range: SourceRange,
  text: string,
  endIndex: number,
  ctx: FileTextContext,
): SourceRange {
  const suffixLength = text.endsWith("\r\n")
    ? 2
    : text.endsWith("\n") || text.endsWith("\r")
      ? 1
      : 0;
  if (suffixLength === 0) return range;
  return {
    ...range,
    endLine: Math.max(range.startLine, range.endLine - 1),
    endByte: ctx.byteTable.toByteOffset(endIndex - suffixLength),
  };
}

/** `rangeOf`, mit der sprachuebergreifenden Zeilenkommentar-Normalisierung. */
export function commentRangeOf(node: SyntaxNode, ctx: FileTextContext): SourceRange {
  return withoutTrailingLineBreak(rangeOf(node, ctx), node.text, node.endIndex, ctx);
}

/** Cursor-Fassung von {@link commentRangeOf}, ohne einen Knotenwrapper zu bauen. */
export function commentRangeOfCursor(cursor: SyntaxCursor, ctx: FileTextContext): SourceRange {
  return withoutTrailingLineBreak(
    rangeOfCursor(cursor, ctx),
    cursor.nodeText,
    cursor.endIndex,
    ctx,
  );
}

/** Union of two ranges — the smallest range containing both. */
export function unionRange(a: SourceRange, b: SourceRange): SourceRange {
  return {
    startLine: Math.min(a.startLine, b.startLine),
    endLine: Math.max(a.endLine, b.endLine),
    startByte: Math.min(a.startByte, b.startByte),
    endByte: Math.max(a.endByte, b.endByte),
  };
}

/** Strips surrounding string quotes (`"`, `'`, `` ` ``) from raw source text, when present. */
export function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Finds the nearest ancestor (excluding `node` itself) whose type is in `types`. */
export function closestAncestorOfType(
  node: SyntaxNode,
  types: ReadonlySet<string>,
): SyntaxNode | null {
  let current = node.parent;
  while (current !== null) {
    if (types.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** All direct children of `node` whose type equals `type` (named or anonymous). */
export function directChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.children.filter((child) => child.type === type);
}

export function hasDirectChildOfType(node: SyntaxNode, type: string): boolean {
  return node.children.some((child) => child.type === type);
}
