/**
 * Retrieval benchmark evaluation (spec.md §27.3: "Mindestens Recall@5,
 * Recall@10, MRR und Repository-Diversity werden ausgewertet").
 *
 * Metric definitions (spec.md fixes the `RetrievalCase` shape but not the
 * exact formulas — these are Untangle decisions, see README
 * "Entscheidungen"):
 *
 * - **Recall@k** (per case): `|expectedFiles ∩ topK hits| / |expectedFiles|`
 *   — 1 when every expected file is not just present but within the top
 *   `k`; a case with an empty `expectedFiles` contributes 1 (vacuously
 *   satisfied, never penalized for having nothing to find). The aggregate
 *   is the mean across cases (macro-average — every case counts equally,
 *   regardless of how many files it expects).
 * - **MRR** (Mean Reciprocal Rank): per case, `1 / rank` of the FIRST hit
 *   (1-based) whose `filePath` is in `expectedFiles`, over the FULL hit
 *   list (not capped at 10) — `0` when no expected file appears anywhere.
 *   The aggregate is the mean across cases.
 * - **Repository-Diversity** (per case): the number of distinct `repoId`s
 *   among the considered hits (top 10, matching Recall@10's window) —
 *   `0` when hits carry no `repoId` at all (a single-repo evaluation), so
 *   this metric is only meaningful for cross-repo benchmarks. The
 *   aggregate is the mean across cases.
 * - **forbiddenFileViolationCount**: number of cases where any hit's
 *   `filePath` was listed in that case's `forbiddenFiles` — a true
 *   negative check, not folded into recall (a false positive is a
 *   different failure mode than a missing true positive).
 */
import type { RetrievalCaseMetrics, RetrievalCaseResult, RetrievalMetrics } from "./types.js";

const RECALL_WINDOWS = { small: 5, large: 10 } as const;

function recallAt(
  expectedFiles: readonly string[],
  hits: readonly { filePath: string }[],
  k: number,
): number {
  if (expectedFiles.length === 0) {
    return 1;
  }
  const topK = new Set(hits.slice(0, k).map((hit) => hit.filePath));
  const found = expectedFiles.filter((file) => topK.has(file)).length;
  return found / expectedFiles.length;
}

function reciprocalRank(
  expectedFiles: readonly string[],
  hits: readonly { filePath: string }[],
): number {
  if (expectedFiles.length === 0) {
    return 1;
  }
  const expectedSet = new Set(expectedFiles);
  for (let i = 0; i < hits.length; i += 1) {
    if (expectedSet.has(hits[i]?.filePath ?? "")) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function repositoryDiversity(hits: readonly { repoId?: string }[], k: number): number {
  const repoIds = new Set(
    hits
      .slice(0, k)
      .map((hit) => hit.repoId)
      .filter((repoId): repoId is string => repoId !== undefined),
  );
  return repoIds.size;
}

function hasForbiddenHit(
  hits: readonly { filePath: string }[],
  forbiddenFiles: readonly string[] | undefined,
): boolean {
  if (!forbiddenFiles || forbiddenFiles.length === 0) {
    return false;
  }
  const forbidden = new Set(forbiddenFiles);
  return hits.some((hit) => forbidden.has(hit.filePath));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Evaluates a set of `RetrievalCaseResult`s into aggregate + per-case metrics. */
export function evaluate(results: readonly RetrievalCaseResult[]): RetrievalMetrics {
  const perCase: RetrievalCaseMetrics[] = results.map(({ retrievalCase, hits }) => ({
    query: retrievalCase.query,
    recallAt5: recallAt(retrievalCase.expectedFiles, hits, RECALL_WINDOWS.small),
    recallAt10: recallAt(retrievalCase.expectedFiles, hits, RECALL_WINDOWS.large),
    reciprocalRank: reciprocalRank(retrievalCase.expectedFiles, hits),
    forbiddenFileViolation: hasForbiddenHit(hits, retrievalCase.forbiddenFiles),
    repositoryDiversity: repositoryDiversity(hits, RECALL_WINDOWS.large),
  }));

  return {
    recallAt5: mean(perCase.map((c) => c.recallAt5)),
    recallAt10: mean(perCase.map((c) => c.recallAt10)),
    mrr: mean(perCase.map((c) => c.reciprocalRank)),
    repositoryDiversity: mean(perCase.map((c) => c.repositoryDiversity)),
    forbiddenFileViolationCount: perCase.filter((c) => c.forbiddenFileViolation).length,
    perCase,
  };
}
