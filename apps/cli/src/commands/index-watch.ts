import { setTimeout as wait } from "node:timers/promises";

import type { IndexFreshnessV1 } from "@untangle-code/domain";

import type { CommandContext } from "../cli/command.js";
import { EXIT, EnvironmentError, UsageError } from "../cli/exit.js";
import { inspectIndexFreshness } from "../cli/index-freshness.js";
import { refreshWorkspaceIndex } from "../cli/index-refresh.js";
import { resolveIndexState } from "../cli/index-state.js";
import { systemClock } from "../cli/system.js";
import { loadWorkspace, storageIndexScope, wireStorage } from "../cli/workspace.js";

import { detectRefName, resolveTarget } from "./index/target.js";
import { createStreamSink } from "./watch/runtime.js";

export interface IndexWatchOptions {
  root: string;
  repo?: string;
  ref?: string;
  embedder: "auto" | "offline";
  intervalMs: number;
  format: "text" | "json";
  outPath: string | null;
  once: boolean;
  maxRefreshes: number | null;
}

export interface IndexWatchObservation {
  workspaceId: string;
  repoId: string;
  refId: string;
  freshness: IndexFreshnessV1;
  /** Bound to exactly the repository/ref that was inspected. */
  refresh(): Promise<void>;
}

export interface IndexWatchDependencies {
  inspect(ctx: CommandContext, options: IndexWatchOptions): Promise<IndexWatchObservation>;
  wait(intervalMs: number, signal: AbortSignal): Promise<void>;
}

const DEFAULT_DEPENDENCIES: IndexWatchDependencies = {
  inspect: inspectIndexWatch,
  wait: async (intervalMs, signal) => {
    await wait(intervalMs, undefined, { signal });
  },
};

/** One serialized loop: re-read configuration and hash sources, then refresh if necessary. */
export async function runIndexWatch(
  ctx: CommandContext,
  options: IndexWatchOptions,
  deps: IndexWatchDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const sink = createStreamSink({ stdout: (chunk) => ctx.io.out(chunk), outPath: options.outPath });
  let refreshes = 0;
  const emit = (
    event: "checked" | "refresh_started" | "refreshed" | "failed" | "stopped",
    observation?: IndexWatchObservation,
    message?: string,
  ): void => {
    const record = {
      schemaVersion: 1,
      kind: "index_watch",
      event,
      checkedAt: observation?.freshness.checkedAt ?? systemClock.nowIso(),
      refreshes,
      ...(observation === undefined
        ? {}
        : {
            workspaceId: observation.workspaceId,
            repoId: observation.repoId,
            refId: observation.refId,
            indexFreshness: observation.freshness,
          }),
      ...(message === undefined ? {} : { message }),
    };
    sink.write(
      options.format === "json"
        ? JSON.stringify(record)
        : `Search index: ${event}${observation === undefined ? "" : ` ${observation.repoId}/${observation.refId}: ${observation.freshness.status}`}${message === undefined ? "" : ` — ${message}`}`,
    );
  };
  let observation: IndexWatchObservation | undefined;
  try {
    while (true) {
      ctx.signal.throwIfAborted();
      observation = await deps.inspect(ctx, options);
      ctx.signal.throwIfAborted();
      emit("checked", observation);
      if (observation.freshness.status !== "fresh") {
        emit("refresh_started", observation);
        await observation.refresh();
        ctx.signal.throwIfAborted();
        refreshes++;
        observation = await deps.inspect(ctx, options);
        ctx.signal.throwIfAborted();
        emit("refreshed", observation);
        if (
          observation.freshness.status === "unknown" ||
          observation.freshness.status === "incompatible"
        ) {
          throw new EnvironmentError(
            "Could not confirm a compatible search index after the update.",
            "Check `untangle doctor` and the index report on stderr.",
          );
        }
      }
      if (options.once || (options.maxRefreshes !== null && refreshes >= options.maxRefreshes)) {
        if (observation.freshness.status !== "fresh") {
          throw new EnvironmentError(
            "Sources changed again during indexing; the search index is still stale.",
            "Keep watch --index running without --baseline-only/--exit-after, or repeat the update.",
          );
        }
        emit("stopped", observation, "The requested number of checks/updates has been reached.");
        return EXIT.ok;
      }
      await deps.wait(options.intervalMs, ctx.signal);
    }
  } catch (error) {
    if (ctx.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      emit("stopped", observation, "Cancelled; any running indexing job was stopped cleanly.");
      return EXIT.cancelled;
    }
    emit("failed", observation, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await sink.close();
  }
}

/** Uses the same registry, scanner freshness check and refresh composition as query --refresh. */
export async function inspectIndexWatch(
  ctx: CommandContext,
  options: IndexWatchOptions,
): Promise<IndexWatchObservation> {
  const view = loadWorkspace({ cwd: options.root, env: ctx.env, strict: true });
  if (options.repo !== undefined && (view.config.repositories ?? []).length === 0) {
    throw new UsageError(
      "--repo requires a configured repository.",
      "Select the project tree with --root.",
    );
  }
  const target = resolveTarget({
    config: view.config,
    cwd: options.root,
    rootFlag: options.root,
    repoFlag: options.repo,
    refFlag: options.ref,
    configBaseDir: view.load.sources.configBaseDir,
  });
  if (detectRefName(target.rootPath) !== target.refName) {
    throw new UsageError(
      `Ref ${target.refName} is not checked out in ${target.rootPath}.`,
      "Switch to the matching worktree before watching the search index.",
    );
  }
  const resolution = await resolveIndexState([target.rootPath], view.workspaceId, {
    repoIds: [target.repoId],
    refs: [target.refId],
    ...storageIndexScope(wireStorage(view, ctx.env)),
  });
  ctx.signal.throwIfAborted();
  if (resolution.kind === "invalid") {
    throw new EnvironmentError(
      `The local index state is invalid: ${resolution.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`,
      "Rerun the affected indexing job before starting watch --index.",
    );
  }
  if (resolution.kind === "ambiguous" && options.embedder === "auto") {
    throw new UsageError(
      "Current index profiles conflict.",
      "Select --embedder=offline or repair the index registry.",
    );
  }
  const current =
    resolution.kind === "resolved"
      ? resolution.current
      : resolution.kind === "ambiguous"
        ? resolution.found
        : [];
  const states =
    options.embedder === "offline"
      ? current.filter((entry) => entry.state.embedder === "offline")
      : current;
  const embedder =
    options.embedder === "offline" ||
    (resolution.kind === "resolved" && resolution.embedder === "offline")
      ? "offline"
      : "auto";
  const freshness = await inspectIndexFreshness(view, states, { signal: ctx.signal });
  return {
    workspaceId: view.workspaceId,
    repoId: target.repoId,
    refId: target.refId,
    freshness,
    refresh: () =>
      refreshWorkspaceIndex(ctx, {
        view,
        ...(target.synthesized ? {} : { repoIds: [target.repoId] }),
        refIds: [target.refName],
        embedder,
      }),
  };
}
