/**
 * Memory-bounded projection of one file's direct edges.
 *
 * Persisted snapshots already keep their edges in canonical order. Iterating
 * that snapshot directly avoids materialising the complete high-degree result
 * returned by `RestoredFileGraph.edgesFrom` immediately before JSON encoding.
 * We still count every matching edge so the visible omission count is exact.
 */
export function boundDirectEdges<T extends { readonly fromFileId: string }>(
  candidates: Iterable<T>,
  fromFileId: string,
  maxEdges: number,
): { edges: T[]; truncated: boolean; omittedCount: number } {
  const edges: T[] = [];
  let matchingCount = 0;

  for (const edge of candidates) {
    if (edge.fromFileId !== fromFileId) continue;
    matchingCount += 1;
    if (edges.length < maxEdges) edges.push(edge);
  }

  const omittedCount = matchingCount - edges.length;
  return { edges, truncated: omittedCount > 0, omittedCount };
}
