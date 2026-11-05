/**
 * Product defaults (spec.md §4.5 "Defaultprofil für MVP"; product.md §11).
 *
 * These are layer 6 (lowest priority) of spec.md §4.1's six-level layering.
 * Every field an `EffectiveUntangleConfigV1` guarantees present is defaulted
 * here.
 */
import { COGNITIVE_ALGORITHM_ID } from "@untangle-code/domain";

import type {
  ChangeConfig,
  ComplexityConfig,
  EmbeddingConfig,
  GraphConfig,
  IndexConfig,
  PortfolioConfig,
  QdrantConfig,
  QualityGateConfig,
  RawConfigLayer,
  SearchConfig,
  TelemetryConfig,
} from "./types.js";

/**
 * Embedding profile fields that are NOT part of `EmbeddingConfig` (spec.md
 * §4.5 lists exactly ten fields, none of them `normalization` or
 * `preparedTextVersion`) but ARE required inputs to
 * `buildEmbeddingProfileId` (spec.md §5.7). Untangle decision: default
 * normalization to "none" (no vector post-processing) and mint an explicit
 * prepared-text format version so a future change to how document text is
 * assembled can roll `embedding_profile_id` forward deliberately.
 */
export const DEFAULT_EMBEDDING_NORMALIZATION = "none" as const;
export const PREPARED_TEXT_VERSION = "untangle-prepared-text-v1" as const;

/** spec.md §4.5 "Defaultprofil für MVP" — Ollama, nomic-embed-text, 768 dims. */
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: "ollama",
  mode: "auto",
  model: "nomic-embed-text",
  dimensions: 768,
  contextLength: 2048,
  queryPrefix: "search_query: ",
  documentPrefix: "search_document: ",
  includePath: true,
  batchSize: 32,
  maxConnections: 4,
  requestTimeoutMs: 120000,
};

/**
 * Qdrant defaults. spec.md §4.4 defines the shape but not default values;
 * `managed` mode with no explicit `url` matches product.md §4.1's
 * zero-config narrative (the CLI starts a managed container and fills `url`
 * in from that at runtime — this package only supplies the mode default).
 */
export const DEFAULT_QDRANT_CONFIG: QdrantConfig = {
  mode: "managed",
  collectionPrefix: "untangle_",
  requestTimeoutMs: 30000,
  maxRetries: 3,
  upsertMaxPoints: 256,
  upsertBudgetBytes: 4 * 1024 * 1024,
};

/** spec.md §4.6; numeric defaults are an Untangle decision, chosen conservatively. */
export const DEFAULT_INDEX_CONFIG: IndexConfig = {
  watch: true,
  reconcileIntervalMinutes: 30,
  maxFileSizeMb: 5,
  maxGraphFileSizeMb: 20,
  scanConcurrency: 8,
  embeddingConcurrency: 4,
  filesPerCheckpoint: 200,
  targetChunkTokens: 900,
  maxChunkTokens: 1500,
  fallbackOverlapTokens: 100,
  includeDotFiles: false,
  indexExtensionless: false,
  extraExtensions: [],
  extensionLanguageMap: {},
};

/** Untangle decision (see `types.ts` `SearchConfig` doc comment). */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  defaultLimit: 10,
  defaultCandidateLimit: 50,
  maxCandidateLimit: 200,
  diversifyByDefault: false,
  boostWeights: {
    exactSymbol: 0.15,
    exactPath: 0.1,
    repoPriority: 0.05,
    graphProximity: 0.1,
    recency: 0.05,
    duplicatePenalty: 0.2,
  },
};

/** Untangle decision, values taken from architecture.md §17.4's per-query limits. */
export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  enabled: true,
  maxTraversalDepth: 20,
  maxTraversalNodes: 2000,
  maxTraversalEdges: 4000,
  maxTraversalWallTimeMs: 5000,
  includeDynamicImports: true,
};

/** Untangle decision (see `types.ts` `ComplexityConfig` doc comment). */
export const DEFAULT_COMPLEXITY_CONFIG: ComplexityConfig = {
  enabled: true,
  cognitiveAlgorithm: COGNITIVE_ALGORITHM_ID,
  cyclomaticVariant: "both",
  maintainabilityIndexEnabled: true,
};

/** spec.md §17.6 default risk score weights. */
export const DEFAULT_CHANGE_CONFIG: ChangeConfig = {
  enabled: true,
  riskWeights: {
    churn: 0.25,
    positiveCognitiveDelta: 0.2,
    positiveCyclomaticDelta: 0.15,
    blastRadius: 0.15,
    graphCentrality: 0.1,
    semanticChange: 0.1,
    testDistance: 0.05,
  },
  symbolMatching: {
    tokenSimilarityMin: 0.6,
    enableEmbeddingSimilarity: true,
  },
};

/** spec.md §4.7 shape; MVP defaults chosen deliberately permissive (warn, not fail). */
export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  mode: "warn",
  newCyclesAllowed: 0,
  minimumParseQuality: "partial",
  ignoreExistingViolations: true,
};

/** spec.md §24: "Telemetrie MUSS standardmäßig aus sein." */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: false,
  logLevel: "info",
  metricsExport: "none",
};

/** portfolio.md §14.4 defaults, spelled out explicitly. */
export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  enabled: true,
  includeTransitive: false,
  conventionMinRepos: 2,
  radar: {
    adoptShareMin: 0.5,
    maintainShareMin: 0.2,
    retireAfterDays: 540,
  },
  blueprint: {
    weights: {
      adoption: 0.4,
      recency: 0.2,
      health: 0.25,
      versionConsistency: 0.15,
    },
  },
  enrichment: {
    enabled: false,
    registries: [],
    cacheTtlHours: 168,
    timeoutMs: 10000,
  },
};

/** Current config schema version this package produces and validates against. */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * The complete product-default layer (spec.md §4.1 layer 6, lowest
 * priority). Every optional sub-config `EffectiveUntangleConfigV1`
 * guarantees present is defaulted here; `repositories` and
 * `contextArtifacts` are deliberately absent (spec.md §4.3: no universal
 * default repository set exists).
 */
export const PRODUCT_DEFAULT_CONFIG: RawConfigLayer = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  qdrant: DEFAULT_QDRANT_CONFIG,
  embeddings: DEFAULT_EMBEDDING_CONFIG,
  index: DEFAULT_INDEX_CONFIG,
  search: DEFAULT_SEARCH_CONFIG,
  graph: DEFAULT_GRAPH_CONFIG,
  complexity: DEFAULT_COMPLEXITY_CONFIG,
  changes: DEFAULT_CHANGE_CONFIG,
  qualityGate: DEFAULT_QUALITY_GATE_CONFIG,
  telemetry: DEFAULT_TELEMETRY_CONFIG,
  portfolio: DEFAULT_PORTFOLIO_CONFIG,
};
