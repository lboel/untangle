import { GraphExplorerInputError } from "./errors.js";
import type {
  ExplorerDocumentEdgeV1,
  ExplorerDocumentNodeV1,
  ExplorerDocumentRepositoryV1,
  ExplorerDocumentViewV1,
  ExplorerFileEdgeV1,
  ExplorerFileNodeV1,
  ExplorerRepositoryV1,
  ExplorerSymbolEdgeV1,
  ExplorerSymbolNodeV1,
  GraphExplorerDocumentDataV1,
  GraphExplorerInputV1,
  GraphExplorerLayoutKind,
  GraphExplorerOptions,
  GraphExplorerViewKind,
  GraphExplorerViewStatsV1,
} from "./types.js";

export const DEFAULT_MAX_NODES = 600;
export const DEFAULT_MAX_EDGES = 1_200;
export const MAX_MAX_NODES = 10_000;
export const MAX_MAX_EDGES = 30_000;

interface ViewSource<Node, Edge> {
  kind: GraphExplorerViewKind;
  generation: string;
  nodes: readonly Node[];
  edges: readonly Edge[];
}

interface CandidateEdge {
  sourceEdgeId: string;
  from: string;
  to: string;
  kind: string;
  resolution: string;
  confidence?: number;
}

interface SymbolCandidate {
  id: string;
  confidence?: number;
}

export function normalizeGraphExplorerInput(
  input: GraphExplorerInputV1,
  options: GraphExplorerOptions = {},
): GraphExplorerDocumentDataV1 {
  const maxNodes = positiveInteger(
    options.maxNodes ?? DEFAULT_MAX_NODES,
    "maxNodes",
    MAX_MAX_NODES,
  );
  const maxEdges = positiveInteger(
    options.maxEdges ?? DEFAULT_MAX_EDGES,
    "maxEdges",
    MAX_MAX_EDGES,
  );
  const title = safeText(options.title ?? "Untangle Graph Explorer", "title", 200);
  const initialLayout = layoutKind(options.initialLayout ?? "repository-lanes");
  const requestedView = viewKind(options.initialView ?? "file");

  assertSnapshotHeader(input.fileGraph, "fileGraph");
  const workspaceId = input.fileGraph.workspaceId;
  const generation = input.fileGraph.graphGeneration;
  if (input.workspace !== undefined) {
    const declaredWorkspace = safeText(input.workspace.workspaceId, "workspace.workspaceId");
    if (declaredWorkspace !== workspaceId) {
      invalid(
        `workspace.workspaceId "${declaredWorkspace}" does not match fileGraph.workspaceId "${workspaceId}"`,
      );
    }
    if (input.workspace.generationId !== undefined) {
      const declaredGeneration = safeText(input.workspace.generationId, "workspace.generationId");
      if (declaredGeneration !== generation) {
        invalid(
          `workspace.generationId "${declaredGeneration}" does not match fileGraph.graphGeneration "${generation}"`,
        );
      }
    }
  }

  if (input.symbolGraph !== undefined && input.symbolGraph !== null) {
    assertSnapshotHeader(input.symbolGraph, "symbolGraph");
    if (input.symbolGraph.workspaceId !== workspaceId) {
      invalid("symbolGraph.workspaceId does not match fileGraph.workspaceId");
    }
    if (input.symbolGraph.graphGeneration !== generation) {
      invalid("symbolGraph.graphGeneration does not match fileGraph.graphGeneration");
    }
  }

  const repositoryMap = collectRepositories(input);
  const file = normalizeView(
    {
      kind: "file",
      generation,
      nodes: input.fileGraph.nodes,
      edges: input.fileGraph.edges,
    },
    maxNodes,
    maxEdges,
    normalizeFileNode,
    fileEdgeCandidates,
  );
  const symbol =
    input.symbolGraph === undefined || input.symbolGraph === null
      ? null
      : normalizeView(
          {
            kind: "symbol",
            generation,
            nodes: input.symbolGraph.nodes,
            edges: input.symbolGraph.edges,
          },
          maxNodes,
          maxEdges,
          normalizeSymbolNode,
          symbolEdgeCandidates,
        );

  for (const repoId of [...file.repositories, ...(symbol?.repositories ?? [])]) {
    if (!repositoryMap.has(repoId)) {
      repositoryMap.set(repoId, { id: repoId, label: repoId });
    }
  }

  const initialViewFallback = requestedView === "symbol" && symbol === null;
  return {
    schemaVersion: 1,
    title,
    workspace: {
      id: workspaceId,
      label:
        input.workspace?.label === undefined
          ? workspaceId
          : safeText(input.workspace.label, "workspace.label", 500),
      generation,
      repositories: [...repositoryMap.values()].sort(compareRepositories),
    },
    limits: { maxNodes, maxEdges },
    initialView: initialViewFallback ? "file" : requestedView,
    initialViewFallback,
    initialLayout,
    views: { file, symbol },
  };
}

function normalizeView<Node, Edge>(
  source: ViewSource<Node, Edge>,
  maxNodes: number,
  maxEdges: number,
  normalizeNode: (node: Node, index: number) => ExplorerDocumentNodeV1,
  edgeCandidates: (edge: Edge, index: number) => CandidateEdge[],
): ExplorerDocumentViewV1 {
  const normalizedNodes = source.nodes.map(normalizeNode);
  assertUnique(
    normalizedNodes.map((node) => node.id),
    `${source.kind} node id`,
  );
  normalizedNodes.sort(compareNodes);
  const allNodeIds = new Set(normalizedNodes.map((node) => node.id));
  const nodeById = new Map(normalizedNodes.map((node) => [node.id, node]));
  const shownNodes = normalizedNodes.slice(0, maxNodes);
  const shownNodeIds = new Set(shownNodes.map((node) => node.id));

  const sourceEdgeIds: string[] = [];
  const edgeTypes = new Set<string>();
  const candidates: CandidateEdge[] = [];
  let unrenderableSourceEdgeCount = 0;
  source.edges.forEach((edge, index) => {
    const normalized = edgeCandidates(edge, index);
    const sourceEdgeId = normalizedSourceEdgeId(edge, index, source.kind);
    sourceEdgeIds.push(sourceEdgeId);
    const kind = normalizedSourceEdgeKind(edge, index, source.kind);
    edgeTypes.add(kind);
    if (normalized.length === 0) unrenderableSourceEdgeCount++;
    candidates.push(...normalized);
  });
  assertUnique(sourceEdgeIds, `${source.kind} source edge id`);
  candidates.sort(compareCandidateEdges);

  let missingEndpointLinkCount = 0;
  let nodeLimitDroppedLinkCount = 0;
  const renderable: CandidateEdge[] = [];
  for (const candidate of candidates) {
    if (!allNodeIds.has(candidate.from) || !allNodeIds.has(candidate.to)) {
      missingEndpointLinkCount++;
      continue;
    }
    if (!shownNodeIds.has(candidate.from) || !shownNodeIds.has(candidate.to)) {
      nodeLimitDroppedLinkCount++;
      continue;
    }
    renderable.push(candidate);
  }
  const shownCandidates = renderable.slice(0, maxEdges);
  const edges = shownCandidates.map((edge, index): ExplorerDocumentEdgeV1 => ({
    id: candidateLinkId(edge, index),
    sourceEdgeId: edge.sourceEdgeId,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    resolution: edge.resolution,
    crossRepo: nodeById.get(edge.from)?.repoId !== nodeById.get(edge.to)?.repoId,
    ...(edge.confidence === undefined ? {} : { confidence: edge.confidence }),
  }));

  const stats: GraphExplorerViewStatsV1 = {
    inputNodeCount: normalizedNodes.length,
    shownNodeCount: shownNodes.length,
    nodeLimitDroppedCount: normalizedNodes.length - shownNodes.length,
    sourceEdgeCount: source.edges.length,
    candidateLinkCount: candidates.length,
    renderableLinkCount: renderable.length,
    shownLinkCount: edges.length,
    unrenderableSourceEdgeCount,
    missingEndpointLinkCount,
    nodeLimitDroppedLinkCount,
    edgeLimitDroppedLinkCount: renderable.length - edges.length,
  };

  return {
    kind: source.kind,
    generation: source.generation,
    nodes: shownNodes,
    edges,
    repositories: uniqueSorted(shownNodes.map((node) => node.repoId)),
    edgeTypes: uniqueSorted([...edgeTypes]),
    stats,
  };
}

function normalizeFileNode(node: ExplorerFileNodeV1, index: number): ExplorerDocumentNodeV1 {
  const at = `fileGraph.nodes[${String(index)}]`;
  const id = safeText(node.fileId, `${at}.fileId`);
  const repoId = safeText(node.repoId, `${at}.repoId`);
  const refId = safeText(node.refId, `${at}.refId`);
  const filePath = safeText(node.filePath, `${at}.filePath`, 8_192);
  const language = safeText(node.language, `${at}.language`, 200);
  const packageName = optionalSafeText(node.packageName, `${at}.packageName`, 500);
  const containerService = optionalSafeText(node.containerService, `${at}.containerService`, 500);
  return {
    id,
    label: basename(filePath),
    secondary: filePath,
    repoId,
    refId,
    filePath,
    language,
    kind: "file",
    ...(packageName === undefined ? {} : { packageName }),
    ...(containerService === undefined ? {} : { containerService }),
    searchText: [filePath, repoId, refId, language, packageName, containerService]
      .filter((part): part is string => part !== undefined)
      .join(" ")
      .toLowerCase(),
  };
}

function normalizeSymbolNode(node: ExplorerSymbolNodeV1, index: number): ExplorerDocumentNodeV1 {
  const at = `symbolGraph.nodes[${String(index)}]`;
  const id = safeText(node.id, `${at}.id`);
  const name = safeText(node.name, `${at}.name`, 2_000);
  const qualifiedName = safeText(node.qualifiedName, `${at}.qualifiedName`, 4_000);
  const repoId = safeText(node.repoId, `${at}.repoId`);
  const refId = safeText(node.refId, `${at}.refId`);
  const filePath = safeText(node.filePath, `${at}.filePath`, 8_192);
  const language = safeText(node.language, `${at}.language`, 200);
  const kind = safeText(node.kind, `${at}.kind`, 200);
  const startLine = nonNegativeInteger(node.startLine, `${at}.startLine`);
  const endLine = nonNegativeInteger(node.endLine, `${at}.endLine`);
  if (endLine < startLine) invalid(`${at}.endLine must be greater than or equal to startLine`);
  return {
    id,
    label: qualifiedName,
    secondary: `${filePath}:${String(startLine)}`,
    repoId,
    refId,
    filePath,
    language,
    kind,
    startLine,
    endLine,
    searchText: [name, qualifiedName, kind, filePath, repoId, refId, language]
      .join(" ")
      .toLowerCase(),
  };
}

function fileEdgeCandidates(edge: ExplorerFileEdgeV1, index: number): CandidateEdge[] {
  const at = `fileGraph.edges[${String(index)}]`;
  const sourceEdgeId = safeText(edge.edgeId, `${at}.edgeId`);
  const from = safeText(edge.fromFileId, `${at}.fromFileId`);
  const kind = safeText(edge.kind, `${at}.kind`, 200);
  const resolution = safeText(edge.resolution.status, `${at}.resolution.status`, 200);
  if (resolution !== "resolved" && resolution !== "external" && resolution !== "unresolved") {
    invalid(`${at}.resolution.status is not supported`);
  }
  if (resolution !== "resolved") return [];
  const target = optionalSafeText(edge.resolution.targetFileId, `${at}.resolution.targetFileId`);
  if (target === undefined)
    invalid(`${at}.resolution.targetFileId is required for a resolved edge`);
  return [
    {
      sourceEdgeId,
      from,
      to: target,
      kind,
      resolution,
    },
  ];
}

function symbolEdgeCandidates(edge: ExplorerSymbolEdgeV1, index: number): CandidateEdge[] {
  const at = `symbolGraph.edges[${String(index)}]`;
  const sourceEdgeId = safeText(edge.edgeId, `${at}.edgeId`);
  const from = safeText(edge.fromSymbolId, `${at}.fromSymbolId`);
  const kind = safeText(edge.kind, `${at}.kind`, 200);
  const resolution = safeText(edge.resolution, `${at}.resolution`, 200);
  if (
    resolution !== "exact" &&
    resolution !== "heuristic" &&
    resolution !== "ambiguous" &&
    resolution !== "unresolved"
  ) {
    invalid(`${at}.resolution is not supported`);
  }
  const confidence = optionalProbability(edge.confidence?.value, `${at}.confidence.value`);
  const targets: SymbolCandidate[] =
    resolution === "ambiguous"
      ? (edge.candidates ?? []).map((candidate, candidateIndex) => ({
          id: safeText(candidate.symbolId, `${at}.candidates[${String(candidateIndex)}].symbolId`),
          ...(candidate.weight === undefined
            ? confidence === undefined
              ? {}
              : { confidence }
            : {
                confidence: probability(
                  candidate.weight,
                  `${at}.candidates[${String(candidateIndex)}].weight`,
                ),
              }),
        }))
      : edge.target === undefined
        ? []
        : [
            {
              id: safeText(edge.target.symbolId, `${at}.target.symbolId`),
              ...(confidence === undefined ? {} : { confidence }),
            },
          ];
  assertUnique(
    targets.map((target) => target.id),
    `${at} candidate symbol id`,
  );
  targets.sort((left, right) => compareCodepoints(left.id, right.id));
  return targets.map((target) => ({
    sourceEdgeId,
    from,
    to: target.id,
    kind,
    resolution,
    ...(target.confidence === undefined ? {} : { confidence: target.confidence }),
  }));
}

function collectRepositories(
  input: GraphExplorerInputV1,
): Map<string, ExplorerDocumentRepositoryV1> {
  const repositories = new Map<string, ExplorerDocumentRepositoryV1>();
  const declared = input.workspace?.repositories ?? [];
  declared.forEach((repo: ExplorerRepositoryV1, index) => {
    const at = `workspace.repositories[${String(index)}]`;
    const id = safeText(repo.repoId, `${at}.repoId`);
    if (repositories.has(id)) invalid(`duplicate workspace repository id "${id}"`);
    repositories.set(id, {
      id,
      label: repo.label === undefined ? id : safeText(repo.label, `${at}.label`, 500),
      ...(repo.refId === undefined ? {} : { refId: safeText(repo.refId, `${at}.refId`) }),
      ...(repo.refName === undefined
        ? {}
        : { refName: safeText(repo.refName, `${at}.refName`, 500) }),
      ...(repo.commitSha === undefined
        ? {}
        : { commitSha: safeText(repo.commitSha, `${at}.commitSha`, 500) }),
    });
  });
  return repositories;
}

function assertSnapshotHeader(
  value: { schemaVersion: 1; workspaceId: string; graphGeneration: string },
  at: string,
): void {
  if (value.schemaVersion !== 1) invalid(`${at}.schemaVersion must be 1`);
  safeText(value.workspaceId, `${at}.workspaceId`);
  safeText(value.graphGeneration, `${at}.graphGeneration`);
  if (!Array.isArray((value as { nodes?: unknown }).nodes)) invalid(`${at}.nodes must be an array`);
  if (!Array.isArray((value as { edges?: unknown }).edges)) invalid(`${at}.edges must be an array`);
}

function normalizedSourceEdgeId(edge: unknown, index: number, kind: GraphExplorerViewKind): string {
  if (typeof edge !== "object" || edge === null)
    invalid(`${kind} edge ${String(index)} must be an object`);
  return safeText((edge as { edgeId?: unknown }).edgeId, `${kind} edge ${String(index)}.edgeId`);
}

function normalizedSourceEdgeKind(
  edge: unknown,
  index: number,
  kind: GraphExplorerViewKind,
): string {
  if (typeof edge !== "object" || edge === null)
    invalid(`${kind} edge ${String(index)} must be an object`);
  return safeText((edge as { kind?: unknown }).kind, `${kind} edge ${String(index)}.kind`, 200);
}

function candidateLinkId(edge: CandidateEdge, index: number): string {
  return `${String(edge.sourceEdgeId.length)}:${edge.sourceEdgeId}:${String(edge.to.length)}:${edge.to}:${String(index)}`;
}

function compareCandidateEdges(left: CandidateEdge, right: CandidateEdge): number {
  return (
    compareCodepoints(left.from, right.from) ||
    compareCodepoints(left.to, right.to) ||
    compareCodepoints(left.kind, right.kind) ||
    compareCodepoints(left.sourceEdgeId, right.sourceEdgeId)
  );
}

function compareNodes(left: ExplorerDocumentNodeV1, right: ExplorerDocumentNodeV1): number {
  return (
    compareCodepoints(left.repoId, right.repoId) ||
    compareCodepoints(left.filePath, right.filePath) ||
    compareCodepoints(left.id, right.id)
  );
}

function compareRepositories(
  left: ExplorerDocumentRepositoryV1,
  right: ExplorerDocumentRepositoryV1,
): number {
  return compareCodepoints(left.id, right.id);
}

export function compareCodepoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0) as number);
  const rightPoints = [...right].map((value) => value.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodepoints);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`duplicate ${label} "${value}"`);
    seen.add(value);
  }
}

function safeText(value: unknown, label: string, maxLength = 4_096): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`${label} must be a non-empty string`);
  if (value.length > maxLength) invalid(`${label} exceeds ${String(maxLength)} UTF-16 code units`);
  if (hasUnsafeDisplayControl(value)) invalid(`${label} contains unsafe control characters`);
  return value;
}

function hasUnsafeDisplayControl(value: string): boolean {
  for (const character of value) {
    const codepoint = character.codePointAt(0) as number;
    if (
      codepoint <= 0x1f ||
      (codepoint >= 0x7f && codepoint <= 0x9f) ||
      (codepoint >= 0x202a && codepoint <= 0x202e) ||
      (codepoint >= 0x2066 && codepoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function optionalSafeText(value: unknown, label: string, maxLength = 4_096): string | undefined {
  if (value === undefined) return undefined;
  return safeText(value, label, maxLength);
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > maximum) {
    invalid(`${label} must be an integer between 1 and ${String(maximum)}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function optionalProbability(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return probability(value, label);
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${label} must be a finite number in [0, 1]`);
  }
  return value;
}

function viewKind(value: unknown): GraphExplorerViewKind {
  if (value === "file" || value === "symbol") return value;
  return invalid('initialView must be "file" or "symbol"');
}

function layoutKind(value: unknown): GraphExplorerLayoutKind {
  if (value === "repository-lanes" || value === "grid" || value === "circle") return value;
  return invalid('initialLayout must be "repository-lanes", "grid", or "circle"');
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1) || path;
}

function invalid(message: string): never {
  throw new GraphExplorerInputError(message);
}
