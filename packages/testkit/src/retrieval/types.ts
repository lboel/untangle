/**
 * Retrieval ground truth and evaluation types (spec.md §27.3 — the
 * `RetrievalCase` shape is quoted there verbatim).
 */

/** One ground-truth query, as spec.md §27.3 defines it. */
export interface RetrievalCase {
  query: string;
  /** Repo-relative (or fully-qualified, cross-repo) file paths that MUST be found. */
  expectedFiles: string[];
  /** Fully-qualified symbol names expected among the results, if applicable. */
  expectedSymbols?: string[];
  /** File paths that MUST NOT appear in the results (a true negative test). */
  forbiddenFiles?: string[];
}

/** One ranked search hit, as produced by whatever retrieval system is under evaluation. */
export interface RetrievalHit {
  filePath: string;
  /** Owning repository, when the case spans more than one (spec.md §13.1 cross-repo search). */
  repoId?: string;
  symbolFqn?: string;
}

/** One case's ground truth paired with the ranked hits it actually produced. */
export interface RetrievalCaseResult {
  retrievalCase: RetrievalCase;
  /** Ranked best-first; only the leading hits up to whatever `@k` needs are used. */
  hits: RetrievalHit[];
}

/** Per-case metrics, exposed alongside the aggregate so failures are diagnosable. */
export interface RetrievalCaseMetrics {
  query: string;
  recallAt5: number;
  recallAt10: number;
  reciprocalRank: number;
  /** True iff any hit's filePath is one of the case's `forbiddenFiles`. */
  forbiddenFileViolation: boolean;
  /** Distinct `repoId`s among this case's considered hits (see `evaluate` doc comment). */
  repositoryDiversity: number;
}

/** Aggregate metrics across every case (spec.md §27.3: "Mindestens Recall@5, Recall@10, MRR und Repository-Diversity"). */
export interface RetrievalMetrics {
  /** Mean, across cases, of the fraction of `expectedFiles` found in the top 5 hits. */
  recallAt5: number;
  /** Mean, across cases, of the fraction of `expectedFiles` found in the top 10 hits. */
  recallAt10: number;
  /** Mean Reciprocal Rank of the first `expectedFiles` match across all hits. */
  mrr: number;
  /** Mean, across cases, of the number of distinct repositories represented among the hits. */
  repositoryDiversity: number;
  /** Number of cases where a `forbiddenFiles` entry appeared in the hits. */
  forbiddenFileViolationCount: number;
  perCase: RetrievalCaseMetrics[];
}
