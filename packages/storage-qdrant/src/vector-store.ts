/**
 * `VectorStore` adapter over the Qdrant REST API (spec.md §10;
 * architecture.md §11).
 *
 * Guarantees (beyond the port contract, see README "Entscheidungen"):
 * - upserts are idempotent (deterministic UUID per port-level id) and
 *   batched by BOTH point count AND serialized byte size (spec.md §10.5,
 *   architecture.md §11.7: flush when `point_count >= max_points OR
 *   serialized_bytes + next_point_bytes > budget`);
 * - a single point larger than the byte budget is rejected with
 *   `POINT_TOO_LARGE`, identifying the point — never dropped silently;
 * - a server-side batch failure is isolated per point (the batch is retried
 *   point-by-point); every failure is reported with the server's reason,
 *   nothing is silently lost;
 * - read/status methods NEVER create a collection as a side effect
 *   (architecture.md §11.5): a missing collection is a safe empty result
 *   for reads, while a transport timeout/network failure is thrown as
 *   `QDRANT_UNAVAILABLE` — a timeout is never "collection missing"
 *   (architecture.md §22.2);
 * - hybrid queries run dense + BM25 prefetch and RRF fusion INSIDE one
 *   collection with payload filters evaluated in Qdrant (spec.md §13.2
 *   steps 5–7, §13.4).
 */
import { Buffer } from "node:buffer";

import type {
  CollectionSpecV1,
  HybridQueryV1,
  PayloadFilter,
  PayloadIndexSpecV1,
  PortCallOptions,
  ScoredPointV1,
  ScrollPageV1,
  ScrollRequestV1,
  SparseVectorV1,
  VectorPointV1,
  VectorStore,
} from "@untangle-code/domain";
import {
  pointTooLargeError,
  qdrantSchemaIncompatibleError,
  qdrantUnavailableError,
} from "@untangle-code/observability";

import { abortedRejection, throwIfAborted } from "./abort.js";
import { toQdrantFilter } from "./filter.js";
import { STORED_POINT_ID_PAYLOAD_KEY, splitStoredPayload, toQdrantPointId } from "./point-id.js";
import {
  QdrantRestClient,
  expectOk,
  isCollectionMissing,
  resultOf,
  serverReason,
} from "./rest-client.js";
import type { QdrantHttpRequest, QdrantHttpResponse, QdrantTransport } from "./transport.js";

export interface QdrantVectorStoreOptions {
  transport: QdrantTransport;
  /** Extra attempts for retryable failures; default 3. */
  maxRetries?: number;
  /** Base retry delay in ms; default 200 (use 0 in tests). */
  retryDelayMs?: number;
  /** Upsert batch limit by point count; default 256 (spec.md §10.5). */
  upsertMaxPoints?: number;
  /** Upsert batch limit by serialized bytes; default 4 MiB (spec.md §10.5). */
  upsertBudgetBytes?: number;
}

interface WirePoint {
  id: string;
  vector: Record<string, unknown>;
  payload: Record<string, unknown>;
}

interface WireScoredPoint {
  id?: unknown;
  score?: unknown;
  payload?: unknown;
  vector?: unknown;
}

const QDRANT_FIELD_SCHEMA: Record<PayloadIndexSpecV1["type"], string> = {
  keyword: "keyword",
  integer: "integer",
  float: "float",
  bool: "bool",
};

export class QdrantVectorStore implements VectorStore {
  public readonly backend = "qdrant" as const;
  private readonly client: QdrantRestClient;
  private readonly upsertMaxPoints: number;
  private readonly upsertBudgetBytes: number;

  public constructor(options: QdrantVectorStoreOptions) {
    this.client = new QdrantRestClient(options.transport, {
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 200,
    });
    this.upsertMaxPoints = options.upsertMaxPoints ?? 256;
    this.upsertBudgetBytes = options.upsertBudgetBytes ?? 4 * 1024 * 1024;
    if (this.upsertMaxPoints <= 0 || this.upsertBudgetBytes <= 0) {
      throw qdrantUnavailableError(
        "upsertMaxPoints and upsertBudgetBytes must be positive integers",
        {
          context: {
            upsertMaxPoints: this.upsertMaxPoints,
            upsertBudgetBytes: this.upsertBudgetBytes,
          },
        },
      );
    }
  }

  public async collectionExists(name: string, options?: PortCallOptions): Promise<boolean> {
    const aborted = abortedRejection<boolean>(options, "vector_store_collection_exists");
    if (aborted) {
      return aborted;
    }
    const request: QdrantHttpRequest = { method: "GET", path: `/collections/${name}` };
    const response = await this.client.call(request, options);
    if (isCollectionMissing(response)) {
      return false;
    }
    expectOk(response, "collection_exists", request);
    return true;
  }

  public async ensureCollection(spec: CollectionSpecV1, options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "vector_store_ensure_collection");
    if (aborted) {
      return aborted;
    }
    const getRequest: QdrantHttpRequest = { method: "GET", path: `/collections/${spec.name}` };
    const info = await this.client.call(getRequest, options);
    if (!isCollectionMissing(info)) {
      expectOk(info, "ensure_collection", getRequest);
      assertCollectionCompatible(spec, resultOf(info));
      return;
    }
    const createRequest: QdrantHttpRequest = {
      method: "PUT",
      path: `/collections/${spec.name}`,
      body: {
        vectors: {
          dense: { size: spec.denseDimensions, distance: spec.denseDistance },
        },
        ...(spec.sparseBm25 ? { sparse_vectors: { bm25: { modifier: "idf" } } } : {}),
        on_disk_payload: spec.onDiskPayload,
      },
    };
    const created = await this.client.call(createRequest, options);
    if (created.status === 409) {
      // Lost a provisioning race — verify the winner's schema instead.
      const recheck = await this.client.callExpectingOk(getRequest, "ensure_collection", options);
      assertCollectionCompatible(spec, resultOf(recheck));
      return;
    }
    expectOk(created, "ensure_collection", createRequest);
  }

  public async ensurePayloadIndexes(
    collection: string,
    indexes: PayloadIndexSpecV1[],
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "vector_store_ensure_payload_indexes");
    if (aborted) {
      return aborted;
    }
    const getRequest: QdrantHttpRequest = { method: "GET", path: `/collections/${collection}` };
    const info = await this.client.call(getRequest, options);
    if (isCollectionMissing(info)) {
      throw qdrantUnavailableError(
        `Collection "${collection}" is not provisioned — cannot create payload indexes`,
        { operation: "vector_store_ensure_payload_indexes", context: { collection } },
      );
    }
    expectOk(info, "ensure_payload_indexes", getRequest);
    const existing = payloadSchemaOf(resultOf(info));

    for (const index of indexes) {
      throwIfAborted(options?.signal, "vector_store_ensure_payload_indexes");
      const wanted = QDRANT_FIELD_SCHEMA[index.type];
      const current = existing.get(index.field);
      if (current !== undefined) {
        if (current !== wanted) {
          throw qdrantSchemaIncompatibleError(
            `Payload index "${index.field}" on collection "${collection}" has type ` +
              `"${current}", expected "${wanted}"`,
            { context: { collection, field: index.field, current, wanted } },
          );
        }
        continue;
      }
      await this.client.callExpectingOk(
        {
          method: "PUT",
          path: `/collections/${collection}/index?wait=true`,
          body: { field_name: index.field, field_schema: wanted },
        },
        "ensure_payload_indexes",
        options,
      );
    }
  }

  public async upsert(
    collection: string,
    points: VectorPointV1[],
    options?: PortCallOptions,
  ): Promise<{ upsertedCount: number }> {
    const aborted = abortedRejection<{ upsertedCount: number }>(options, "vector_store_upsert");
    if (aborted) {
      return aborted;
    }
    if (points.length === 0) {
      return { upsertedCount: 0 };
    }

    // Serialize each point once; classify oversized points up front so they
    // are REJECTED with an identifiable error, never sent or silently
    // dropped (spec.md §10.5).
    const sized: { point: VectorPointV1; wire: WirePoint; bytes: number }[] = [];
    const oversized: { id: string; bytes: number }[] = [];
    for (const point of points) {
      const wire = toWirePoint(point);
      const bytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
      if (bytes > this.upsertBudgetBytes) {
        oversized.push({ id: point.id, bytes });
      } else {
        sized.push({ point, wire, bytes });
      }
    }

    // Flush when point_count >= max_points OR bytes + next > budget
    // (architecture.md §11.7).
    const batches: { wires: WirePoint[]; ids: string[] }[] = [];
    let current: { wires: WirePoint[]; ids: string[] } = { wires: [], ids: [] };
    let currentBytes = 0;
    for (const entry of sized) {
      const wouldOverflow =
        current.wires.length >= this.upsertMaxPoints ||
        (current.wires.length > 0 && currentBytes + entry.bytes > this.upsertBudgetBytes);
      if (wouldOverflow) {
        batches.push(current);
        current = { wires: [], ids: [] };
        currentBytes = 0;
      }
      current.wires.push(entry.wire);
      current.ids.push(entry.point.id);
      currentBytes += entry.bytes;
    }
    if (current.wires.length > 0) {
      batches.push(current);
    }

    let upsertedCount = 0;
    const failed: { id: string; reason: string }[] = [];
    for (const batch of batches) {
      throwIfAborted(options?.signal, "vector_store_upsert");
      const response = await this.upsertWire(collection, batch.wires, options);
      if (response.status >= 200 && response.status < 300) {
        upsertedCount += batch.wires.length;
        continue;
      }
      if (batch.wires.length === 1) {
        failed.push({ id: batch.ids[0] ?? "", reason: describeFailure(response) });
        continue;
      }
      // Isolate the partial failure: retry the failed batch point by point
      // so one bad point never silently sinks its whole batch (spec.md §10.5).
      for (let i = 0; i < batch.wires.length; i += 1) {
        throwIfAborted(options?.signal, "vector_store_upsert");
        const wire = batch.wires[i] as WirePoint;
        const single = await this.upsertWire(collection, [wire], options);
        if (single.status >= 200 && single.status < 300) {
          upsertedCount += 1;
        } else {
          failed.push({ id: batch.ids[i] ?? "", reason: describeFailure(single) });
        }
      }
    }

    if (oversized.length > 0) {
      throw pointTooLargeError(
        `${oversized.length} point(s) exceed the serialized byte budget of ` +
          `${this.upsertBudgetBytes} bytes: ${oversized.map((p) => p.id).join(", ")}`,
        {
          operation: "vector_store_upsert",
          context: {
            collection,
            budgetBytes: this.upsertBudgetBytes,
            oversizedPoints: oversized,
            failedPoints: failed,
            upsertedCount,
          },
        },
      );
    }
    if (failed.length > 0) {
      throw qdrantUnavailableError(
        `Upsert into "${collection}" failed for ${failed.length} of ${points.length} ` +
          `point(s): ${failed.map((f) => `${f.id} (${f.reason})`).join("; ")}`,
        {
          operation: "vector_store_upsert",
          context: { collection, failedPoints: failed, upsertedCount },
        },
      );
    }
    return { upsertedCount };
  }

  private upsertWire(
    collection: string,
    wires: WirePoint[],
    options?: PortCallOptions,
  ): Promise<QdrantHttpResponse> {
    return this.client.call(
      {
        method: "PUT",
        path: `/collections/${collection}/points?wait=true`,
        body: { points: wires },
      },
      options,
    );
  }

  public async deleteByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "vector_store_delete_by_filter");
    if (aborted) {
      return aborted;
    }
    const request: QdrantHttpRequest = {
      method: "POST",
      path: `/collections/${collection}/points/delete?wait=true`,
      body: { filter: toQdrantFilter(filter) ?? {} },
    };
    const response = await this.client.call(request, options);
    if (isCollectionMissing(response)) {
      return; // Nothing to delete — a safe no-op, never a collection creation.
    }
    expectOk(response, "delete_by_filter", request);
  }

  public async hybridQuery(
    collection: string,
    query: HybridQueryV1,
    options?: PortCallOptions,
  ): Promise<ScoredPointV1[]> {
    const aborted = abortedRejection<ScoredPointV1[]>(options, "vector_store_hybrid_query");
    if (aborted) {
      return aborted;
    }
    if (query.dense === undefined && query.sparse === undefined) {
      return []; // No query vector at all — nothing to rank.
    }
    const filter = toQdrantFilter(query.filter);
    const candidateLimit = query.candidateLimit ?? Math.max(query.limit, 20);
    // The original id must always be recoverable from the payload, so the
    // reserved key is requested even for `withPayload: false`.
    const withPayload = query.withPayload ? true : { include: [STORED_POINT_ID_PAYLOAD_KEY] };

    let body: Record<string, unknown>;
    if (query.dense !== undefined && query.sparse !== undefined) {
      body = {
        prefetch: [
          {
            query: query.dense,
            using: "dense",
            limit: candidateLimit,
            ...(filter === undefined ? {} : { filter }),
          },
          {
            query: { indices: query.sparse.indices, values: query.sparse.values },
            using: "bm25",
            limit: candidateLimit,
            ...(filter === undefined ? {} : { filter }),
          },
        ],
        query: { fusion: "rrf" },
        limit: query.limit,
        ...(filter === undefined ? {} : { filter }),
        with_payload: withPayload,
      };
    } else if (query.dense !== undefined) {
      body = {
        query: query.dense,
        using: "dense",
        limit: query.limit,
        ...(filter === undefined ? {} : { filter }),
        with_payload: withPayload,
      };
    } else {
      const sparse = query.sparse as SparseVectorV1;
      body = {
        query: { indices: sparse.indices, values: sparse.values },
        using: "bm25",
        limit: query.limit,
        ...(filter === undefined ? {} : { filter }),
        with_payload: withPayload,
      };
    }

    const request: QdrantHttpRequest = {
      method: "POST",
      path: `/collections/${collection}/points/query`,
      body,
    };
    const response = await this.client.call(request, options);
    if (isCollectionMissing(response)) {
      return []; // Missing collection is a safe empty read (architecture.md §11.5).
    }
    expectOk(response, "hybrid_query", request);
    const result = resultOf(response) as { points?: WireScoredPoint[] } | undefined;
    const wirePoints = result?.points ?? [];

    const denseOnly = query.dense !== undefined && query.sparse === undefined;
    const sparseOnly = query.sparse !== undefined && query.dense === undefined;
    return wirePoints.map((wire, rank) => {
      const { originalId, payload } = splitStoredPayload(
        wire.payload as Record<string, unknown> | undefined,
      );
      const score = typeof wire.score === "number" ? wire.score : 0;
      const scored: ScoredPointV1 = {
        id: originalId ?? String(wire.id ?? ""),
        score,
        // Per-branch diagnostics are only well-defined for single-branch
        // queries; Qdrant's fused RRF response does not expose them
        // (documented decision, README "Entscheidungen").
        ...(denseOnly ? { denseScore: score } : {}),
        ...(sparseOnly ? { sparseRank: rank } : {}),
      };
      if (query.withPayload) {
        scored.payload = payload;
      }
      return scored;
    });
  }

  public async retrieve(
    collection: string,
    ids: string[],
    options?: PortCallOptions & { withVectors?: boolean },
  ): Promise<VectorPointV1[]> {
    const aborted = abortedRejection<VectorPointV1[]>(options, "vector_store_retrieve");
    if (aborted) {
      return aborted;
    }
    if (ids.length === 0) {
      return [];
    }
    const withVectors = options?.withVectors ?? false;
    const request: QdrantHttpRequest = {
      method: "POST",
      path: `/collections/${collection}/points`,
      body: {
        ids: ids.map(toQdrantPointId),
        with_payload: true,
        with_vector: withVectors,
      },
    };
    const response = await this.client.call(request, options);
    if (isCollectionMissing(response)) {
      return [];
    }
    expectOk(response, "retrieve", request);
    const wirePoints = (resultOf(response) ?? []) as WireScoredPoint[];
    const byQdrantId = new Map<string, WireScoredPoint>();
    for (const wire of wirePoints) {
      byQdrantId.set(String(wire.id ?? ""), wire);
    }
    // Results follow the ORDER OF THE REQUESTED ids, skipping missing ones
    // (port contract).
    const results: VectorPointV1[] = [];
    for (const id of ids) {
      const wire = byQdrantId.get(toQdrantPointId(id));
      if (wire === undefined) {
        continue;
      }
      results.push(fromWirePoint(id, wire, withVectors));
    }
    return results;
  }

  public async scroll(
    collection: string,
    request: ScrollRequestV1,
    options?: PortCallOptions,
  ): Promise<ScrollPageV1> {
    const aborted = abortedRejection<ScrollPageV1>(options, "vector_store_scroll");
    if (aborted) {
      return aborted;
    }
    const withVectors = request.withVectors ?? false;
    const filter = toQdrantFilter(request.filter);
    const wireRequest: QdrantHttpRequest = {
      method: "POST",
      path: `/collections/${collection}/points/scroll`,
      body: {
        limit: request.limit,
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(filter === undefined ? {} : { filter }),
        with_payload: true,
        with_vector: withVectors,
      },
    };
    const response = await this.client.call(wireRequest, options);
    if (isCollectionMissing(response)) {
      return { points: [] };
    }
    expectOk(response, "scroll", wireRequest);
    const result = resultOf(response) as
      { points?: WireScoredPoint[]; next_page_offset?: unknown } | undefined;
    const points = (result?.points ?? []).map((wire) => {
      const { originalId, payload } = splitStoredPayload(
        wire.payload as Record<string, unknown> | undefined,
      );
      const point = fromWirePoint(originalId ?? String(wire.id ?? ""), wire, withVectors);
      point.payload = payload;
      return point;
    });
    const nextOffset = result?.next_page_offset;
    return {
      points,
      // The cursor is opaque to callers; Qdrant hands back the id of the
      // next unread point (or null when exhausted).
      ...(nextOffset === undefined || nextOffset === null
        ? {}
        : { nextOffset: String(nextOffset) }),
    };
  }

  public async countByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<number> {
    const aborted = abortedRejection<number>(options, "vector_store_count_by_filter");
    if (aborted) {
      return aborted;
    }
    const wireFilter = toQdrantFilter(filter);
    const request: QdrantHttpRequest = {
      method: "POST",
      path: `/collections/${collection}/points/count`,
      body: { ...(wireFilter === undefined ? {} : { filter: wireFilter }), exact: true },
    };
    const response = await this.client.call(request, options);
    if (isCollectionMissing(response)) {
      return 0;
    }
    expectOk(response, "count_by_filter", request);
    const result = resultOf(response) as { count?: unknown } | undefined;
    return typeof result?.count === "number" ? result.count : 0;
  }
}

function toWirePoint(point: VectorPointV1): WirePoint {
  const vector: Record<string, unknown> = {};
  if (point.dense !== undefined) {
    vector["dense"] = point.dense;
  }
  if (point.sparse !== undefined) {
    vector["bm25"] = { indices: point.sparse.indices, values: point.sparse.values };
  }
  return {
    id: toQdrantPointId(point.id),
    vector,
    payload: { ...point.payload, [STORED_POINT_ID_PAYLOAD_KEY]: point.id },
  };
}

function fromWirePoint(
  originalId: string,
  wire: WireScoredPoint,
  withVectors: boolean,
): VectorPointV1 {
  const { payload } = splitStoredPayload(wire.payload as Record<string, unknown> | undefined);
  const point: VectorPointV1 = { id: originalId, payload };
  if (withVectors && typeof wire.vector === "object" && wire.vector !== null) {
    const vector = wire.vector as Record<string, unknown>;
    const dense = vector["dense"];
    if (Array.isArray(dense)) {
      point.dense = dense as number[];
    }
    const sparse = vector["bm25"];
    if (typeof sparse === "object" && sparse !== null) {
      const wireSparse = sparse as { indices?: unknown; values?: unknown };
      if (Array.isArray(wireSparse.indices) && Array.isArray(wireSparse.values)) {
        point.sparse = {
          indices: wireSparse.indices as number[],
          values: wireSparse.values as number[],
        };
      }
    }
  }
  return point;
}

function describeFailure(response: QdrantHttpResponse): string {
  const reason = serverReason(response);
  return reason === undefined ? `HTTP ${response.status}` : `HTTP ${response.status}: ${reason}`;
}

function payloadSchemaOf(result: unknown): Map<string, string> {
  const schema = new Map<string, string>();
  if (typeof result !== "object" || result === null) {
    return schema;
  }
  const raw = (result as Record<string, unknown>)["payload_schema"];
  if (typeof raw !== "object" || raw === null) {
    return schema;
  }
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null) {
      const dataType = (value as Record<string, unknown>)["data_type"];
      if (typeof dataType === "string") {
        schema.set(field, dataType);
      }
    }
  }
  return schema;
}

function assertCollectionCompatible(spec: CollectionSpecV1, result: unknown): void {
  const params = collectionParamsOf(result);
  const dense = params === undefined ? undefined : params.dense;
  if (params === undefined || dense === undefined) {
    throw qdrantSchemaIncompatibleError(
      `Collection "${spec.name}" exists but has no "dense" named vector`,
      { context: { collection: spec.name } },
    );
  }
  if (dense.size !== spec.denseDimensions || dense.distance !== spec.denseDistance) {
    throw qdrantSchemaIncompatibleError(
      `Collection "${spec.name}" exists with dense vector (size ${dense.size}, ` +
        `distance ${dense.distance}) but (size ${spec.denseDimensions}, distance ` +
        `${spec.denseDistance}) was requested — refusing to mix embedding profiles ` +
        `(architecture.md §11.3)`,
      {
        context: {
          collection: spec.name,
          existing: dense,
          requested: { size: spec.denseDimensions, distance: spec.denseDistance },
        },
      },
    );
  }
  if (spec.sparseBm25 && !params.hasBm25) {
    throw qdrantSchemaIncompatibleError(
      `Collection "${spec.name}" exists without the "bm25" sparse vector required by the spec`,
      { context: { collection: spec.name } },
    );
  }
}

function collectionParamsOf(
  result: unknown,
): { dense?: { size: unknown; distance: unknown }; hasBm25: boolean } | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const config = (result as Record<string, unknown>)["config"];
  if (typeof config !== "object" || config === null) {
    return undefined;
  }
  const params = (config as Record<string, unknown>)["params"];
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const vectors = record["vectors"];
  const sparse = record["sparse_vectors"];
  const hasBm25 =
    typeof sparse === "object" && sparse !== null && "bm25" in (sparse as Record<string, unknown>);
  let dense: { size: unknown; distance: unknown } | undefined;
  if (typeof vectors === "object" && vectors !== null) {
    const denseRaw = (vectors as Record<string, unknown>)["dense"];
    if (typeof denseRaw === "object" && denseRaw !== null) {
      const denseRecord = denseRaw as Record<string, unknown>;
      dense = { size: denseRecord["size"], distance: denseRecord["distance"] };
    }
  }
  return { ...(dense === undefined ? {} : { dense }), hasBm25 };
}
