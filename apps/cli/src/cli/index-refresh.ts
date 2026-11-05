import { buildRefId } from "@untangle-code/domain";

import { indexCommand } from "../commands/index/index.js";
import { detectRefName, resolveTarget, type ResolvedTarget } from "../commands/index/target.js";

import type { CommandContext } from "./command.js";
import { EXIT, EnvironmentError, UsageError } from "./exit.js";
import type { WorkspaceView } from "./workspace.js";

/** Rebuild only selected, physically checked-out refs; route progress away from query JSON. */
export async function refreshWorkspaceIndex(
  ctx: CommandContext,
  options: {
    view: WorkspaceView;
    repoIds?: readonly string[];
    refIds?: readonly string[];
    embedder: "auto" | "offline";
  },
): Promise<void> {
  const { view } = options;
  const configured = view.config.repositories ?? [];
  const targets = preflightRefreshTargets(view, options.repoIds, options.refIds);
  for (const target of targets) {
    ctx.signal.throwIfAborted();
    const exit = await indexCommand.run(
      { ...ctx, io: { out: (chunk) => ctx.io.err(chunk), err: (chunk) => ctx.io.err(chunk) } },
      {
        positionals: [],
        flags: {
          root: configured.length === 0 ? target.rootPath : view.root,
          ...(configured.length === 0 ? {} : { repo: target.repoId }),
          ref: target.refName,
          embedder: options.embedder,
          format: "json",
          resume: false,
        },
      },
    );
    ctx.signal.throwIfAborted();
    if (exit !== EXIT.ok)
      throw new EnvironmentError(
        "The search index could not be fully refreshed.",
        "Check the index report on stderr and run `untangle doctor`.",
      );
  }
}

/** Resolve and validate the complete requested scope before the first mutation. */
function preflightRefreshTargets(
  view: WorkspaceView,
  selectedRepoIds: readonly string[] | undefined,
  selectedRefIds: readonly string[] | undefined,
): ResolvedTarget[] {
  const configured = view.config.repositories ?? [];
  const repoIds = selectedRepoIds?.length
    ? [...new Set(selectedRepoIds)]
    : configured.map((repo) => repo.id);
  const requestedRefs = new Set(selectedRefIds ?? []);
  const availableTargets = (repoIds.length ? repoIds : [undefined]).map((repoId) =>
    resolveRefreshTarget(view, repoId, requestedRefs.size > 0),
  );
  const unavailableRefs = [...requestedRefs].flatMap((ref) =>
    ref.includes(":")
      ? availableTargets.some((target) => target.refId === ref)
        ? []
        : [ref]
      : availableTargets
          .filter((target) => target.refName !== ref)
          .map((target) => buildRefId(target.repoId, ref)),
  );
  if (unavailableRefs.length > 0)
    throw new UsageError(
      `Selected refs are not checked out here: ${unavailableRefs.join(", ")}.`,
      "Switch to matching worktrees or select only refs checked out here.",
    );
  const targets = availableTargets.filter(
    (target) =>
      requestedRefs.size === 0 ||
      requestedRefs.has(target.refId) ||
      requestedRefs.has(target.refName),
  );
  if (targets.length === 0)
    throw new UsageError(
      "None of the selected refs is checked out here.",
      "Switch to the matching worktree and run `untangle index` there.",
    );
  for (const target of targets) {
    if (detectRefName(target.rootPath) !== target.refName)
      throw new UsageError(
        `Ref ${target.refName} is not checked out in ${target.rootPath}.`,
        "Switch to the matching worktree before refreshing its index.",
      );
  }
  return targets;
}

/** Explicit ref selection follows the physical checkout rather than a configured default. */
function resolveRefreshTarget(
  view: WorkspaceView,
  repoId: string | undefined,
  hasExplicitRefs: boolean,
): ResolvedTarget {
  const input = {
    config: view.config,
    cwd: view.root,
    rootFlag: view.root,
    repoFlag: repoId,
    refFlag: undefined,
    configBaseDir: view.load.sources.configBaseDir,
  };
  const configuredTarget = resolveTarget(input);
  if (
    (view.config.repositories ?? []).length === 0 &&
    repoId !== undefined &&
    repoId !== configuredTarget.repoId
  ) {
    throw new UsageError(
      `Repository ${repoId} is absent from this project.`,
      "Select the index by its actual repository ID or omit --repo.",
    );
  }
  return hasExplicitRefs
    ? resolveTarget({ ...input, refFlag: detectRefName(configuredTarget.rootPath) })
    : configuredTarget;
}
