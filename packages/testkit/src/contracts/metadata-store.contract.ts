/**
 * Port-contract suite for `MetadataStore` (domain `ports.ts`,
 * architecture.md §11.5).
 *
 * Written entirely against the public `MetadataStore` signature — run it
 * against `InMemoryMetadataStore` (self-test) and, later, the real
 * adapter via `runMetadataStoreContract(() => myAdapter())`.
 */
import type {
  EmbeddingProfile,
  FileManifestV1,
  IndexCheckpointV1,
  MetadataStore,
  RefRecord,
  WorkspaceRecord,
} from "@untangle-code/domain";
import { beforeEach, describe, expect, it } from "vitest";

function workspace(overrides: Partial<WorkspaceRecord> & { workspaceId: string }): WorkspaceRecord {
  return {
    schemaVersion: 1,
    configHash: "hash-1",
    repositories: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function refRecord(overrides: Partial<RefRecord> & { refId: string; repoId: string }): RefRecord {
  return {
    refName: "main",
    generationId: "gen-1",
    indexStatus: "empty",
    ...overrides,
  };
}

function fileManifest(
  overrides: Partial<FileManifestV1> & { fileId: string; refId: string },
): FileManifestV1 {
  return {
    repoId: "repo-1",
    relativePath: "src/index.ts",
    contentHash: "content-hash",
    sizeBytes: 10,
    language: "typescript",
    parseQuality: "complete",
    chunkIds: [],
    symbolIds: [],
    metricsScopeId: "scope-1",
    parserVersion: "1",
    chunkerVersion: "1",
    generationId: "gen-1",
    ...overrides,
  };
}

function embeddingProfile(overrides: Partial<EmbeddingProfile> = {}): EmbeddingProfile {
  return {
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
    queryPrefix: "search_query: ",
    documentPrefix: "search_document: ",
    includePath: true,
    normalization: "none",
    preparedTextVersion: "v1",
    ...overrides,
  };
}

function checkpoint(
  overrides: Partial<IndexCheckpointV1> & { jobId: string; repoId: string; refId: string },
): IndexCheckpointV1 {
  return {
    generationId: "gen-1",
    workspaceId: "ws-1",
    effectiveProfileId: "profile-1",
    completedFiles: [],
    storedPointIdsByFile: {},
    manifestHashes: {},
    stage: "embedding",
    savedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function runMetadataStoreContract(
  factory: () => MetadataStore | Promise<MetadataStore>,
): void {
  describe("MetadataStore port contract", () => {
    let store: MetadataStore;

    beforeEach(async () => {
      store = await factory();
    });

    describe("not-found is always null, never thrown (spec.md §25.2)", () => {
      it("every getter returns null for an id that was never written", async () => {
        await expect(store.getWorkspace("missing")).resolves.toBeNull();
        await expect(store.getRefRecord("missing")).resolves.toBeNull();
        await expect(store.getFileManifest("missing")).resolves.toBeNull();
        await expect(store.getEmbeddingProfile("missing")).resolves.toBeNull();
        await expect(store.getCheckpoint("missing")).resolves.toBeNull();
        await expect(store.getLatestCheckpoint("missing-repo", "missing-ref")).resolves.toBeNull();
        await expect(store.getRecord("kind", "missing")).resolves.toBeNull();
      });

      it("every lister returns an empty array, never throws, for an unknown scope", async () => {
        await expect(store.listRefRecords("missing-repo")).resolves.toEqual([]);
        await expect(store.listFileManifests("missing-ref")).resolves.toEqual([]);
        await expect(store.listRecords("missing-kind")).resolves.toEqual([]);
      });
    });

    describe("workspace round-trip", () => {
      it("putWorkspace then getWorkspace returns exactly what was stored", async () => {
        const record = workspace({ workspaceId: "ws-1" });
        await store.putWorkspace(record);
        await expect(store.getWorkspace("ws-1")).resolves.toEqual(record);
      });

      it("putWorkspace overwrites a previous record for the same id", async () => {
        await store.putWorkspace(workspace({ workspaceId: "ws-1", configHash: "old" }));
        await store.putWorkspace(workspace({ workspaceId: "ws-1", configHash: "new" }));
        await expect(store.getWorkspace("ws-1")).resolves.toMatchObject({ configHash: "new" });
      });
    });

    describe("ref records", () => {
      it("putRefRecord then getRefRecord round-trips", async () => {
        const record = refRecord({ refId: "repo-1:main", repoId: "repo-1" });
        await store.putRefRecord(record);
        await expect(store.getRefRecord("repo-1:main")).resolves.toEqual(record);
      });

      it("listRefRecords filters strictly by repoId", async () => {
        await store.putRefRecord(refRecord({ refId: "r1:main", repoId: "r1" }));
        await store.putRefRecord(refRecord({ refId: "r1:dev", repoId: "r1" }));
        await store.putRefRecord(refRecord({ refId: "r2:main", repoId: "r2" }));
        const r1Refs = await store.listRefRecords("r1");
        expect(r1Refs.map((r) => r.refId).sort()).toEqual(["r1:dev", "r1:main"]);
      });
    });

    describe("file manifests", () => {
      it("putFileManifests then getFileManifest/listFileManifests round-trip", async () => {
        const manifestA = fileManifest({ fileId: "f1", refId: "ref-1" });
        const manifestB = fileManifest({ fileId: "f2", refId: "ref-1" });
        await store.putFileManifests([manifestA, manifestB]);
        await expect(store.getFileManifest("f1")).resolves.toEqual(manifestA);
        const listed = await store.listFileManifests("ref-1");
        expect(listed.map((m) => m.fileId).sort()).toEqual(["f1", "f2"]);
      });

      it("deleteFileManifests removes exactly the requested ids", async () => {
        await store.putFileManifests([
          fileManifest({ fileId: "f1", refId: "ref-1" }),
          fileManifest({ fileId: "f2", refId: "ref-1" }),
        ]);
        await store.deleteFileManifests(["f1"]);
        await expect(store.getFileManifest("f1")).resolves.toBeNull();
        await expect(store.getFileManifest("f2")).resolves.not.toBeNull();
      });
    });

    describe("embedding profiles", () => {
      it("putEmbeddingProfile then getEmbeddingProfile round-trips under the given profileId", async () => {
        const profile = embeddingProfile();
        await store.putEmbeddingProfile("profile-1", profile);
        await expect(store.getEmbeddingProfile("profile-1")).resolves.toEqual(profile);
      });
    });

    describe("checkpoints", () => {
      it("putCheckpoint then getCheckpoint round-trips by jobId", async () => {
        const cp = checkpoint({ jobId: "job-1", repoId: "repo-1", refId: "ref-1" });
        await store.putCheckpoint(cp);
        await expect(store.getCheckpoint("job-1")).resolves.toEqual(cp);
      });

      it("getLatestCheckpoint returns the checkpoint with the latest savedAt for (repoId, refId)", async () => {
        await store.putCheckpoint(
          checkpoint({
            jobId: "job-1",
            repoId: "repo-1",
            refId: "ref-1",
            savedAt: "2024-01-01T00:00:00.000Z",
          }),
        );
        await store.putCheckpoint(
          checkpoint({
            jobId: "job-2",
            repoId: "repo-1",
            refId: "ref-1",
            savedAt: "2024-06-01T00:00:00.000Z",
          }),
        );
        await store.putCheckpoint(
          checkpoint({
            jobId: "job-3",
            repoId: "repo-1",
            refId: "other-ref",
            savedAt: "2024-12-01T00:00:00.000Z",
          }),
        );
        const latest = await store.getLatestCheckpoint("repo-1", "ref-1");
        expect(latest?.jobId).toBe("job-2");
      });
    });

    describe("generic versioned records (BUILD_PLAN §3 additive evolution)", () => {
      it("putRecord/getRecord/deleteRecord round-trip under (kind, id)", async () => {
        await store.putRecord("archetype", "a1", { name: "example" });
        await expect(store.getRecord("archetype", "a1")).resolves.toEqual({ name: "example" });
        await store.deleteRecord("archetype", "a1");
        await expect(store.getRecord("archetype", "a1")).resolves.toBeNull();
      });

      it("listRecords without a filter returns every record of that kind", async () => {
        await store.putRecord("archetype", "a1", { name: "one" });
        await store.putRecord("archetype", "a2", { name: "two" });
        const all = await store.listRecords("archetype");
        expect(all).toHaveLength(2);
      });

      it("listRecords with a filter matches records whose fields equal every filter entry", async () => {
        await store.putRecord("tech", "t1", { ecosystem: "npm", name: "react" });
        await store.putRecord("tech", "t2", { ecosystem: "pypi", name: "django" });
        const npmOnly = await store.listRecords("tech", { ecosystem: "npm" });
        expect(npmOnly.map((r) => r["name"])).toEqual(["react"]);
      });

      it("records of different kinds never leak into each other's listings", async () => {
        await store.putRecord("kindA", "x", { v: 1 });
        await store.putRecord("kindB", "x", { v: 2 });
        expect(await store.listRecords("kindA")).toEqual([{ v: 1 }]);
        expect(await store.getRecord("kindB", "x")).toEqual({ v: 2 });
      });
    });

    describe("AbortSignal (spec.md §22)", () => {
      it("rejects every method when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const signal = controller.signal;
        await expect(store.getWorkspace("w", { signal })).rejects.toBeDefined();
        await expect(
          store.putWorkspace(workspace({ workspaceId: "w" }), { signal }),
        ).rejects.toBeDefined();
        await expect(store.getRefRecord("r", { signal })).rejects.toBeDefined();
        await expect(
          store.putRefRecord(refRecord({ refId: "r", repoId: "repo" }), { signal }),
        ).rejects.toBeDefined();
        await expect(store.listRefRecords("repo", { signal })).rejects.toBeDefined();
        await expect(store.getFileManifest("f", { signal })).rejects.toBeDefined();
        await expect(store.listFileManifests("ref", { signal })).rejects.toBeDefined();
        await expect(
          store.putFileManifests([fileManifest({ fileId: "f", refId: "ref" })], { signal }),
        ).rejects.toBeDefined();
        await expect(store.deleteFileManifests(["f"], { signal })).rejects.toBeDefined();
        await expect(store.getEmbeddingProfile("p", { signal })).rejects.toBeDefined();
        await expect(
          store.putEmbeddingProfile("p", embeddingProfile(), { signal }),
        ).rejects.toBeDefined();
        await expect(store.getCheckpoint("j", { signal })).rejects.toBeDefined();
        await expect(
          store.putCheckpoint(checkpoint({ jobId: "j", repoId: "r", refId: "ref" }), { signal }),
        ).rejects.toBeDefined();
        await expect(store.getLatestCheckpoint("r", "ref", { signal })).rejects.toBeDefined();
        await expect(store.getRecord("k", "i", { signal })).rejects.toBeDefined();
        await expect(store.putRecord("k", "i", {}, { signal })).rejects.toBeDefined();
        await expect(store.listRecords("k", undefined, { signal })).rejects.toBeDefined();
        await expect(store.deleteRecord("k", "i", { signal })).rejects.toBeDefined();
      });
    });
  });
}
