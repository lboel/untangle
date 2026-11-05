import { validateCoverage } from "@untangle-code/domain";
import type { AstRegion, ExtractedSymbol, ParseResult } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { chunkFile } from "./chunker.js";
import { spanOf } from "./test-helpers.js";
import type { ChunkFileIdentity, ChunkerConfigInput } from "./types.js";

const identity: ChunkFileIdentity = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "repo-1:main",
  fileId: "file-1",
  filePath: "src/widget.ts",
  languageId: "typescript",
};

const preparedText: ChunkerConfigInput["preparedText"] = {
  documentPrefix: "search_document:",
  repoLabel: "untangle",
  refName: "main",
};

const COMPLETE_PARSE: ParseResult = {
  parseQuality: "complete",
  ast: { languageId: "typescript", parseQuality: "complete", root: {}, diagnostics: [] },
  diagnostics: [],
  errorNodeCount: 0,
  missingNodeCount: 0,
};

const FAILED_PARSE: ParseResult = {
  parseQuality: "failed",
  ast: null,
  diagnostics: [
    {
      severity: "error",
      kind: "error_node",
      message: "unexpected token",
      range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
    },
  ],
  errorNodeCount: 1,
  missingNodeCount: 0,
};

function assertLossless(
  drafts: { chunkId: string; range: { startByte: number; endByte: number } }[],
  coverage: Parameters<typeof validateCoverage>[0],
  fileRange: Parameters<typeof validateCoverage>[1],
) {
  const validation = validateCoverage(coverage, fileRange);
  expect(validation.issues).toEqual([]);
  expect(validation.complete).toBe(true);
  expect(drafts.length).toBeGreaterThan(0);
}

describe("chunkFile — lossless coverage across strategies", () => {
  it("is lossless for a well-formed, AST-chunkable file", () => {
    const content = `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n`;
    const addRange = spanOf(content, "export function add", "\n}");
    const subRange = spanOf(content, "export function sub", "\n}");
    const regions: AstRegion[] = [
      {
        chunkKind: "function",
        range: addRange,
        scopeId: "unused",
        symbolFqn: "add",
        splittable: true,
      },
      {
        chunkKind: "function",
        range: subRange,
        scopeId: "unused",
        symbolFqn: "sub",
        splittable: true,
      },
    ];
    const symbols: ExtractedSymbol[] = [
      {
        name: "add",
        qualifiedName: "add",
        kind: "function",
        signature: "add(a, b): number",
        normalizedSignature: "add(number,number):number",
        range: addRange,
        exportedNames: ["add"],
        astHash: "h-add",
        tokenFingerprint: "tf-add",
      },
      {
        name: "sub",
        qualifiedName: "sub",
        kind: "function",
        signature: "sub(a, b): number",
        normalizedSignature: "sub(number,number):number",
        range: subRange,
        exportedNames: ["sub"],
        astHash: "h-sub",
        tokenFingerprint: "tf-sub",
      },
    ];
    const result = chunkFile({
      identity,
      content,
      parseResult: COMPLETE_PARSE,
      regions,
      symbols,
      config: { preparedText },
    });
    expect(result.strategy).toBe("ast");
    assertLossless(result.drafts, result.coverage, {
      startLine: 1,
      endLine: content.split("\n").length,
      startByte: 0,
      endByte: Buffer.byteLength(content, "utf8"),
    });
    // Byte gaps between the two functions (blank line) must have been filled, not dropped.
    const reconstructedRanges = result.drafts
      .map((d) => d.range)
      .sort((a, b) => a.startByte - b.startByte);
    expect(reconstructedRanges[0]!.startByte).toBe(0);
    expect(reconstructedRanges[reconstructedRanges.length - 1]!.endByte).toBe(
      Buffer.byteLength(content, "utf8"),
    );
  });

  it("is lossless for a file with a parse error (line fallback)", () => {
    const content = "this is not valid syntax {{{ %%% \n more garbage\n".repeat(20);
    const result = chunkFile({
      identity,
      content,
      parseResult: FAILED_PARSE,
      regions: [],
      symbols: [],
      config: { preparedText },
    });
    expect(result.strategy).toBe("line_fallback");
    const fileRange = {
      startLine: 1,
      endLine: content.split("\n").length,
      startByte: 0,
      endByte: Buffer.byteLength(content, "utf8"),
    };
    assertLossless(result.drafts, result.coverage, fileRange);
  });

  it("is lossless for minified content", () => {
    const content = `(function(){${"x=1;".repeat(10000)}})();`;
    const result = chunkFile({
      identity,
      content,
      parseResult: COMPLETE_PARSE,
      regions: [],
      symbols: [],
      config: { preparedText, maxTokensPerChunk: 200 },
    });
    expect(result.strategy).toBe("minified");
    const fileRange = {
      startLine: 1,
      endLine: 1,
      startByte: 0,
      endByte: Buffer.byteLength(content, "utf8"),
    };
    assertLossless(result.drafts, result.coverage, fileRange);
  });

  it("is lossless when AST regions leave an unmodeled gap (e.g. an import line)", () => {
    const content = `import { Base } from "./base";\n\nexport function run(): void {\n  Base.init();\n}\n`;
    const runRange = spanOf(content, "export function run", "\n}");
    const regions: AstRegion[] = [
      {
        chunkKind: "function",
        range: runRange,
        scopeId: "unused",
        symbolFqn: "run",
        splittable: true,
      },
    ];
    const symbols: ExtractedSymbol[] = [
      {
        name: "run",
        qualifiedName: "run",
        kind: "function",
        signature: "run(): void",
        normalizedSignature: "run():void",
        range: runRange,
        exportedNames: ["run"],
        astHash: "h-run",
        tokenFingerprint: "tf-run",
      },
    ];
    const result = chunkFile({
      identity,
      content,
      parseResult: COMPLETE_PARSE,
      regions,
      symbols,
      config: { preparedText },
    });
    // The import line was not modeled by any region — it must show up as a fallback_lines gap-fill chunk.
    expect(result.drafts.some((d) => d.chunkKind === "fallback_lines")).toBe(true);
    const fileRange = {
      startLine: 1,
      endLine: content.split("\n").length,
      startByte: 0,
      endByte: Buffer.byteLength(content, "utf8"),
    };
    assertLossless(result.drafts, result.coverage, fileRange);
  });
});

describe("chunkFile — chunk id stability under pure line shift (spec.md §5.5, §5.6)", () => {
  it("keeps the same chunkId when unrelated leading lines are inserted", () => {
    const before = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
    const after = `// a new leading comment\n// another one\n\n${before}`;

    function chunkOf(content: string) {
      const addRange = spanOf(content, "export function add", "\n}");
      const regions: AstRegion[] = [
        {
          chunkKind: "function",
          range: addRange,
          scopeId: "unused",
          symbolFqn: "add",
          splittable: true,
        },
      ];
      const symbols: ExtractedSymbol[] = [
        {
          name: "add",
          qualifiedName: "add",
          kind: "function",
          signature: "add(a, b): number",
          normalizedSignature: "add(number,number):number",
          range: addRange,
          exportedNames: ["add"],
          astHash: "h-add",
          tokenFingerprint: "tf-add",
        },
      ];
      return chunkFile({
        identity,
        content,
        parseResult: COMPLETE_PARSE,
        regions,
        symbols,
        config: { preparedText },
      });
    }

    const resultBefore = chunkOf(before);
    const resultAfter = chunkOf(after);
    const chunkBefore = resultBefore.drafts.find((d) => d.chunkKind === "function")!;
    const chunkAfter = resultAfter.drafts.find((d) => d.chunkKind === "function")!;
    expect(chunkBefore.chunkId).toBe(chunkAfter.chunkId);
    // But the line numbers did change, proving this isn't a trivial no-op.
    expect(chunkBefore.range.startLine).not.toBe(chunkAfter.range.startLine);
  });
});

describe("chunkFile — token budget respected including the prepared-text header", () => {
  it("keeps tokenEstimate (header + content) within maxTokensPerChunk", () => {
    const content = `export function greet(name: string): string {\n  return "hello " + name;\n}\n`;
    const greetRange = spanOf(content, "export function greet", "\n}");
    const regions: AstRegion[] = [
      {
        chunkKind: "function",
        range: greetRange,
        scopeId: "unused",
        symbolFqn: "greet",
        splittable: true,
      },
    ];
    const symbols: ExtractedSymbol[] = [
      {
        name: "greet",
        qualifiedName: "greet",
        kind: "function",
        signature: "greet(name: string): string",
        normalizedSignature: "greet(string):string",
        range: greetRange,
        exportedNames: ["greet"],
        astHash: "h-greet",
        tokenFingerprint: "tf-greet",
      },
    ];
    const result = chunkFile({
      identity,
      content,
      parseResult: COMPLETE_PARSE,
      regions,
      symbols,
      config: { preparedText, maxTokensPerChunk: 60 },
    });
    for (const draft of result.drafts) {
      expect(draft.tokenEstimate).toBeLessThanOrEqual(60);
      expect(draft.preparedDenseText).toBeDefined();
      // preparedDenseText is strictly larger than raw content (header adds bytes) …
      expect(draft.preparedDenseText!.length).toBeGreaterThan(draft.content.length);
      // … yet the whole thing (header included) still fits inside the budget.
    }
  });
});
