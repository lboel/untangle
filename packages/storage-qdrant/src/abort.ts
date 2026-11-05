/**
 * `AbortSignal` handling for the Qdrant adapter (spec.md §22: every
 * long-running port method MUST respect abort signals; cancellation surfaces
 * as `UntangleError` with code `JOB_CANCELLED`).
 *
 * Mirrors the calling convention of the testkit's in-memory adapters
 * (re-implemented here — testkit is test infrastructure and must not be a
 * production dependency): port methods reject their returned Promise, they
 * never throw synchronously.
 */
import type { PortCallOptions } from "@untangle-code/domain";
import { jobCancelledError } from "@untangle-code/observability";

/**
 * Returns a rejected `Promise<T>` carrying `UntangleError("JOB_CANCELLED", …)`
 * when `options.signal` is already aborted, `undefined` otherwise.
 */
export function abortedRejection<T>(
  options: PortCallOptions | undefined,
  operation: string,
): Promise<T> | undefined {
  if (options?.signal?.aborted) {
    return Promise.reject(jobCancelledError(`"${operation}" was aborted`, { operation }));
  }
  return undefined;
}

/**
 * Throws `UntangleError("JOB_CANCELLED", …)` when `signal` is aborted.
 * For use INSIDE `async` function bodies (e.g. between upsert batches),
 * where a throw is already a Promise rejection.
 */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw jobCancelledError(`"${operation}" was aborted`, { operation });
  }
}
