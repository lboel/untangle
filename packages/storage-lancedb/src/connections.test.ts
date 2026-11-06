import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Connection } from "@lancedb/lancedb";
import { connect } from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectionPool } from "./connections.js";
import { StorageCall } from "./operation.js";
import { LanceDbVectorStore } from "./vector-store.js";

let root: string;
let pool: ConnectionPool;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "untangle-lance-connections-"));
  pool = new ConnectionPool();
});
afterEach(async () => {
  await pool.close();
  await rm(root, { recursive: true, force: true });
});
const call = () => new StorageCall("native_connection_contract", undefined, 10_000);

describe("bounded native session reuse", () => {
  it("evicts a transient native connection failure so an immediate retry opens a new real session", async () => {
    let attempts = 0;
    const recovering = new ConnectionPool(async (target) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient native connect failure");
      return connect(target, { readConsistencyInterval: 0 });
    });
    try {
      await expect(
        recovering.withConnection(root, call(), async (db) => db.tableNames()),
      ).rejects.toThrow("transient native connect failure");
      await expect(
        recovering.withConnection(root, call(), async (db) => db.tableNames()),
      ).resolves.toEqual([]);
      expect(attempts).toBe(2);
    } finally {
      await recovering.close();
    }
  });
  it("reuses a burst session, closes every idle session, and reopens safely", async () => {
    const first = await pool.withConnection(root, call(), async (db) => db);
    const second = await pool.withConnection(root, call(), async (db) => db);
    expect(second).toBe(first);
    await expect.poll(() => first.isOpen(), { timeout: 2000 }).toBe(false);
    const third = await pool.withConnection(root, call(), async (db) => db);
    expect(third).not.toBe(first);
    expect(third.isOpen()).toBe(true);
    await pool.close();
    expect(third.isOpen()).toBe(false);
  });

  it("does not close a session while native work still owns it, including a failing borrower", async () => {
    let db!: Connection;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = pool.withConnection(root, call(), async (connection) => {
      db = connection;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("borrower failed");
    });
    const assertion = expect(pending).rejects.toThrow("borrower failed");
    await ready;
    const other = await pool.withConnection(root, call(), async (connection) => connection);
    expect(other).toBe(db);
    // Let an idle-close interval pass while the first borrower remains active.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(db.isOpen()).toBe(true);
    release();
    await assertion;
    await expect.poll(() => db.isOpen(), { timeout: 2000 }).toBe(false);
  });

  it("refreshes cross-connection writes during a reused session without caching payload authority", async () => {
    const a = new LanceDbVectorStore({ path: root }),
      b = new LanceDbVectorStore({ path: root });
    try {
      await a.ensureCollection({
        name: "points",
        denseDimensions: 1,
        denseDistance: "Dot",
        sparseBm25: false,
        onDiskPayload: true,
      });
      await a.upsert("points", [{ id: "id", payload: { revision: 1 } }]);
      expect((await a.retrieve("points", ["id"]))[0]?.payload).toEqual({ revision: 1 });
      await b.upsert("points", [{ id: "id", payload: { revision: 2 } }]);
      expect((await a.retrieve("points", ["id"]))[0]?.payload).toEqual({ revision: 2 });
      await b.deleteByFilter("points", {});
      expect(await a.retrieve("points", ["id"])).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
