import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { mcpFailure, mcpSuccess } from "./envelope.js";
import { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } from "./output-schemas.js";
import { assertPathInsideWorkspace, PathOutsideWorkspaceError } from "./path-sandbox.js";
import {
  createUntangleMcpServer,
  executeMcpToolInvocation,
  toolResponseEnvelopeSchema,
} from "./server.js";
import { UNTANGLE_MCP_TOOLS, type UntangleMcpOperationMap } from "./tools.js";
import {
  UNTANGLE_MCP_TOOL_NAMES,
  type UntangleMcpRuntime,
  type UntangleMcpToolName,
} from "./types.js";

import { DEFAULT_MCP_AVAILABLE_TOOLS } from "./index.js";

const MINIMAL_INPUTS = {
  untangle_index: { root: ".", repositoryId: "repo" },
  untangle_update: { root: ".", repositoryId: "repo", paths: ["src/index.ts"] },
  untangle_stop: { workspaceId: "workspace", jobId: "job" },
  untangle_watch: { root: ".", repositoryId: "repo" },
  untangle_status: {},
  untangle_health: {},
  untangle_projects: {},
  untangle_search: { query: "symbol" },
  untangle_search_session: { action: "report" },
  untangle_context_list: {},
  untangle_context_index: { root: ".", artifactNames: ["decisions"] },
  untangle_context_search: { query: "decision" },
  untangle_context_remove: { root: ".", target: "decisions" },
  untangle_graph_build: { root: "." },
  untangle_graph_status: {},
  untangle_graph_query: { file: "src/index.ts" },
  untangle_graph_stats: {},
  untangle_graph_cycles: {},
  untangle_graph_visualize: { out: "graph.html" },
  untangle_graph_remove: { root: ".", target: "generation" },
  untangle_symbols: {},
  untangle_symbol: { symbol: "createUntangle" },
  untangle_flow: { from: "main" },
  untangle_impact: { symbol: "main" },
  untangle_cross_repo_impact: { symbol: "main" },
  untangle_complexity: {},
  untangle_complexity_explain: { symbol: "main" },
  untangle_hotspots: {},
  untangle_complexity_diff: { base: "main", head: "HEAD" },
  untangle_changes: { base: "main", head: "HEAD" },
  untangle_change_search: { query: "parser" },
  untangle_quality_gate: { base: "main", head: "HEAD" },
  untangle_about: {},
  untangle_portfolio_scan: { root: "." },
  untangle_stack_matrix: {},
  untangle_who_uses: { technology: "typescript" },
  untangle_conventions: {},
  untangle_archetypes: {},
  untangle_tech_radar: {},
  untangle_blueprint: { kind: "cli" },
  untangle_product: {},
  untangle_boundaries: {},
} satisfies Record<UntangleMcpToolName, Record<string, unknown>>;

const EXPECTED_DEFAULT_AVAILABLE_TOOLS = [
  "untangle_health",
  "untangle_projects",
  "untangle_search",
  "untangle_search_session",
  "untangle_context_list",
  "untangle_graph_status",
  "untangle_graph_query",
  "untangle_graph_stats",
  "untangle_graph_cycles",
  "untangle_graph_visualize",
  "untangle_symbols",
  "untangle_symbol",
  "untangle_flow",
  "untangle_impact",
  "untangle_complexity",
  "untangle_hotspots",
  "untangle_about",
  "untangle_product",
  "untangle_boundaries",
] as const satisfies readonly UntangleMcpToolName[];

const ZERO_INDEX_COUNTS = {
  filesSeen: 0,
  filesPlanned: 0,
  filesUnchanged: 0,
  filesIgnored: 0,
  filesAnalyzed: 0,
  filesRemoved: 0,
  chunks: 0,
  symbols: 0,
  points: 0,
  embeddingCacheHits: 0,
  embeddingsComputed: 0,
  parseCacheHits: 0,
  parseCacheMisses: 0,
  chunkCacheHits: 0,
  chunkCacheMisses: 0,
  metricsCacheHits: 0,
  metricsCacheMisses: 0,
  truncated: 0,
  fileGraphNodes: 0,
  fileGraphEdges: 0,
  symbolGraphNodes: 0,
  symbolGraphEdges: 0,
};

const INDEX_REPORT = {
  schemaVersion: 1 as const,
  jobId: "job",
  generationId: "generation",
  workspaceId: "workspace",
  repoId: "repo",
  refId: "repo:main",
  embeddingProfileId: "profile",
  collection: "untangle_chunks_profile",
  outcome: "completed" as const,
  counts: ZERO_INDEX_COUNTS,
  skipped: [],
  skippedByReason: {},
  skippedByStage: {},
  skippedTruncated: 0,
};

const JOB = {
  jobId: "job",
  operation: "index",
  status: "completed" as const,
  workspaceId: "workspace",
  generationId: "generation",
};

const SEARCH_RESULT = {
  schemaVersion: 1 as const,
  queryFingerprint: "query-fingerprint",
  query: {
    schemaVersion: 1 as const,
    text: "symbol",
    workspaceId: "workspace",
    filters: {
      repoIds: [],
      refIds: [],
      languages: [],
      pathGlobs: [],
      symbolNames: [],
      symbolKinds: [],
      chunkKinds: [],
    },
    limit: 10,
    candidateLimit: 20,
    diversify: false,
    includeGraphContext: false,
    includeLinked: false,
    includeContent: false,
    rankerVersion: "untangle-ranker-v1",
  },
  groups: [],
  profileSeparation: false,
  totalHits: 0,
  skipped: [],
  warnings: [],
};

const SEARCH_SESSION = {
  schemaVersion: 1 as const,
  revision: 0,
  sessionId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace",
  status: "active" as const,
  recordingConsent: "explicit" as const,
  retainText: false,
  goal: { fingerprint: "a".repeat(64) },
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  attempts: [],
  navigation: [],
};

const PRODUCT_COMPLEXITY_REPORT = {
  schemaVersion: 1 as const,
  algorithm: "untangle-dynamic-search-complexity-v1" as const,
  isHeuristic: true as const,
  workspaceId: "workspace",
  generatedAt: "2026-09-06T00:00:03.000Z",
  sessionCounts: {
    total: 3,
    active: 0,
    completed: 3,
    featureTaggedCompleted: 3,
    abandoned: 0,
  },
  cohorts: [
    {
      measurementContextId: "e".repeat(64),
      completedSessionCount: 3,
      measurementContextComplete: true,
      sufficientEvidence: true,
      minimumCompletedSessions: 3 as const,
      medianSearchesToTarget: 2,
      p90SearchesToTarget: 3,
      medianQueryReformulations: 1,
      medianAcceptedTargetRank: 1,
      meanReciprocalRank: 1,
      targetReturnedRate: 1,
      directHitRate: 0.5,
      healthyRetrievalRate: 1,
      medianEligibleCandidatesExamined: 80,
      medianUniqueFilesExposed: 8,
      meanCandidateFileDispersion: 0.4,
      meanCandidateChurn: 0.3,
      candidateLimitHitRate: 0.25,
      caveats: ["heuristic cohort"],
    },
  ],
  featureMappings: [
    {
      featureFingerprint: "f".repeat(64),
      measurementContextId: "e".repeat(64),
      distinctGoalCount: 2,
      search: {
        measurementContextId: "e".repeat(64),
        completedSessionCount: 3,
        measurementContextComplete: true,
        sufficientEvidence: true,
        minimumCompletedSessions: 3 as const,
        medianSearchesToTarget: 2,
        p90SearchesToTarget: 3,
        medianQueryReformulations: 1,
        medianAcceptedTargetRank: 1,
        meanReciprocalRank: 1,
        targetReturnedRate: 1,
        directHitRate: 0.5,
        healthyRetrievalRate: 1,
        medianEligibleCandidatesExamined: 80,
        medianUniqueFilesExposed: 8,
        meanCandidateFileDispersion: 0.4,
        meanCandidateChurn: 0.3,
        candidateLimitHitRate: 0.25,
        caveats: ["heuristic feature cohort"],
      },
      code: {
        confirmedTargetCount: 1,
        observedComplexitySessionCount: 3,
        unavailableComplexitySessionCount: 0,
        targets: [
          {
            target: { filePath: "packages/search/src/product-complexity.ts" },
            completedSessionCount: 3,
            complexityVariants: [
              {
                evidence: {
                  status: "observed" as const,
                  source: "indexed-search-hit" as const,
                  candidate: {
                    repoId: "repo",
                    refId: "repo:main",
                    filePath: "packages/search/src/product-complexity.ts",
                    chunkId: "chunk",
                    symbolId: "symbol",
                    symbolFqn: "buildDynamicProductComplexityReport",
                    embeddingProfileId: "qwen3-embedding-0.6b",
                    indexGeneration: "generation",
                  },
                  complexity: {
                    metricsScope: "symbol" as const,
                    metricsScopeId: "symbol",
                    metricsVersion: "untangle-metrics-v1",
                    cognitive: 12,
                  },
                  payloadComplete: true,
                  incompletePayloadFields: [],
                },
                completedSessionCount: 3,
              },
            ],
          },
        ],
      },
      caveats: ["search and code remain separate"],
    },
  ],
  caveats: ["caller conditions require external control"],
};

const FILE_GRAPH_METRICS = {
  schemaVersion: 1 as const,
  workspaceId: "workspace",
  graphGeneration: "generation",
  graphVersion: "untangle-file-graph-v1",
  nodeCount: 0,
  edgeCount: 0,
  orphanFileIds: [],
  stronglyConnectedComponents: [],
  cycles: [],
  importResolution: {
    resolvedCount: 0,
    externalCount: 0,
    unresolvedCount: 0,
    rate: 0,
  },
  repositoryDistribution: {},
  languageDistribution: {},
  topCentralFiles: [],
  centralityFormula: "degree / max(1, nodeCount - 1)",
};

const FILE_NODE = {
  schemaVersion: 1 as const,
  workspaceId: "workspace",
  repoId: "repo",
  refId: "repo:main",
  fileId: "file-main",
  filePath: "src/main.ts",
  language: "typescript",
  contentHash: "hash",
  imports: [],
  dependencies: [],
  dependents: [],
  graphGeneration: "generation",
  unresolvedImportCount: 0,
};

const GRAPH_FILE_VIEW = {
  generationId: "generation",
  workspaceId: "workspace",
  node: FILE_NODE,
  edges: [],
  issues: [],
  truncated: false,
  omittedCount: 0,
};

const VIEW_STATS = {
  inputNodeCount: 0,
  shownNodeCount: 0,
  nodeLimitDroppedCount: 0,
  sourceEdgeCount: 0,
  candidateLinkCount: 0,
  renderableLinkCount: 0,
  shownLinkCount: 0,
  unrenderableSourceEdgeCount: 0,
  missingEndpointLinkCount: 0,
  nodeLimitDroppedLinkCount: 0,
  edgeLimitDroppedLinkCount: 0,
};

const GRAPH_VISUALIZATION = {
  generationId: "generation",
  workspaceId: "workspace",
  artifact: {
    path: "/workspace/graph.html",
    bytes: 1,
    sha256: "a".repeat(64),
    limits: { maxNodes: 600, maxEdges: 1_200 },
    views: { file: VIEW_STATS, symbol: null },
  },
  symbolGraph: { available: false as const, missingReason: "not indexed" },
  issues: [],
};

const SYMBOL = {
  id: "symbol",
  name: "main",
  qualifiedName: "main",
  kind: "function",
  repoId: "repo",
  refId: "repo:main",
  fileId: "file",
  filePath: "src/main.ts",
  language: "typescript",
  startLine: 1,
  endLine: 1,
  startByte: 0,
  endByte: 10,
  contentHash: "hash",
};

const SYMBOL_DETAIL = {
  generationId: "generation",
  matchedBy: "symbol_id" as const,
  symbol: SYMBOL,
  outgoing: [],
  callers: [],
};

const TRAVERSAL_LIMITS = {
  maxDepth: 3,
  maxNodes: 100,
  maxEdges: 200,
  maxWallTimeMs: 1_000,
};

const IMPACT = {
  schemaVersion: 1 as const,
  rootSymbolIds: ["symbol"],
  affected: [],
  containsAmbiguousEdges: false,
  ambiguousEdgeIds: [],
  minConfidence: 0,
  traversal: {
    schemaVersion: 1 as const,
    direction: "reverse" as const,
    rootSymbolIds: ["symbol"],
    visitedSymbolIds: [],
    edgeIds: [],
    depthReached: 0,
    truncated: false,
    revisitSkippedSymbolIds: [],
    limits: TRAVERSAL_LIMITS,
  },
  skipped: [],
};

const COMPLEXITY_REPORT = {
  schemaVersion: 1 as const,
  root: "/workspace",
  filesDiscovered: 0,
  filesAnalyzed: 0,
  filesProse: 0,
  totals: { executionUnits: 0, cognitive: 0, cyclomatic: 0 },
  hotspots: [],
  violations: [],
  prose: [],
  skipped: [],
};

const PROVENANCE = {
  workspaceId: "workspace",
  repoId: "repo",
  refId: "repo:main",
  sourceFile: "package.json",
  detectorId: "npm.dependencies",
  detectorVersion: "portfolio-detect-v1",
  evidenceKind: "manifest" as const,
};

const CONFIDENCE = {
  value: 1,
  basis: "deterministic" as const,
  signals: ["npm.dependencies"],
};

const RECOMMENDATION_COMPONENTS = [
  { name: "adoption" as const, value: 1, weight: 0.4, contribution: 0.4, inputs: {} },
  { name: "recency" as const, value: 1, weight: 0.2, contribution: 0.2, inputs: {} },
  { name: "health" as const, value: 1, weight: 0.25, contribution: 0.25, inputs: {} },
  {
    name: "version_consistency" as const,
    value: 1,
    weight: 0.15,
    contribution: 0.15,
    inputs: {},
  },
];

const STACK_MATRIX = {
  schemaVersion: 1 as const,
  matrixId: "matrix",
  workspaceId: "workspace",
  generationId: "generation",
  generatedAt: "2026-09-06T00:00:00.000Z",
  analyzerVersion: "untangle-portfolio-v1",
  repositories: [{ repoId: "repo", refId: "repo:main", profileId: "profile" }],
  entries: [
    {
      technologyId: "typescript",
      name: "typescript",
      category: "language",
      ecosystem: "npm",
      adoption: { repoCount: 1, repoShare: 1, repoIds: ["repo"] },
      versionSpread: {
        distinctVersions: ["5.9.3"],
        byRepo: { repo: "5.9.3" },
        majorSpread: 0,
        comparable: true,
      },
      usageDepth: {
        importingFilesByRepo: { repo: 1 },
        declaredOnlyRepos: [],
        importOnlyRepos: [],
      },
      confidence: CONFIDENCE,
    },
  ],
  warnings: [],
};

const WHO_USES = {
  schemaVersion: 1 as const,
  technology: {
    technologyId: "typescript",
    name: "typescript",
    category: "language",
    ecosystem: "npm",
  },
  generationId: "generation",
  usages: [
    {
      repoId: "repo",
      repoLabel: "Repository",
      refId: "repo:main",
      versionResolved: "5.9.3",
      usage: "dev",
      declaredOnly: false,
      importOnly: false,
      importingFileCount: 1,
      provenance: [PROVENANCE],
    },
  ],
  notUsingRepoIds: [],
  warnings: [],
};

const CONVENTIONS = {
  schemaVersion: 1 as const,
  generationId: "generation",
  conventions: [
    {
      schemaVersion: 1 as const,
      conventionId: "convention",
      workspaceId: "workspace",
      generationId: "generation",
      kind: "test_setup" as const,
      title: "Co-located tests",
      description: "Tests live beside source files.",
      rule: {
        ruleKind: "naming_pattern" as const,
        expression: { suffix: ".test.ts" },
        humanReadable: "tests use the .test.ts suffix",
      },
      evidence: {
        applicableRepos: ["repo"],
        supportingRepos: ["repo"],
        matchCount: 1,
        counterexamples: [{ repoId: "repo", provenance: PROVENANCE }],
        sampleProvenance: [PROVENANCE],
      },
      confidence: CONFIDENCE,
      detectorId: "conv.naming.test_suffix",
      detectorVersion: "portfolio-conventions-v1",
      heuristic: false,
    },
  ],
  suppressedCount: 0,
  warnings: [],
};

const ARCHETYPES = {
  schemaVersion: 1 as const,
  generationId: "generation",
  classifierVersion: "untangle-archetype-v1",
  assignments: [
    {
      schemaVersion: 1 as const,
      archetypeId: "archetype",
      workspaceId: "workspace",
      repoId: "repo",
      refId: "repo:main",
      generationId: "generation",
      classifierVersion: "untangle-archetype-v1",
      archetype: "cli_tool" as const,
      score: 1,
      alternatives: [{ archetype: "library" as const, score: 0.2 }],
      signals: [
        {
          signalId: "npm.bin_field",
          description: "package exposes a binary",
          weight: 1,
          matched: true,
          contribution: 1,
          provenance: PROVENANCE,
          heuristic: false,
        },
      ],
      confidence: CONFIDENCE,
    },
  ],
  warnings: [],
};

const TECH_RADAR = {
  schemaVersion: 1 as const,
  generationId: "generation",
  radarVersion: "untangle-radar-v1",
  entries: [
    {
      schemaVersion: 1 as const,
      entryId: "radar-entry",
      workspaceId: "workspace",
      generationId: "generation",
      radarVersion: "untangle-radar-v1",
      technologyId: "typescript",
      name: "typescript",
      category: "language",
      ring: "adopt" as const,
      ringReason: ["R1"],
      versionDrift: {
        distinctVersions: ["5.9.3"],
        majorSpread: 0,
        byRepo: { repo: "5.9.3" },
        comparable: true,
      },
      duplicates: [{ problemDomain: "language", competingTechnologyIds: [] }],
      trend: {
        direction: "stable" as const,
        points: [{ window: "2026-Q3", repoCount: 1, distinctVersionCount: 1 }],
      },
      evidence: [PROVENANCE],
      confidence: CONFIDENCE,
    },
  ],
  historyAvailable: true,
  warnings: [],
};

const BLUEPRINT_FILE = {
  path: "src/index.ts",
  templateId: "typescript-cli-v1",
  contentPreviewHash: "hash",
  sizeBytes: 42,
};

const BLUEPRINT = {
  schemaVersion: 1 as const,
  blueprint: {
    schemaVersion: 1 as const,
    blueprintId: "blueprint",
    workspaceId: "workspace",
    generationId: "generation",
    advisorVersion: "untangle-blueprint-v1",
    generatedAt: "2026-09-06T00:00:00.000Z",
    kind: "cli" as const,
    language: "typescript",
    runtime: { name: "node", versionRange: ">=22" },
    directoryLayout: [{ path: "src/", kind: "directory" as const, purpose: "source code" }],
    dependencies: [
      {
        technologyId: "zod",
        name: "zod",
        ecosystem: "npm",
        version: "4.5.4",
        usage: "runtime" as const,
        recommendationId: "recommendation",
      },
    ],
    toolchain: [],
    testSetup: {
      framework: "vitest",
      layout: "co-located",
      recommendationId: "recommendation",
    },
    ciSkeleton: {
      system: "github-actions",
      workflowFiles: [".github/workflows/ci.yml"],
      recommendationId: "recommendation",
    },
    appliedConventionIds: ["convention"],
    recommendationIds: ["recommendation"],
    files: [BLUEPRINT_FILE],
    evidenceSummary: {
      reposConsidered: 1,
      reposMatchingKind: ["repo"],
      portfolioGenerationId: "generation",
    },
    warnings: [],
  },
  recommendations: [
    {
      schemaVersion: 1 as const,
      recommendationId: "recommendation",
      blueprintId: "blueprint",
      workspaceId: "workspace",
      generationId: "generation",
      advisorVersion: "untangle-blueprint-v1",
      topic: "validation",
      recommended: { technologyId: "zod", name: "zod", version: "4.5.4" },
      fitScore: 1,
      components: RECOMMENDATION_COMPONENTS,
      evidence: {
        supportingRepoIds: ["repo"],
        supportingRecordIds: ["record"],
        healthByRepo: {
          repo: {
            metricsVersion: "untangle-metrics-v1",
            measuredAt: "2026-09-06T00:00:00.000Z",
            caveats: [],
          },
        },
      },
      alternatives: [
        {
          technologyId: "valibot",
          name: "valibot",
          fitScore: 0.5,
          components: RECOMMENDATION_COMPONENTS,
        },
      ],
      risks: [
        {
          kind: "single_repo_evidence" as const,
          severity: "warning" as const,
          message: "Only one repository supports this choice.",
          evidence: [PROVENANCE],
        },
      ],
      confidence: CONFIDENCE,
    },
  ],
  scaffold: {
    mode: "dry_run" as const,
    targetDir: "/workspace/generated",
    files: [BLUEPRINT_FILE],
  },
  warnings: [],
};

const MINIMAL_SUCCESS_DATA = {
  untangle_index: INDEX_REPORT,
  untangle_update: INDEX_REPORT,
  untangle_stop: { job: JOB, cancellationRequested: true },
  untangle_watch: { job: JOB, watching: true },
  untangle_status: { jobs: [JOB] },
  untangle_health: { schemaVersion: 1 as const, ok: true, checks: [] },
  untangle_projects: { root: "/workspace", repositories: [], projectId: "project" },
  untangle_search: SEARCH_RESULT,
  untangle_search_session: { action: "start" as const, session: SEARCH_SESSION },
  untangle_context_list: { artifacts: [], configured: 0 },
  untangle_context_index: {
    generationId: "generation",
    artifacts: ["decisions"],
    indexedDocuments: 1,
  },
  untangle_context_search: { query: "decision", results: [], total: 0 },
  untangle_context_remove: { target: "decisions", removed: true, removedDocumentCount: 1 },
  untangle_graph_build: {
    generationId: "generation",
    workspaceId: "workspace",
    fileGraph: { nodeCount: 0, edgeCount: 0 },
    symbolGraph: { nodeCount: 0, edgeCount: 0 },
    skipped: [],
  },
  untangle_graph_status: {
    generationId: "generation",
    workspaceId: "workspace",
    metrics: FILE_GRAPH_METRICS,
    issues: [],
  },
  untangle_graph_query: GRAPH_FILE_VIEW,
  untangle_graph_stats: {
    generationId: "generation",
    metrics: FILE_GRAPH_METRICS,
    boundaries: { crossRepo: 0, crossPackage: 0, crossContainer: 0 },
    issues: [],
  },
  untangle_graph_cycles: { generationId: "generation", cycles: [], total: 0, issues: [] },
  untangle_graph_visualize: GRAPH_VISUALIZATION,
  untangle_graph_remove: { target: "generation", generationId: "generation", removed: true },
  untangle_symbols: { generationId: "generation", symbols: [SYMBOL], total: 1, truncated: false },
  untangle_symbol: SYMBOL_DETAIL,
  untangle_flow: { ...SYMBOL_DETAIL, truncated: false, omittedCount: 0 },
  untangle_impact: {
    generationId: "generation",
    root: SYMBOL,
    impact: IMPACT,
    truncated: false,
    omittedCount: 0,
  },
  untangle_cross_repo_impact: {
    generationId: "generation",
    root: SYMBOL,
    impact: IMPACT,
    repoIds: ["repo"],
  },
  untangle_complexity: COMPLEXITY_REPORT,
  untangle_complexity_explain: {
    symbol: SYMBOL,
    snapshot: {
      snapshotId: "snapshot",
      scope: "symbol" as const,
      scopeId: "symbol",
      repoId: "repo",
      refId: "repo:main",
      metricsVersion: "untangle-metrics-v1",
      measuredAt: "2026-09-06T00:00:00.000Z",
      parseQuality: "complete" as const,
      cyclomatic: { classic: 1, extended: 1, contributors: [] },
      cognitive: { value: 0, algorithm: "untangle-cognitive-v1", contributors: [] },
      structural: {},
      textual: {},
      syntactic: {},
      halstead: {},
      maintainabilityIndex: 100,
      maintainabilityFormula: "MI",
    },
  },
  untangle_hotspots: COMPLEXITY_REPORT,
  untangle_complexity_diff: {
    base: "main",
    head: "HEAD",
    metricsVersion: "untangle-metrics-v1",
    entries: [],
    warnings: [],
  },
  untangle_changes: { base: "main", head: "HEAD", changes: [], total: 0 },
  untangle_change_search: { query: "parser", changes: [], total: 0 },
  untangle_quality_gate: {
    status: "passed" as const,
    base: "main",
    head: "HEAD",
    violations: [],
    improvements: [],
    analysisCoverage: { filesChanged: 0, filesAnalyzed: 0, symbolsChanged: 0, parseFailures: 0 },
  },
  untangle_about: {
    name: "untangle" as const,
    version: "0.1.0",
    license: "AGPL-3.0-only" as const,
    source: "https://github.com/lboel/untangle",
    commit: "abc123",
    availableTools: [],
    unavailableToolsReturn: "FEATURE_UNAVAILABLE" as const,
  },
  untangle_portfolio_scan: {
    schemaVersion: 1 as const,
    jobId: "job",
    generationId: "generation",
    status: "completed" as const,
    repositoriesPlanned: 1,
    repositoriesCompleted: 1,
    technologiesDetected: 1,
    conventionsDetected: 1,
    warnings: [],
  },
  untangle_stack_matrix: STACK_MATRIX,
  untangle_who_uses: WHO_USES,
  untangle_conventions: CONVENTIONS,
  untangle_archetypes: ARCHETYPES,
  untangle_tech_radar: TECH_RADAR,
  untangle_blueprint: BLUEPRINT,
  untangle_product: {
    schemaVersion: 1,
    root: "/workspace/project",
    status: "needs_manifest",
    manifest: { path: "untangle.features.json", status: "missing" },
    sourceTreeDigest: "a".repeat(64),
    inventory: { files: 0, truncated: false, excluded: 0 },
    semanticConformance: "not_independently_proven",
    ownershipAuthority: "manifest_declarations",
    features: [],
    coverage: {
      measuredCodeFiles: 0,
      mappedCodeFiles: 0,
      unmappedCodeFiles: [],
      unmappedCodeFileCount: 0,
      sharedFiles: [],
      mappedCodeUnion: null,
    },
    dependencyCycles: [],
    issues: [],
    limitations: [],
    draft: { schemaVersion: 1, owners: [], features: [] },
  },
  untangle_boundaries: {
    schemaVersion: 1,
    kind: "frontend-boundaries",
    root: "/workspace/project",
    status: "complete",
    sourceTreeDigest: "a".repeat(64),
    freshness: {
      status: "fresh",
      sourceTreeBefore: "a".repeat(64),
      sourceTreeAfter: "a".repeat(64),
      changedPaths: [],
    },
    inventory: { files: 0, excluded: 0, truncated: false, analyzed: 0, unsupported: 0, failed: 0 },
    http: {
      schemaVersion: 1,
      kind: "http-boundaries",
      services: [],
      endpoints: [],
      requests: [],
      limitations: [],
      summary: { files: 0, endpoints: 0, requests: 0, resolved: 0, ambiguous: 0, unresolved: 0 },
    },
    importContext: {
      kind: "file-imports-not-function-calls",
      edges: [],
      requestImporters: [],
      unresolved: [],
      summary: { edges: 0, unresolved: 0, requestImporters: 0 },
      truncated: false,
    },
    features: {
      manifest: { path: ".untangle/features.json", status: "missing" },
      associations: [],
      associationCount: 0,
      dependencySemantics: "declared_dependencies_unchanged",
    },
    truncation: {
      truncated: false,
      limit: 200,
      omittedRequests: 0,
      omittedEndpoints: 0,
      omittedIssues: 0,
      omittedFeatureAssociations: 0,
    },
    issues: [],
    limitations: [],
    servicesManifest: { path: ".untangle/services.json", status: "missing" },
  },
} satisfies {
  [Name in UntangleMcpToolName]: UntangleMcpOperationMap[Name]["output"];
};

describe("Untangle MCP server", () => {
  it("registers exactly the 42 specified tools in stable order", async () => {
    await withClient(undefined, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(UNTANGLE_MCP_TOOL_NAMES);
      expect(UNTANGLE_MCP_TOOLS.map((tool) => tool.name)).toEqual(UNTANGLE_MCP_TOOL_NAMES);
      expect(listed.tools).toHaveLength(42);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
      expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
      for (const tool of listed.tools) {
        const [success, failure] = advertisedEnvelopeBranches(tool.outputSchema);
        expect(schemaConst(schemaProperties(success)["ok"])).toBe(true);
        expect(schemaRequired(success)).toContain("data");
        expect(schemaProperties(success)).not.toHaveProperty("error");
        expect(schemaConst(schemaProperties(failure)["ok"])).toBe(false);
        expect(schemaRequired(failure)).toContain("error");
        expect(schemaProperties(failure)).not.toHaveProperty("data");
      }
      expect(
        listed.tools.find((tool) => tool.name === "untangle_search")?.inputSchema.required,
      ).toContain("query");
      expect(
        listed.tools.find((tool) => tool.name === "untangle_graph_visualize")?.inputSchema.required,
      ).toContain("out");
      expect(
        schemaProperties(
          advertisedEnvelopeBranches(
            listed.tools.find((tool) => tool.name === "untangle_about")?.outputSchema,
          )[0],
        ),
      ).toHaveProperty("data");
    });
  });

  it("models success and failure as exclusive envelope variants", () => {
    const success = mcpSuccess("untangle_about", MINIMAL_SUCCESS_DATA.untangle_about);
    const failure = mcpFailure("untangle_about", "EXPECTED_FAILURE", "Expected failure.", false);

    expect(toolResponseEnvelopeSchema.safeParse(success).success).toBe(true);
    expect(toolResponseEnvelopeSchema.safeParse(failure).success).toBe(true);
    expect(toolResponseEnvelopeSchema.safeParse({ ...success, error: failure.error }).success).toBe(
      false,
    );
    expect(
      toolResponseEnvelopeSchema.safeParse({
        schemaVersion: 1,
        ok: true,
        operation: "untangle_about",
        warnings: [],
      }).success,
    ).toBe(false);
    expect(toolResponseEnvelopeSchema.safeParse({ ...failure, data: {} }).success).toBe(false);
    expect(
      toolResponseEnvelopeSchema.safeParse({
        schemaVersion: 1,
        ok: false,
        operation: "untangle_about",
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("exports an immutable, exhaustive 19-tool default capability inventory", async () => {
    expect(DEFAULT_MCP_AVAILABLE_TOOLS).toEqual(EXPECTED_DEFAULT_AVAILABLE_TOOLS);
    expect(Object.isFrozen(DEFAULT_MCP_AVAILABLE_TOOLS)).toBe(true);
    expect(new Set(DEFAULT_MCP_AVAILABLE_TOOLS).size).toBe(19);
    expect(
      DEFAULT_MCP_AVAILABLE_TOOLS.every((name) =>
        UNTANGLE_MCP_TOOLS.some((definition) => definition.name === name),
      ),
    ).toBe(true);
    expect(() =>
      (DEFAULT_MCP_AVAILABLE_TOOLS as unknown as UntangleMcpToolName[]).push("untangle_index"),
    ).toThrow(TypeError);

    await withClient(undefined, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(structured(result)).toMatchObject({
        data: { availableTools: [...EXPECTED_DEFAULT_AVAILABLE_TOOLS].sort() },
      });
    });
  });

  it("correlates graph visualization availability with both artifact views", () => {
    const schema = UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_graph_visualize;
    const available = {
      ...GRAPH_VISUALIZATION,
      artifact: {
        ...GRAPH_VISUALIZATION.artifact,
        views: { file: VIEW_STATS, symbol: VIEW_STATS },
      },
      symbolGraph: { available: true as const },
    };

    expect(schema.safeParse(GRAPH_VISUALIZATION).success).toBe(true);
    expect(schema.safeParse(available).success).toBe(true);
    expect(
      schema.safeParse({
        ...GRAPH_VISUALIZATION,
        artifact: {
          ...GRAPH_VISUALIZATION.artifact,
          views: { file: null, symbol: null },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...GRAPH_VISUALIZATION, symbolGraph: { available: false } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...GRAPH_VISUALIZATION,
        artifact: {
          ...GRAPH_VISUALIZATION.artifact,
          views: { file: VIEW_STATS, symbol: VIEW_STATS },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...available,
        artifact: {
          ...available.artifact,
          views: { file: VIEW_STATS, symbol: null },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...available, symbolGraph: { available: true, missingReason: "none" } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...GRAPH_VISUALIZATION,
        artifact: { ...GRAPH_VISUALIZATION.artifact, bytes: 0 },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...GRAPH_VISUALIZATION,
        artifact: { ...GRAPH_VISUALIZATION.artifact, sha256: "not-a-sha256" },
      }).success,
    ).toBe(false);
  });

  it("rejects impossible product-complexity reports at the MCP output boundary", async () => {
    const schema = UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search_session;
    const valid = { action: "report" as const, report: PRODUCT_COMPLEXITY_REPORT };
    const cohort = PRODUCT_COMPLEXITY_REPORT.cohorts[0];
    if (cohort === undefined) throw new Error("expected cohort fixture");

    expect(schema.safeParse(valid).success).toBe(true);
    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          sessionCounts: { ...PRODUCT_COMPLEXITY_REPORT.sessionCounts, total: 4 },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          cohorts: [{ ...cohort, medianSearchesToTarget: -1 }],
        },
      }).success,
    ).toBe(false);
    const falseEvidence = {
      ...valid,
      report: {
        ...PRODUCT_COMPLEXITY_REPORT,
        cohorts: [
          {
            ...cohort,
            completedSessionCount: 2,
            measurementContextComplete: false,
            sufficientEvidence: true,
          },
        ],
        sessionCounts: {
          total: 2,
          active: 0,
          completed: 2,
          featureTaggedCompleted: 2,
          abandoned: 0,
        },
      },
    };
    expect(schema.safeParse(falseEvidence).success).toBe(false);
    const featureMapping = PRODUCT_COMPLEXITY_REPORT.featureMappings[0];
    if (featureMapping === undefined) throw new Error("expected feature mapping fixture");
    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          featureMappings: [
            {
              ...featureMapping,
              code: { ...featureMapping.code, observedComplexitySessionCount: 2 },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          featureMappings: [
            {
              ...featureMapping,
              measurementContextId: "d".repeat(64),
            },
          ],
        },
      }).success,
    ).toBe(false);

    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpSuccess(operation, falseEvidence);
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({
        name: "untangle_search_session",
        arguments: { action: "report" },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        operation: "untangle_search_session",
        error: { code: "INVALID_INTERNAL_OUTPUT", retryable: false },
      });
    });
  });

  it("rejects forged feature-to-code provenance at the MCP output boundary", () => {
    const schema = UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search_session;
    const valid = { action: "report" as const, report: PRODUCT_COMPLEXITY_REPORT };
    const featureMapping = PRODUCT_COMPLEXITY_REPORT.featureMappings[0];
    const targetMapping = featureMapping?.code.targets[0];
    const variant = targetMapping?.complexityVariants[0];
    if (featureMapping === undefined || targetMapping === undefined || variant === undefined) {
      throw new Error("expected feature-to-code fixture");
    }

    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          featureMappings: [
            {
              ...featureMapping,
              code: {
                ...featureMapping.code,
                targets: [
                  {
                    ...targetMapping,
                    target: { filePath: "packages/domain/src/not-the-observed-target.ts" },
                  },
                ],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          featureMappings: [
            {
              ...featureMapping,
              code: {
                ...featureMapping.code,
                targets: [
                  {
                    ...targetMapping,
                    complexityVariants: [
                      { ...variant, completedSessionCount: 1 },
                      { ...variant, completedSessionCount: 2 },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          featureMappings: [
            {
              ...featureMapping,
              code: {
                ...featureMapping.code,
                confirmedTargetCount: 2,
                targets: [
                  {
                    ...targetMapping,
                    completedSessionCount: 1,
                    complexityVariants: [{ ...variant, completedSessionCount: 1 }],
                  },
                  {
                    ...targetMapping,
                    completedSessionCount: 2,
                    complexityVariants: [{ ...variant, completedSessionCount: 2 }],
                  },
                ],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);

    const unknownContext = "d".repeat(64);
    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          featureMappings: [
            {
              ...featureMapping,
              measurementContextId: unknownContext,
              search: { ...featureMapping.search, measurementContextId: unknownContext },
            },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        ...valid,
        report: { ...PRODUCT_COMPLEXITY_REPORT, featureMappings: [] },
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        ...valid,
        report: {
          ...PRODUCT_COMPLEXITY_REPORT,
          featureMappings: [
            {
              ...featureMapping,
              code: {
                ...featureMapping.code,
                targets: [
                  {
                    ...targetMapping,
                    complexityVariants: [
                      {
                        ...variant,
                        evidence: {
                          ...variant.evidence,
                          complexity: { ...variant.evidence.complexity, cognitive: -1 },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("preserves whitespace in raw import specifiers across the response boundary", async () => {
    const rawSpecifier = "  ./dependency  ";
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpSuccess(operation, {
          ...GRAPH_FILE_VIEW,
          edges: [
            {
              schemaVersion: 1,
              edgeId: "edge",
              workspaceId: "workspace",
              repoId: "repo",
              refId: "repo:main",
              fromFileId: "file-main",
              fromPath: "src/main.ts",
              kind: "unresolved",
              rawSpecifier,
              resolution: {
                status: "unresolved",
                reason: "no candidate",
                detail: "fixture",
              },
              boundary: {
                crossRepo: false,
                crossPackage: false,
                crossContainer: false,
              },
              sites: [],
              occurrenceOrdinal: 0,
              graphGeneration: "generation",
              graphVersion: "untangle-file-graph-v1",
            },
          ],
        });
      },
    };

    await withClient(runtime, async (client) => {
      const result = await client.callTool({
        name: "untangle_graph_query",
        arguments: { file: "src/main.ts" },
      });
      expect(result.isError).toBe(false);
      expect(structured(result)).toMatchObject({
        data: { edges: [{ rawSpecifier }] },
      });
    });
  });

  it("runs every tool through one envelope contract instead of shadow handlers", async () => {
    const invoked: UntangleMcpToolName[] = [];
    const runtime: UntangleMcpRuntime = {
      async invoke(operation, input, context) {
        invoked.push(operation);
        expect(context.signal).toBeInstanceOf(AbortSignal);
        expect(input).toBeTypeOf("object");
        return mcpSuccess(operation, MINIMAL_SUCCESS_DATA[operation]);
      },
    };

    await withClient(runtime, async (client) => {
      for (const name of UNTANGLE_MCP_TOOL_NAMES) {
        const result = await client.callTool({ name, arguments: MINIMAL_INPUTS[name] });
        const envelope = structured(result);
        expect(envelope).toMatchObject({
          schemaVersion: 1,
          ok: true,
          operation: name,
          warnings: [],
        });
        expect(result.isError).toBe(false);
        expect(JSON.parse(textOf(result))).toEqual(envelope);
      }
    });

    expect(invoked).toEqual(UNTANGLE_MCP_TOOL_NAMES);
  });

  it.each([
    "untangle_portfolio_scan",
    "untangle_stack_matrix",
    "untangle_who_uses",
    "untangle_conventions",
    "untangle_archetypes",
    "untangle_tech_radar",
    "untangle_blueprint",
  ] as const)("accepts the normative recursive portfolio result for %s", async (name) => {
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpSuccess(operation, MINIMAL_SUCCESS_DATA[name]);
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name, arguments: MINIMAL_INPUTS[name] });
      expect(result.isError).toBe(false);
      expect(structured(result)).toMatchObject({ ok: true, operation: name });
    });
  });

  it.each([
    "untangle_portfolio_scan",
    "untangle_stack_matrix",
    "untangle_who_uses",
    "untangle_conventions",
    "untangle_archetypes",
    "untangle_tech_radar",
    "untangle_blueprint",
  ] as const)("rejects a missing nested portfolio contract field for %s", async (name) => {
    const invalid = invalidPortfolioData(name);
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpSuccess(operation, invalid);
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name, arguments: MINIMAL_INPUTS[name] });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        operation: name,
        error: { code: "INVALID_INTERNAL_OUTPUT", retryable: false },
      });
    });
  });

  it("returns FEATURE_UNAVAILABLE explicitly for a registered missing capability", async () => {
    await withClient(undefined, async (client) => {
      const result = await client.callTool({
        name: "untangle_quality_gate",
        arguments: MINIMAL_INPUTS.untangle_quality_gate,
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation: "untangle_quality_gate",
        error: { code: "FEATURE_UNAVAILABLE", retryable: false },
      });
    });
  });

  it("accepts the default runtime's about payload under its advertised schema", async () => {
    await withClient(undefined, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(result.isError).toBe(false);
      expect(structured(result)).toMatchObject({
        ok: true,
        operation: "untangle_about",
        data: {
          name: "untangle",
          license: "AGPL-3.0-only",
          unavailableToolsReturn: "FEATURE_UNAVAILABLE",
        },
      });
    });
  });

  it("returns the common envelope for invalid tool arguments", async () => {
    await withClient(undefined, async (client) => {
      const result = await client.callTool({ name: "untangle_search", arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation: "untangle_search",
        error: { code: "INVALID_ARGUMENT", retryable: false },
      });
      expect(JSON.parse(textOf(result))).toEqual(structured(result));
    });
  });

  it("replaces tool-specific invalid success data with INVALID_INTERNAL_OUTPUT", async () => {
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpSuccess(operation, { echoed: true });
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation: "untangle_about",
        error: { code: "INVALID_INTERNAL_OUTPUT", retryable: false },
      });
    });
  });

  it("rejects a structurally valid search journey with an invalid failed-attempt state", async () => {
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpSuccess(operation, {
          action: "start",
          session: {
            ...SEARCH_SESSION,
            attempts: [
              {
                attemptId: "00000000-0000-4000-8000-000000000002",
                sequence: 1,
                observationFingerprint: "b".repeat(64),
                queryFingerprint: "c".repeat(64),
                rankerVersion: "untangle-ranker-v2",
                observedAt: "2026-09-06T00:00:01.000Z",
                status: "failed",
                warningCodes: [],
                retrievalHealthy: false,
                profiles: [],
              },
            ],
          },
        });
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({
        name: "untangle_search_session",
        arguments: { action: "start", goal: "Find the owner" },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        operation: "untangle_search_session",
        error: { code: "INVALID_INTERNAL_OUTPUT", retryable: false },
      });
    });
  });

  it("rejects an otherwise valid envelope whose operation does not match the invoked tool", async () => {
    const runtime: UntangleMcpRuntime = {
      async invoke() {
        return mcpSuccess("untangle_projects", MINIMAL_SUCCESS_DATA.untangle_projects);
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        operation: "untangle_about",
        error: { code: "INVALID_INTERNAL_OUTPUT", retryable: false },
      });
      expect(textOf(result)).toContain("operation mismatch");
    });
  });

  it("preserves a valid common failure envelope without applying the success-data schema", async () => {
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpFailure(operation, "EXPECTED_FAILURE", "Expected failure.", true, {
          details: { reason: "fixture" },
        });
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation: "untangle_about",
        error: {
          code: "EXPECTED_FAILURE",
          message: "Expected failure.",
          retryable: true,
          details: { reason: "fixture" },
        },
      });
    });
  });

  it("returns CANCELLED before invoking the runtime when the request is already aborted", async () => {
    const definition = definitionFor("untangle_about");
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const result = await executeMcpToolInvocation(
      definition,
      {},
      {
        cwd: process.cwd(),
        env: {},
        workspaceRoots: [realpathSync(process.cwd())],
        signal: controller.signal,
        runtime: {
          async invoke(operation) {
            invoked = true;
            return mcpSuccess(operation, MINIMAL_SUCCESS_DATA[operation]);
          },
        },
      },
    );
    expect(invoked).toBe(false);
    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({
      ok: false,
      operation: "untangle_about",
      error: { code: "CANCELLED", retryable: false },
    });
  });

  it("maps an AbortError thrown during runtime invocation to CANCELLED", async () => {
    const runtime: UntangleMcpRuntime = {
      async invoke() {
        throw new DOMException("cancelled", "AbortError");
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        operation: "untangle_about",
        error: { code: "CANCELLED", retryable: false },
      });
    });
  });

  it("does not publish a late success after cancellation with a non-Error reason", async () => {
    const definition = definitionFor("untangle_about");
    const controller = new AbortController();
    const result = await executeMcpToolInvocation(
      definition,
      {},
      {
        cwd: process.cwd(),
        env: {},
        workspaceRoots: [realpathSync(process.cwd())],
        signal: controller.signal,
        runtime: {
          async invoke(operation) {
            controller.abort("client supplied cancellation reason");
            return mcpSuccess(operation, MINIMAL_SUCCESS_DATA[operation]);
          },
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({
      ok: false,
      operation: "untangle_about",
      error: { code: "CANCELLED", retryable: false },
    });
  });

  it("correlates public success-envelope data with its operation", () => {
    expect(
      toolResponseEnvelopeSchema.safeParse({
        ...mcpSuccess("untangle_about", MINIMAL_SUCCESS_DATA.untangle_about),
        data: MINIMAL_SUCCESS_DATA.untangle_graph_status,
      }).success,
    ).toBe(false);
    expect(
      toolResponseEnvelopeSchema.safeParse({
        ...mcpSuccess("untangle_about", MINIMAL_SUCCESS_DATA.untangle_about),
        operation: "not_an_untangle_tool",
      }).success,
    ).toBe(false);
  });

  it("replaces malformed runtime failures with a valid error envelope", async () => {
    const runtime: UntangleMcpRuntime = {
      async invoke() {
        return { oops: true } as never;
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        operation: "untangle_about",
        error: { code: "INVALID_INTERNAL_OUTPUT", retryable: false },
      });
      expect(JSON.parse(textOf(result))).toEqual(structured(result));
    });
  });

  it("names the explicit blueprint target even when the mutating capability is unavailable", async () => {
    await withClient(undefined, async (client) => {
      const result = await client.callTool({
        name: "untangle_blueprint",
        arguments: { kind: "cli", apply: true, targetDir: "generated/service" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(path.resolve("generated/service"));
      expect(structured(result)).toMatchObject({
        ok: false,
        error: {
          code: "FEATURE_UNAVAILABLE",
          retryable: false,
          details: {
            targetDirectory: path.resolve("generated/service"),
            mutationPerformed: false,
          },
        },
      });
    });
  });

  it("does not ignore an explicit workspace scope on a read tool", async () => {
    await withClient(undefined, async (client) => {
      const result = await client.callTool({
        name: "untangle_projects",
        arguments: { workspaceId: "definitely-not-this-workspace" },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        operation: "untangle_projects",
        workspaceId: "definitely-not-this-workspace",
        error: { code: "WORKSPACE_NOT_FOUND", retryable: false },
      });
    });
  });

  it("blocks an out-of-workspace path before invoking the runtime", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "untangle-mcp-root-"));
    let invoked = false;
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        invoked = true;
        return mcpSuccess(operation, {});
      },
    };

    try {
      await withClient(
        runtime,
        async (client) => {
          const result = await client.callTool({
            name: "untangle_graph_visualize",
            arguments: { out: "../escape.html" },
          });
          expect(result.isError).toBe(true);
          expect(structured(result)).toMatchObject({
            ok: false,
            error: {
              code: "PATH_OUTSIDE_WORKSPACE",
              retryable: false,
              details: { requestedPath: "../escape.html" },
            },
          });
        },
        root,
      );
      expect(invoked).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves existing symlinks when checking containment", () => {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "untangle-mcp-symlink-"));
    const root = path.join(sandbox, "root");
    const outside = path.join(sandbox, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "link"));
    try {
      expect(() =>
        assertPathInsideWorkspace("link/new.html", { cwd: root, workspaceRoots: [root] }),
      ).toThrow(PathOutsideWorkspaceError);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects a dangling symlink whose not-yet-existing target is outside", () => {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "untangle-mcp-dangling-"));
    const root = path.join(sandbox, "root");
    const outside = path.join(sandbox, "outside");
    mkdirSync(root);
    symlinkSync(path.join(outside, "future"), path.join(root, "link"));
    try {
      expect(() =>
        assertPathInsideWorkspace("link/report.html", { cwd: root, workspaceRoots: [root] }),
      ).toThrow(PathOutsideWorkspaceError);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("maps a symbolic-link cycle to INVALID_ARGUMENT without invoking the runtime", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "untangle-mcp-cycle-"));
    symlinkSync("b", path.join(root, "a"));
    symlinkSync("a", path.join(root, "b"));
    let invoked = false;
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        invoked = true;
        return mcpSuccess(operation, MINIMAL_SUCCESS_DATA[operation]);
      },
    };
    try {
      await withClient(
        runtime,
        async (client) => {
          const result = await client.callTool({
            name: "untangle_graph_visualize",
            arguments: { out: "a/report.html" },
          });
          expect(result.isError).toBe(true);
          expect(structured(result)).toMatchObject({
            ok: false,
            error: {
              code: "INVALID_ARGUMENT",
              retryable: false,
              details: { requestedPath: "a/report.html" },
            },
          });
        },
        root,
      );
      expect(invoked).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps an invalid filesystem path to INVALID_ARGUMENT", async () => {
    await withClient(undefined, async (client) => {
      const result = await client.callTool({
        name: "untangle_graph_visualize",
        arguments: { out: "invalid\0path.html" },
      });
      expect(result.isError).toBe(true);
      expect(structured(result)).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENT", retryable: false },
      });
    });
  });

  it("passes canonical paths to the runtime after containment validation", async () => {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "untangle-mcp-canonical-"));
    const root = path.join(sandbox, "root");
    const actual = path.join(root, "actual");
    mkdirSync(root);
    mkdirSync(actual);
    symlinkSync(actual, path.join(root, "link"));
    let seenOutput: unknown;
    const runtime: UntangleMcpRuntime = {
      async invoke(operation, input) {
        seenOutput = input["out"];
        return mcpSuccess(operation, MINIMAL_SUCCESS_DATA.untangle_graph_visualize);
      },
    };
    try {
      await withClient(
        runtime,
        async (client) => {
          await client.callTool({
            name: "untangle_graph_visualize",
            arguments: { out: "link/report.html" },
          });
        },
        root,
      );
      expect(seenOutput).toBe(path.join(realpathSync(actual), "report.html"));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps hostile-looking strings as inert JSON data", async () => {
    const value = "</script><img src=x onerror=alert(1)>";
    const runtime: UntangleMcpRuntime = {
      async invoke(operation) {
        return mcpSuccess(operation, { ...MINIMAL_SUCCESS_DATA.untangle_about, commit: value });
      },
    };
    await withClient(runtime, async (client) => {
      const result = await client.callTool({ name: "untangle_about", arguments: {} });
      expect(structured(result)).toMatchObject({ data: { commit: value } });
      expect(textOf(result)).toContain(value);
    });
  });
});

async function withClient(
  runtime: UntangleMcpRuntime | undefined,
  run: (client: Client) => Promise<void>,
  cwd = process.cwd(),
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createUntangleMcpServer({
    cwd,
    workspaceRoots: [cwd],
    ...(runtime === undefined ? {} : { runtime }),
  });
  const client = new Client({ name: "untangle-contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return block?.type === "text" ? block.text : "";
}

function definitionFor(name: UntangleMcpToolName) {
  const definition = UNTANGLE_MCP_TOOLS.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`missing MCP tool definition for ${name}`);
  return definition;
}

function advertisedEnvelopeBranches(
  schema: unknown,
): [Record<string, unknown>, Record<string, unknown>] {
  if (!isRecord(schema) || !Array.isArray(schema["oneOf"])) {
    throw new Error("advertised output schema has no oneOf envelope variants");
  }
  const branches = schema["oneOf"].filter(isRecord);
  const success = branches.find((branch) => schemaConst(schemaProperties(branch)["ok"]) === true);
  const failure = branches.find((branch) => schemaConst(schemaProperties(branch)["ok"]) === false);
  if (success === undefined || failure === undefined) {
    throw new Error("advertised output schema is missing an ok discriminator variant");
  }
  return [success, failure];
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema["properties"])) return {};
  return schema["properties"];
}

function schemaRequired(schema: unknown): readonly unknown[] {
  if (!isRecord(schema) || !Array.isArray(schema["required"])) return [];
  return schema["required"];
}

function schemaConst(schema: unknown): unknown {
  return isRecord(schema) ? schema["const"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPortfolioData(
  name:
    | "untangle_portfolio_scan"
    | "untangle_stack_matrix"
    | "untangle_who_uses"
    | "untangle_conventions"
    | "untangle_archetypes"
    | "untangle_tech_radar"
    | "untangle_blueprint",
): Record<string, unknown> {
  const copy = structuredClone(MINIMAL_SUCCESS_DATA[name]) as Record<string, unknown>;
  switch (name) {
    case "untangle_portfolio_scan":
      delete copy["jobId"];
      break;
    case "untangle_stack_matrix":
      delete (copy["entries"] as Record<string, unknown>[])[0]?.["adoption"];
      break;
    case "untangle_who_uses":
      delete (copy["usages"] as Record<string, unknown>[])[0]?.["provenance"];
      break;
    case "untangle_conventions":
      delete (copy["conventions"] as Record<string, unknown>[])[0]?.["rule"];
      break;
    case "untangle_archetypes":
      delete (copy["assignments"] as Record<string, unknown>[])[0]?.["signals"];
      break;
    case "untangle_tech_radar":
      delete (copy["entries"] as Record<string, unknown>[])[0]?.["trend"];
      break;
    case "untangle_blueprint":
      delete (copy["recommendations"] as Record<string, unknown>[])[0]?.["components"];
      break;
  }
  return copy;
}
