import type { AstRegion, ExtractedSymbol, SourceRange } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { resolveChunkerConfig } from "../config.js";
import { createBuildContext } from "../context.js";
import { rangeOf, spanOf } from "../test-helpers.js";

import { runAstChunkStrategy } from "./ast-chunk-strategy.js";

/** A "giant" function: many independent, uniformly-sized statement blocks so it forces fragmentation. */
function buildGiantFunctionFixture(blockCount: number): {
  content: string;
  functionRange: SourceRange;
  blockRanges: SourceRange[];
} {
  const blocks: string[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    blocks.push(
      `  if (input === ${i}) {\n    results.push(compute(${i}, input, context, previous, accumulator));\n  }`,
    );
  }
  const content = `function process(input: number, context: Context, previous: number[], accumulator: number[]): number[] {\n  const results: number[] = [];\n${blocks.join("\n")}\n  return results;\n}\n`;
  const functionRange = spanOf(content, "function process", "\n}");
  const blockRanges = blocks.map((_, i) => rangeOf(content, `if (input === ${i}) {`));
  return { content, functionRange, blockRanges };
}

const identity = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "repo-1:main",
  fileId: "file-1",
  filePath: "src/process.ts",
  languageId: "typescript",
};

describe("runAstChunkStrategy — large symbol fragmentation (spec.md §8.5)", () => {
  it("splits an oversized function into multiple symbol_fragment chunks with correct indices and no content loss", () => {
    const { content, functionRange, blockRanges } = buildGiantFunctionFixture(40);
    const config = resolveChunkerConfig({
      maxTokensPerChunk: 120,
      preparedText: { documentPrefix: "search_document:", repoLabel: "untangle", refName: "main" },
    });

    // Model each `if` block as an AST child region so the AST-block split (step 6) has structure to work with.
    const children: AstRegion[] = blockRanges.map((range) => ({
      chunkKind: "symbol_fragment",
      range,
      scopeId: "unused",
      splittable: false,
    }));
    const functionRegion: AstRegion = {
      chunkKind: "function",
      range: functionRange,
      scopeId: "unused",
      symbolFqn: "process",
      splittable: true,
      children,
    };
    const symbols: ExtractedSymbol[] = [
      {
        name: "process",
        qualifiedName: "process",
        kind: "function",
        signature: "process(input, context, previous, accumulator): number[]",
        normalizedSignature: "process(number,Context,number[],number[]):number[]",
        range: functionRange,
        exportedNames: [],
        astHash: "h-process",
        tokenFingerprint: "tf-process",
      },
    ];

    const ctx = createBuildContext(identity, content, config, "complete");
    const result = runAstChunkStrategy(ctx, [functionRegion], symbols);

    const fragments = result.drafts.filter((d) => d.chunkKind === "symbol_fragment");
    expect(fragments.length).toBeGreaterThan(1);

    // fragmentIndex/fragmentCount are correct and contiguous.
    const sorted = [...fragments].sort((a, b) => a.fragmentIndex! - b.fragmentIndex!);
    sorted.forEach((fragment, i) => {
      expect(fragment.fragmentIndex).toBe(i);
      expect(fragment.fragmentCount).toBe(sorted.length);
    });

    // Every fragment carries a non-empty header/signature (spec.md §8.5).
    for (const fragment of sorted) {
      expect(fragment.signature).toBeTruthy();
    }

    // Fragments are ordered, contiguous and gap-free, and together
    // reconstruct the function's source EXACTLY (no loss, no duplication).
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.range.startByte).toBe(sorted[i - 1]!.range.endByte);
    }
    expect(sorted[0]!.range.startByte).toBe(functionRange.startByte);
    expect(sorted[sorted.length - 1]!.range.endByte).toBe(functionRange.endByte);
    const reconstructed = sorted.map((f) => f.content).join("");
    const originalBytes = Buffer.from(content, "utf8").subarray(
      functionRange.startByte,
      functionRange.endByte,
    );
    expect(reconstructed).toBe(originalBytes.toString("utf8"));

    // Every fragment respects the token budget, header included.
    for (const fragment of fragments) {
      expect(fragment.tokenEstimate).toBeLessThanOrEqual(config.maxTokensPerChunk);
    }
  });

  it("keeps a small function as a single, unfragmented chunk", () => {
    const content = `function add(a: number, b: number): number {\n  return a + b;\n}\n`;
    const functionRange = spanOf(content, "function add", "\n}");
    const config = resolveChunkerConfig({
      maxTokensPerChunk: 500,
      preparedText: { documentPrefix: "search_document:", repoLabel: "untangle", refName: "main" },
    });
    const functionRegion: AstRegion = {
      chunkKind: "function",
      range: functionRange,
      scopeId: "unused",
      symbolFqn: "add",
      splittable: true,
    };
    const symbols: ExtractedSymbol[] = [
      {
        name: "add",
        qualifiedName: "add",
        kind: "function",
        signature: "add(a: number, b: number): number",
        normalizedSignature: "add(number,number):number",
        range: functionRange,
        exportedNames: [],
        astHash: "h-add",
        tokenFingerprint: "tf-add",
      },
    ];
    const ctx = createBuildContext(identity, content, config, "complete");
    const result = runAstChunkStrategy(ctx, [functionRegion], symbols);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.chunkKind).toBe("function");
    expect(result.drafts[0]!.fragmentIndex).toBeUndefined();
  });
});
