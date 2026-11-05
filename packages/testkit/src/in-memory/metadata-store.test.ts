import type { RefRecord, WorkspaceRecord } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { InMemoryMetadataStore } from "./metadata-store.js";

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    schemaVersion: 1,
    workspaceId: "ws-1",
    configHash: "hash-1",
    repositories: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRef(overrides: Partial<RefRecord> = {}): RefRecord {
  return {
    refId: "repo-1:main",
    repoId: "repo-1",
    refName: "main",
    generationId: "gen-1",
    indexStatus: "completed",
    ...overrides,
  };
}

describe("InMemoryMetadataStore — workspace", () => {
  it("returns null for an unknown workspace without creating it", async () => {
    const store = new InMemoryMetadataStore();
    expect(await store.getWorkspace("missing")).toBeNull();
  });

  it("round-trips a put workspace", async () => {
    const store = new InMemoryMetadataStore();
    const record = makeWorkspace();
    await store.putWorkspace(record);
    expect(await store.getWorkspace(record.workspaceId)).toEqual(record);
  });

  it("putWorkspace overwrites a previous record for the same id", async () => {
    const store = new InMemoryMetadataStore();
    await store.putWorkspace(makeWorkspace({ configHash: "old" }));
    await store.putWorkspace(makeWorkspace({ configHash: "new" }));
    expect((await store.getWorkspace("ws-1"))?.configHash).toBe("new");
  });
});

describe("InMemoryMetadataStore — ref records", () => {
  it("listRefRecords filters by repoId only", async () => {
    const store = new InMemoryMetadataStore();
    await store.putRefRecord(makeRef({ refId: "repo-1:main", repoId: "repo-1" }));
    await store.putRefRecord(makeRef({ refId: "repo-2:main", repoId: "repo-2" }));
    const refs = await store.listRefRecords("repo-1");
    expect(refs.map((r) => r.refId)).toEqual(["repo-1:main"]);
  });

  it("returns an empty array for a repo with no ref records", async () => {
    const store = new InMemoryMetadataStore();
    expect(await store.listRefRecords("nothing")).toEqual([]);
  });
});

describe("InMemoryMetadataStore — file manifests", () => {
  it("putFileManifests upserts and listFileManifests filters by refId", async () => {
    const store = new InMemoryMetadataStore();
    await store.putFileManifests([
      {
        fileId: "f1",
        repoId: "repo-1",
        refId: "ref-1",
        relativePath: "a.ts",
        contentHash: "h1",
        sizeBytes: 10,
        language: "typescript",
        parseQuality: "complete",
        chunkIds: [],
        symbolIds: [],
        metricsScopeId: "scope-1",
        parserVersion: "1.0.0",
        chunkerVersion: "1.0.0",
        generationId: "gen-1",
      },
    ]);
    const manifests = await store.listFileManifests("ref-1");
    expect(manifests).toHaveLength(1);
    expect(await store.getFileManifest("f1")).not.toBeNull();
  });

  it("deleteFileManifests removes only the given ids", async () => {
    const store = new InMemoryMetadataStore();
    const base = {
      repoId: "repo-1",
      refId: "ref-1",
      contentHash: "h",
      sizeBytes: 1,
      language: "typescript",
      parseQuality: "complete" as const,
      chunkIds: [],
      symbolIds: [],
      metricsScopeId: "scope",
      parserVersion: "1.0.0",
      chunkerVersion: "1.0.0",
      generationId: "gen-1",
    };
    await store.putFileManifests([
      { ...base, fileId: "f1", relativePath: "a.ts" },
      { ...base, fileId: "f2", relativePath: "b.ts" },
    ]);
    await store.deleteFileManifests(["f1"]);
    expect(await store.getFileManifest("f1")).toBeNull();
    expect(await store.getFileManifest("f2")).not.toBeNull();
  });
});

describe("InMemoryMetadataStore — checkpoints", () => {
  it("getLatestCheckpoint returns the most recently saved matching checkpoint", async () => {
    const store = new InMemoryMetadataStore();
    const base = {
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "ref-1",
      generationId: "gen-1",
      effectiveProfileId: "profile-1",
      completedFiles: [],
      storedPointIdsByFile: {},
      manifestHashes: {},
      stage: "chunking",
    };
    await store.putCheckpoint({ ...base, jobId: "job-1", savedAt: "2026-01-01T00:00:00.000Z" });
    await store.putCheckpoint({ ...base, jobId: "job-2", savedAt: "2026-01-02T00:00:00.000Z" });
    const latest = await store.getLatestCheckpoint("repo-1", "ref-1");
    expect(latest?.jobId).toBe("job-2");
  });

  it("getLatestCheckpoint returns null when no checkpoint matches repo/ref", async () => {
    const store = new InMemoryMetadataStore();
    expect(await store.getLatestCheckpoint("repo-x", "ref-x")).toBeNull();
  });
});

describe("InMemoryMetadataStore — generic records", () => {
  it("round-trips a generic record by kind and id", async () => {
    const store = new InMemoryMetadataStore();
    await store.putRecord("quality_gate", "gate-1", { status: "pass" });
    expect(await store.getRecord("quality_gate", "gate-1")).toEqual({ status: "pass" });
  });

  it("listRecords filters by exact field match", async () => {
    const store = new InMemoryMetadataStore();
    await store.putRecord("quality_gate", "g1", { status: "pass" });
    await store.putRecord("quality_gate", "g2", { status: "fail" });
    const passing = await store.listRecords("quality_gate", { status: "pass" });
    expect(passing).toEqual([{ status: "pass" }]);
  });

  it("deleteRecord removes only the targeted record", async () => {
    const store = new InMemoryMetadataStore();
    await store.putRecord("quality_gate", "g1", { status: "pass" });
    await store.deleteRecord("quality_gate", "g1");
    expect(await store.getRecord("quality_gate", "g1")).toBeNull();
  });

  it("listRecords on an unknown kind returns an empty array", async () => {
    const store = new InMemoryMetadataStore();
    expect(await store.listRecords("unknown_kind")).toEqual([]);
  });
});
