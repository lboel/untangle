import { describe, expect, it } from "vitest";

import {
  buildLineOffsets,
  createLineOffsetResolver,
  createUnresolvedPositionResolver,
  sourceRangeFromByteOffsets,
  utf8Length,
} from "./positions.js";

const CONTENT = ["const total = 1;", "const grün = 2;", "export { total, grün };", ""].join("\n");

describe("buildLineOffsets", () => {
  it("rechnet Zeilenanfaenge in UTF-8-Bytes, nicht in Zeichen", () => {
    const { offsets } = buildLineOffsets(CONTENT);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(utf8Length("const total = 1;") + 1);
    // "grün" ist 5 Bytes lang, nicht 4 — der Offset der dritten Zeile
    // beweist, dass in Bytes gerechnet wird.
    expect(offsets[2]).toBe(offsets[1]! + utf8Length("const grün = 2;") + 1);
    expect(utf8Length("const grün = 2;")).toBe(16);
  });
});

describe("createLineOffsetResolver", () => {
  const resolver = createLineOffsetResolver(new Map([["src/a.ts", CONTENT]]));

  it("uebersetzt einen Zeilenbereich in einen Byte-Range", () => {
    const range = resolver("src/a.ts", { startLine: 1, endLine: 1 });
    expect(range).toEqual({ startLine: 1, endLine: 1, startByte: 0, endByte: 16 });
  });

  it("beachtet Spalten, wenn das Werkzeug sie liefert", () => {
    const range = resolver("src/a.ts", {
      startLine: 2,
      endLine: 2,
      startColumn: 7,
      endColumn: 11,
    });
    // Spalten sind 1-basiert; `endColumn` ist exklusiv (SARIF-Konvention).
    expect(range?.startByte).toBe(17 + utf8Length("const "));
    expect(range?.endByte).toBe(17 + utf8Length("const grün"));
  });

  it("liefert null fuer eine unbekannte Datei — nichts wird erfunden", () => {
    expect(resolver("src/unknown.ts", { startLine: 1, endLine: 1 })).toBeNull();
  });

  it("liefert null, wenn die Zeile hinter dem Dateiende liegt", () => {
    expect(resolver("src/a.ts", { startLine: 999, endLine: 999 })).toBeNull();
  });

  it("begrenzt endLine auf die letzte vorhandene Zeile", () => {
    const range = resolver("src/a.ts", { startLine: 1, endLine: 999 });
    expect(range?.endLine).toBe(4);
  });
});

describe("createUnresolvedPositionResolver", () => {
  it("loest nie auf; der Fall bleibt dadurch sichtbar", () => {
    expect(createUnresolvedPositionResolver()("src/a.ts", { startLine: 1, endLine: 1 })).toBeNull();
  });
});

describe("sourceRangeFromByteOffsets", () => {
  it("nutzt die Byte-Angabe des Formats, wenn es sie fuehrt", () => {
    expect(
      sourceRangeFromByteOffsets({ startLine: 4, endLine: 6, byteOffset: 87, byteLength: 24 }),
    ).toEqual({ startLine: 4, endLine: 6, startByte: 87, endByte: 111 });
  });

  it("liefert null ohne Byte-Angabe", () => {
    expect(sourceRangeFromByteOffsets({ startLine: 1, endLine: 1 })).toBeNull();
  });
});
