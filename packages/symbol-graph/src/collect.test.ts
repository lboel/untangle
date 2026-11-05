/**
 * Bruecke zum Parser: was schiefgeht, wird begruendet — nicht verschluckt (E4).
 */
import type {
  ComplexityFacts,
  ExtractedSymbol,
  HalsteadTokens,
  LanguageAdapter,
  ParseResult,
  ParsedAst,
  RawCall,
  RawImport,
  SourceFile,
} from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { collectSymbolGraphFile, collectSymbolGraphFiles } from "./collect.js";

const CONTENT = "export function only() {\n  helper();\n}\n";

const SYMBOL: ExtractedSymbol = {
  name: "only",
  qualifiedName: "only",
  kind: "function",
  normalizedSignature: "only()",
  range: { startLine: 1, endLine: 3, startByte: 0, endByte: CONTENT.length - 1 },
  exportedNames: ["only"],
  astHash: "ast-only",
  tokenFingerprint: "tok-only",
};

const CALL: RawCall = {
  calleeName: "helper",
  callerScopeId: "scope",
  range: { startLine: 2, endLine: 2, startByte: 27, endByte: 35 },
};

const IMPORT: RawImport = {
  specifier: "./helper",
  importKind: "import",
  range: { startLine: 1, endLine: 1, startByte: 0, endByte: 10 },
  importedNames: ["helper"],
};

function source(): SourceFile {
  return {
    fileId: "file-1",
    repoId: "repo-1",
    refId: "ref-1",
    path: "src/only.ts",
    languageId: "fake",
    content: CONTENT,
    contentHash: "hash",
    sizeBytes: CONTENT.length,
  };
}

const AST: ParsedAst = { languageId: "fake", parseQuality: "complete", root: {}, diagnostics: [] };

function adapter(overrides: Partial<LanguageAdapter> = {}): LanguageAdapter {
  const base: LanguageAdapter = {
    languageId: "fake",
    extensions: [".fake"],
    supportLevel: "deep",
    parse: (): ParseResult => ({
      parseQuality: "complete",
      ast: AST,
      diagnostics: [],
      errorNodeCount: 0,
      missingNodeCount: 0,
    }),
    extractChunks: () => [],
    extractSymbols: (): ExtractedSymbol[] => [SYMBOL],
    extractImports: (): RawImport[] => [IMPORT],
    extractCalls: (): RawCall[] => [CALL],
    computeComplexity: (): ComplexityFacts => ({
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
    tokenizeForHalstead: (): HalsteadTokens => ({ operators: [], operands: [] }),
  };
  return { ...base, ...overrides };
}

function parseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    parseQuality: "complete",
    ast: AST,
    diagnostics: [],
    errorNodeCount: 0,
    missingNodeCount: 0,
    ...overrides,
  };
}

describe("collectSymbolGraphFile", () => {
  it("turns adapter output into a graph input file", () => {
    const result = collectSymbolGraphFile({
      adapter: adapter(),
      source: source(),
      parseResult: parseResult(),
    });
    expect(result.skipped).toEqual([]);
    expect(result.file.symbols).toHaveLength(1);
    expect(result.file.calls).toHaveLength(1);
    expect(result.file.imports).toHaveLength(1);
    expect(result.file.content).toBe(CONTENT);
  });

  it("feeds into buildSymbolGraph without further glue", () => {
    const collected = collectSymbolGraphFiles([
      { adapter: adapter(), source: source(), parseResult: parseResult() },
    ]);
    const graph = buildSymbolGraph({
      workspaceId: "ws-1",
      graphGeneration: "gen-1",
      files: collected.files,
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.toName).toBe("helper");
    expect(graph.edges[0]?.resolution).toBe("unresolved");
    expect(graph.edges[0]?.unresolvedReason).toBe("import_unresolved");
  });

  it("records a failed parse with a reason instead of throwing", () => {
    const result = collectSymbolGraphFile({
      adapter: adapter(),
      source: source(),
      parseResult: parseResult({ parseQuality: "failed", ast: null, errorNodeCount: 3 }),
    });
    expect(result.file.symbols).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("parse_failed");
    expect(result.skipped[0]?.detail).toContain("no AST");
    expect(result.skipped[0]?.detail).toContain("3 error node(s)");
  });

  it("does NOT swallow a throwing extractor (E4)", () => {
    const result = collectSymbolGraphFile({
      adapter: adapter({
        extractCalls: () => {
          throw new Error("grammar blew up");
        },
      }),
      source: source(),
      parseResult: parseResult(),
    });
    expect(result.file.symbols).toHaveLength(1);
    expect(result.file.calls).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("parse_failed");
    expect(result.skipped[0]?.detail).toContain("extractCalls");
    expect(result.skipped[0]?.detail).toContain("grammar blew up");
  });

  it("treats an adapter without symbols as a correct empty result", () => {
    const result = collectSymbolGraphFile({
      adapter: adapter({
        supportLevel: "text",
        extractSymbols: () => [],
        extractCalls: () => [],
        extractImports: () => [],
      }),
      source: { ...source(), path: "docs/notes.md", languageId: "markdown" },
      parseResult: parseResult(),
    });
    expect(result.file.symbols).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
