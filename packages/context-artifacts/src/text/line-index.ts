/**
 * Line-oriented byte indexing shared by every format adapter.
 *
 * Every adapter in this package chunks by *line range* (headings, top-level
 * SQL statements, brace-delimited blocks, YAML documents, …), never by raw
 * character offset, so a single small utility converts a 1-based inclusive
 * line span into the byte-accurate `SourceRange` domain requires
 * (`startLine`/`endLine` 1-based inclusive, `startByte`/`endByte` 0-based
 * half-open — see `packages/domain/src/types/common.ts`).
 *
 * Splitting only ever happens right after a `\n` (0x0A, single ASCII byte,
 * never a UTF-8 continuation byte), so every line boundary this module
 * produces is automatically a safe UTF-8 boundary — no separate multi-byte
 * safety check is needed the way the chunker package needs one for
 * mid-line token-boundary splits.
 */
import type { SourceRange } from "@untangle-code/domain";

export interface LineIndex {
  readonly buffer: Buffer;
  /**
   * Byte offset of the start of each line (0-based), one entry per line,
   * PLUS one trailing sentinel equal to `buffer.length` — so
   * `lineStarts[lineCount]` is always a valid "end of file" byte offset.
   */
  readonly lineStarts: number[];
  readonly lineCount: number;
}

/** Builds a `LineIndex` from full document content (a decoded UTF-8 string). */
export function buildLineIndex(content: string): LineIndex {
  const buffer = Buffer.from(content, "utf8");
  const lineStarts: number[] = [0];
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lineStarts.push(i + 1);
    }
  }
  const lineCount = lineStarts.length;
  lineStarts.push(buffer.length);
  return { buffer, lineStarts, lineCount };
}

function lineStartByte(index: LineIndex, line: number): number {
  const clamped = Math.min(Math.max(line, 1), index.lineStarts.length);
  return index.lineStarts[clamped - 1] ?? index.buffer.length;
}

/**
 * 1-based line number containing byte offset `byteOffset` (clamped into
 * `[0, buffer.length]`). Binary search over `lineStarts` (sorted ascending,
 * one entry per line plus the EOF sentinel — see {@link LineIndex}), used by
 * any scanner that tracks byte offsets directly (e.g. the SQL adapter's
 * per-statement spans) and needs the matching 1-based line number without
 * re-walking the buffer from the start.
 */
export function lineNumberForByte(index: LineIndex, byteOffset: number): number {
  const target = Math.min(Math.max(byteOffset, 0), index.buffer.length);
  let low = 0;
  let high = index.lineCount - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((index.lineStarts[mid] ?? 0) <= target) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

/**
 * Builds a `SourceRange` for the 1-based inclusive line span
 * `[startLine, endLine]`. `endByte` is the byte offset of the start of the
 * line AFTER `endLine` (or end-of-file for the last line), so two chunks
 * built from adjacent line spans (`endLine` of one === `startLine - 1` of
 * the next) are byte-adjacent with no gap and no overlap.
 */
export function rangeForLines(index: LineIndex, startLine: number, endLine: number): SourceRange {
  const startByte = lineStartByte(index, startLine);
  const endByte = lineStartByte(index, endLine + 1);
  return { startLine, endLine, startByte, endByte };
}

/** Decodes the UTF-8 bytes `[startByte, endByte)` as a string. */
export function sliceBytes(index: LineIndex, startByte: number, endByte: number): string {
  return index.buffer.toString("utf8", startByte, endByte);
}

/** Convenience: raw content of the 1-based inclusive line span. */
export function sliceLines(index: LineIndex, startLine: number, endLine: number): string {
  const range = rangeForLines(index, startLine, endLine);
  return sliceBytes(index, range.startByte, range.endByte);
}

/**
 * Splits content into physical lines WITHOUT their line terminator, plus a
 * `LineIndex` for range/byte lookups. Adapters that scan line-by-line
 * (Markdown headings, Dockerfile `FROM`, brace-block scanners, …) use this
 * once per document.
 */
export function splitLines(content: string): { lines: string[]; index: LineIndex } {
  const index = buildLineIndex(content);
  // `\r\n` and `\n` both split correctly here; a trailing `\r` (if any) is
  // stripped so heading/keyword regexes don't have to account for it.
  const lines = content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { lines, index };
}
