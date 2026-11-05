import {
  MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH,
  MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH,
  MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  MAX_SEARCH_JOURNEY_REASON_LENGTH,
  MAX_SEARCH_JOURNEY_TEXT_LENGTH,
  MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH,
  SEARCH_JOURNEY_ABANDON_REASON_CODES,
} from "@untangle-code/domain";
import { MAX_MAX_EDGES, MAX_MAX_NODES } from "@untangle-code/graph-explorer";
import * as z from "zod/v4";

import {
  MAX_FLOW_DEPTH,
  MAX_FLOW_EDGES,
  MAX_FLOW_NODES,
  MAX_FLOW_RESULT_LIMIT,
  MAX_GRAPH_QUERY_DEPTH,
  MAX_GRAPH_QUERY_EDGES,
  MAX_GRAPH_QUERY_NODES,
} from "../commands/flow/limits.js";

import {
  UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS,
  type UntangleMcpSuccessDataByOperation,
} from "./output-schemas.js";
import type { UntangleMcpToolName } from "./types.js";

const nonEmpty = z.string().trim().min(1).max(4_096);
const optionalScope = {
  workspaceId: nonEmpty.optional(),
  root: nonEmpty.optional(),
};
const requiredScope = {
  workspaceId: nonEmpty.optional(),
  root: nonEmpty,
};
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const journeyText = z.string().trim().min(1).max(MAX_SEARCH_JOURNEY_TEXT_LENGTH);
const journeyLocator = z.string().trim().min(1).max(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH);
const journeyReason = z.string().trim().min(1).max(MAX_SEARCH_JOURNEY_REASON_LENGTH);
const journeyToolName = z.string().trim().min(1).max(MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH);
const featureId = z.string().trim().min(1).max(MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH);
const executionLabel = z.string().trim().min(1).max(MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH);
const executionContext = z
  .object({
    agentModel: executionLabel,
    harness: executionLabel,
    searchStrategy: executionLabel,
    taskClass: executionLabel,
    taskMix: executionLabel.optional(),
    priorContext: executionLabel.optional(),
  })
  .strict();

export interface McpToolDefinition<
  Name extends UntangleMcpToolName = UntangleMcpToolName,
  InputSchema extends z.ZodType<Record<string, unknown>> = z.ZodType<Record<string, unknown>>,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly successDataSchema: (typeof UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS)[Name];
  readonly pathFields: readonly string[];
}

function define<
  Name extends UntangleMcpToolName,
  InputSchema extends z.ZodType<Record<string, unknown>>,
>(
  name: Name,
  description: string,
  inputSchema: InputSchema,
  pathFields: readonly string[] = [],
): McpToolDefinition<Name, InputSchema> {
  return {
    name,
    description,
    inputSchema,
    successDataSchema: UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS[name],
    pathFields,
  };
}

const empty = z.object({}).strict();
const readScope = z.object(optionalScope).strict();
const searchJourneyTarget = z
  .object({
    repoId: journeyLocator.optional(),
    refId: journeyLocator.optional(),
    filePath: journeyLocator.optional(),
    chunkId: journeyLocator.optional(),
    symbolId: journeyLocator.optional(),
    embeddingProfileId: journeyLocator.optional(),
    indexGeneration: journeyLocator.optional(),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (
      target.filePath === undefined &&
      target.chunkId === undefined &&
      target.symbolId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "target requires filePath, chunkId or symbolId",
      });
    }
  });

/** Stable specified tool order, with additive product evidence inspection. */
export const UNTANGLE_MCP_TOOLS = [
  define(
    "untangle_index",
    "Index one explicit repository target. Registered honestly even when the MCP adapter cannot execute it yet.",
    z
      .object({ ...requiredScope, repositoryId: nonEmpty, background: z.boolean().optional() })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_update",
    "Update one explicit repository target from changed paths.",
    z
      .object({
        ...requiredScope,
        repositoryId: nonEmpty,
        paths: z.array(nonEmpty).min(1),
        background: z.boolean().optional(),
      })
      .strict(),
    ["root", "paths"],
  ),
  define(
    "untangle_stop",
    "Stop one explicitly named Untangle job.",
    z.object({ workspaceId: nonEmpty, jobId: nonEmpty }).strict(),
  ),
  define(
    "untangle_watch",
    "Start watching one explicit repository target.",
    z.object({ ...requiredScope, repositoryId: nonEmpty }).strict(),
    ["root"],
  ),
  define(
    "untangle_status",
    "Read workspace or job status without mutating it.",
    z.object({ ...optionalScope, jobId: nonEmpty.optional() }).strict(),
    ["root"],
  ),
  define(
    "untangle_health",
    "Run Untangle's configuration, storage, embedding and index health checks.",
    z
      .object({
        ...optionalScope,
        skipEmbeddings: z.boolean().optional(),
        timeoutMs: positiveInt.optional(),
      })
      .strict(),
    ["root"],
  ),
  define("untangle_projects", "List configured repositories/projects.", readScope, ["root"]),
  define(
    "untangle_search",
    "Search the indexed workspace with profile-separated, evidence-bearing results.",
    z
      .object({
        ...optionalScope,
        query: journeyText,
        limit: positiveInt.max(1_000).optional(),
        mode: z.enum(["hybrid", "semantic", "lexical", "symbol"]).optional(),
        abstention: z.enum(["strict", "evidence"]).optional(),
        requireFresh: z.boolean().optional(),
        repositories: z.array(nonEmpty).optional(),
        refs: z.array(nonEmpty).optional(),
        pathGlob: z.array(nonEmpty).optional(),
        languages: z.array(nonEmpty).optional(),
        symbolNames: z.array(nonEmpty).optional(),
        includeContent: z.boolean().optional(),
        includeContext: z.boolean().optional(),
        includeLinked: z.boolean().optional(),
        explain: z.boolean().optional(),
        session: z
          .object({ id: nonEmpty, step: positiveInt.max(128).optional() })
          .strict()
          .optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_search_session",
    "Start, inspect, annotate or complete a local task-scoped search journey, or report Dynamic Product Complexity.",
    z.discriminatedUnion("action", [
      z
        .object({
          ...optionalScope,
          action: z.literal("start"),
          goal: journeyText,
          featureId: featureId.optional(),
          retainText: z.boolean().optional(),
          executionContext: executionContext.optional(),
        })
        .strict(),
      z.object({ ...optionalScope, action: z.literal("get"), sessionId: nonEmpty }).strict(),
      z
        .object({
          ...optionalScope,
          action: z.literal("observe"),
          sessionId: nonEmpty,
          kind: z.enum(["open-file", "open-symbol", "graph-query", "other-tool"]),
          toolName: journeyToolName.optional(),
          target: searchJourneyTarget.optional(),
        })
        .strict(),
      z
        .object({
          ...optionalScope,
          action: z.literal("complete"),
          sessionId: nonEmpty,
          target: searchJourneyTarget,
          acceptedAttemptId: journeyLocator.optional(),
        })
        .strict(),
      z
        .object({
          ...optionalScope,
          action: z.literal("abandon"),
          sessionId: nonEmpty,
          reasonCode: z.enum(SEARCH_JOURNEY_ABANDON_REASON_CODES).optional(),
          reason: journeyReason.optional(),
        })
        .strict(),
      z.object({ ...optionalScope, action: z.literal("report") }).strict(),
    ]),
    ["root"],
  ),
  define("untangle_context_list", "List configured context artifacts.", readScope, ["root"]),
  define(
    "untangle_context_index",
    "Index explicitly selected context artifacts.",
    z.object({ ...requiredScope, artifactNames: z.array(nonEmpty).min(1) }).strict(),
    ["root"],
  ),
  define(
    "untangle_context_search",
    "Search context artifacts.",
    z.object({ ...optionalScope, query: nonEmpty, limit: positiveInt.optional() }).strict(),
    ["root"],
  ),
  define(
    "untangle_context_remove",
    "Remove one explicitly named context artifact target.",
    z.object({ ...requiredScope, target: nonEmpty }).strict(),
    ["root"],
  ),
  define(
    "untangle_graph_build",
    "Build the graph for one explicit workspace target.",
    z.object({ ...requiredScope, repositoryId: nonEmpty.optional() }).strict(),
    ["root"],
  ),
  define("untangle_graph_status", "Read the persisted workspace graph status.", readScope, [
    "root",
  ]),
  define(
    "untangle_graph_query",
    "Query a file node and its dependency/dependent neighborhood.",
    z
      .object({
        ...optionalScope,
        file: nonEmpty,
        direction: z.enum(["both", "dependencies", "dependents"]).optional(),
        depth: positiveInt.max(MAX_GRAPH_QUERY_DEPTH).optional(),
        maxNodes: positiveInt.max(MAX_GRAPH_QUERY_NODES).optional(),
        maxEdges: positiveInt.max(MAX_GRAPH_QUERY_EDGES).optional(),
      })
      .strict(),
    ["root"],
  ),
  define("untangle_graph_stats", "Return persisted file-graph metrics and provenance.", readScope, [
    "root",
  ]),
  define(
    "untangle_graph_cycles",
    "List persisted file-graph cycles without breaking them.",
    z.object({ ...optionalScope, limit: nonNegativeInt.optional() }).strict(),
    ["root"],
  ),
  define(
    "untangle_graph_visualize",
    "Write a deterministic, self-contained offline HTML graph explorer.",
    z
      .object({
        ...optionalScope,
        out: nonEmpty,
        layout: z.enum(["repository-lanes", "grid", "circle"]).optional(),
        maxNodes: positiveInt.max(MAX_MAX_NODES).optional(),
        maxEdges: positiveInt.max(MAX_MAX_EDGES).optional(),
      })
      .strict(),
    ["root", "out"],
  ),
  define(
    "untangle_graph_remove",
    "Remove one explicitly identified graph generation.",
    z.object({ ...requiredScope, target: nonEmpty }).strict(),
    ["root"],
  ),
  define(
    "untangle_symbols",
    "List persisted symbol nodes with deterministic ordering.",
    z
      .object({ ...optionalScope, query: nonEmpty.optional(), limit: positiveInt.optional() })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_symbol",
    "Resolve one unambiguous persisted symbol and show callers/callees.",
    z.object({ ...optionalScope, symbol: nonEmpty }).strict(),
    ["root"],
  ),
  define(
    "untangle_flow",
    "Find persisted call paths between two unambiguous symbols.",
    z
      .object({
        ...optionalScope,
        from: nonEmpty,
        to: nonEmpty.optional(),
        depth: positiveInt.max(MAX_FLOW_DEPTH).optional(),
        limit: positiveInt.max(MAX_FLOW_RESULT_LIMIT).optional(),
        maxNodes: positiveInt.max(MAX_FLOW_NODES).optional(),
        maxEdges: positiveInt.max(MAX_FLOW_EDGES).optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_impact",
    "Analyze callers affected by one persisted symbol.",
    z
      .object({
        ...optionalScope,
        symbol: nonEmpty,
        depth: positiveInt.max(MAX_FLOW_DEPTH).optional(),
        limit: positiveInt.max(MAX_FLOW_RESULT_LIMIT).optional(),
        maxNodes: positiveInt.max(MAX_FLOW_NODES).optional(),
        maxEdges: positiveInt.max(MAX_FLOW_EDGES).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_cross_repo_impact",
    "Analyze impact across repositories from a workspace graph snapshot.",
    z.object({ ...optionalScope, symbol: nonEmpty, depth: positiveInt.optional() }).strict(),
    ["root"],
  ),
  define(
    "untangle_complexity",
    "Measure code complexity directly from workspace files, without an index.",
    z
      .object({
        ...optionalScope,
        top: nonNegativeInt.optional(),
        includeNested: z.boolean().optional(),
        prose: z.boolean().optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_complexity_explain",
    "Explain the contribution sites of one complexity scope.",
    z.object({ ...optionalScope, symbol: nonEmpty, path: nonEmpty.optional() }).strict(),
    ["root", "path"],
  ),
  define(
    "untangle_hotspots",
    "List the highest measured complexity hotspots.",
    z
      .object({ ...optionalScope, limit: nonNegativeInt.optional(), prose: z.boolean().optional() })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_complexity_diff",
    "Compare complexity between two explicit revisions.",
    z.object({ ...optionalScope, base: nonEmpty, head: nonEmpty }).strict(),
    ["root"],
  ),
  define(
    "untangle_changes",
    "Analyze changes between two explicit revisions.",
    z.object({ ...optionalScope, base: nonEmpty, head: nonEmpty }).strict(),
    ["root"],
  ),
  define(
    "untangle_change_search",
    "Search persisted change history.",
    z.object({ ...optionalScope, query: nonEmpty, limit: positiveInt.optional() }).strict(),
    ["root"],
  ),
  define(
    "untangle_quality_gate",
    "Evaluate a delta-first quality gate between two explicit revisions.",
    z.object({ ...optionalScope, base: nonEmpty, head: nonEmpty }).strict(),
    ["root"],
  ),
  define("untangle_about", "Return version, license, source and capability truth.", empty),
  define(
    "untangle_portfolio_scan",
    "Scan an explicit portfolio workspace.",
    z
      .object({
        ...optionalScope,
        repositories: z.array(nonEmpty).optional(),
        refreshHistory: z.boolean().optional(),
        background: z.boolean().optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_stack_matrix",
    "Read a portfolio technology stack matrix.",
    z
      .object({
        ...optionalScope,
        categories: z.array(nonEmpty).optional(),
        includeTransitive: z.boolean().optional(),
        minAdoptionShare: z.number().min(0).max(1).optional(),
        generationId: nonEmpty.optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_who_uses",
    "Find repositories using one technology.",
    z
      .object({
        ...optionalScope,
        technology: nonEmpty,
        versionRange: nonEmpty.optional(),
        includeDepth: z.boolean().optional(),
        includeDeclaredOnly: z.boolean().optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_conventions",
    "Read detected repository conventions with evidence.",
    z
      .object({
        ...optionalScope,
        kinds: z.array(nonEmpty).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        includeCounterexamples: z.boolean().optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_archetypes",
    "Read deterministic project archetype assignments.",
    z
      .object({
        ...optionalScope,
        repositories: z.array(nonEmpty).optional(),
        explain: z.boolean().optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_tech_radar",
    "Read the evidence-backed portfolio technology radar.",
    z
      .object({
        ...optionalScope,
        rings: z.array(z.enum(["adopt", "maintain", "consolidate", "retire"])).optional(),
        categories: z.array(nonEmpty).optional(),
        problemDomain: nonEmpty.optional(),
      })
      .strict(),
    ["root"],
  ),
  define(
    "untangle_blueprint",
    "Generate or apply an evidence-backed project blueprint.",
    z
      .object({
        ...optionalScope,
        kind: z.enum(["api-service", "worker", "cli", "library", "web-app", "mcp-server"]),
        language: nonEmpty.optional(),
        topics: z.array(nonEmpty).optional(),
        targetDir: nonEmpty.optional(),
        apply: z.boolean().optional(),
        showContent: z.boolean().optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.apply === true && value.targetDir === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["targetDir"],
            message: "targetDir is required when apply=true",
          });
        }
      }),
    ["root", "targetDir"],
  ),
  define(
    "untangle_product",
    "Resolve a search result's repository-relative path to declared features, ownership, full feature complexity and supplied test evidence. Works offline; no test execution or independent semantic proof.",
    z
      .object({
        ...optionalScope,
        manifest: nonEmpty.optional(),
        testEvidence: nonEmpty.optional(),
        featureId: nonEmpty.optional(),
        path: nonEmpty.optional(),
        maxCognitive: z.number().finite().nonnegative().optional(),
        requireComplete: z.boolean().optional(),
      })
      .strict(),
    ["root", "manifest", "testEvidence"],
  ),
  define(
    "untangle_boundaries",
    "Read current Vue/TS/JS import context and HTTP dependencies to mounted FastAPI routes, with explicit service bindings and declared feature ownership. No index, network, project execution or inferred synchronous calls.",
    z
      .object({
        ...optionalScope,
        path: nonEmpty.optional(),
        servicesFile: nonEmpty.optional(),
        maxRelations: z.number().int().min(1).max(1000).optional(),
      })
      .strict(),
    ["root", "servicesFile"],
  ),
] as const satisfies readonly McpToolDefinition[];

export type UntangleMcpInputByOperation = {
  [Name in UntangleMcpToolName]: z.output<
    Extract<(typeof UNTANGLE_MCP_TOOLS)[number], { readonly name: Name }>["inputSchema"]
  >;
};

/** Compile-time operation map shared by typed MCP adapters and contract tests. */
export type UntangleMcpOperationMap = {
  [Name in UntangleMcpToolName]: {
    input: UntangleMcpInputByOperation[Name];
    output: UntangleMcpSuccessDataByOperation[Name];
  };
};
