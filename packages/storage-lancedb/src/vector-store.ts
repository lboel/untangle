import { Buffer } from "node:buffer";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { Connection, Table } from "@lancedb/lancedb";
import type {
  CollectionSpecV1,
  HybridQueryV1,
  PayloadFilter,
  PayloadIndexSpecV1,
  PortCallOptions,
  ScoredPointV1,
  ScrollPageV1,
  ScrollRequestV1,
  VectorPointV1,
  VectorStore,
} from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";

import { ConnectionPool } from "./connections.js";
import { matchesFilter, nativeFilter, validateFilter } from "./filters.js";
import { ensureManagedIndexes, maintainTable } from "./maintenance.js";
import { invalid, schemaError, StorageCall, unavailable, wrapStorageError } from "./operation.js";
import { rankPoints } from "./query.js";
import {
  assertTableSchema,
  CATALOG_TABLE,
  catalogSchema,
  collectionTableName,
  decodePoint,
  encodePoint,
  idOrder,
  normalizeSpec,
  pointSchema,
  readCollectionRecord,
  readIndexes,
  recordSpec,
  sqlString,
  storedId,
  validateIndex,
  type CollectionRecord,
  type PointRow,
} from "./schema.js";
import { withMutationLock } from "./write-lock.js";

export interface LanceDbVectorStoreOptions {
  path: string;
  upsertMaxPoints?: number;
  upsertBudgetBytes?: number;
  requestTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Initial exact-scan implementation refuses unbounded corpus reads. */
  scanMaxRows?: number;
  scanBudgetBytes?: number;
}

export interface ResolvedLanceDbOptions {
  path: string;
  upsertMaxPoints: number;
  upsertBudgetBytes: number;
  requestTimeoutMs: number;
  lockTimeoutMs: number;
  scanMaxRows: number;
  scanBudgetBytes: number;
}

interface OpenCollection {
  record: CollectionRecord;
  spec: CollectionSpecV1;
  table: Table;
}

const CATALOG_DIRECTORY = `${CATALOG_TABLE}.lance`;
const PAGE_SIZE = 16;
const KEY_WINDOW_SIZE = 256;

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw invalid(`${name} must be a positive safe integer.`);
  return value;
}

/** Persistent Lance tables; no authoritative in-memory vector or catalog state. */
export class LanceDbVectorStore implements VectorStore {
  public readonly backend = "lancedb" as const;
  public readonly path: string;
  public readonly options: Readonly<ResolvedLanceDbOptions>;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly connections = new ConnectionPool();

  public constructor(options: LanceDbVectorStoreOptions) {
    if (
      typeof options.path !== "string" ||
      !options.path.trim() ||
      options.path.includes("\0") ||
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(options.path)
    )
      throw invalid("LanceDB requires an explicit local filesystem path.");
    this.path = path.resolve(options.path);
    this.options = Object.freeze({
      path: this.path,
      upsertMaxPoints: positive("upsertMaxPoints", options.upsertMaxPoints ?? 256),
      upsertBudgetBytes: positive(
        "upsertBudgetBytes",
        options.upsertBudgetBytes ?? 4 * 1024 * 1024,
      ),
      requestTimeoutMs: positive("requestTimeoutMs", options.requestTimeoutMs ?? 30_000),
      lockTimeoutMs: positive("lockTimeoutMs", options.lockTimeoutMs ?? 30_000),
      scanMaxRows: positive("scanMaxRows", options.scanMaxRows ?? 100_000),
      scanBudgetBytes: positive("scanBudgetBytes", options.scanBudgetBytes ?? 128 * 1024 * 1024),
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    await this.connections.close();
  }

  private run<T>(
    operation: string,
    options: PortCallOptions | undefined,
    work: (call: StorageCall) => Promise<T>,
  ): Promise<T> {
    const call = new StorageCall(operation, options?.signal, this.options.requestTimeoutMs);
    const result = (async () => {
      try {
        call.check();
        if (this.closed) throw unavailable("This LanceDB store has been closed.", call, false);
        const value = await work(call);
        call.check();
        return value;
      } catch (error) {
        return wrapStorageError(error, call);
      }
    })();
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result)).catch(() => {});
    return result;
  }

  private async physicalRoot(create: boolean, call: StorageCall): Promise<string | null> {
    call.check();
    if (create) await mkdir(this.path, { recursive: true, mode: 0o700 });
    let info;
    try {
      info = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return null;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw schemaError("LanceDB root must be a physical directory.");
    return realpath(this.path);
  }

  private async hasCatalog(root: string): Promise<boolean> {
    try {
      const info = await lstat(path.join(root, CATALOG_DIRECTORY));
      if (!info.isDirectory() || info.isSymbolicLink())
        throw schemaError("The Lance catalog must be a physical table directory.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async connection<T>(
    root: string,
    call: StorageCall,
    work: (db: Connection) => Promise<T>,
  ): Promise<T> {
    return this.connections.withConnection(root, call, work);
  }

  private async catalog(db: Connection, create: boolean, call: StorageCall): Promise<Table> {
    const wanted = await catalogSchema();
    let table: Table;
    if (create && !(await db.tableNames()).includes(CATALOG_TABLE)) {
      call.mayHaveCommitted = true;
      table = await db.createEmptyTable(CATALOG_TABLE, wanted);
    } else table = await db.openTable(CATALOG_TABLE);
    try {
      await assertTableSchema(table, wanted);
      call.check();
      return table;
    } catch (error) {
      table.close();
      throw error;
    }
  }

  private async record(
    catalog: Table,
    name: string,
    call: StorageCall,
  ): Promise<CollectionRecord | null> {
    const rows: unknown[] = await catalog
      .query()
      .where(`name = ${sqlString(storedId(name))}`)
      .limit(2)
      .toArray({ timeoutMs: call.remaining() });
    if (rows.length > 1) throw schemaError("Duplicate logical collection records were found.");
    return rows.length ? readCollectionRecord(rows[0] as Record<string, unknown>, name) : null;
  }

  private async opened(
    db: Connection,
    record: CollectionRecord,
    call: StorageCall,
  ): Promise<OpenCollection> {
    const spec = recordSpec(record);
    readIndexes(record);
    const table = await db.openTable(record.table_name);
    try {
      await assertTableSchema(table, await pointSchema(spec));
      call.check();
      return { record, spec, table };
    } catch (error) {
      table.close();
      throw error;
    }
  }

  private async read<T>(
    name: string,
    call: StorageCall,
    absent: T,
    work: (db: Connection, collection: OpenCollection) => Promise<T>,
  ): Promise<T> {
    const root = await this.physicalRoot(false, call);
    if (root === null || !(await this.hasCatalog(root))) return absent;
    return this.connection(root, call, async (db) => {
      const catalog = await this.catalog(db, false, call);
      try {
        const record = await this.record(catalog, name, call);
        if (record === null) return absent;
        const collection = await this.opened(db, record, call);
        try {
          return await work(db, collection);
        } finally {
          collection.table.close();
        }
      } finally {
        catalog.close();
      }
    });
  }

  private async mutation<T>(
    create: boolean,
    call: StorageCall,
    absent: () => T,
    work: (db: Connection, catalog: Table) => Promise<T>,
  ): Promise<T> {
    const root = await this.physicalRoot(create, call);
    if (root === null || (!create && !(await this.hasCatalog(root)))) return absent();
    return withMutationLock(root, call, this.options.lockTimeoutMs, () =>
      this.connection(root, call, async (db) => {
        const catalog = await this.catalog(db, create, call);
        try {
          return await work(db, catalog);
        } finally {
          catalog.close();
        }
      }),
    );
  }

  private async writeRecord(
    catalog: Table,
    record: CollectionRecord,
    call: StorageCall,
  ): Promise<void> {
    const { makeArrowTable } = await import("@lancedb/lancedb");
    const data = makeArrowTable([record], { schema: await catalogSchema() });
    call.check();
    call.mayHaveCommitted = true;
    await catalog
      .mergeInsert("name")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(data, { timeoutMs: call.remaining() });
    call.check();
  }

  public collectionExists(name: string, options?: PortCallOptions): Promise<boolean> {
    return this.run("lancedb_collection_exists", options, (call) =>
      this.read(name, call, false, async () => true),
    );
  }

  public ensureCollection(spec: CollectionSpecV1, options?: PortCallOptions): Promise<void> {
    return this.run("lancedb_ensure_collection", options, async (call) => {
      const wanted = normalizeSpec(spec);
      await this.mutation(
        true,
        call,
        () => undefined,
        async (db, catalog) => {
          const existing = await this.record(catalog, wanted.name, call);
          if (existing) {
            if (JSON.stringify(recordSpec(existing)) !== JSON.stringify(wanted))
              throw schemaError("Collection already exists with a different specification.", {
                collection: wanted.name,
              });
            const opened = await this.opened(db, existing, call);
            try {
              await ensureManagedIndexes(opened.table, call);
              await maintainTable(opened.table, call);
            } finally {
              opened.table.close();
            }
            return;
          }
          const tableName = collectionTableName(wanted.name);
          const schema = await pointSchema(wanted);
          let table: Table;
          if ((await db.tableNames()).includes(tableName)) {
            // Recover only an exactly marked table left by an interrupted ensure.
            table = await db.openTable(tableName);
            try {
              await assertTableSchema(table, schema);
            } finally {
              table.close();
            }
          } else {
            call.check();
            call.mayHaveCommitted = true;
            table = await db.createEmptyTable(tableName, schema);
            table.close();
          }
          const indexed = await db.openTable(tableName);
          try {
            await ensureManagedIndexes(indexed, call);
          } finally {
            indexed.close();
          }
          await this.writeRecord(
            catalog,
            {
              name: storedId(wanted.name),
              table_name: tableName,
              spec_json: JSON.stringify(wanted),
              indexes_json: "[]",
              schema_version: 1,
            },
            call,
          );
        },
      );
    });
  }

  public ensurePayloadIndexes(
    collection: string,
    indexes: PayloadIndexSpecV1[],
    options?: PortCallOptions,
  ): Promise<void> {
    return this.run("lancedb_ensure_payload_indexes", options, async (call) => {
      indexes.forEach(validateIndex);
      await this.mutation(
        false,
        call,
        () => {
          throw unavailable("Collection is not provisioned.", call, false);
        },
        async (_db, catalog) => {
          const record = await this.record(catalog, collection, call);
          if (!record) throw unavailable("Collection is not provisioned.", call, false);
          const existing = readIndexes(record);
          for (const index of indexes) {
            const previous = existing.find((entry) => entry.field === index.field);
            if (previous && previous.type !== index.type)
              throw schemaError("Payload index already has a different type.", {
                field: index.field,
              });
            if (!previous) existing.push({ ...index });
          }
          existing.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
          await this.writeRecord(
            catalog,
            { ...record, indexes_json: JSON.stringify(existing) },
            call,
          );
        },
      );
    });
  }

  public upsert(
    collection: string,
    points: VectorPointV1[],
    options?: PortCallOptions,
  ): Promise<{ upsertedCount: number }> {
    return this.run("lancedb_upsert", options, async (call) => {
      if (!points.length) return { upsertedCount: 0 };
      return this.mutation(
        false,
        call,
        () => {
          throw unavailable("Collection is not provisioned.", call, false);
        },
        async (db, catalog) => {
          const record = await this.record(catalog, collection, call);
          if (!record) throw unavailable("Collection is not provisioned.", call, false);
          const opened = await this.opened(db, record, call);
          try {
            return await this.upsertRows(opened, points, call);
          } finally {
            opened.table.close();
          }
        },
      );
    });
  }

  private async upsertRows(
    collection: OpenCollection,
    points: VectorPointV1[],
    call: StorageCall,
  ): Promise<{ upsertedCount: number }> {
    const accepted = new Map<string, { row: PointRow; bytes: number; count: number }>();
    const oversized: { id: string; bytes: number }[] = [];
    for (const point of points) {
      call.check();
      const row = encodePoint(point, collection.spec);
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (bytes > this.options.upsertBudgetBytes) oversized.push({ id: point.id, bytes });
      else accepted.set(row.id, { row, bytes, count: (accepted.get(row.id)?.count ?? 0) + 1 });
    }
    const { makeArrowTable } = await import("@lancedb/lancedb");
    const schema = await pointSchema(collection.spec);
    let batch: PointRow[] = [],
      batchBytes = 0,
      batchCount = 0,
      upsertedCount = 0;
    const flush = async () => {
      if (!batch.length) return;
      call.check();
      call.mayHaveCommitted = true;
      try {
        await collection.table
          .mergeInsert("id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(makeArrowTable(batch, { schema }), { timeoutMs: call.remaining() });
        upsertedCount += batchCount;
      } catch (cause) {
        call.check();
        throw new UntangleError(
          "LANCEDB_UNAVAILABLE",
          "A Lance upsert batch failed; earlier batches may have committed.",
          {
            retryable: true,
            operation: call.operation,
            context: {
              upsertedCount,
              failedIds: batch.map((row) => JSON.parse(row.id) as string),
              mayHaveCommitted: true,
            },
            cause,
          },
        );
      }
      try {
        await maintainTable(collection.table, call);
      } catch (cause) {
        call.check();
        throw new UntangleError(
          "LANCEDB_UNAVAILABLE",
          "The upsert batch committed, but Lance index/fragment maintenance failed.",
          {
            operation: call.operation,
            retryable: true,
            context: { upsertedCount, maintenanceFailed: true, mayHaveCommitted: true },
            cause,
          },
        );
      }
      call.check();
      batch = [];
      batchBytes = 0;
      batchCount = 0;
    };
    for (const entry of accepted.values()) {
      if (
        batch.length &&
        (batch.length >= this.options.upsertMaxPoints ||
          batchBytes + entry.bytes > this.options.upsertBudgetBytes)
      )
        await flush();
      batch.push(entry.row);
      batchBytes += entry.bytes;
      batchCount += entry.count;
    }
    await flush();
    if (oversized.length)
      throw new UntangleError(
        "POINT_TOO_LARGE",
        "Points exceed the configured serialized byte budget.",
        {
          operation: call.operation,
          context: {
            budgetBytes: this.options.upsertBudgetBytes,
            oversizedPoints: oversized,
            upsertedCount,
          },
        },
      );
    return { upsertedCount };
  }

  /** One projected native Arrow stream, without repeated OFFSET scans/sorts. */
  private async scan(
    db: Connection,
    collection: OpenCollection,
    vectors: boolean | { dense: boolean; sparse: boolean },
    call: StorageCall,
  ): Promise<VectorPointV1[]> {
    const reader = await db.openTable(collection.record.table_name);
    const result: VectorPointV1[] = [],
      seen = new Set<string>();
    let bytes = 0;
    try {
      await reader.checkout(await reader.version());
      const selection =
        typeof vectors === "boolean" ? { dense: vectors, sparse: vectors } : vectors;
      const query = reader
        .query()
        .select([
          "id",
          "payload",
          ...(selection.dense ? ["dense"] : []),
          ...(selection.sparse ? ["sparse_indices", "sparse_values"] : []),
        ])
        .limit(this.options.scanMaxRows + 1);
      for await (const batch of query) {
        call.check();
        for (let row = 0; row < batch.numRows; row += 1) {
          call.check();
          const raw: unknown = batch.get(row);
          const point = decodePoint(
            raw as Record<string, unknown>,
            selection.dense || selection.sparse,
            collection.spec,
          );
          if (seen.has(point.id))
            throw schemaError("Duplicate persisted logical point IDs were found.");
          seen.add(point.id);
          bytes += Buffer.byteLength(JSON.stringify(point));
          if (result.length >= this.options.scanMaxRows || bytes > this.options.scanBudgetBytes)
            throw unavailable(
              "The exact Lance scan exceeded its configured row/byte budget.",
              call,
              false,
            );
          result.push(point);
        }
      }
      return result;
    } finally {
      reader.close();
    }
  }

  public deleteByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<void> {
    return this.run("lancedb_delete", options, async (call) => {
      validateFilter(filter);
      await this.mutation(
        false,
        call,
        () => undefined,
        async (db, catalog) => {
          const record = await this.record(catalog, collection, call);
          if (!record) return;
          const opened = await this.opened(db, record, call);
          try {
            const predicate = nativeFilter(filter);
            if (predicate !== null) {
              call.check();
              call.mayHaveCommitted = true;
              await opened.table.delete(predicate);
              call.check();
              return;
            }
            const ids = (await this.scan(db, opened, false, call))
              .filter((point) => matchesFilter(point.payload, filter))
              .map((point) => storedId(point.id));
            // The guard remains held across all deletes; every batch is atomic in Lance.
            for (let offset = 0; offset < ids.length; offset += this.options.upsertMaxPoints) {
              call.check();
              call.mayHaveCommitted = true;
              await opened.table.delete(
                `id IN (${ids
                  .slice(offset, offset + this.options.upsertMaxPoints)
                  .map(sqlString)
                  .join(",")})`,
              );
            }
          } finally {
            opened.table.close();
          }
        },
      );
    });
  }

  public hybridQuery(
    collection: string,
    query: HybridQueryV1,
    options?: PortCallOptions,
  ): Promise<ScoredPointV1[]> {
    return this.run("lancedb_query", options, (call) =>
      this.read(collection, call, [], async (db, opened) =>
        rankPoints(
          await this.scan(
            db,
            opened,
            { dense: query.dense !== undefined, sparse: query.sparse !== undefined },
            call,
          ),
          opened.spec,
          query,
          () => call.check(),
        ),
      ),
    );
  }

  public retrieve(
    collection: string,
    ids: string[],
    options?: PortCallOptions & { withVectors?: boolean },
  ): Promise<VectorPointV1[]> {
    return this.run("lancedb_retrieve", options, async (call) => {
      if (!ids.length) return [];
      return this.read(collection, call, [], async (db, opened) => {
        // Point lookups must not scan every graph/metadata record for each get.
        // Pin a separate reader so multi-batch retrieves share one snapshot.
        const reader = await db.openTable(opened.record.table_name);
        const byId = new Map<string, VectorPointV1>();
        let bytes = 0;
        try {
          await reader.checkout(await reader.version());
          const uniqueIds = [...new Set(ids)];
          for (let offset = 0; offset < uniqueIds.length; offset += 128) {
            call.check();
            const batch = uniqueIds.slice(offset, offset + 128);
            const query = reader
              .query()
              .where(`id IN (${batch.map((id) => sqlString(storedId(id))).join(",")})`)
              .limit(batch.length + 1);
            if (!options?.withVectors) query.select(["id", "payload"]);
            const rows: unknown[] = await query.toArray({ timeoutMs: call.remaining() });
            for (const raw of rows) {
              const point = decodePoint(
                raw as Record<string, unknown>,
                options?.withVectors ?? false,
                opened.spec,
              );
              if (byId.has(point.id))
                throw schemaError("Duplicate persisted logical point IDs were found.");
              bytes += Buffer.byteLength(JSON.stringify(point));
              if (byId.size >= this.options.scanMaxRows || bytes > this.options.scanBudgetBytes)
                throw unavailable(
                  "The Lance retrieve exceeded its configured row/byte budget.",
                  call,
                  false,
                );
              byId.set(point.id, point);
            }
          }
          return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
        } finally {
          reader.close();
        }
      });
    });
  }

  public scroll(
    collection: string,
    request: ScrollRequestV1,
    options?: PortCallOptions,
  ): Promise<ScrollPageV1> {
    return this.run("lancedb_scroll", options, async (call) => {
      validateFilter(request.filter);
      if (!Number.isSafeInteger(request.limit) || request.limit < 0)
        throw invalid("Scroll limit must be a non-negative safe integer.");
      let after: string | undefined;
      if (request.offset !== undefined) {
        try {
          if (!request.offset.startsWith("lance-v1.")) throw new Error("Invalid cursor prefix.");
          const cursor = JSON.parse(
            Buffer.from(request.offset.slice(9), "base64url").toString("utf8"),
          ) as { collection?: unknown; after?: unknown };
          if (cursor.collection !== collection || typeof cursor.after !== "string")
            throw new Error("Wrong cursor collection.");
          after = cursor.after;
        } catch {
          throw invalid("Invalid or foreign Lance scroll cursor.");
        }
      }
      return this.read(collection, call, { points: [] }, async (db, opened) => {
        const points = await this.seekPage(db, opened, request, after, call);
        if (!request.limit && points.length && request.offset === undefined)
          throw invalid("A zero-length initial scroll cannot represent a non-exhausted cursor.");
        const page = points.slice(0, request.limit);
        const last = page[page.length - 1]?.id ?? after;
        const nextOffset =
          points.length > page.length && last !== undefined
            ? "lance-v1." +
              Buffer.from(JSON.stringify({ collection, after: last })).toString("base64url")
            : undefined;
        return { points: page, ...(nextOffset === undefined ? {} : { nextOffset }) };
      });
    });
  }

  /** Seek in the native table and stop after one requested page plus lookahead. */
  private async seekPage(
    db: Connection,
    collection: OpenCollection,
    request: ScrollRequestV1,
    after: string | undefined,
    call: StorageCall,
  ): Promise<VectorPointV1[]> {
    const reader = await db.openTable(collection.record.table_name);
    const points: VectorPointV1[] = [],
      seen = new Set<string>();
    const predicate = nativeFilter(request.filter);
    let seek = after === undefined ? undefined : idOrder(after);
    let visited = 0,
      bytes = 0;
    const accept = (row: Record<string, unknown>, key: string) => {
      call.check();
      const point = decodePoint(row, request.withVectors ?? false, collection.spec);
      if (seen.has(point.id) || key !== idOrder(point.id) || (seek !== undefined && key <= seek))
        throw schemaError("Duplicate or inconsistent persisted point ordering was found.");
      seen.add(point.id);
      visited += 1;
      bytes += Buffer.byteLength(JSON.stringify(point));
      if (visited > this.options.scanMaxRows || bytes > this.options.scanBudgetBytes)
        throw unavailable("The Lance scroll exceeded its configured row/byte budget.", call, false);
      seek = key;
      if (matchesFilter(point.payload, request.filter)) points.push(point);
    };
    try {
      await reader.checkout(await reader.version());
      // Most graph shards fit one small query. Keep that path at one payload
      // read; only broad scans pay for the subsequent ordered-key planning.
      const firstLimit = Math.min(PAGE_SIZE, request.limit + 1);
      const initial = reader
        .query()
        .where(
          [predicate ?? "TRUE", ...(seek === undefined ? [] : [`id_order > ${sqlString(seek)}`])]
            .map((clause) => `(${clause})`)
            .join(" AND "),
        )
        .orderBy({ columnName: "id_order", ascending: true })
        .limit(firstLimit);
      initial.select(
        request.withVectors
          ? ["id", "id_order", "payload", "dense", "sparse_indices", "sparse_values"]
          : ["id", "id_order", "payload"],
      );
      const firstRows: unknown[] = await initial.toArray({
        maxBatchLength: PAGE_SIZE,
        timeoutMs: call.remaining(),
      });
      for (const raw of firstRows) {
        const row = raw as Record<string, unknown>;
        const key = row["id_order"];
        if (typeof key !== "string") throw schemaError("Invalid persisted scroll key.");
        accept(row, key);
        if (points.length > request.limit) return points;
      }
      if (firstRows.length < firstLimit) return points;
      while (points.length <= request.limit) {
        call.check();
        const clauses = [
          predicate ?? "TRUE",
          ...(seek === undefined ? [] : [`id_order > ${sqlString(seek)}`]),
        ];
        const limit = Math.min(KEY_WINDOW_SIZE, request.limit + 1 - points.length);
        // Sort/filter lightweight keys once per window, then fetch payloads
        // through their BTree index. Sorting the full payload corpus again
        // for every 16-row decode batch makes large grep scans quadratic.
        const keys: unknown[] = await reader
          .query()
          .where(clauses.map((clause) => `(${clause})`).join(" AND "))
          .orderBy({ columnName: "id_order", ascending: true })
          .select(["id_order"])
          .limit(limit)
          .toArray({ maxBatchLength: PAGE_SIZE, timeoutMs: call.remaining() });
        const ordered: string[] = [];
        let previous = seek;
        for (const raw of keys) {
          const key = (raw as Record<string, unknown>)["id_order"];
          if (
            typeof key !== "string" ||
            !/^(?:[0-9a-f]{4})+$/u.test(key) ||
            (previous !== undefined && key <= previous)
          )
            throw schemaError("Duplicate or invalid persisted scroll keys were found.");
          ordered.push(key);
          previous = key;
        }
        for (
          let offset = 0;
          offset < ordered.length && points.length <= request.limit;
          offset += PAGE_SIZE
        ) {
          call.check();
          const batch = ordered.slice(offset, offset + PAGE_SIZE);
          const query = reader
            .query()
            .where(`id_order IN (${batch.map(sqlString).join(",")})`)
            .limit(batch.length + 1);
          query.select(
            request.withVectors
              ? ["id", "id_order", "payload", "dense", "sparse_indices", "sparse_values"]
              : ["id", "id_order", "payload"],
          );
          const rows: unknown[] = await query.toArray({
            maxBatchLength: PAGE_SIZE,
            timeoutMs: call.remaining(),
          });
          const byKey = new Map<string, Record<string, unknown>>();
          for (const raw of rows) {
            const row = raw as Record<string, unknown>;
            const key = row["id_order"];
            if (typeof key !== "string" || !batch.includes(key) || byKey.has(key))
              throw schemaError("Duplicate or foreign persisted scroll payloads were found.");
            byKey.set(key, row);
          }
          if (byKey.size !== batch.length)
            throw schemaError("A pinned Lance scroll key has no matching payload.");
          for (const key of batch) {
            accept(byKey.get(key)!, key);
            if (points.length > request.limit) break;
          }
        }
        if (keys.length < limit) break;
      }
      return points;
    } finally {
      reader.close();
    }
  }

  public countByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<number> {
    return this.run("lancedb_count", options, async (call) => {
      validateFilter(filter);
      return this.read(collection, call, 0, async (db, opened) => {
        const predicate = nativeFilter(filter);
        if (predicate !== null) {
          const count = await opened.table.countRows(predicate);
          call.check();
          return count;
        }
        return (await this.scan(db, opened, false, call)).filter((point) =>
          matchesFilter(point.payload, filter),
        ).length;
      });
    });
  }
}
