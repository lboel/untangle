/**
 * Integration test against a REAL Qdrant instance.
 *
 * WP-75 (spec.md §3.2 — "Untangle DARF in diesem Modus keine fremden
 * Prozesse oder Container verändern"): this suite has NO default endpoint.
 * A silent fallback to `http://127.0.0.1:6333` would, on any developer
 * machine that happens to run Qdrant locally for an unrelated reason, write
 * and delete test collections in a FOREIGN instance the developer never
 * opted this run into — which is exactly what was observed (the run wrote
 * to a foreign instance and failed; a solo run then "passed" only because
 * the reachability probe is wobbly under parallel load, not because the
 * endpoint was actually safe to use).
 *
 * The suite now runs ONLY when `UNTANGLE_QDRANT_INTEGRATION_URL` is
 * explicitly set by the invoker (an opt-in, not a guess) — otherwise it
 * skips unconditionally, with no reachability probe at all, so an
 * unrelated local Qdrant can never be touched by an ordinary `vitest run`.
 * When the variable IS set, a reachability probe (generous timeout, see
 * `PROBE_TIMEOUT_MS`) still guards against skipping loudly when the
 * explicitly-requested instance simply isn't up yet.
 */
import { randomUUID } from "node:crypto";

import { SystemClock } from "@untangle-code/testkit";
import { afterAll, describe, expect, it } from "vitest";

import { textToBm25SparseVector } from "./bm25-text.js";
import { QdrantGraphStore } from "./graph-store.js";
import { QdrantMetadataStore } from "./metadata-store.js";
import { FetchQdrantTransport } from "./transport.js";
import { QdrantVectorStore } from "./vector-store.js";

// No default: an unset env var means "do not touch any Qdrant instance",
// full stop — see the WP-75 note above.
const QDRANT_URL = process.env["UNTANGLE_QDRANT_INTEGRATION_URL"];

// Generous: an explicitly-requested instance (e.g. a docker-compose service
// still starting up) should get a real chance to answer before the suite
// gives up and skips, rather than flaking under load like the old 1500ms
// probe did.
const PROBE_TIMEOUT_MS = 10000;

async function probeQdrant(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/collections`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const qdrantAvailable = QDRANT_URL !== undefined && (await probeQdrant(QDRANT_URL));
const suite = qdrantAvailable ? describe : describe.skip;

// Randomized per-run prefix: only collections under it are ever touched.
const TEST_PREFIX = `untangle_it_${randomUUID().replace(/-/g, "").slice(0, 10)}_`;

// When the suite is skipped (the normal case — no env var set), `transport`
// and `vectorStore` are constructed but never dialed: `describe.skip` never
// runs the `it`/`afterAll` bodies that would use them. The placeholder URL
// keeps construction well-typed without reintroducing a real default.
const transport = new FetchQdrantTransport({
  url: QDRANT_URL ?? "http://127.0.0.1:0",
  requestTimeoutMs: 10000,
});
const vectorStore = new QdrantVectorStore({
  transport,
  maxRetries: 1,
  retryDelayMs: 50,
  upsertMaxPoints: 64,
  upsertBudgetBytes: 1024 * 1024,
});

async function deleteTestCollections(): Promise<void> {
  const response = await transport.request({ method: "GET", path: "/collections" });
  const result = (response.body as { result?: { collections?: { name?: string }[] } } | undefined)
    ?.result;
  for (const collection of result?.collections ?? []) {
    const name = collection.name;
    // Safety: NEVER delete anything outside this run's own test prefix.
    if (typeof name === "string" && name.startsWith(TEST_PREFIX)) {
      await transport.request({ method: "DELETE", path: `/collections/${name}` });
    }
  }
}

suite("qdrant integration (live instance)", () => {
  afterAll(async () => {
    await deleteTestCollections();
  });

  it("provisions a code-style collection, upserts and answers a hybrid RRF query", async () => {
    const collection = `${TEST_PREFIX}code_v1`;
    await vectorStore.ensureCollection({
      name: collection,
      denseDimensions: 4,
      denseDistance: "Cosine",
      sparseBm25: true,
      onDiskPayload: true,
    });
    await vectorStore.ensureCollection({
      name: collection,
      denseDimensions: 4,
      denseDistance: "Cosine",
      sparseBm25: true,
      onDiskPayload: true,
    }); // idempotent
    await vectorStore.ensurePayloadIndexes(collection, [
      { field: "language", type: "keyword" },
      { field: "sloc", type: "integer" },
    ]);

    await vectorStore.upsert(collection, [
      {
        id: "chunk-resolver",
        dense: [1, 0, 0, 0],
        sparse: textToBm25SparseVector("export function resolveImport(path)"),
        payload: { language: "typescript", sloc: 12 },
      },
      {
        id: "chunk-other",
        dense: [0, 1, 0, 0],
        sparse: textToBm25SparseVector("unrelated markdown prose"),
        payload: { language: "markdown", sloc: 3 },
      },
    ]);
    // Idempotent re-upsert must not duplicate.
    await vectorStore.upsert(collection, [
      {
        id: "chunk-resolver",
        dense: [1, 0, 0, 0],
        sparse: textToBm25SparseVector("export function resolveImport(path)"),
        payload: { language: "typescript", sloc: 12 },
      },
    ]);
    expect(await vectorStore.countByFilter(collection, {})).toBe(2);

    const hits = await vectorStore.hybridQuery(collection, {
      dense: [1, 0, 0, 0],
      sparse: textToBm25SparseVector("resolveImport"),
      filter: { must: [{ field: "language", match: { eq: "typescript" } }] },
      limit: 5,
      withPayload: true,
    });
    expect(hits[0]?.id).toBe("chunk-resolver");
    expect(hits.every((hit) => hit.payload?.["language"] === "typescript")).toBe(true);

    const retrieved = await vectorStore.retrieve(collection, ["chunk-other", "missing"], {
      withVectors: true,
    });
    expect(retrieved.map((point) => point.id)).toEqual(["chunk-other"]);
    expect(retrieved[0]?.dense).toHaveLength(4);
  });

  it("round-trips metadata records without creating collections on status reads", async () => {
    const metadataStore = new QdrantMetadataStore({
      vectorStore,
      collectionPrefix: TEST_PREFIX,
    });
    await expect(metadataStore.getWorkspace("ws-integration")).resolves.toBeNull();
    expect(await vectorStore.collectionExists(`${TEST_PREFIX}metadata_v1`)).toBe(false);

    const record = {
      schemaVersion: 1 as const,
      workspaceId: "ws-integration",
      configHash: "hash-1",
      repositories: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await metadataStore.putWorkspace(record);
    await expect(metadataStore.getWorkspace("ws-integration")).resolves.toEqual(record);
  });

  it("round-trips a multipart graph shard and detects a missing part", async () => {
    const graphStore = new QdrantGraphStore({
      vectorStore,
      clock: new SystemClock(),
      collectionPrefix: TEST_PREFIX,
      partBudgetBytes: 512,
    });
    const payload = {
      edges: Array.from({ length: 50 }, (_, i) => ({ from: `f${i}`, to: `f${i + 1}` })),
      big: "x".repeat(2000),
    };
    await graphStore.writeShards([
      {
        logicalShardId: "shard-1",
        collection: "graph_files",
        generationId: "gen-1",
        writeId: randomUUID(),
        payload,
      },
    ]);
    const read = await graphStore.readShard("graph_files", "shard-1");
    expect(read?.payload).toEqual(payload);

    await vectorStore.deleteByFilter(`${TEST_PREFIX}graph_files_v1`, {
      must: [{ field: "part_index", match: { eq: 0 } }],
    });
    await expect(graphStore.readShard("graph_files", "shard-1")).rejects.toMatchObject({
      code: "GRAPH_INCOMPLETE",
    });
  });
});
