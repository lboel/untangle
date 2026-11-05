/**
 * Symbolknoten: Bytebereiche, `contentHash` und der Umgang mit Nicht-ASCII.
 */
import { Buffer } from "node:buffer";

import { sha256Hex } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildFileSymbolNodes, sliceSourceBytes } from "./nodes.js";
import type { SymbolGraphFileInput } from "./types.js";

const UMLAUT_SOURCE = "export function grueße() {\n  return „Hallo“;\n}\n";

function umlautFile(): SymbolGraphFileInput {
  const buffer = Buffer.from(UMLAUT_SOURCE, "utf8");
  return {
    fileId: "file-u",
    repoId: "repo-1",
    refId: "ref-1",
    path: "src/u.ts",
    languageId: "typescript",
    content: UMLAUT_SOURCE,
    parseQuality: "complete",
    symbols: [
      {
        name: "gruße",
        qualifiedName: "gruße",
        kind: "function",
        normalizedSignature: "gruße()",
        range: { startLine: 1, endLine: 3, startByte: 0, endByte: buffer.length - 1 },
        exportedNames: ["gruße"],
        astHash: "ast",
        tokenFingerprint: "tok",
      },
    ],
    calls: [],
    imports: [],
  };
}

describe("sliceSourceBytes", () => {
  it("cuts by BYTE offsets, not by character indices", () => {
    const buffer = Buffer.from("aäb", "utf8");
    expect(buffer.length).toBe(4);
    // Zeichenindex 2 waere "b"; Byteversatz 2 liegt mitten im "ä".
    expect(sliceSourceBytes(buffer, 0, 3)).toBe("aä");
    expect(sliceSourceBytes(buffer, 3, 4)).toBe("b");
  });

  it("clamps out-of-range offsets instead of throwing", () => {
    const buffer = Buffer.from("abc", "utf8");
    expect(sliceSourceBytes(buffer, -5, 99)).toBe("abc");
    expect(sliceSourceBytes(buffer, 2, 1)).toBe("");
  });
});

describe("buildFileSymbolNodes", () => {
  it("hashes exactly the symbol's source bytes, umlauts included", () => {
    const file = umlautFile();
    const result = buildFileSymbolNodes("ws-1", file);
    expect(result.nodes).toHaveLength(1);
    const expected = sha256Hex(UMLAUT_SOURCE.slice(0, UMLAUT_SOURCE.length - 1));
    expect(result.nodes[0]?.contentHash).toBe(expected);
  });

  it("carries exportedAs and skips it when the symbol exports nothing", () => {
    const file = umlautFile();
    expect(buildFileSymbolNodes("ws-1", file).nodes[0]?.exportedAs).toEqual(["gruße"]);
    const withoutExport: SymbolGraphFileInput = {
      ...file,
      symbols: file.symbols.map((symbol) => ({ ...symbol, exportedNames: [] })),
    };
    expect(buildFileSymbolNodes("ws-1", withoutExport).nodes[0]?.exportedAs).toBeUndefined();
  });

  it("reports a duplicate symbol id instead of overwriting the first node", () => {
    const file = umlautFile();
    const twice: SymbolGraphFileInput = {
      ...file,
      symbols: [...file.symbols, ...file.symbols],
    };
    const result = buildFileSymbolNodes("ws-1", twice);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodeBySymbolIndex[1]).toBeNull();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("duplicate");
    expect(result.skipped[0]?.detail).toContain("same symbol id");
  });
});
