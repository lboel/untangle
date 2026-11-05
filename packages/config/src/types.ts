/**
 * Configuration types (spec.md §4.2–§4.8, §5.7; product.md §11; portfolio.md
 * §14.4; architecture.md §6.3, §23.2).
 *
 * These are the *raw*, *partial*-friendly shapes a `.untangle.json`,
 * environment layer or CLI argument object may contribute. The fully merged,
 * defaulted and validated shape produced by {@link "./load.js"} carries the
 * same interfaces but with all optional fields the product defaults fill in
 * actually present — see `EffectiveUntangleConfigV1` at the bottom of this
 * file.
 */
import type { ContextArtifactConfig, RepositoryConfig } from "@untangle-code/domain";

// Re-exported so consumers of @untangle-code/config never need to reach into
// @untangle-code/domain themselves for these two config-shaped types (domain
// README, decision 5: RepositoryConfig lives in domain by WP-01 order;
// ContextArtifactConfig likewise — this package re-exports rather than
// duplicating either).
export type { ContextArtifactConfig, ContextArtifactType } from "@untangle-code/domain";
export type { RepositoryConfig } from "@untangle-code/domain";

/** spec.md §4.4. */
export interface QdrantConfig {
  mode: "managed" | "external";
  url?: string;
  /** Name of the environment variable holding the API key — never the key itself (architecture.md §23.2). */
  apiKeyEnv?: string;
  collectionPrefix?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  upsertMaxPoints?: number;
  upsertBudgetBytes?: number;
}

/** spec.md §4.5. */
export interface EmbeddingConfig {
  provider: "ollama";
  mode: "auto" | "managed" | "external";
  url?: string;
  /** Name of the environment variable holding the API key — never the key itself (architecture.md §23.2). */
  apiKeyEnv?: string;
  model: string;
  dimensions: number;
  contextLength: number;
  queryPrefix: string;
  documentPrefix: string;
  includePath: boolean;
  batchSize: number;
  maxConnections: number;
  requestTimeoutMs: number;
}

/** spec.md §4.6. */
export interface IndexConfig {
  watch: boolean;
  reconcileIntervalMinutes: number;
  maxFileSizeMb: number;
  maxGraphFileSizeMb: number;
  scanConcurrency: number;
  embeddingConcurrency: number;
  filesPerCheckpoint: number;
  targetChunkTokens: number;
  maxChunkTokens: number;
  fallbackOverlapTokens: number;
  includeDotFiles: boolean;
  indexExtensionless: boolean;
  extraExtensions: string[];
  extensionLanguageMap: Record<string, string>;
}

/**
 * Search defaults (Untangle decision — spec.md §13 defines the request/result
 * shapes `SearchRequestV1`/`SearchResultV1` in domain, but names no
 * `SearchConfig` fields; this shape documents which of those request knobs
 * get a project-wide default and adds the boost weights spec.md §13.3 lists
 * without assigning default magnitudes).
 */
export interface SearchConfig {
  /** Default `limit` when a search request omits it. */
  defaultLimit: number;
  /** Default `candidateLimit` (pre-RRF/pre-filter pool size) when omitted. */
  defaultCandidateLimit: number;
  /** Hard ceiling a caller-supplied `candidateLimit` is clamped to. */
  maxCandidateLimit: number;
  /** Default `diversify` (MMR, architecture.md §18.5) when a request omits it. */
  diversifyByDefault: boolean;
  /** Default `minScore` when a request omits it. */
  minScoreDefault?: number;
  /**
   * Calibrated absence decisions, keyed by the exact embedding profile id.
   *
   * These values are deliberately optional and have no product default: raw
   * cosine scores are model-specific, and their useful separation also
   * depends on the indexed corpus. A policy therefore only applies when its
   * key, workspace id, and physical collection all match the active target.
   */
  relevancePolicies?: Record<string, SearchRelevancePolicyBindingConfigV1>;
  /** Relative weights of the additive score components (spec.md §13.3). */
  boostWeights: {
    exactSymbol: number;
    exactPath: number;
    repoPriority: number;
    graphProximity: number;
    recency: number;
    duplicatePenalty: number;
  };
}

/** Corpus binding for a calibrated search relevance policy (WP-231). */
export interface SearchRelevancePolicyBindingConfigV1 {
  /** Exact logical workspace used while calibrating the thresholds. */
  workspaceId: string;
  /** Exact physical vector collection used while calibrating the thresholds. */
  collection: string;
  policy: SearchRelevancePolicyConfigV1;
}

/** Config representation of the search engine's calibrated relevance policy (WP-231). */
export interface SearchRelevancePolicyConfigV1 {
  /** Human- and machine-readable provenance of the measurements behind the thresholds. */
  calibrationId: string;
  /** Absolute minimum cosine score of the strongest dense candidate, in [-1, 1]. */
  minimumDenseScore: number;
  /** Minimum difference between rank 1 and `denseReferenceRank`, in [0, 2]. */
  minimumDenseSpread: number;
  /** One-based dense rank used for the relative comparison; at least 2. */
  denseReferenceRank: number;
  /** Minimum IDF-weighted fraction of query evidence found together in one candidate. */
  minimumCandidateIdfCoverage: number;
}

/**
 * Graph traversal limits (Untangle decision — architecture.md §17.4 names
 * `maxDepth`/`maxNodes`/`maxEdges`/`maxWallTimeMs` as per-query traversal
 * limits without a config shape; this makes them project-configurable
 * defaults). `includeDynamicImports` reflects the `dynamic_import` edge kind
 * from spec.md §14.2 being switchable.
 */
export interface GraphConfig {
  enabled: boolean;
  maxTraversalDepth: number;
  maxTraversalNodes: number;
  maxTraversalEdges: number;
  maxTraversalWallTimeMs: number;
  includeDynamicImports: boolean;
}

/**
 * Complexity engine switches (Untangle decision — spec.md §16 defines the
 * metrics and algorithm IDs exhaustively but no `ComplexityConfig` shape;
 * product.md §11's example config uses `enabled` and `cognitiveAlgorithm`,
 * which anchor this shape). `cyclomaticVariant` selects which of classic
 * (§16.2) and extended (§16.3) get computed; both are cheap to compute
 * together so "both" is the default.
 */
export interface ComplexityConfig {
  enabled: boolean;
  /** Overridable for future algorithm versions; defaults to `COGNITIVE_ALGORITHM_ID` from domain. */
  cognitiveAlgorithm: string;
  cyclomaticVariant: "classic" | "extended" | "both";
  maintainabilityIndexEnabled: boolean;
}

/**
 * Change Intelligence configuration (Untangle decision — spec.md §17.6 gives
 * the default risk score weights and requires every component to be
 * disclosed with its weight and contribution, but does not name a config
 * type). Weights MUST sum to `1.0` within a `±0.001` tolerance, mirroring the
 * validation rule portfolio.md §14.4 states for `blueprint.weights`.
 */
export interface ChangeConfig {
  enabled: boolean;
  riskWeights: {
    churn: number;
    positiveCognitiveDelta: number;
    positiveCyclomaticDelta: number;
    blastRadius: number;
    graphCentrality: number;
    semanticChange: number;
    testDistance: number;
  };
  symbolMatching: {
    /** Minimum token/MinHash similarity (spec.md §17.3 step 4) to accept a rename/move candidate. */
    tokenSimilarityMin: number;
    /** Whether step 6 (embedding cosine at equal profile) participates at all. */
    enableEmbeddingSimilarity: boolean;
  };
}

/** spec.md §4.7. */
export interface QualityGateConfig {
  mode: "off" | "warn" | "fail";
  newCyclesAllowed: number;
  cognitivePerSymbolMax?: number;
  cognitiveDeltaPerSymbolMax?: number;
  cyclomaticPerSymbolMax?: number;
  cyclomaticDeltaPerSymbolMax?: number;
  maxNestingPerSymbolMax?: number;
  maintainabilityIndexMin?: number;
  riskScoreMax?: number;
  minimumParseQuality: "failed" | "partial" | "complete";
  ignoreExistingViolations: boolean;
  include?: string[];
  exclude?: string[];
}

/**
 * Telemetry (spec.md §24: "Telemetrie MUSS standardmäßig aus sein" — telemetry
 * MUST default to off; §23.2/§23.3 name the log/metrics facilities this
 * switches). Shape beyond `enabled` is an Untangle decision.
 */
export interface TelemetryConfig {
  /** Default `false` — local-first, opt-in only (spec.md §24). */
  enabled: boolean;
  logLevel: "error" | "warn" | "info" | "debug" | "trace";
  /** Whether internal counters (spec.md §23.3) are exported to an external system. */
  metricsExport: "none" | "prometheus";
}

/** portfolio.md §13. */
export interface PortfolioEnrichmentConfig {
  /** Default `false` — no registry/network access without opt-in (portfolio.md §13). */
  enabled: boolean;
  registries: ("npm" | "pypi" | "crates" | "maven" | "nuget" | "go" | "composer")[];
  registryUrls?: Record<string, string>;
  /** Default `168` (one week). */
  cacheTtlHours: number;
  timeoutMs: number;
}

/** portfolio.md §14.4 — normative shape. */
export interface PortfolioConfig {
  /** Default `true`. */
  enabled?: boolean;
  /** Default `false`. */
  includeTransitive?: boolean;
  /** Default `2`. */
  conventionMinRepos?: number;
  conventions?: {
    pinned?: string[];
    suppressed?: string[];
  };
  radar?: {
    /** Default `0.5`. */
    adoptShareMin?: number;
    /** Default `0.2`. */
    maintainShareMin?: number;
    /** Default `540`. */
    retireAfterDays?: number;
  };
  blueprint?: {
    weights?: {
      /** Default `0.40`. */
      adoption?: number;
      /** Default `0.20`. */
      recency?: number;
      /** Default `0.25`. */
      health?: number;
      /** Default `0.15`. */
      versionConsistency?: number;
    };
  };
  enrichment?: PortfolioEnrichmentConfig;
}

/**
 * Main configuration schema (spec.md §4.2), extended with `portfolio`
 * (portfolio.md §14.4, folded into `UntangleConfigV1` per portfolio.md
 * §18.1's planned spec.md §4.2 amendment).
 */
export interface UntangleConfigV1 {
  schemaVersion: 1;
  workspaceId?: string;
  projectId?: string;
  repositories?: RepositoryConfig[];
  qdrant?: QdrantConfig;
  embeddings?: EmbeddingConfig;
  index?: IndexConfig;
  search?: SearchConfig;
  graph?: GraphConfig;
  complexity?: ComplexityConfig;
  changes?: ChangeConfig;
  qualityGate?: QualityGateConfig;
  contextArtifacts?: ContextArtifactConfig[];
  telemetry?: TelemetryConfig;
  portfolio?: PortfolioConfig;
}

/** The set of `UntangleConfigV1` top-level keys, used to detect unknown fields (spec.md §4.8). */
export const UNTANGLE_CONFIG_V1_KEYS = [
  "schemaVersion",
  "workspaceId",
  "projectId",
  "repositories",
  "qdrant",
  "embeddings",
  "index",
  "search",
  "graph",
  "complexity",
  "changes",
  "qualityGate",
  "contextArtifacts",
  "telemetry",
  "portfolio",
] as const satisfies readonly (keyof UntangleConfigV1)[];

/**
 * Recursively makes every field of `T` optional, including inside array
 * elements. Used for {@link RawConfigLayer}: a single JSON file, an env-var
 * layer, or an `explicit` argument object commonly sets only a handful of
 * leaves inside a nested config section (e.g. just `qdrant.collectionPrefix`)
 * — a shallow `Partial<T>` would still require every OTHER field of
 * `QdrantConfig` once `qdrant` is present at all, which is not how any of
 * the six layers in spec.md §4.1 are actually written. Runtime validation
 * (`validate.ts`) is what enforces which fields are truly required once all
 * layers are merged with the product defaults.
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * A raw configuration layer as read from JSON, environment mapping or passed
 * explicitly: every field optional (deeply — see {@link DeepPartial}),
 * `schemaVersion` not required (defaults are applied and validated later).
 * `$schema` is accepted and ignored (spec.md §11's example config carries it).
 */
export type RawConfigLayer = {
  $schema?: string;
  schemaVersion?: number;
} & DeepPartial<Omit<UntangleConfigV1, "schemaVersion">>;

/**
 * The fully merged, defaulted and validated configuration
 * ({@link "./load.js"}'s `loadConfig` result). All fields the product
 * defaults (spec.md §4.5, this package's `defaults.ts`) supply are guaranteed
 * present; `repositories` and `contextArtifacts` stay optional because they
 * have no universal default (spec.md §4.3: the current project path MAY
 * serve as an implicit single repository instead).
 */
export interface EffectiveUntangleConfigV1 extends UntangleConfigV1 {
  schemaVersion: 1;
  qdrant: QdrantConfig;
  embeddings: EmbeddingConfig;
  index: IndexConfig;
  search: SearchConfig;
  graph: GraphConfig;
  complexity: ComplexityConfig;
  changes: ChangeConfig;
  qualityGate: QualityGateConfig;
  telemetry: TelemetryConfig;
  portfolio: PortfolioConfig;
}
