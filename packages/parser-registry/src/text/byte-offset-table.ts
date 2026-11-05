/**
 * UTF-16 code unit offset -> UTF-8 byte offset conversion.
 *
 * tree-sitter's native Node binding reports `startIndex`/`endIndex` as UTF-16
 * code unit offsets into the JS source string (verified empirically: a
 * 4-byte astral codepoint advances `endIndex` by 2, not 4). `SourceRange`
 * (domain `types/common.ts`) is normative on byte offsets ("startByte is
 * 0-based inclusive, endByte is 0-based exclusive", spec.md §7/§8.4 lossless
 * byte-range coverage). Every adapter in this package MUST therefore convert
 * through a `ByteOffsetTable` before constructing a `SourceRange` — never
 * pass a tree-sitter index straight through.
 *
 * The table is a prefix-sum: `table[i]` is the number of UTF-8 bytes needed
 * to encode `source.slice(0, i)`. Building it is O(n) once per parse;
 * lookups are O(1). A lookup at an index that falls inside a surrogate pair
 * (which should never happen for a tree-sitter node boundary, since the
 * lexer never splits a surrogate pair) resolves to the byte offset of the
 * pair's start.
 */
export interface ByteOffsetTable {
  /** Convert a UTF-16 code unit offset (clamped to the source length) to a UTF-8 byte offset. */
  toByteOffset(utf16Index: number): number;
  /** Total UTF-8 byte length of the source. */
  readonly totalBytes: number;
}

function utf8LengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function buildByteOffsetTable(source: string): ByteOffsetTable {
  const length = source.length;
  // prefixBytes[i] = byte offset corresponding to UTF-16 index i.
  const prefixBytes = new Uint32Array(length + 1);
  let byteLength = 0;
  let i = 0;
  while (i < length) {
    const codePoint = source.codePointAt(i);
    // codePointAt is only undefined past the string end, which can't happen here.
    const cp = codePoint as number;
    const utf16Width = cp > 0xffff ? 2 : 1;
    prefixBytes[i] = byteLength;
    if (utf16Width === 2) {
      // The low surrogate is not a valid boundary; map it to the same byte
      // offset as the high surrogate so any accidental lookup is still safe.
      prefixBytes[i + 1] = byteLength;
    }
    byteLength += utf8LengthOfCodePoint(cp);
    i += utf16Width;
  }
  prefixBytes[length] = byteLength;

  return {
    totalBytes: byteLength,
    toByteOffset(utf16Index: number): number {
      const clamped = utf16Index < 0 ? 0 : utf16Index > length ? length : utf16Index;
      return prefixBytes[clamped] as number;
    },
  };
}
