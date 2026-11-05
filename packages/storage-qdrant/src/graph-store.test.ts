/**
 * Multipart behavior of `QdrantGraphStore` (architecture.md §11.7, §22.2;
 * spec.md §10.6): roundtrip across parts, incomplete/corrupted shards as
 * `GRAPH_INCOMPLETE` (never empty data), crash-window behavior (an
 * incomplete newer write never shadows the last complete one), and stale
 * part cleanup.
 */
import { isUntangleError } from "@untangle-code/domain";
import { FakeClock } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import {
  GRAPH_SHARD_PART_POINT_TYPE,
  QdrantGraphStore,
  splitPayloadIntoParts,
} from "./graph-store.js";
import { FakeQdrantServer } from "./testing/fake-qdrant-server.js";
import type { QdrantHttpRequest, QdrantTransport } from "./transport.js";
import { QdrantVectorStore } from "./vector-store.js";

const PREFIX = "untangle_";
const FILES = `${PREFIX}graph_files_v1`;

interface Setup {
  fake: FakeQdrantServer;
  vectorStore: QdrantVectorStore;
  graphStore: QdrantGraphStore;
  clock: FakeClock;
}

function setup(partBudgetBytes = 256): Setup {
  const fake = new FakeQdrantServer();
  const vectorStore = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
  const clock = new FakeClock(1_700_000_000_000);
  const graphStore = new QdrantGraphStore({
    vectorStore,
    clock,
    collectionPrefix: PREFIX,
    partBudgetBytes,
  });
  return { fake, vectorStore, graphStore, clock };
}

function bigPayload(): Record<string, unknown> {
  return {
    edges: Array.from({ length: 30 }, (_, i) => ({ from: `file-${i}.ts`, to: `file-${i + 1}.ts` })),
    imports: Array.from({ length: 20 }, (_, i) => `module-${i}`),
    content_hash: "abc123",
    huge_entry: "z".repeat(2000), // alone above the 256-byte part budget → fragments
  };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

async function partCount(vectorStore: QdrantVectorStore, shardId: string): Promise<number> {
  return vectorStore.countByFilter(FILES, {
    must: [
      { field: "point_type", match: { eq: GRAPH_SHARD_PART_POINT_TYPE } },
      { field: "logical_shard_id", match: { eq: shardId } },
    ],
  });
}

describe("QdrantGraphStore multipart (architecture.md §11.7)", () => {
  it("splits a large shard entry-wise into multiple parts and reads it back losslessly", async () => {
    const { vectorStore, graphStore } = setup(256);
    const payload = bigPayload();
    await graphStore.writeShards([
      {
        logicalShardId: "s1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: "w1",
        payload,
      },
    ]);

    expect(await partCount(vectorStore, "s1")).toBeGreaterThan(1);
    const read = await graphStore.readShard("graph_files", "s1");
    expect(read?.payload).toEqual(payload);
    expect(read?.writeId).toBe("w1");
    expect(read?.generationId).toBe("gen-1");
  });

  it("every part carries logical_shard_id, part_index, part_count, write_id and checksum", async () => {
    const { fake, graphStore } = setup(256);
    await graphStore.writeShards([
      {
        logicalShardId: "s1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: "w1",
        payload: bigPayload(),
      },
    ]);
    const parts = fake.rawPoints(FILES);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.payload["logical_shard_id"]).toBe("s1");
      expect(part.payload["write_id"]).toBe("w1");
      expect(typeof part.payload["part_index"]).toBe("number");
      expect(part.payload["part_count"]).toBe(parts.length);
      expect(typeof part.payload["checksum"]).toBe("string");
    }
  });

  it("a missing part makes the read fail with GRAPH_INCOMPLETE — never empty data", async () => {
    const { vectorStore, graphStore } = setup(256);
    await graphStore.writeShards([
      {
        logicalShardId: "s1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: "w1",
        payload: bigPayload(),
      },
    ]);
    await vectorStore.deleteByFilter(FILES, {
      must: [
        { field: "logical_shard_id", match: { eq: "s1" } },
        { field: "part_index", match: { eq: 1 } },
      ],
    });
    const error = await errorOf(graphStore.readShard("graph_files", "s1"));
    expect(isUntangleError(error) && error.code).toBe("GRAPH_INCOMPLETE");
    if (isUntangleError(error)) {
      expect(error.message).toContain("s1");
    }
  });

  it("a corrupted part content fails checksum verification with GRAPH_INCOMPLETE", async () => {
    const { vectorStore, graphStore } = setup(1024 * 1024);
    await graphStore.writeShards([
      {
        logicalShardId: "s1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: "w1",
        payload: { nodes: 3 },
      },
    ]);
    // Overwrite the single part with tampered content but intact bookkeeping.
    const page = await vectorStore.scroll(FILES, { limit: 10 });
    const part = page.points[0];
    expect(part).toBeDefined();
    if (part === undefined) {
      return;
    }
    await vectorStore.upsert(FILES, [
      {
        id: part.id,
        dense: [0],
        payload: {
          ...part.payload,
          content: { part_kind: "entries", entries: [["nodes", "4"]] },
        },
      },
    ]);
    const error = await errorOf(graphStore.readShard("graph_files", "s1"));
    expect(isUntangleError(error) && error.code).toBe("GRAPH_INCOMPLETE");
  });

  it("an incomplete NEWER write never shadows the last complete one (crash window)", async () => {
    const { vectorStore, graphStore } = setup(1024 * 1024);
    await graphStore.writeShards([
      {
        logicalShardId: "s1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: "w1",
        payload: { v: 1 },
      },
    ]);
    // Simulate a writer that crashed after storing only part 0 of 2.
    await vectorStore.upsert(FILES, [
      {
        id: "crashed-part-0",
        dense: [0],
        payload: {
          point_type: GRAPH_SHARD_PART_POINT_TYPE,
          logical_shard_id: "s1",
          generation_id: "gen-1",
          write_id: "w2-crashed",
          part_index: 0,
          part_count: 2,
          checksum: "irrelevant",
          written_at_epoch_ms: 1_800_000_000_000,
          content: { part_kind: "entries", entries: [] },
        },
      },
    ]);
    const read = await graphStore.readShard("graph_files", "s1");
    expect(read?.payload).toEqual({ v: 1 }); // last COMPLETE write wins
    expect(read?.writeId).toBe("w1");
  });

  it("a shard whose ONLY write is incomplete is GRAPH_INCOMPLETE, not null and not empty", async () => {
    const { vectorStore, graphStore } = setup();
    await vectorStore.ensureCollection({
      name: FILES,
      denseDimensions: 1,
      denseDistance: "Dot",
      sparseBm25: false,
      onDiskPayload: true,
    });
    await vectorStore.upsert(FILES, [
      {
        id: "torso-part",
        dense: [0],
        payload: {
          point_type: GRAPH_SHARD_PART_POINT_TYPE,
          logical_shard_id: "torso",
          generation_id: "gen-1",
          write_id: "w1",
          part_index: 0,
          part_count: 3,
          checksum: "x",
          written_at_epoch_ms: 1,
          content: { part_kind: "entries", entries: [] },
        },
      },
    ]);
    const error = await errorOf(graphStore.readShard("graph_files", "torso"));
    expect(isUntangleError(error) && error.code).toBe("GRAPH_INCOMPLETE");
    // Explicit generation read fails the same way (spec.md §10.6: an
    // incomplete generation is never served as complete).
    const generationError = await errorOf(
      graphStore.readShard("graph_files", "torso", { generationId: "gen-1" }),
    );
    expect(isUntangleError(generationError) && generationError.code).toBe("GRAPH_INCOMPLETE");
  });

  it("rewriting a shard with fewer parts cleans up the previous write's parts", async () => {
    const { vectorStore, graphStore } = setup(256);
    await graphStore.writeShards([
      {
        logicalShardId: "s1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: "w1",
        payload: bigPayload(),
      },
    ]);
    expect(await partCount(vectorStore, "s1")).toBeGreaterThan(1);
    await graphStore.writeShards([
      {
        logicalShardId: "s1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: "w2",
        payload: { tiny: true },
      },
    ]);
    expect(await partCount(vectorStore, "s1")).toBe(1);
    const read = await graphStore.readShard("graph_files", "s1");
    expect(read?.payload).toEqual({ tiny: true });
    expect(read?.writeId).toBe("w2");
  });
});

describe("splitPayloadIntoParts", () => {
  it("packs small entries together and fragments an oversized entry", () => {
    const parts = splitPayloadIntoParts({ a: 1, b: "x", huge: "y".repeat(1000) }, 128);
    const kinds = parts.map((part) => part.part_kind);
    expect(kinds).toContain("entries");
    expect(kinds).toContain("entry_fragment");
    const fragments = parts.filter((part) => part.part_kind === "entry_fragment");
    expect(fragments.length).toBeGreaterThan(1);
    expect(
      new Set(fragments.map((f) => (f.part_kind === "entry_fragment" ? f.fragment_count : 0))).size,
    ).toBe(1);
  });

  it("produces exactly one empty part for an empty payload", () => {
    expect(splitPayloadIntoParts({}, 128)).toEqual([{ part_kind: "entries", entries: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Regression WP-77: concurrent writeShard() calls on the same
// (logical_shard_id, generation_id) must never delete each other's parts and
// both report success while the shard vanishes (silent data loss). The
// adversarial reproduction interleaved the raw REST steps of two writers so
// that BOTH upserts land before EITHER cleanup runs; the old protocol
// ("delete every other write") then let cleanup-C delete D's parts and
// cleanup-D delete C's — readShard() afterwards returned null although both
// writers returned without error.
// ---------------------------------------------------------------------------

/**
 * Transport wrapper that parks selected requests until the test releases
 * them, so the exact adversarial interleaving is replayed DETERMINISTICALLY
 * (no reliance on scheduler luck).
 */
class GatedTransport implements QdrantTransport {
  public constructor(
    private readonly inner: QdrantTransport,
    private readonly gate: (request: QdrantHttpRequest) => Promise<void> | undefined,
  ) {}

  public async request(
    request: QdrantHttpRequest,
    options?: Parameters<QdrantTransport["request"]>[1],
  ): ReturnType<QdrantTransport["request"]> {
    const hold = this.gate(request);
    if (hold !== undefined) {
      await hold;
    }
    return this.inner.request(request, options);
  }
}

type GatedKind = "delete" | "count";

interface Hold {
  writer: string;
  kind: GatedKind;
  release: () => void;
}

function kindOf(request: QdrantHttpRequest): GatedKind | undefined {
  if (request.path.includes("/points/delete")) {
    return "delete";
  }
  if (request.path.includes("/points/count")) {
    return "count";
  }
  return undefined;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe("QdrantGraphStore concurrent writers (WP-77 regression)", () => {
  const logicalShardId = "file:concurrent.ts";
  const generationId = "gen-9";
  const shardOf = (writeId: string, payload: Record<string, unknown>) =>
    ({
      logicalShardId,
      collection: "graph_files",
      generationId,
      writeId,
      payload,
    }) as const;

  it("adversarial interleaving (both upserts before both cleanups): the shard survives and the overtaken writer gets an error — never two successes over a vanished shard", async () => {
    const fake = new FakeQdrantServer();
    const holds: Hold[] = [];
    const gatedStore = (writer: string, clockMs: number): QdrantGraphStore => {
      const transport = new GatedTransport(fake, (request) => {
        const kind = kindOf(request);
        if (kind === undefined) {
          return undefined;
        }
        return new Promise<void>((resolve) => {
          holds.push({ writer, kind, release: resolve });
        });
      });
      return new QdrantGraphStore({
        vectorStore: new QdrantVectorStore({ transport, maxRetries: 0, retryDelayMs: 0 }),
        clock: new FakeClock(clockMs),
        collectionPrefix: PREFIX,
      });
    };
    const take = (writer: string, kind: GatedKind): Hold => {
      const index = holds.findIndex((hold) => hold.writer === writer && hold.kind === kind);
      if (index < 0) {
        throw new Error(`no parked ${kind} request of writer ${writer}`);
      }
      return holds.splice(index, 1)[0] as Hold;
    };

    // Writer C is the OLDER write, writer D the newer one (distinct worker
    // processes, hence two store instances over one backing server).
    const storeC = gatedStore("C", 1_000);
    const storeD = gatedStore("D", 2_000);
    const writeC = storeC.writeShards([shardOf("write-C", { deps: ["m1", "m2", "m3"] })]);
    const writeD = storeD.writeShards([shardOf("write-D", { deps: ["n1"] })]);
    // Attach handlers immediately so a rejection is never "unhandled".
    writeC.catch(() => undefined);
    writeD.catch(() => undefined);

    // Step 1+2 (implicit): both writers upsert their parts — proven by both
    // having reached their (parked) cleanup call.
    await waitFor(
      () => holds.filter((hold) => hold.kind === "delete").length === 2,
      "both upserts done, both cleanups parked",
    );
    // Step 3: writer C runs its cleanup.
    take("C", "delete").release();
    await waitFor(() => holds.some((h) => h.writer === "C" && h.kind === "count"), "C at verify");
    // Step 4: writer D runs its cleanup (this is where the old protocol
    // deleted C's parts — and C's cleanup had already deleted D's).
    take("D", "delete").release();
    await waitFor(() => holds.some((h) => h.writer === "D" && h.kind === "count"), "D at verify");
    // Only now may either writer verify/return.
    take("C", "count").release();
    take("D", "count").release();

    const [resultC, resultD] = await Promise.allSettled([writeC, writeD]);

    // The overtaken OLDER writer must get an error instead of silent success.
    expect(resultC.status).toBe("rejected");
    const reason = (resultC as PromiseRejectedResult).reason as unknown;
    expect(isUntangleError(reason)).toBe(true);
    if (isUntangleError(reason)) {
      expect(reason.code).toBe("LOCK_HELD");
      expect(reason.retryable).toBe(true);
    }
    // The newer writer's data survives intact.
    expect(resultD.status).toBe("fulfilled");

    // Core invariant of the defect: NEVER "both writers succeed and the
    // shard is gone". Here: at least one writer failed AND a complete,
    // checksum-verified shard is readable.
    const reader = new QdrantGraphStore({
      vectorStore: new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 }),
      clock: new FakeClock(9_000),
      collectionPrefix: PREFIX,
    });
    const read = await reader.readShard("graph_files", logicalShardId);
    const bothSucceeded = resultC.status === "fulfilled" && resultD.status === "fulfilled";
    expect(bothSucceeded && read === null).toBe(false);
    expect(read).not.toBeNull();
    expect(read?.writeId).toBe("write-D");
    expect(read?.payload).toEqual({ deps: ["n1"] });
  });

  it("two writers with IDENTICAL timestamps never annihilate each other; reads resolve the tie deterministically", async () => {
    const fake = new FakeQdrantServer();
    const storeOf = (): QdrantGraphStore =>
      new QdrantGraphStore({
        vectorStore: new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 }),
        clock: new FakeClock(5_000),
        collectionPrefix: PREFIX,
      });
    const storeA = storeOf();
    const storeB = storeOf();
    await storeA.writeShards([shardOf("write-A", { deps: ["a"] })]);
    await storeB.writeShards([shardOf("write-B", { deps: ["b"] })]);

    // Strict-lt cleanup deletes neither equal-timestamp write: both remain.
    const remaining = await new QdrantVectorStore({
      transport: fake,
      maxRetries: 0,
      retryDelayMs: 0,
    }).countByFilter(FILES, {
      must: [
        { field: "point_type", match: { eq: GRAPH_SHARD_PART_POINT_TYPE } },
        { field: "logical_shard_id", match: { eq: logicalShardId } },
      ],
    });
    expect(remaining).toBe(2);

    // The reader resolves the tie by the greatest write_id — identically on
    // every read.
    const first = await storeA.readShard("graph_files", logicalShardId);
    const second = await storeB.readShard("graph_files", logicalShardId);
    expect(first?.writeId).toBe("write-B");
    expect(second?.writeId).toBe("write-B");
    expect(first?.payload).toEqual({ deps: ["b"] });
  });
});
