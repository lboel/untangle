/**
 * Local result contracts for the complexity calculators (spec.md §16,
 * architecture.md §15.2). These are NOT domain types: domain fixes the
 * *stored* shapes (`ComplexitySnapshotV1`, `ComplexitySummaryV1`,
 * `CognitiveContributionV1`, `MetricContribution`); this module fixes the
 * richer *calculator output* shapes that `assemble.ts` folds into those
 * stored shapes. See README "Entscheidungen" for the mapping rules.
 */
import type { CognitiveContributionV1, MetricContribution } from "@untangle-code/domain";

/**
 * One cyclomatic decision contribution. Structurally a `MetricContribution`
 * (so it can be stored directly in `ComplexitySnapshotV1.cyclomatic.contributors`)
 * plus the two spec.md §16.2/§16.3 membership flags that tell which of the two
 * totals (classic/extended) this contribution feeds.
 */
export interface CyclomaticContribution extends MetricContribution {
  countsForClassic: boolean;
  countsForExtended: boolean;
}

/** Output of `computeCyclomatic` (spec.md §16.2, §16.3). */
export interface CyclomaticResult {
  classic: number;
  extended: number;
  /** Superset list (extended ⊇ classic); filter by the membership flags. */
  contributions: CyclomaticContribution[];
  algorithmVersion: string;
}

/** Output of `computeCognitive` (spec.md §16.4, algorithm `untangle-cognitive-v1`). */
export interface CognitiveResult {
  value: number;
  algorithm: string;
  contributions: CognitiveContributionV1[];
}

/**
 * Coupling and API-surface inputs that require whole-repository graph or
 * export/visibility knowledge the facts-only calculators do not have. Every
 * field is optional and is only ever included in the output when supplied
 * here — never guessed or defaulted (per the work order).
 */
export interface StructuralExternalInput {
  fanIn?: number;
  fanOut?: number;
  afferentCoupling?: number;
  efferentCoupling?: number;
  /** Used as-is when given; otherwise derived from afferent/efferent when both are present. */
  instability?: number;
  importInDegree?: number;
  importOutDegree?: number;
  inheritanceDepth?: number;
  publicApiCount?: number;
}

/** Envelope every non-cyclomatic/cognitive calculator returns (uniform API, spec.md §16.5–§16.8). */
export interface MetricsResult {
  metrics: Record<string, number>;
  algorithmVersion: string;
}

/** Output of `computeHalstead` (spec.md §16.7). */
export interface HalsteadResult {
  metrics: Record<string, number>;
  /** Present only when `options.includeEstimates` is set; explicitly labeled as estimates. */
  estimates?: {
    /** Estimated time to implement, in seconds (Halstead's Stroud-number-18 heuristic). */
    timeSeconds: number;
    /** Estimated defect count (`volume / 3000`, Halstead's heuristic). */
    estimatedBugs: number;
  };
  algorithmVersion: string;
}

/** Output of `computeMaintainability` (spec.md §16.9). */
export interface MaintainabilityResult {
  /** Clamped to [0, 100]. */
  value: number;
  /** Unclamped `MI_raw` before the `* 100 / 171` rescale, for debugging/explain. */
  raw: number;
  /** The exact formula used, as required by the work order. */
  formula: string;
  algorithmVersion: string;
}

/** One value to aggregate (spec.md §16.10). */
export interface AggregationEntry {
  /** Dedupe key — duplicate ids are folded to a single sample (first occurrence wins). */
  metricsScopeId: string;
  value: number;
  /** SLOC of the scope this value came from, for the SLOC-weighted mean. */
  sloc?: number;
}

/** Result of `aggregate()` (spec.md §16.10). */
export interface AggregationResult {
  count: number;
  sum: number;
  mean: number;
  median: number;
  max: number;
  p90: number;
  p95: number;
  /** Undefined when no entry carried an `sloc`. */
  slocWeightedMean?: number;
  /** Number of (deduplicated) entries whose value is strictly greater than each configured threshold, keyed by the threshold's decimal string. */
  thresholdCounts: Record<string, number>;
  /** Number of raw entries dropped because their `metricsScopeId` repeated an earlier one. */
  duplicatesDropped: number;
}

/** One line of `explainSymbol`'s ranked, human-readable breakdown. */
export interface ExplainEntry {
  rank: number;
  metric: "cyclomatic" | "cognitive";
  kind: string;
  line: number;
  value: number;
  text: string;
}
