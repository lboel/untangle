/**
 * A minimal counting semaphore used to bound I/O parallelism during
 * discovery (spec.md §6.1; architecture.md §13.1 "bounded queues").
 *
 * Deliberately hand-rolled per WP-05 order ("ein einfacher, eigenen
 * Semaphor/Pool") instead of pulling in a scheduling dependency.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  public constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`Semaphore concurrency must be a positive integer, got ${concurrency}`);
    }
    this.available = concurrency;
  }

  /** Resolves once a slot is free; returns the matching release function. */
  public acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.available -= 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  /** Number of currently free slots — exposed for tests only. */
  public get availableCount(): number {
    return this.available;
  }
}
