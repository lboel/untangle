/**
 * @untangle-code/core — die Pipeline des Indexlaufs.
 *
 * Dieses Paket ist das VERBINDUNGSSTUECK, das `packages/jobs/src/stages.ts`
 * seit jeher ankuendigt: es implementiert die dort definierten Stufen
 * (`InfrastructureStage`, `DiscoveryStage`, `AnalysisStage`, `EmbeddingStage`,
 * `StorageStage`, `GraphStage`, `GenerationCommitStage`) gegen die echten
 * Adapter — Scanner, Parser-Registry, Chunker, Komplexitaetsmodul,
 * Einbettungsanbieter, Vektorspeicher, Datei- und Symbolgraph — und reicht sie
 * dem `IndexJobRunner`.
 *
 * ES ENTSCHEIDET NICHTS UEBER ADAPTER. Welcher Einbetter, welcher Speicher,
 * welches Repository — all das kommt von aussen herein. Deshalb laeuft
 * derselbe Code gegen einen echten Vektorspeicher und gegen einen im Prozess,
 * gegen ein echtes Sprachmodell und gegen den netzlosen Einbetter dieses
 * Pakets.
 *
 * Dieses Modul ist der EINZIGE oeffentliche Export des Pakets.
 */
export * from "./types.js";
export * from "./cancellation.js";
export * from "./collected.js";
export * from "./ledger.js";
export * from "./skip-reasons.js";
export * from "./offline-embedder.js";
export * from "./pipeline.js";
export * from "./plan.js";
export * from "./engine.js";
// Additiver Kompatibilitaetsname fuer Konsumenten, die die gebaute
// Stufen-Pipeline explizit statt des vollstaendigen Laufs verwenden.
export { createIndexStages as createIndexPipeline } from "./pipeline.js";
export { createDiscoveryStage, createDiscoveryState } from "./stages/discovery.js";
export type { DiscoveryStateV1, DiscoveryStageDeps } from "./stages/discovery.js";
export { createAnalysisStage } from "./stages/analysis.js";
export type { AnalysisStageDeps } from "./stages/analysis.js";
export { createEmbeddingStage } from "./stages/embedding.js";
export type { EmbeddingStageDeps } from "./stages/embedding.js";
export { createStorageStage } from "./stages/storage.js";
export type { StorageStageDeps } from "./stages/storage.js";
export { createGraphStage } from "./stages/graphs.js";
/** @deprecated Legacy global shard ID; new writes use workspace-namespaced IDs. */
export { LEGACY_SYMBOL_GRAPH_SHARD_ID as SYMBOL_GRAPH_SHARD_ID } from "@untangle-code/symbol-graph";
export type { GraphStageDeps } from "./stages/graphs.js";
export { createInfrastructureStage, redactUrl } from "./stages/infrastructure.js";
export type { InfrastructureStageDeps } from "./stages/infrastructure.js";
export { createCommitStage } from "./stages/commit.js";
export type { CommitStageDeps } from "./stages/commit.js";
export { analyzeProductAlignment, runProductTests } from "./product-alignment/index.js";
export type {
  ProductAlignmentOptionsV1,
  ProductTestRunOptionsV1,
  ProductTestRunResultV1,
  ProductTestProcessRequestV1,
  ProductTestProcessResultV1,
} from "./product-alignment/index.js";
export * from "./frontend-boundaries/index.js";
export * from "./sdd-connectors/index.js";
