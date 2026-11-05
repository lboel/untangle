import type { GraphShardV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { InMemoryGraphStore } from "./graph-store.js";

function makeShard(overrides: Partial<GraphShardV1> = {}): GraphShardV1 {
  return {
    logicalShardId: "shard-1",
    collection: "graph_files",
    generationId: "gen-1",
    writeId: "write-1",
    payload: { nodes: [] },
    ...overrides,
  };
}

describe("InMemoryGraphStore", () => {
  it("readShard returns null for an unknown shard without creating it", async () => {
    const store = new InMemoryGraphStore();
    expect(await store.readShard("graph_files", "unknown")).toBeNull();
  });

  it("writeShards then readShard round-trips the latest generation by default", async () => {
    const store = new InMemoryGraphStore();
    const shard = makeShard();
    await store.writeShards([shard]);
    expect(await store.readShard("graph_files", "shard-1")).toEqual(shard);
  });

  it("readShard can target a specific, non-latest generation", async () => {
    const store = new InMemoryGraphStore();
    const genA = makeShard({ generationId: "gen-a", payload: { v: 1 } });
    const genB = makeShard({ generationId: "gen-b", payload: { v: 2 } });
    await store.writeShards([genA]);
    await store.writeShards([genB]);

    expect(await store.readShard("graph_files", "shard-1")).toEqual(genB);
    expect(await store.readShard("graph_files", "shard-1", { generationId: "gen-a" })).toEqual(
      genA,
    );
  });

  it("collections are isolated from each other", async () => {
    const store = new InMemoryGraphStore();
    await store.writeShards([makeShard({ collection: "graph_files" })]);
    expect(await store.readShard("graph_indices", "shard-1")).toBeNull();
  });

  it("listShardIds with no generation filter returns the latest shard ids, sorted", async () => {
    const store = new InMemoryGraphStore();
    await store.writeShards([
      makeShard({ logicalShardId: "b" }),
      makeShard({ logicalShardId: "a" }),
    ]);
    expect(await store.listShardIds("graph_files")).toEqual(["a", "b"]);
  });

  it("listShardIds filtered by generation includes every shard with a record at that generation, even once superseded", async () => {
    const store = new InMemoryGraphStore();
    await store.writeShards([
      makeShard({ logicalShardId: "b" }),
      makeShard({ logicalShardId: "a" }),
    ]);
    // "a" moves on to gen-2, but its gen-1 record is retained history, not
    // deleted — a generation-scoped listing answers "which shards have a
    // record at this generation", not "which shards are currently at it".
    await store.writeShards([makeShard({ logicalShardId: "a", generationId: "gen-2" })]);
    expect(await store.listShardIds("graph_files", { generationId: "gen-1" })).toEqual(["a", "b"]);
    expect(await store.listShardIds("graph_files", { generationId: "gen-2" })).toEqual(["a"]);
  });

  it("deleteShards removes both the shard data and its latest-generation pointer", async () => {
    const store = new InMemoryGraphStore();
    await store.writeShards([makeShard()]);
    await store.deleteShards("graph_files", ["shard-1"]);
    expect(await store.readShard("graph_files", "shard-1")).toBeNull();
    expect(await store.listShardIds("graph_files")).toEqual([]);
  });
});
