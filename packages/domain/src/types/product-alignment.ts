/** Declared product boundaries and evidence; no semantic or ownership inference. */
export interface ProductSourceReferenceV1 {
  path: string;
  heading: string;
}

export interface ProductFileSelectionV1 {
  include: string[];
  exclude?: string[];
}

export interface ProductOwnerV1 {
  id: string;
  label: string;
  kind: "person" | "team" | "role";
  status: "declared" | "confirmed";
  /** Confirmation is a manifest declaration, not an independently authenticated identity. */
  confirmedBy?: string;
  sources: ProductSourceReferenceV1[];
}

export interface ProductFeatureV1 {
  /** Stable caller-declared key, shared with feature-tagged Search Journeys. */
  id: string;
  title: string;
  stage: "implemented" | "planned";
  review: "proposed" | "confirmed";
  confirmedBy?: string;
  intent: (ProductSourceReferenceV1 & { role: "vision" | "specification" })[];
  owners: string[];
  code: ProductFileSelectionV1;
  tests: ProductFileSelectionV1;
  criteria: {
    id: string;
    description: string;
    tests: string[];
    /** Exact fully qualified test names. Omitted means the entire selected test-file contract. */
    testNames?: string[];
  }[];
  dependsOn: string[];
  budgets?: {
    maxCognitivePerUnit?: number;
    maxCognitiveTotal?: number;
    maxCodeFiles?: number;
    maxOwners?: number;
  };
}

export interface ProductFeatureManifestV1 {
  schemaVersion: 1;
  owners: ProductOwnerV1[];
  features: ProductFeatureV1[];
}

/** Supplied execution evidence, bound to an entire accepted inventory before and after. */
export interface ProductTestEvidenceV1 {
  schemaVersion: 1;
  sourceTreeBefore: string;
  sourceTreeAfter: string;
  command: string[];
  exitCode: number;
  tests: { path: string; name: string; status: "passed" | "failed" | "skipped" }[];
}

export type ProductEvidenceStatusV1 =
  "resolved" | "missing" | "ambiguous" | "not_in_scan" | "changed" | "unreadable";

export interface ProductSourceEvidenceV1 extends ProductSourceReferenceV1 {
  status: ProductEvidenceStatusV1;
  contentHash?: string;
  startLine?: number;
  endLine?: number;
}

export interface ProductFileEvidenceV1 {
  path: string;
  status:
    | "measured"
    | "not_in_scan"
    | "changed"
    | "unreadable"
    | "unsupported"
    | "partial"
    | "invalid_metrics";
  contentHash?: string;
  scannedContentHash?: string;
}

export interface ProductMetricReadingsV1 {
  top_level: number;
  execution_unit: number;
  self: number;
}

export interface ProductCodeMetricsV1 {
  metricsVersion: string;
  cognitiveAlgorithm: string;
  cognitive: ProductMetricReadingsV1;
  cyclomaticClassic: ProductMetricReadingsV1;
  cyclomaticExtended: ProductMetricReadingsV1;
  files: number;
  scopes: number;
  executionUnitRoots: number;
  sloc: number;
  /** Cyclomatic includes a base of one per contributing scope. */
  cyclomaticPerScopeBase: 1;
}

export interface ProductHotspotV1 {
  path: string;
  contentHash: string;
  symbol: string;
  scopeId: string;
  startLine: number;
  endLine: number;
  cognitive: number;
  cyclomaticClassic: number;
  cyclomaticExtended: number;
}

export interface ProductAgentHintV1 {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  paths: string[];
  suggestedAction: string;
  /** Suggested independent search requests; they do not replace full-file analysis. */
  search?: { symbol: string; path: string; requireFresh: true };
}

export interface ProductFeatureAlignmentV1 {
  id: string;
  title: string;
  stage: ProductFeatureV1["stage"];
  review: ProductFeatureV1["review"];
  status: "evidence_consistent" | "needs_review" | "incomplete" | "violated";
  intent: (ProductSourceEvidenceV1 & { role: "vision" | "specification" })[];
  ownership: {
    id: string;
    label?: string;
    status: "declared" | "confirmed" | "missing";
    sources: ProductSourceEvidenceV1[];
  }[];
  code: {
    complete: boolean;
    files: ProductFileEvidenceV1[];
    metrics: ProductCodeMetricsV1 | null;
    hotspots: ProductHotspotV1[];
  };
  tests: {
    complete: boolean;
    files: ProductFileEvidenceV1[];
    metrics: ProductCodeMetricsV1 | null;
  };
  testEvidence: {
    status: "bound_passed" | "bound_failed" | "not_run" | "stale" | "invalid";
    passed: number;
    failed: number;
    skipped: number;
    proof: "supplied_source_bound_report" | "none";
  };
  criteria: {
    id: string;
    description: string;
    matchedFiles: string[];
    status: "passed" | "failed" | "not_run" | "missing_tests" | "unverified";
  }[];
  dimensions: {
    requirements: number;
    owners: number;
    codeFiles: number;
    testFiles: number;
    sharedCodeFiles: number;
    declaredDependencies: number;
    dependentFeatures: number;
  };
  dependsOn: string[];
  agentHints: ProductAgentHintV1[];
  issues: string[];
}

export interface ProductAlignmentReportV1 {
  schemaVersion: 1;
  root: string;
  status:
    | "needs_manifest"
    | "invalid_manifest"
    | "evidence_consistent"
    | "needs_review"
    | "incomplete"
    | "violated";
  manifest: {
    path: string;
    status: "missing" | "loaded" | "invalid" | "not_in_scan" | "changed" | "unreadable";
    contentHash?: string;
  };
  sourceTreeDigest: string;
  inventory: { files: number; truncated: boolean; excluded: number };
  semanticConformance: "not_independently_proven";
  ownershipAuthority: "manifest_declarations";
  /** Literal search-hit lookup; feature metrics and coverage retain their full scope. */
  selection?: {
    path: string;
    status: "matched" | "unmapped" | "missing" | "not_in_scan" | "changed" | "unreadable";
    matches: { featureId: string; roles: ("code" | "test" | "intent" | "ownership")[] }[];
  };
  /** Present only after explicit local test execution. Reports are not authenticated. */
  testRun?: {
    status:
      | "completed"
      | "stale"
      | "invalid_report"
      | "spawn_failed"
      | "timed_out"
      | "output_limit"
      | "cancelled";
    directory: string;
    receiptPath: string;
    exitCode: number | null;
    issue?: string;
  };
  features: ProductFeatureAlignmentV1[];
  coverage: {
    measuredCodeFiles: number;
    mappedCodeFiles: number;
    unmappedCodeFiles: string[];
    unmappedCodeFileCount: number;
    sharedFiles: { path: string; featureIds: string[] }[];
    /** Unique union, never the sum of per-feature metrics. */
    mappedCodeUnion: ProductCodeMetricsV1 | null;
  };
  dependencyCycles: string[][];
  issues: string[];
  limitations: string[];
  draft: ProductFeatureManifestV1 | null;
}
