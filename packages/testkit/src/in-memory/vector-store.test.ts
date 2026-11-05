import { UntangleError } from "@untangle-code/domain";
import type { CollectionSpecV1, VectorPointV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { textToSparseVector } from "../bm25.js";

import { InMemoryVectorStore } from "./vector-store.js";

const SPEC: CollectionSpecV1 = {
  name: "chunks",
  denseDimensions: 3,
  denseDistance: "Cosine",
  sparseBm25: true,
  onDiskPayload: false,
};

function point(overrides: Partial<VectorPointV1> & { id: string }): VectorPointV1 {
  return { payload: {}, ...overrides };
}

describe("InMemoryVectorStore — collection lifecycle", () => {
  it("collectionExists is false until ensureCollection is called", async () => {
    const store = new InMemoryVectorStore();
    expect(await store.collectionExists("chunks")).toBe(false);
    await store.ensureCollection(SPEC);
    expect(await store.collectionExists("chunks")).toBe(true);
  });

  it("upsert throws QDRANT_UNAVAILABLE against a collection that was never provisioned", async () => {
    const store = new InMemoryVectorStore();
    await expect(store.upsert("chunks", [point({ id: "1" })])).rejects.toBeInstanceOf(
      UntangleError,
    );
    await expect(store.upsert("chunks", [point({ id: "1" })])).rejects.toMatchObject({
      code: "QDRANT_UNAVAILABLE",
    });
  });

  it("read methods on a missing collection return safe empty results, never throw", async () => {
    const store = new InMemoryVectorStore();
    expect(await store.retrieve("missing", ["1"])).toEqual([]);
    expect(await store.hybridQuery("missing", { limit: 10, withPayload: false })).toEqual([]);
    expect(await store.scroll("missing", { limit: 10 })).toEqual({ points: [] });
    expect(await store.countByFilter("missing", {})).toBe(0);
  });
});

describe("InMemoryVectorStore — upsert and retrieve", () => {
  it("upsert is idempotent by id and retrieve respects withVectors", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    const original = point({ id: "1", dense: [1, 0, 0], payload: { a: 1 } });
    await store.upsert("chunks", [original]);
    const updated = point({ id: "1", dense: [0, 1, 0], payload: { a: 2 } });
    const result = await store.upsert("chunks", [updated]);
    expect(result.upsertedCount).toBe(1);

    const withoutVectors = await store.retrieve("chunks", ["1"]);
    expect(withoutVectors).toEqual([{ id: "1", payload: { a: 2 } }]);

    const withVectors = await store.retrieve("chunks", ["1"], { withVectors: true });
    expect(withVectors[0]).toEqual(updated);
  });

  it("retrieve skips ids that are not present", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [point({ id: "1" })]);
    expect(await store.retrieve("chunks", ["1", "missing"])).toEqual([{ id: "1", payload: {} }]);
  });

  it("deleteByFilter removes only matching points", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "1", payload: { lang: "ts" } }),
      point({ id: "2", payload: { lang: "py" } }),
    ]);
    await store.deleteByFilter("chunks", { must: [{ field: "lang", match: { eq: "ts" } }] });
    expect(await store.retrieve("chunks", ["1", "2"])).toEqual([
      { id: "2", payload: { lang: "py" } },
    ]);
  });
});

describe("InMemoryVectorStore — hybridQuery", () => {
  it("finds partial identifier terms through the same sparse tokenization as production", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "camel", sparse: textToSparseVector("getUserById") }),
      point({ id: "snake", sparse: textToSparseVector("get_user_by_id") }),
      point({ id: "other", sparse: textToSparseVector("rotateCache") }),
    ]);
    const hits = await store.hybridQuery("chunks", {
      sparse: textToSparseVector("user id"),
      limit: 2,
      withPayload: false,
    });
    expect(hits.map((hit) => hit.id).sort()).toEqual(["camel", "snake"]);
  });

  it("dense-only query ranks by cosine similarity", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "close", dense: [1, 0, 0] }),
      point({ id: "far", dense: [0, 1, 0] }),
    ]);
    const results = await store.hybridQuery("chunks", {
      dense: [1, 0, 0],
      limit: 10,
      withPayload: false,
    });
    expect(results[0]?.id).toBe("close");
    expect(results[0]?.denseScore).toBeCloseTo(1, 10);
  });

  it("sparse-only query ranks by BM25 score", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "match", sparse: textToSparseVector("quick brown fox") }),
      point({ id: "no-match", sparse: textToSparseVector("totally unrelated words") }),
    ]);
    const results = await store.hybridQuery("chunks", {
      sparse: textToSparseVector("quick fox"),
      limit: 10,
      withPayload: false,
    });
    expect(results[0]?.id).toBe("match");
  });

  it("hybrid query fuses dense and sparse branches via RRF when both are present", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({
        id: "both",
        dense: [1, 0, 0],
        sparse: textToSparseVector("quick brown fox"),
      }),
      point({ id: "dense-only", dense: [1, 0, 0] }),
      point({ id: "sparse-only", sparse: textToSparseVector("quick brown fox") }),
    ]);
    const results = await store.hybridQuery("chunks", {
      dense: [1, 0, 0],
      sparse: textToSparseVector("quick fox"),
      limit: 10,
      withPayload: false,
    });
    // Ranked first in both branches, so it must fuse to the top.
    expect(results[0]?.id).toBe("both");
  });

  it("applies the payload filter before ranking", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "1", dense: [1, 0, 0], payload: { lang: "ts" } }),
      point({ id: "2", dense: [1, 0, 0], payload: { lang: "py" } }),
    ]);
    const results = await store.hybridQuery("chunks", {
      dense: [1, 0, 0],
      filter: { must: [{ field: "lang", match: { eq: "py" } }] },
      limit: 10,
      withPayload: false,
    });
    expect(results.map((r) => r.id)).toEqual(["2"]);
  });

  it("withPayload controls whether payload is attached to results", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [point({ id: "1", dense: [1, 0, 0], payload: { a: 1 } })]);
    const withoutPayload = await store.hybridQuery("chunks", {
      dense: [1, 0, 0],
      limit: 10,
      withPayload: false,
    });
    expect(withoutPayload[0]?.payload).toBeUndefined();

    const withPayload = await store.hybridQuery("chunks", {
      dense: [1, 0, 0],
      limit: 10,
      withPayload: true,
    });
    expect(withPayload[0]?.payload).toEqual({ a: 1 });
  });

  it("respects the final result limit after fusion", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "1", dense: [1, 0, 0] }),
      point({ id: "2", dense: [0.9, 0.1, 0] }),
      point({ id: "3", dense: [0.1, 0.9, 0] }),
    ]);
    const results = await store.hybridQuery("chunks", {
      dense: [1, 0, 0],
      limit: 1,
      withPayload: false,
    });
    expect(results).toHaveLength(1);
  });
});

describe("InMemoryVectorStore — scroll and countByFilter", () => {
  it("scroll pages through points in a stable id order", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [point({ id: "a" }), point({ id: "b" }), point({ id: "c" })]);

    const firstPage = await store.scroll("chunks", { limit: 2 });
    expect(firstPage.points.map((p) => p.id)).toEqual(["a", "b"]);
    expect(firstPage.nextOffset).toBe("b");

    const secondPage = await store.scroll("chunks", {
      limit: 2,
      ...(firstPage.nextOffset !== undefined ? { offset: firstPage.nextOffset } : {}),
    });
    expect(secondPage.points.map((p) => p.id)).toEqual(["c"]);
    expect(secondPage.nextOffset).toBeUndefined();
  });

  it("scroll resumes correctly when the last-seen point was deleted (regression: used to silently restart at the beginning)", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "a", payload: { pid: "a" } }),
      point({ id: "b", payload: { pid: "b" } }),
      point({ id: "c", payload: { pid: "c" } }),
    ]);

    const firstPage = await store.scroll("chunks", { limit: 2 });
    expect(firstPage.points.map((p) => p.id)).toEqual(["a", "b"]);
    expect(firstPage.nextOffset).toBe("b");

    // "b" (the cursor the caller is about to resume from) is deleted
    // independently, between this scroll call and the next one.
    await store.deleteByFilter("chunks", { must: [{ field: "pid", match: { eq: "b" } }] });

    const resumed = await store.scroll("chunks", { limit: 2, offset: "b" });
    // Must resume at "c" (the next surviving point after "b" in sort order),
    // never restart at "a".
    expect(resumed.points.map((p) => p.id)).toEqual(["c"]);
    expect(resumed.nextOffset).toBeUndefined();
  });

  it("scroll with a foreign/never-issued offset past all current ids yields an empty, exhausted page instead of restarting", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [point({ id: "a" }), point({ id: "b" }), point({ id: "c" })]);

    const page = await store.scroll("chunks", { limit: 2, offset: "zzz-does-not-exist" });
    expect(page.points).toEqual([]);
    expect(page.nextOffset).toBeUndefined();
  });

  it("scroll with limit 0 and an existing offset reports NOT exhausted (unchanged cursor) when data remains (regression: limit 0 used to always look exhausted)", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [point({ id: "a" }), point({ id: "b" }), point({ id: "c" })]);

    const page = await store.scroll("chunks", { limit: 0, offset: "a" });
    expect(page.points).toEqual([]);
    // Cursor is handed back unchanged — nothing was consumed.
    expect(page.nextOffset).toBe("a");
  });

  it("scroll with limit 0 at a truly exhausted offset correctly reports exhaustion", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [point({ id: "a" }), point({ id: "b" })]);

    const page = await store.scroll("chunks", { limit: 0, offset: "b" });
    expect(page.points).toEqual([]);
    expect(page.nextOffset).toBeUndefined();
  });

  it("scroll with limit 0 and no offset on a non-empty collection throws rather than silently claiming exhaustion", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [point({ id: "a" })]);

    await expect(store.scroll("chunks", { limit: 0 })).rejects.toThrow();
  });

  it("scroll with limit 0 and no offset on an empty collection does not throw (nothing to be dishonest about)", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);

    const page = await store.scroll("chunks", { limit: 0 });
    expect(page.points).toEqual([]);
    expect(page.nextOffset).toBeUndefined();
  });

  it("countByFilter counts only matching points", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(SPEC);
    await store.upsert("chunks", [
      point({ id: "1", payload: { lang: "ts" } }),
      point({ id: "2", payload: { lang: "ts" } }),
      point({ id: "3", payload: { lang: "py" } }),
    ]);
    expect(
      await store.countByFilter("chunks", { must: [{ field: "lang", match: { eq: "ts" } }] }),
    ).toBe(2);
  });
});
