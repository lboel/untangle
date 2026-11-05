/**
 * Portfolio intelligence contracts (portfolio.md §7, §12.2, §14.2).
 *
 * These types are fixed in domain (docs/BUILD_PLAN.md §3.4) so that WP-22
 * (portfolio) and its consumers build against the same shapes without drift.
 */
import type {
  ARCHETYPE_CLASSIFIER_VERSION,
  BLUEPRINT_ADVISOR_VERSION,
  RADAR_VERSION,
} from "../versions.js";

import type { SupportLevel } from "./common.js";
import type { JobEvent } from "./job.js";

// ---------------------------------------------------------------------------
// Shared building blocks (portfolio.md §7)
// ---------------------------------------------------------------------------

/** Evidence kind of a provenance entry (portfolio.md §7). */
export type PortfolioEvidenceKind =
  | "manifest"
  | "lockfile"
  | "config"
  | "import_graph"
  | "symbol_graph"
  | "ci"
  | "container"
  | "iac"
  | "change_history"
  | "heuristic";

/** Provenance of a portfolio fact (portfolio.md §7) — exact spec shape. */
export interface PortfolioProvenanceV1 {
  workspaceId: string;
  repoId: string;
  refId: string;
  commitSha?: string;
  /** Repo-relative path, "/"-normalized. */
  sourceFile: string;
  startLine?: number;
  endLine?: number;
  /** e.g. "npm.dependencies" (portfolio.md §6.3). */
  detectorId: string;
  /** e.g. "portfolio-detect-v1". */
  detectorVersion: string;
  evidenceKind: PortfolioEvidenceKind;
}

/** Confidence of a portfolio fact (portfolio.md §7) — exact spec shape. */
export interface PortfolioConfidenceV1 {
  /** [0, 1]. */
  value: number;
  basis: "deterministic" | "heuristic";
  /** Participating detector ids. */
  signals: string[];
}

// ---------------------------------------------------------------------------
// Technology records (portfolio.md §7.1)
// ---------------------------------------------------------------------------

/** Usage classification of a technology in a repository (portfolio.md §7.1). */
export type TechnologyUsage =
  "runtime" | "dev" | "build" | "test" | "ci" | "infra" | "peer" | "optional" | "transitive";

/** Where a version value came from (portfolio.md §7.1). */
export type TechnologyVersionSource = "manifest" | "lockfile" | "runtime_file" | "import_only";

/** One detected technology in exactly one repository/ref (portfolio.md §7.1). */
export interface TechnologyRecordV1 {
  schemaVersion: 1;
  /** tech_record_id. */
  recordId: string;
  technologyId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  generationId: string;

  /** canonical_name (portfolio.md §5). */
  name: string;
  /** Original spelling. */
  displayName?: string;
  /** Category (portfolio.md §6.1). */
  category: string;
  ecosystem?: string;
  /** From portfolio-domain-map-v1, otherwise absent. */
  problemDomain?: string;

  /** As declared, e.g. "^18.2.0". */
  versionRaw?: string;
  /** From lockfile, e.g. "18.3.1". */
  versionResolved?: string;
  versionComparable: boolean;
  versionSource?: TechnologyVersionSource;

  usage: TechnologyUsage;
  /** Declared but no import evidence. */
  declaredOnly: boolean;
  /** Import evidence without declaration (phantom dependency). */
  importOnly: boolean;
  /** From the file graph; 0 when not applicable. */
  importingFileCount: number;

  /** ISO-8601, from change history; absent without history — never estimated. */
  firstSeenAt?: string;
  lastSeenAt?: string;

  /** At least one entry — records without provenance are invalid. */
  provenance: PortfolioProvenanceV1[];
  confidence: PortfolioConfidenceV1;
}

// ---------------------------------------------------------------------------
// Repository profile (portfolio.md §7.2)
// ---------------------------------------------------------------------------

export interface RepositoryHealthV1 {
  /** From the complexity engine. */
  metricsVersion: string;
  measuredAt: string;
  maintainabilityIndexMedian?: number;
  cognitiveP90?: number;
  cyclomaticP90?: number;
  dependencyCycleCount?: number;
  /** Share of files above the hotspot threshold, [0, 1]. */
  hotspotShare?: number;
  unresolvedImportRatio?: number;
  parseFailureRatio?: number;
  /** e.g. "no complexity index for ref". */
  caveats: string[];
}

export interface LanguageShareV1 {
  language: string;
  supportLevel: SupportLevel;
  fileCount: number;
  /** [0, 1]. */
  slocShare: number;
}

export interface RepositoryProfileV1 {
  schemaVersion: 1;
  profileId: string;
  workspaceId: string;
  repoId: string;
  repoLabel: string;
  refId: string;
  commitSha?: string;
  generationId: string;
  /** "untangle-portfolio-v1". */
  analyzerVersion: string;
  generatedAt: string;

  languages: LanguageShareV1[];
  /** References to TechnologyRecordV1. */
  technologyRecordIds: string[];
  runtimeSummary: { name: string; versionRange?: string }[];
  packageManagers: string[];

  /** Reference to ArchetypeV1. */
  archetypeId?: string;
  matchedConventionIds: string[];
  violatedConventionIds: string[];

  health?: RepositoryHealthV1;

  /**
   * Incomplete profiles (manifestsFailed > 0 or missing sources) must be
   * recognizable; derived outputs carry the incompleteness as warnings.
   */
  completeness: {
    manifestsFound: number;
    manifestsParsed: number;
    manifestsFailed: number;
    importGraphAvailable: boolean;
    changeHistoryAvailable: boolean;
    complexityAvailable: boolean;
  };
}

// ---------------------------------------------------------------------------
// Stack matrix (portfolio.md §7.3)
// ---------------------------------------------------------------------------

export interface StackMatrixEntryV1 {
  technologyId: string;
  name: string;
  category: string;
  ecosystem?: string;
  problemDomain?: string;

  adoption: {
    repoCount: number;
    /** repoCount / analyzed repos. */
    repoShare: number;
    repoIds: string[];
  };

  versionSpread: {
    /** versionResolved, otherwise versionRaw. */
    distinctVersions: string[];
    byRepo: Record<string, string | null>;
    /** max(major) - min(major) over comparable versions. */
    majorSpread: number;
    comparable: boolean;
  };

  usageDepth: {
    importingFilesByRepo: Record<string, number>;
    declaredOnlyRepos: string[];
    importOnlyRepos: string[];
  };

  firstSeenAt?: string;
  lastSeenAt?: string;

  /** Minimum over participating records. */
  confidence: PortfolioConfidenceV1;
}

export interface StackMatrixV1 {
  schemaVersion: 1;
  matrixId: string;
  workspaceId: string;
  generationId: string;
  generatedAt: string;
  analyzerVersion: string;
  repositories: { repoId: string; refId: string; profileId: string }[];
  entries: StackMatrixEntryV1[];
  /** e.g. incomplete profiles. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Conventions (portfolio.md §7.4)
// ---------------------------------------------------------------------------

export type ConventionRuleKind =
  | "path_exists"
  | "path_layout"
  | "naming_pattern"
  | "dependency_present"
  | "layering"
  | "symbol_pattern"
  | "config_pattern";

export type ConventionKind =
  | "directory_layout"
  | "layering"
  | "naming"
  | "test_setup"
  | "error_handling"
  | "config_handling"
  | "logging";

export interface ConventionRuleV1 {
  ruleKind: ConventionRuleKind;
  /** Canonical JSON; basis of the rule fingerprint (portfolio.md §8.3). */
  expression: Record<string, unknown>;
  /** English short form, e.g. "tests are co-located as *.test.ts". */
  humanReadable: string;
}

export interface ConventionCounterexampleV1 {
  repoId: string;
  provenance: PortfolioProvenanceV1;
  note?: string;
}

export interface ConventionV1 {
  schemaVersion: 1;
  conventionId: string;
  workspaceId: string;
  generationId: string;
  kind: ConventionKind;
  title: string;
  description: string;
  rule: ConventionRuleV1;

  evidence: {
    /** Repos the rule applies to. */
    applicableRepos: string[];
    supportingRepos: string[];
    /** Matches across all repos. */
    matchCount: number;
    counterexamples: ConventionCounterexampleV1[];
    /** Max. 20 sample evidence locations. */
    sampleProvenance: PortfolioProvenanceV1[];
  };

  confidence: PortfolioConfidenceV1;
  detectorId: string;
  detectorVersion: string;
  heuristic: boolean;
}

// ---------------------------------------------------------------------------
// Archetypes (portfolio.md §7.5)
// ---------------------------------------------------------------------------

export type ArchetypeName =
  | "layered_service"
  | "hexagonal_service"
  | "modular_monolith"
  | "api_service"
  | "worker"
  | "cli_tool"
  | "library"
  | "frontend_app"
  | "mcp_server"
  | "infra_repo"
  | "monorepo_root"
  | "unclassified";

export interface ArchetypeSignalV1 {
  /** e.g. "npm.bin_field". */
  signalId: string;
  description: string;
  weight: number;
  matched: boolean;
  /** weight when matched, otherwise 0. */
  contribution: number;
  provenance?: PortfolioProvenanceV1;
  heuristic: boolean;
}

export interface ArchetypeV1 {
  schemaVersion: 1;
  archetypeId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  generationId: string;
  classifierVersion: typeof ARCHETYPE_CLASSIFIER_VERSION;

  archetype: ArchetypeName;

  /** Sum of contributions, normalized to [0, 1]; < 0.30 forces "unclassified". */
  score: number;
  /** Descending, max. 3. */
  alternatives: { archetype: ArchetypeName; score: number }[];
  /** Complete list incl. unmatched mandatory signals — never omitted. */
  signals: ArchetypeSignalV1[];
  confidence: PortfolioConfidenceV1;
}

// ---------------------------------------------------------------------------
// Blueprints (portfolio.md §7.6, §7.7)
// ---------------------------------------------------------------------------

export type BlueprintKind = "api-service" | "worker" | "cli" | "library" | "web-app" | "mcp-server";

export interface BlueprintDirectoryEntryV1 {
  /** Relative layout entry, e.g. "src/domain/". */
  path: string;
  kind: "directory" | "file";
  purpose: string;
  /** Convention the entry derives from. */
  sourceConventionId?: string;
}

export interface BlueprintDependencyV1 {
  technologyId: string;
  name: string;
  ecosystem: string;
  /** Concrete recommended version from the portfolio. */
  version: string;
  usage: "runtime" | "dev";
  /** Justification reference — mandatory. */
  recommendationId: string;
}

export interface BlueprintFileV1 {
  path: string;
  /** Versioned internal template id. */
  templateId: string;
  /** SHA-256 of the generated content. */
  contentPreviewHash: string;
  sizeBytes: number;
}

export interface BlueprintV1 {
  schemaVersion: 1;
  blueprintId: string;
  workspaceId: string;
  generationId: string;
  advisorVersion: typeof BLUEPRINT_ADVISOR_VERSION;
  generatedAt: string;

  kind: BlueprintKind;
  language: string;
  runtime: { name: string; versionRange: string };

  directoryLayout: BlueprintDirectoryEntryV1[];
  dependencies: BlueprintDependencyV1[];
  /** build/test/lint, usage "dev". */
  toolchain: BlueprintDependencyV1[];
  testSetup: { framework: string; layout: string; recommendationId: string };
  ciSkeleton: { system: string; workflowFiles: string[]; recommendationId: string };

  appliedConventionIds: string[];
  /** All BlueprintRecommendationV1 ids. */
  recommendationIds: string[];
  /** Only present for scaffolding preview/application. */
  files?: BlueprintFileV1[];

  evidenceSummary: {
    reposConsidered: number;
    /** Repos of the same archetype as primary evidence source. */
    reposMatchingKind: string[];
    portfolioGenerationId: string;
  };
  warnings: string[];
}

export type RecommendationComponentName = "adoption" | "recency" | "health" | "version_consistency";

export interface RecommendationComponentV1 {
  name: RecommendationComponentName;
  /** [0, 1], normalized. */
  value: number;
  weight: number;
  /** value * weight. */
  contribution: number;
  /** Raw inputs, e.g. { repoShare: 0.75, repoIds: [...] }. */
  inputs: Record<string, unknown>;
}

export interface BlueprintAlternativeV1 {
  technologyId: string;
  name: string;
  version?: string;
  fitScore: number;
  components: RecommendationComponentV1[];
  note?: string;
}

export type BlueprintRiskKind =
  | "outdated_version"
  | "low_adoption"
  | "high_hotspot_share"
  | "version_divergence"
  | "single_repo_evidence"
  | "declared_only_evidence"
  | "heuristic_evidence";

export interface BlueprintRiskV1 {
  kind: BlueprintRiskKind;
  severity: "info" | "warning" | "critical";
  message: string;
  evidence: PortfolioProvenanceV1[];
}

export interface BlueprintRecommendationV1 {
  schemaVersion: 1;
  recommendationId: string;
  blueprintId: string;
  workspaceId: string;
  generationId: string;
  advisorVersion: typeof BLUEPRINT_ADVISOR_VERSION;

  /** e.g. "http_framework", "test_runner", "ci_system". */
  topic: string;
  recommended: { technologyId: string; name: string; version?: string };

  /** [0, 1]; never emitted without all four components. */
  fitScore: number;
  components: RecommendationComponentV1[];
  evidence: {
    supportingRepoIds: string[];
    /** TechnologyRecordV1 references. */
    supportingRecordIds: string[];
    healthByRepo: Record<string, RepositoryHealthV1 | null>;
  };

  /** At least one when candidates exist. */
  alternatives: BlueprintAlternativeV1[];
  risks: BlueprintRiskV1[];
  confidence: PortfolioConfidenceV1;
}

// ---------------------------------------------------------------------------
// Tech radar (portfolio.md §7.8)
// ---------------------------------------------------------------------------

export type RadarRing = "adopt" | "maintain" | "consolidate" | "retire";

export type RadarTrendDirection =
  "converging" | "diverging" | "stable" | "declining" | "new" | "unknown";

export interface RadarTrendPointV1 {
  /** e.g. "2026-Q1". */
  window: string;
  repoCount: number;
  distinctVersionCount: number;
}

export interface TechRadarEntryV1 {
  schemaVersion: 1;
  entryId: string;
  workspaceId: string;
  generationId: string;
  radarVersion: typeof RADAR_VERSION;
  technologyId: string;
  name: string;
  category: string;
  problemDomain?: string;

  ring: RadarRing;
  /** Rule ids that determined the ring (checked R4 → R3 → R1 → R2). */
  ringReason: string[];

  versionDrift: {
    distinctVersions: string[];
    majorSpread: number;
    byRepo: Record<string, string | null>;
    comparable: boolean;
  };

  duplicates: {
    problemDomain: string;
    /** Other technologies of the same domain in the portfolio. */
    competingTechnologyIds: string[];
  }[];

  trend: {
    /** "unknown" without change history — never guessed. */
    direction: RadarTrendDirection;
    /** From change history; empty without history. */
    points: RadarTrendPointV1[];
  };

  evidence: PortfolioProvenanceV1[];
  confidence: PortfolioConfidenceV1;
}

// ---------------------------------------------------------------------------
// Qdrant payload (portfolio.md §12.2)
// ---------------------------------------------------------------------------

export type PortfolioPointType =
  | "technology_record"
  | "repository_profile"
  | "stack_matrix"
  | "convention"
  | "archetype"
  | "radar_entry"
  | "blueprint"
  | "blueprint_recommendation";

/** Portfolio point payload (portfolio.md §12.2) — snake_case as stored. */
export interface PortfolioPointPayloadV1 {
  schema_version: 1;
  point_type: PortfolioPointType;
  workspace_id: string;
  /** Absent for workspace-wide records. */
  repo_id?: string;
  ref_id?: string;
  generation_id: string;
  analyzer_version: string;
  created_at_epoch_ms: number;

  technology_id?: string;
  technology_name?: string;
  technology_category?: string;
  ecosystem?: string;
  problem_domain?: string;
  version_resolved?: string;
  usage?: string;
  archetype?: string;
  convention_kind?: string;
  radar_ring?: string;
  blueprint_kind?: string;
  confidence_value?: number;
  confidence_basis?: "deterministic" | "heuristic";
  adoption_repo_count?: number;
  adoption_repo_share?: number;
  major_spread?: number;
  last_seen_at_epoch_ms?: number;

  /** Full record as JSON: TechnologyRecordV1 | RepositoryProfileV1 | … */
  record: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool inputs/results (portfolio.md §14.2)
// ---------------------------------------------------------------------------

export interface PortfolioScanInputV1 {
  workspaceId?: string;
  repositories?: string[];
  /** Recompute trends from change history. */
  refreshHistory?: boolean;
  background?: boolean;
}

export interface PortfolioScanResultV1 {
  schemaVersion: 1;
  jobId: string;
  generationId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  repositoriesPlanned: number;
  repositoriesCompleted: number;
  technologiesDetected?: number;
  conventionsDetected?: number;
  warnings: string[];
}

export interface StackMatrixInputV1 {
  workspaceId?: string;
  categories?: string[];
  /** Default false. */
  includeTransitive?: boolean;
  /** Default 0. */
  minAdoptionShare?: number;
  /** Default: last completed generation. */
  generationId?: string;
}

export interface WhoUsesInputV1 {
  /** Name or technologyId. */
  technology: string;
  workspaceId?: string;
  /** SemVer range filter over versionResolved. */
  versionRange?: string;
  /** Include importingFileCount per repo. */
  includeDepth?: boolean;
  /** Default true. */
  includeDeclaredOnly?: boolean;
}

export interface WhoUsesResultV1 {
  schemaVersion: 1;
  technology: { technologyId: string; name: string; category: string; ecosystem?: string };
  generationId: string;
  usages: {
    repoId: string;
    repoLabel: string;
    refId: string;
    versionRaw?: string;
    versionResolved?: string;
    usage: string;
    declaredOnly: boolean;
    importOnly: boolean;
    importingFileCount?: number;
    firstSeenAt?: string;
    lastSeenAt?: string;
    provenance: PortfolioProvenanceV1[];
  }[];
  notUsingRepoIds: string[];
  warnings: string[];
}

export interface ConventionsInputV1 {
  workspaceId?: string;
  kinds?: string[];
  /** Default 0.5. */
  minConfidence?: number;
  /** Default true. */
  includeCounterexamples?: boolean;
}

export interface ConventionsResultV1 {
  schemaVersion: 1;
  generationId: string;
  conventions: ConventionV1[];
  suppressedCount: number;
  warnings: string[];
}

export interface ArchetypesInputV1 {
  workspaceId?: string;
  repositories?: string[];
  /** Output complete signals, default true. */
  explain?: boolean;
}

export interface ArchetypesResultV1 {
  schemaVersion: 1;
  generationId: string;
  classifierVersion: string;
  assignments: ArchetypeV1[];
  warnings: string[];
}

export interface TechRadarInputV1 {
  workspaceId?: string;
  rings?: RadarRing[];
  categories?: string[];
  problemDomain?: string;
}

export interface TechRadarResultV1 {
  schemaVersion: 1;
  generationId: string;
  radarVersion: string;
  entries: TechRadarEntryV1[];
  historyAvailable: boolean;
  warnings: string[];
}

export interface BlueprintInputV1 {
  kind: BlueprintKind;
  workspaceId?: string;
  /** Default: dominant portfolio language for this kind. */
  language?: string;
  /** Restrict to topics. */
  topics?: string[];
  /** Activates scaffolding path validation. */
  targetDir?: string;
  /** Default false ⇒ dry run. */
  apply?: boolean;
  /** Default false. */
  showContent?: boolean;
}

export interface BlueprintResultV1 {
  schemaVersion: 1;
  blueprint: BlueprintV1;
  recommendations: BlueprintRecommendationV1[];
  scaffold?: {
    mode: "dry_run" | "applied";
    targetDir: string;
    files: BlueprintFileV1[];
    /** Only when "applied". */
    manifestPath?: string;
  };
  warnings: string[];
}

/** Portfolio scan runs as a job and emits the shared JobEvent stream. */
export type PortfolioScanEvents = AsyncIterable<JobEvent>;
