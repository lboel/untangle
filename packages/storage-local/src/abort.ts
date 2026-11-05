/**
 * Shared `AbortSignal` handling (spec.md §22: "public APIs MUST support
 * abort signals"; rule 9: every long-running method respects `AbortSignal`
 * and aborts with `JOB_CANCELLED`).
 *
 * Every port method in this package is `async`, so throwing synchronously
 * here still surfaces as a rejected Promise to the caller — unlike
 * `@untangle-code/testkit`'s `abortedRejection` (which exists specifically
 * for a few NON-`async` methods where a synchronous throw would be a bug).
 */
import type { PortCallOptions } from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";

/** Throws `UntangleError("JOB_CANCELLED", …)` when `options.signal` is already aborted. */
export function assertNotAborted(options: PortCallOptions | undefined, operation: string): void {
  if (options?.signal?.aborted) {
    throw new UntangleError("JOB_CANCELLED", `"${operation}" was aborted`, { operation });
  }
}

/** Builds a `PortCallOptions` from an optional `AbortSignal` without ever setting
 * `signal: undefined` explicitly — required because domain's `PortCallOptions` is
 * checked under `exactOptionalPropertyTypes`. */
export function portOptions(signal: AbortSignal | undefined): PortCallOptions | undefined {
  return signal === undefined ? undefined : { signal };
}
