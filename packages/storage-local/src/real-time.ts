/**
 * The single, isolated real-wall-clock read in this package, used ONLY to
 * bound `FileLockProvider.acquire()`'s retry-polling loop — a real file lock
 * has no injectable `Clock` for "how long have we actually been waiting",
 * since that loop sleeps via real `setTimeout` regardless of what the
 * injected `Clock` reports (see `lock-provider.ts` for the full reasoning;
 * this mirrors `@untangle-code/testkit`'s own `SystemClock`, which exists for
 * exactly the same reason and carries the same isolation comment).
 *
 * Lease/record timestamps themselves (`acquiredAt`, `leaseExpiresAt`, cache
 * and checkpoint `savedAt`/access times) always go through the injected
 * `Clock` port, never this function — this is deliberately the ONE place in
 * the package's non-test code that reads real time directly.
 */
export function realNowEpochMs(): number {
  // eslint-disable-next-line no-restricted-syntax -- see file doc comment above.
  return Date.now();
}
