/**
 * Builds a `PortCallOptions` from an optional `AbortSignal` without ever
 * setting `signal: undefined` explicitly — required because domain's
 * `PortCallOptions` is checked under `exactOptionalPropertyTypes`.
 */
import type { PortCallOptions } from "@untangle-code/domain";

export function portOptions(signal: AbortSignal | undefined): PortCallOptions | undefined {
  return signal === undefined ? undefined : { signal };
}
