/**
 * Byte-accurate text slicing and line/byte conversion (spec.md §7.1's
 * `SourceRange` convention: byte offsets are 0-based half-open, line numbers
 * 1-based inclusive).
 *
 * The chunker MUST slice chunk content by byte offset, not by JS string
 * (UTF-16) index, so that `CodeChunkPayloadV1.start_byte`/`end_byte` are
 * exact and so that content is byte-identical to the source file on disk.
 * Everything here operates on a `Buffer` built once per file.
 */
import type { SourceRange } from "@untangle-code/domain";

/** Precomputed line-start byte offsets for one file's content. */
export interface LineIndex {
  buffer: Buffer;
  /** Byte offset of the first byte of each line; `lineStarts[0] === 0`. */
  lineStarts: number[];
}

/** Builds a `LineIndex` from full file content (decoded UTF-8 string). */
export function buildLineIndex(content: string): LineIndex {
  const buffer = Buffer.from(content, "utf8");
  const lineStarts: number[] = [0];
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lineStarts.push(i + 1);
    }
  }
  return { buffer, lineStarts };
}

/** 1-based line number containing the given 0-based byte offset. */
export function lineNumberForByteOffset(index: LineIndex, byteOffset: number): number {
  const { lineStarts } = index;
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineStarts[mid]! <= byteOffset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

/**
 * Builds a `SourceRange` for a byte span, deriving line numbers from the
 * index. `endByte` is exclusive; for a non-empty span the end line is the
 * line containing the last included byte (`endByte - 1`).
 */
export function rangeForByteSpan(
  index: LineIndex,
  startByte: number,
  endByte: number,
): SourceRange {
  const startLine = lineNumberForByteOffset(index, startByte);
  const endLine = endByte > startByte ? lineNumberForByteOffset(index, endByte - 1) : startLine;
  return { startLine, endLine, startByte, endByte };
}

/** Decodes the UTF-8 bytes `[startByte, endByte)` of the file as a string. */
export function sliceBytes(index: LineIndex, startByte: number, endByte: number): string {
  return index.buffer.toString("utf8", startByte, endByte);
}

/** True if `byte` is a UTF-8 continuation byte (`10xxxxxx`). */
export function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * Returns the largest offset `<= target` (and `>= 0`) that does not fall in
 * the middle of a multi-byte UTF-8 sequence, i.e. `buffer[offset]` (if any)
 * is not a continuation byte. Used to keep token-boundary splits byte-safe
 * (architecture.md §14.4) even when the file mixes multi-byte characters.
 */
export function safeUtf8Boundary(buffer: Buffer, target: number): number {
  let offset = Math.max(0, Math.min(target, buffer.length));
  while (offset > 0 && offset < buffer.length && isUtf8ContinuationByte(buffer[offset]!)) {
    offset -= 1;
  }
  return offset;
}
