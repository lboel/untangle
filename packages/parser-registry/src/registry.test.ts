import type { LanguageAdapter } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { LazyParserRegistry } from "./registry.js";

function fakeAdapter(languageId: string, extensions: string[]): LanguageAdapter {
  return {
    languageId,
    extensions,
    supportLevel: "deep",
    parse: () => {
      throw new Error("not used in registry tests");
    },
    extractChunks: () => [],
    extractSymbols: () => [],
    extractImports: () => [],
    extractCalls: () => [],
    computeComplexity: () => ({
      symbolScopes: [],
      decisions: [],
      nestingEvents: [],
      operators: [],
      operands: [],
      nodeKinds: [],
      comments: [],
      identifiers: [],
      literals: [],
      parseDiagnostics: [],
    }),
    tokenizeForHalstead: () => ({ operators: [], operands: [] }),
  };
}

describe("LazyParserRegistry", () => {
  it("resolves an adapter by extension", () => {
    const registry = new LazyParserRegistry();
    const ts = fakeAdapter("typescript", [".ts", ".mts"]);
    registry.register(ts);

    expect(registry.getAdapterForPath("src/index.ts")).toBe(ts);
    expect(registry.getAdapterForPath("src/index.mts")).toBe(ts);
  });

  it("resolves case-insensitively", () => {
    const registry = new LazyParserRegistry();
    const ts = fakeAdapter("typescript", [".ts"]);
    registry.register(ts);
    expect(registry.getAdapterForPath("src/Index.TS")).toBe(ts);
  });

  it("returns null for an unregistered extension", () => {
    const registry = new LazyParserRegistry();
    registry.register(fakeAdapter("typescript", [".ts"]));
    expect(registry.getAdapterForPath("README.md")).toBeNull();
  });

  it("returns null for a dotfile with no extension", () => {
    const registry = new LazyParserRegistry();
    registry.register(fakeAdapter("typescript", [".ts"]));
    expect(registry.getAdapterForPath(".gitignore")).toBeNull();
  });

  it("resolves by language id", () => {
    const registry = new LazyParserRegistry();
    const ts = fakeAdapter("typescript", [".ts"]);
    registry.register(ts);
    expect(registry.getAdapterByLanguage("typescript")).toBe(ts);
    expect(registry.getAdapterByLanguage("python")).toBeNull();
  });

  it("lists every registered adapter", () => {
    const registry = new LazyParserRegistry();
    registry.register(fakeAdapter("typescript", [".ts"]));
    registry.register(fakeAdapter("javascript", [".js"]));
    expect(
      registry
        .listAdapters()
        .map((a) => a.languageId)
        .sort(),
    ).toEqual(["javascript", "typescript"]);
  });

  it("reports support level for a registered/unregistered language", () => {
    const registry = new LazyParserRegistry();
    registry.register(fakeAdapter("typescript", [".ts"]));
    expect(registry.supportLevelOf("typescript")).toBe("deep");
    expect(registry.supportLevelOf("python")).toBeNull();
  });

  it("a later registration overrides an earlier one for a shared extension", () => {
    const registry = new LazyParserRegistry();
    const first = fakeAdapter("javascript", [".js"]);
    const second = fakeAdapter("jsx", [".js"]);
    registry.register(first);
    registry.register(second);
    expect(registry.getAdapterForPath("a.js")).toBe(second);
  });
});
