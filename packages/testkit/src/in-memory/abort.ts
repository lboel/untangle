/**
 * Shared `AbortSignal` handling for the in-memory port adapters in this
 * package (spec.md §22: "public APIs MUST support abort signals";
 * ports.ts: cancellation surfaces as `UntangleError` with code
 * `JOB_CANCELLED`).
 *
 * Every port method here returns a `Promise`, and several are written as
 * plain (non-`async`) functions specifically so a failure is ALWAYS a
 * Promise rejection, never a synchronous throw (see the comments on
 * `InMemoryVectorStore.ensurePayloadIndexes`/`.upsert`). `Error.prototype`
 * calls (like `throwIfAborted()`) throw synchronously, so this module
 * returns a rejected `Promise` instead — callers check it explicitly:
 *
 * ```ts
 * const aborted = abortedRejection<Foo>(options, "operation_name");
 * if (aborted) return aborted;
 * ```
 */
import type { PortCallOptions } from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";

/**
 * Returns a rejected `Promise<T>` carrying `UntangleError("JOB_CANCELLED", …)`
 * when `options.signal` is already aborted, `undefined` otherwise.
 */
export function abortedRejection<T>(
  options: PortCallOptions | undefined,
  operation: string,
): Promise<T> | undefined {
  if (options?.signal?.aborted) {
    return Promise.reject(
      new UntangleError("JOB_CANCELLED", `"${operation}" was aborted`, { operation }),
    );
  }
  return undefined;
}
