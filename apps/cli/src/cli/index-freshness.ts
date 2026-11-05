import {
  buildCorpusRevisionFingerprint,
  buildFileId,
  buildRefId,
  canonicalJson,
  CHUNKER_VERSION,
  LEXICAL_TOKENIZER_VERSION,
  normalizeRelativePath,
  knownParserLanguages,
  parserVersionForLanguage,
  sha256Hex,
  type IndexFreshnessV1,
  type PortCallOptions,
} from "@untangle-code/domain";
import { discoverFiles } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import { detectRefName, resolveTarget, type ResolvedTarget } from "../commands/index/target.js";

import type { FoundIndexState, IndexStateV1 } from "./index-state.js";
import type { WorkspaceView } from "./workspace.js";

type RepositoryFreshness = IndexFreshnessV1["repositories"][number];
type FreshnessOptions = PortCallOptions & {
  expectedRepoIds?: readonly string[];
  expectedRefs?: readonly string[];
};

/** Bind source selection and chunk semantics; operational concurrency does not change the corpus. */
export function indexConfigFingerprint(view: WorkspaceView, target: ResolvedTarget): string {
  return sha256Hex(
    canonicalJson({
      chunkerVersion: CHUNKER_VERSION,
      parserVersions: knownParserLanguages().map((language) => [
        language,
        parserVersionForLanguage(language),
      ]),
      maxFileSizeMb: view.config.index.maxFileSizeMb,
      maxChunkTokens: view.config.index.maxChunkTokens,
      include: target.include ?? [],
      exclude: target.exclude ?? [],
    }),
  );
}

export async function inspectIndexFreshness(
  view: WorkspaceView,
  states: readonly FoundIndexState[],
  options: FreshnessOptions = {},
): Promise<IndexFreshnessV1> {
  const repositories: RepositoryFreshness[] = [];
  for (const found of states) {
    options.signal?.throwIfAborted();
    repositories.push(await inspectRepositoryFreshness(view, found, options));
  }
  appendMissingSnapshots(view, states, repositories, options);
  return {
    status: aggregateFreshnessStatus(repositories),
    checkedAt: new Date().toISOString(),
    repositories,
  };
}

async function inspectRepositoryFreshness(
  view: WorkspaceView,
  found: FoundIndexState,
  options: PortCallOptions,
): Promise<RepositoryFreshness> {
  const entry = snapshotFreshness(found.state);
  if (!hasCompleteSnapshotMetadata(found.state, entry)) return entry;
  const target = resolveFreshnessTarget(view, found, entry, options);
  if (target !== null) await scanContentManifest(view, found.state, target, entry, options);
  return entry;
}

/** Keep persisted evidence visible even when it cannot establish freshness. */
function snapshotFreshness(state: IndexStateV1): RepositoryFreshness {
  return {
    repoId: state.repoId,
    refId: state.refId,
    status: "unknown",
    reason: "snapshot_metadata_missing",
    filesChecked: 0,
    ...(state.indexedAt === undefined ? {} : { indexedAt: state.indexedAt }),
    ...(state.corpusRevisionFingerprint === undefined
      ? {}
      : { indexedCorpusFingerprint: state.corpusRevisionFingerprint }),
  };
}

function hasCompleteSnapshotMetadata(state: IndexStateV1, entry: RepositoryFreshness): boolean {
  if (state.lexicalTokenizerVersion !== LEXICAL_TOKENIZER_VERSION) {
    entry.status = "incompatible";
    entry.reason = "lexical_tokenizer_changed";
    return false;
  }
  if (state.outcome !== "completed") {
    entry.status = "stale";
    entry.reason = "index_incomplete";
    return false;
  }
  return (
    state.corpusRevisionFingerprint !== undefined &&
    state.indexConfigFingerprint !== undefined &&
    state.indexedAt !== undefined
  );
}

/** Historical refs and changed source-selection rules need different diagnoses. */
function resolveFreshnessTarget(
  view: WorkspaceView,
  found: FoundIndexState,
  entry: RepositoryFreshness,
  options: PortCallOptions,
): ResolvedTarget | null {
  const state = found.state;
  let target: ResolvedTarget;
  try {
    target = resolveTarget({
      config: view.config,
      cwd: found.repoRoot,
      rootFlag: found.repoRoot,
      repoFlag: (view.config.repositories ?? []).length === 0 ? undefined : state.repoId,
      refFlag: state.refName,
      configBaseDir: view.load.sources.configBaseDir,
    });
  } catch {
    options.signal?.throwIfAborted();
    entry.reason = "repository_unavailable";
    return null;
  }
  if (target.rootPath !== found.repoRoot || detectRefName(target.rootPath) !== state.refName) {
    entry.reason = "ref_not_checked_out";
    return null;
  }
  if (indexConfigFingerprint(view, target) !== state.indexConfigFingerprint) {
    entry.status = "stale";
    entry.reason = "index_configuration_changed";
    return null;
  }
  return target;
}

/** Compare the same full file/content manifest recorded by completed index discovery. */
async function scanContentManifest(
  view: WorkspaceView,
  state: IndexStateV1,
  target: ResolvedTarget,
  entry: RepositoryFreshness,
  options: PortCallOptions,
): Promise<void> {
  const hashes: Record<string, string> = {};
  let unreadable = false;
  try {
    for await (const file of discoverFiles({
      fs: new NodeFileSystem(),
      roots: [target.rootPath],
      repoRoot: target.rootPath,
      maxFileSizeBytes: view.config.index.maxFileSizeMb * 1024 * 1024,
      concurrency: view.config.index.scanConcurrency,
      ignore: {
        ...(target.include === undefined ? {} : { configInclude: target.include }),
        ...(target.exclude === undefined ? {} : { configExclude: target.exclude }),
      },
      onSkip: (skip) => {
        if (skip.reason === "unreadable") unreadable = true;
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      options.signal?.throwIfAborted();
      const fileId = buildFileId({
        workspaceId: state.workspaceId,
        repoId: state.repoId,
        refId: state.refId,
        relativePath: normalizeRelativePath(file.relativePath),
      });
      hashes[fileId] = file.contentHash;
      entry.filesChecked++;
    }
    if (unreadable) {
      entry.reason = "source_scan_incomplete";
      return;
    }
    entry.currentCorpusFingerprint = buildCorpusRevisionFingerprint(hashes);
    entry.status =
      entry.currentCorpusFingerprint === state.corpusRevisionFingerprint ? "fresh" : "stale";
    entry.reason = entry.status === "fresh" ? "content_hashes_match" : "sources_changed";
  } catch {
    options.signal?.throwIfAborted();
    entry.reason = "source_scan_incomplete";
  }
}

/** Missing selected records must not disappear from the aggregate. */
function appendMissingSnapshots(
  view: WorkspaceView,
  states: readonly FoundIndexState[],
  repositories: RepositoryFreshness[],
  options: FreshnessOptions,
): void {
  if (options.expectedRepoIds === undefined) return;
  const expectedRepos = expectedRepositoryIds(view, options.expectedRepoIds);
  if (options.expectedRefs?.length) {
    appendMissingRefSnapshots(
      view,
      states,
      repositories,
      expectedRepos,
      options.expectedRefs,
      options,
    );
    return;
  }
  for (const repoId of expectedRepos) {
    if (!states.some(({ state }) => state.repoId === repoId)) {
      repositories.push(missingSnapshot(view, repoId, undefined, options));
    }
  }
}

function expectedRepositoryIds(view: WorkspaceView, repoIds: readonly string[]): readonly string[] {
  if (repoIds.length > 0) return repoIds;
  return [
    resolveTarget({
      config: view.config,
      cwd: view.root,
      rootFlag: view.root,
      repoFlag: undefined,
      refFlag: undefined,
      configBaseDir: view.load.sources.configBaseDir,
    }).repoId,
  ];
}

/** Named refs cover every selected repository; canonical refs retain their repo qualification. */
function appendMissingRefSnapshots(
  view: WorkspaceView,
  states: readonly FoundIndexState[],
  repositories: RepositoryFreshness[],
  expectedRepos: readonly string[],
  expectedRefs: readonly string[],
  options: PortCallOptions,
): void {
  for (const ref of expectedRefs) {
    const matchingRepos = ref.includes(":")
      ? expectedRepos.filter((repoId) => ref.startsWith(`${repoId}:`))
      : expectedRepos;
    if (matchingRepos.length === 0) {
      repositories.push(missingSnapshot(view, expectedRepos[0] ?? "unknown", ref, options));
      continue;
    }
    for (const repoId of matchingRepos) {
      if (
        !states.some(
          ({ state }) => state.repoId === repoId && (state.refId === ref || state.refName === ref),
        )
      ) {
        repositories.push(missingSnapshot(view, repoId, ref, options));
      }
    }
  }
}

function missingSnapshot(
  view: WorkspaceView,
  repoId: string,
  ref: string | undefined,
  options: PortCallOptions,
): RepositoryFreshness {
  let refId = ref?.includes(":") ? ref : buildRefId(repoId, ref ?? "unknown");
  if (ref === undefined) {
    try {
      refId = resolveTarget({
        config: view.config,
        cwd: view.root,
        rootFlag: view.root,
        repoFlag: (view.config.repositories ?? []).length === 0 ? undefined : repoId,
        refFlag: undefined,
        configBaseDir: view.load.sources.configBaseDir,
      }).refId;
    } catch {
      options.signal?.throwIfAborted();
      /* Missing configuration remains unverified. */
    }
  }
  return {
    repoId,
    refId,
    status: "unknown",
    reason: "index_snapshot_missing",
    filesChecked: 0,
  };
}

function aggregateFreshnessStatus(
  repositories: readonly RepositoryFreshness[],
): IndexFreshnessV1["status"] {
  if (repositories.length === 0) return "unknown";
  for (const status of ["incompatible", "stale", "unknown"] as const) {
    if (repositories.some((entry) => entry.status === status)) return status;
  }
  return "fresh";
}
