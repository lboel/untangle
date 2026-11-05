/**
 * Cross-collection rule (spec.md §13.4): RRF scores of separate collections
 * are never sorted as absolute relevance; same-profile collections merge by
 * rank; incompatible profiles yield separate groups plus an explicit notice.
 */
import { describe, expect, it } from "vitest";

import { textToBm25SparseVector } from "./bm25-text.js";
import {
  PROFILE_SEPARATION_NOTICE,
  hybridQueryAcrossCollections,
  mergeAcrossCollections,
} from "./cross-collection.js";
import { FakeQdrantServer } from "./testing/fake-qdrant-server.js";
import { QdrantVectorStore } from "./vector-store.js";

describe("mergeAcrossCollections (spec.md §13.4)", () => {
  it("keeps incompatible profiles in separate groups and adds the separation notice", () => {
    const merged = mergeAcrossCollections([
      {
        collection: "code_a",
        embeddingProfileId: "profile-a",
        results: [{ id: "x", score: 0.03 }],
      },
      {
        collection: "code_b",
        embeddingProfileId: "profile-b",
        results: [{ id: "y", score: 0.9 }],
      },
    ]);
    expect(merged.groups).toHaveLength(2);
    expect(merged.profileSeparation).toBe(true);
    expect(merged.notice).toBe(PROFILE_SEPARATION_NOTICE);
    // Group order follows input order, NOT descending raw score — a raw
    // 0.9 from another collection must not outrank anything.
    expect(merged.groups.map((group) => group.embeddingProfileId)).toEqual([
      "profile-a",
      "profile-b",
    ]);
    expect(merged.groups[0]?.results[0]?.collection).toBe("code_a");
  });

  it("merges same-profile collections by RANK, never by raw RRF score", () => {
    // Collection A's raw scores are 30x larger than B's. Sorting raw scores
    // would put both A hits first; rank fusion interleaves the two #1 hits
    // before the two #2 hits.
    const merged = mergeAcrossCollections([
      {
        collection: "a",
        embeddingProfileId: "p",
        results: [
          { id: "a-first", score: 0.9 },
          { id: "a-second", score: 0.8 },
        ],
      },
      {
        collection: "b",
        embeddingProfileId: "p",
        results: [
          { id: "b-first", score: 0.03 },
          { id: "b-second", score: 0.02 },
        ],
      },
    ]);
    expect(merged.groups).toHaveLength(1);
    expect(merged.profileSeparation).toBe(false);
    expect(merged.notice).toBeUndefined();
    const order = merged.groups[0]?.results.map((point) => point.id) ?? [];
    expect(order.slice(0, 2).sort()).toEqual(["a-first", "b-first"]);
    expect(order.slice(2).sort()).toEqual(["a-second", "b-second"]);
  });

  it("keeps identical point ids from different collections distinct", () => {
    const merged = mergeAcrossCollections([
      { collection: "a", embeddingProfileId: "p", results: [{ id: "same", score: 0.5 }] },
      { collection: "b", embeddingProfileId: "p", results: [{ id: "same", score: 0.4 }] },
    ]);
    const results = merged.groups[0]?.results ?? [];
    expect(results).toHaveLength(2);
    expect(new Set(results.map((point) => point.collection)).size).toBe(2);
  });

  it("applies limitPerGroup after fusion", () => {
    const merged = mergeAcrossCollections(
      [
        {
          collection: "a",
          embeddingProfileId: "p",
          results: [
            { id: "1", score: 3 },
            { id: "2", score: 2 },
            { id: "3", score: 1 },
          ],
        },
      ],
      { limitPerGroup: 2 },
    );
    expect(merged.groups[0]?.results).toHaveLength(2);
  });
});

describe("hybridQueryAcrossCollections", () => {
  it("queries every target collection and groups by profile with the notice", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    for (const name of ["untangle_code_aaaa_v1", "untangle_code_bbbb_v1"]) {
      await store.ensureCollection({
        name,
        denseDimensions: 3,
        denseDistance: "Cosine",
        sparseBm25: true,
        onDiskPayload: true,
      });
    }
    await store.upsert("untangle_code_aaaa_v1", [
      {
        id: "a-hit",
        dense: [1, 0, 0],
        sparse: textToBm25SparseVector("resolve import"),
        payload: {},
      },
    ]);
    await store.upsert("untangle_code_bbbb_v1", [
      {
        id: "b-hit",
        dense: [1, 0, 0],
        sparse: textToBm25SparseVector("resolve import"),
        payload: {},
      },
    ]);

    const query = {
      dense: [1, 0, 0],
      sparse: textToBm25SparseVector("resolve"),
      limit: 5,
      withPayload: false,
    };
    const merged = await hybridQueryAcrossCollections(store, [
      { collection: "untangle_code_aaaa_v1", embeddingProfileId: "profile-a", query },
      { collection: "untangle_code_bbbb_v1", embeddingProfileId: "profile-b", query },
    ]);
    expect(merged.groups).toHaveLength(2);
    expect(merged.profileSeparation).toBe(true);
    expect(merged.notice).toBe(PROFILE_SEPARATION_NOTICE);
    expect(merged.groups[0]?.results[0]?.id).toBe("a-hit");
    expect(merged.groups[1]?.results[0]?.id).toBe("b-hit");
  });
});
