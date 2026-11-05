/**
 * Structural input contracts keep this renderer independent from graph
 * builders and stores. The corresponding Untangle snapshots satisfy these
 * shapes without conversion, while the generated artifact only retains the
 * explicitly listed, source-free metadata.
 */

export interface ExplorerRepositoryV1 {
  repoId: string;
  label?: string;
  refId?: string;
  refName?: string;
  commitSha?: string;
}

export interface ExplorerWorkspaceSnapshotV1 {
  workspaceId: string;
  label?: string;
  generationId?: string;
  repositories?: readonly ExplorerRepositoryV1[];
}

export interface ExplorerFileNodeV1 {
  fileId: string;
  repoId: string;
  refId: string;
  filePath: string;
  language: string;
  packageName?: string;
  containerService?: string;
}

export interface ExplorerFileEdgeResolutionV1 {
  status: "resolved" | "external" | "unresolved";
  targetFileId?: string;
  targetRepoId?: string;
  targetRefId?: string;
  targetPath?: string;
  mechanism?: string;
  reason?: string;
}

export interface ExplorerFileEdgeV1 {
  edgeId: string;
  repoId: string;
  refId: string;
  fromFileId: string;
  kind: string;
  resolution: ExplorerFileEdgeResolutionV1;
  boundary?: {
    crossRepo?: boolean;
    crossPackage?: boolean;
    crossContainer?: boolean;
  };
}

export interface ExplorerFileGraphSnapshotV1 {
  schemaVersion: 1;
  workspaceId: string;
  graphGeneration: string;
  nodes: readonly ExplorerFileNodeV1[];
  edges: readonly ExplorerFileEdgeV1[];
}

export interface ExplorerSymbolNodeV1 {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  repoId: string;
  refId: string;
  fileId: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
}

export interface ExplorerSymbolTargetV1 {
  symbolId: string;
  qualifiedName?: string;
  repoId?: string;
  refId?: string;
  filePath?: string;
  /** Candidate-specific confidence for ambiguous symbol edges. */
  weight?: number;
}

export interface ExplorerSymbolEdgeV1 {
  edgeId: string;
  repoId: string;
  refId: string;
  fromSymbolId: string;
  kind: string;
  resolution: string;
  target?: ExplorerSymbolTargetV1;
  candidates?: readonly ExplorerSymbolTargetV1[];
  confidence?: { value: number; basis?: string; signals?: readonly string[] };
  crossRepo?: boolean;
}

export interface ExplorerSymbolGraphSnapshotV1 {
  schemaVersion: 1;
  workspaceId: string;
  graphGeneration: string;
  nodes: readonly ExplorerSymbolNodeV1[];
  edges: readonly ExplorerSymbolEdgeV1[];
}

export interface GraphExplorerInputV1 {
  fileGraph: ExplorerFileGraphSnapshotV1;
  symbolGraph?: ExplorerSymbolGraphSnapshotV1 | null;
  workspace?: ExplorerWorkspaceSnapshotV1;
}

export type GraphExplorerViewKind = "file" | "symbol";
export type GraphExplorerLayoutKind = "repository-lanes" | "grid" | "circle";

export interface GraphExplorerOptions {
  /** Visible title in the explorer. Default: `Untangle Graph Explorer`. */
  title?: string;
  /** Per-view node budget. Default: 600; maximum: 10,000. */
  maxNodes?: number;
  /** Per-view renderable-link budget. Default: 1,200; maximum: 30,000. */
  maxEdges?: number;
  /** Falls back visibly to `file` if no symbol snapshot was supplied. */
  initialView?: GraphExplorerViewKind;
  /** Default deterministic layout. */
  initialLayout?: GraphExplorerLayoutKind;
}

export interface GraphExplorerWriteOptions extends GraphExplorerOptions {
  /** File mode used for the atomically replaced destination. Default: 0o600. */
  mode?: number;
}

export interface GraphExplorerViewStatsV1 {
  inputNodeCount: number;
  shownNodeCount: number;
  nodeLimitDroppedCount: number;
  sourceEdgeCount: number;
  candidateLinkCount: number;
  renderableLinkCount: number;
  shownLinkCount: number;
  unrenderableSourceEdgeCount: number;
  missingEndpointLinkCount: number;
  nodeLimitDroppedLinkCount: number;
  edgeLimitDroppedLinkCount: number;
}

export interface GraphExplorerArtifact {
  html: string;
  bytes: number;
  sha256: string;
  limits: { maxNodes: number; maxEdges: number };
  views: Record<GraphExplorerViewKind, GraphExplorerViewStatsV1 | null>;
}

export interface GraphExplorerWriteResult {
  path: string;
  bytes: number;
  sha256: string;
  limits: { maxNodes: number; maxEdges: number };
  views: Record<GraphExplorerViewKind, GraphExplorerViewStatsV1 | null>;
}

/** Internal serialized model; exported for deterministic downstream audits. */
export interface GraphExplorerDocumentDataV1 {
  schemaVersion: 1;
  title: string;
  workspace: {
    id: string;
    label: string;
    generation: string;
    repositories: ExplorerDocumentRepositoryV1[];
  };
  limits: { maxNodes: number; maxEdges: number };
  initialView: GraphExplorerViewKind;
  initialViewFallback: boolean;
  initialLayout: GraphExplorerLayoutKind;
  views: {
    file: ExplorerDocumentViewV1;
    symbol: ExplorerDocumentViewV1 | null;
  };
}

export interface ExplorerDocumentRepositoryV1 {
  id: string;
  label: string;
  refId?: string;
  refName?: string;
  commitSha?: string;
}

export interface ExplorerDocumentNodeV1 {
  id: string;
  label: string;
  secondary: string;
  repoId: string;
  refId: string;
  filePath: string;
  language: string;
  kind: string;
  startLine?: number;
  endLine?: number;
  packageName?: string;
  containerService?: string;
  searchText: string;
}

export interface ExplorerDocumentEdgeV1 {
  id: string;
  sourceEdgeId: string;
  from: string;
  to: string;
  kind: string;
  resolution: string;
  crossRepo: boolean;
  /** Edge confidence, or candidate weight for an ambiguous symbol link. */
  confidence?: number;
}

export interface ExplorerDocumentViewV1 {
  kind: GraphExplorerViewKind;
  generation: string;
  nodes: ExplorerDocumentNodeV1[];
  edges: ExplorerDocumentEdgeV1[];
  repositories: string[];
  edgeTypes: string[];
  stats: GraphExplorerViewStatsV1;
}
