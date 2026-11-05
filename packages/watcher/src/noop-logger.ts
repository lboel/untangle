/** Default `LoggerPort` used when `RepoWatcherOptions.logger` is omitted — discards everything. */
import type { LoggerPort } from "@untangle-code/domain";

export const noopLogger: LoggerPort = {
  log(): void {
    // intentionally discarded — see module doc
  },
  child(): LoggerPort {
    return noopLogger;
  },
};
