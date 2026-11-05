import { validateCoverage } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { resolveChunkerConfig } from "../config.js";
import { createBuildContext } from "../context.js";

import { runLineFallbackStrategy } from "./line-fallback-strategy.js";

const identity = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "repo-1:main",
  fileId: "file-1",
  filePath: "src/broken.ts",
  languageId: "typescript",
};

const preparedText = { documentPrefix: "search_document:", repoLabel: "untangle", refName: "main" };

function makeContent(lines: number): string {
  return (
    Array.from({ length: lines }, (_, i) => `line ${i} of unparseable content`).join("\n") + "\n"
  );
}

describe("runLineFallbackStrategy", () => {
  it("fully covers the file with overlapping fallback_lines windows", () => {
    const content = makeContent(500);
    const config = resolveChunkerConfig({
      preparedText,
      lineFallback: { linesPerChunk: 60, overlapLines: 8 },
    });
    const ctx = createBuildContext(identity, content, config, "failed");
    const result = runLineFallbackStrategy(ctx);

    expect(result.drafts.every((d) => d.chunkKind === "fallback_lines")).toBe(true);
    expect(result.drafts.length).toBeGreaterThan(1);

    const validation = validateCoverage(result.coverage, ctx.fileRange);
    expect(validation.complete).toBe(true);
    expect(validation.gaps).toEqual([]);
  });

  it("applies the configured line overlap between consecutive windows", () => {
    const content = makeContent(200);
    const config = resolveChunkerConfig({
      preparedText,
      lineFallback: { linesPerChunk: 50, overlapLines: 10 },
    });
    const ctx = createBuildContext(identity, content, config, "failed");
    const result = runLineFallbackStrategy(ctx);
    const [first, second] = result.drafts;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The second window starts before the first one ends (overlap).
    expect(second!.range.startByte).toBeLessThan(first!.range.endByte);
  });

  it("respects the token budget even for a single very long line", () => {
    const content = "x ".repeat(4000) + "\nshort line\n";
    const config = resolveChunkerConfig({
      preparedText,
      maxTokensPerChunk: 50,
      lineFallback: { linesPerChunk: 60, overlapLines: 0 },
    });
    const ctx = createBuildContext(identity, content, config, "failed");
    const result = runLineFallbackStrategy(ctx);
    for (const draft of result.drafts) {
      expect(draft.tokenEstimate).toBeLessThanOrEqual(config.maxTokensPerChunk);
    }
    const validation = validateCoverage(result.coverage, ctx.fileRange);
    expect(validation.complete).toBe(true);
  });

  it("reconstructs de-duplicated content losslessly (union covers file exactly)", () => {
    const content = makeContent(30);
    const config = resolveChunkerConfig({
      preparedText,
      lineFallback: { linesPerChunk: 10, overlapLines: 3 },
    });
    const ctx = createBuildContext(identity, content, config, "failed");
    const result = runLineFallbackStrategy(ctx);
    // Every byte of the file is included in at least one chunk's content.
    const covered = new Set<number>();
    for (const draft of result.drafts) {
      for (let b = draft.range.startByte; b < draft.range.endByte; b += 1) {
        covered.add(b);
      }
    }
    for (let b = 0; b < ctx.fileRange.endByte; b += 1) {
      expect(covered.has(b)).toBe(true);
    }
  });
});
