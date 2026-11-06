import type {
  CollectionSpecV1,
  HybridQueryV1,
  ScoredPointV1,
  SparseVectorV1,
  VectorPointV1,
} from "@untangle-code/domain";
import { reciprocalRankFusion } from "@untangle-code/storage-qdrant";

import { matchesFilter, validateFilter } from "./filters.js";
import { invalid, schemaError } from "./operation.js";
import { validateSparse } from "./schema.js";

const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function denseScore(
  a: readonly number[],
  b: readonly number[],
  distance: CollectionSpecV1["denseDistance"],
): number {
  let score = 0;
  if (distance === "Cosine") {
    let scaleA = 0,
      scaleB = 0;
    for (let i = 0; i < a.length; i += 1) {
      scaleA = Math.max(scaleA, Math.abs(a[i]!));
      scaleB = Math.max(scaleB, Math.abs(b[i]!));
    }
    if (!scaleA || !scaleB) return 0;
    let dot = 0,
      aa = 0,
      bb = 0;
    for (let i = 0; i < a.length; i += 1) {
      const av = a[i]! / scaleA,
        bv = b[i]! / scaleB;
      dot += av * bv;
      aa += av * av;
      bb += bv * bv;
    }
    score = dot / Math.sqrt(aa * bb);
  } else if (distance === "Dot") {
    for (let i = 0; i < a.length; i += 1) score += a[i]! * b[i]!;
  } else {
    let length = 0;
    for (let i = 0; i < a.length; i += 1) length = Math.hypot(length, a[i]! - b[i]!);
    score = -length;
  }
  if (!Number.isFinite(score)) throw invalid("Vector score exceeds finite numeric range.");
  return score;
}

/** Collection-wide IDF is reconstructed from one immutable Lance snapshot. */
function sparseScorer(
  points: readonly VectorPointV1[],
  query: SparseVectorV1,
  check: () => void,
): (point: VectorPointV1) => number {
  const frequency = new Map<number, number>();
  let documents = 0;
  for (const point of points) {
    check();
    if (!point.sparse) continue;
    documents += 1;
    point.sparse.indices.forEach((index, i) => {
      if (point.sparse!.values[i]! > 0) frequency.set(index, (frequency.get(index) ?? 0) + 1);
    });
  }
  const weights = new Map(
    query.indices.map((index, i) => {
      const df = frequency.get(index) ?? 0;
      return [index, query.values[i]! * Math.log(1 + (documents - df + 0.5) / (df + 0.5))];
    }),
  );
  return (point) => {
    let score = 0;
    point.sparse?.indices.forEach((index, i) => {
      score += (weights.get(index) ?? 0) * point.sparse!.values[i]!;
    });
    if (!Number.isFinite(score)) throw invalid("Sparse score exceeds finite numeric range.");
    return score;
  };
}

export function rankPoints(
  points: readonly VectorPointV1[],
  spec: CollectionSpecV1,
  query: HybridQueryV1,
  check: () => void,
): ScoredPointV1[] {
  validateFilter(query.filter);
  if (
    !Number.isInteger(query.limit) ||
    query.limit < 0 ||
    (query.candidateLimit !== undefined &&
      (!Number.isInteger(query.candidateLimit) || query.candidateLimit < 0))
  )
    throw invalid("Query limits must be non-negative integers.");
  if (
    query.dense &&
    (query.dense.length !== spec.denseDimensions || !query.dense.every(Number.isFinite))
  )
    throw schemaError("Query dense vector does not match the collection.");
  if (query.sparse) {
    if (!spec.sparseBm25) throw schemaError("The collection does not declare sparse vectors.");
    validateSparse(query.sparse.indices, query.sparse.values);
  }
  if (!query.limit || (!query.dense && !query.sparse)) return [];
  const candidates = points.filter((point) => {
    check();
    return matchesFilter(point.payload, query.filter);
  });
  const compare = (a: { id: string; score: number }, b: { id: string; score: number }) =>
    b.score - a.score || compareId(a.id, b.id);
  const limit =
    query.dense && query.sparse ? (query.candidateLimit ?? Math.max(query.limit, 20)) : query.limit;
  const dense = query.dense
    ? candidates
        .filter((point) => point.dense !== undefined)
        .map((point) => {
          check();
          return {
            id: point.id,
            score: denseScore(query.dense!, point.dense!, spec.denseDistance),
          };
        })
        .sort(compare)
        .slice(0, limit)
    : [];
  const scoreSparse = query.sparse ? sparseScorer(points, query.sparse, check) : null;
  const sparse = scoreSparse
    ? candidates
        .filter((point) => point.sparse !== undefined)
        .map((point) => {
          check();
          return { id: point.id, score: scoreSparse(point) };
        })
        .filter((hit) => hit.score > 0)
        .sort(compare)
        .slice(0, limit)
    : [];
  const denseScores = new Map(dense.map((hit) => [hit.id, hit.score]));
  const sparseRanks = new Map(sparse.map((hit, rank) => [hit.id, rank]));
  const byId = new Map(points.map((point) => [point.id, point]));
  const ranked =
    query.dense && query.sparse
      ? [...reciprocalRankFusion([dense.map((hit) => hit.id), sparse.map((hit) => hit.id)])]
          .map(([id, score]) => ({ id, score }))
          .sort(compare)
      : query.dense
        ? dense
        : sparse;
  check();
  return ranked.slice(0, query.limit).map((hit) => ({
    ...hit,
    ...(denseScores.has(hit.id) ? { denseScore: denseScores.get(hit.id)! } : {}),
    ...(sparseRanks.has(hit.id) ? { sparseRank: sparseRanks.get(hit.id)! } : {}),
    ...(query.withPayload ? { payload: byId.get(hit.id)!.payload } : {}),
  }));
}
