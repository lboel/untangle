/**
 * Port-contract suite for `GraphStore` (domain `ports.ts`, architecture.md
 * §6.11, §11.6–§11.7).
 *
 * Deliberately OUT of scope (documented, see README "Entscheidungen"):
 * `GRAPH_INCOMPLETE` (a multipart-shard adapter concern — an in-memory
 * double never splits a shard into parts, so it can never observe this
 * failure mode; a real adapter package should add its own dedicated test).
 */
import type { GraphCollection, GraphShardV1, GraphStore } from "@untangle-code/domain";
import { beforeEach, describe, expect, it } from "vitest";

const COLLECTION: GraphCollection = "graph_files";

function shard(overrides: Partial<GraphShardV1> & { logicalShardId: string }): GraphShardV1 {
  return {
    collection: COLLECTION,
    generationId: "gen-1",
    writeId: "write-1",
    payload: {},
    ...overrides,
  };
}

export function runGraphStoreContract(factory: () => GraphStore | Promise<GraphStore>): void {
  describe("GraphStore port contract", () => {
    let store: GraphStore;

    beforeEach(async () => {
      store = await factory();
    });

    it("readShard returns null for a shard that was never written", async () => {
      await expect(store.readShard(COLLECTION, "missing")).resolves.toBeNull();
    });

    it("writeShards then readShard round-trips the payload for the latest generation by default", async () => {
      await store.writeShards([shard({ logicalShardId: "s1", payload: { nodes: 3 } })]);
      const read = await store.readShard(COLLECTION, "s1");
      expect(read?.payload).toEqual({ nodes: 3 });
    });

    it("writing a new generation for the same shard becomes the default read, without losing the old one", async () => {
      await store.writeShards([
        shard({ logicalShardId: "s1", generationId: "gen-1", payload: { v: 1 } }),
      ]);
      await store.writeShards([
        shard({ logicalShardId: "s1", generationId: "gen-2", payload: { v: 2 } }),
      ]);
      const latest = await store.readShard(COLLECTION, "s1");
      expect(latest?.payload).toEqual({ v: 2 });
      const old = await store.readShard(COLLECTION, "s1", { generationId: "gen-1" });
      expect(old?.payload).toEqual({ v: 1 });
    });

    it("readShard with an explicit unknown generationId returns null, not the latest", async () => {
      await store.writeShards([shard({ logicalShardId: "s1", generationId: "gen-1" })]);
      await expect(
        store.readShard(COLLECTION, "s1", { generationId: "unknown-gen" }),
      ).resolves.toBeNull();
    });

    it("listShardIds lists every shard id at its latest generation, sorted", async () => {
      await store.writeShards([shard({ logicalShardId: "s2" }), shard({ logicalShardId: "s1" })]);
      expect(await store.listShardIds(COLLECTION)).toEqual(["s1", "s2"]);
    });

    it("listShardIds is scoped per collection — a shard id in one collection is invisible in another", async () => {
      await store.writeShards([shard({ logicalShardId: "s1", collection: "graph_files" })]);
      expect(await store.listShardIds("graph_indices")).toEqual([]);
    });

    it("deleteShards removes a shard entirely (readShard afterward is null)", async () => {
      await store.writeShards([shard({ logicalShardId: "s1" })]);
      await store.deleteShards(COLLECTION, ["s1"]);
      expect(await store.readShard(COLLECTION, "s1")).toBeNull();
      expect(await store.listShardIds(COLLECTION)).toEqual([]);
    });

    it("deleteShards on an unknown id is a no-op, not an error", async () => {
      await expect(store.deleteShards(COLLECTION, ["never-existed"])).resolves.toBeUndefined();
    });

    describe("AbortSignal (spec.md §22)", () => {
      it("rejects every method when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const signal = controller.signal;
        await expect(
          store.writeShards([shard({ logicalShardId: "s1" })], { signal }),
        ).rejects.toBeDefined();
        await expect(store.readShard(COLLECTION, "s1", { signal })).rejects.toBeDefined();
        await expect(store.listShardIds(COLLECTION, { signal })).rejects.toBeDefined();
        await expect(store.deleteShards(COLLECTION, ["s1"], { signal })).rejects.toBeDefined();
      });
    });
  });
}
