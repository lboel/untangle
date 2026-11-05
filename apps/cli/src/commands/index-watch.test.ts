import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IndexFreshnessV1 } from "@untangle-code/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandContext } from "../cli/command.js";
import { EnvironmentError, EXIT } from "../cli/exit.js";
import { BufferIo } from "../cli/io.js";

import {
  inspectIndexWatch,
  runIndexWatch,
  type IndexWatchObservation,
  type IndexWatchOptions,
} from "./index-watch.js";
import { watchCommand } from "./watch-command.js";

vi.mock("../cli/index-freshness.js", () => ({
  inspectIndexFreshness: vi.fn(async () => ({
    status: "unknown",
    checkedAt: "2026-10-10T00:00:00Z",
    repositories: [],
  })),
}));
vi.mock("../cli/index-refresh.js", () => ({ refreshWorkspaceIndex: vi.fn() }));
vi.mock("../cli/index-state.js", () => ({
  resolveIndexState: vi.fn(async () => ({ kind: "none" })),
}));

const OPTIONS: IndexWatchOptions = {
  root: "/unused",
  embedder: "auto",
  intervalMs: 1000,
  format: "json",
  outPath: null,
  once: true,
  maxRefreshes: null,
};

function context(controller = new AbortController()): CommandContext & { io: BufferIo } {
  return { cwd: "/unused", env: {}, signal: controller.signal, io: new BufferIo() };
}

function observation(
  status: IndexFreshnessV1["status"],
  refresh: () => Promise<void> = vi.fn(async () => undefined),
): IndexWatchObservation {
  return {
    workspaceId: "watch-test",
    repoId: "repo",
    refId: "repo:main",
    freshness: { status, checkedAt: "2026-10-10T00:00:00Z", repositories: [] },
    refresh,
  };
}

function events(
  ctx: CommandContext & { io: BufferIo },
): Array<{ event: string; refreshes: number; indexFreshness?: IndexFreshnessV1 }> {
  return ctx.io.outText
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (row) =>
        JSON.parse(row) as { event: string; refreshes: number; indexFreshness?: IndexFreshnessV1 },
    );
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
});

describe("search index watch", () => {
  it("checks a fresh index once without refreshing or waiting", async () => {
    const ctx = context();
    const refresh = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);
    expect(
      await runIndexWatch(ctx, OPTIONS, {
        inspect: vi.fn(async () => observation("fresh", refresh)),
        wait,
      }),
    ).toBe(EXIT.ok);
    expect(refresh).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(events(ctx).map((event) => event.event)).toEqual(["checked", "stopped"]);
  });

  it.each(["stale", "incompatible", "unknown"] as const)(
    "refreshes %s and verifies the resulting state",
    async (status) => {
      const ctx = context();
      const refresh = vi.fn(async () => undefined);
      const inspect = vi
        .fn()
        .mockResolvedValueOnce(observation(status, refresh))
        .mockResolvedValueOnce(observation("fresh"));
      expect(await runIndexWatch(ctx, OPTIONS, { inspect, wait: vi.fn() })).toBe(EXIT.ok);
      expect(refresh).toHaveBeenCalledOnce();
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(events(ctx).map((event) => event.event)).toEqual([
        "checked",
        "refresh_started",
        "refreshed",
        "stopped",
      ]);
      expect(events(ctx)[2]?.indexFreshness?.status).toBe("fresh");
    },
  );

  it("serializes refresh and post-check before the next polling interval", async () => {
    const ctx = context();
    let release: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(observation("stale", refresh))
      .mockResolvedValueOnce(observation("fresh"));
    const wait = vi.fn();
    const result = runIndexWatch(
      ctx,
      { ...OPTIONS, once: false, maxRefreshes: 1 },
      { inspect, wait },
    );
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(inspect).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    release?.();
    expect(await result).toBe(EXIT.ok);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("finds a later source change on the next check instead of refreshing every poll", async () => {
    const ctx = context();
    const refresh = vi.fn(async () => undefined);
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(observation("fresh"))
      .mockResolvedValueOnce(observation("stale", refresh))
      .mockResolvedValueOnce(observation("fresh"));
    const wait = vi.fn(async () => undefined);
    expect(
      await runIndexWatch(ctx, { ...OPTIONS, once: false, maxRefreshes: 1 }, { inspect, wait }),
    ).toBe(EXIT.ok);
    expect(wait).toHaveBeenCalledExactlyOnceWith(1000, ctx.signal);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reports a failed refresh and preserves the actionable error", async () => {
    const ctx = context();
    const error = new EnvironmentError(
      "Qdrant unavailable",
      "Start the configured Qdrant service.",
    );
    const refresh = vi.fn(async () => {
      throw error;
    });
    await expect(
      runIndexWatch(ctx, OPTIONS, {
        inspect: vi.fn(async () => observation("stale", refresh)),
        wait: vi.fn(),
      }),
    ).rejects.toBe(error);
    expect(events(ctx).map((event) => event.event)).toEqual([
      "checked",
      "refresh_started",
      "failed",
    ]);
  });

  it("does not report an unverifiable new generation as a successful watcher run", async () => {
    const ctx = context();
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(observation("stale"))
      .mockResolvedValueOnce(observation("unknown"));
    await expect(runIndexWatch(ctx, OPTIONS, { inspect, wait: vi.fn() })).rejects.toMatchObject({
      exitCode: EXIT.environment,
    });
    expect(events(ctx).at(-1)?.event).toBe("failed");
  });

  it("cancels a pending polling wait without starting another inspection", async () => {
    const controller = new AbortController();
    const ctx = context(controller);
    const inspect = vi.fn(async () => observation("fresh"));
    const wait = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    expect(await runIndexWatch(ctx, { ...OPTIONS, once: false }, { inspect, wait })).toBe(
      EXIT.cancelled,
    );
    expect(inspect).toHaveBeenCalledOnce();
    expect(events(ctx).at(-1)?.event).toBe("stopped");
  });

  it("passes the cancellation signal into an in-flight refresh and waits for cleanup", async () => {
    const controller = new AbortController();
    const ctx = context(controller);
    let cleaned = false;
    const refresh = vi.fn(async () => {
      await new Promise<void>((_resolve, reject) =>
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }),
      ).finally(() => {
        cleaned = true;
      });
    });
    const result = runIndexWatch(ctx, OPTIONS, {
      inspect: vi.fn(async () => observation("stale", refresh)),
      wait: vi.fn(),
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    controller.abort();
    expect(await result).toBe(EXIT.cancelled);
    expect(cleaned).toBe(true);
    expect(events(ctx).some((event) => event.event === "refreshed")).toBe(false);
  });

  it("rejects an unspecified repository in a multi-repository configuration before mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "untangle-index-watch-"));
    temporaryRoots.push(root);
    await writeFile(
      path.join(root, ".untangle.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [
          { id: "one", path: "one" },
          { id: "two", path: "two" },
        ],
      }),
    );
    await expect(inspectIndexWatch(context(), { ...OPTIONS, root })).rejects.toMatchObject({
      exitCode: EXIT.usage,
    });
  });

  it("rejects index-only arguments without --index and invalid polling bounds", async () => {
    await expect(
      watchCommand.run(context(), { positionals: [], flags: { repo: "one" } }),
    ).rejects.toMatchObject({ exitCode: EXIT.usage });
    await expect(
      watchCommand.run(context(), { positionals: [], flags: { index: true, reconcile: 0 } }),
    ).rejects.toMatchObject({ exitCode: EXIT.usage });
    await expect(
      watchCommand.run(context(), {
        positionals: [],
        flags: { index: true, reconcile: 2_147_483_648 },
      }),
    ).rejects.toMatchObject({ exitCode: EXIT.usage });
  });
});
