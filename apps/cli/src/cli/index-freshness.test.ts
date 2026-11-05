import { mkdtemp, mkdir, rm, writeFile, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalJson,
  CHUNKER_VERSION,
  LEXICAL_TOKENIZER_VERSION,
  sha256Hex,
} from "@untangle-code/domain";
import { afterEach, describe, expect, it } from "vitest";

import { detectRefName, resolveTarget } from "../commands/index/target.js";
import { addFreshnessWarning } from "../commands/query.js";

import { indexConfigFingerprint, inspectIndexFreshness } from "./index-freshness.js";
import { parseIndexState, type FoundIndexState } from "./index-state.js";
import { loadWorkspace } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "untangle-freshness-"));
  roots.push(root);
  await writeFile(
    path.join(root, "user.ts"),
    "export function getUserById(id: string) { return id; }\n",
  );
  const view = loadWorkspace({ cwd: root, env: {}, strict: true });
  const target = resolveTarget({
    config: view.config,
    cwd: root,
    rootFlag: root,
    repoFlag: undefined,
    refFlag: undefined,
    configBaseDir: view.root,
  });
  const found: FoundIndexState = {
    repoRoot: root,
    statePath: path.join(root, ".untangle/index-state.json"),
    source: "registry",
    current: true,
    state: {
      schemaVersion: 1,
      workspaceId: view.workspaceId,
      repoId: target.repoId,
      refId: target.refId,
      refName: target.refName,
      embedder: "service",
      embeddingProfileId: view.profileId,
      collection: "test",
      qdrantUrl: "http://127.0.0.1:16333",
      outcome: "completed",
      generationId: "generation",
      corpusRevisionFingerprint: "a".repeat(64),
      indexedAt: "2026-10-10T10:00:00.000Z",
      indexConfigFingerprint: indexConfigFingerprint(view, target),
      lexicalTokenizerVersion: LEXICAL_TOKENIZER_VERSION,
    },
  };
  const first = await inspectIndexFreshness(view, [found]);
  const baseline = {
    ...found,
    state: {
      ...found.state,
      corpusRevisionFingerprint: first.repositories[0]?.currentCorpusFingerprint ?? "",
    },
  };
  return { root, view, found: baseline };
}

describe("content-bound index freshness", () => {
  it("confirms the entire source manifest and completion metadata", async () => {
    const { view, found } = await fixture();
    expect(await inspectIndexFreshness(view, [found])).toMatchObject({
      status: "fresh",
      repositories: [
        { reason: "content_hashes_match", filesChecked: 1, indexedAt: "2026-10-10T10:00:00.000Z" },
      ],
    });
    expect(parseIndexState(JSON.stringify(found.state))).toEqual(found.state);
  });
  it("finds content changes even when mtime and file size are preserved", async () => {
    const { root, view, found } = await fixture();
    const file = path.join(root, "user.ts");
    const before = await stat(file);
    await writeFile(file, "export function getUserById(id: string) { return 42; }\n");
    await utimes(file, before.atime, before.mtime);
    expect(await inspectIndexFreshness(view, [found])).toMatchObject({
      status: "stale",
      repositories: [{ reason: "sources_changed" }],
    });
  });
  it.each(["add", "delete"])("detects %s operations", async (operation) => {
    const { root, view, found } = await fixture();
    if (operation === "add")
      await writeFile(path.join(root, "added.ts"), "export const added = true;\n");
    else await rm(path.join(root, "user.ts"));
    expect((await inspectIndexFreshness(view, [found])).status).toBe("stale");
  });
  it("does not count the private state directory as source", async () => {
    const { root, view, found } = await fixture();
    await mkdir(path.join(root, ".untangle"));
    await writeFile(path.join(root, ".untangle/cache.ts"), "changed state");
    expect((await inspectIndexFreshness(view, [found])).status).toBe("fresh");
  });
  it("requires reindexing legacy lexical vectors without reinterpreting them", async () => {
    const { view, found } = await fixture();
    const { lexicalTokenizerVersion: _, ...legacy } = found.state;
    expect(await inspectIndexFreshness(view, [{ ...found, state: legacy }])).toMatchObject({
      status: "incompatible",
      repositories: [{ reason: "lexical_tokenizer_changed" }],
    });
  });
  it("detects source-selection and chunk-budget changes", async () => {
    const { view, found } = await fixture();
    expect(
      await inspectIndexFreshness(
        {
          ...view,
          config: {
            ...view.config,
            index: { ...view.config.index, maxChunkTokens: view.config.index.maxChunkTokens + 1 },
          },
        },
        [found],
      ),
    ).toMatchObject({ status: "stale", repositories: [{ reason: "index_configuration_changed" }] });
  });
  it.each([undefined, "untangle-chunker-v1"])(
    "rejects a source-identical snapshot built with legacy chunk semantics (%s)",
    async (chunkerVersion) => {
      const { view, found } = await fixture();
      const legacyFingerprint = sha256Hex(
        canonicalJson({
          ...(chunkerVersion === undefined ? {} : { chunkerVersion }),
          maxFileSizeMb: view.config.index.maxFileSizeMb,
          maxChunkTokens: view.config.index.maxChunkTokens,
          include: [],
          exclude: [],
        }),
      );
      expect(CHUNKER_VERSION).not.toBe("untangle-chunker-v1");
      expect(
        await inspectIndexFreshness(view, [
          { ...found, state: { ...found.state, indexConfigFingerprint: legacyFingerprint } },
        ]),
      ).toMatchObject({
        status: "stale",
        repositories: [{ reason: "index_configuration_changed", filesChecked: 0 }],
      });
    },
  );
  it("does not claim freshness for incomplete or unbound snapshots", async () => {
    const { view, found } = await fixture();
    expect(
      (
        await inspectIndexFreshness(view, [
          { ...found, state: { ...found.state, outcome: "running" } },
        ])
      ).status,
    ).toBe("stale");
    const { indexedAt: _, ...unbound } = found.state;
    expect((await inspectIndexFreshness(view, [{ ...found, state: unbound }])).status).toBe(
      "unknown",
    );
    expect((await inspectIndexFreshness(view, [])).status).toBe("unknown");
  });
  it("requires coverage of every requested repository, including ones with no index record", async () => {
    const { view, found } = await fixture();
    expect(
      await inspectIndexFreshness(view, [found], {
        expectedRepoIds: [found.state.repoId, "unindexed"],
      }),
    ).toMatchObject({
      status: "unknown",
      repositories: [
        { status: "fresh" },
        { repoId: "unindexed", reason: "index_snapshot_missing" },
      ],
    });
    expect(
      (await inspectIndexFreshness(view, [found], { expectedRepoIds: [found.state.repoId] }))
        .status,
    ).toBe("fresh");
  });
  it("requires every selected ref without broadening a canonical per-repo ref filter", async () => {
    const { view, found } = await fixture();
    const repoId = found.state.repoId;
    expect(
      (
        await inspectIndexFreshness(view, [found], {
          expectedRepoIds: [repoId],
          expectedRefs: [found.state.refId, "missing"],
        })
      ).status,
    ).toBe("unknown");
    expect(
      await inspectIndexFreshness(view, [found], {
        expectedRepoIds: [repoId, "other"],
        expectedRefs: [found.state.refId],
      }),
    ).toMatchObject({ status: "fresh", repositories: [{ repoId }] });
  });
  it("does not compare a historical ref to another checked-out branch", async () => {
    const { view, found } = await fixture();
    expect(
      await inspectIndexFreshness(view, [
        { ...found, state: { ...found.state, refName: "historical" } },
      ]),
    ).toMatchObject({ status: "unknown", repositories: [{ reason: "ref_not_checked_out" }] });
  });
  it("reads worktree .git pointers instead of inventing working-tree refs", async () => {
    const { root } = await fixture();
    await mkdir(path.join(root, "gitdir"));
    await writeFile(path.join(root, "gitdir/HEAD"), "ref: refs/heads/feature/search\n");
    await writeFile(path.join(root, ".git"), "gitdir: gitdir\n");
    expect(detectRefName(root)).toBe("feature/search");
  });
  it("propagates cancellation", async () => {
    const { view, found } = await fixture();
    await expect(
      inspectIndexFreshness(view, [found], { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
  it("marks stale searches as measurement-incomplete even when they contain hits", () => {
    const result = { warnings: [] as Array<{ code: string; message: string }> };
    addFreshnessWarning(result, {
      status: "stale",
      checkedAt: "2026-10-10T10:00:00.000Z",
      repositories: [],
    });
    expect(result.warnings[0]?.code).toBe("INDEX_CONTEXT_INCOMPLETE");
  });
  it("retains existing index diagnostics without repeating the same warning", () => {
    const result = {
      warnings: [
        {
          code: "INDEX_CONTEXT_INCOMPLETE",
          message: "Incomplete snapshot",
          details: { embeddingProfileId: "profile" },
        },
      ],
    };
    addFreshnessWarning(result, {
      status: "stale",
      checkedAt: "2026-10-10T10:00:00.000Z",
      repositories: [],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      details: { embeddingProfileId: "profile", indexFreshness: { status: "stale" } },
    });
  });
});
