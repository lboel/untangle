/**
 * `GraphStore` adapter over the graph collections (architecture.md §11.6)
 * with multipart writes per architecture.md §11.7.
 *
 * Write model:
 * - one logical shard is split ENTRY-WISE (top-level payload entries) into
 *   parts within a per-part byte budget; a single entry larger than the
 *   budget is further split into string fragments of its canonical JSON;
 * - every part carries `logical_shard_id`, `part_index`, `part_count`,
 *   `write_id` and the SHA-256 checksum of the whole shard payload
 *   (canonical JSON), plus a monotonic `written_at_epoch_ms` from the
 *   injected Clock port (never `Date.now()`);
 * - after a successful write, stale parts of STRICTLY OLDER writes (by
 *   `written_at_epoch_ms`) of the same (shard, generation) are deleted, so a
 *   write behaves like an atomic replace once complete. Cleanup NEVER
 *   touches writes with an equal or newer timestamp — two concurrent
 *   writers therefore can never delete each other's parts symmetrically
 *   (mutual annihilation), because "A deletes B" requires B to be strictly
 *   older than A, which is antisymmetric;
 * - after cleanup, the writer VERIFIES its own parts are still fully
 *   present. A writer whose parts were removed by a concurrent newer
 *   writer's cleanup was overtaken and throws `LOCK_HELD`
 *   (`retryable: true`) instead of silently reporting success. Since at
 *   most one of two racing writers can be strictly older, at least one
 *   writer always survives with a complete write — a reader never finds
 *   the shard empty after concurrent "successful" writes.
 *
 * Read model (architecture.md §22.2: an incomplete multipart shard is an
 * ERROR, never empty data):
 * - parts are grouped by (generation, write); a group is COMPLETE when all
 *   `part_index` 0..part_count-1 are present exactly once with one
 *   `write_id`, one `part_count`, one checksum, and the reassembled payload
 *   hashes to that checksum;
 * - the newest COMPLETE group (by `written_at_epoch_ms`, ties broken
 *   deterministically by the lexicographically greatest `write_id`) wins —
 *   a newer but incomplete write (e.g. a crashed writer) never shadows the
 *   last complete one, and is itself never served;
 * - when parts exist but NO complete group does, `readShard` throws
 *   `GRAPH_INCOMPLETE`; only a shard with no parts at all is `null`.
 */
import { Buffer } from "node:buffer";

import type {
  Clock,
  CollectionSpecV1,
  GraphCollection,
  GraphShardV1,
  GraphStore,
  PayloadFilter,
  PortCallOptions,
  VectorPointV1,
  VectorStore,
} from "@untangle-code/domain";
import { canonicalJson, sha256Hex } from "@untangle-code/domain";
import {
  graphIncompleteError,
  lockHeldError,
  qdrantUnavailableError,
} from "@untangle-code/observability";

import { abortedRejection, throwIfAborted } from "./abort.js";
import { graphCollectionName } from "./collections.js";

export const GRAPH_SHARD_PART_POINT_TYPE = "graph_shard_part";

/** Collection schema for graph shard parts: 1-dim dummy vector, no sparse. */
export function graphCollectionSpec(name: string): CollectionSpecV1 {
  return {
    name,
    denseDimensions: 1,
    denseDistance: "Dot",
    sparseBm25: false,
    onDiskPayload: true,
  };
}

export interface QdrantGraphStoreOptions {
  vectorStore: VectorStore;
  /** Time source for `written_at_epoch_ms` (never `Date.now()`). */
  clock: Clock;
  /** Collection prefix (architecture.md §11.1); default "untangle_". */
  collectionPrefix?: string;
  /** Per-part payload budget in bytes (architecture.md §11.7); default 1 MiB. */
  partBudgetBytes?: number;
}

/** Content of one part: either whole entries or one fragment of an oversized entry. */
type PartContent =
  | { part_kind: "entries"; entries: [string, string][] }
  | {
      part_kind: "entry_fragment";
      fragment_key: string;
      fragment_index: number;
      fragment_count: number;
      fragment_segment: string;
    };

interface StoredPart {
  logicalShardId: string;
  generationId: string;
  writeId: string;
  partIndex: number;
  partCount: number;
  checksum: string;
  writtenAt: number;
  content: PartContent;
}

const DUMMY_DENSE: number[] = [0];

export class QdrantGraphStore implements GraphStore {
  private readonly store: VectorStore;
  private readonly clock: Clock;
  private readonly prefix: string;
  private readonly partBudgetBytes: number;
  private readonly provisioned = new Set<string>();
  private lastWrittenAt = 0;

  public constructor(options: QdrantGraphStoreOptions) {
    this.store = options.vectorStore;
    this.clock = options.clock;
    this.prefix = options.collectionPrefix ?? "untangle_";
    this.partBudgetBytes = options.partBudgetBytes ?? 1024 * 1024;
    if (this.partBudgetBytes <= 0) {
      throw qdrantUnavailableError("partBudgetBytes must be a positive integer", {
        context: { partBudgetBytes: this.partBudgetBytes },
      });
    }
    // Validate the prefix eagerly.
    graphCollectionName(this.prefix, "graph_meta");
  }

  public async writeShards(shards: GraphShardV1[], options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "graph_store_write_shards");
    if (aborted) {
      return aborted;
    }
    for (const shard of shards) {
      throwIfAborted(options?.signal, "graph_store_write_shards");
      await this.writeShard(shard, options);
    }
  }

  public async readShard(
    collection: GraphCollection,
    logicalShardId: string,
    options?: PortCallOptions & { generationId?: string },
  ): Promise<GraphShardV1 | null> {
    const aborted = abortedRejection<GraphShardV1 | null>(options, "graph_store_read_shard");
    if (aborted) {
      return aborted;
    }
    const parts = await this.scrollParts(
      collection,
      {
        must: [
          { field: "point_type", match: { eq: GRAPH_SHARD_PART_POINT_TYPE } },
          { field: "logical_shard_id", match: { eq: logicalShardId } },
          ...(options?.generationId === undefined
            ? []
            : [{ field: "generation_id", match: { eq: options.generationId } } as const]),
        ],
      },
      options,
    );
    if (parts.length === 0) {
      return null;
    }

    // Group by (generation, write); pick the newest COMPLETE group.
    const groups = new Map<string, StoredPart[]>();
    for (const part of parts) {
      const key = JSON.stringify([part.generationId, part.writeId]);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [part]);
      } else {
        group.push(part);
      }
    }
    let winner: { parts: StoredPart[]; writtenAt: number; writeId: string } | undefined;
    const incompleteReasons: string[] = [];
    for (const group of groups.values()) {
      const completeness = checkGroupComplete(group);
      if (completeness !== "complete") {
        incompleteReasons.push(completeness);
        continue;
      }
      const writtenAt = Math.max(...group.map((part) => part.writtenAt));
      const writeId = (group[0] as StoredPart).writeId;
      // Deterministic winner: newest by written_at, ties broken by the
      // lexicographically greatest write_id. Two concurrent writers with an
      // identical timestamp (strict-lt cleanup deletes neither) must always
      // resolve to the SAME shard on every read.
      if (
        winner === undefined ||
        writtenAt > winner.writtenAt ||
        (writtenAt === winner.writtenAt && writeId > winner.writeId)
      ) {
        winner = { parts: group, writtenAt, writeId };
      }
    }
    if (winner === undefined) {
      // Parts exist but no write is complete — an ERROR, never empty data
      // (architecture.md §22.2).
      throw graphIncompleteError(
        `Multipart shard "${logicalShardId}" in "${collection}" has no complete, ` +
          `consistent write: ${incompleteReasons.join("; ")}`,
        {
          operation: "graph_store_read_shard",
          context: {
            collection,
            logicalShardId,
            ...(options?.generationId === undefined ? {} : { generationId: options.generationId }),
            reasons: incompleteReasons,
          },
        },
      );
    }

    const first = winner.parts[0] as StoredPart;
    const payload = reassemblePayload(winner.parts, collection, logicalShardId);
    const checksum = sha256Hex(canonicalJson(payload));
    if (checksum !== first.checksum) {
      throw graphIncompleteError(
        `Multipart shard "${logicalShardId}" in "${collection}" failed checksum ` +
          `verification (stored ${first.checksum}, computed ${checksum})`,
        {
          operation: "graph_store_read_shard",
          context: { collection, logicalShardId, stored: first.checksum, computed: checksum },
        },
      );
    }
    return {
      logicalShardId,
      collection,
      generationId: first.generationId,
      writeId: first.writeId,
      payload,
    };
  }

  public async listShardIds(
    collection: GraphCollection,
    options?: PortCallOptions & { generationId?: string },
  ): Promise<string[]> {
    const aborted = abortedRejection<string[]>(options, "graph_store_list_shard_ids");
    if (aborted) {
      return aborted;
    }
    const parts = await this.scrollParts(
      collection,
      {
        must: [
          { field: "point_type", match: { eq: GRAPH_SHARD_PART_POINT_TYPE } },
          ...(options?.generationId === undefined
            ? []
            : [{ field: "generation_id", match: { eq: options.generationId } } as const]),
        ],
      },
      options,
    );
    const ids = new Set<string>();
    for (const part of parts) {
      ids.add(part.logicalShardId);
    }
    return [...ids].sort();
  }

  public async deleteShards(
    collection: GraphCollection,
    logicalShardIds: string[],
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "graph_store_delete_shards");
    if (aborted) {
      return aborted;
    }
    if (logicalShardIds.length === 0) {
      return;
    }
    await this.store.deleteByFilter(
      this.collectionName(collection),
      {
        must: [
          { field: "point_type", match: { eq: GRAPH_SHARD_PART_POINT_TYPE } },
          { field: "logical_shard_id", match: { in: logicalShardIds } },
        ],
      },
      options,
    );
  }

  // -- internals ------------------------------------------------------------

  private collectionName(collection: GraphCollection): string {
    return graphCollectionName(this.prefix, collection);
  }

  private nextWrittenAt(): number {
    // Strictly monotonic per store instance so successive writes are always
    // ordered, even under a frozen test clock.
    this.lastWrittenAt = Math.max(this.clock.nowEpochMs(), this.lastWrittenAt + 1);
    return this.lastWrittenAt;
  }

  private async writeShard(shard: GraphShardV1, options?: PortCallOptions): Promise<void> {
    const collectionName = this.collectionName(shard.collection);
    if (!this.provisioned.has(collectionName)) {
      await this.store.ensureCollection(graphCollectionSpec(collectionName), options);
      this.provisioned.add(collectionName);
    }

    const checksum = sha256Hex(canonicalJson(shard.payload));
    const contents = splitPayloadIntoParts(shard.payload, this.partBudgetBytes);
    const writtenAt = this.nextWrittenAt();
    const points: VectorPointV1[] = contents.map((content, partIndex) => ({
      id: JSON.stringify([
        "graph",
        shard.collection,
        shard.logicalShardId,
        shard.generationId,
        shard.writeId,
        partIndex,
      ]),
      dense: DUMMY_DENSE,
      payload: {
        point_type: GRAPH_SHARD_PART_POINT_TYPE,
        logical_shard_id: shard.logicalShardId,
        generation_id: shard.generationId,
        write_id: shard.writeId,
        part_index: partIndex,
        part_count: contents.length,
        checksum,
        written_at_epoch_ms: writtenAt,
        content: content as unknown as Record<string, unknown>,
      },
    }));
    await this.store.upsert(collectionName, points, options);

    // The new write is fully stored — now drop STRICTLY OLDER writes (by
    // written_at_epoch_ms) of the same (shard, generation), including
    // leftover parts of a previous write. Deliberately NOT "every other
    // write": two concurrent writers whose upserts both land before either
    // cleanup runs would otherwise delete each other's parts and leave the
    // shard EMPTY while both report success (silent data loss). With the
    // strict-lt bound, "A deletes B" requires writtenAt(B) < writtenAt(A) —
    // an antisymmetric relation, so at most one of two racing writers can
    // lose its parts and the write with the greatest timestamp always
    // survives complete. Leftover higher part_index points of an earlier,
    // LARGER write with the SAME write_id cannot exist: part point ids embed
    // the write_id, and a write_id identifies exactly one write (domain
    // ports.ts).
    await this.store.deleteByFilter(
      collectionName,
      {
        must: [
          { field: "point_type", match: { eq: GRAPH_SHARD_PART_POINT_TYPE } },
          { field: "logical_shard_id", match: { eq: shard.logicalShardId } },
          { field: "generation_id", match: { eq: shard.generationId } },
          { field: "written_at_epoch_ms", range: { lt: writtenAt } },
        ],
        mustNot: [{ field: "write_id", match: { eq: shard.writeId } }],
      },
      options,
    );

    // Post-write verification: a concurrent NEWER writer's cleanup may have
    // deleted this write's parts between our upsert and now. A writer whose
    // result was overtaken MUST report an error instead of silently claiming
    // success (domain ports.ts invariant: readers see a complete shard or an
    // error — a writer must never believe a vanished write was stored).
    const remaining = await this.store.countByFilter(
      collectionName,
      {
        must: [
          { field: "point_type", match: { eq: GRAPH_SHARD_PART_POINT_TYPE } },
          { field: "logical_shard_id", match: { eq: shard.logicalShardId } },
          { field: "generation_id", match: { eq: shard.generationId } },
          { field: "write_id", match: { eq: shard.writeId } },
        ],
      },
      options,
    );
    if (remaining !== points.length) {
      throw lockHeldError(
        `Write "${shard.writeId}" of shard "${shard.logicalShardId}" ` +
          `(generation "${shard.generationId}") was overtaken by a concurrent ` +
          `writer: ${remaining} of ${points.length} parts remain after commit. ` +
          `The newer concurrent write survives; retry against the current state ` +
          `if this write must still be applied.`,
        {
          operation: "graph_store_write_shard",
          retryable: true,
          context: {
            collection: collectionName,
            logicalShardId: shard.logicalShardId,
            generationId: shard.generationId,
            writeId: shard.writeId,
            expectedParts: points.length,
            remainingParts: remaining,
          },
        },
      );
    }
  }

  private async scrollParts(
    collection: GraphCollection,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<StoredPart[]> {
    const collectionName = this.collectionName(collection);
    const parts: StoredPart[] = [];
    let offset: string | undefined;
    for (;;) {
      const page = await this.store.scroll(
        collectionName,
        { filter, limit: 256, ...(offset === undefined ? {} : { offset }) },
        options,
      );
      for (const point of page.points) {
        const part = parseStoredPart(point.payload);
        if (part !== undefined) {
          parts.push(part);
        }
      }
      if (page.nextOffset === undefined) {
        return parts;
      }
      if (page.nextOffset === offset) {
        throw qdrantUnavailableError(
          `Graph scroll cursor did not advance (collection "${collectionName}")`,
          { operation: "graph_store_scroll", context: { collection: collectionName } },
        );
      }
      offset = page.nextOffset;
    }
  }
}

/**
 * Splits a shard payload entry-wise into part contents within the byte
 * budget (architecture.md §11.7: large graph shards are split entry-wise).
 * A single entry whose canonical JSON exceeds the budget is split into
 * string fragments that concatenate back losslessly.
 */
export function splitPayloadIntoParts(
  payload: Record<string, unknown>,
  budgetBytes: number,
): PartContent[] {
  const entries: [string, string][] = Object.keys(payload)
    .sort()
    .filter((key) => payload[key] !== undefined)
    .map((key) => [key, canonicalJson(payload[key])]);

  const parts: PartContent[] = [];
  let current: [string, string][] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length > 0) {
      parts.push({ part_kind: "entries", entries: current });
      current = [];
      currentBytes = 0;
    }
  };

  for (const [key, json] of entries) {
    const entryBytes = utf8Length(key) + utf8Length(json) + 16;
    if (entryBytes > budgetBytes) {
      flush();
      // Fragment the oversized entry. Segment length is counted in UTF-16
      // code units with a conservative divisor (JSON escaping may inflate a
      // code unit to up to 6 bytes on the wire).
      const segmentLength = Math.max(1, Math.floor(budgetBytes / 6));
      const segments: string[] = [];
      for (let i = 0; i < json.length; i += segmentLength) {
        segments.push(json.slice(i, i + segmentLength));
      }
      segments.forEach((segment, fragmentIndex) => {
        parts.push({
          part_kind: "entry_fragment",
          fragment_key: key,
          fragment_index: fragmentIndex,
          fragment_count: segments.length,
          fragment_segment: segment,
        });
      });
      continue;
    }
    if (current.length > 0 && currentBytes + entryBytes > budgetBytes) {
      flush();
    }
    current.push([key, json]);
    currentBytes += entryBytes;
  }
  flush();

  if (parts.length === 0) {
    // An empty payload still needs one part so the shard exists at all.
    parts.push({ part_kind: "entries", entries: [] });
  }
  return parts;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** "complete" or a human-readable inconsistency description. */
function checkGroupComplete(group: StoredPart[]): string {
  const first = group[0] as StoredPart;
  const partCount = first.partCount;
  if (!group.every((part) => part.partCount === partCount)) {
    return `write "${first.writeId}": inconsistent part_count values`;
  }
  if (!group.every((part) => part.checksum === first.checksum)) {
    return `write "${first.writeId}": inconsistent checksums`;
  }
  const seen = new Set<number>();
  for (const part of group) {
    if (seen.has(part.partIndex)) {
      return `write "${first.writeId}": duplicate part_index ${part.partIndex}`;
    }
    seen.add(part.partIndex);
  }
  if (group.length !== partCount) {
    return (
      `write "${first.writeId}": ${group.length} of ${partCount} parts present ` +
      `(missing: ${missingIndexes(seen, partCount).join(", ")})`
    );
  }
  for (let i = 0; i < partCount; i += 1) {
    if (!seen.has(i)) {
      return `write "${first.writeId}": missing part_index ${i}`;
    }
  }
  return "complete";
}

function missingIndexes(seen: Set<number>, partCount: number): number[] {
  const missing: number[] = [];
  for (let i = 0; i < partCount; i += 1) {
    if (!seen.has(i)) {
      missing.push(i);
    }
  }
  return missing;
}

function reassemblePayload(
  parts: StoredPart[],
  collection: GraphCollection,
  logicalShardId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const fragments = new Map<string, { count: number; segments: (string | undefined)[] }>();
  const fail = (reason: string): never => {
    throw graphIncompleteError(
      `Multipart shard "${logicalShardId}" in "${collection}" cannot be reassembled: ${reason}`,
      { operation: "graph_store_read_shard", context: { collection, logicalShardId, reason } },
    );
  };

  const ordered = [...parts].sort((a, b) => a.partIndex - b.partIndex);
  for (const part of ordered) {
    const content = part.content;
    if (content.part_kind === "entries") {
      for (const [key, json] of content.entries) {
        if (key in payload || fragments.has(key)) {
          fail(`duplicate entry key "${key}"`);
        }
        payload[key] = parseJsonOrFail(json, key, fail);
      }
      continue;
    }
    if (content.part_kind !== "entry_fragment") {
      fail("unknown part content kind");
    }
    let state = fragments.get(content.fragment_key);
    if (state === undefined) {
      if (content.fragment_key in payload) {
        fail(`duplicate entry key "${content.fragment_key}"`);
      }
      state = {
        count: content.fragment_count,
        segments: new Array<string | undefined>(content.fragment_count).fill(undefined),
      };
      fragments.set(content.fragment_key, state);
    }
    if (
      content.fragment_count !== state.count ||
      content.fragment_index < 0 ||
      content.fragment_index >= state.count ||
      state.segments[content.fragment_index] !== undefined
    ) {
      fail(`inconsistent fragments for entry "${content.fragment_key}"`);
    }
    state.segments[content.fragment_index] = content.fragment_segment;
  }
  for (const [key, state] of fragments) {
    if (state.segments.some((segment) => segment === undefined)) {
      fail(`missing fragments for entry "${key}"`);
    }
    payload[key] = parseJsonOrFail(state.segments.join(""), key, fail);
  }
  return payload;
}

function parseJsonOrFail(json: string, key: string, fail: (reason: string) => never): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return fail(`entry "${key}" holds invalid JSON`);
  }
}

function parseStoredPart(payload: Record<string, unknown>): StoredPart | undefined {
  const logicalShardId = payload["logical_shard_id"];
  const generationId = payload["generation_id"];
  const writeId = payload["write_id"];
  const partIndex = payload["part_index"];
  const partCount = payload["part_count"];
  const checksum = payload["checksum"];
  const writtenAt = payload["written_at_epoch_ms"];
  const content = payload["content"];
  if (
    typeof logicalShardId !== "string" ||
    typeof generationId !== "string" ||
    typeof writeId !== "string" ||
    typeof partIndex !== "number" ||
    typeof partCount !== "number" ||
    typeof checksum !== "string" ||
    typeof writtenAt !== "number" ||
    typeof content !== "object" ||
    content === null
  ) {
    return undefined;
  }
  return {
    logicalShardId,
    generationId,
    writeId,
    partIndex,
    partCount,
    checksum,
    writtenAt,
    content: content as PartContent,
  };
}
