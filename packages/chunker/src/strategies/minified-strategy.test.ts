import { validateCoverage } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { resolveChunkerConfig } from "../config.js";
import { createBuildContext } from "../context.js";

import { runMinifiedStrategy } from "./minified-strategy.js";

const identity = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "repo-1:main",
  fileId: "file-1",
  filePath: "src/bundle.min.js",
  languageId: "javascript",
};

const preparedText = { documentPrefix: "search_document:", repoLabel: "untangle", refName: "main" };

describe("runMinifiedStrategy", () => {
  it("splits a huge single-line bundle into budget-respecting minified_fragment chunks that fully cover it", () => {
    const content = `(function(){${"a=1;".repeat(20000)}})();`;
    const config = resolveChunkerConfig({ preparedText, maxTokensPerChunk: 100 });
    const ctx = createBuildContext(identity, content, config, "complete");
    const result = runMinifiedStrategy(ctx);

    expect(result.drafts.every((d) => d.chunkKind === "minified_fragment")).toBe(true);
    for (const draft of result.drafts) {
      expect(draft.tokenEstimate).toBeLessThanOrEqual(config.maxTokensPerChunk);
    }
    const validation = validateCoverage(result.coverage, ctx.fileRange);
    expect(validation.complete).toBe(true);
  });

  it("applies configured overlap bytes between consecutive fragments", () => {
    const content = "b".repeat(10000);
    const config = resolveChunkerConfig({
      preparedText,
      maxTokensPerChunk: 50,
      minifiedStrategy: { overlapBytes: 20 },
    });
    const ctx = createBuildContext(identity, content, config, "complete");
    const result = runMinifiedStrategy(ctx);
    expect(result.drafts.length).toBeGreaterThan(1);
    for (let i = 1; i < result.drafts.length; i += 1) {
      expect(result.drafts[i]!.range.startByte).toBeLessThan(result.drafts[i - 1]!.range.endByte);
    }
  });
});
