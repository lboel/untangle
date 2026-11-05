/**
 * Reciprocal Rank Fusion (spec.md §10.1, §13.4: "only RRF in v1, only within
 * one collection"). Combines several ranked id lists into one fused score
 * per id — used by `InMemoryVectorStore.hybridQuery` to fuse the dense and
 * sparse branches.
 */

export interface ReciprocalRankFusionOptions {
  /** Smoothing constant; 60 is the conventional default from the RRF paper. */
  k?: number;
}

/**
 * Fuses ranked lists of ids (best first, 0-based rank) into one score map.
 * An id absent from a branch simply does not contribute that branch's term —
 * it is never penalized beyond not being ranked there.
 */
export function reciprocalRankFusion(
  rankedIdLists: readonly (readonly string[])[],
  options: ReciprocalRankFusionOptions = {},
): Map<string, number> {
  const k = options.k ?? 60;
  const scores = new Map<string, number>();
  for (const list of rankedIdLists) {
    list.forEach((id, rank) => {
      const contribution = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }
  return scores;
}
