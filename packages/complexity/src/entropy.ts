/** Shannon entropy in bits over a frequency distribution (spec.md §16.6, §16.8). */
export function shannonEntropy(frequencies: Iterable<number>): number {
  let total = 0;
  const values: number[] = [];
  for (const f of frequencies) {
    if (f <= 0) continue;
    values.push(f);
    total += f;
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (const f of values) {
    const p = f / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Builds a frequency map by counting occurrences of `key(item)` over `items`. */
export function frequenciesOf<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
