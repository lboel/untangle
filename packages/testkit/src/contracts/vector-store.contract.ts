/**
 * Port-contract suite for `VectorStore` (domain `ports.ts`).
 *
 * Written entirely against the public `VectorStore` signature, so it runs
 * unchanged against `InMemoryVectorStore` (self-test, see
 * `vector-store.contract.self-test.test.ts`) and, later, the real
 * Qdrant-backed adapter — call `runVectorStoreContract(() => myAdapter())`
 * from that package's own test file.
 *
 * Deliberately OUT of scope (documented, not silently skipped — see README
 * "Entscheidungen"):
 * - `POINT_TOO_LARGE` / byte-budget enforcement (ports.ts's "contract
 *   highlights" comment): Qdrant's actual payload/point size limits are an
 *   adapter-specific constant, not something `CollectionSpecV1` exposes to
 *   test generically — an adapter package should add its own dedicated test
 *   for this against its real size limit;
 * - dense-vector dimensionality / distance-metric ENFORCEMENT (rejecting a
 *   point whose `dense.length` disagrees with `denseDistance`/collection
 *   schema): Qdrant enforces this server-side; an in-memory double has no
 *   schema layer to enforce it against, so asserting this generically would
 *   make the suite fail against `InMemoryVectorStore` for reasons that have
 *   nothing to do with the behavior under test.
 */
import type { CollectionSpecV1, VectorPointV1, VectorStore } from "@untangle-code/domain";
import { isUntangleError } from "@untangle-code/domain";
import { beforeEach, describe, expect, it } from "vitest";

function point(overrides: Partial<VectorPointV1> & { id: string }): VectorPointV1 {
  return { payload: {}, ...overrides };
}

function collectionSpec(name: string, overrides: Partial<CollectionSpecV1> = {}): CollectionSpecV1 {
  return {
    name,
    denseDimensions: 3,
    denseDistance: "Cosine",
    sparseBm25: true,
    onDiskPayload: false,
    ...overrides,
  };
}

/**
 * Runs the `VectorStore` port contract against instances produced by
 * `factory`. Call once per adapter under test, at module scope of a
 * `*.test.ts` file — vitest collects the `describe`/`it` calls made inside.
 */
export function runVectorStoreContract(factory: () => VectorStore | Promise<VectorStore>): void {
  describe("VectorStore port contract", () => {
    let store: VectorStore;

    beforeEach(async () => {
      store = await factory();
    });

    describe("collection lifecycle", () => {
      it("collectionExists is false before ensureCollection, true after", async () => {
        expect(await store.collectionExists("c1")).toBe(false);
        await store.ensureCollection(collectionSpec("c1"));
        expect(await store.collectionExists("c1")).toBe(true);
      });

      it("ensureCollection is idempotent (calling it twice does not throw or duplicate data)", async () => {
        const spec = collectionSpec("c1");
        await store.ensureCollection(spec);
        await store.ensureCollection(spec);
        await store.upsert("c1", [point({ id: "1" })]);
        await store.ensureCollection(spec);
        expect(await store.countByFilter("c1", {})).toBe(1);
      });

      it("read/status methods never create a collection as a side effect (architecture.md §11.5)", async () => {
        await store.collectionExists("ghost");
        await store.hybridQuery("ghost", { limit: 5, withPayload: false });
        await store.retrieve("ghost", ["1"]);
        await store.scroll("ghost", { limit: 5 });
        await store.countByFilter("ghost", {});
        expect(await store.collectionExists("ghost")).toBe(false);
      });

      it("read methods on a never-provisioned collection return safe empty results, never throw", async () => {
        await expect(store.hybridQuery("ghost", { limit: 5, withPayload: false })).resolves.toEqual(
          [],
        );
        await expect(store.retrieve("ghost", ["1"])).resolves.toEqual([]);
        await expect(store.scroll("ghost", { limit: 5 })).resolves.toMatchObject({ points: [] });
        await expect(store.countByFilter("ghost", {})).resolves.toBe(0);
        await expect(store.deleteByFilter("ghost", {})).resolves.toBeUndefined();
      });
    });

    describe("upsert idempotency (spec.md §10.5)", () => {
      it("re-upserting the same id replaces its payload and vectors rather than duplicating it", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [point({ id: "1", dense: [1, 0, 0], payload: { v: 1 } })]);
        await store.upsert("c1", [point({ id: "1", dense: [0, 1, 0], payload: { v: 2 } })]);

        expect(await store.countByFilter("c1", {})).toBe(1);
        const [retrieved] = await store.retrieve("c1", ["1"]);
        expect(retrieved?.payload).toEqual({ v: 2 });
      });

      it("re-upserting with a different sparse term set does not leave stale BM25 statistics behind", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        // A second, stable document keeps document-frequency effects visible.
        await store.upsert("c1", [point({ id: "other", sparse: { indices: [1], values: [1] } })]);
        await store.upsert("c1", [
          point({ id: "shared", sparse: { indices: [1, 2], values: [1, 1] } }),
        ]);
        await store.upsert("c1", [
          // Re-add "shared" with a disjoint term set (index 1 no longer present).
          point({ id: "shared", sparse: { indices: [3], values: [1] } }),
        ]);

        const rebuilt = await store.hybridQuery("c1", {
          sparse: { indices: [1], values: [1] },
          limit: 10,
          withPayload: false,
        });
        // Only "other" still contains term 1 — a query for it must score
        // "shared" as a true non-match (score 0, it holds none of the query
        // terms any more), not still be inflated by the stale contribution
        // its old vector used to make to term 1's popularity. A store may
        // legitimately still list a zero-scoring candidate up to `limit`
        // (Qdrant does), so this checks scores, not list membership.
        expect(rebuilt.find((r) => r.id === "other")?.score).toBeGreaterThan(0);
        expect(rebuilt.find((r) => r.id === "shared")?.score ?? 0).toBe(0);
      });
    });

    describe("deleteByFilter", () => {
      it("removes only points matching the filter", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [
          point({ id: "1", payload: { lang: "ts" } }),
          point({ id: "2", payload: { lang: "py" } }),
        ]);
        await store.deleteByFilter("c1", { must: [{ field: "lang", match: { eq: "ts" } }] });
        expect(await store.countByFilter("c1", {})).toBe(1);
        expect((await store.retrieve("c1", ["2"]))[0]?.id).toBe("2");
      });
    });

    describe("retrieve", () => {
      it("returns points in the order of the requested ids, skipping missing ones", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [point({ id: "1" }), point({ id: "2" }), point({ id: "3" })]);
        const results = await store.retrieve("c1", ["3", "missing", "1"]);
        expect(results.map((r) => r.id)).toEqual(["3", "1"]);
      });

      it("withVectors controls whether dense/sparse vectors are attached", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [point({ id: "1", dense: [1, 2, 3] })]);
        const withoutVectors = await store.retrieve("c1", ["1"]);
        expect(withoutVectors[0]?.dense).toBeUndefined();
        const withVectors = await store.retrieve("c1", ["1"], { withVectors: true });
        expect(withVectors[0]?.dense).toEqual([1, 2, 3]);
      });
    });

    describe("hybridQuery", () => {
      it("dense-only query ranks the closest vector first", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [
          point({ id: "near", dense: [1, 0, 0] }),
          point({ id: "far", dense: [-1, 0, 0] }),
        ]);
        const results = await store.hybridQuery("c1", {
          dense: [1, 0, 0],
          limit: 10,
          withPayload: false,
        });
        expect(results[0]?.id).toBe("near");
      });

      it("respects the final result limit", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [
          point({ id: "1", dense: [1, 0, 0] }),
          point({ id: "2", dense: [0.9, 0.1, 0] }),
          point({ id: "3", dense: [0.1, 0.9, 0] }),
        ]);
        const results = await store.hybridQuery("c1", {
          dense: [1, 0, 0],
          limit: 1,
          withPayload: false,
        });
        expect(results).toHaveLength(1);
      });

      it("applies the payload filter before ranking", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [
          point({ id: "1", dense: [1, 0, 0], payload: { lang: "ts" } }),
          point({ id: "2", dense: [1, 0, 0], payload: { lang: "py" } }),
        ]);
        const results = await store.hybridQuery("c1", {
          dense: [1, 0, 0],
          filter: { must: [{ field: "lang", match: { eq: "py" } }] },
          limit: 10,
          withPayload: false,
        });
        expect(results.map((r) => r.id)).toEqual(["2"]);
      });

      it("withPayload controls whether payload is attached to results", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [point({ id: "1", dense: [1, 0, 0], payload: { a: 1 } })]);
        const withoutPayload = await store.hybridQuery("c1", {
          dense: [1, 0, 0],
          limit: 10,
          withPayload: false,
        });
        expect(withoutPayload[0]?.payload).toBeUndefined();
        const withPayload = await store.hybridQuery("c1", {
          dense: [1, 0, 0],
          limit: 10,
          withPayload: true,
        });
        expect(withPayload[0]?.payload).toEqual({ a: 1 });
      });
    });

    describe("scroll", () => {
      it("pages through every point exactly once when followed to exhaustion", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        const ids = ["a", "b", "c", "d", "e"];
        await store.upsert(
          "c1",
          ids.map((id) => point({ id })),
        );

        const seen: string[] = [];
        let offset: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = await store.scroll("c1", {
            limit: 2,
            ...(offset !== undefined ? { offset } : {}),
          });
          seen.push(...page.points.map((p) => p.id));
          if (page.nextOffset === undefined) {
            break;
          }
          offset = page.nextOffset;
        }
        expect(seen.sort()).toEqual(ids);
      });

      it("nextOffset is absent exactly when the scroll is exhausted", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [point({ id: "only" })]);
        const page = await store.scroll("c1", { limit: 10 });
        expect(page.points.map((p) => p.id)).toEqual(["only"]);
        expect(page.nextOffset).toBeUndefined();
      });
    });

    describe("countByFilter", () => {
      it("counts only points matching the filter", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        await store.upsert("c1", [
          point({ id: "1", payload: { lang: "ts" } }),
          point({ id: "2", payload: { lang: "ts" } }),
          point({ id: "3", payload: { lang: "py" } }),
        ]);
        expect(
          await store.countByFilter("c1", { must: [{ field: "lang", match: { eq: "ts" } }] }),
        ).toBe(2);
      });
    });

    describe("AbortSignal (spec.md §22)", () => {
      it("rejects every long-running method when the signal is already aborted", async () => {
        await store.ensureCollection(collectionSpec("c1"));
        const controller = new AbortController();
        controller.abort();
        const signal = controller.signal;
        await expect(store.collectionExists("c1", { signal })).rejects.toBeDefined();
        await expect(
          store.ensureCollection(collectionSpec("c2"), { signal }),
        ).rejects.toBeDefined();
        await expect(
          store.ensurePayloadIndexes("c1", [{ field: "lang", type: "keyword" }], { signal }),
        ).rejects.toBeDefined();
        await expect(store.upsert("c1", [point({ id: "1" })], { signal })).rejects.toBeDefined();
        await expect(store.deleteByFilter("c1", {}, { signal })).rejects.toBeDefined();
        await expect(
          store.hybridQuery("c1", { limit: 1, withPayload: false }, { signal }),
        ).rejects.toBeDefined();
        await expect(store.retrieve("c1", ["1"], { signal })).rejects.toBeDefined();
        await expect(store.scroll("c1", { limit: 1 }, { signal })).rejects.toBeDefined();
        await expect(store.countByFilter("c1", {}, { signal })).rejects.toBeDefined();
      });
    });

    describe("error shape", () => {
      it("a write against a never-provisioned collection rejects with a typed, retryable-aware error", async () => {
        try {
          await store.upsert("never-provisioned", [point({ id: "1" })]);
          expect.unreachable("upsert against an unprovisioned collection must reject");
        } catch (error) {
          if (isUntangleError(error)) {
            expect(typeof error.retryable).toBe("boolean");
          }
          // Adapters may throw a differently-typed infrastructure error for
          // this case (e.g. a raw Qdrant client error) as long as they
          // reject rather than resolve — only `UntangleError`'s shape is
          // asserted further here.
        }
      });
    });
  });
}
