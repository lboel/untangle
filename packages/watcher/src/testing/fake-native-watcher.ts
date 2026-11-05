/**
 * Controllable `NativeWatcherPort` for tests — not exported from the
 * package's public API (test-only, like `fake-scheduler.ts`).
 *
 * A test drives it by calling `emit()` (deliver one raw change event to
 * whichever session is currently open), `fail()` (make the current
 * session's iteration reject — simulates a backend crash, e.g. `EMFILE` or
 * `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`) or `throwOnNextWatch()` (make the
 * very next `watch()` call itself throw synchronously, before any
 * iteration starts). `RepoWatcher.runWatchLoop` reopens a session by
 * calling `watch()` again after a backend failure, so `emit()`/`fail()`
 * always target the MOST RECENTLY opened, still-open session.
 */
import type { NativeChangeEventV1, NativeWatcherPort } from "../types.js";

interface PendingSettle {
  resolve: (result: IteratorResult<NativeChangeEventV1>) => void;
  reject: (error: unknown) => void;
}

class FakeWatchSession
  implements AsyncIterable<NativeChangeEventV1>, AsyncIterator<NativeChangeEventV1>
{
  private readonly queue: NativeChangeEventV1[] = [];
  private readonly pending: PendingSettle[] = [];
  private done = false;
  private failure: { error: unknown } | undefined;

  public constructor(signal?: AbortSignal) {
    if (signal?.aborted) {
      this.finish();
    } else {
      signal?.addEventListener("abort", () => this.finish(), { once: true });
    }
  }

  public get isOpen(): boolean {
    return !this.done;
  }

  public [Symbol.asyncIterator](): AsyncIterator<NativeChangeEventV1> {
    return this;
  }

  public next(): Promise<IteratorResult<NativeChangeEventV1>> {
    if (this.failure) {
      const { error } = this.failure;
      this.failure = undefined;
      return Promise.reject(error);
    }
    if (this.done) {
      return Promise.resolve({ done: true, value: undefined });
    }
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve({ done: false, value: queued });
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  public emit(event: NativeChangeEventV1): void {
    if (this.done) {
      return;
    }
    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
    } else {
      this.queue.push(event);
    }
  }

  /** Makes the iteration reject with `error` — delivered to a waiting `next()` immediately, or to the next `next()` call otherwise. */
  public fail(error: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    const waiter = this.pending.shift();
    if (waiter) {
      waiter.reject(error);
    } else {
      this.failure = { error };
    }
  }

  public finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    const waiter = this.pending.shift();
    waiter?.resolve({ done: true, value: undefined });
  }
}

export class FakeNativeWatcher implements NativeWatcherPort {
  private sessions: FakeWatchSession[] = [];
  private throwOnWatch: unknown;
  private hasThrowOnWatch = false;

  public watch(
    _rootPath: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<NativeChangeEventV1> {
    if (this.hasThrowOnWatch) {
      const error = this.throwOnWatch;
      this.hasThrowOnWatch = false;
      this.throwOnWatch = undefined;
      throw error;
    }
    const session = new FakeWatchSession(options?.signal);
    this.sessions.push(session);
    return session;
  }

  /** Makes the very next `watch()` call throw synchronously, before any session opens. */
  public throwOnNextWatch(error: unknown): void {
    this.hasThrowOnWatch = true;
    this.throwOnWatch = error;
  }

  /** Delivers `event` on the most recently opened, still-open session. */
  public emit(event: NativeChangeEventV1): void {
    this.activeSession().emit(event);
  }

  /** Makes the most recently opened, still-open session's iteration reject with `error`. */
  public fail(error: unknown): void {
    this.activeSession().fail(error);
  }

  /** Number of `watch()` calls made so far — test introspection (e.g. asserting a restart happened). */
  public get watchCallCount(): number {
    return this.sessions.length;
  }

  private activeSession(): FakeWatchSession {
    for (let i = this.sessions.length - 1; i >= 0; i -= 1) {
      const session = this.sessions[i];
      if (session?.isOpen) {
        return session;
      }
    }
    throw new Error("FakeNativeWatcher: no open watch session — was watch() called?");
  }
}
