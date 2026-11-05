/**
 * The production BM25 text vectorization must stay algorithm-identical to
 * the testkit's reference implementation (README "Entscheidungen"): both
 * sides of every unit test (indexer output vs. in-memory store scoring)
 * and the real Qdrant corpus share one term-id space.
 */
import { Bm25Index, hashToken, textToSparseVector, tokenize } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { hashBm25Token, textToBm25SparseVector, tokenizeForBm25 } from "./bm25-text.js";

const SAMPLES = [
  "export function resolveImport(path: string): string | null {",
  "const αβγ = 42; // unicode identifiers",
  "SELECT * FROM files WHERE language = 'typescript'",
  "",
  "   \t\n  ",
  "camelCaseIdentifier snake_case_identifier kebab-case-identifier",
  "HTTPServer getUserById get_user_by_id größenÄnderung 𐐀𐐨User cafe\u0301Name",
];

describe("bm25 text vectorization parity with the testkit reference", () => {
  it("tokenizes identically", () => {
    for (const sample of SAMPLES) {
      expect(tokenizeForBm25(sample)).toEqual(tokenize(sample));
    }
  });

  it("hashes tokens identically", () => {
    for (const token of ["resolveimport", "string", "α", "x", "42", "a".repeat(200)]) {
      expect(hashBm25Token(token)).toBe(hashToken(token));
    }
  });

  it("produces identical sparse vectors", () => {
    for (const sample of SAMPLES) {
      expect(textToBm25SparseVector(sample)).toEqual(textToSparseVector(sample));
    }
  });
});

describe("textToBm25SparseVector", () => {
  it("matches component queries before reranking and preserves exact identifier terms", () => {
    const index = new Bm25Index();
    const camel = textToBm25SparseVector("getUserById");
    const snake = textToBm25SparseVector("get_user_by_id");
    const acronym = textToBm25SparseVector("HTTPServer");
    index.addDocument("camel", camel);
    index.addDocument("snake", snake);
    index.addDocument("acronym", acronym);
    const query = textToBm25SparseVector("user id");
    expect(index.score(query, camel)).toBeGreaterThan(0);
    expect(index.score(query, snake)).toBeGreaterThan(0);
    expect(index.score(query, acronym)).toBe(0);
    expect(index.score(textToBm25SparseVector("http server"), acronym)).toBeGreaterThan(0);
    expect(camel.indices).toContain(hashBm25Token("getuserbyid"));
    expect(snake.indices).toContain(hashBm25Token("get_user_by_id"));
  });

  it("is deterministic and sorted by term index", () => {
    const vector = textToBm25SparseVector("alpha beta alpha gamma");
    expect(vector).toEqual(textToBm25SparseVector("alpha beta alpha gamma"));
    expect([...vector.indices].sort((a, b) => a - b)).toEqual(vector.indices);
    expect(vector.values.reduce((sum, value) => sum + value, 0)).toBe(4);
  });

  it("returns an empty vector for text without tokens", () => {
    expect(textToBm25SparseVector("!!! --- ???")).toEqual({ indices: [], values: [] });
  });
});
