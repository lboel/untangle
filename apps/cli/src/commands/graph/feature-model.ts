import {
  canonicalJson,
  compareCodepoints,
  uuidv5,
  type ProductAlignmentReportV1,
} from "@untangle-code/domain";

export type FeatureMapNodeKind = "feature" | "code" | "test" | "owner" | "intent" | "unmapped";
export type FeatureMapEdgeKind = "code" | "test" | "ownership" | "intent" | "dependency";
export interface FeatureMapNodeV1 {
  id: string;
  kind: FeatureMapNodeKind;
  label: string;
  path?: string;
  status: string;
  cognitive?: number;
  details: Record<string, unknown>;
}
export interface FeatureMapEdgeV1 {
  id: string;
  from: string;
  to: string;
  kind: FeatureMapEdgeKind;
}
export interface FeatureMapSummaryV1 {
  status: ProductAlignmentReportV1["status"];
  features: number;
  shownNodes: number;
  totalNodes: number;
  shownEdges: number;
  totalEdges: number;
  truncated: boolean;
  mappedCodeFiles: number;
  unmappedCodeFiles: number;
  inventoryFiles: number;
}
export interface FeatureMapGraphV1 {
  schemaVersion: 1;
  sourceTreeDigest: string;
  nodes: FeatureMapNodeV1[];
  edges: FeatureMapEdgeV1[];
  summary: FeatureMapSummaryV1;
  limits: { maxNodes: number; maxEdges: number };
  limitations: string[];
  issues: string[];
  dependencyCycles: string[][];
}
export interface FeatureMapLimitsV1 {
  maxNodes?: number;
  maxEdges?: number;
}

export function featureMapLimits(input: FeatureMapLimitsV1): {
  maxNodes: number;
  maxEdges: number;
} {
  const maxNodes = input.maxNodes ?? 500;
  const maxEdges = input.maxEdges ?? 2_000;
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 2_000)
    throw new RangeError("maxNodes must be an integer between 1 and 2000.");
  if (!Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 10_000)
    throw new RangeError("maxEdges must be an integer between 1 and 10000.");
  return { maxNodes, maxEdges };
}

function identity(kind: string, key: string): string {
  return uuidv5(canonicalJson({ surface: "feature-map-v1", kind, key }));
}

/** Relations are declarations/evidence, never inferred semantic or runtime calls. */
export function buildFeatureMapGraph(
  report: ProductAlignmentReportV1,
  input: FeatureMapLimitsV1 = {},
  unassignedPaths: readonly string[] = [],
): FeatureMapGraphV1 {
  const limits = featureMapLimits(input);
  const nodes = new Map<string, FeatureMapNodeV1>();
  const edges = new Map<string, FeatureMapEdgeV1>();
  const addNode = (
    kind: FeatureMapNodeKind,
    key: string,
    data: Omit<FeatureMapNodeV1, "kind" | "id">,
  ): string => {
    const id = identity(kind === "test" ? "code" : kind, key);
    const existing = nodes.get(id);
    // A file selected as both code and test keeps one identity and both role facts.
    if (existing !== undefined && (kind === "code" || kind === "test")) {
      const roles = new Set([...(existing.details["roles"] as string[]), kind]);
      existing.details["roles"] = [...roles].sort(compareCodepoints);
    } else if (existing === undefined) nodes.set(id, { id, kind, ...data });
    return id;
  };
  const addEdge = (from: string, to: string, kind: FeatureMapEdgeKind): void => {
    const id = identity("edge", canonicalJson({ from, to, kind }));
    edges.set(id, { id, from, to, kind });
  };
  const features = [...report.features].sort((a, b) => compareCodepoints(a.id, b.id));
  for (const feature of features) {
    addNode("feature", feature.id, {
      label: feature.title,
      status: feature.status,
      ...(feature.code.metrics === null
        ? {}
        : { cognitive: feature.code.metrics.cognitive.execution_unit }),
      details: {
        featureId: feature.id,
        stage: feature.stage,
        review: feature.review,
        codeComplete: feature.code.complete,
        testComplete: feature.tests.complete,
        metrics: feature.code.metrics,
        testMetrics: feature.tests.metrics,
        testEvidence: feature.testEvidence,
        dimensions: feature.dimensions,
        criteria: feature.criteria,
        hotspots: feature.code.hotspots,
        agentHints: feature.agentHints,
        issues: feature.issues,
      },
    });
  }
  for (const feature of features) {
    const featureId = identity("feature", feature.id);
    for (const owner of feature.ownership) {
      const ownerId = addNode("owner", owner.id, {
        label: owner.label ?? owner.id,
        status: owner.status,
        details: {
          ownerId: owner.id,
          authority: report.ownershipAuthority,
          sources: owner.sources,
        },
      });
      addEdge(featureId, ownerId, "ownership");
    }
    for (const intent of feature.intent) {
      const intentId = addNode(
        "intent",
        canonicalJson({ path: intent.path, heading: intent.heading }),
        {
          label: intent.heading || intent.path,
          path: intent.path,
          status: intent.status,
          details: {
            role: intent.role,
            heading: intent.heading,
            contentHash: intent.contentHash,
            startLine: intent.startLine,
            endLine: intent.endLine,
          },
        },
      );
      addEdge(featureId, intentId, "intent");
    }
    for (const role of ["code", "test"] as const) {
      const selection = role === "code" ? feature.code : feature.tests;
      for (const file of selection.files) {
        const fileId = addNode(role, file.path, {
          label: file.path,
          path: file.path,
          status: file.status,
          details: {
            roles: [role],
            contentHash: file.contentHash,
            sharedFeatures:
              report.coverage.sharedFiles.find((shared) => shared.path === file.path)?.featureIds ??
              [],
          },
        });
        addEdge(featureId, fileId, role);
      }
    }
    for (const dependency of feature.dependsOn) {
      const target = identity("feature", dependency);
      if (nodes.has(target)) addEdge(featureId, target, "dependency");
    }
  }
  const unmapped = [...new Set([...report.coverage.unmappedCodeFiles, ...unassignedPaths])].sort(
    compareCodepoints,
  );
  for (const filePath of unmapped) {
    // The fallback census is not an AST measurement and does not imply a feature.
    if (nodes.has(identity("code", filePath))) continue;
    addNode("unmapped", filePath, {
      label: filePath,
      path: filePath,
      status: "unmapped",
      details: { featureAssignment: "none", measurement: "not_provided_by_feature_report" },
    });
  }
  const allNodes = [...nodes.values()];
  const shownNodes = allNodes.slice(0, limits.maxNodes);
  const visible = new Set(shownNodes.map((node) => node.id));
  const allEdges = [...edges.values()].sort((a, b) => compareCodepoints(a.id, b.id));
  const shownEdges = allEdges
    .filter((edge) => visible.has(edge.from) && visible.has(edge.to))
    .slice(0, limits.maxEdges);
  return {
    schemaVersion: 1,
    sourceTreeDigest: report.sourceTreeDigest,
    nodes: shownNodes,
    edges: shownEdges,
    summary: {
      status: report.status,
      features: report.features.length,
      shownNodes: shownNodes.length,
      totalNodes: allNodes.length,
      shownEdges: shownEdges.length,
      totalEdges: allEdges.length,
      truncated:
        shownNodes.length < allNodes.length ||
        shownEdges.length < allEdges.length ||
        report.inventory.truncated,
      mappedCodeFiles: report.coverage.mappedCodeFiles,
      unmappedCodeFiles: Math.max(report.coverage.unmappedCodeFileCount, unmapped.length),
      inventoryFiles: report.inventory.files,
    },
    limits,
    issues: report.issues,
    dependencyCycles: report.dependencyCycles,
    limitations: [
      ...report.limitations,
      "Only declared feature, code/test, intent and ownership relations are drawn. Feature dependency edges are not code imports or runtime calls.",
      "Node size represents complete feature cognitive execution_unit complexity only when measured. File sizes do not claim file complexity.",
      "The diagram is a bounded source snapshot. Filtered or omitted nodes never reduce the complete feature metrics in the report.",
      "Spatial positions, depth and thread curvature are visualization choices, not semantic similarity, coupling scores or additional relationships.",
      ...(unassignedPaths.length === 0
        ? []
        : [
            "Unassigned paths come from an accepted scanner census; they carry no inferred feature, owner or AST metric.",
          ]),
    ],
  };
}
