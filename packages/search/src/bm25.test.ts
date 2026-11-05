import { describe, expect, it } from "vitest";

import { Bm25Ranker } from "./bm25.js";

const documents = [
  { id: "a", text: "charge a credit card and issue a receipt" },
  { id: "b", text: "refund a receipt" },
  { id: "c", text: "rotate the authentication token" },
];

describe("Bm25Ranker", () => {
  it("ranks the document containing the query term first", () => {
    const ranking = new Bm25Ranker(documents).rank("charge");
    expect(ranking[0]?.id).toBe("a");
    expect(ranking[0]?.rank).toBe(1);
  });

  it("drops documents that match no query term instead of giving them a phantom rank", () => {
    const ranking = new Bm25Ranker(documents).rank("charge");
    expect(ranking.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("rewards a rarer term more than a common one", () => {
    const ranker = new Bm25Ranker(documents);
    const rare = ranker.rank("rotate")[0]?.score ?? 0;
    const common = ranker.rank("receipt")[0]?.score ?? 0;
    expect(rare).toBeGreaterThan(common);
  });

  it("finds an identifier through its camelCase parts", () => {
    const ranker = new Bm25Ranker([
      { id: "x", text: "export function rotateToken(token: Token) {}" },
      { id: "y", text: "export function unrelated() {}" },
    ]);
    expect(ranker.rank("rotate token").map((entry) => entry.id)).toEqual(["x"]);
  });

  it("breaks score ties by codepoint order of the id, never by insertion order", () => {
    const ranker = new Bm25Ranker([
      { id: "zzz", text: "charge" },
      { id: "aaa", text: "charge" },
    ]);
    expect(ranker.rank("charge").map((entry) => entry.id)).toEqual(["aaa", "zzz"]);
  });

  it("is deterministic across identical instances", () => {
    const first = new Bm25Ranker(documents).rank("receipt");
    const second = new Bm25Ranker(documents).rank("receipt");
    expect(second).toEqual(first);
  });

  it("survives an empty corpus", () => {
    const ranker = new Bm25Ranker([]);
    expect(ranker.documentCount).toBe(0);
    expect(ranker.rank("anything")).toEqual([]);
  });

  it("never produces a negative score for a term present in every document", () => {
    const ranker = new Bm25Ranker([
      { id: "a", text: "token" },
      { id: "b", text: "token" },
    ]);
    for (const entry of ranker.rank("token")) {
      expect(entry.score).toBeGreaterThan(0);
    }
  });
});
