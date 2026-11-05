/**
 * @untangle-code/complexity — the complexity engine (spec.md §16,
 * architecture.md §6.7, §15). Pure, deterministic calculators over
 * `ComplexityFacts`/`ComplexityIRNode` from `@untangle-code/domain`; no I/O,
 * no parser-registry, no embeddings. This module is the ONLY public export
 * of the package.
 */

// Scoping/text utilities shared across calculators.
export {
  containsRange,
  rangeKey,
  selectSymbolFacts,
  sliceByRange,
  splitLines,
  strictlyContainsRange,
} from "./scope.js";
export { classifyLines, scopeLines } from "./text-lines.js";
export { shannonEntropy, frequenciesOf } from "./entropy.js";
export { classifyNodeKind, isAsyncNodeKind, isExceptionNodeKind } from "./node-kind-heuristics.js";
export type { NodeKindClass } from "./node-kind-heuristics.js";

// IR producer: ComplexityFacts -> ComplexityIRNode bridge (architecture.md §6.7).
export { buildSymbolIR } from "./ir/build-ir.js";
export type { BuildSymbolIROptions } from "./ir/build-ir.js";

// Calculators (architecture.md §15.2).
export { computeCyclomatic } from "./cyclomatic.js";
export { computeCognitive, assertCognitiveInvariant } from "./cognitive.js";
export { computeStructural } from "./structural.js";
export { computeTextual } from "./textual.js";
export { computeSyntactic } from "./syntactic.js";
export { computeHalstead } from "./halstead.js";
export type { HalsteadOptions } from "./halstead.js";
export { computeMaintainability, MAINTAINABILITY_FORMULA } from "./maintainability.js";
export type { MaintainabilityInput } from "./maintainability.js";
export { aggregate } from "./aggregator.js";
// Aggregation ueber den Scope-Baum, ohne Doppelzaehlung (WP-82).
export {
  aggregateScopeTree,
  assertScopeTreeInvariants,
  checkAllScopeCoverage,
  checkScopeCoverage,
  checkScopeTreeInvariants,
  checkSelectionCoverage,
  selectionForReading,
  selectScopeEntries,
  SCOPE_INVARIANT_CODES,
  SCOPE_SUM_READINGS,
} from "./scope-aggregate.js";
export type {
  ScopeInvariantCode,
  ScopeInvariantViolationV1,
  ScopeMetricNodeV1,
  ScopeSelectionKind,
  ScopeSelectionV1,
  ScopeSumReading,
  ScopeTreeAggregateV1,
  ScopeTreeOptions,
} from "./scope-aggregate.js";
// Eindeutige Scope-Ids als Voraussetzung der Dedupe ueber metricsScopeId (WP-82).
export { withUniqueScopeIds } from "./scope-identity.js";
export type { ScopeIdCollisionV1, UniqueScopeIdsResultV1 } from "./scope-identity.js";
// Prosa-Metriken als EIGENE Familie (vision.md §1c, WP-217). Ihre Werte sind
// `ProseNumberV1`-Objekte und koennen deshalb strukturell nie in eine
// Code-Metrik-Summe geraten.
export { computeProseMetrics, compareProseByStructureLoad } from "./prose/metrics.js";
export type { ProseLinkResolver, ProseMetricsOptions } from "./prose/metrics.js";
export { explainSymbol } from "./explain.js";
export { assembleComplexitySnapshot } from "./assemble.js";
export type { SnapshotContext, SnapshotParts } from "./assemble.js";

// Local result contracts (not domain types — see types.ts docs).
export type {
  AggregationEntry,
  AggregationResult,
  CognitiveResult,
  CyclomaticContribution,
  CyclomaticResult,
  ExplainEntry,
  HalsteadResult,
  MaintainabilityResult,
  MetricsResult,
  StructuralExternalInput,
} from "./types.js";
