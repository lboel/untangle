/**
 * Complexity contracts (spec.md §16; architecture.md §10.5, §15).
 */
import type { COGNITIVE_ALGORITHM_ID } from "../versions.js";

import type { ComplexityScope, MetricsScope, ParseQuality } from "./common.js";

/**
 * A single explainable contribution to a metric total (architecture.md §10.5).
 * Every aggregate metric value must be reconstructible as the sum of its
 * contributions.
 */
export interface MetricContribution {
  line: number;
  column?: number;
  /** Contribution kind, e.g. "if", "logical_and_group", "catch". */
  kind: string;
  /** Contribution value added to the metric total. */
  value: number;
  note?: string;
}

/** Cognitive complexity contribution (spec.md §16.4) — exact spec shape. */
export interface CognitiveContributionV1 {
  line: number;
  column?: number;
  kind: string;
  base: number;
  nestingPenalty: number;
  total: number;
  note?: string;
}

/** Full complexity snapshot for one scope (architecture.md §10.5). */
export interface ComplexitySnapshotV1 {
  snapshotId: string;
  scope: ComplexityScope;
  scopeId: string;
  repoId: string;
  refId: string;
  commitSha?: string;
  metricsVersion: string;
  /** ISO-8601; obtained via the Clock port. */
  measuredAt: string;
  parseQuality: ParseQuality;
  cyclomatic: {
    classic: number;
    extended: number;
    contributors: MetricContribution[];
  };
  /**
   * Cognitive complexity (spec.md §16.4). Contributors are stored in the
   * FULL spec shape (`CognitiveContributionV1`), because §16.4 requires that
   * every contribution carries source position, kind, base AND nesting share
   * ("jeder Beitrag MUSS Quellposition, Art, Basis und Nesting-Anteil
   * enthalten") — flattening base/nestingPenalty into a free-text note would
   * violate that requirement for the persisted snapshot.
   */
  cognitive: {
    value: number;
    algorithm: typeof COGNITIVE_ALGORITHM_ID;
    contributors: CognitiveContributionV1[];
  };
  /** Structural metrics, keys from spec.md §16.5 (e.g. "sloc", "max_nesting"). */
  structural: Record<string, number>;
  /** Textual/lexical metrics, keys from spec.md §16.6. */
  textual: Record<string, number>;
  /** Syntactic metrics, keys from spec.md §16.8. */
  syntactic: Record<string, number>;
  /** Halstead metrics, keys from spec.md §16.7 (n1, n2, N1, N2, volume, …). */
  halstead: Record<string, number>;
  /** Maintainability index per the exact formula in spec.md §16.9, in [0, 100]. */
  maintainabilityIndex: number;
  /**
   * The exact maintainability formula that produced `maintainabilityIndex`,
   * as a human-readable string. Persisted with the snapshot because spec.md
   * §16.9 requires: "Untangle MUSS die verwendete Formel explizit ausgeben".
   */
  maintainabilityFormula: string;
}

/**
 * Compact complexity summary attached to search results and change events
 * (spec.md §13.6). Untangle decision (spec leaves the shape open): the summary
 * mirrors the numeric payload fields of `CodeChunkPayloadV1` (spec.md §10.3)
 * plus the metrics scope needed for aggregation dedupe (spec.md §16.10).
 */
export interface ComplexitySummaryV1 {
  metricsScope: MetricsScope;
  metricsScopeId: string;
  metricsVersion: string;
  cyclomaticClassic?: number;
  cyclomaticExtended?: number;
  cognitive?: number;
  maxNesting?: number;
  sloc?: number;
  halsteadVolume?: number;
  maintainabilityIndex?: number;
  riskScore?: number;
}
