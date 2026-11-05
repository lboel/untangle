/** AST-backed HTTP boundary facts, separate from import/call graph edges. */
import type { RawImport } from "../analysis.js";

import type { ParseQuality, SourceRange } from "./common.js";

/** Small expression algebra: unknown syntax stays unknown, never evaluated. */
export type HttpExpressionV1 =
  | { kind: "string"; value: string }
  | { kind: "undefined" }
  | { kind: "name"; name: string }
  | { kind: "member"; object: HttpExpressionV1; property: string }
  | { kind: "template"; parts: (string | HttpExpressionV1)[] }
  | {
      kind: "object";
      entries: ({ key: string; value: HttpExpressionV1 } | { spread: HttpExpressionV1 })[];
    }
  | { kind: "call"; callee: HttpExpressionV1; arguments: HttpExpressionV1[] }
  | { kind: "unknown"; detail: string };

export interface HttpCallFactV1 {
  callee: HttpExpressionV1;
  arguments: HttpExpressionV1[];
  range: SourceRange;
  /** Lexical function location, not a graph node identifier. */
  scope: string;
}

export interface HttpFunctionFactV1 {
  scope: string;
  parentScope: string;
  name: string;
  range: SourceRange;
  parameters: { name: string; defaultValue?: HttpExpressionV1; fetchTransport?: boolean }[];
}

export interface HttpBindingFactV1 {
  scope: string;
  name: string;
  value: HttpExpressionV1;
  range: SourceRange;
}

export interface HttpRouterFactV1 {
  name: string;
  scope: string;
  kind: "app" | "router";
  prefix: string | null;
  range: SourceRange;
}

export interface HttpRouteFactV1 {
  router: string;
  scope: string;
  method: string;
  path: string | null;
  handler: string;
  range: SourceRange;
  handlerRange: SourceRange;
}

export interface HttpRouterIncludeFactV1 {
  owner: string;
  scope: string;
  /** Names as written, including module aliases, expanded only for literal tuple loops. */
  router: string;
  prefix: string | null;
  range: SourceRange;
}

export interface HttpPythonImportFactV1 {
  module: string;
  local: string;
  imported?: string;
  range: SourceRange;
}

export interface HttpBoundaryFileFactsV1 {
  path: string;
  contentHash: string;
  languageId: string;
  parseQuality: ParseQuality;
  imports: RawImport[];
  calls: HttpCallFactV1[];
  functions: HttpFunctionFactV1[];
  bindings: HttpBindingFactV1[];
  routers: HttpRouterFactV1[];
  routes: HttpRouteFactV1[];
  includes: HttpRouterIncludeFactV1[];
  pythonImports: HttpPythonImportFactV1[];
  limitations: string[];
}

/** Deployment knowledge must be declared: equal paths alone do not identify a service. */
export interface HttpServiceBindingV1 {
  id: string;
  frontendRoots: string[];
  backendRoots: string[];
  sameOrigin?: boolean;
  origins?: string[];
}

export interface HttpBoundaryProvenanceV1 {
  path: string;
  contentHash: string;
  range: SourceRange;
  kind: "request" | "transport" | "route" | "router" | "include";
  name?: string;
}

export interface HttpEndpointV1 {
  serviceId: string | null;
  method: string;
  path: string;
  handler: string;
  provenance: HttpBoundaryProvenanceV1[];
}

export interface HttpBoundaryRequestV1 {
  source: HttpBoundaryProvenanceV1;
  method: string | null;
  path: string | null;
  origin: string | null;
  status: "resolved" | "ambiguous" | "unresolved";
  reason?: string;
  serviceIds: string[];
  targets: HttpEndpointV1[];
  provenance: HttpBoundaryProvenanceV1[];
}

export interface HttpBoundaryReportV1 {
  schemaVersion: 1;
  kind: "http-boundaries";
  services: HttpServiceBindingV1[];
  endpoints: HttpEndpointV1[];
  requests: HttpBoundaryRequestV1[];
  limitations: { path: string; reason: string }[];
  summary: {
    files: number;
    endpoints: number;
    requests: number;
    resolved: number;
    ambiguous: number;
    unresolved: number;
  };
}
