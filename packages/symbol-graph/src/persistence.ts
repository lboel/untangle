/**
 * Workspace- und generationssichere Ablage des Symbolgraphen ueber den
 * bestehenden `GraphStore`-Port.
 *
 * Der Graph ist ein einzelner Shard: Knoten, Kanten, Metriken und Skip-Ledger
 * bilden zusammen genau EIN konsistentes Abbild. Der Workspace steckt sowohl
 * kollisionsfrei in der logischen Shard-ID als auch im Payload; die Generation
 * wird immer explizit an den Store uebergeben und ebenfalls gegengeprueft.
 */
import type {
  GraphShardV1,
  GraphStore,
  PortCallOptions,
  SkipLedgerEntryV1,
  SkipLedgerV1,
  SymbolEdgeV1,
  SymbolNodeV1,
} from "@untangle-code/domain";
import {
  SKIP_REASONS,
  SKIP_STAGES,
  SKIP_SUBJECT_KINDS,
  SYMBOL_EDGE_KINDS,
  SYMBOL_EDGE_RESOLUTIONS,
  SYMBOL_EDGE_UNRESOLVED_REASONS,
  SYMBOL_GRAPH_VERSION,
  compareCodepoints,
  validateSkipLedger,
  validateSymbolEdge,
} from "@untangle-code/domain";

import { computeSymbolGraphMetrics } from "./metrics.js";
import type { SymbolGraphMetricsV1, SymbolGraphV1 } from "./types.js";

/** Versionierter Praefix der workspace-sicheren Symbolgraph-Shards. */
export const SYMBOL_GRAPH_SHARD_NAMESPACE = "untangle:symbol-graph:v1";
/** Vor Wave 8 verwendete globale ID; nur fuer expliziten Legacy-Fallback. */
export const LEGACY_SYMBOL_GRAPH_SHARD_ID = "symbol-graph";

export interface SymbolGraphSnapshotScope {
  workspaceId: string;
  generationId: string;
}

export interface SymbolGraphSnapshotReadOptions extends PortCallOptions {
  /** Aktiviert ausschliesslich den scope-validierten Fallback auf den alten Shard. */
  allowLegacyFallback?: boolean;
}

export interface SymbolGraphSnapshotReadIssue {
  kind: "missing_snapshot" | "scope_mismatch" | "malformed_payload" | "count_mismatch";
  message: string;
}

export interface SymbolGraphSnapshotReadResult {
  snapshot: SymbolGraphV1 | null;
  issues: SymbolGraphSnapshotReadIssue[];
}

/** Kollisionsfreie Shard-ID fuer den Symbolgraphen eines Workspace. */
export function symbolGraphSnapshotShardId(workspaceId: string): string {
  assertIdentifier("workspaceId", workspaceId);
  return `${SYMBOL_GRAPH_SHARD_NAMESPACE}:${String(workspaceId.length)}:${workspaceId}:snapshot`;
}

/** Bildet einen vollstaendigen Symbolgraphen auf genau einen typisierten Shard ab. */
export function toSymbolGraphShard(snapshot: SymbolGraphV1, writeId: string): GraphShardV1 {
  assertIdentifier("writeId", writeId);
  const issues = validateSnapshotPayload(snapshot as unknown as Readonly<Record<string, unknown>>, {
    workspaceId: snapshot.workspaceId,
    generationId: snapshot.graphGeneration,
  });
  if (issues.length > 0) {
    throw new TypeError(
      `symbol graph snapshot is not persistable: ${issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  return {
    logicalShardId: symbolGraphSnapshotShardId(snapshot.workspaceId),
    collection: "graph_meta",
    generationId: snapshot.graphGeneration,
    writeId,
    payload: {
      persistenceSchemaVersion: 1,
      schemaVersion: snapshot.schemaVersion,
      workspaceId: snapshot.workspaceId,
      graphGeneration: snapshot.graphGeneration,
      graphVersion: snapshot.graphVersion,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      metrics: snapshot.metrics,
      skipped: snapshot.skipped,
    },
  };
}

/** Schreibt ein vollstaendiges Symbolgraph-Abbild. */
export async function writeSymbolGraphSnapshot(
  store: GraphStore,
  snapshot: SymbolGraphV1,
  writeId: string,
  options?: PortCallOptions,
): Promise<void> {
  await store.writeShards([toSymbolGraphShard(snapshot, writeId)], options);
}

/**
 * Liest ausschliesslich den angegebenen Workspace und die angegebene
 * Generation. Eine `latest`-Abfrage ohne Generation findet nicht statt.
 */
export async function readSymbolGraphSnapshot(
  store: GraphStore,
  scope: SymbolGraphSnapshotScope,
  options: SymbolGraphSnapshotReadOptions = {},
): Promise<SymbolGraphSnapshotReadResult> {
  assertSnapshotScope(scope);
  const { allowLegacyFallback, ...callOptions } = options;
  const scoped = await readSymbolGraphShard(
    store,
    scope,
    symbolGraphSnapshotShardId(scope.workspaceId),
    callOptions,
  );
  if (
    allowLegacyFallback !== true ||
    scoped.snapshot !== null ||
    scoped.issues.some((issue) => issue.kind !== "missing_snapshot")
  ) {
    return scoped;
  }
  return readSymbolGraphShard(store, scope, LEGACY_SYMBOL_GRAPH_SHARD_ID, callOptions);
}

async function readSymbolGraphShard(
  store: GraphStore,
  scope: SymbolGraphSnapshotScope,
  shardId: string,
  options: PortCallOptions,
): Promise<SymbolGraphSnapshotReadResult> {
  const shard = await store.readShard("graph_meta", shardId, {
    ...options,
    generationId: scope.generationId,
  });
  if (shard === null) {
    return {
      snapshot: null,
      issues: [
        {
          kind: "missing_snapshot",
          message: `graph_meta/${shardId} is absent for workspace "${scope.workspaceId}" and generation "${scope.generationId}"`,
        },
      ],
    };
  }

  if (shard.generationId !== scope.generationId) {
    return {
      snapshot: null,
      issues: [
        {
          kind: "scope_mismatch",
          message: `graph_meta/${shardId} was returned from generation "${shard.generationId}" while "${scope.generationId}" was requested`,
        },
      ],
    };
  }

  const issues = validateSnapshotPayload(
    shard.payload,
    scope,
    shardId !== LEGACY_SYMBOL_GRAPH_SHARD_ID,
  );
  if (issues.length > 0) return { snapshot: null, issues };

  return {
    snapshot: {
      schemaVersion: 1,
      workspaceId: scope.workspaceId,
      graphGeneration: scope.generationId,
      graphVersion: SYMBOL_GRAPH_VERSION,
      nodes: shard.payload["nodes"] as SymbolNodeV1[],
      edges: shard.payload["edges"] as SymbolEdgeV1[],
      skipped: shard.payload["skipped"] as unknown as SkipLedgerV1,
      metrics: shard.payload["metrics"] as unknown as SymbolGraphMetricsV1,
    },
    issues: [],
  };
}

function validateSnapshotPayload(
  payload: Readonly<Record<string, unknown>>,
  scope: SymbolGraphSnapshotScope,
  requirePersistenceMarker = false,
): SymbolGraphSnapshotReadIssue[] {
  const issues: SymbolGraphSnapshotReadIssue[] = [];
  if (requirePersistenceMarker && payload["persistenceSchemaVersion"] !== 1) {
    issues.push({
      kind: "malformed_payload",
      message: "symbol graph has no supported persistenceSchemaVersion marker",
    });
  }
  if (payload["workspaceId"] !== scope.workspaceId) {
    issues.push({
      kind: "scope_mismatch",
      message: `symbol graph belongs to workspace "${String(payload["workspaceId"])}", not requested workspace "${scope.workspaceId}"`,
    });
  }
  if (payload["graphGeneration"] !== scope.generationId) {
    issues.push({
      kind: "scope_mismatch",
      message: `symbol graph belongs to generation "${String(payload["graphGeneration"])}", not requested generation "${scope.generationId}"`,
    });
  }
  if (payload["schemaVersion"] !== 1 || payload["graphVersion"] !== SYMBOL_GRAPH_VERSION) {
    issues.push({
      kind: "malformed_payload",
      message: "symbol graph has an unsupported schemaVersion or graphVersion",
    });
  }

  const nodes = payload["nodes"];
  if (!Array.isArray(nodes) || !nodes.every(isSymbolNode)) {
    issues.push({
      kind: "malformed_payload",
      message: 'symbol graph has no usable "nodes" payload',
    });
  }

  const edges = payload["edges"];
  if (!Array.isArray(edges) || !edges.every(isSymbolEdge)) {
    issues.push({
      kind: "malformed_payload",
      message: 'symbol graph has no usable "edges" payload',
    });
  } else {
    for (const edge of edges) {
      if (
        edge.workspaceId !== scope.workspaceId ||
        edge.graphGeneration !== scope.generationId ||
        edge.graphVersion !== SYMBOL_GRAPH_VERSION
      ) {
        issues.push({
          kind: "scope_mismatch",
          message: `symbol edge "${edge.edgeId}" does not belong to the requested workspace/generation`,
        });
      }
      const edgeIssues = validateSymbolEdge(edge);
      if (edgeIssues.length > 0) {
        issues.push({
          kind: "malformed_payload",
          message: `symbol edge "${edge.edgeId}" violates its domain contract: ${edgeIssues
            .map((issue) => `${issue.kind}: ${issue.message}`)
            .join("; ")}`,
        });
      }
    }
  }

  const skipped = payload["skipped"];
  if (!isSkipLedger(skipped)) {
    issues.push({
      kind: "malformed_payload",
      message: 'symbol graph has no usable "skipped" payload',
    });
  } else {
    if (skipped.generationId !== scope.generationId) {
      issues.push({
        kind: "scope_mismatch",
        message: `symbol graph skip ledger belongs to generation "${skipped.generationId}", not "${scope.generationId}"`,
      });
    }
    const ledgerIssues = validateSkipLedger(skipped);
    if (ledgerIssues.length > 0) {
      issues.push({
        kind: "malformed_payload",
        message: `symbol graph skip ledger violates its domain contract: ${ledgerIssues
          .map((issue) => `${issue.kind}: ${issue.message}`)
          .join("; ")}`,
      });
    }
  }

  const metrics = payload["metrics"];
  if (!isSymbolGraphMetrics(metrics)) {
    issues.push({
      kind: "malformed_payload",
      message: 'symbol graph has no usable "metrics" payload',
    });
  }

  if (Array.isArray(nodes) && nodes.every(isSymbolNode)) {
    const nodeIds = nodes.map((node) => node.id);
    if (new Set(nodeIds).size !== nodeIds.length || !isCodepointSorted(nodeIds)) {
      issues.push({
        kind: "malformed_payload",
        message: "symbol graph nodes are duplicated or not in canonical id order",
      });
    }
  }
  if (Array.isArray(edges) && edges.every(isSymbolEdge)) {
    const edgeIds = edges.map((edge) => edge.edgeId);
    if (new Set(edgeIds).size !== edgeIds.length || !isCodepointSorted(edgeIds)) {
      issues.push({
        kind: "malformed_payload",
        message: "symbol graph edges are duplicated or not in canonical edgeId order",
      });
    }
    if (Array.isArray(nodes) && nodes.every(isSymbolNode)) {
      const nodeIds = new Set(nodes.map((node) => node.id));
      for (const edge of edges) {
        const referencedIds = [
          edge.fromSymbolId,
          ...(edge.target === undefined ? [] : [edge.target.symbolId]),
          ...(edge.candidates ?? []).map((candidate) => candidate.symbolId),
        ];
        if (referencedIds.some((symbolId) => !nodeIds.has(symbolId))) {
          issues.push({
            kind: "malformed_payload",
            message: `symbol edge "${edge.edgeId}" references a symbol outside the persisted node set`,
          });
        }
      }
    }
  }

  if (
    Array.isArray(nodes) &&
    nodes.every(isSymbolNode) &&
    Array.isArray(edges) &&
    edges.every(isSymbolEdge) &&
    isSkipLedger(skipped) &&
    isSymbolGraphMetrics(metrics)
  ) {
    const representedFileCount = new Set(nodes.map((node) => node.fileId)).size;
    if (representedFileCount + metrics.symbolLessFileCount > metrics.fileCount) {
      issues.push({
        kind: "count_mismatch",
        message: "symbol graph file metrics cannot account for the persisted node files",
      });
    }
    const expected = computeSymbolGraphMetrics({
      nodes,
      edges,
      fileCount: metrics.fileCount,
      symbolLessFileCount: metrics.symbolLessFileCount,
      skippedCount: skipped.entries.length,
    });
    if (JSON.stringify(normalizeMetrics(metrics)) !== JSON.stringify(normalizeMetrics(expected))) {
      issues.push({
        kind: "count_mismatch",
        message: "symbol graph metrics do not match persisted nodes, edges and skip ledger",
      });
    }
  }
  return issues;
}

function isSymbolNode(value: unknown): value is SymbolNodeV1 {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value["id"]) &&
    isNonEmptyString(value["name"]) &&
    typeof value["qualifiedName"] === "string" &&
    isNonEmptyString(value["kind"]) &&
    isNonEmptyString(value["repoId"]) &&
    isNonEmptyString(value["refId"]) &&
    isNonEmptyString(value["fileId"]) &&
    typeof value["filePath"] === "string" &&
    isNonEmptyString(value["language"]) &&
    isNonNegativeInteger(value["startLine"]) &&
    isNonNegativeInteger(value["endLine"]) &&
    isNonNegativeInteger(value["startByte"]) &&
    isNonNegativeInteger(value["endByte"]) &&
    value["endLine"] >= value["startLine"] &&
    value["endByte"] >= value["startByte"] &&
    isNonEmptyString(value["contentHash"]) &&
    optionalString(value["signature"]) &&
    optionalString(value["visibility"]) &&
    (value["exportedAs"] === undefined || isStringArray(value["exportedAs"]))
  );
}

function isSymbolEdge(value: unknown): value is SymbolEdgeV1 {
  if (!isRecord(value)) return false;
  const confidence = value["confidence"];
  if (
    !isRecord(confidence) ||
    typeof confidence["value"] !== "number" ||
    (confidence["basis"] !== "deterministic" && confidence["basis"] !== "heuristic") ||
    !isStringArray(confidence["signals"])
  ) {
    return false;
  }
  const target = value["target"];
  if (target !== undefined && !isSymbolTarget(target)) return false;
  const candidates = value["candidates"];
  if (candidates !== undefined && (!Array.isArray(candidates) || !candidates.every(isCandidate))) {
    return false;
  }
  const sites = value["sites"];
  return (
    value["schemaVersion"] === 1 &&
    isNonEmptyString(value["edgeId"]) &&
    isNonEmptyString(value["workspaceId"]) &&
    isNonEmptyString(value["repoId"]) &&
    isNonEmptyString(value["refId"]) &&
    isNonEmptyString(value["fromSymbolId"]) &&
    includes(SYMBOL_EDGE_KINDS, value["kind"]) &&
    isNonEmptyString(value["toName"]) &&
    optionalString(value["toQualifier"]) &&
    includes(SYMBOL_EDGE_RESOLUTIONS, value["resolution"]) &&
    (value["unresolvedReason"] === undefined ||
      includes(SYMBOL_EDGE_UNRESOLVED_REASONS, value["unresolvedReason"])) &&
    optionalString(value["unresolvedDetail"]) &&
    typeof value["crossRepo"] === "boolean" &&
    Array.isArray(sites) &&
    sites.every(isSymbolEdgeSite) &&
    optionalString(value["sitesMissingReason"]) &&
    isNonNegativeInteger(value["occurrenceOrdinal"]) &&
    isNonEmptyString(value["graphGeneration"]) &&
    value["graphVersion"] === SYMBOL_GRAPH_VERSION
  );
}

function isSymbolTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value["symbolId"]) &&
    typeof value["qualifiedName"] === "string" &&
    isNonEmptyString(value["repoId"]) &&
    isNonEmptyString(value["refId"]) &&
    typeof value["filePath"] === "string"
  );
}

function isCandidate(value: unknown): boolean {
  return (
    isSymbolTarget(value) &&
    isRecord(value) &&
    typeof value["weight"] === "number" &&
    Number.isFinite(value["weight"])
  );
}

function isSymbolEdgeSite(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value["repoId"]) &&
    isNonEmptyString(value["refId"]) &&
    typeof value["filePath"] === "string" &&
    isSourceRange(value["range"]) &&
    (value["column"] === undefined || isNonNegativeInteger(value["column"]))
  );
}

function isSourceRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value["startLine"]) &&
    isNonNegativeInteger(value["endLine"]) &&
    isNonNegativeInteger(value["startByte"]) &&
    isNonNegativeInteger(value["endByte"])
  );
}

function isSkipLedger(value: unknown): value is SkipLedgerV1 {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== 1 ||
    !isNonEmptyString(value["generationId"]) ||
    !Array.isArray(value["entries"]) ||
    !value["entries"].every(isSkipLedgerEntry) ||
    !isRecord(value["countsByReason"])
  ) {
    return false;
  }
  return Object.entries(value["countsByReason"]).every(
    ([reason, count]) => includes(SKIP_REASONS, reason) && isNonNegativeInteger(count),
  );
}

function isSkipLedgerEntry(value: unknown): value is SkipLedgerEntryV1 {
  return (
    isRecord(value) &&
    value["schemaVersion"] === 1 &&
    includes(SKIP_STAGES, value["stage"]) &&
    includes(SKIP_SUBJECT_KINDS, value["subjectKind"]) &&
    includes(SKIP_REASONS, value["reason"]) &&
    isNonEmptyString(value["detail"]) &&
    typeof value["recoverable"] === "boolean" &&
    optionalString(value["subjectId"]) &&
    optionalString(value["path"]) &&
    optionalString(value["repoId"]) &&
    optionalString(value["refId"]) &&
    (value["range"] === undefined || isSourceRange(value["range"]))
  );
}

function isSymbolGraphMetrics(value: unknown): value is SymbolGraphMetricsV1 {
  if (!isRecord(value) || value["schemaVersion"] !== 1) return false;
  const integerKeys = [
    "nodeCount",
    "edgeCount",
    "fileCount",
    "symbolLessFileCount",
    "crossRepoEdgeCount",
    "orphanSymbolCount",
    "maxInDegree",
    "maxOutDegree",
    "skippedCount",
  ] as const;
  const rateKeys = ["exactEdgeRate", "ambiguousEdgeRate", "unresolvedEdgeRate"] as const;
  if (!integerKeys.every((key) => isNonNegativeInteger(value[key]))) return false;
  if (!rateKeys.every((key) => isRate(value[key]))) return false;
  if (!isStringArray(value["topCalledSymbolIds"])) return false;
  return (
    isCompleteCountRecord(value["edgesByResolution"], SYMBOL_EDGE_RESOLUTIONS) &&
    isCompleteCountRecord(value["edgesByKind"], SYMBOL_EDGE_KINDS)
  );
}

function isCompleteCountRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => isNonNegativeInteger(value[key]))
  );
}

function normalizeMetrics(metrics: SymbolGraphMetricsV1): SymbolGraphMetricsV1 {
  return {
    schemaVersion: 1,
    nodeCount: metrics.nodeCount,
    edgeCount: metrics.edgeCount,
    fileCount: metrics.fileCount,
    symbolLessFileCount: metrics.symbolLessFileCount,
    edgesByResolution: Object.fromEntries(
      SYMBOL_EDGE_RESOLUTIONS.map((key) => [key, metrics.edgesByResolution[key]]),
    ) as SymbolGraphMetricsV1["edgesByResolution"],
    edgesByKind: Object.fromEntries(
      SYMBOL_EDGE_KINDS.map((key) => [key, metrics.edgesByKind[key]]),
    ) as SymbolGraphMetricsV1["edgesByKind"],
    exactEdgeRate: metrics.exactEdgeRate,
    ambiguousEdgeRate: metrics.ambiguousEdgeRate,
    unresolvedEdgeRate: metrics.unresolvedEdgeRate,
    crossRepoEdgeCount: metrics.crossRepoEdgeCount,
    orphanSymbolCount: metrics.orphanSymbolCount,
    maxInDegree: metrics.maxInDegree,
    maxOutDegree: metrics.maxOutDegree,
    topCalledSymbolIds: metrics.topCalledSymbolIds,
    skippedCount: metrics.skippedCount,
  };
}

function isCodepointSorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareCodepoints(values[index - 1] as string, value) <= 0,
  );
}

function includes(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSnapshotScope(scope: SymbolGraphSnapshotScope): void {
  assertIdentifier("workspaceId", scope.workspaceId);
  assertIdentifier("generationId", scope.generationId);
}

function assertIdentifier(name: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
