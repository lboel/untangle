/**
 * In-memory `GraphStore` (architecture.md §6.11, §11.6–§11.7). Adapters split
 * large shards into checksum-verified multipart writes; the in-memory store
 * has no size limits, so it always sees one complete shard per write and
 * `GRAPH_INCOMPLETE` can never occur here — that failure mode is exclusively
 * an adapter (WP-11) concern (see README "Entscheidungen").
 */
import type {
  GraphCollection,
  GraphShardV1,
  GraphStore,
  PortCallOptions,
} from "@untangle-code/domain";

import { abortedRejection } from "./abort.js";

type GenerationsByShard = Map<string, Map<string, GraphShardV1>>;

export class InMemoryGraphStore implements GraphStore {
  private readonly byCollection = new Map<GraphCollection, GenerationsByShard>();
  private readonly latestGeneration = new Map<GraphCollection, Map<string, string>>();

  private generationsOf(collection: GraphCollection): GenerationsByShard {
    let byShard = this.byCollection.get(collection);
    if (!byShard) {
      byShard = new Map();
      this.byCollection.set(collection, byShard);
    }
    return byShard;
  }

  private latestOf(collection: GraphCollection): Map<string, string> {
    let latest = this.latestGeneration.get(collection);
    if (!latest) {
      latest = new Map();
      this.latestGeneration.set(collection, latest);
    }
    return latest;
  }

  public writeShards(shards: GraphShardV1[], options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "graph_store_write_shards");
    if (aborted) {
      return aborted;
    }
    for (const shard of shards) {
      const byShard = this.generationsOf(shard.collection);
      let byGeneration = byShard.get(shard.logicalShardId);
      if (!byGeneration) {
        byGeneration = new Map();
        byShard.set(shard.logicalShardId, byGeneration);
      }
      byGeneration.set(shard.generationId, shard);
      this.latestOf(shard.collection).set(shard.logicalShardId, shard.generationId);
    }
    return Promise.resolve();
  }

  public readShard(
    collection: GraphCollection,
    logicalShardId: string,
    options?: PortCallOptions & { generationId?: string },
  ): Promise<GraphShardV1 | null> {
    const aborted = abortedRejection<GraphShardV1 | null>(options, "graph_store_read_shard");
    if (aborted) {
      return aborted;
    }
    const generationId = options?.generationId ?? this.latestOf(collection).get(logicalShardId);
    if (!generationId) {
      return Promise.resolve(null);
    }
    const byGeneration = this.generationsOf(collection).get(logicalShardId);
    return Promise.resolve(byGeneration?.get(generationId) ?? null);
  }

  public listShardIds(
    collection: GraphCollection,
    options?: PortCallOptions & { generationId?: string },
  ): Promise<string[]> {
    const aborted = abortedRejection<string[]>(options, "graph_store_list_shard_ids");
    if (aborted) {
      return aborted;
    }
    const byShard = this.generationsOf(collection);
    const ids: string[] = [];
    if (options?.generationId) {
      for (const [logicalShardId, byGeneration] of byShard) {
        if (byGeneration.has(options.generationId)) {
          ids.push(logicalShardId);
        }
      }
    } else {
      ids.push(...this.latestOf(collection).keys());
    }
    return Promise.resolve(ids.sort());
  }

  public deleteShards(
    collection: GraphCollection,
    logicalShardIds: string[],
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "graph_store_delete_shards");
    if (aborted) {
      return aborted;
    }
    const byShard = this.generationsOf(collection);
    const latest = this.latestOf(collection);
    for (const logicalShardId of logicalShardIds) {
      byShard.delete(logicalShardId);
      latest.delete(logicalShardId);
    }
    return Promise.resolve();
  }
}
