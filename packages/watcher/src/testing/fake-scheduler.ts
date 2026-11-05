/**
 * Deterministic `SchedulerPort` for tests — not exported from the package's
 * public API (mirrors `@untangle-code/scanner`'s `src/testing/`, which is
 * also test-only infrastructure).
 *
 * Paired with a `FakeClock` (`@untangle-code/testkit`) it owns: `advance()`
 * moves that SAME clock forward and fires any timers that become due along
 * the way, in strict chronological order — so a test can assert on both
 * "how much fake time passed" (via the shared clock) and "did the debounce/
 * reconciliation timer fire" with one deterministic call, no real
 * `setTimeout` waits anywhere in the fast suite.
 */
import type { FakeClock } from "@untangle-code/testkit";

import type { SchedulerPort, TimerHandle } from "../types.js";

interface ScheduledTimer {
  dueAtEpochMs: number;
  /** Present for `setInterval` timers; re-arms itself by this many ms after firing. */
  intervalMs?: number;
  callback: () => void;
  cleared: boolean;
}

export class FakeScheduler implements SchedulerPort {
  private readonly timers: ScheduledTimer[] = [];

  public constructor(private readonly clock: FakeClock) {}

  public setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const timer: ScheduledTimer = {
      dueAtEpochMs: this.clock.nowEpochMs() + delayMs,
      callback,
      cleared: false,
    };
    this.timers.push(timer);
    return { clear: () => (timer.cleared = true) };
  }

  public setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const timer: ScheduledTimer = {
      dueAtEpochMs: this.clock.nowEpochMs() + intervalMs,
      intervalMs,
      callback,
      cleared: false,
    };
    this.timers.push(timer);
    return { clear: () => (timer.cleared = true) };
  }

  /** Number of timers still pending (cleared/fired-once ones excluded) — test introspection only. */
  public get pendingCount(): number {
    return this.timers.filter((timer) => !timer.cleared).length;
  }

  /**
   * Advances the shared clock by `deltaMs`, firing every timer whose due
   * time falls within `(now, now + deltaMs]`, earliest first. An interval
   * timer re-arms and may fire again within the same `advance()` call if
   * `deltaMs` spans multiple periods.
   */
  public advance(deltaMs: number): void {
    const target = this.clock.nowEpochMs() + deltaMs;
    for (;;) {
      let next: ScheduledTimer | undefined;
      for (const timer of this.timers) {
        if (timer.cleared || timer.dueAtEpochMs > target) {
          continue;
        }
        if (!next || timer.dueAtEpochMs < next.dueAtEpochMs) {
          next = timer;
        }
      }
      if (!next) {
        break;
      }
      this.clock.set(next.dueAtEpochMs);
      if (next.intervalMs !== undefined) {
        next.dueAtEpochMs += next.intervalMs;
      } else {
        next.cleared = true;
      }
      next.callback();
    }
    this.clock.set(target);
  }
}
