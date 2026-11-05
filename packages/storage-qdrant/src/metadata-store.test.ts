/**
 * Adapter-specific `QdrantMetadataStore` tests beyond the shared port
 * contract: no side-effect collection creation on status reads
 * (architecture.md §11.5), lazy provisioning on writes, promoted filter
 * fields, and server-side filtering of list reads.
 */
import type { FileManifestV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { QdrantMetadataStore } from "./metadata-store.js";
import { STORED_POINT_ID_PAYLOAD_KEY } from "./point-id.js";
import { FakeQdrantServer } from "./testing/fake-qdrant-server.js";
import { QdrantVectorStore } from "./vector-store.js";

function setup(): { fake: FakeQdrantServer; store: QdrantMetadataStore } {
  const fake = new FakeQdrantServer();
  const store = new QdrantMetadataStore({
    vectorStore: new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 }),
    collectionPrefix: "untangle_",
  });
  return { fake, store };
}

function manifest(fileId: string, refId: string): FileManifestV1 {
  return {
    fileId,
    repoId: "repo-1",
    refId,
    relativePath: "src/index.ts",
    contentHash: "hash",
    sizeBytes: 10,
    language: "typescript",
    parseQuality: "complete",
    chunkIds: [],
    symbolIds: [],
    metricsScopeId: "scope",
    parserVersion: "1",
    chunkerVersion: "1",
    generationId: "gen-1",
  };
}

describe("QdrantMetadataStore side effects (architecture.md §11.5)", () => {
  it("status reads never create the metadata collection", async () => {
    const { fake, store } = setup();
    await expect(store.getWorkspace("ws-1")).resolves.toBeNull();
    await expect(store.getRefRecord("ref-1")).resolves.toBeNull();
    await expect(store.getCheckpoint("job-1")).resolves.toBeNull();
    await expect(store.getLatestCheckpoint("repo-1", "ref-1")).resolves.toBeNull();
    await expect(store.listFileManifests("ref-1")).resolves.toEqual([]);
    await expect(store.listRecords("kind")).resolves.toEqual([]);
    expect(fake.collectionNames()).toEqual([]);
    expect(fake.requestLog.every((request) => request.method !== "PUT")).toBe(true);
  });

  it("the first write provisions {prefix}metadata_v1 exactly once", async () => {
    const { fake, store } = setup();
    await store.putRecord("kind", "a", { v: 1 });
    await store.putRecord("kind", "b", { v: 2 });
    expect(fake.collectionNames()).toEqual(["untangle_metadata_v1"]);
    const creates = fake.requestLog.filter(
      (request) => request.method === "PUT" && request.path === "/collections/untangle_metadata_v1",
    );
    expect(creates).toHaveLength(1);
  });
});

describe("QdrantMetadataStore storage layout", () => {
  it("promotes repo_id/ref_id/point_type as top-level payload fields for server-side filtering", async () => {
    const { fake, store } = setup();
    await store.putFileManifests([manifest("f1", "ref-1")]);
    const points = fake.rawPoints("untangle_metadata_v1");
    expect(points).toHaveLength(1);
    const payload = points[0]?.payload ?? {};
    expect(payload["point_type"]).toBe("file_manifest");
    expect(payload["repo_id"]).toBe("repo-1");
    expect(payload["ref_id"]).toBe("ref-1");
    expect(payload["generation_id"]).toBe("gen-1");
    expect(payload["record"]).toEqual(manifest("f1", "ref-1"));
    expect(typeof payload[STORED_POINT_ID_PAYLOAD_KEY]).toBe("string");
  });

  it("listFileManifests filters by ref_id inside Qdrant, not client-side", async () => {
    const { fake, store } = setup();
    await store.putFileManifests([manifest("f1", "ref-1"), manifest("f2", "ref-2")]);
    fake.requestLog.length = 0;
    const listed = await store.listFileManifests("ref-1");
    expect(listed.map((m) => m.fileId)).toEqual(["f1"]);
    const scrolls = fake.requestLog.filter((request) => request.path.includes("/points/scroll"));
    expect(scrolls.length).toBeGreaterThan(0);
    for (const scroll of scrolls) {
      expect(JSON.stringify(scroll.body)).toContain("ref_id");
    }
  });

  it("pages through more than one scroll page when listing many records", async () => {
    const { store } = setup();
    const manifests = Array.from({ length: 300 }, (_, i) => manifest(`f${i}`, "ref-1"));
    await store.putFileManifests(manifests);
    const listed = await store.listFileManifests("ref-1");
    expect(listed).toHaveLength(300);
    expect(new Set(listed.map((m) => m.fileId)).size).toBe(300);
  });
});
