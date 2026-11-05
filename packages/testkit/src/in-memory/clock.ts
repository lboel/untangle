/**
 * Manually-advanceable `Clock` (BUILD_PLAN global rule: no `Date.now()` in
 * domain/analysis logic — this is the test-time source of "now").
 */
import type { Clock } from "@untangle-code/domain";

export class FakeClock implements Clock {
  private currentMs: number;

  public constructor(startEpochMs = 0) {
    this.currentMs = startEpochMs;
  }

  public nowEpochMs(): number {
    return this.currentMs;
  }

  public nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  /** Moves the clock forward (or backward, given a negative delta) by `deltaMs`. */
  public advance(deltaMs: number): void {
    this.currentMs += deltaMs;
  }

  /** Sets the clock to an absolute epoch millisecond value. */
  public set(epochMs: number): void {
    this.currentMs = epochMs;
  }
}

/**
 * Real-time `Clock` backed by `Date.now()`.
 *
 * Used for real elapsed-time wait budgets and production-like integration
 * cases. Lock lease timestamps remain controlled by the Clock injected into
 * the adapter; their contract uses FakeClock for exact boundaries while
 * polling, cancellation and waitMs continue to exercise real time. This is
 * deliberately the only place in this package that reads real time directly.
 */
export class SystemClock implements Clock {
  public nowEpochMs(): number {
    // The one legitimate, single call site in this package that reads real
    // time directly — see the class doc comment above for why. Every other
    // caller (including `InMemoryLockProvider`'s own real-time-bounded
    // retry loop) goes through an INSTANCE of this class, never `Date.now()`
    // itself, which is exactly what the repo-wide lint rule requires.
    // eslint-disable-next-line no-restricted-syntax
    return Date.now();
  }

  public nowIso(): string {
    return new Date().toISOString();
  }
}
