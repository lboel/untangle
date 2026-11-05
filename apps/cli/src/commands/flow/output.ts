export interface LimitedItems<T> {
  items: T[];
  truncated: boolean;
  omittedCount: number;
}

/** Bounded presentation helper shared by text-independent JSON surfaces. */
export function limitItems<T>(items: readonly T[], limit: number): LimitedItems<T> {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const omittedCount = Math.max(0, items.length - boundedLimit);
  return {
    items: items.slice(0, boundedLimit),
    truncated: omittedCount > 0,
    omittedCount,
  };
}
