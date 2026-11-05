import { describe, expect, it } from "vitest";

import { Bm25Index, hashToken, sparseVectorLength, textToSparseVector, tokenize } from "./bm25.js";

describe("tokenize", () => {
  it("lower-cases words and preserves full identifiers alongside their parts", () => {
    expect(tokenize("Hello, World! foo_bar")).toEqual(["hello", "world", "foo_bar", "foo", "bar"]);
  });

  it("returns an empty array for text with no tokens", () => {
    expect(tokenize("   ---  ")).toEqual([]);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same token", () => {
    expect(hashToken("example")).toBe(hashToken("example"));
  });

  it("is a non-negative safe integer", () => {
    const hash = hashToken("example");
    expect(Number.isSafeInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
  });

  it("differs for different tokens (no trivial collision on common inputs)", () => {
    expect(hashToken("alpha")).not.toBe(hashToken("beta"));
  });
});

describe("textToSparseVector", () => {
  it("counts term frequencies and sorts by index", () => {
    const vector = textToSparseVector("foo foo bar");
    expect(vector.indices).toEqual([...vector.indices].sort((a, b) => a - b));
    expect(sparseVectorLength(vector)).toBe(3);
  });

  it("produces the same vector for the same text (determinism)", () => {
    expect(textToSparseVector("alpha beta gamma")).toEqual(textToSparseVector("alpha beta gamma"));
  });
});

describe("Bm25Index", () => {
  it("retrieves camelCase and snake_case documents through query component words", () => {
    const index = new Bm25Index();
    const camel = textToSparseVector("function getUserById() {}");
    const snake = textToSparseVector("function get_user_by_id() {}");
    const unrelated = textToSparseVector("function rotateCache() {}");
    index.addDocument("camel", camel);
    index.addDocument("snake", snake);
    index.addDocument("unrelated", unrelated);
    const query = textToSparseVector("user id");
    expect(index.score(query, camel)).toBeGreaterThan(0);
    expect(index.score(query, snake)).toBeGreaterThan(0);
    expect(index.score(query, unrelated)).toBe(0);
    expect(index.score(textToSparseVector("getUserById"), camel)).toBeGreaterThan(0);
    expect(index.score(textToSparseVector("get_user_by_id"), snake)).toBeGreaterThan(0);
  });

  it("scores a document containing all query terms higher than one containing none", () => {
    const index = new Bm25Index();
    const docA = textToSparseVector("the quick brown fox jumps");
    const docB = textToSparseVector("completely unrelated content here");
    index.addDocument("a", docA);
    index.addDocument("b", docB);

    const query = textToSparseVector("quick fox");
    expect(index.score(query, docA)).toBeGreaterThan(index.score(query, docB));
  });

  it("scores an empty query as zero against any document", () => {
    const index = new Bm25Index();
    const doc = textToSparseVector("some content");
    index.addDocument("a", doc);
    expect(index.score(textToSparseVector(""), doc)).toBe(0);
  });

  it("is idempotent when the same document id is re-added (no double counting)", () => {
    const index = new Bm25Index();
    const doc = textToSparseVector("repeated content");
    index.addDocument("a", doc);
    const before = index.documentCount;
    index.addDocument("a", doc);
    expect(index.documentCount).toBe(before);
  });

  it("removeDocument reverses addDocument's contribution to document count", () => {
    const index = new Bm25Index();
    const doc = textToSparseVector("some content");
    index.addDocument("a", doc);
    expect(index.documentCount).toBe(1);
    index.removeDocument("a", doc);
    expect(index.documentCount).toBe(0);
  });

  it("ignores removal of an id that was never added", () => {
    const index = new Bm25Index();
    const doc = textToSparseVector("some content");
    expect(() => index.removeDocument("missing", doc)).not.toThrow();
    expect(index.documentCount).toBe(0);
  });

  it("re-adding the same id with a disjoint term set matches a freshly-built index over only the final vectors (regression: addDocument used to remove the NEW vector's terms instead of the OLD one's, permanently corrupting documentFrequency)", () => {
    const sharedOld = textToSparseVector("apple apple banana");
    const sharedNew = textToSparseVector("zebra yak");
    const other = textToSparseVector("apple citrus");

    const rebuilt = new Bm25Index();
    rebuilt.addDocument("shared", sharedOld);
    rebuilt.addDocument("other", other);
    // Re-add "shared" with a completely different term set — this is the
    // idempotent-upsert path under test.
    rebuilt.addDocument("shared", sharedNew);

    const fresh = new Bm25Index();
    fresh.addDocument("shared", sharedNew);
    fresh.addDocument("other", other);

    expect(rebuilt.documentCount).toBe(fresh.documentCount);

    // A query touching "apple" (only ever in the OLD "shared" vector and in
    // "other") exercises documentFrequency directly: under the bug, "apple"
    // stayed at df=2 forever (the stale contribution from the old "shared"
    // vector was never decremented), understating its IDF against both
    // documents compared to a correctly-built index where df=1.
    const query = textToSparseVector("apple zebra");
    expect(rebuilt.score(query, sharedNew)).toBe(fresh.score(query, sharedNew));
    expect(rebuilt.score(query, other)).toBe(fresh.score(query, other));
  });
});
