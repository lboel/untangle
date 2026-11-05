/**
 * Adapter-specific `QdrantVectorStore` tests beyond the shared port
 * contract: byte/count batching (spec.md §10.5, architecture.md §11.7),
 * `POINT_TOO_LARGE`, partial-failure isolation, timeout-vs-missing
 * discrimination (architecture.md §22.2), schema compatibility and payload
 * index provisioning (spec.md §10.4).
 */
import type { CollectionSpecV1, VectorPointV1 } from "@untangle-code/domain";
import { isUntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { CODE_PAYLOAD_INDEXES } from "./collections.js";
import { FakeQdrantServer } from "./testing/fake-qdrant-server.js";
import { QdrantVectorStore } from "./vector-store.js";

function spec(name: string, overrides: Partial<CollectionSpecV1> = {}): CollectionSpecV1 {
  return {
    name,
    denseDimensions: 3,
    denseDistance: "Cosine",
    sparseBm25: true,
    onDiskPayload: true,
    ...overrides,
  };
}

function point(id: string, payloadText = ""): VectorPointV1 {
  return { id, dense: [1, 0, 0], payload: { text: payloadText } };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("QdrantVectorStore batching (spec.md §10.5, architecture.md §11.7)", () => {
  it("flushes on the byte budget BEFORE the point-count limit is reached", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({
      transport: fake,
      maxRetries: 0,
      retryDelayMs: 0,
      upsertMaxPoints: 1000,
      upsertBudgetBytes: 700,
    });
    await store.ensureCollection(spec("c1"));
    const points = Array.from({ length: 6 }, (_, i) => point(`p${i}`, "x".repeat(120)));
    const { upsertedCount } = await store.upsert("c1", points);
    expect(upsertedCount).toBe(6);

    const requests = fake.upsertRequests("c1");
    expect(requests.length).toBeGreaterThan(1); // byte budget forced flushes
    for (const request of requests) {
      expect(request.bytes).toBeLessThanOrEqual(700 + 16); // + wire array framing
      expect(request.pointCount).toBeLessThan(6);
    }
    expect(requests.reduce((sum, r) => sum + r.pointCount, 0)).toBe(6);
  });

  it("flushes on the point-count limit even when the byte budget is generous", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({
      transport: fake,
      maxRetries: 0,
      retryDelayMs: 0,
      upsertMaxPoints: 2,
      upsertBudgetBytes: 10 * 1024 * 1024,
    });
    await store.ensureCollection(spec("c1"));
    await store.upsert(
      "c1",
      ["a", "b", "c", "d", "e"].map((id) => point(id)),
    );
    expect(fake.upsertRequests("c1").map((r) => r.pointCount)).toEqual([2, 2, 1]);
  });

  it("rejects a single oversized point with POINT_TOO_LARGE, identifying it, while still storing the valid points", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({
      transport: fake,
      maxRetries: 0,
      retryDelayMs: 0,
      upsertMaxPoints: 100,
      upsertBudgetBytes: 600,
    });
    await store.ensureCollection(spec("c1"));
    const error = await errorOf(
      store.upsert("c1", [point("ok-1"), point("too-big", "y".repeat(5000)), point("ok-2")]),
    );
    expect(isUntangleError(error) && error.code).toBe("POINT_TOO_LARGE");
    if (isUntangleError(error)) {
      expect(error.message).toContain("too-big");
      expect(error.context["upsertedCount"]).toBe(2);
    }
    // The valid points were NOT silently lost with the batch (spec.md §10.5).
    expect(await store.countByFilter("c1", {})).toBe(2);
  });

  it("isolates a server-side batch failure per point instead of silently losing the batch", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({
      transport: fake,
      maxRetries: 0,
      retryDelayMs: 0,
      upsertMaxPoints: 100,
      upsertBudgetBytes: 10 * 1024 * 1024,
    });
    await store.ensureCollection(spec("c1"));
    const isBatchOfMany = (body: unknown): boolean => {
      const points = (body as { points?: unknown[] } | undefined)?.points;
      return Array.isArray(points) && points.length > 1;
    };
    // The full batch fails once server-side; the per-point retries succeed.
    fake.planFailure({
      mode: "http",
      status: 500,
      error: "internal upsert failure",
      match: (request) =>
        request.method === "PUT" &&
        request.path.includes("/points?wait=true") &&
        isBatchOfMany(request.body),
    });
    const { upsertedCount } = await store.upsert("c1", [point("a"), point("b"), point("c")]);
    expect(upsertedCount).toBe(3);
    expect(await store.countByFilter("c1", {})).toBe(3);
  });

  it("reports a permanently failing point with the server's reason, keeping the rest", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({
      transport: fake,
      maxRetries: 0,
      retryDelayMs: 0,
      upsertMaxPoints: 100,
      upsertBudgetBytes: 10 * 1024 * 1024,
    });
    await store.ensureCollection(spec("c1"));
    const containsPoison = (body: unknown): boolean =>
      JSON.stringify(body ?? {}).includes("poison-marker");
    // Both the whole batch AND the isolated poison point fail.
    fake.planFailure({
      mode: "http",
      status: 400,
      error: "bad point",
      match: (r) => containsPoison(r.body),
    });
    fake.planFailure({
      mode: "http",
      status: 400,
      error: "bad point",
      match: (r) => containsPoison(r.body),
    });

    const error = await errorOf(
      store.upsert("c1", [point("good-1"), point("bad", "poison-marker"), point("good-2")]),
    );
    expect(isUntangleError(error) && error.code).toBe("QDRANT_UNAVAILABLE");
    if (isUntangleError(error)) {
      expect(error.message).toContain("bad point"); // server reason surfaced
      expect(error.context["upsertedCount"]).toBe(2);
    }
    expect(await store.countByFilter("c1", {})).toBe(2);
  });
});

describe("QdrantVectorStore fail-safe rules (architecture.md §22.2)", () => {
  it("a timeout is QDRANT_UNAVAILABLE (retryable), never interpreted as a missing collection", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    await store.ensureCollection(spec("c1"));
    await store.upsert("c1", [point("p1")]);

    fake.planFailure({ mode: "timeout" });
    const existsError = await errorOf(store.collectionExists("c1"));
    expect(isUntangleError(existsError) && existsError.code).toBe("QDRANT_UNAVAILABLE");
    expect(isUntangleError(existsError) && existsError.retryable).toBe(true);

    fake.planFailure({ mode: "timeout" });
    const queryError = await errorOf(
      store.hybridQuery("c1", { dense: [1, 0, 0], limit: 5, withPayload: false }),
    );
    // A timeout must REJECT — resolving to [] would misread it as "missing".
    expect(isUntangleError(queryError) && queryError.code).toBe("QDRANT_UNAVAILABLE");
  });

  it("retries a transient timeout up to maxRetries and then succeeds", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 1, retryDelayMs: 0 });
    await store.ensureCollection(spec("c1"));
    fake.planFailure({ mode: "timeout" });
    await expect(store.collectionExists("c1")).resolves.toBe(true);
  });

  it("an aborted signal rejects with JOB_CANCELLED, not with an infrastructure code", async () => {
    const store = new QdrantVectorStore({
      transport: new FakeQdrantServer(),
      maxRetries: 0,
      retryDelayMs: 0,
    });
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(store.upsert("c1", [point("p1")], { signal: controller.signal }));
    expect(isUntangleError(error) && error.code).toBe("JOB_CANCELLED");
  });
});

describe("QdrantVectorStore provisioning (spec.md §10.2, §10.4)", () => {
  it("creates the collection with dense size/distance, bm25 idf sparse vector and on_disk_payload", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    await store.ensureCollection(spec("code", { denseDimensions: 768 }));
    const create = fake.requestLog.find(
      (request) => request.method === "PUT" && request.path === "/collections/code",
    );
    expect(create?.body).toEqual({
      vectors: { dense: { size: 768, distance: "Cosine" } },
      sparse_vectors: { bm25: { modifier: "idf" } },
      on_disk_payload: true,
    });
  });

  it("rejects an existing collection with a mismatching dense schema as QDRANT_SCHEMA_INCOMPATIBLE", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    await store.ensureCollection(spec("c1", { denseDimensions: 3 }));
    const error = await errorOf(store.ensureCollection(spec("c1", { denseDimensions: 4 })));
    expect(isUntangleError(error) && error.code).toBe("QDRANT_SCHEMA_INCOMPATIBLE");
  });

  it("creates every missing payload index and skips existing ones on the next call", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    await store.ensureCollection(spec("c1"));
    await store.ensurePayloadIndexes("c1", [...CODE_PAYLOAD_INDEXES]);
    const schema = fake.payloadSchema("c1");
    expect(Object.keys(schema)).toHaveLength(CODE_PAYLOAD_INDEXES.length);
    expect(schema["point_type"]).toBe("keyword");
    expect(schema["risk_score"]).toBe("float");
    expect(schema["sloc"]).toBe("integer");

    const indexRequestsBefore = fake.requestLog.filter((r) => r.path.includes("/index")).length;
    await store.ensurePayloadIndexes("c1", [...CODE_PAYLOAD_INDEXES]);
    const indexRequestsAfter = fake.requestLog.filter((r) => r.path.includes("/index")).length;
    expect(indexRequestsAfter).toBe(indexRequestsBefore); // idempotent, nothing re-created
  });

  it("rejects a payload index whose existing type conflicts, instead of silently skipping it", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    await store.ensureCollection(spec("c1"));
    await store.ensurePayloadIndexes("c1", [{ field: "sloc", type: "keyword" }]);
    const error = await errorOf(
      store.ensurePayloadIndexes("c1", [{ field: "sloc", type: "integer" }]),
    );
    expect(isUntangleError(error) && error.code).toBe("QDRANT_SCHEMA_INCOMPATIBLE");
  });

  it("read and status methods never issue a collection-creating request", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    await store.collectionExists("ghost");
    await store.hybridQuery("ghost", { dense: [1, 0, 0], limit: 5, withPayload: false });
    await store.retrieve("ghost", ["x"]);
    await store.scroll("ghost", { limit: 5 });
    await store.countByFilter("ghost", {});
    await store.deleteByFilter("ghost", {});
    expect(fake.collectionNames()).toEqual([]);
    expect(fake.requestLog.every((request) => request.method !== "PUT")).toBe(true);
  });
});
