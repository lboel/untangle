/**
 * In-memory `GitPort` (architecture.md §2.1, §19.1) — no real git binary, no
 * real repository on disk. Multiple repositories live in one instance, each
 * addressed by its `repoPath` (an opaque string key here — a real path in
 * production, any label a test likes here).
 *
 * Commit identity is a pure hash of its content (`sha256Hex` of the
 * canonical-JSON of parents + sorted file entries + message), never
 * `Math.random()` — so a commit built from the same inputs always gets the
 * same sha, in any process (BUILD_PLAN global determinism rule).
 *
 * Decisions (see README "Entscheidungen"):
 * - `resolveCommit` maps `{ kind: "working_tree" }` and `{ kind: "index" }`
 *   to the current branch's HEAD commit — both sit "on top of" HEAD, and a
 *   fake with no literal working directory has nothing more specific to
 *   report;
 * - `{ kind: "generation" }` resolves only through an explicit
 *   `registerGeneration()` call — Untangle's own indexing generations are
 *   not a git concept, so a real git adapter could not resolve one either;
 * - `listChangedFiles` reports a simple, deterministic rename heuristic: a
 *   deleted path and an added path with byte-identical content are reported
 *   as one `renamed` change with `similarity: 1` — good enough for the
 *   rename fixtures this package builds, not a content-similarity algorithm.
 */
import type { FileChangeV1, GitPort, PortCallOptions, Revision } from "@untangle-code/domain";
import { canonicalJson, sha256Hex } from "@untangle-code/domain";

interface FakeCommit {
  sha: string;
  parentShas: string[];
  message: string;
  /** "/"-normalized repo-relative path → file content. */
  files: Map<string, Uint8Array>;
}

interface RepoState {
  commits: Map<string, FakeCommit>;
  branches: Map<string, string>;
  currentBranchName: string | null;
  generations: Map<string, string>;
  remotes: string[];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function computeCommitSha(
  parentShas: string[],
  files: Map<string, Uint8Array>,
  message: string,
): string {
  const sortedEntries = [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => [path, Buffer.from(content).toString("base64")] as const);
  return sha256Hex(
    canonicalJson({ parentShas: [...parentShas].sort(), files: sortedEntries, message }),
  );
}

export class FakeGitProvider implements GitPort {
  private readonly repos = new Map<string, RepoState>();

  private repoState(repoPath: string): RepoState | undefined {
    return this.repos.get(repoPath);
  }

  private requireRepo(repoPath: string): RepoState {
    const state = this.repos.get(repoPath);
    if (!state) {
      throw new Error(`FakeGitProvider: "${repoPath}" is not a registered repository`);
    }
    return state;
  }

  // -- test-setup helpers (not part of GitPort) ----------------------------

  /** Registers an (initially empty, branch-less) repository at `repoPath`. */
  public initRepository(repoPath: string, remotes: string[] = []): void {
    this.repos.set(repoPath, {
      commits: new Map(),
      branches: new Map(),
      currentBranchName: null,
      generations: new Map(),
      remotes: [...remotes],
    });
  }

  /**
   * Creates a commit from a full file snapshot (not a diff) and advances
   * `branch` to it. `parents` default to the branch's current HEAD (a
   * normal, single-parent commit); pass an empty array explicitly for a
   * root commit. Returns the new commit's sha.
   */
  public commit(
    repoPath: string,
    branch: string,
    files: Record<string, string | Uint8Array>,
    options: { message?: string; parents?: string[] } = {},
  ): string {
    const state = this.requireRepo(repoPath);
    const fileMap = new Map<string, Uint8Array>();
    for (const [path, content] of Object.entries(files)) {
      fileMap.set(
        normalizePath(path),
        typeof content === "string" ? new TextEncoder().encode(content) : content,
      );
    }
    const parentShas =
      options.parents ?? (state.branches.has(branch) ? [state.branches.get(branch) as string] : []);
    const message = options.message ?? `commit on ${branch}`;
    const sha = computeCommitSha(parentShas, fileMap, message);
    state.commits.set(sha, { sha, parentShas, message, files: fileMap });
    state.branches.set(branch, sha);
    if (state.currentBranchName === null) {
      state.currentBranchName = branch;
    }
    return sha;
  }

  /** Checks out `branch` as the current branch (must already have a commit). */
  public checkout(repoPath: string, branch: string): void {
    const state = this.requireRepo(repoPath);
    if (!state.branches.has(branch)) {
      throw new Error(`FakeGitProvider: branch "${branch}" does not exist in "${repoPath}"`);
    }
    state.currentBranchName = branch;
  }

  /** Associates an Untangle indexing `generationId` with a resolvable commit sha. */
  public registerGeneration(repoPath: string, generationId: string, sha: string): void {
    this.requireRepo(repoPath).generations.set(generationId, sha);
  }

  // -- internal lookups -----------------------------------------------------

  private filesAt(repoPath: string, revision: Revision): Map<string, Uint8Array> | null {
    const state = this.repoState(repoPath);
    if (!state) {
      return null;
    }
    const sha = this.resolveShaSync(state, revision);
    if (sha === null) {
      return null;
    }
    return state.commits.get(sha)?.files ?? null;
  }

  private resolveShaSync(state: RepoState, revision: Revision): string | null {
    switch (revision.kind) {
      case "commit":
        return state.commits.has(revision.sha) ? revision.sha : null;
      case "ref":
        return state.branches.get(revision.name) ?? null;
      case "working_tree":
      case "index": {
        if (state.currentBranchName === null) {
          return null;
        }
        return state.branches.get(state.currentBranchName) ?? null;
      }
      case "generation":
        return state.generations.get(revision.generationId) ?? null;
      default:
        return null;
    }
  }

  // -- GitPort ----------------------------------------------------------------

  public async isRepository(repoPath: string, options?: PortCallOptions): Promise<boolean> {
    options?.signal?.throwIfAborted();
    return this.repos.has(repoPath);
  }

  public async resolveCommit(
    repoPath: string,
    revision: Revision,
    options?: PortCallOptions,
  ): Promise<string | null> {
    options?.signal?.throwIfAborted();
    const state = this.repoState(repoPath);
    if (!state) {
      return null;
    }
    return this.resolveShaSync(state, revision);
  }

  public async currentBranch(repoPath: string, options?: PortCallOptions): Promise<string | null> {
    options?.signal?.throwIfAborted();
    return this.repoState(repoPath)?.currentBranchName ?? null;
  }

  public async listChangedFiles(
    repoPath: string,
    base: Revision,
    head: Revision,
    options?: PortCallOptions,
  ): Promise<FileChangeV1[]> {
    options?.signal?.throwIfAborted();
    const baseFiles = this.filesAt(repoPath, base) ?? new Map<string, Uint8Array>();
    const headFiles = this.filesAt(repoPath, head) ?? new Map<string, Uint8Array>();

    const addedPaths: string[] = [];
    const deletedPaths: string[] = [];
    const modifiedPaths: string[] = [];
    const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of allPaths) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (inBase === undefined && inHead !== undefined) {
        addedPaths.push(path);
      } else if (inBase !== undefined && inHead === undefined) {
        deletedPaths.push(path);
      } else if (inBase !== undefined && inHead !== undefined && !bytesEqual(inBase, inHead)) {
        modifiedPaths.push(path);
      }
    }

    const changes: FileChangeV1[] = [];
    const consumedAdded = new Set<string>();
    for (const deletedPath of deletedPaths) {
      const deletedContent = baseFiles.get(deletedPath) as Uint8Array;
      const renameTarget = addedPaths.find(
        (addedPath) =>
          !consumedAdded.has(addedPath) &&
          bytesEqual(deletedContent, headFiles.get(addedPath) as Uint8Array),
      );
      if (renameTarget !== undefined) {
        consumedAdded.add(renameTarget);
        changes.push({
          changeKind: "renamed",
          oldPath: deletedPath,
          newPath: renameTarget,
          similarity: 1,
        });
      } else {
        changes.push({ changeKind: "deleted", oldPath: deletedPath });
      }
    }
    for (const addedPath of addedPaths) {
      if (!consumedAdded.has(addedPath)) {
        changes.push({ changeKind: "added", newPath: addedPath });
      }
    }
    for (const modifiedPath of modifiedPaths) {
      changes.push({ changeKind: "modified", oldPath: modifiedPath, newPath: modifiedPath });
    }
    return changes;
  }

  public async readFileAtRevision(
    repoPath: string,
    revision: Revision,
    relativePath: string,
    options?: PortCallOptions,
  ): Promise<Uint8Array | null> {
    options?.signal?.throwIfAborted();
    const files = this.filesAt(repoPath, revision);
    return files?.get(normalizePath(relativePath))?.slice() ?? null;
  }

  public async listTrackedFiles(
    repoPath: string,
    revision: Revision,
    options?: PortCallOptions,
  ): Promise<string[]> {
    options?.signal?.throwIfAborted();
    const files = this.filesAt(repoPath, revision);
    return files ? [...files.keys()].sort() : [];
  }

  public async remoteUrls(repoPath: string, options?: PortCallOptions): Promise<string[]> {
    options?.signal?.throwIfAborted();
    return this.repoState(repoPath)?.remotes ?? [];
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
