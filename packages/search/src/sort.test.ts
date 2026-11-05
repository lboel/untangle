import type { SearchHitV1 } from "@untangle-code/domain";
import { RANKER_VERSION } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { assignRanks, sortHits } from "./sort.js";

function hit(overrides: Partial<SearchHitV1> & { dedupeKey: string }): SearchHitV1 {
  return {
    schemaVersion: 1,
    rank: 0,
    repoId: "repo-a",
    repoLabel: "repo-a",
    refId: "ref-main",
    refName: "main",
    fileId: "file-1",
    filePath: "src/a.ts",
    range: { startLine: 1, endLine: 2, startByte: 0, endByte: 10 },
    language: "typescript",
    parseQuality: "complete",
    chunkId: "chunk-1",
    chunkKind: "function",
    score: {
      schemaVersion: 1,
      final: 0.5,
      components: [{ kind: "base_hybrid", rawValue: 0.5, weight: 1, contribution: 0.5 }],
      inputs: {},
      rankerVersion: RANKER_VERSION,
      clamped: false,
    },
    relatedFragments: [],
    embeddingProfileId: "profile-1",
    indexGeneration: "gen-1",
    ...overrides,
  };
}

describe("sortHits", () => {
  it("relevance sorts by final score, descending", () => {
    const sorted = sortHits(
      [
        hit({ dedupeKey: "a", score: { ...hit({ dedupeKey: "a" }).score, final: 0.2 } }),
        hit({ dedupeKey: "b", score: { ...hit({ dedupeKey: "b" }).score, final: 0.9 } }),
      ],
      "relevance",
    );
    expect(sorted.map((entry) => entry.dedupeKey)).toEqual(["b", "a"]);
  });

  it("breaks every tie by dedupe key codepoints", () => {
    const sorted = sortHits([hit({ dedupeKey: "z" }), hit({ dedupeKey: "a" })], "relevance");
    expect(sorted.map((entry) => entry.dedupeKey)).toEqual(["a", "z"]);
  });

  it("path sorts by repo, path and start line", () => {
    const sorted = sortHits(
      [
        hit({ dedupeKey: "1", filePath: "src/b.ts" }),
        hit({
          dedupeKey: "2",
          filePath: "src/a.ts",
          range: { startLine: 9, endLine: 9, startByte: 0, endByte: 1 },
        }),
        hit({ dedupeKey: "3", filePath: "src/a.ts" }),
      ],
      "path",
    );
    expect(sorted.map((entry) => entry.dedupeKey)).toEqual(["3", "2", "1"]);
  });

  it("sorts by complexity in both directions", () => {
    const complex = hit({
      dedupeKey: "complex",
      complexity: {
        metricsScope: "symbol",
        metricsScopeId: "s1",
        metricsVersion: "v1",
        cognitive: 30,
      },
    });
    const simple = hit({
      dedupeKey: "simple",
      complexity: {
        metricsScope: "symbol",
        metricsScopeId: "s2",
        metricsVersion: "v1",
        cognitive: 2,
      },
    });
    expect(sortHits([simple, complex], "complexity-desc").map((e) => e.dedupeKey)).toEqual([
      "complex",
      "simple",
    ]);
    expect(sortHits([complex, simple], "complexity-asc").map((e) => e.dedupeKey)).toEqual([
      "simple",
      "complex",
    ]);
  });

  it("puts hits without the sorted value LAST, not first", () => {
    const measured = hit({
      dedupeKey: "measured",
      complexity: {
        metricsScope: "symbol",
        metricsScopeId: "s1",
        metricsVersion: "v1",
        cognitive: 1,
      },
    });
    const unmeasured = hit({ dedupeKey: "unmeasured" });
    expect(sortHits([unmeasured, measured], "complexity-asc").map((e) => e.dedupeKey)).toEqual([
      "measured",
      "unmeasured",
    ]);
  });

  it("findability-asc puts the hardest-to-find symbol first", () => {
    const hard = hit({
      dedupeKey: "hard",
      findability: { score: 0.1, isHeuristic: true, algorithm: "untangle-findability-v1" },
    });
    const easy = hit({
      dedupeKey: "easy",
      findability: { score: 0.9, isHeuristic: true, algorithm: "untangle-findability-v1" },
    });
    expect(sortHits([easy, hard], "findability-asc").map((e) => e.dedupeKey)).toEqual([
      "hard",
      "easy",
    ]);
  });

  it("does not mutate its input", () => {
    const hits = [hit({ dedupeKey: "z" }), hit({ dedupeKey: "a" })];
    sortHits(hits, "relevance");
    expect(hits.map((entry) => entry.dedupeKey)).toEqual(["z", "a"]);
  });
});

describe("assignRanks", () => {
  it("numbers hits from 1", () => {
    expect(
      assignRanks([hit({ dedupeKey: "a" }), hit({ dedupeKey: "b" })]).map((e) => e.rank),
    ).toEqual([1, 2]);
  });
});
