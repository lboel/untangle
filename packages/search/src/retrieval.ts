/** Independent recall branches, bounded provider calls and deterministic failure diagnostics. */
import {
  UntangleError,
  compareCodepoints,
  isUntangleError,
  type ErrorCode,
  type PayloadFilter,
  type PortCallOptions,
  type ScoredPointV1,
  type ScrollPageV1,
  type ToolWarningV1,
  type VectorStore,
} from "@untangle-code/domain";

import { withSearchBranchDeadline } from "./deadline.js";
import { buildSymbolNameFilter } from "./filter.js";
import type { SearchSkipInput } from "./ledger.js";
import type { ProfileTargetV1, SparseVectorizer } from "./port.js";
import { symbolNameFilterCandidates } from "./symbol-match.js";
import type { SearchMode } from "./types.js";

export type RetrievalBranch = "dense" | "sparse" | "symbol";
type RetrievalTarget = Pick<ProfileTargetV1, "collection" | "embeddingProfileId" | "embedder">;

export interface IndependentRetrievalRequest {
  vectorStore: Pick<VectorStore, "hybridQuery" | "scroll">;
  target: RetrievalTarget;
  text: string;
  filter: PayloadFilter;
  candidateLimit: number;
  mode: SearchMode;
  sparseVectorizer?: SparseVectorizer;
  branchTimeoutMs: number;
}

interface FailedBranch {
  branch: RetrievalBranch;
  status: "failed";
  error: unknown;
}

type BranchOutcome<T> =
  | FailedBranch
  | { branch: RetrievalBranch; status: "not_requested" }
  | { branch: RetrievalBranch; status: "succeeded"; result: T };

export interface IndependentRetrievalResult {
  densePoints: readonly ScoredPointV1[];
  sparsePoints: readonly ScoredPointV1[];
  symbolPage?: ScrollPageV1;
  completedBranches: ReadonlySet<RetrievalBranch>;
  failures: readonly FailedBranch[];
  warnings: ToolWarningV1[];
  caveats: string[];
  skipped: SearchSkipInput[];
}

/** The mode controls both recall and ranking, so it has one shared definition. */
export function branchesOfMode(mode: SearchMode): {
  dense: boolean;
  lexical: boolean;
  symbol: boolean;
} {
  switch (mode) {
    case "semantic":
      return { dense: true, lexical: false, symbol: false };
    case "lexical":
      return { dense: false, lexical: true, symbol: false };
    case "symbol":
      return { dense: false, lexical: false, symbol: true };
    case "hybrid":
      return { dense: true, lexical: true, symbol: true };
  }
}

/** Cancellation is control flow, never a degraded retrieval result. */
export function rethrowCancellation(error: unknown, options?: PortCallOptions): void {
  options?.signal?.throwIfAborted();
  if (
    (isUntangleError(error) && error.code === "JOB_CANCELLED") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throw error;
  }
}

async function retrieveDense(
  request: IndependentRetrievalRequest,
  options: PortCallOptions,
): Promise<ScoredPointV1[]> {
  const { target } = request;
  const preparedQuery = `${target.embedder.profile.queryPrefix}${request.text}`;
  const dense = await target.embedder.embedQuery(preparedQuery, options);
  options.signal?.throwIfAborted();
  return request.vectorStore.hybridQuery(
    target.collection,
    {
      dense,
      filter: request.filter,
      limit: request.candidateLimit,
      candidateLimit: request.candidateLimit,
      withPayload: true,
    },
    options,
  );
}

async function retrieveSparse(
  request: IndependentRetrievalRequest,
  options: PortCallOptions,
): Promise<ScoredPointV1[]> {
  if (request.sparseVectorizer === undefined) {
    throw new UntangleError("INDEX_INCOMPLETE", "no sparse vectorizer is wired", {
      operation: "search_sparse_retrieval",
    });
  }
  return request.vectorStore.hybridQuery(
    request.target.collection,
    {
      sparse: request.sparseVectorizer(request.text),
      filter: request.filter,
      limit: request.candidateLimit,
      candidateLimit: request.candidateLimit,
      withPayload: true,
    },
    options,
  );
}

async function retrieveSymbol(
  request: IndependentRetrievalRequest,
  options: PortCallOptions,
): Promise<ScrollPageV1> {
  const filter = buildSymbolNameFilter(request.filter, symbolNameFilterCandidates(request.text));
  if (filter === undefined) return { points: [] };
  return request.vectorStore.scroll(
    request.target.collection,
    { filter, limit: request.candidateLimit },
    options,
  );
}

/** Each branch produces an explicit outcome; a provider failure does not cancel its peers. */
async function executeBranch<T>(
  branch: RetrievalBranch,
  enabled: boolean,
  request: IndependentRetrievalRequest,
  retrieve: (request: IndependentRetrievalRequest, options: PortCallOptions) => Promise<T>,
  options: PortCallOptions,
): Promise<BranchOutcome<T>> {
  if (!enabled) return { branch, status: "not_requested" };
  try {
    const result = await withSearchBranchDeadline(
      branch,
      request.mode === "hybrid" ? request.branchTimeoutMs : undefined,
      retrieve.bind(undefined, request),
      options,
    );
    options.signal?.throwIfAborted();
    return { branch, status: "succeeded", result };
  } catch (error) {
    rethrowCancellation(error, options);
    return { branch, status: "failed", error };
  }
}

function branchResult<T>(outcome: BranchOutcome<T>): T | undefined {
  return outcome.status === "succeeded" ? outcome.result : undefined;
}

function isFailedBranch(outcome: BranchOutcome<unknown>): outcome is FailedBranch {
  return outcome.status === "failed";
}

function branchFailureCode(failure: FailedBranch | undefined): ErrorCode {
  if (failure !== undefined && isUntangleError(failure.error)) return failure.error.code;
  return failure?.branch === "dense" ? "EMBEDDING_UNAVAILABLE" : "QDRANT_UNAVAILABLE";
}

function timeoutDetails(error: unknown): Record<string, unknown> {
  if (!isUntangleError(error) || error.context["timedOut"] !== true) return {};
  return { timedOut: true, timeoutMs: error.context["timeoutMs"] };
}

/** Build evidence once in branch-name order, independent of completion timing. */
function failureDiagnostics(
  target: RetrievalTarget,
  failures: readonly FailedBranch[],
): Pick<IndependentRetrievalResult, "warnings" | "caveats" | "skipped"> {
  const warnings: ToolWarningV1[] = [];
  const caveats: string[] = [];
  const skipped: SearchSkipInput[] = [];
  for (const failure of failures) {
    const { branch, error } = failure;
    const message = error instanceof Error ? error.message : String(error);
    const detail = `profile "${target.embeddingProfileId}" retrieval branch "${branch}" failed: ${message}`;
    const timeout = timeoutDetails(error);
    caveats.push(detail);
    warnings.push({
      code: "SEARCH_BRANCH_UNAVAILABLE",
      message: detail,
      details: {
        embeddingProfileId: target.embeddingProfileId,
        collection: target.collection,
        branch,
        causeCode: branchFailureCode(failure),
        ...timeout,
      },
    });
    if (timeout["timedOut"] === true) {
      warnings.push({
        code: "SEARCH_BRANCH_TIMEOUT",
        message: detail,
        details: { branch, timeoutMs: timeout["timeoutMs"] },
      });
    }
    skipped.push({
      subjectKind: "search_candidate",
      subjectId: `${target.embeddingProfileId}:${branch}`,
      reason: "provider_unavailable",
      detail,
      recoverable: true,
    });
  }
  return { warnings, caveats, skipped };
}

/** Return all requested branch outcomes in fixed dense/sparse/symbol order. */
export async function retrieveIndependentBranches(
  request: IndependentRetrievalRequest,
  options?: PortCallOptions,
): Promise<IndependentRetrievalResult> {
  options?.signal?.throwIfAborted();
  const active = branchesOfMode(request.mode);
  const controller = new AbortController();
  const linkedOptions: PortCallOptions = {
    ...options,
    signal:
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal]),
  };
  const [dense, sparse, symbol] = await Promise.all([
    executeBranch("dense", active.dense, request, retrieveDense, linkedOptions),
    executeBranch("sparse", active.lexical, request, retrieveSparse, linkedOptions),
    executeBranch("symbol", active.symbol, request, retrieveSymbol, linkedOptions),
  ]).finally(() => controller.abort());
  options?.signal?.throwIfAborted();
  const outcomes = [dense, sparse, symbol];
  const failures = outcomes
    .filter(isFailedBranch)
    .sort((left, right) => compareCodepoints(left.branch, right.branch));
  const completedBranches = new Set(
    outcomes.filter((outcome) => outcome.status === "succeeded").map((outcome) => outcome.branch),
  );
  const symbolPage = branchResult(symbol);
  return {
    densePoints: branchResult(dense) ?? [],
    sparsePoints: branchResult(sparse) ?? [],
    ...(symbolPage === undefined ? {} : { symbolPage }),
    completedBranches,
    failures,
    ...failureDiagnostics(request.target, failures),
  };
}

/** The caller first records diagnostics, then distinguishes total failure from empty success. */
export function assertCompletedRetrieval(
  result: IndependentRetrievalResult,
  target: RetrievalTarget,
): void {
  if (result.completedBranches.size > 0) return;
  const first = result.failures[0];
  throw new UntangleError(
    branchFailureCode(first),
    `all requested retrieval branches failed for profile "${target.embeddingProfileId}": ${result.warnings.map((warning) => warning.message).join("; ")}`,
    {
      operation: "search_retrieval",
      retryable: result.failures.some(({ error }) => !isUntangleError(error) || error.retryable),
      context: {
        collection: target.collection,
        failedBranches: result.failures.map(({ branch }) => branch),
      },
      cause: first?.error,
    },
  );
}
