/**
 * Bounded-concurrency map (spec.md §9.2 "Requests MÜSSEN nach
 * Verbindungslimit begrenzt werden").
 *
 * A small counting semaphore rather than a dependency on an external queue
 * library — the whole need here is "run at most N of these concurrently,
 * preserve output order", which is a handful of lines.
 */

/** Runs `fn` over `items` with at most `limit` concurrent calls, preserving output order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const boundedLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  }

  await Promise.all(Array.from({ length: boundedLimit }, () => worker()));
  return results;
}
