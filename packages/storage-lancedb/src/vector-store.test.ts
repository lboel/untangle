import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { connect } from "@lancedb/lancedb";
import type { CollectionSpecV1, PayloadFilter } from "@untangle-code/domain";
import { FakeClock } from "@untangle-code/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLanceDbStorage } from "./factory.js";
import { matchesFilter } from "./filters.js";
import { CATALOG_TABLE, collectionTableName } from "./schema.js";
import { LanceDbVectorStore } from "./vector-store.js";

const spec: CollectionSpecV1 = {
  name: "points",
  denseDimensions: 3,
  denseDistance: "Cosine",
  sparseBm25: true,
  onDiskPayload: true,
};
let root: string;
let dbPath: string;
const stores: LanceDbVectorStore[] = [];

function store(
  options: Partial<ConstructorParameters<typeof LanceDbVectorStore>[0]> = {},
): LanceDbVectorStore {
  const result = new LanceDbVectorStore({ path: dbPath, ...options });
  stores.push(result);
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "untangle-lance-native-"));
  dbPath = path.join(root, "db");
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((instance) => instance.close()));
  await rm(root, { recursive: true, force: true });
});

describe("native Lance storage", () => {
  it.each(["must", "should", "mustNot"] as const)(
    "preserves empty-key and nested-array %s semantics for native counts, pages and deletes",
    async (clause) => {
      const current = store();
      await current.ensureCollection(spec);
      const points = [
        { id: "a", payload: { "": { child: "x" }, a: [[1], [2]] } },
        { id: "b", payload: { "": [{ child: "x" }, { child: "y" }], a: [[]] } },
        { id: "c", payload: { "": { child: "z" }, a: [[3, 4]] } },
        { id: "d", payload: {} },
        { id: "e", payload: { "": { child: "x" }, ".child": "literal", a: [[5]], "a.0": 9 } },
        { id: "f", payload: { "": { child: [true, 5] }, a: [[[1]]] } },
        { id: "g", payload: { "": { "": { child: "deep" } } } },
        { id: "h", payload: { a: [[[[1]]]] } },
      ];
      const conditions = [
        { field: ".child", match: { eq: "x" } },
        { field: ".child", match: { in: ["x", "y"] } },
        { field: ".child", match: { eq: true } },
        { field: ".child", match: { eq: "literal" } },
        { field: "..child", match: { eq: "deep" } },
        { field: "a.0", match: { eq: 1 } },
        { field: "a.0", match: { eq: 9 } },
        { field: "a.length", match: { eq: 0 } },
        { field: "a.length", match: { eq: 2 } },
        { field: "a.0.0", match: { eq: 1 } },
      ];
      const matchedIds = [
        ["a", "b"],
        ["a", "b"],
        ["f"],
        ["e"],
        ["g"],
        ["a", "f"],
        ["e"],
        ["b"],
        ["c"],
        ["h"],
      ];
      for (const [index, condition] of conditions.entries()) {
        await current.upsert(spec.name, points);
        const filter: PayloadFilter = { [clause]: [condition] };
        const expected = points
          .filter((point) => matchesFilter(point.payload, filter))
          .map((point) => point.id);
        expect(expected, JSON.stringify(filter)).toEqual(
          clause === "mustNot"
            ? points.map((point) => point.id).filter((id) => !matchedIds[index]!.includes(id))
            : matchedIds[index],
        );
        const preserved = points
          .filter((point) => !matchesFilter(point.payload, filter))
          .map((point) => point.id);
        expect(await current.countByFilter(spec.name, filter), JSON.stringify(filter)).toBe(
          expected.length,
        );
        expect(
          (await current.scroll(spec.name, { filter, limit: 10 })).points.map((point) => point.id),
          JSON.stringify(filter),
        ).toEqual(expected);
        await current.deleteByFilter(spec.name, filter);
        expect(
          (await current.scroll(spec.name, { limit: 10 })).points.map((point) => point.id),
          JSON.stringify(filter),
        ).toEqual(preserved);
      }
    },
  );

  it("rejects payload-index requests on absent roots/catalogs without creating storage", async () => {
    await expect(
      store().ensurePayloadIndexes("missing", [{ field: "repo", type: "keyword" }]),
    ).rejects.toMatchObject({ code: "LANCEDB_UNAVAILABLE", retryable: false });
    expect(await readdir(root)).toEqual([]);
    await mkdir(dbPath);
    await expect(
      store().ensurePayloadIndexes("missing", [{ field: "repo", type: "keyword" }]),
    ).rejects.toMatchObject({ code: "LANCEDB_UNAVAILABLE", retryable: false });
    expect(await readdir(dbPath)).toEqual([]);
  });

  it("pages 1,024 native rows and cleans a graph shard without decoding the whole corpus per call", async () => {
    const writer = store();
    await writer.ensureCollection(spec);
    await writer.upsert(
      spec.name,
      Array.from({ length: 1024 }, (_, i) => ({
        id: String(i).padStart(5, "0"),
        payload: {
          point_type: "graph_shard_part",
          logical_shard_id: "shard-" + i,
          generation_id: "g1",
          write_id: "old",
          written_at_epoch_ms: 1,
        },
      })),
    );
    const bounded = store({ scanMaxRows: 65 });
    const seen: string[] = [];
    let offset: string | undefined;
    do {
      const page = await bounded.scroll(spec.name, { limit: 64, ...(offset ? { offset } : {}) });
      seen.push(...page.points.map((point) => point.id));
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(seen).toEqual(Array.from({ length: 1024 }, (_, i) => String(i).padStart(5, "0")));
    expect(await bounded.countByFilter(spec.name, {})).toBe(1024);
    await bounded.deleteByFilter(spec.name, {
      must: [
        { field: "point_type", match: { eq: "graph_shard_part" } },
        { field: "logical_shard_id", match: { eq: "shard-512" } },
        { field: "generation_id", match: { eq: "g1" } },
        { field: "written_at_epoch_ms", range: { lt: 2 } },
      ],
      mustNot: [{ field: "write_id", match: { eq: "current" } }],
    });
    expect(await bounded.countByFilter(spec.name, {})).toBe(1023);
    expect(
      (await bounded.retrieve(spec.name, ["00511", "00512", "00513"])).map((point) => point.id),
    ).toEqual(["00511", "00513"]);
  });

  it("preserves UTF-16 logical order across native seek pages, including supplementary and lone-surrogate IDs", async () => {
    const current = store();
    await current.ensureCollection(spec);
    const ids = ["\ue000", "🐑", "\ud800", "\ud7ff", "A", "A\0", "quote'", "\udfff"];
    await current.upsert(
      spec.name,
      ids.map((id) => ({ id, payload: {} })),
    );
    const actual: string[] = [];
    let offset: string | undefined;
    do {
      const page = await current.scroll(spec.name, { limit: 1, ...(offset ? { offset } : {}) });
      actual.push(...page.points.map((point) => point.id));
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(actual).toEqual([...ids].sort());
  });

  it("native promoted predicates preserve array/dotted-key/missing-field and Boolean filter semantics", async () => {
    const current = store();
    await current.ensureCollection(spec);
    const points = [
      {
        id: "a",
        payload: {
          "a.b": "literal",
          a: { b: "shadowed" },
          tags: ["ts", true, 0],
          owners: [{ role: "search" }, { role: "cli" }],
          written_at_epoch_ms: [1, 4],
        },
      },
      {
        id: "b",
        payload: {
          a: { b: "nested" },
          tags: ["py", false],
          owners: [{ role: "cli" }],
          written_at_epoch_ms: 3,
        },
      },
      { id: "c", payload: { tags: [], owners: [], written_at_epoch_ms: [] } },
      { id: "d", payload: {} },
    ];
    await current.upsert(spec.name, points);
    const filters: PayloadFilter[] = [
      { must: [{ field: "a.b", match: { eq: "literal" } }] },
      { must: [{ field: "a.b", match: { eq: "shadowed" } }] },
      { must: [{ field: "owners.role", match: { in: ["search"] } }] },
      { mustNot: [{ field: "owners.role", match: { eq: "cli" } }] },
      {
        should: [
          { field: "tags", match: { eq: true } },
          { field: "a.b", match: { eq: "nested" } },
        ],
      },
      { must: [{ field: "tags", match: { eq: -0 } }] },
      { must: [{ field: "missing", match: { in: [] } }] },
      ...(["lt", "lte", "gt", "gte"] as const).map((bound) => ({
        must: [{ field: "written_at_epoch_ms", range: { [bound]: 3 } }],
      })),
      { must: [{ field: "written_at_epoch_ms", range: { gt: 1, lt: 4 } }] },
    ];
    for (const filter of filters) {
      const expected = points
        .filter((point) => matchesFilter(point.payload, filter))
        .map((point) => point.id);
      expect(await current.countByFilter(spec.name, filter), JSON.stringify(filter)).toBe(
        expected.length,
      );
      expect(
        (await current.scroll(spec.name, { filter, limit: 10 })).points.map((point) => point.id),
        JSON.stringify(filter),
      ).toEqual(expected);
    }
  });

  it("factory and every absent-path read leave the filesystem untouched", async () => {
    const storage = createLanceDbStorage({ path: dbPath, clock: new FakeClock(0) });
    expect(await readdir(root)).toEqual([]);
    expect(await storage.vectorStore.collectionExists("ghost")).toBe(false);
    expect(await storage.vectorStore.countByFilter("ghost", {})).toBe(0);
    expect(await storage.vectorStore.retrieve("ghost", ["id"])).toEqual([]);
    expect(
      await storage.vectorStore.hybridQuery("ghost", {
        dense: [1, 0, 0],
        limit: 2,
        withPayload: true,
      }),
    ).toEqual([]);
    expect(await storage.vectorStore.scroll("ghost", { limit: 2 })).toEqual({ points: [] });
    expect(await storage.metadataStore.getWorkspace("missing")).toBeNull();
    expect(await storage.graphStore.readShard("graph_files", "missing")).toBeNull();
    expect(await readdir(root)).toEqual([]);
    await mkdir(dbPath);
    expect(await storage.vectorStore.collectionExists("ghost")).toBe(false);
    expect(await storage.vectorStore.countByFilter("ghost", {})).toBe(0);
    expect(await readdir(dbPath)).toEqual([]);
    await storage.close();
  });

  it("persists real tables and stable logical IDs across close/reopen", async () => {
    const first = store();
    await first.ensureCollection(spec);
    const ids = ["plain", "quote' OR TRUE --", "nul\0end", "\ud800", "🐑"];
    await first.upsert(
      spec.name,
      ids.map((id) => ({
        id,
        dense: [1, 2, 3],
        sparse: { indices: [8], values: [2] },
        payload: { id },
      })),
    );
    await first.upsert(spec.name, [
      { id: ids[0]!, payload: { replaced: true } },
      { id: ids[0]!, payload: { replaced: "last" } },
    ]);
    await first.close();
    const second = store();
    expect(await second.countByFilter(spec.name, {})).toBe(ids.length);
    const retrieved = await second.retrieve(spec.name, [...ids].reverse(), { withVectors: true });
    expect(retrieved.map((point) => point.id)).toEqual([...ids].reverse());
    expect(retrieved.at(-1)?.payload).toEqual({ replaced: "last" });
    expect(retrieved[0]?.dense).toEqual([1, 2, 3]);
    const native = await connect(dbPath, { readConsistencyInterval: 0 });
    try {
      expect((await native.tableNames()).sort()).toEqual(
        [CATALOG_TABLE, collectionTableName(spec.name)].sort(),
      );
      const table = await native.openTable(collectionTableName(spec.name));
      try {
        expect(await table.countRows()).toBe(ids.length);
      } finally {
        table.close();
      }
    } finally {
      native.close();
    }
  });

  it("validates every declared collection property on reopen", async () => {
    const current = store();
    await current.ensureCollection(spec);
    await current.ensureCollection({ ...spec });
    for (const changed of [
      { denseDimensions: 4 },
      { denseDistance: "Dot" as const },
      { sparseBm25: false },
      { onDiskPayload: false },
    ])
      await expect(current.ensureCollection({ ...spec, ...changed })).rejects.toMatchObject({
        code: "LANCEDB_SCHEMA_INCOMPATIBLE",
      });
    expect(await current.countByFilter(spec.name, {})).toBe(0);
  });

  it("rejects foreign native catalog schemas rather than returning an empty store", async () => {
    const native = await connect(dbPath, { readConsistencyInterval: 0 });
    const table = await native.createTable(CATALOG_TABLE, [{ unknown: "foreign" }]);
    table.close();
    native.close();
    await expect(store().collectionExists(spec.name)).rejects.toMatchObject({
      code: "LANCEDB_SCHEMA_INCOMPATIBLE",
    });
  });

  it("persists an idempotent typed payload-index catalog and rejects conflicting types", async () => {
    await store().ensureCollection(spec);
    await store().ensurePayloadIndexes(spec.name, [
      { field: "repo", type: "keyword" },
      { field: "n", type: "integer" },
    ]);
    await store().ensurePayloadIndexes(spec.name, [{ field: "repo", type: "keyword" }]);
    await expect(
      store().ensurePayloadIndexes(spec.name, [{ field: "repo", type: "bool" }]),
    ).rejects.toMatchObject({ code: "LANCEDB_SCHEMA_INCOMPATIBLE" });
    const native = await connect(dbPath, { readConsistencyInterval: 0 });
    const table = await native.openTable(CATALOG_TABLE);
    try {
      const rows = await table.query().toArray();
      expect(JSON.parse(rows[0].indexes_json as string)).toEqual([
        { field: "n", type: "integer" },
        { field: "repo", type: "keyword" },
      ]);
    } finally {
      table.close();
      native.close();
    }
  });

  it("applies must/should/mustNot, nested arrays, exact dotted keys and numeric ranges", async () => {
    const current = store();
    await current.ensureCollection(spec);
    await current.upsert(spec.name, [
      {
        id: "a",
        payload: {
          lang: "ts",
          owners: [{ role: "search" }],
          n: 3,
          enabled: true,
          "a.b": "literal",
        },
      },
      {
        id: "b",
        payload: {
          lang: "py",
          owners: [{ role: "cli" }],
          n: 4,
          enabled: false,
          a: { b: "nested" },
        },
      },
      { id: "c", payload: { lang: ["ts", "vue"], n: 5, enabled: true } },
    ]);
    const filter: PayloadFilter = {
      must: [
        { field: "lang", match: { in: ["ts", "vue"] } },
        { field: "n", range: { gt: 2, gte: 3, lt: 6, lte: 5 } },
      ],
      should: [
        { field: "owners.role", match: { eq: "search" } },
        { field: "a.b", match: { eq: "literal" } },
      ],
      mustNot: [{ field: "enabled", match: { eq: false } }],
    };
    expect(await current.countByFilter(spec.name, filter)).toBe(1);
    await current.deleteByFilter(spec.name, filter);
    expect((await current.scroll(spec.name, { limit: 5 })).points.map((point) => point.id)).toEqual(
      ["b", "c"],
    );
    await expect(
      current.countByFilter(spec.name, {
        must: [{ field: "x", match: null }],
      } as unknown as PayloadFilter),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("prevalidates a whole upsert and releases the guard after rejected writes", async () => {
    const current = store();
    await current.ensureCollection(spec);
    await expect(
      current.upsert(spec.name, [
        { id: "good", payload: {} },
        { id: "bad", dense: [1], payload: {} },
      ]),
    ).rejects.toMatchObject({ code: "LANCEDB_SCHEMA_INCOMPATIBLE" });
    expect(await current.countByFilter(spec.name, {})).toBe(0);
    await current.upsert(spec.name, [{ id: "good", payload: {} }]);
    expect(await current.countByFilter(spec.name, {})).toBe(1);
  });

  it("commits fitting points, reports oversized IDs and preserves batch counts", async () => {
    const current = store({ upsertMaxPoints: 1, upsertBudgetBytes: 220 });
    await current.ensureCollection(spec);
    await expect(
      current.upsert(spec.name, [
        { id: "a", payload: { small: true } },
        { id: "large", payload: { body: "x".repeat(1000) } },
        { id: "b", payload: {} },
      ]),
    ).rejects.toMatchObject({
      code: "POINT_TOO_LARGE",
      context: { upsertedCount: 2, budgetBytes: 220, oversizedPoints: [{ id: "large" }] },
    });
    expect(
      (await current.retrieve(spec.name, ["a", "large", "b"])).map((point) => point.id),
    ).toEqual(["a", "b"]);
  });

  it("fails exact scans explicitly at their row/byte budget, without silently truncating", async () => {
    await store().ensureCollection(spec);
    await store().upsert(spec.name, [
      { id: "a", dense: [1, 0, 0], payload: { large: "x".repeat(500) } },
      { id: "b", dense: [0, 1, 0], payload: {} },
    ]);
    await expect(
      store({ scanMaxRows: 1 }).hybridQuery(spec.name, {
        dense: [1, 0, 0],
        limit: 1,
        withPayload: false,
      }),
    ).rejects.toMatchObject({ code: "LANCEDB_UNAVAILABLE", retryable: false });
    await expect(
      store({ scanBudgetBytes: 100 }).scroll(spec.name, { limit: 5 }),
    ).rejects.toMatchObject({ code: "LANCEDB_UNAVAILABLE", retryable: false });
    // A bounded point lookup remains usable even when the whole corpus would exceed the scan budget.
    expect((await store({ scanMaxRows: 1 }).retrieve(spec.name, ["b"]))[0]?.id).toBe("b");
  });

  it("uses a keyset cursor after the boundary point is deleted and rejects foreign cursors", async () => {
    const current = store();
    await current.ensureCollection(spec);
    await current.upsert(
      spec.name,
      ["a", "b", "c"].map((id) => ({ id, payload: { id } })),
    );
    const first = await current.scroll(spec.name, { limit: 1 });
    await current.deleteByFilter(spec.name, { must: [{ field: "id", match: { eq: "a" } }] });
    expect(
      (await current.scroll(spec.name, { limit: 2, offset: first.nextOffset! })).points.map(
        (point) => point.id,
      ),
    ).toEqual(["b", "c"]);
    await expect(
      current.scroll("foreign", { limit: 1, offset: first.nextOffset! }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it.each(["Cosine", "Dot", "Euclid"] as const)(
    "scores %s exactly and returns higher scores first",
    async (distance) => {
      const current = store();
      await current.ensureCollection({ ...spec, denseDistance: distance });
      await current.upsert(spec.name, [
        { id: "near", dense: [1, 0, 0], payload: {} },
        { id: "far", dense: [-1, 0, 0], payload: {} },
      ]);
      const hits = await current.hybridQuery(spec.name, {
        dense: [1, 0, 0],
        limit: 2,
        withPayload: false,
      });
      expect(hits.map((hit) => hit.id)).toEqual(["near", "far"]);
      expect(hits.map((hit) => hit.score)).toEqual(distance === "Euclid" ? [-0, -2] : [1, -1]);
    },
  );

  it("uses query TF, global collection IDF before filtering, and removes stale terms on update/delete", async () => {
    const current = store();
    await current.ensureCollection(spec);
    await current.upsert(spec.name, [
      { id: "a", sparse: { indices: [1], values: [2] }, payload: { scope: "keep" } },
      { id: "b", sparse: { indices: [1, 2], values: [1, 1] }, payload: { scope: "other" } },
    ]);
    const query = { sparse: { indices: [1], values: [3] }, limit: 10, withPayload: false };
    expect(
      (
        await current.hybridQuery(spec.name, {
          ...query,
          filter: { must: [{ field: "scope", match: { eq: "keep" } }] },
        })
      )[0]?.score,
    ).toBeCloseTo(6 * Math.log(1 + 0.5 / 2.5), 12);
    await current.upsert(spec.name, [
      { id: "b", sparse: { indices: [2], values: [1] }, payload: { scope: "other" } },
    ]);
    expect((await store().hybridQuery(spec.name, query))[0]?.score).toBeCloseTo(
      6 * Math.log(2),
      12,
    );
    await current.deleteByFilter(spec.name, { must: [{ field: "scope", match: { eq: "other" } }] });
    expect((await current.hybridQuery(spec.name, query))[0]?.score).toBeCloseTo(
      6 * Math.log(1 + 0.5 / 1.5),
      12,
    );
  });

  it("fuses independent dense and sparse candidate lists with deterministic RRF", async () => {
    const current = store();
    await current.ensureCollection(spec);
    await current.upsert(spec.name, [
      { id: "dense", dense: [1, 0, 0], sparse: { indices: [2], values: [1] }, payload: {} },
      { id: "sparse", dense: [0, 1, 0], sparse: { indices: [1], values: [1] }, payload: {} },
    ]);
    const hits = await current.hybridQuery(spec.name, {
      dense: [1, 0, 0],
      sparse: { indices: [1], values: [1] },
      candidateLimit: 1,
      limit: 2,
      withPayload: true,
    });
    expect(hits.map((hit) => hit.id)).toEqual(["dense", "sparse"]);
    expect(hits.map((hit) => hit.score)).toEqual([1 / 61, 1 / 61]);
    expect(hits[0]?.denseScore).toBe(1);
    expect(hits[1]?.sparseRank).toBe(0);
  });
});
