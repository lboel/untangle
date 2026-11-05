import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRefId } from "@untangle-code/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { indexCommand } from "../commands/index/index.js";

import type { CommandContext } from "./command.js";
import { EXIT } from "./exit.js";
import { refreshWorkspaceIndex } from "./index-refresh.js";
import { loadWorkspace } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  repositories: Array<{ id: string; configuredRef: string; checkedRef: string }>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "untangle-refresh-"));
  roots.push(root);
  for (const repo of repositories) {
    await mkdir(path.join(root, repo.id, ".git"), { recursive: true });
    await writeFile(path.join(root, repo.id, ".git/HEAD"), `ref: refs/heads/${repo.checkedRef}\n`);
  }
  const base = loadWorkspace({ cwd: root, env: {}, strict: true });
  const view = {
    ...base,
    config: {
      ...base.config,
      repositories: repositories.map((repo) => ({
        id: repo.id,
        path: repo.id,
        ref: repo.configuredRef,
      })),
    },
    repoIds: repositories.map((repo) => repo.id),
  };
  const controller = new AbortController();
  const ctx: CommandContext = {
    cwd: root,
    env: {},
    signal: controller.signal,
    io: { out: vi.fn(), err: vi.fn() },
  };
  const run = vi.spyOn(indexCommand, "run").mockResolvedValue(EXIT.ok);
  return { root, view, ctx, controller, run };
}

describe("checked-out index refresh selection", () => {
  it.each(["feature/search", buildRefId("demo", "feature/search")])(
    "honors explicit ref %s instead of a different configured default",
    async (ref) => {
      const { root, view, ctx, run } = await fixture([
        { id: "demo", configuredRef: "main", checkedRef: "feature/search" },
      ]);
      await refreshWorkspaceIndex(ctx, { view, refIds: [ref], embedder: "offline" });
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[1].flags).toMatchObject({
        root,
        repo: "demo",
        ref: "feature/search",
        embedder: "offline",
        resume: false,
      });
    },
  );

  it("retains the configured default when no ref was selected", async () => {
    const { view, ctx, run } = await fixture([
      { id: "demo", configuredRef: "main", checkedRef: "main" },
    ]);
    await refreshWorkspaceIndex(ctx, { view, embedder: "auto" });
    expect(run.mock.calls[0]?.[1].flags["ref"]).toBe("main");
  });

  it("rejects a configured ref that is not checked out", async () => {
    const { view, ctx, run } = await fixture([
      { id: "demo", configuredRef: "main", checkedRef: "feature/search" },
    ]);
    await expect(refreshWorkspaceIndex(ctx, { view, embedder: "auto" })).rejects.toMatchObject({
      exitCode: EXIT.usage,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([{ refIds: ["missing"] }, { refIds: ["feature/search", "missing"] }])(
    "rejects unavailable ref selections $refIds before any partial refresh",
    async ({ refIds }) => {
      const { view, ctx, run } = await fixture([
        { id: "demo", configuredRef: "main", checkedRef: "feature/search" },
      ]);
      await expect(
        refreshWorkspaceIndex(ctx, { view, refIds, embedder: "offline" }),
      ).rejects.toMatchObject({
        exitCode: EXIT.usage,
        message: expect.stringContaining("missing"),
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("refreshes all explicitly selected physical refs serially", async () => {
    const { view, ctx, run } = await fixture([
      { id: "first", configuredRef: "main", checkedRef: "feature/search" },
      { id: "second", configuredRef: "other", checkedRef: "main" },
    ]);
    await refreshWorkspaceIndex(ctx, {
      view,
      refIds: [buildRefId("first", "feature/search"), buildRefId("second", "main")],
      embedder: "offline",
    });
    expect(run.mock.calls.map(([, args]) => args.flags["ref"])).toEqual(["feature/search", "main"]);
  });

  it("requires a named ref to be checked out in every selected repository", async () => {
    const { view, ctx, run } = await fixture([
      { id: "first", configuredRef: "main", checkedRef: "main" },
      { id: "second", configuredRef: "main", checkedRef: "feature/search" },
    ]);
    await expect(
      refreshWorkspaceIndex(ctx, { view, refIds: ["main"], embedder: "offline" }),
    ).rejects.toMatchObject({
      exitCode: EXIT.usage,
      message: expect.stringContaining("second:main"),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a canonical ref limited to its own repository", async () => {
    const { view, ctx, run } = await fixture([
      { id: "first", configuredRef: "main", checkedRef: "main" },
      { id: "second", configuredRef: "main", checkedRef: "feature/search" },
    ]);
    await refreshWorkspaceIndex(ctx, { view, refIds: ["first:main"], embedder: "offline" });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1].flags["repo"]).toBe("first");
  });

  it("does not silently refresh a synthesized repo for an unknown explicit repository ID", async () => {
    const { view, ctx, run } = await fixture([]);
    await expect(
      refreshWorkspaceIndex(ctx, { view, repoIds: ["missing"], embedder: "offline" }),
    ).rejects.toMatchObject({ exitCode: EXIT.usage });
    expect(run).not.toHaveBeenCalled();
  });

  it("validates every default target before mutating the first repository", async () => {
    const { view, ctx, run } = await fixture([
      { id: "first", configuredRef: "main", checkedRef: "main" },
      { id: "second", configuredRef: "main", checkedRef: "feature/search" },
    ]);
    await expect(refreshWorkspaceIndex(ctx, { view, embedder: "offline" })).rejects.toMatchObject({
      exitCode: EXIT.usage,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps index output off the query stdout stream", async () => {
    const { view, ctx, run } = await fixture([
      { id: "demo", configuredRef: "main", checkedRef: "main" },
    ]);
    run.mockImplementation(async (indexContext) => {
      indexContext.io.out("index result");
      indexContext.io.err("index progress");
      return EXIT.ok;
    });
    await refreshWorkspaceIndex(ctx, { view, embedder: "offline" });
    expect(ctx.io.out).not.toHaveBeenCalled();
    expect(ctx.io.err).toHaveBeenNthCalledWith(1, "index result");
    expect(ctx.io.err).toHaveBeenNthCalledWith(2, "index progress");
  });

  it("stops before the next repository when the first refresh is cancelled", async () => {
    const { view, ctx, run, controller } = await fixture([
      { id: "first", configuredRef: "main", checkedRef: "main" },
      { id: "second", configuredRef: "main", checkedRef: "main" },
    ]);
    run.mockImplementation(async () => {
      controller.abort();
      return EXIT.cancelled;
    });
    await expect(refreshWorkspaceIndex(ctx, { view, embedder: "offline" })).rejects.toThrow();
    expect(run).toHaveBeenCalledOnce();
  });
});
