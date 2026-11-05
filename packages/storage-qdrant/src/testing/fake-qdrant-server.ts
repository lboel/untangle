/**
 * Fake Qdrant REST server for unit tests — implements `QdrantTransport`
 * in-process, emulating the subset of the Qdrant HTTP API this adapter uses:
 * collection lifecycle, payload indexes, upsert, retrieve, scroll, count,
 * delete-by-filter and the query API (dense/sparse branches, prefetch + RRF
 * fusion, payload filters, `with_payload` include lists).
 *
 * TEST INFRASTRUCTURE ONLY: this file lives outside the build (`tsconfig.json`
 * excludes `src/testing/**`) and may therefore use `@untangle-code/testkit`
 * (BM25 scoring, cosine similarity, RRF) — production sources must not.
 *
 * Sparse scoring mirrors the `modifier: "idf"` semantics of spec.md §10.2 the
 * same way the testkit's in-memory store does: documents carry raw
 * term-frequency vectors, the server keeps corpus statistics (with correct
 * removal on re-upsert — no stale document frequencies) and weights at query
 * time.
 */
import type { PortCallOptions, SparseVectorV1 } from "@untangle-code/domain";
import { jobCancelledError, qdrantUnavailableError } from "@untangle-code/observability";
import { Bm25Index, cosineSimilarity, reciprocalRankFusion } from "@untangle-code/testkit";

import type { QdrantHttpRequest, QdrantHttpResponse, QdrantTransport } from "../transport.js";

interface FakePoint {
  id: string;
  vector: { dense?: number[]; bm25?: SparseVectorV1 };
  payload: Record<string, unknown>;
}

interface FakeCollection {
  params: Record<string, unknown>;
  points: Map<string, FakePoint>;
  payloadSchema: Map<string, string>;
  bm25: Bm25Index;
}

interface WireCondition {
  key?: string;
  match?: { value?: unknown; any?: unknown[] };
  range?: { gt?: number; gte?: number; lt?: number; lte?: number };
}

interface WireFilter {
  must?: WireCondition[];
  should?: WireCondition[];
  must_not?: WireCondition[];
}

/** A planned failure, consumed FIFO when its matcher passes. */
export interface PlannedFailure {
  /** "timeout" throws like a transport timeout; "http" returns a response. */
  mode: "timeout" | "http";
  status?: number;
  error?: string;
  /** Only requests matching this predicate consume the failure. */
  match?: (request: QdrantHttpRequest) => boolean;
}

function ok(result: unknown): QdrantHttpResponse {
  return { status: 200, body: { status: "ok", result, time: 0 } };
}

function errorResponse(status: number, error: string): QdrantHttpResponse {
  return { status, body: { status: { error }, time: 0 } };
}

function collectionMissing(name: string): QdrantHttpResponse {
  return errorResponse(404, `Not found: Collection \`${name}\` doesn't exist!`);
}

function matchesCondition(payload: Record<string, unknown>, condition: WireCondition): boolean {
  const key = condition.key;
  if (key === undefined) {
    return false;
  }
  const actual = payload[key];
  if (condition.match !== undefined) {
    if ("any" in condition.match && Array.isArray(condition.match.any)) {
      return condition.match.any.includes(actual);
    }
    return actual === condition.match.value;
  }
  if (condition.range !== undefined) {
    if (typeof actual !== "number") {
      return false;
    }
    const { gt, gte, lt, lte } = condition.range;
    if (gt !== undefined && !(actual > gt)) return false;
    if (gte !== undefined && !(actual >= gte)) return false;
    if (lt !== undefined && !(actual < lt)) return false;
    if (lte !== undefined && !(actual <= lte)) return false;
    return true;
  }
  return false;
}

function matchesFilter(payload: Record<string, unknown>, filter: WireFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.must !== undefined && !filter.must.every((c) => matchesCondition(payload, c))) {
    return false;
  }
  if (filter.must_not !== undefined && filter.must_not.some((c) => matchesCondition(payload, c))) {
    return false;
  }
  if (filter.should !== undefined && filter.should.length > 0) {
    if (!filter.should.some((c) => matchesCondition(payload, c))) {
      return false;
    }
  }
  return true;
}

function projectPayload(
  payload: Record<string, unknown>,
  withPayload: unknown,
): Record<string, unknown> | undefined {
  if (withPayload === true) {
    return payload;
  }
  if (typeof withPayload === "object" && withPayload !== null) {
    const include = (withPayload as Record<string, unknown>)["include"];
    if (Array.isArray(include)) {
      const projected: Record<string, unknown> = {};
      for (const key of include) {
        if (typeof key === "string" && key in payload) {
          projected[key] = payload[key];
        }
      }
      return projected;
    }
  }
  return undefined;
}

export class FakeQdrantServer implements QdrantTransport {
  private readonly collections = new Map<string, FakeCollection>();
  private readonly failures: PlannedFailure[] = [];
  /** Every request seen, for batching/side-effect assertions. */
  public readonly requestLog: QdrantHttpRequest[] = [];

  // -- test helpers ---------------------------------------------------------

  public planFailure(failure: PlannedFailure): void {
    this.failures.push(failure);
  }

  public collectionNames(): string[] {
    return [...this.collections.keys()].sort();
  }

  public rawPoints(collection: string): FakePoint[] {
    return [...(this.collections.get(collection)?.points.values() ?? [])];
  }

  public payloadSchema(collection: string): Record<string, string> {
    return Object.fromEntries(this.collections.get(collection)?.payloadSchema ?? []);
  }

  /** All upsert requests against `collection`, in order. */
  public upsertRequests(collection: string): { pointCount: number; bytes: number }[] {
    return this.requestLog
      .filter(
        (request) =>
          request.method === "PUT" &&
          request.path.startsWith(`/collections/${collection}/points`) &&
          !request.path.includes("/index"),
      )
      .map((request) => {
        const body = request.body as { points?: unknown[] } | undefined;
        return {
          pointCount: body?.points?.length ?? 0,
          bytes: Buffer.byteLength(JSON.stringify(body?.points ?? []), "utf8"),
        };
      });
  }

  // -- transport ------------------------------------------------------------

  public async request(
    request: QdrantHttpRequest,
    options?: PortCallOptions,
  ): Promise<QdrantHttpResponse> {
    if (options?.signal?.aborted) {
      throw jobCancelledError(`Qdrant request "${request.method} ${request.path}" was aborted`, {
        operation: "qdrant_request",
      });
    }
    this.requestLog.push(request);

    const failureIndex = this.failures.findIndex(
      (failure) => failure.match === undefined || failure.match(request),
    );
    if (failureIndex !== -1) {
      const failure = this.failures.splice(failureIndex, 1)[0] as PlannedFailure;
      if (failure.mode === "timeout") {
        throw qdrantUnavailableError(
          `Qdrant request "${request.method} ${request.path}" timed out after 1ms`,
          { retryable: true, operation: "qdrant_request", context: { path: request.path } },
        );
      }
      return errorResponse(failure.status ?? 500, failure.error ?? "planned failure");
    }

    // Enforce JSON-serializability of the body (as real HTTP would).
    const body =
      request.body === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(request.body)) as Record<string, unknown>);
    const path = request.path.split("?")[0] as string;
    const segments = path.split("/").filter((segment) => segment.length > 0);

    if (segments[0] !== "collections") {
      return errorResponse(400, `unsupported path "${request.path}"`);
    }
    if (segments.length === 1 && request.method === "GET") {
      return ok({
        collections: [...this.collections.keys()].map((name) => ({ name })),
      });
    }
    const name = segments[1] as string;
    const rest = segments.slice(2);

    if (rest.length === 0) {
      return this.handleCollection(name, request.method, body);
    }
    if (rest.length === 1 && rest[0] === "index" && request.method === "PUT") {
      return this.handleCreateIndex(name, body);
    }
    if (rest[0] === "points") {
      return this.handlePoints(name, rest.slice(1), request.method, body);
    }
    return errorResponse(400, `unsupported path "${request.path}"`);
  }

  // -- collection lifecycle -------------------------------------------------

  private handleCollection(
    name: string,
    method: string,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const existing = this.collections.get(name);
    if (method === "GET") {
      if (existing === undefined) {
        return collectionMissing(name);
      }
      return ok({
        config: { params: existing.params },
        payload_schema: Object.fromEntries(
          [...existing.payloadSchema.entries()].map(([field, dataType]) => [
            field,
            { data_type: dataType },
          ]),
        ),
        points_count: existing.points.size,
      });
    }
    if (method === "PUT") {
      if (existing !== undefined) {
        return errorResponse(409, `Collection \`${name}\` already exists!`);
      }
      this.collections.set(name, {
        params: body ?? {},
        points: new Map(),
        payloadSchema: new Map(),
        bm25: new Bm25Index(),
      });
      return ok(true);
    }
    if (method === "DELETE") {
      this.collections.delete(name);
      return ok(true);
    }
    return errorResponse(400, `unsupported method ${method}`);
  }

  private handleCreateIndex(
    name: string,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const collection = this.collections.get(name);
    if (collection === undefined) {
      return collectionMissing(name);
    }
    const field = body?.["field_name"];
    const schema = body?.["field_schema"];
    if (typeof field !== "string" || typeof schema !== "string") {
      return errorResponse(400, "field_name and field_schema are required");
    }
    collection.payloadSchema.set(field, schema);
    return ok(true);
  }

  // -- points ---------------------------------------------------------------

  private handlePoints(
    name: string,
    action: string[],
    method: string,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const collection = this.collections.get(name);
    if (collection === undefined) {
      return collectionMissing(name);
    }
    if (action.length === 0 && method === "PUT") {
      return this.handleUpsert(collection, body);
    }
    if (action.length === 0 && method === "POST") {
      return this.handleRetrieve(collection, body);
    }
    const verb = action[0];
    if (verb === "delete" && method === "POST") {
      return this.handleDelete(collection, body);
    }
    if (verb === "query" && method === "POST") {
      return this.handleQuery(collection, body);
    }
    if (verb === "scroll" && method === "POST") {
      return this.handleScroll(collection, body);
    }
    if (verb === "count" && method === "POST") {
      return this.handleCount(collection, body);
    }
    return errorResponse(400, `unsupported points action "${verb ?? ""}"`);
  }

  private handleUpsert(
    collection: FakeCollection,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const points = body?.["points"];
    if (!Array.isArray(points)) {
      return errorResponse(400, "points array is required");
    }
    const denseConfig = this.denseConfigOf(collection);
    for (const raw of points) {
      const wire = raw as {
        id?: unknown;
        vector?: { dense?: unknown; bm25?: unknown };
        payload?: unknown;
      };
      if (typeof wire.id !== "string") {
        return errorResponse(400, "point id must be a string UUID");
      }
      const dense = wire.vector?.dense;
      if (Array.isArray(dense) && denseConfig !== undefined && dense.length !== denseConfig.size) {
        return errorResponse(
          400,
          `Wrong input: Vector dimension error: expected dim: ${denseConfig.size}, got ${dense.length}`,
        );
      }
    }
    for (const raw of points) {
      const wire = raw as {
        id: string;
        vector?: { dense?: number[]; bm25?: SparseVectorV1 };
        payload?: Record<string, unknown>;
      };
      const previous = collection.points.get(wire.id);
      if (previous?.vector.bm25 !== undefined) {
        collection.bm25.removeDocument(wire.id, previous.vector.bm25);
      }
      const point: FakePoint = {
        id: wire.id,
        vector: {
          ...(wire.vector?.dense === undefined ? {} : { dense: wire.vector.dense }),
          ...(wire.vector?.bm25 === undefined ? {} : { bm25: wire.vector.bm25 }),
        },
        payload: wire.payload ?? {},
      };
      collection.points.set(wire.id, point);
      if (point.vector.bm25 !== undefined) {
        collection.bm25.addDocument(wire.id, point.vector.bm25);
      }
    }
    return ok({ operation_id: 0, status: "completed" });
  }

  private denseConfigOf(collection: FakeCollection): { size: number } | undefined {
    const vectors = collection.params["vectors"];
    if (typeof vectors !== "object" || vectors === null) {
      return undefined;
    }
    const dense = (vectors as Record<string, unknown>)["dense"];
    if (typeof dense !== "object" || dense === null) {
      return undefined;
    }
    const size = (dense as Record<string, unknown>)["size"];
    return typeof size === "number" ? { size } : undefined;
  }

  private handleRetrieve(
    collection: FakeCollection,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const ids = body?.["ids"];
    if (!Array.isArray(ids)) {
      return errorResponse(400, "ids array is required");
    }
    const withVector = body?.["with_vector"] === true;
    const withPayload = body?.["with_payload"];
    const result = ids
      .map((id) => collection.points.get(String(id)))
      .filter((point): point is FakePoint => point !== undefined)
      .map((point) => ({
        id: point.id,
        payload: projectPayload(point.payload, withPayload ?? true) ?? {},
        ...(withVector ? { vector: point.vector } : {}),
      }));
    return ok(result);
  }

  private handleDelete(
    collection: FakeCollection,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const filter = (body?.["filter"] ?? {}) as WireFilter;
    for (const [id, point] of [...collection.points.entries()]) {
      if (matchesFilter(point.payload, filter)) {
        if (point.vector.bm25 !== undefined) {
          collection.bm25.removeDocument(id, point.vector.bm25);
        }
        collection.points.delete(id);
      }
    }
    return ok({ operation_id: 0, status: "completed" });
  }

  private rankDense(candidates: FakePoint[], query: number[]): { id: string; score: number }[] {
    return candidates
      .filter((point): point is FakePoint & { vector: { dense: number[] } } =>
        Array.isArray(point.vector.dense),
      )
      .map((point) => ({ id: point.id, score: cosineSimilarity(query, point.vector.dense) }))
      .sort((a, b) => (b.score === a.score ? (a.id < b.id ? -1 : 1) : b.score - a.score));
  }

  private rankSparse(
    collection: FakeCollection,
    candidates: FakePoint[],
    query: SparseVectorV1,
  ): { id: string; score: number }[] {
    return candidates
      .filter(
        (point): point is FakePoint & { vector: { bm25: SparseVectorV1 } } =>
          point.vector.bm25 !== undefined,
      )
      .map((point) => ({ id: point.id, score: collection.bm25.score(query, point.vector.bm25) }))
      .sort((a, b) => (b.score === a.score ? (a.id < b.id ? -1 : 1) : b.score - a.score));
  }

  private rankBranch(
    collection: FakeCollection,
    branch: Record<string, unknown>,
    outerFilter: WireFilter | undefined,
  ): { id: string; score: number }[] | QdrantHttpResponse {
    const branchFilter = branch["filter"] as WireFilter | undefined;
    const candidates = [...collection.points.values()].filter(
      (point) =>
        matchesFilter(point.payload, outerFilter) && matchesFilter(point.payload, branchFilter),
    );
    const query = branch["query"];
    const using = branch["using"];
    const limit = typeof branch["limit"] === "number" ? branch["limit"] : candidates.length;
    let ranked: { id: string; score: number }[];
    if (using === "dense" && Array.isArray(query)) {
      ranked = this.rankDense(candidates, query as number[]);
    } else if (
      using === "bm25" &&
      typeof query === "object" &&
      query !== null &&
      Array.isArray((query as Record<string, unknown>)["indices"])
    ) {
      ranked = this.rankSparse(collection, candidates, query as unknown as SparseVectorV1);
    } else {
      return errorResponse(400, `unsupported query branch (using "${String(using)}")`);
    }
    return ranked.slice(0, limit);
  }

  private handleQuery(
    collection: FakeCollection,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const outerFilter = body?.["filter"] as WireFilter | undefined;
    const limit = typeof body?.["limit"] === "number" ? body["limit"] : 10;
    const withPayload = body?.["with_payload"];
    const prefetch = body?.["prefetch"];
    const query = body?.["query"];

    let fusedIds: { id: string; score: number }[];
    if (Array.isArray(prefetch)) {
      const fusion =
        typeof query === "object" && query !== null
          ? (query as Record<string, unknown>)["fusion"]
          : undefined;
      if (fusion !== "rrf") {
        return errorResponse(400, "only rrf fusion is supported");
      }
      const rankLists: string[][] = [];
      for (const rawBranch of prefetch) {
        const ranked = this.rankBranch(
          collection,
          rawBranch as Record<string, unknown>,
          outerFilter,
        );
        if (!Array.isArray(ranked)) {
          return ranked;
        }
        rankLists.push(ranked.map((hit) => hit.id));
      }
      const fused = reciprocalRankFusion(rankLists);
      fusedIds = [...fused.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => (b.score === a.score ? (a.id < b.id ? -1 : 1) : b.score - a.score));
    } else {
      const ranked = this.rankBranch(
        collection,
        {
          query,
          using: body?.["using"],
          limit,
        },
        outerFilter,
      );
      if (!Array.isArray(ranked)) {
        return ranked;
      }
      fusedIds = ranked;
    }

    const points = fusedIds.slice(0, limit).map(({ id, score }) => {
      const point = collection.points.get(id) as FakePoint;
      const payload = projectPayload(point.payload, withPayload);
      return { id, score, ...(payload === undefined ? {} : { payload }) };
    });
    return ok({ points });
  }

  private handleScroll(
    collection: FakeCollection,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const filter = body?.["filter"] as WireFilter | undefined;
    const limit = typeof body?.["limit"] === "number" ? body["limit"] : 10;
    const offset = body?.["offset"];
    const withVector = body?.["with_vector"] === true;
    const withPayload = body?.["with_payload"];

    const sorted = [...collection.points.values()]
      .filter((point) => matchesFilter(point.payload, filter))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Qdrant semantics: `offset` is the id of the FIRST point of this page.
    const startIndex =
      offset === undefined ? 0 : sorted.findIndex((point) => point.id >= String(offset));
    const effectiveStart = startIndex === -1 ? sorted.length : startIndex;
    const page = sorted.slice(effectiveStart, effectiveStart + limit);
    const next = sorted[effectiveStart + limit];
    return ok({
      points: page.map((point) => ({
        id: point.id,
        payload: projectPayload(point.payload, withPayload ?? true) ?? {},
        ...(withVector ? { vector: point.vector } : {}),
      })),
      next_page_offset: next === undefined ? null : next.id,
    });
  }

  private handleCount(
    collection: FakeCollection,
    body: Record<string, unknown> | undefined,
  ): QdrantHttpResponse {
    const filter = body?.["filter"] as WireFilter | undefined;
    let count = 0;
    for (const point of collection.points.values()) {
      if (matchesFilter(point.payload, filter)) {
        count += 1;
      }
    }
    return ok({ count });
  }
}
