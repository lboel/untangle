/**
 * @untangle-code/watcher — native recursive filesystem watching with
 * debounce/coalescing, periodic reconciliation and cross-process ref
 * locking (spec.md §12.1, §12.3; architecture.md §21.1).
 *
 * `RepoWatcher` is the package's single orchestrator; everything else here
 * is either a swappable seam (`NativeWatcherPort`, `SchedulerPort`,
 * `ContentHasher`) or a standalone building block it composes
 * (`PathDebouncer`, `reconcileTree`/`evaluatePath`). This module is the
 * ONLY public export of the package — see README "Architektur".
 */

// Watcher-local contracts.
export * from "./types.js";

// Path helpers (useful for callers building an `ignore` predicate).
export { isDotGitPath, joinRelative, normalizeRelativePath } from "./paths.js";

// Content-hash pipeline (spec.md §12.1).
export { defaultContentHasher, hashBytes } from "./content-hash.js";

// Production adapters.
export { NodeScheduler } from "./scheduler.js";
export { NodeNativeWatcher } from "./native-watcher.js";

// Default no-op logger (used when `RepoWatcherOptions.logger` is omitted).
export { noopLogger } from "./noop-logger.js";

// Debounce/coalescing (spec.md §12.3).
export { PathDebouncer, type PathDebouncerOptions } from "./debouncer.js";

// Reconciliation (spec.md §12.1, §12.3).
export {
  evaluatePath,
  reconcileTree,
  type EvaluatePathParams,
  type ReconcileTreeParams,
} from "./reconciler.js";

// The orchestrator (spec.md §12.1, §12.3; architecture.md §21.1).
export { RepoWatcher, buildWatchLockKey, type RepoWatcherOptions } from "./watcher.js";
