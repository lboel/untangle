/**
 * Error wrapping for this package (architecture.md §22.1, spec.md §25.1).
 *
 * `ERROR_CODES` (spec.md §25.1) has no dedicated "watcher backend/reconcile
 * failed" code, and adding one is out of scope here — `packages/domain` is
 * not among this package's assigned paths, and the fixed error-code enum is
 * an additive-only contract owned by BUILD_PLAN §3, not something a single
 * work package changes unilaterally. `INDEX_INCOMPLETE` is the closest
 * existing fit: a watcher-loop or reconciliation failure means the index
 * *could* silently drift out of sync with the filesystem, which is exactly
 * what that code denotes, and — importantly for spec.md §25.2's "'not
 * found' vs. 'infrastructure failure' must never be confused" rule — it is
 * unambiguously NOT a "not found" code, so no such confusion arises here.
 * Flagged in this task's `openIssues` as a candidate for a dedicated
 * `WATCHER_DEGRADED` code in a future, coordinated domain change.
 */
import { UntangleError, isUntangleError } from "@untangle-code/domain";

export { isUntangleError };

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Normalizes any thrown value into an `UntangleError`. An already-typed
 * error (e.g. `LOCK_HELD` from `LockProvider.renew()`, `JOB_CANCELLED` from
 * an aborted operation) passes through unchanged — this only wraps genuine
 * unknowns (backend I/O failures, unexpected iterable termination, …).
 */
export function toWatcherError(
  error: unknown,
  operation: string,
  context: Record<string, unknown>,
): UntangleError {
  if (isUntangleError(error)) {
    return error;
  }
  return new UntangleError(
    "INDEX_INCOMPLETE",
    `Watcher operation "${operation}" failed: ${errorMessage(error)}`,
    {
      operation,
      retryable: true,
      context,
      cause: error,
    },
  );
}
