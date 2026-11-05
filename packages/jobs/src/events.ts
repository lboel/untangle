/**
 * Single-consumer async event channel — the transport that makes the typed
 * job events of architecture.md §2.2 consumable as an `AsyncIterable`
 * (spec.md §22: `index()` returns `AsyncIterable<JobEvent>`).
 *
 * The producer side (`emit`) never blocks: job events are small, bounded in
 * number per batch, and the pipeline's memory pressure is controlled by the
 * bounded work queues, not by the event stream. `fail()` exists for
 * catastrophic driver bugs only — regular job failures are emitted as
 * `job_failed` events and end the stream via `close()`.
 */

export class AsyncEventChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private closed = false;
  private failure: { error: unknown } | null = null;
  private wakers: Array<() => void> = [];

  /** Enqueues one event. Throws when the channel is already closed/failed. */
  public emit(event: T): void {
    if (this.closed) {
      throw new Error("AsyncEventChannel.emit() called after close()/fail()");
    }
    this.buffer.push(event);
    this.notify();
  }

  /** Ends the stream after all buffered events were consumed. Idempotent. */
  public close(): void {
    this.closed = true;
    this.notify();
  }

  /**
   * Ends the stream with a rejection after all buffered events were
   * consumed. Idempotent; a later `fail()` does not override an earlier one.
   */
  public fail(error: unknown): void {
    if (this.failure === null) {
      this.failure = { error };
    }
    this.closed = true;
    this.notify();
  }

  private notify(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const wake of wakers) {
      wake();
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        // `length > 0` guarantees the shift result is a T, even for a T that
        // could itself include `undefined`.
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.failure !== null) {
        throw this.failure.error;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => this.wakers.push(resolve));
    }
  }
}
