/**
 * Persistierte File-/Symbolgraphen -> schmaler Search-Anreicherungsport.
 *
 * Hier (und nicht in `@untangle-code/search`) duerfen die konkreten
 * Graphpakete bekannt sein. Gelesen wird immer mit Workspace UND Generation;
 * ein ungescoptes `latest` kommt auf diesem Pfad nicht vor.
 */
import type {
  FileEdgeV1,
  FileNodeV1,
  GraphStore,
  PortCallOptions,
  SearchGraphOmissionV1,
  SearchGraphRelationV1,
  SymbolEdgeV1,
  SymbolNodeV1,
  ToolWarningV1,
} from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";
import {
  readGraphSnapshot,
  type FileGraphSnapshotV1,
  type SnapshotReadIssue,
} from "@untangle-code/file-graph";
import {
  SEARCH_GRAPH_RELATION_LIMIT,
  boundSearchGraphDetail,
  createSearchGraphRelations,
  unavailableSearchGraphRelations,
  type SearchGraphEnrichmentEntryV1,
  type SearchGraphEnrichmentPort,
  type SearchGraphEnrichmentRequestV1,
  type SearchGraphEnrichmentTargetV1,
} from "@untangle-code/search";
import {
  readSymbolGraphSnapshot,
  type SymbolGraphSnapshotReadIssue,
  type SymbolGraphV1,
} from "@untangle-code/symbol-graph";

interface EnrichmentScope {
  workspaceId: string;
  generationId: string;
  targets: SearchGraphEnrichmentTargetV1[];
}

interface FileGraphLookup {
  nodes: ReadonlyMap<string, FileNodeV1>;
  outgoing: ReadonlyMap<string, readonly FileEdgeV1[]>;
  incoming: ReadonlyMap<string, readonly FileEdgeV1[]>;
}

interface SymbolGraphLookup {
  nodes: ReadonlyMap<string, SymbolNodeV1>;
  outgoing: ReadonlyMap<string, readonly SymbolEdgeV1[]>;
  incoming: ReadonlyMap<string, readonly SymbolEdgeV1[]>;
}

/** Warnungsdetails bleiben auch bei tausenden fehlenden Shards endlich. */
export const SEARCH_GRAPH_WARNING_ISSUE_LIMIT = 16;

/** Baut den graph-backed Adapter; der Konstruktor selbst fuehrt keinerlei I/O aus. */
export function createSearchGraphEnrichment(graphStore: GraphStore): SearchGraphEnrichmentPort {
  return {
    enrich(request, options) {
      return enrichFromPersistedGraphs(graphStore, request, options);
    },
  };
}

async function enrichFromPersistedGraphs(
  graphStore: GraphStore,
  request: SearchGraphEnrichmentRequestV1,
  options?: PortCallOptions,
): Promise<{ entries: SearchGraphEnrichmentEntryV1[]; warnings: ToolWarningV1[] }> {
  if (!Number.isInteger(request.relationLimit) || request.relationLimit <= 0) {
    throw new TypeError("search graph relationLimit must be a positive integer");
  }
  options?.signal?.throwIfAborted();

  const entries = new Map<string, SearchGraphEnrichmentEntryV1>();
  for (const target of request.targets) entries.set(target.targetId, { targetId: target.targetId });
  const warnings: ToolWarningV1[] = [];

  for (const scope of scopesOf(request.targets)) {
    options?.signal?.throwIfAborted();
    const readOptions = options?.signal === undefined ? {} : { signal: options.signal };

    if (request.includeContext) {
      try {
        const loaded = await readGraphSnapshot(
          graphStore,
          { workspaceId: scope.workspaceId, generationId: scope.generationId },
          readOptions,
        );
        if (loaded.snapshot === null) {
          const detail = unavailableDetail("file graph", scope, loaded.issues);
          warnings.push(
            unavailableWarning("GRAPH_CONTEXT_UNAVAILABLE", detail, scope, loaded.issues),
          );
          for (const target of scope.targets) {
            setContext(
              entries,
              target.targetId,
              unavailableSearchGraphRelations("graph_unavailable", detail, request.relationLimit),
            );
          }
        } else {
          const lookup = indexFileGraph(loaded.snapshot);
          if (loaded.issues.length > 0) {
            warnings.push(
              partialWarning("GRAPH_CONTEXT_PARTIAL", "file graph", scope, loaded.issues),
            );
          }
          for (const target of scope.targets) {
            setContext(
              entries,
              target.targetId,
              fileRelations(lookup, target, loaded.issues, request.relationLimit),
            );
          }
        }
      } catch (error) {
        options?.signal?.throwIfAborted();
        const detail = readFailureDetail("file graph", scope, error);
        warnings.push(unavailableWarning("GRAPH_CONTEXT_UNAVAILABLE", detail, scope, []));
        for (const target of scope.targets) {
          setContext(
            entries,
            target.targetId,
            unavailableSearchGraphRelations("graph_unavailable", detail, request.relationLimit),
          );
        }
      }
    }

    if (request.includeLinked) {
      try {
        const loaded = await readSymbolGraphSnapshot(
          graphStore,
          { workspaceId: scope.workspaceId, generationId: scope.generationId },
          readOptions,
        );
        if (loaded.snapshot === null) {
          const detail = unavailableDetail("symbol graph", scope, loaded.issues);
          warnings.push(
            unavailableWarning("LINKED_ARTIFACTS_UNAVAILABLE", detail, scope, loaded.issues),
          );
          for (const target of scope.targets) {
            setLinked(
              entries,
              target.targetId,
              unavailableSearchGraphRelations("graph_unavailable", detail, request.relationLimit),
            );
          }
        } else {
          const lookup = indexSymbolGraph(loaded.snapshot);
          if (loaded.issues.length > 0) {
            warnings.push(
              partialWarning("LINKED_ARTIFACTS_PARTIAL", "symbol graph", scope, loaded.issues),
            );
          }
          for (const target of scope.targets) {
            setLinked(
              entries,
              target.targetId,
              symbolRelations(lookup, target, loaded.issues, request.relationLimit),
            );
          }
        }
      } catch (error) {
        options?.signal?.throwIfAborted();
        const detail = readFailureDetail("symbol graph", scope, error);
        warnings.push(unavailableWarning("LINKED_ARTIFACTS_UNAVAILABLE", detail, scope, []));
        for (const target of scope.targets) {
          setLinked(
            entries,
            target.targetId,
            unavailableSearchGraphRelations("graph_unavailable", detail, request.relationLimit),
          );
        }
      }
    }
  }

  return {
    entries: request.targets.map(
      (target) => entries.get(target.targetId) as SearchGraphEnrichmentEntryV1,
    ),
    warnings: warnings.sort(compareWarnings),
  };
}

function scopesOf(targets: readonly SearchGraphEnrichmentTargetV1[]): EnrichmentScope[] {
  const byScope = new Map<string, EnrichmentScope>();
  for (const target of targets) {
    const key = `${String(target.workspaceId.length)}:${target.workspaceId}${String(target.generationId.length)}:${target.generationId}`;
    const scope = byScope.get(key) ?? {
      workspaceId: target.workspaceId,
      generationId: target.generationId,
      targets: [],
    };
    scope.targets.push(target);
    byScope.set(key, scope);
  }
  return [...byScope.values()].sort((left, right) => {
    const byWorkspace = compareCodepoints(left.workspaceId, right.workspaceId);
    return byWorkspace !== 0
      ? byWorkspace
      : compareCodepoints(left.generationId, right.generationId);
  });
}

function fileRelations(
  graph: FileGraphLookup,
  target: SearchGraphEnrichmentTargetV1,
  readIssues: readonly SnapshotReadIssue[],
  relationLimit: number,
) {
  const root = graph.nodes.get(target.fileId);
  const omissions = partialOmissions("file graph", readIssues);
  const relations: SearchGraphRelationV1[] = [];
  if (root === undefined || !sameFile(root, target)) {
    omissions.push({
      reason: "source_not_in_graph",
      count: 1,
      detail: `file "${target.fileId}" at ${target.repoId}/${target.refId}/${target.filePath} is absent from the persisted file graph`,
    });
    return createSearchGraphRelations(relations, omissions, relationLimit);
  }

  for (const edge of graph.outgoing.get(target.fileId) ?? []) {
    if (!matchesFileSource(root, edge)) {
      omissions.push(missingEndpoint("outgoing", edge.edgeId));
    } else if (edge.resolution.status !== "resolved") {
      omissions.push({
        reason: "unresolved_endpoint",
        count: 1,
        detail: `outgoing file edge "${edge.edgeId}" has persisted resolution "${edge.resolution.status}" and therefore no indexed file endpoint`,
      });
    } else {
      const endpoint = graph.nodes.get(edge.resolution.targetFileId);
      if (endpoint === undefined || !matchesResolvedTarget(endpoint, edge)) {
        omissions.push(missingEndpoint("outgoing", edge.edgeId));
      } else {
        relations.push(fileRelation(edge, endpoint, "outgoing"));
      }
    }
  }
  for (const edge of graph.incoming.get(target.fileId) ?? []) {
    const endpoint = graph.nodes.get(edge.fromFileId);
    if (
      !matchesResolvedTarget(root, edge) ||
      endpoint === undefined ||
      !matchesFileSource(endpoint, edge)
    ) {
      omissions.push(missingEndpoint("incoming", edge.edgeId));
    } else {
      relations.push(fileRelation(edge, endpoint, "incoming"));
    }
  }
  return createSearchGraphRelations(relations, omissions, relationLimit);
}

function symbolRelations(
  graph: SymbolGraphLookup,
  target: SearchGraphEnrichmentTargetV1,
  readIssues: readonly SymbolGraphSnapshotReadIssue[],
  relationLimit: number,
) {
  const omissions = partialOmissions("symbol graph", readIssues);
  const relations: SearchGraphRelationV1[] = [];
  if (target.symbolId === undefined) {
    omissions.push({
      reason: "symbol_id_missing",
      count: 1,
      detail: `final hit at ${target.repoId}/${target.refId}/${target.filePath} has no persisted symbolId; linked symbols were not guessed by name`,
    });
    return createSearchGraphRelations(relations, omissions, relationLimit);
  }

  const root = graph.nodes.get(target.symbolId);
  if (root === undefined || !sameSymbol(root, target)) {
    omissions.push({
      reason: "source_not_in_graph",
      count: 1,
      detail: `symbol "${target.symbolId}" is absent from the persisted symbol graph at the hit's file/ref; linked symbols were not guessed by name`,
    });
    return createSearchGraphRelations(relations, omissions, relationLimit);
  }

  for (const edge of graph.outgoing.get(target.symbolId) ?? []) {
    if (edge.repoId !== root.repoId || edge.refId !== root.refId) {
      omissions.push(missingEndpoint("outgoing", edge.edgeId));
    } else {
      appendOutgoingSymbolRelation(relations, omissions, graph.nodes, edge);
    }
  }
  for (const edge of graph.incoming.get(target.symbolId) ?? []) {
    appendIncomingSymbolRelation(relations, omissions, graph.nodes, edge, target.symbolId);
  }
  return createSearchGraphRelations(relations, omissions, relationLimit);
}

function indexFileGraph(graph: FileGraphSnapshotV1): FileGraphLookup {
  const outgoing = new Map<string, FileEdgeV1[]>();
  const incoming = new Map<string, FileEdgeV1[]>();
  for (const edge of graph.edges) {
    pushEdge(outgoing, edge.fromFileId, edge);
    if (edge.resolution.status === "resolved") {
      pushEdge(incoming, edge.resolution.targetFileId, edge);
    }
  }
  return {
    nodes: new Map(graph.nodes.map((node) => [node.fileId, node] as const)),
    outgoing,
    incoming,
  };
}

function indexSymbolGraph(graph: SymbolGraphV1): SymbolGraphLookup {
  const outgoing = new Map<string, SymbolEdgeV1[]>();
  const incoming = new Map<string, SymbolEdgeV1[]>();
  for (const edge of graph.edges) {
    pushEdge(outgoing, edge.fromSymbolId, edge);
    const endpointIds = new Set([
      ...(edge.target === undefined ? [] : [edge.target.symbolId]),
      ...(edge.candidates ?? []).map((candidate) => candidate.symbolId),
    ]);
    for (const endpointId of endpointIds) pushEdge(incoming, endpointId, edge);
  }
  return {
    nodes: new Map(graph.nodes.map((node) => [node.id, node] as const)),
    outgoing,
    incoming,
  };
}

function pushEdge<T>(map: Map<string, T[]>, key: string, edge: T): void {
  const bucket = map.get(key) ?? [];
  bucket.push(edge);
  map.set(key, bucket);
}

function appendOutgoingSymbolRelation(
  relations: SearchGraphRelationV1[],
  omissions: SearchGraphOmissionV1[],
  nodes: ReadonlyMap<string, SymbolNodeV1>,
  edge: SymbolEdgeV1,
): void {
  if (edge.resolution !== "exact" || edge.target === undefined) {
    omissions.push(symbolResolutionOmission("outgoing", edge));
    return;
  }
  const endpoint = nodes.get(edge.target.symbolId);
  if (endpoint === undefined || !matchesSymbolTarget(endpoint, edge)) {
    omissions.push(missingEndpoint("outgoing", edge.edgeId));
    return;
  }
  relations.push(symbolRelation(edge, endpoint, "outgoing"));
}

function appendIncomingSymbolRelation(
  relations: SearchGraphRelationV1[],
  omissions: SearchGraphOmissionV1[],
  nodes: ReadonlyMap<string, SymbolNodeV1>,
  edge: SymbolEdgeV1,
  symbolId: string,
): void {
  const pointsToRoot = edge.target?.symbolId === symbolId;
  const namesRootAsCandidate =
    edge.candidates?.some((candidate) => candidate.symbolId === symbolId) === true;
  if (!pointsToRoot && !namesRootAsCandidate) return;
  if (edge.resolution !== "exact" || !pointsToRoot) {
    omissions.push(symbolResolutionOmission("incoming", edge));
    return;
  }
  const root = nodes.get(symbolId);
  if (root === undefined || !matchesSymbolTarget(root, edge)) {
    omissions.push(missingEndpoint("incoming", edge.edgeId));
    return;
  }
  const endpoint = nodes.get(edge.fromSymbolId);
  if (endpoint === undefined || !matchesSymbolSource(endpoint, edge)) {
    omissions.push(missingEndpoint("incoming", edge.edgeId));
    return;
  }
  relations.push(symbolRelation(edge, endpoint, "incoming"));
}

function fileRelation(
  edge: FileEdgeV1,
  endpoint: FileNodeV1,
  direction: "incoming" | "outgoing",
): SearchGraphRelationV1 {
  return {
    schemaVersion: 1,
    source: "file_graph",
    edgeId: edge.edgeId,
    direction,
    edgeKind: edge.kind,
    repoId: endpoint.repoId,
    refId: endpoint.refId,
    fileId: endpoint.fileId,
    path: endpoint.filePath,
    crossRepository: edge.boundary.crossRepo,
  };
}

function symbolRelation(
  edge: SymbolEdgeV1,
  endpoint: SymbolNodeV1,
  direction: "incoming" | "outgoing",
): SearchGraphRelationV1 {
  return {
    schemaVersion: 1,
    source: "symbol_graph",
    edgeId: edge.edgeId,
    direction,
    edgeKind: edge.kind,
    repoId: endpoint.repoId,
    refId: endpoint.refId,
    fileId: endpoint.fileId,
    path: endpoint.filePath,
    crossRepository: edge.crossRepo,
    symbol: {
      id: endpoint.id,
      name: endpoint.name,
      qualifiedName: endpoint.qualifiedName,
      kind: endpoint.kind,
    },
  };
}

function symbolResolutionOmission(
  direction: "incoming" | "outgoing",
  edge: SymbolEdgeV1,
): SearchGraphOmissionV1 {
  const reason =
    edge.resolution === "ambiguous"
      ? "ambiguous_endpoint"
      : edge.resolution === "heuristic"
        ? "heuristic_endpoint"
        : edge.resolution === "unresolved"
          ? "unresolved_endpoint"
          : "endpoint_missing";
  return {
    reason,
    count: 1,
    detail: `${direction} symbol edge "${edge.edgeId}" has persisted resolution "${edge.resolution}"; no endpoint was guessed`,
  };
}

function missingEndpoint(
  direction: "incoming" | "outgoing",
  edgeId: string,
): SearchGraphOmissionV1 {
  return {
    reason: "endpoint_missing",
    count: 1,
    detail: `${direction} edge "${edgeId}" names an endpoint that is absent or inconsistent in the persisted graph snapshot`,
  };
}

function sameFile(node: FileNodeV1, target: SearchGraphEnrichmentTargetV1): boolean {
  return (
    node.repoId === target.repoId &&
    node.refId === target.refId &&
    node.fileId === target.fileId &&
    node.filePath === target.filePath
  );
}

function sameSymbol(node: SymbolNodeV1, target: SearchGraphEnrichmentTargetV1): boolean {
  return (
    node.repoId === target.repoId &&
    node.refId === target.refId &&
    node.fileId === target.fileId &&
    node.filePath === target.filePath &&
    node.id === target.symbolId
  );
}

function matchesResolvedTarget(node: FileNodeV1, edge: FileEdgeV1): boolean {
  return (
    edge.resolution.status === "resolved" &&
    node.fileId === edge.resolution.targetFileId &&
    node.repoId === edge.resolution.targetRepoId &&
    node.refId === edge.resolution.targetRefId &&
    node.filePath === edge.resolution.targetPath
  );
}

function matchesFileSource(node: FileNodeV1, edge: FileEdgeV1): boolean {
  return (
    node.fileId === edge.fromFileId &&
    node.repoId === edge.repoId &&
    node.refId === edge.refId &&
    node.filePath === edge.fromPath
  );
}

function matchesSymbolTarget(node: SymbolNodeV1, edge: SymbolEdgeV1): boolean {
  return (
    edge.target !== undefined &&
    node.id === edge.target.symbolId &&
    node.qualifiedName === edge.target.qualifiedName &&
    node.repoId === edge.target.repoId &&
    node.refId === edge.target.refId &&
    node.filePath === edge.target.filePath
  );
}

function matchesSymbolSource(node: SymbolNodeV1, edge: SymbolEdgeV1): boolean {
  return node.id === edge.fromSymbolId && node.repoId === edge.repoId && node.refId === edge.refId;
}

function partialOmissions(
  graphName: string,
  issues: readonly { kind: string; message: string }[],
): SearchGraphOmissionV1[] {
  if (issues.length === 0) return [];
  return [
    {
      reason: "graph_partial",
      count: issues.length,
      detail: `${graphName} loaded with ${String(issues.length)} persisted snapshot issue(s)`,
    },
  ];
}

function setContext(
  entries: Map<string, SearchGraphEnrichmentEntryV1>,
  targetId: string,
  graphContext: NonNullable<SearchGraphEnrichmentEntryV1["graphContext"]>,
): void {
  const entry = entries.get(targetId);
  if (entry !== undefined) entries.set(targetId, { ...entry, graphContext });
}

function setLinked(
  entries: Map<string, SearchGraphEnrichmentEntryV1>,
  targetId: string,
  linkedSymbols: NonNullable<SearchGraphEnrichmentEntryV1["linkedSymbols"]>,
): void {
  const entry = entries.get(targetId);
  if (entry !== undefined) entries.set(targetId, { ...entry, linkedSymbols });
}

function unavailableDetail(
  graphName: string,
  scope: Pick<EnrichmentScope, "workspaceId" | "generationId">,
  issues: readonly { kind: string; message: string }[],
): string {
  const bounded = boundedIssueDetails(issues);
  const suffix =
    issues.length === 0
      ? "no persisted snapshot was returned"
      : `${bounded.issues.join("; ")}${bounded.omittedIssueCount === 0 ? "" : `; +${String(bounded.omittedIssueCount)} further issue(s) omitted from this warning`}`;
  return boundSearchGraphDetail(
    `${graphName} unavailable for workspace "${scope.workspaceId}" generation "${scope.generationId}": ${suffix}`,
  );
}

function readFailureDetail(
  graphName: string,
  scope: Pick<EnrichmentScope, "workspaceId" | "generationId">,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundSearchGraphDetail(
    `${graphName} read failed for workspace "${scope.workspaceId}" generation "${scope.generationId}": ${message}`,
  );
}

function unavailableWarning(
  code: string,
  message: string,
  scope: Pick<EnrichmentScope, "workspaceId" | "generationId">,
  issues: readonly { kind: string; message: string }[],
): ToolWarningV1 {
  const bounded = boundedIssueDetails(issues);
  return {
    code,
    message,
    details: {
      workspaceId: boundSearchGraphDetail(scope.workspaceId),
      generationId: boundSearchGraphDetail(scope.generationId),
      issues: bounded.issues,
      omittedIssueCount: bounded.omittedIssueCount,
    },
  };
}

function partialWarning(
  code: string,
  graphName: string,
  scope: Pick<EnrichmentScope, "workspaceId" | "generationId">,
  issues: readonly { kind: string; message: string }[],
): ToolWarningV1 {
  const bounded = boundedIssueDetails(issues);
  return {
    code,
    message: boundSearchGraphDetail(
      `${graphName} for workspace "${scope.workspaceId}" generation "${scope.generationId}" is partial; usable direct relations were retained and omissions are explicit`,
    ),
    details: {
      workspaceId: boundSearchGraphDetail(scope.workspaceId),
      generationId: boundSearchGraphDetail(scope.generationId),
      issues: bounded.issues,
      omittedIssueCount: bounded.omittedIssueCount,
    },
  };
}

function issueDetails(issues: readonly { kind: string; message: string }[]): string[] {
  return issues
    .map((issue) => boundSearchGraphDetail(`${issue.kind}: ${issue.message}`))
    .sort(compareCodepoints);
}

function boundedIssueDetails(issues: readonly { kind: string; message: string }[]): {
  issues: string[];
  omittedIssueCount: number;
} {
  const sorted = issueDetails(issues);
  return {
    issues: sorted.slice(0, SEARCH_GRAPH_WARNING_ISSUE_LIMIT),
    omittedIssueCount: Math.max(0, sorted.length - SEARCH_GRAPH_WARNING_ISSUE_LIMIT),
  };
}

function compareWarnings(left: ToolWarningV1, right: ToolWarningV1): number {
  const byCode = compareCodepoints(left.code, right.code);
  return byCode !== 0 ? byCode : compareCodepoints(left.message, right.message);
}

/** Die effektive Defaultgrenze als Teil der Adapter-API sichtbar halten. */
export { SEARCH_GRAPH_RELATION_LIMIT };
