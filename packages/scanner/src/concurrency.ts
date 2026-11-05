/**
 * Bounded-concurrency mapping over an (async) iterable, yielding results as
 * soon as they complete (not necessarily in source order). Backs the
 * per-file processing stage of discovery (architecture.md §13.1/§13.2).
 */
import { Semaphore } from "./semaphore.js";

interface Settled<R> {
  id: number;
  value: R;
}

/**
 * Applies `worker` to every item of `source` with at most `concurrency` in
 * flight at once, yielding each result as it settles. Checks `signal` before
 * pulling each new item and before yielding each result, throwing (via
 * `AbortSignal.throwIfAborted`) as soon as an abort is observed.
 */
export async function* mapConcurrent<T, R>(
  source: AsyncIterable<T> | Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<R>,
  signal?: AbortSignal,
): AsyncGenerator<R, void, void> {
  const semaphore = new Semaphore(concurrency);
  const iterator: AsyncIterator<T> | Iterator<T> =
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (source as Iterable<T>)[Symbol.iterator]();

  const inFlight = new Map<number, Promise<Settled<R>>>();
  let nextId = 0;
  let sourceDone = false;

  async function pullOne(): Promise<void> {
    if (sourceDone) {
      return;
    }
    const release = await semaphore.acquire();
    signal?.throwIfAborted();
    const step = await iterator.next();
    if (step.done) {
      sourceDone = true;
      release();
      return;
    }
    const id = nextId;
    nextId += 1;
    const task = worker(step.value)
      .then((value) => ({ id, value }))
      .finally(release);
    inFlight.set(id, task);
  }

  try {
    signal?.throwIfAborted();
    const starters: Array<Promise<void>> = [];
    for (let i = 0; i < concurrency; i += 1) {
      starters.push(pullOne());
    }
    await Promise.all(starters);

    while (inFlight.size > 0) {
      signal?.throwIfAborted();
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.id);
      if (!sourceDone) {
        await pullOne();
      }
      signal?.throwIfAborted();
      yield settled.value;
    }
  } finally {
    if (typeof (iterator as AsyncIterator<T>).return === "function") {
      await (iterator as AsyncIterator<T>).return?.();
    }
  }
}
