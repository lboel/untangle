import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { connect, makeArrowTable, Query, QueryBase } from "@lancedb/lancedb";
import type { CollectionSpecV1, PayloadFilter } from "@untangle-code/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_FILTER_TOKEN_BYTES, nativeFilter, scalarToken } from "./filters.js";
import { COMPACTION_FRAGMENT_LIMIT, MANAGED_INDEXES } from "./maintenance.js";
import { collectionTableName, encodePoint, pointSchema, storedId } from "./schema.js";
import { LanceDbVectorStore } from "./vector-store.js";

const spec: CollectionSpecV1 = {
  name: "points",
  denseDimensions: 3,
  denseDistance: "Cosine",
  sparseBm25: true,
  onDiskPayload: true,
};
let root: string;
let store: LanceDbVectorStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "untangle-lance-scale-"));
  store = new LanceDbVectorStore({ path: root });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await rm(root, { recursive: true, force: true });
});

describe("native scaling and retained snapshots", () => {
  it("pages 12,504 native grep rows with at most two global key sorts per page", async () => {
    await store.ensureCollection(spec);
    const ids = Array.from({ length: 12504 }, (_, i) => String(i).padStart(5, "0"));
    await store.upsert(
      spec.name,
      ids.map((id) => ({
        id,
        payload: {
          point_type: "code_chunk",
          workspace_id: "workspace",
          body: "const example = true",
        },
      })),
    );
    const orderBy = vi.spyOn(Query.prototype, "orderBy");
    const seen: string[] = [];
    let offset: string | undefined;
    let pages = 0;
    do {
      const page = await store.scroll(spec.name, {
        limit: 256,
        filter: {
          must: [
            { field: "point_type", match: { eq: "code_chunk" } },
            { field: "workspace_id", match: { eq: "workspace" } },
          ],
        },
        ...(offset ? { offset } : {}),
      });
      pages += 1;
      seen.push(...page.points.map((point) => point.id));
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(seen).toEqual(ids);
    expect(orderBy.mock.calls.length).toBeLessThanOrEqual(2 * pages);
  });

  it("keeps ordered-key and payload reads on the same pinned version across concurrent changes", async () => {
    await store.ensureCollection(spec);
    await store.upsert(
      spec.name,
      Array.from({ length: 40 }, (_, i) => ({
        id: String(i).padStart(3, "0"),
        payload: { ordinal: i, revision: "old" },
      })),
    );
    const writer = new LanceDbVectorStore({ path: root });
    const original = QueryBase.prototype.toArray;
    let changed = false;
    vi.spyOn(QueryBase.prototype, "toArray").mockImplementation(async function (
      this: QueryBase<never>,
      ...options: Parameters<typeof original>
    ) {
      const rows = await original.call(this, ...options);
      if (
        !changed &&
        rows.length &&
        rows[0]["id_order"] !== undefined &&
        rows[0]["payload"] === undefined
      ) {
        changed = true;
        await writer.upsert(spec.name, [{ id: "016", payload: { ordinal: 16, revision: "new" } }]);
        await writer.deleteByFilter(spec.name, { must: [{ field: "ordinal", match: { eq: 17 } }] });
      }
      return rows;
    });
    try {
      const page = await store.scroll(spec.name, { limit: 40 });
      expect(changed).toBe(true);
      expect(page.points).toHaveLength(40);
      expect(page.points.find((point) => point.id === "016")?.payload["revision"]).toBe("old");
      expect(page.points.some((point) => point.id === "017")).toBe(true);
      vi.restoreAllMocks();
      const latest = await store.scroll(spec.name, { limit: 40 });
      expect(latest.points).toHaveLength(39);
      expect(latest.points.find((point) => point.id === "016")?.payload["revision"]).toBe("new");
      expect(latest.points.some((point) => point.id === "017")).toBe(false);
    } finally {
      await writer.close();
    }
  });

  it("ranks 12,504 real rows through one projected Arrow iterator without OFFSET queries", async () => {
    await store.ensureCollection(spec);
    await store.upsert(
      spec.name,
      Array.from({ length: 12504 }, (_, i) => ({
        id: String(i).padStart(5, "0"),
        dense: [1, 0, 0],
        sparse: { indices: i === 12503 ? [1, 2] : [1], values: i === 12503 ? [1, 1] : [1] },
        payload: { ordinal: i },
      })),
    );
    const stream = vi.spyOn(QueryBase.prototype, Symbol.asyncIterator);
    const hits = await store.hybridQuery(spec.name, {
      sparse: { indices: [2], values: [1] },
      limit: 5,
      withPayload: true,
    });
    expect(hits.map((hit) => hit.id)).toEqual(["12503"]);
    expect(hits[0]?.payload).toEqual({ ordinal: 12503 });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("keeps lexical scans independent of dense width and the dense scan byte budget", async () => {
    await store.ensureCollection({ ...spec, denseDimensions: 512 });
    await store.upsert(spec.name, [
      {
        id: "lexical",
        dense: Array.from({ length: 512 }, () => 1),
        sparse: { indices: [7], values: [1] },
        payload: {},
      },
    ]);
    const bounded = new LanceDbVectorStore({ path: root, scanBudgetBytes: 256 });
    try {
      expect(
        (
          await bounded.hybridQuery(spec.name, {
            sparse: { indices: [7], values: [1] },
            limit: 1,
            withPayload: false,
          })
        ).map((hit) => hit.id),
      ).toEqual(["lexical"]);
      await expect(
        bounded.hybridQuery(spec.name, {
          dense: Array.from({ length: 512 }, () => 1),
          limit: 1,
          withPayload: false,
        }),
      ).rejects.toMatchObject({ code: "LANCEDB_UNAVAILABLE", retryable: false });
    } finally {
      await bounded.close();
    }
  });

  it("maintains real selective indexes and bounded fragments while preserving every old version and a pinned reader", async () => {
    await store.ensureCollection(spec);
    await store.upsert(spec.name, [
      { id: "anchor", payload: { revision: "old", group: "anchor" } },
    ]);
    const db = await connect(root, { readConsistencyInterval: 0 });
    const current = await db.openTable(collectionTableName(spec.name));
    const pinned = await db.openTable(collectionTableName(spec.name));
    try {
      const version = await pinned.version();
      await pinned.checkout(version);
      const versionsBefore = (await current.listVersions()).map((entry) => entry.version);
      for (let i = 0; i < 80; i += 1)
        await store.upsert(spec.name, [{ id: "row-" + i, payload: { group: "row", i } }]);
      await store.upsert(spec.name, [
        { id: "anchor", payload: { revision: "new", group: "anchor" } },
      ]);
      const indices = await current.listIndices();
      expect(indices.map((index) => index.name).sort()).toEqual(
        MANAGED_INDEXES.map((index) => index.name).sort(),
      );
      expect((await current.stats()).fragmentStats.numSmallFragments).toBeLessThan(
        COMPACTION_FRAGMENT_LIMIT,
      );
      const stats = await current.indexStats("untangle_filter_tokens_v1");
      // Updating anchor removes its old indexed row; only live rows count.
      expect((stats?.numIndexedRows ?? 0) + (stats?.numUnindexedRows ?? 0)).toBe(81);
      expect(stats?.numUnindexedRows).toBeLessThan(COMPACTION_FRAGMENT_LIMIT);
      const predicate = nativeFilter({ must: [{ field: "group", match: { eq: "anchor" } }] })!;
      expect(await current.query().where(predicate).explainPlan()).toContain("ScalarIndexQuery");
      expect(await pinned.countRows()).toBe(1);
      const old = await pinned
        .query()
        .where(`id = '${storedId("anchor")}'`)
        .select(["payload"])
        .toArray();
      expect(JSON.parse(old[0].payload as string)).toEqual({ revision: "old", group: "anchor" });
      expect((await current.listVersions()).map((entry) => entry.version)).toEqual(
        expect.arrayContaining(versionsBefore),
      );
      const reopened = new LanceDbVectorStore({ path: root });
      try {
        expect((await reopened.retrieve(spec.name, ["anchor"]))[0]?.payload).toEqual({
          revision: "new",
          group: "anchor",
        });
      } finally {
        await reopened.close();
      }
    } finally {
      pinned.close();
      current.close();
      db.close();
    }
  });

  it("keeps encoded-byte boundary, Unicode, NUL and mixed long-token filters exact, including deletes", async () => {
    await store.ensureCollection(spec);
    const field = "value\0🐑";
    const boundary = "x".repeat(MAX_FILTER_TOKEN_BYTES - Buffer.byteLength(scalarToken(field, "")));
    const over = boundary + "x",
      unicode = "🐑".repeat(1024),
      nul = "\0".repeat(1024),
      longField = "k".repeat(MAX_FILTER_TOKEN_BYTES);
    const points = [
      { id: "boundary", payload: { [field]: boundary } },
      { id: "over", payload: { [field]: over } },
      { id: "unicode", payload: { [field]: unicode } },
      { id: "nul", payload: { [field]: nul } },
      { id: "short", payload: { [field]: "short" } },
      { id: "long-field", payload: { [longField]: true } },
      { id: "missing", payload: {} },
    ];
    const cases = [
      { condition: { field, match: { eq: boundary } }, ids: ["boundary"], native: true },
      { condition: { field, match: { eq: over } }, ids: ["over"], native: false },
      {
        condition: { field, match: { in: ["short", over] } },
        ids: ["over", "short"],
        native: false,
      },
      { condition: { field, match: { eq: unicode } }, ids: ["unicode"], native: false },
      { condition: { field, match: { eq: nul } }, ids: ["nul"], native: false },
      { condition: { field: longField, match: { eq: true } }, ids: ["long-field"], native: false },
    ];
    for (const entry of cases)
      for (const clause of ["must", "mustNot"] as const) {
        await store.upsert(spec.name, points);
        const filter: PayloadFilter = { [clause]: [entry.condition] };
        expect(nativeFilter(filter) !== null).toBe(entry.native);
        const expected = points
          .map((point) => point.id)
          .filter((id) => (clause === "must" ? entry.ids.includes(id) : !entry.ids.includes(id)))
          .sort();
        const preserved = points
          .map((point) => point.id)
          .filter((id) => !expected.includes(id))
          .sort();
        expect(await store.countByFilter(spec.name, filter)).toBe(expected.length);
        expect(
          (await store.scroll(spec.name, { filter, limit: 20 })).points.map((point) => point.id),
        ).toEqual(expected);
        await store.deleteByFilter(spec.name, filter);
        expect(
          (await store.scroll(spec.name, { limit: 20 })).points.map((point) => point.id),
        ).toEqual(preserved);
      }
  });

  it("reports committed IDs accurately when native maintenance fails and releases the writer guard", async () => {
    await store.ensureCollection(spec);
    for (let i = 0; i < 31; i += 1)
      await store.upsert(spec.name, [{ id: "row-" + i, payload: {} }]);
    const db = await connect(root, { readConsistencyInterval: 0 });
    const table = await db.openTable(collectionTableName(spec.name));
    const prototype = Object.getPrototypeOf(table) as typeof table;
    const optimize = vi
      .spyOn(prototype, "optimize")
      .mockRejectedValueOnce(new Error("native maintenance refused"));
    try {
      const error: unknown = await store
        .upsert(spec.name, [{ id: "committed", payload: { persisted: true } }])
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code: "LANCEDB_UNAVAILABLE",
        context: { upsertedCount: 1, maintenanceFailed: true, mayHaveCommitted: true },
      });
      expect(error).not.toHaveProperty("context.failedIds");
      expect((await store.retrieve(spec.name, ["committed"]))[0]?.payload).toEqual({
        persisted: true,
      });
      optimize.mockRestore();
      await expect(
        store.upsert(spec.name, [{ id: "after-failure", payload: {} }]),
      ).resolves.toEqual({ upsertedCount: 1 });
    } finally {
      optimize.mockRestore();
      table.close();
      db.close();
    }
  });

  it("upgrades an existing indexless collection only on explicit ensure, without changing points", async () => {
    await store.ensureCollection(spec);
    await store.upsert(spec.name, [{ id: "existing", payload: { preserved: true } }]);
    const db = await connect(root, { readConsistencyInterval: 0 });
    const table = await db.openTable(collectionTableName(spec.name));
    try {
      for (const index of await table.listIndices()) await table.dropIndex(index.name);
      // R2 persisted uncapped tokens. Upgrade must also accept those real
      // legacy rows; new encoding alone would not characterize this case.
      const blob = "x".repeat(700_000);
      const legacy = {
        ...encodePoint({ id: "legacy", payload: { blob } }, spec),
        filter_tokens: [scalarToken("blob", blob)],
      };
      await table.add(makeArrowTable([legacy], { schema: await pointSchema(spec) }));
      expect(await table.listIndices()).toEqual([]);
      expect(await store.collectionExists(spec.name)).toBe(true);
      expect((await store.retrieve(spec.name, ["existing"]))[0]?.payload).toEqual({
        preserved: true,
      });
      expect((await store.retrieve(spec.name, ["legacy"]))[0]?.payload["blob"]).toHaveLength(
        700_000,
      );
      expect(await table.listIndices()).toEqual([]);
      await store.ensureCollection(spec);
      expect((await table.listIndices()).map((index) => index.name).sort()).toEqual(
        MANAGED_INDEXES.map((index) => index.name).sort(),
      );
      expect((await store.retrieve(spec.name, ["existing"]))[0]?.payload).toEqual({
        preserved: true,
      });
      expect(
        (
          await store.scroll(spec.name, {
            filter: { must: [{ field: "blob", match: { eq: blob } }] },
            limit: 5,
          })
        ).points.map((point) => point.id),
      ).toEqual(["legacy"]);
    } finally {
      table.close();
      db.close();
    }
  });

  it("checks cancellation after an actual native Arrow batch arrives and closes the iterator", async () => {
    await store.ensureCollection(spec);
    await store.upsert(spec.name, [
      { id: "point", sparse: { indices: [1], values: [1] }, payload: {} },
    ]);
    const controller = new AbortController();
    const original = QueryBase.prototype[Symbol.asyncIterator];
    let returned = false;
    vi.spyOn(QueryBase.prototype, Symbol.asyncIterator).mockImplementation(function (
      this: QueryBase<never>,
    ) {
      const iterator = original.call(this);
      return {
        next: async () => {
          const batch = await iterator.next();
          controller.abort();
          return batch;
        },
        return: async () => {
          returned = true;
          return iterator.return ? iterator.return() : { done: true, value: undefined };
        },
      };
    });
    await expect(
      store.hybridQuery(
        spec.name,
        { sparse: { indices: [1], values: [1] }, limit: 1, withPayload: false },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    expect(returned).toBe(true);
    vi.restoreAllMocks();
    expect((await store.retrieve(spec.name, ["point"]))[0]?.id).toBe("point");
  });
});
