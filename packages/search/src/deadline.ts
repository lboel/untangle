import { UntangleError, type PortCallOptions } from "@untangle-code/domain";

/** Bound hybrid branches and propagate outer cancellation even if an adapter hangs. */
export async function withSearchBranchDeadline<T>(
  branch: "dense" | "sparse" | "symbol",
  timeoutMs: number | undefined,
  retrieve: (options: PortCallOptions) => Promise<T>,
  options?: PortCallOptions,
  storeFailureCode: "QDRANT_UNAVAILABLE" | "LANCEDB_UNAVAILABLE" = "QDRANT_UNAVAILABLE",
): Promise<T> {
  options?.signal?.throwIfAborted();
  const controller = new AbortController();
  let timeoutError: UntangleError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason: unknown = options?.signal?.reason;
      reject(reason);
      controller.abort(reason);
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timeoutError = new UntangleError(
          branch === "dense" ? "EMBEDDING_UNAVAILABLE" : storeFailureCode,
          `retrieval branch "${branch}" exceeded its ${String(timeoutMs)}ms deadline`,
          {
            operation: "search_branch",
            retryable: true,
            context: { branch, timeoutMs, timedOut: true },
          },
        );
        // Reject before notifying the adapter: an adapter's JOB_CANCELLED is
        // caused by this local deadline and must not cancel successful peers.
        reject(timeoutError);
        controller.abort(timeoutError);
      }, timeoutMs);
    }
  });
  try {
    // Promise.race installs handlers on both promises, including a late
    // adapter rejection after a deadline. It cannot become unhandled.
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return retrieve({ ...options, signal: controller.signal });
      }),
      interrupted,
    ]);
  } catch (error) {
    options?.signal?.throwIfAborted();
    if (timeoutError !== undefined) throw timeoutError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) options?.signal?.removeEventListener("abort", onAbort);
  }
}
