import type {
  FileSystemPort,
  HttpBoundaryReportV1,
  HttpServiceBindingV1,
  ParserRegistry,
  ProductFeatureV1,
  SourceRange,
} from "@untangle-code/domain";

import type { ProductInventoryScopeV1 } from "../product-alignment/analysis.js";

export interface FrontendBoundaryOptionsV1 {
  root: string;
  services?: readonly HttpServiceBindingV1[];
  /** Literal repository-relative file; filters output after the entire census. */
  path?: string;
  featureManifestPath?: string;
  fs?: FileSystemPort;
  parserRegistry?: ParserRegistry;
  signal?: AbortSignal;
  inventoryScope?: ProductInventoryScopeV1;
  /** Output relations per section, 1..1000. Full summary counts remain visible. */
  maxRelations?: number;
}

export interface FrontendImportEdgeV1 {
  fromPath: string;
  toPath: string;
  rawSpecifier: string;
  range: SourceRange;
  sourceHash: string;
  targetHash: string;
}

export interface FrontendBoundaryIssueV1 {
  path: string;
  reason: string;
}

export interface FrontendFeatureAssociationV1 {
  path: string;
  matches: {
    featureId: string;
    title: string;
    role: "code" | "test";
    review: ProductFeatureV1["review"];
    ownership: { id: string; label?: string; status: "declared" | "confirmed" | "missing" }[];
    declaredDependsOn: string[];
  }[];
}

export interface FrontendBoundaryReportV1 {
  schemaVersion: 1;
  kind: "frontend-boundaries";
  root: string;
  status: "complete" | "incomplete" | "stale";
  sourceTreeDigest: string;
  freshness: {
    status: "fresh" | "stale";
    sourceTreeBefore: string;
    sourceTreeAfter: string;
    changedPaths: string[];
  };
  inventory: {
    files: number;
    excluded: number;
    truncated: boolean;
    analyzed: number;
    unsupported: number;
    failed: number;
  };
  selection?: { path: string; inInventory: boolean; matchingRequests: number };
  http: HttpBoundaryReportV1;
  importContext: {
    kind: "file-imports-not-function-calls";
    edges: FrontendImportEdgeV1[];
    requestImporters: {
      requestPath: string;
      path: string;
      contentHash: string;
      distance: number;
      via: FrontendImportEdgeV1[];
    }[];
    unresolved: FrontendBoundaryIssueV1[];
    summary: { edges: number; unresolved: number; requestImporters: number };
    truncated: boolean;
  };
  features: {
    manifest: {
      path: string;
      status: "loaded" | "missing" | "invalid" | "changed" | "unreadable" | "not_in_scan";
      contentHash?: string;
    };
    associations: FrontendFeatureAssociationV1[];
    associationCount: number;
    dependencySemantics: "declared_dependencies_unchanged";
  };
  truncation: {
    truncated: boolean;
    limit: number;
    omittedRequests: number;
    omittedEndpoints: number;
    omittedIssues: number;
    omittedFeatureAssociations: number;
  };
  issues: FrontendBoundaryIssueV1[];
  limitations: string[];
}
