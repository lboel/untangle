/**
 * Single-flight / in-flight de-duplication primitives (spec.md §9.4, WP-78).
 *
 * Used to make sure a running async operation for a given key is REUSED by
 * concurrent callers instead of started twice — both for embedding a
 * not-yet-cached text (`provider.ts`'s `embedSlice`) and for the readiness
 * sequence (`ensureReadyOnce`). Deliberately generic and cache-agnostic:
 * these helpers only manage the "who is doing this right now" bookkeeping,
 * never the cache or the network call itself.
 */

/** An externally-settleable promise: `resolve`/`reject` are exposed to the caller. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** Creates a {@link Deferred}. The executor runs synchronously, so both fields are always assigned. */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toAbortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

/**
 * Awaits `shared` — a promise potentially also being awaited by OTHER
 * callers — but lets THIS caller's own `signal` reject early without
 * affecting `shared` itself: the underlying operation keeps running (and
 * other joined callers keep waiting on it) even after one waiter's own
 * signal aborts (WP-78 requirement: one waiter's cancellation must not
 * cancel the operation for everyone else).
 */
export function raceWithSignal<T>(shared: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return shared;
  }
  if (signal.aborted) {
    return Promise.reject(toAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Registry of in-flight operations keyed by an arbitrary string. `claim`
 * MUST be called synchronously (no `await`) between checking for an
 * existing entry and registering a new one — see call sites in
 * `provider.ts` — so that two concurrent callers observing the same "no
 * entry yet" state cannot both start the operation (the actual JS-level
 * atomicity comes from there being no `await` in the claiming code, not
 * from this class).
 */
export class InFlightRegistry<T> {
  private readonly entries = new Map<string, Promise<T>>();

  /** Returns the in-flight promise for `key`, if any is currently registered. */
  public get(key: string): Promise<T> | undefined {
    return this.entries.get(key);
  }

  /**
   * Registers `promise` as the in-flight operation for `key`. The entry is
   * removed automatically once `promise` settles — successfully or not — so
   * a failed attempt frees the key immediately for a fresh retry (WP-78:
   * "ein Fehlschlag den Eintrag wieder freigibt").
   */
  public register(key: string, promise: Promise<T>): void {
    this.entries.set(key, promise);
    // Void: this cleanup must never itself become an unhandled rejection —
    // the caller is responsible for handling/propagating `promise`'s outcome.
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (this.entries.get(key) === promise) {
          this.entries.delete(key);
        }
      });
  }
}
