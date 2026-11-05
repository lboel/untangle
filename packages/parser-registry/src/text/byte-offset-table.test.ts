import { describe, expect, it } from "vitest";

import { buildByteOffsetTable } from "./byte-offset-table.js";

describe("buildByteOffsetTable", () => {
  it("returns identity mapping for pure ASCII", () => {
    const table = buildByteOffsetTable("const x = 1;");
    expect(table.toByteOffset(0)).toBe(0);
    expect(table.toByteOffset(5)).toBe(5);
    expect(table.totalBytes).toBe(12);
  });

  it("accounts for multi-byte BMP characters (2-byte and 3-byte UTF-8)", () => {
    // "é" is U+00E9 -> 2 UTF-8 bytes, 1 UTF-16 unit.
    // "€" is U+20AC -> 3 UTF-8 bytes, 1 UTF-16 unit.
    const source = "é€x";
    const table = buildByteOffsetTable(source);
    expect(table.toByteOffset(0)).toBe(0);
    expect(table.toByteOffset(1)).toBe(2); // after é: 2 bytes
    expect(table.toByteOffset(2)).toBe(5); // after €: +3 bytes
    expect(table.toByteOffset(3)).toBe(6); // after x: +1 byte
    expect(table.totalBytes).toBe(Buffer.byteLength(source, "utf8"));
  });

  it("accounts for astral codepoints spanning a UTF-16 surrogate pair", () => {
    // 😀 is a surrogate pair (2 UTF-16 units) encoding to 4 UTF-8 bytes.
    const source = 'const emoji = "😀"; const y = 1;';
    const table = buildByteOffsetTable(source);
    expect(table.totalBytes).toBe(Buffer.byteLength(source, "utf8"));
    // Index right after the closing quote of the string literal in UTF-16
    // units (matches the tree-sitter offsets observed empirically).
    const afterEmojiUtf16 = source.indexOf('"', source.indexOf('"') + 1) + 1;
    const byteOffset = table.toByteOffset(afterEmojiUtf16);
    const expectedBytes = Buffer.byteLength(source.slice(0, afterEmojiUtf16), "utf8");
    expect(byteOffset).toBe(expectedBytes);
  });

  it("clamps out-of-range indices", () => {
    const table = buildByteOffsetTable("abc");
    expect(table.toByteOffset(-5)).toBe(0);
    expect(table.toByteOffset(1000)).toBe(table.totalBytes);
  });

  it("is monotonically non-decreasing", () => {
    const source = "hello 世界 🎉 world é€";
    const table = buildByteOffsetTable(source);
    let previous = 0;
    for (let i = 0; i <= source.length; i += 1) {
      const value = table.toByteOffset(i);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBe(table.totalBytes);
  });
});
