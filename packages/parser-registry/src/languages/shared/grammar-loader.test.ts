import { afterEach, describe, expect, it } from "vitest";

import { loadGrammar, loadParserCtor, resetGrammarCachesForTests } from "./grammar-loader.js";
import { parseWithBuffer } from "./parse-limits.js";

describe("grammar-loader", () => {
  afterEach(() => {
    resetGrammarCachesForTests();
  });

  it("caches the Parser constructor across calls", () => {
    const first = loadParserCtor();
    const second = loadParserCtor();
    expect(second).toBe(first);
  });

  it("caches a grammar handle across calls (same module+export)", () => {
    const first = loadGrammar({ moduleName: "tree-sitter-typescript", exportName: "typescript" });
    const second = loadGrammar({ moduleName: "tree-sitter-typescript", exportName: "typescript" });
    expect(second).toBe(first);
  });

  it("loads distinct handles for distinct exports of the same module", () => {
    const typescript = loadGrammar({
      moduleName: "tree-sitter-typescript",
      exportName: "typescript",
    });
    const tsx = loadGrammar({ moduleName: "tree-sitter-typescript", exportName: "tsx" });
    expect(typescript).not.toBe(tsx);
  });

  it("loads a Parser that can actually parse using a loaded grammar (end-to-end sanity)", () => {
    const ParserCtor = loadParserCtor();
    const language = loadGrammar({ moduleName: "tree-sitter-javascript" });
    const parser = new ParserCtor();
    parser.setLanguage(language);
    const tree = parseWithBuffer(parser, "const x = 1;");
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.type).toBe("program");
  });
});
