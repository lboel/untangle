/**
 * Watcher-local contracts (spec.md §12.1, §12.3; architecture.md §21.1).
 *
 * None of these are domain ports — `NativeWatcherPort` and `SchedulerPort`
 * are infrastructure seams private to this package (fixed here the same way
 * `@untangle-code/scanner` fixes `ScannedFileV1` locally, see that
 * package's README "Entscheidungen" 1), so tests can swap in fakes without
 * touching `packages/domain`.
 */
import type { FileSystemPort, PortCallOptions, UntangleError } from "@untangle-code/domain";

// ---------------------------------------------------------------------------
// Native watcher backend (wraps `node:fs/promises` `watch(..., {recursive:true})`)
// ---------------------------------------------------------------------------

/** One raw change notification from the native backend. */
export interface NativeChangeEventV1 {
  eventType: "rename" | "change";
  /**
   * "/"-normalized path relative to the watched root. `null` when the
   * backend cannot name the changed entry (some platforms omit `filename`
   * for certain event kinds) — callers fall back to a full reconciliation
   * pass rather than guessing (spec.md §12.3).
   */
  relativePath: string | null;
}

/**
 * Thin seam over the native recursive watcher. The only implementation that
 * matters in production is {@link NodeNativeWatcher} (`node:fs/promises`
 * `watch(rootPath, {recursive:true})`); tests inject
 * `FakeNativeWatcher` (`src/testing/fake-native-watcher.ts`) instead.
 */
export interface NativeWatcherPort {
  /**
   * Async-iterates change events for `rootPath` until the iterable ends or
   * `options.signal` aborts. A thrown/rejected iteration is the backend
   * reporting failure — callers (here: `RepoWatcher`) are responsible for
   * isolating it (spec.md §12.3: a watcher error must never bring down the
   * process).
   */
  watch(rootPath: string, options?: { signal?: AbortSignal }): AsyncIterable<NativeChangeEventV1>;
}

// ---------------------------------------------------------------------------
// Scheduler (wraps `setTimeout`/`setInterval`)
// ---------------------------------------------------------------------------

export interface TimerHandle {
  clear(): void;
}

/**
 * Timer seam, analogous to `NativeWatcherPort` — production code gets
 * {@link NodeScheduler}, tests get `FakeScheduler`
 * (`src/testing/fake-scheduler.ts`), which advances a shared `FakeClock` so
 * debounce/reconciliation timing is fully deterministic under test (no real
 * `setTimeout` waits, see README "Entscheidungen").
 */
export interface SchedulerPort {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Hashes one file's current content through `FileSystemPort` (never
 * `node:fs` directly — keeps this package's core testable against any port
 * implementation, e.g. testkit's `MemoryFileSystem`).
 */
export type ContentHasher = (
  fs: FileSystemPort,
  absolutePath: string,
  options?: PortCallOptions,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Reconciliation snapshot (spec.md §12.1) — NOT `FileManifestV1`
// ---------------------------------------------------------------------------

/**
 * The watcher's own per-file bookkeeping for change detection. Deliberately
 * not domain's `FileManifestV1`: that contract carries post-analysis fields
 * (`chunkIds`, `parserVersion`, …) the watcher never has and has no `mtime`
 * field at all, while spec.md §12.1 requires comparing against path, size
 * AND mtime here (content hash remains the sole authority for the final
 * unchanged/changed verdict — see `reconcileTree`'s doc comment).
 */
export interface WatchedFileSnapshotV1 {
  relativePath: string;
  sizeBytes: number;
  mtimeEpochMs: number;
  contentHash: string;
}

/** One detected change, emitted to `RepoWatcher.onChange` subscribers. */
export type WatcherEventV1 =
  | {
      changeKind: "added" | "modified";
      relativePath: string;
      sizeBytes: number;
      mtimeEpochMs: number;
      contentHash: string;
    }
  | { changeKind: "deleted"; relativePath: string };

export type WatcherStatus = "starting" | "running" | "degraded" | "stopped";

export interface WatcherStatusEventV1 {
  status: WatcherStatus;
  /** Present when the transition (typically into `"degraded"`) was caused by an error. */
  error?: UntangleError;
}

export type WatcherChangeHandler = (events: WatcherEventV1[]) => void | Promise<void>;
export type WatcherStatusHandler = (event: WatcherStatusEventV1) => void;

/** Predicate deciding whether a "/"-normalized relative path is out of scope for this watcher. */
export type IgnorePredicate = (relativePath: string) => boolean;
