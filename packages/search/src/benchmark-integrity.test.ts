import { describe, expect, it } from "vitest";

import { assertBenchmarkRetrievalCompleted } from "./benchmark-integrity.js";
import { FINDABILITY_RETRIEVAL_FAILURE_WARNING_CODES } from "./findability.js";
import { buildInMemorySearchEngine } from "./testing/in-memory-index.js";

describe("assertBenchmarkRetrievalCompleted", () => {
  it("accepts a search that actually reached its target", async () => {
    const { engine } = await buildInMemorySearchEngine([
      { chunkId: "ok", filePath: "src/ok.ts", content: "export const ok = true;" },
    ]);
    const result = await engine.search({ query: "ok" });
    expect(() => assertBenchmarkRetrievalCompleted("q-ok", result)).not.toThrow();
  });

  it("rejects every retrieval-failure warning before it can become a benchmark row", async () => {
    const { engine } = await buildInMemorySearchEngine([
      { chunkId: "ok", filePath: "src/ok.ts", content: "export const ok = true;" },
    ]);
    const healthy = await engine.search({ query: "ok" });
    for (const code of FINDABILITY_RETRIEVAL_FAILURE_WARNING_CODES) {
      const failed = {
        ...healthy,
        warnings: [...healthy.warnings, { code, message: "provider failed" }],
      };
      expect(() => assertBenchmarkRetrievalCompleted(`q-${code}`, failed), code).toThrow(
        `q-${code}`,
      );
    }
  });

  it("rejects a group-less result even without a provider warning", async () => {
    const { engine } = await buildInMemorySearchEngine([]);
    const healthyShape = await engine.search({ query: "nothing" });
    const failed = { ...healthyShape, groups: [] };
    expect(() => assertBenchmarkRetrievalCompleted("q-no-group", failed)).toThrow(
      /without a single profile group/u,
    );
  });
});
