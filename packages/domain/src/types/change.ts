/**
 * Change intelligence contracts (spec.md §17; architecture.md §19).
 */
import type { RISK_ALGORITHM_ID } from "../versions.js";

/** Change kind of a change event (spec.md §17.2). */
export type ChangeKind =
  "added" | "modified" | "deleted" | "renamed" | "moved" | "moved_and_renamed";

/**
 * Text diff summary. Shape is an Untangle decision (spec.md §17.2 references
 * it without defining it): plain counts, no hunk content — large diffs are
 * referenced via local artifacts, not duplicated into payloads
 * (architecture.md §10.6).
 */
export interface DiffSummaryV1 {
  linesAdded: number;
  linesRemoved: number;
  hunkCount: number;
  /** True when either side was classified binary; line counts are then 0. */
  binary: boolean;
  bytesAdded?: number;
  bytesRemoved?: number;
}

/**
 * AST diff summary (shape: Untangle decision). Counts refer to AST nodes of
 * the matched entity; `fingerprintChanged` reports whether the entity's
 * AST fingerprint (spec.md §17.3 signal 3) differs between base and head.
 */
export interface AstDiffSummaryV1 {
  nodesAdded: number;
  nodesRemoved: number;
  nodesMoved: number;
  nodesUpdated: number;
  /** Distinct node kinds affected, e.g. ["if_statement", "call_expression"]. */
  affectedNodeKinds: string[];
  fingerprintChanged: boolean;
}

/**
 * Per-metric delta entry (spec.md §17.4).
 *
 * For added symbols `baseValue` is null, for deleted symbols `headValue` is
 * null; in both cases `delta`/`relativeDelta` are null as well — new/deleted
 * entities are reported separately, never as an infinite relative delta.
 */
export interface MetricDeltaEntryV1 {
  /** Metric key, e.g. "cognitive", "cyclomatic_classic", "sloc". */
  metric: string;
  baseValue: number | null;
  headValue: number | null;
  /** `head - base`; null when one side is missing. */
  delta: number | null;
  /** `delta / max(abs(base), epsilon)`; null when one side is missing. */
  relativeDelta: number | null;
}

/** Complexity delta of one matched entity (spec.md §17.4). */
export interface ComplexityDeltaV1 {
  metricsVersion: string;
  /** Epsilon used as the relative-delta denominator floor. */
  epsilon: number;
  entries: MetricDeltaEntryV1[];
}

/** Reference to a graph edge affected by a change (shape: Untangle decision). */
export interface GraphEdgeRefV1 {
  /** Source node id (file id or symbol id depending on `edgeKind`). */
  fromId: string;
  /** Target node id, or an unresolved name for `unresolved` targets. */
  toId: string;
  /** e.g. "import", "re_export", "dynamic_import", "call", "cross_repo_package". */
  edgeKind: string;
  crossRepo: boolean;
}

/** Fan-in/fan-out change of one node (spec.md §17.5). */
export interface FanChangeV1 {
  nodeId: string;
  fanInBefore: number;
  fanInAfter: number;
  fanOutBefore: number;
  fanOutAfter: number;
}

/** Graph delta of a change (spec.md §17.5). */
export interface GraphDeltaV1 {
  addedFileImports: GraphEdgeRefV1[];
  removedFileImports: GraphEdgeRefV1[];
  addedSymbolCalls: GraphEdgeRefV1[];
  removedSymbolCalls: GraphEdgeRefV1[];
  addedCrossRepoEdges: GraphEdgeRefV1[];
  removedCrossRepoEdges: GraphEdgeRefV1[];
  /** Each cycle as its ordered list of node ids. */
  addedCycles: string[][];
  removedCycles: string[][];
  fanChanges: FanChangeV1[];
  impactSizeBefore: number;
  impactSizeAfter: number;
}

/** Blast-radius summary of a change (spec.md §17.2; shape: Untangle decision). */
export interface ImpactSummaryV1 {
  impactedFileCount: number;
  impactedSymbolCount: number;
  impactedRepoIds: string[];
  /** Depth actually reached by the reverse traversal. */
  maxDepthReached: number;
  /** True when a traversal limit stopped the analysis (architecture.md §17.4). */
  truncated: boolean;
  truncationReason?: string;
  /** Bounded sample of impacted symbol ids for display. */
  sampleImpactedSymbolIds: string[];
}

/** Risk level buckets (spec.md §17.6). */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Risk score (spec.md §17.6). Must never be emitted without `components` and
 * `caveats` — an empty caveat list is allowed, a missing one is not.
 */
export interface RiskScoreV1 {
  /** Aggregated score in [0, 1]. */
  value: number;
  level: RiskLevel;
  algorithm: typeof RISK_ALGORITHM_ID;
  /** Per-component breakdown: normalized value, weight, contribution. */
  components: Record<string, { value: number; weight: number; contribution: number }>;
  caveats: string[];
}

/** Change event (spec.md §17.2) — exact spec shape. */
export interface ChangeEventV1 {
  schemaVersion: 1;
  changeId: string;
  workspaceId: string;
  repoId: string;
  baseRef: string;
  headRef: string;
  baseCommit?: string;
  headCommit?: string;
  /** ISO-8601; obtained via the Clock port. */
  changedAt: string;
  changeKind: ChangeKind;
  oldSymbolId?: string;
  newSymbolId?: string;
  oldFilePath?: string;
  newFilePath?: string;
  textDiffSummary: DiffSummaryV1;
  astDiffSummary?: AstDiffSummaryV1;
  complexityDelta?: ComplexityDeltaV1;
  graphDelta?: GraphDeltaV1;
  blastRadius?: ImpactSummaryV1;
  risk?: RiskScoreV1;
}
