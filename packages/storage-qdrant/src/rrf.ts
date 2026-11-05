/**
 * Reciprocal Rank Fusion (spec.md §13.4). Production re-implementation of
 * the fusion used by the testkit's in-memory store — needed here for the
 * cross-collection merge (`cross-collection.ts`), where results of SEPARATE
 * collections sharing one embedding profile are combined by RANK (an
 * explicit normalization strategy), never by sorting their raw RRF scores
 * as absolute relevance.
 */

/** Smoothing constant; 60 is the conventional default from the RRF paper. */
export const RRF_DEFAULT_K = 60;

/**
 * Fuses ranked lists of ids (best first, 0-based rank) into one score map.
 * An id absent from a branch simply does not contribute that branch's term.
 */
export function reciprocalRankFusion(
  rankedIdLists: readonly (readonly string[])[],
  options: { k?: number } = {},
): Map<string, number> {
  const k = options.k ?? RRF_DEFAULT_K;
  const scores = new Map<string, number>();
  for (const list of rankedIdLists) {
    list.forEach((id, rank) => {
      const contribution = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }
  return scores;
}
