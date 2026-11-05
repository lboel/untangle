/**
 * Per-path debounce/coalescing (spec.md §12.3: "Events MÜSSEN entprellt
 * werden; Default 2000 ms" and "Mehrere Events derselben Datei MÜSSEN
 * koalesziert werden").
 *
 * Implemented as one classic reset-on-notify timer per path, via the
 * injected `SchedulerPort`, rather than a polling "collect due paths"
 * loop: every `notify(path)` call clears that path's pending timer (if any)
 * and starts a fresh one, so a burst of events for the same path — however
 * many, however close together — always collapses to exactly one `onDue`
 * firing, `debounceMs` after the LAST event in the burst. This directly is
 * the coalescing requirement, not merely a step towards it.
 */
import type { SchedulerPort, TimerHandle } from "./types.js";

export interface PathDebouncerOptions {
  scheduler: SchedulerPort;
  debounceMs: number;
  onDue: (relativePath: string) => void;
}

export class PathDebouncer {
  private readonly timers = new Map<string, TimerHandle>();

  public constructor(private readonly options: PathDebouncerOptions) {}

  /** Records an event for `relativePath`, (re)starting its quiet-period timer. */
  public notify(relativePath: string): void {
    this.timers.get(relativePath)?.clear();
    const handle = this.options.scheduler.setTimeout(() => {
      this.timers.delete(relativePath);
      this.options.onDue(relativePath);
    }, this.options.debounceMs);
    this.timers.set(relativePath, handle);
  }

  /** True while `relativePath` has a pending (not yet due) timer. */
  public isPending(relativePath: string): boolean {
    return this.timers.has(relativePath);
  }

  /** Cancels every pending timer without firing `onDue` — used by `RepoWatcher.stop()`. */
  public dispose(): void {
    for (const handle of this.timers.values()) {
      handle.clear();
    }
    this.timers.clear();
  }
}
