import type { FileSystemPort, ProductFeatureManifestV1 } from "@untangle-code/domain";

export type SddFrameworkV1 = "spec-kit" | "openspec";
export interface SddConnectionOptionsV1 {
  root: string;
  framework?: SddFrameworkV1 | "auto";
  signal?: AbortSignal;
  fs?: FileSystemPort;
}
export interface SddSourceV1 {
  path: string;
  sha256: string;
  bytes: number;
}
export interface SddRequirementV1 {
  id: string;
  description: string;
  /** Actual requirement/scenario text, excluding examples and child headings. */
  body: string;
  path: string;
  line: number;
  heading: string;
  kind: "requirement" | "success_criterion" | "scenario";
  change?: "added" | "modified" | "removed";
}
export interface SddTaskV1 {
  id: string;
  description: string;
  checked: boolean;
  path: string;
  line: number;
  story?: string;
}
export interface SddFileReferenceV1 {
  literal: string;
  sourcePath: string;
  line: number;
  path: string | null;
  role: "code" | "test" | "document";
  status: "resolved" | "missing" | "unsafe" | "unreadable" | "ambiguous";
  sha256?: string;
}
export interface SddFeatureV1 {
  id: string;
  title: string;
  framework: SddFrameworkV1;
  kind: "feature" | "capability" | "change";
  directory: string;
  documents: string[];
  requirements: SddRequirementV1[];
  tasks: SddTaskV1[];
  references: SddFileReferenceV1[];
}
export interface SddConnectionReportV1 {
  schemaVersion: 1;
  kind: "sdd_connection";
  root: string;
  requestedFramework: SddFrameworkV1 | "auto";
  frameworks: SddFrameworkV1[];
  status: "connected" | "not_detected" | "incomplete" | "stale";
  sourceDigest: string;
  sources: SddSourceV1[];
  features: SddFeatureV1[];
  draft: ProductFeatureManifestV1;
  issues: { code: string; path: string; message: string }[];
  limitations: string[];
  upstream: { framework: SddFrameworkV1; revision: string; documents: string[] }[];
}
