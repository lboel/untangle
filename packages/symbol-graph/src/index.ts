/**
 * @untangle-code/symbol-graph — der Symbolgraph von Untangle (spec.md §15,
 * architecture.md §17).
 *
 * Er beantwortet drei Fragen: wer ruft dieses Symbol, was ruft es, und welcher
 * Weg fuehrt von einem Einstiegspunkt hierher. Rein und deterministisch: kein
 * I/O, keine Uhr, kein Zufall — eine Zeitquelle wird uebergeben, wenn ein
 * Zeitbudget gelten soll. Dieses Modul ist der EINZIGE oeffentliche Ausgang
 * des Pakets.
 */

// Vertragstypen (Ein- und Ausgabe).
export { ENTRY_POINT_KINDS, CALL_PATH_MISS_REASONS } from "./types.js";
export type {
  AllCallPathsResultV1,
  AllCallPathsTruncationReason,
  CallPathMissReason,
  CallPathV1,
  EntryPointDetectionOptions,
  EntryPointKind,
  EntryPointSetV1,
  EntryPointSignalV1,
  EntryPointV1,
  ImpactResultV1,
  ImpactedSymbolV1,
  ResolvedImportTargetV1,
  ShortestCallPathResultV1,
  SymbolBindingV1,
  SymbolGraphBuildInput,
  SymbolGraphBuildOptions,
  SymbolGraphFileInput,
  SymbolGraphMetricsV1,
  SymbolGraphTraversalV1,
  SymbolGraphV1,
} from "./types.js";

// Aufbau.
export { buildSymbolGraph, buildImportBindings, findEnclosingSymbol } from "./build.js";
export { buildFileSymbolNodes, sliceSourceBytes } from "./nodes.js";
export type { FileSymbolNodesResult } from "./nodes.js";

// Bruecke zum Dateigraphen (gegen den Domaintyp, nicht gegen das Paket).
export { resolvedImportsFromFileEdges } from "./file-graph-bridge.js";

// Bruecke zum Parser.
export { collectSymbolGraphFile, collectSymbolGraphFiles } from "./collect.js";
export type { CollectSymbolGraphFileInput, CollectSymbolGraphFileResult } from "./collect.js";

// Aufloesung.
export {
  RESOLUTION_DEFAULTS,
  buildSymbolNameIndex,
  resolveCall,
  weightCandidates,
  withResolutionDefaults,
} from "./resolve.js";
export type {
  CallResolutionContext,
  CallResolutionOutcome,
  SymbolNameIndex,
  WeightedCandidate,
} from "./resolve.js";

// Bindungen und Nachbarschaft.
export { bindingsOfEdge, weakerResolution } from "./bindings.js";
export { createSymbolGraphIndex } from "./graph-index.js";
export type { SymbolGraphIndex } from "./graph-index.js";

// Traversierung, Pfade, Impact, Einstiegspunkte.
export { bindingsInDirection, traverseSymbolGraph } from "./traverse.js";
export type { TraverseSymbolGraphOptions } from "./traverse.js";
export { findAllCallPaths, findShortestCallPath, toCallPath } from "./paths.js";
export type { AllCallPathsOptions, ShortestCallPathOptions } from "./paths.js";
export { analyzeImpact } from "./impact.js";
export type { AnalyzeImpactOptions } from "./impact.js";
export {
  DEFAULT_CONVENTIONAL_ENTRY_NAMES,
  DEFAULT_ROUTE_DIRECTORY_SEGMENTS,
  DEFAULT_TEST_PATH_MARKERS,
  ENTRY_POINT_WEIGHTS,
  MAX_ENTRY_POINT_CONFIDENCE,
  combineEntryPointWeights,
  detectEntryPoints,
} from "./entry-points.js";

// Kennzahlen.
export { TOP_CALLED_LIMIT, computeSymbolGraphMetrics } from "./metrics.js";
export type { SymbolGraphMetricsInput } from "./metrics.js";

// Workspace- und generationssichere Ablage ueber den bestehenden GraphStore-Port.
export {
  LEGACY_SYMBOL_GRAPH_SHARD_ID,
  SYMBOL_GRAPH_SHARD_NAMESPACE,
  readSymbolGraphSnapshot,
  symbolGraphSnapshotShardId,
  toSymbolGraphShard,
  writeSymbolGraphSnapshot,
} from "./persistence.js";
export type {
  SymbolGraphSnapshotReadIssue,
  SymbolGraphSnapshotReadOptions,
  SymbolGraphSnapshotReadResult,
  SymbolGraphSnapshotScope,
} from "./persistence.js";
