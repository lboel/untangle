/**
 * AbortSignal helpers shared by every long-running method in this package
 * (spec.md §22: public APIs MUST support abort signals; cancellation
 * surfaces as `UntangleError` with code `JOB_CANCELLED`).
 */
import { isUntangleError } from "@untangle-code/domain";
import { jobCancelledError } from "@untangle-code/observability";

/**
 * Throws `UntangleError("JOB_CANCELLED", …)` when `signal` is already
 * aborted. Called at every safe batch boundary (architecture.md §21.3).
 */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw jobCancelledError(`"${operation}" was aborted`, { operation });
  }
}

/** True when `error` is an `UntangleError` with code `JOB_CANCELLED`. */
export function isJobCancelledError(error: unknown): boolean {
  return isUntangleError(error) && error.code === "JOB_CANCELLED";
}

/**
 * Resolves when `signal` aborts. The listener is removed as soon as
 * `cleanup` aborts, so racing this against another promise does not leak
 * one listener per wait.
 */
export function abortedPromise(signal: AbortSignal, cleanup: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true, signal: cleanup });
  });
}
