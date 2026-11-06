import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  indexStateCurrentKey,
  indexStatePath,
  indexStateRecordKey,
  parseIndexState,
  replaceRunningIndexState,
  resolveIndexState,
  stateRootOf,
  writeIndexState,
  type IndexStateV1,
} from "./index-state.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "untangle-backend-state-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function state(backend: "qdrant" | "lancedb", overrides: Partial<IndexStateV1> = {}): IndexStateV1 {
  return {
    schemaVersion: 1,
    workspaceId: "workspace",
    repoId: "repo",
    refId: "repo:main",
    refName: "main",
    embedder: "offline",
    embeddingProfileId: "profile",
    collection: "untangle_code_profile_v1",
    generationId: "generation",
    outcome: "completed",
    ...(backend === "qdrant"
      ? { qdrantUrl: "http://127.0.0.1:16333" }
      : {
          storageBackend: "lancedb",
          storeUrl: pathToFileURL(path.join(root, "db")).href,
        }),
    ...overrides,
  };
}

describe("backend-bound index publication", () => {
  it("reads legacy Qdrant records unchanged and embedded records without a fake server URL", () => {
    for (const backend of ["qdrant", "lancedb"] as const) {
      const value = state(backend);
      expect(parseIndexState(JSON.stringify(value))).toEqual(value);
    }
  });

  it.each([
    { storageBackend: "unknown", storeUrl: "file:///index" },
    { storageBackend: "lancedb" },
    { storageBackend: "lancedb", storeUrl: "http://server/index" },
    { storageBackend: "lancedb", storeUrl: "file:relative" },
    { storageBackend: "lancedb", storeUrl: "file://server/index" },
    { storageBackend: "lancedb", storeUrl: "file:///index?query" },
    { storageBackend: "lancedb", storeUrl: "file:///index#fragment" },
    { storageBackend: "lancedb", storeUrl: "file:///index", qdrantUrl: "http://server" },
    { storeUrl: "file:///index" },
  ])("rejects malformed or ambiguous storage identity %j", (identity) => {
    const {
      qdrantUrl: _url,
      storageBackend: _backend,
      storeUrl: _store,
      ...base
    } = state("qdrant");
    expect(parseIndexState(JSON.stringify({ ...base, ...identity }))).toBeNull();
  });

  it("isolates current pointers and auto profiles for two backends and two embedded paths", async () => {
    const qdrant = state("qdrant", { embedder: "service", embeddingProfileId: "service-profile" });
    const lance = state("lancedb");
    const second = state("lancedb", { storeUrl: pathToFileURL(path.join(root, "second-db")).href });
    expect(new Set([qdrant, lance, second].map(indexStateCurrentKey)).size).toBe(3);
    expect(new Set([qdrant, lance, second].map(indexStateRecordKey)).size).toBe(3);
    for (const value of [qdrant, lance, second]) {
      expect((await writeIndexState(stateRootOf(root), value)).ok).toBe(true);
    }
    for (const value of [qdrant, lance, second]) {
      const resolved = await resolveIndexState([root], "workspace", {
        storageBackend: value.storageBackend ?? "qdrant",
        storeUrl: value.storeUrl ?? value.qdrantUrl!,
      });
      expect(resolved.kind).toBe("resolved");
      if (resolved.kind !== "resolved") throw new Error("Expected independent backend state");
      expect(resolved.current.map((x) => x.state)).toEqual([value]);
      expect(resolved.embedder).toBe(value.embedder);
    }
  });

  it("preserves Qdrant and another database when an embedded terminal generation is published", async () => {
    const qdrant = state("qdrant");
    const running = state("lancedb", { outcome: "running" });
    for (const value of [qdrant, running])
      expect((await writeIndexState(stateRootOf(root), value)).ok).toBe(true);
    const completed = { ...running, outcome: "completed" as const };
    const result = await replaceRunningIndexState(stateRootOf(root), completed);
    expect(result.ok).toBe(true);
    expect(result.superseded).toBe(false);
    const resolved = await resolveIndexState([root], "workspace", { storageBackend: "qdrant" });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.found.state).toEqual(qdrant);
  });

  it("never invalidates a legacy Qdrant singleton on a malformed embedded publication", async () => {
    const legacy = state("qdrant");
    const selectedRoot = stateRootOf(root);
    await mkdir(selectedRoot, { recursive: true });
    await writeFile(indexStatePath(selectedRoot), JSON.stringify(legacy));
    const invalid = { ...state("lancedb"), storeUrl: "" };
    expect((await writeIndexState(selectedRoot, invalid)).ok).toBe(false);
    expect(JSON.parse(await readFile(indexStatePath(selectedRoot), "utf8"))).toEqual(legacy);
  });
});
