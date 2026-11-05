/**
 * Reconciliation (spec.md §12.1, §12.3): compares path, size, mtime and
 * content hash against the watcher's own last-known snapshot per file —
 * but ONLY the content hash may decide the final unchanged/changed verdict
 * ("Nur der Content Hash darf den endgültigen Unchanged-Status bestimmen").
 *
 * `evaluatePath` therefore always re-hashes on reconciliation, never
 * short-circuits on a matching size/mtime — a file whose size and mtime are
 * byte-for-byte identical to the snapshot but whose content hash differs
 * (e.g. a filesystem/clock granularity artefact, or an edit that happens to
 * preserve length) is still reported "modified". Cheaper mtime-based
 * short-circuiting is a legitimate future optimization but would directly
 * contradict this spec sentence, so it is deliberately not implemented
 * (see README "Bekannte Grenzen").
 */
import type { FileSystemPort, PortCallOptions } from "@untangle-code/domain";

import { joinRelative } from "./paths.js";
import type {
  ContentHasher,
  IgnorePredicate,
  WatchedFileSnapshotV1,
  WatcherEventV1,
} from "./types.js";

export interface EvaluatePathParams {
  fs: FileSystemPort;
  hasher: ContentHasher;
  rootPath: string;
  relativePath: string;
  /** Mutated in place: the caller's long-lived snapshot map. */
  snapshots: Map<string, WatchedFileSnapshotV1>;
  options?: PortCallOptions;
}

/**
 * Evaluates ONE path against the current snapshot map, updating the map and
 * returning the resulting event — or `null` when nothing changed (verdict
 * decided by content hash alone, see module doc).
 */
export async function evaluatePath(params: EvaluatePathParams): Promise<WatcherEventV1 | null> {
  const { fs, hasher, rootPath, relativePath, snapshots, options } = params;
  const absolutePath = joinRelative(rootPath, relativePath);
  const stat = await fs.stat(absolutePath, options);
  const previous = snapshots.get(relativePath);

  if (!stat || stat.kind !== "file") {
    if (previous) {
      snapshots.delete(relativePath);
      return { changeKind: "deleted", relativePath };
    }
    return null;
  }

  const contentHash = await hasher(fs, absolutePath, options);
  const nextSnapshot: WatchedFileSnapshotV1 = {
    relativePath,
    sizeBytes: stat.sizeBytes,
    mtimeEpochMs: stat.mtimeEpochMs,
    contentHash,
  };

  if (previous && previous.contentHash === contentHash) {
    // Unchanged by the one rule that is allowed to decide that — but keep
    // size/mtime fresh in case they drifted without the content doing so
    // (e.g. a rewrite of byte-identical content).
    snapshots.set(relativePath, nextSnapshot);
    return null;
  }

  snapshots.set(relativePath, nextSnapshot);
  return {
    changeKind: previous ? "modified" : "added",
    relativePath,
    sizeBytes: stat.sizeBytes,
    mtimeEpochMs: stat.mtimeEpochMs,
    contentHash,
  };
}

export interface ReconcileTreeParams {
  fs: FileSystemPort;
  hasher: ContentHasher;
  rootPath: string;
  snapshots: Map<string, WatchedFileSnapshotV1>;
  ignore: IgnorePredicate;
  options?: PortCallOptions;
}

/**
 * Full-tree reconciliation pass: walks `rootPath` via `FileSystemPort`
 * (never `node:fs` directly), re-evaluates every non-ignored file found
 * against `snapshots` (add/modify), and reports as `"deleted"` every
 * snapshot entry no longer found on disk. Respects `options.signal`,
 * rejecting with `JOB_CANCELLED` (via `fs.stat`/`readDir`'s own abort
 * handling, propagated unchanged) between steps (spec.md §22).
 *
 * Deliberately NOT a full `@untangle-code/scanner`-grade walk: no
 * `.gitignore`/`.untangleignore` layering, only the caller-supplied
 * `ignore` predicate plus a built-in `.git` exclusion (see
 * `RepoWatcher.isIgnored`). Depending on `scanner` for that is out of this
 * package's assigned dependency set (see README "Entscheidungen") — a
 * caller wiring a real indexing pipeline is expected to pass an `ignore`
 * backed by scanner's own `IgnoreEngine`.
 *
 * Symlink cycle safety: every directory's `realPath()` is recorded in
 * `visitedRealDirs`; a second directory resolving to an already-visited
 * real path is skipped rather than walked again (same purpose as
 * scanner's own `visitedRealDirs`, reimplemented locally here — see
 * `content-hash.ts` for why this package does not depend on scanner).
 */
export async function reconcileTree(params: ReconcileTreeParams): Promise<WatcherEventV1[]> {
  const { fs, hasher, rootPath, snapshots, ignore, options } = params;
  const seen = new Set<string>();
  const events: WatcherEventV1[] = [];
  const visitedRealDirs = new Set<string>();

  async function walk(relativeDir: string): Promise<void> {
    options?.signal?.throwIfAborted();
    const absoluteDir = relativeDir === "" ? rootPath : joinRelative(rootPath, relativeDir);

    let realDir: string;
    try {
      realDir = await fs.realPath(absoluteDir, options);
    } catch {
      // Directory vanished (or became unreadable) between discovery and
      // this walk step — treated as "nothing here right now", not a hard
      // failure; a later reconciliation pass will pick up whatever
      // replaces it, and any snapshot entries under it are still reported
      // deleted below via the final `seen`-set sweep.
      return;
    }
    if (visitedRealDirs.has(realDir)) {
      return;
    }
    visitedRealDirs.add(realDir);

    const entries = await fs.readDir(absoluteDir, options);
    for (const entry of entries) {
      options?.signal?.throwIfAborted();
      const entryRelativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (ignore(entryRelativePath)) {
        continue;
      }
      const stat = await fs.stat(entry.path, options);
      if (!stat) {
        continue;
      }
      if (stat.kind === "directory") {
        await walk(entryRelativePath);
        continue;
      }
      if (stat.kind !== "file") {
        continue;
      }
      seen.add(entryRelativePath);
      const event = await evaluatePath({
        fs,
        hasher,
        rootPath,
        relativePath: entryRelativePath,
        snapshots,
        ...(options !== undefined ? { options } : {}),
      });
      if (event) {
        events.push(event);
      }
    }
  }

  await walk("");

  for (const relativePath of [...snapshots.keys()]) {
    if (!seen.has(relativePath)) {
      snapshots.delete(relativePath);
      events.push({ changeKind: "deleted", relativePath });
    }
  }

  return events;
}
