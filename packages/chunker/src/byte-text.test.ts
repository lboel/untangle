import { describe, expect, it } from "vitest";

import {
  buildLineIndex,
  lineNumberForByteOffset,
  rangeForByteSpan,
  safeUtf8Boundary,
  sliceBytes,
} from "./byte-text.js";

describe("buildLineIndex", () => {
  it("finds line starts for ASCII content", () => {
    const index = buildLineIndex("aaa\nbb\nc");
    expect(index.lineStarts).toEqual([0, 4, 7]);
  });

  it("counts a trailing newline as an extra (empty) line start", () => {
    const index = buildLineIndex("a\nb\n");
    expect(index.lineStarts).toEqual([0, 2, 4]);
  });
});

describe("lineNumberForByteOffset", () => {
  it("returns 1-based line numbers", () => {
    const index = buildLineIndex("aaa\nbb\nc");
    expect(lineNumberForByteOffset(index, 0)).toBe(1);
    expect(lineNumberForByteOffset(index, 3)).toBe(1); // the \n itself
    expect(lineNumberForByteOffset(index, 4)).toBe(2);
    expect(lineNumberForByteOffset(index, 7)).toBe(3);
  });
});

describe("rangeForByteSpan", () => {
  it("derives correct start/end lines for a multi-line span", () => {
    const index = buildLineIndex("aaa\nbb\nc");
    const range = rangeForByteSpan(index, 0, 8);
    expect(range).toEqual({ startLine: 1, endLine: 3, startByte: 0, endByte: 8 });
  });

  it("uses the same line for a zero-length span", () => {
    const index = buildLineIndex("aaa\nbb\nc");
    const range = rangeForByteSpan(index, 4, 4);
    expect(range.startLine).toBe(range.endLine);
  });
});

describe("sliceBytes", () => {
  it("round-trips content exactly for a byte-safe UTF-8 span", () => {
    const content = "héllo wörld";
    const index = buildLineIndex(content);
    expect(sliceBytes(index, 0, index.buffer.length)).toBe(content);
  });
});

describe("safeUtf8Boundary", () => {
  it("does not split a multi-byte character", () => {
    const content = "aéb"; // 'a', 'é' (2 bytes in UTF-8), 'b'
    const buffer = Buffer.from(content, "utf8");
    // buffer: [a(1), 0xC3, 0xA9, b(1)] -> targeting offset 2 (mid 'é') must back off to 1.
    const boundary = safeUtf8Boundary(buffer, 2);
    expect(boundary).toBe(1);
    // Decoding at any safe boundary must never produce a replacement character.
    expect(buffer.toString("utf8", 0, boundary)).not.toContain("�");
  });

  it("leaves an already-safe offset untouched", () => {
    const buffer = Buffer.from("abcdef", "utf8");
    expect(safeUtf8Boundary(buffer, 3)).toBe(3);
  });
});
