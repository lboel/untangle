import path from "node:path";

import {
  compareCodepoints,
  isUntangleError,
  type SearchJourneyAbandonReasonCode,
  type SearchJourneyExecutionContextInputV1,
  type SearchJourneyTargetV1,
  type SearchResultSetV1,
  type ToolResponseEnvelopeV1,
  type ToolWarningV1,
} from "@untangle-code/domain";
import { MAX_MAX_EDGES, MAX_MAX_NODES } from "@untangle-code/graph-explorer";
import { SearchJourneyService } from "@untangle-code/search";
import { openLocalStorage } from "@untangle-code/storage-local";
import { createSymbolGraphIndex } from "@untangle-code/symbol-graph";

import type { FlagValue, ParsedArgs } from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { CliError, EXIT } from "../cli/exit.js";
import { loadGraphs } from "../cli/graphs.js";
import { stateRootOf } from "../cli/index-state.js";
import { BufferIo } from "../cli/io.js";
import { systemClock, systemRandom } from "../cli/system.js";
import { CLI_VERSION } from "../cli/version.js";
import { loadWorkspace } from "../cli/workspace.js";
import { complexityCommand } from "../commands/complexity.js";
import { doctorCommand } from "../commands/doctor.js";
import { flowCommand } from "../commands/flow/index.js";
import {
  MAX_FLOW_DEPTH,
  MAX_FLOW_EDGES,
  MAX_FLOW_NODES,
  MAX_FLOW_RESULT_LIMIT,
  MAX_GRAPH_QUERY_DEPTH,
  MAX_GRAPH_QUERY_EDGES,
  MAX_GRAPH_QUERY_NODES,
} from "../commands/flow/limits.js";
import { selectSymbolNode } from "../commands/flow/select.js";
import { runBoundaries } from "../commands/graph/boundaries.js";
import { graphCommand } from "../commands/graph/index.js";
import { productCommand } from "../commands/product.js";
import { queryCommand } from "../commands/query.js";

import { mcpFailure, mcpSuccess, unavailableEnvelope } from "./envelope.js";
import { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } from "./output-schemas.js";
import type { McpInvocationContext, UntangleMcpRuntime, UntangleMcpToolName } from "./types.js";

const SOURCE_URL = "https://github.com/lboel/untangle";

export const DEFAULT_MCP_AVAILABLE_TOOLS = Object.freeze([
  "untangle_health",
  "untangle_projects",
  "untangle_search",
  "untangle_search_session",
  "untangle_context_list",
  "untangle_graph_status",
  "untangle_graph_query",
  "untangle_graph_stats",
  "untangle_graph_cycles",
  "untangle_graph_visualize",
  "untangle_symbols",
  "untangle_symbol",
  "untangle_flow",
  "untangle_impact",
  "untangle_complexity",
  "untangle_hotspots",
  "untangle_about",
  "untangle_product",
  "untangle_boundaries",
] as const satisfies readonly UntangleMcpToolName[]);

type DefaultMcpAvailableTool = (typeof DEFAULT_MCP_AVAILABLE_TOOLS)[number];

const DEFAULT_MCP_AVAILABLE_TOOL_SET: ReadonlySet<UntangleMcpToolName> = new Set(
  DEFAULT_MCP_AVAILABLE_TOOLS,
);

function isDefaultAvailableTool(
  operation: UntangleMcpToolName,
): operation is DefaultMcpAvailableTool {
  return DEFAULT_MCP_AVAILABLE_TOOL_SET.has(operation);
}

/** Default local runtime. It never spawns an external process. */
export class DefaultUntangleMcpRuntime implements UntangleMcpRuntime {
  async invoke(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    if (context.signal.aborted) {
      return mcpFailure(operation, "CANCELLED", "The MCP operation was cancelled.", false);
    }

    try {
      const scopeFailure = validateRequestedWorkspace(operation, input, context);
      if (scopeFailure !== null) return scopeFailure;
      if (!isDefaultAvailableTool(operation)) {
        if (operation === "untangle_blueprint" && input["apply"] === true) {
          const targetDirectory = path.resolve(
            stringInput(input, "root") ?? context.cwd,
            String(input["targetDir"]),
          );
          return mcpFailure(
            operation,
            "FEATURE_UNAVAILABLE",
            `Blueprint apply is unavailable for target directory "${targetDirectory}"; no filesystem changes were made.`,
            false,
            {
              ...(typeof input["workspaceId"] === "string"
                ? { workspaceId: input["workspaceId"] }
                : {}),
              details: {
                missingCapability: unavailableReason(operation),
                targetDirectory,
                mutationPerformed: false,
              },
            },
          );
        }
        return unavailableEnvelope(operation, unavailableReason(operation));
      }

      let result: ToolResponseEnvelopeV1<unknown>;
      switch (operation) {
        case "untangle_boundaries": {
          const flags: Record<string, FlagValue> = { format: "json" };
          copyString(input, "root", flags, "root");
          copyString(input, "path", flags, "path");
          copyString(input, "servicesFile", flags, "services");
          copyNumber(input, "maxRelations", flags, "max-relations");
          result = await invokeJsonCommand(
            operation,
            { spec: graphCommand.spec, run: runBoundaries },
            { positionals: [], flags },
            context,
          );
          break;
        }
        case "untangle_about":
          result = about(operation, context.env);
          break;
        case "untangle_projects":
          result = projects(operation, input, context);
          break;
        case "untangle_context_list":
          result = contextList(operation, input, context);
          break;
        case "untangle_health":
          result = await this.health(operation, input, context);
          break;
        case "untangle_search":
          result = await this.search(operation, input, context);
          break;
        case "untangle_search_session":
          result = await this.searchSession(operation, input, context);
          break;
        case "untangle_complexity":
        case "untangle_hotspots":
          result = await this.complexity(operation, input, context);
          break;
        case "untangle_product":
          result = await this.product(operation, input, context);
          break;
        case "untangle_graph_status":
        case "untangle_graph_query":
        case "untangle_graph_stats":
        case "untangle_graph_cycles":
        case "untangle_graph_visualize":
          result = await this.graph(operation, input, context);
          break;
        case "untangle_symbols":
        case "untangle_symbol":
          result = await this.symbols(operation, input, context);
          break;
        case "untangle_flow":
        case "untangle_impact":
          result = await this.flow(operation, input, context);
          break;
        default:
          return assertNever(operation);
      }
      if (context.signal.aborted) return cancelledEnvelope(operation);
      return result;
    } catch (error) {
      if (context.signal.aborted) return cancelledEnvelope(operation);
      return failureFromThrown(operation, error);
    }
  }

  private async health(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    const flags: Record<string, FlagValue> = { format: "json" };
    copyString(input, "root", flags, "root");
    copyBoolean(input, "skipEmbeddings", flags, "skip-embeddings");
    copyNumber(input, "timeoutMs", flags, "timeout");
    return invokeJsonCommand(operation, doctorCommand, { positionals: [], flags }, context, [
      EXIT.ok,
      EXIT.environment,
    ]);
  }

  private async search(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    const flags: Record<string, FlagValue> = { format: "json" };
    copyString(input, "root", flags, "root");
    copyString(input, "workspaceId", flags, "workspace");
    copyNumber(input, "limit", flags, "limit");
    copyString(input, "mode", flags, "mode");
    copyString(input, "abstention", flags, "abstention");
    copyBoolean(input, "requireFresh", flags, "require-fresh");
    copyStrings(input, "repositories", flags, "repo");
    copyStrings(input, "refs", flags, "ref");
    copyStrings(input, "pathGlob", flags, "path");
    copyStrings(input, "languages", flags, "lang");
    copyStrings(input, "symbolNames", flags, "symbol");
    copyBoolean(input, "includeContent", flags, "content");
    copyBoolean(input, "includeContext", flags, "context");
    copyBoolean(input, "includeLinked", flags, "linked");
    copyBoolean(input, "explain", flags, "explain");
    const result = await invokeJsonCommand(
      operation,
      queryCommand,
      { positionals: [String(input["query"])], flags },
      context,
    );
    const link = searchSessionLink(input);
    if (link === null) return result;
    const searchData = result.ok ? result.data : result.error?.details?.["data"];

    try {
      const service = await openSearchJourneyService(input, context);
      const parsed = UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search.safeParse(searchData);
      if (parsed.success) {
        const recorded = await service.recordSearch(
          link.id,
          parsed.data as unknown as SearchResultSetV1,
          link.step === undefined ? {} : { step: link.step },
          { signal: context.signal },
        );
        return withSearchObservation(result, parsed.data, {
          sessionId: link.id,
          attemptId: recorded.attempt.attemptId,
          status: "recorded",
        });
      }
      if (result.ok) return result;
      await service.recordFailedSearch(
        link.id,
        {
          query: String(input["query"]),
          failureCode: result.error?.code ?? "OPERATION_FAILED",
          failureReason: result.error?.message ?? "The search did not produce a success result.",
        },
        link.step === undefined ? {} : { step: link.step },
        { signal: context.signal },
      );
      return result;
    } catch (error) {
      const warning: ToolWarningV1 = {
        code: "SEARCH_SESSION_RECORDING_FAILED",
        message:
          searchData !== undefined
            ? "The search result is valid, but its optional Dynamic Product Complexity observation could not be recorded."
            : "The search failed, and its optional Dynamic Product Complexity failure observation could not be recorded.",
        details: {
          sessionId: link.id,
          reasonCode: isUntangleError(error)
            ? error.code
            : error instanceof Error
              ? error.name
              : "UNKNOWN_ERROR",
        },
      };
      if (!isRecord(searchData)) {
        return { ...result, warnings: [...result.warnings, warning] };
      }
      return withSearchObservation(
        { ...result, warnings: [...result.warnings, warning] },
        searchData,
        { sessionId: link.id, status: "not_recorded", warningCode: warning.code },
      );
    }
  }

  private async searchSession(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    const action = String(input["action"]);
    const service = await openSearchJourneyService(input, context);
    const callOptions = { signal: context.signal };
    switch (action) {
      case "start": {
        const session = await service.start(
          {
            goal: String(input["goal"]),
            ...(typeof input["featureId"] === "string" ? { featureId: input["featureId"] } : {}),
            ...(typeof input["retainText"] === "boolean"
              ? { retainText: input["retainText"] }
              : {}),
            ...(isRecord(input["executionContext"])
              ? {
                  executionContext: input[
                    "executionContext"
                  ] as unknown as SearchJourneyExecutionContextInputV1,
                }
              : {}),
          },
          callOptions,
        );
        return mcpSuccess(operation, { action, session }, { workspaceId: session.workspaceId });
      }
      case "get": {
        const session = await service.get(String(input["sessionId"]), callOptions);
        return mcpSuccess(operation, { action, session }, { workspaceId: session.workspaceId });
      }
      case "observe": {
        const session = await service.observeNavigation(
          String(input["sessionId"]),
          {
            kind: input["kind"] as "open-file" | "open-symbol" | "graph-query" | "other-tool",
            ...(typeof input["toolName"] === "string" ? { toolName: input["toolName"] } : {}),
            ...(isRecord(input["target"]) ? { target: searchJourneyTarget(input["target"]) } : {}),
          },
          callOptions,
        );
        return mcpSuccess(operation, { action, session }, { workspaceId: session.workspaceId });
      }
      case "complete": {
        const session = await service.complete(
          String(input["sessionId"]),
          {
            target: searchJourneyTarget(input["target"] as Readonly<Record<string, unknown>>),
            ...(typeof input["acceptedAttemptId"] === "string"
              ? { acceptedAttemptId: input["acceptedAttemptId"] }
              : {}),
          },
          callOptions,
        );
        return mcpSuccess(operation, { action, session }, { workspaceId: session.workspaceId });
      }
      case "abandon": {
        const session = await service.abandon(
          String(input["sessionId"]),
          {
            ...(typeof input["reasonCode"] === "string"
              ? { reasonCode: input["reasonCode"] as SearchJourneyAbandonReasonCode }
              : {}),
            ...(typeof input["reason"] === "string" ? { reason: input["reason"] } : {}),
          },
          callOptions,
        );
        return mcpSuccess(operation, { action, session }, { workspaceId: session.workspaceId });
      }
      case "report": {
        const report = await service.report(callOptions);
        return mcpSuccess(operation, { action, report }, { workspaceId: report.workspaceId });
      }
      default:
        return mcpFailure(
          operation,
          "INVALID_ARGUMENT",
          `Unknown search-session action "${action}".`,
          false,
        );
    }
  }

  private async product(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    const flags: Record<string, FlagValue> = { format: "json" };
    copyString(input, "root", flags, "root");
    copyString(input, "manifest", flags, "manifest");
    copyString(input, "testEvidence", flags, "test-evidence");
    copyString(input, "featureId", flags, "feature");
    copyString(input, "path", flags, "path");
    copyNumber(input, "maxCognitive", flags, "max-cognitive");
    copyBoolean(input, "requireComplete", flags, "require-complete");
    return invokeJsonCommand(operation, productCommand, { positionals: [], flags }, context);
  }

  private async complexity(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    const flags: Record<string, FlagValue> = { format: "json" };
    copyString(input, "root", flags, "root");
    copyBoolean(input, "prose", flags, "prose");
    if (operation === "untangle_hotspots") {
      copyNumber(input, "limit", flags, "top");
    } else {
      copyNumber(input, "top", flags, "top");
      copyBoolean(input, "includeNested", flags, "include-nested");
    }
    return invokeJsonCommand(operation, complexityCommand, { positionals: [], flags }, context);
  }

  private async graph(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    if (operation === "untangle_graph_query" && stringInput(input, "file") === undefined) {
      return mcpFailure(
        operation,
        "INVALID_ARGUMENT",
        "untangle_graph_query requires an explicit file; the unbounded workspace overview is not exposed over MCP.",
        false,
      );
    }
    const flags: Record<string, FlagValue> = { format: "json" };
    copyString(input, "root", flags, "root");
    copyString(input, "direction", flags, "direction");
    copyCappedNumber(input, "depth", flags, "depth", MAX_GRAPH_QUERY_DEPTH);
    copyCappedNumber(
      input,
      "maxNodes",
      flags,
      "max-nodes",
      operation === "untangle_graph_visualize" ? MAX_MAX_NODES : MAX_GRAPH_QUERY_NODES,
    );
    copyCappedNumber(
      input,
      "maxEdges",
      flags,
      "max-edges",
      operation === "untangle_graph_visualize" ? MAX_MAX_EDGES : MAX_GRAPH_QUERY_EDGES,
    );
    copyNumber(input, "limit", flags, "limit");
    copyString(input, "out", flags, "out");
    copyString(input, "layout", flags, "layout");
    const file = typeof input["file"] === "string" ? input["file"] : undefined;
    const positionals =
      operation === "untangle_graph_visualize" ? ["visualize"] : file === undefined ? [] : [file];
    const envelope = await invokeJsonCommand(
      operation,
      graphCommand,
      { positionals, flags },
      context,
    );
    if (!envelope.ok || !isRecord(envelope.data)) return envelope;
    if (operation === "untangle_graph_query" && file !== undefined) return envelope;
    if (file !== undefined) return envelope;
    if (operation === "untangle_graph_stats") {
      return {
        ...envelope,
        data: {
          generationId: envelope.data["generationId"],
          metrics: envelope.data["metrics"],
          boundaries: envelope.data["boundaries"],
          issues: envelope.data["issues"],
        },
      };
    }
    if (operation === "untangle_graph_cycles") {
      const limit = typeof input["limit"] === "number" ? input["limit"] : 20;
      const cycles = Array.isArray(envelope.data["cyclePaths"])
        ? envelope.data["cyclePaths"].slice(0, limit)
        : [];
      return {
        ...envelope,
        data: {
          generationId: envelope.data["generationId"],
          cycles,
          total: Array.isArray(envelope.data["cyclePaths"])
            ? envelope.data["cyclePaths"].length
            : 0,
          issues: envelope.data["issues"],
        },
      };
    }
    if (operation === "untangle_graph_status") {
      return {
        ...envelope,
        data: {
          generationId: envelope.data["generationId"],
          workspaceId: envelope.data["workspaceId"],
          metrics: envelope.data["metrics"],
          issues: envelope.data["issues"],
        },
      };
    }
    return envelope;
  }

  private async symbols(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    const loaded = await loadGraphs({
      cwd: stringInput(input, "root") ?? context.cwd,
      env: context.env,
      signal: context.signal,
    });
    const requestedWorkspace = stringInput(input, "workspaceId");
    if (requestedWorkspace !== undefined && requestedWorkspace !== loaded.fileGraph.workspaceId) {
      return mcpFailure(
        operation,
        "WORKSPACE_NOT_FOUND",
        `Loaded graph belongs to workspace "${loaded.fileGraph.workspaceId}", not requested workspace "${requestedWorkspace}".`,
        false,
      );
    }
    if (loaded.symbolGraph === null) {
      return mcpFailure(
        operation,
        "INDEX_INCOMPLETE",
        loaded.symbolGraphMissingReason ?? "The symbol graph is unavailable.",
        false,
      );
    }
    const index = createSymbolGraphIndex(loaded.symbolGraph.graph);
    if (operation === "untangle_symbols") {
      const query = stringInput(input, "query")?.toLowerCase();
      const limit = numberInput(input, "limit") ?? 100;
      const matching = index
        .nodes()
        .filter(
          (node) =>
            query === undefined ||
            node.name.toLowerCase().includes(query) ||
            node.qualifiedName.toLowerCase().includes(query),
        )
        .sort(
          (left, right) =>
            compareCodepoints(left.repoId, right.repoId) ||
            compareCodepoints(left.refId, right.refId) ||
            compareCodepoints(left.filePath, right.filePath) ||
            left.startLine - right.startLine ||
            compareCodepoints(left.id, right.id),
        );
      return mcpSuccess(
        operation,
        {
          generationId: loaded.generationId,
          symbols: matching.slice(0, limit),
          total: matching.length,
          truncated: matching.length > limit,
        },
        { workspaceId: loaded.fileGraph.workspaceId },
      );
    }
    const selection = selectSymbolNode(index.nodes(), String(input["symbol"]));
    if (selection.status === "ambiguous") {
      return mcpFailure(
        operation,
        "SYMBOL_AMBIGUOUS",
        `The symbol matched ${String(selection.candidates.length)} persisted nodes; none was selected.`,
        false,
        { details: { candidates: selection.candidates } },
      );
    }
    if (selection.status === "absent") {
      return mcpFailure(
        operation,
        "SYMBOL_NOT_FOUND",
        "The symbol is not present in the persisted graph.",
        false,
        { details: { near: selection.near } },
      );
    }
    return mcpSuccess(
      operation,
      {
        generationId: loaded.generationId,
        matchedBy: selection.matchedBy,
        symbol: selection.node,
        outgoing: index.outgoingEdges(selection.node.id),
        callers: index.callers(selection.node.id),
      },
      { workspaceId: loaded.fileGraph.workspaceId },
    );
  }

  private async flow(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>> {
    const flags: Record<string, FlagValue> = { format: "json" };
    copyString(input, "root", flags, "root");
    copyCappedNumber(input, "depth", flags, "depth", MAX_FLOW_DEPTH);
    copyCappedNumber(input, "limit", flags, "limit", MAX_FLOW_RESULT_LIMIT);
    copyCappedNumber(input, "maxNodes", flags, "max-nodes", MAX_FLOW_NODES);
    copyCappedNumber(input, "maxEdges", flags, "max-edges", MAX_FLOW_EDGES);
    copyNumber(input, "minConfidence", flags, "min-confidence");
    const first = operation === "untangle_impact" ? String(input["symbol"]) : String(input["from"]);
    const positionals = [first];
    if (operation === "untangle_impact") {
      flags["impact"] = true;
    } else if (typeof input["to"] === "string") {
      positionals.push(input["to"]);
    }
    return invokeJsonCommand(operation, flowCommand, { positionals, flags }, context);
  }
}

async function openSearchJourneyService(
  input: Readonly<Record<string, unknown>>,
  context: McpInvocationContext,
): Promise<SearchJourneyService> {
  const view = loadWorkspace({
    cwd: stringInput(input, "root") ?? context.cwd,
    env: context.env,
    strict: true,
  });
  const local = await openLocalStorage(
    stateRootOf(view.root),
    {
      clock: systemClock,
      random: systemRandom,
    },
    { signal: context.signal },
  );
  return new SearchJourneyService({
    workspaceId: view.workspaceId,
    store: local.searchJourneys,
    clock: systemClock,
    random: systemRandom,
    fingerprintKeyProvider: async (options) =>
      await local.searchJourneys.getOrCreateFingerprintKey(options),
  });
}

function searchSessionLink(
  input: Readonly<Record<string, unknown>>,
): { id: string; step?: number } | null {
  const session = input["session"];
  if (!isRecord(session) || typeof session["id"] !== "string") return null;
  return {
    id: session["id"],
    ...(typeof session["step"] === "number" ? { step: session["step"] } : {}),
  };
}

function searchJourneyTarget(input: Readonly<Record<string, unknown>>): SearchJourneyTargetV1 {
  const output: SearchJourneyTargetV1 = {};
  for (const key of [
    "repoId",
    "refId",
    "filePath",
    "chunkId",
    "symbolId",
    "embeddingProfileId",
    "indexGeneration",
  ] as const) {
    const value = input[key];
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

function validateRequestedWorkspace(
  operation: UntangleMcpToolName,
  input: Readonly<Record<string, unknown>>,
  context: McpInvocationContext,
): ToolResponseEnvelopeV1<unknown> | null {
  const requestedWorkspace = stringInput(input, "workspaceId");
  if (requestedWorkspace === undefined) return null;
  const view = loadWorkspace({
    cwd: stringInput(input, "root") ?? context.cwd,
    env: context.env,
    strict: true,
  });
  if (requestedWorkspace === view.workspaceId) return null;
  return mcpFailure(
    operation,
    "WORKSPACE_NOT_FOUND",
    `The requested workspace "${requestedWorkspace}" is not the workspace served by this MCP scope.`,
    false,
    { workspaceId: requestedWorkspace },
  );
}

function about(
  operation: UntangleMcpToolName,
  env: Readonly<Record<string, string | undefined>>,
): ToolResponseEnvelopeV1<unknown> {
  const commit = env["UNTANGLE_BUILD_COMMIT"]?.trim() || "unknown";
  const warnings: ToolWarningV1[] =
    commit === "unknown"
      ? [
          {
            code: "BUILD_COMMIT_UNKNOWN",
            message: "This development build did not embed a source commit.",
          },
        ]
      : [];
  return mcpSuccess(
    operation,
    {
      name: "untangle",
      version: CLI_VERSION,
      license: "AGPL-3.0-only",
      source: SOURCE_URL,
      commit,
      availableTools: [...DEFAULT_MCP_AVAILABLE_TOOLS].sort(compareCodepoints),
      unavailableToolsReturn: "FEATURE_UNAVAILABLE",
    },
    { warnings },
  );
}

function projects(
  operation: UntangleMcpToolName,
  input: Readonly<Record<string, unknown>>,
  context: McpInvocationContext,
): ToolResponseEnvelopeV1<unknown> {
  const view = loadWorkspace({
    cwd: stringInput(input, "root") ?? context.cwd,
    env: context.env,
    strict: true,
  });
  return mcpSuccess(
    operation,
    {
      root: view.root,
      repositories: view.config.repositories ?? [],
      projectId: view.config.projectId,
    },
    { workspaceId: view.workspaceId },
  );
}

function contextList(
  operation: UntangleMcpToolName,
  input: Readonly<Record<string, unknown>>,
  context: McpInvocationContext,
): ToolResponseEnvelopeV1<unknown> {
  const view = loadWorkspace({
    cwd: stringInput(input, "root") ?? context.cwd,
    env: context.env,
    strict: true,
  });
  const artifacts = [...(view.config.contextArtifacts ?? [])].sort((left, right) =>
    compareCodepoints(left.name, right.name),
  );
  return mcpSuccess(
    operation,
    { artifacts, configured: artifacts.length },
    { workspaceId: view.workspaceId },
  );
}

async function invokeJsonCommand(
  operation: UntangleMcpToolName,
  command: Command,
  args: ParsedArgs,
  context: McpInvocationContext,
  acceptedExitCodes: readonly number[] = [EXIT.ok],
): Promise<ToolResponseEnvelopeV1<unknown>> {
  const io = new BufferIo();
  const commandContext: CommandContext = {
    io,
    cwd: context.cwd,
    env: context.env,
    signal: context.signal,
  };
  let exitCode: number;
  try {
    exitCode = await command.run(commandContext, args);
  } catch (error) {
    if (context.signal.aborted) return cancelledEnvelope(operation);
    const failure = failureFromThrown(operation, error);
    return partialSearchFailure(operation, error, io, failure) ?? failure;
  }
  if (context.signal.aborted) return cancelledEnvelope(operation);
  const warnings = diagnostics(io.errText);
  let data: unknown;
  try {
    data = io.outText.trim() === "" ? null : JSON.parse(io.outText);
  } catch {
    return mcpFailure(
      operation,
      "INVALID_INTERNAL_OUTPUT",
      `${command.spec.name} did not emit valid JSON.`,
      false,
      { warnings },
    );
  }
  if (!acceptedExitCodes.includes(exitCode)) {
    return mcpFailure(
      operation,
      codeForExit(exitCode),
      `The ${command.spec.name} operation ended with exit code ${String(exitCode)}.`,
      exitCode === EXIT.environment,
      { warnings, details: { exitCode, data } },
    );
  }
  return mcpSuccess(operation, data, { warnings });
}

/** Preserve verified fallback hits without turning infrastructure failure into success. */
function partialSearchFailure(
  operation: UntangleMcpToolName,
  error: unknown,
  io: BufferIo,
  failure: ToolResponseEnvelopeV1<unknown>,
): ToolResponseEnvelopeV1<unknown> | undefined {
  if (
    operation !== "untangle_search" ||
    !(error instanceof CliError) ||
    error.exitCode !== EXIT.environment
  ) {
    return undefined;
  }
  let output: unknown;
  try {
    output = JSON.parse(io.outText);
  } catch {
    return undefined;
  }
  const parsed = UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search.safeParse(output);
  if (
    !parsed.success ||
    !parsed.data.warnings.some((warning) => warning.code === "SEARCH_BRANCH_UNAVAILABLE") ||
    !parsed.data.skipped.some(
      (entry) =>
        entry.subjectKind === "search_candidate" && entry.reason === "provider_unavailable",
    )
  ) {
    return undefined;
  }
  return {
    ...failure,
    workspaceId: parsed.data.query.workspaceId,
    warnings: [
      ...failure.warnings,
      ...parsed.data.warnings.map(({ code, message, details }) => ({
        code,
        message,
        ...(details === undefined ? {} : { details }),
      })),
      ...diagnostics(io.errText),
    ],
    error: {
      code: failure.error?.code ?? "ENVIRONMENT_UNAVAILABLE",
      message: failure.error?.message ?? "Search retrieval was incomplete.",
      retryable: true,
      details: { ...failure.error?.details, exitCode: error.exitCode, data: parsed.data },
    },
  };
}

/** A partial search observation belongs inside its preserved failure payload. */
function withSearchObservation(
  result: ToolResponseEnvelopeV1<unknown>,
  searchData: Readonly<Record<string, unknown>>,
  observation: Readonly<Record<string, string>>,
): ToolResponseEnvelopeV1<unknown> {
  const data = { ...searchData, searchObservation: observation };
  if (result.ok) return { ...result, data };
  if (result.error === undefined) return result;
  return { ...result, error: { ...result.error, details: { ...result.error.details, data } } };
}

function failureFromThrown(
  operation: UntangleMcpToolName,
  error: unknown,
): ToolResponseEnvelopeV1<unknown> {
  if (error instanceof CliError) {
    return mcpFailure(
      operation,
      codeForExit(error.exitCode),
      error.message,
      error.exitCode === EXIT.environment,
      error.nextStep === undefined ? {} : { details: { nextStep: error.nextStep } },
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return mcpFailure(operation, "CANCELLED", "The MCP operation was cancelled.", false);
  }
  if (isUntangleError(error)) {
    return mcpFailure(operation, error.code, error.message, error.retryable, {
      ...(Object.keys(error.context).length === 0 ? {} : { details: error.context }),
    });
  }
  return mcpFailure(
    operation,
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
    false,
  );
}

function cancelledEnvelope(operation: UntangleMcpToolName): ToolResponseEnvelopeV1<unknown> {
  return mcpFailure(operation, "CANCELLED", "The MCP operation was cancelled.", false);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled default MCP capability: ${String(value)}`);
}

function codeForExit(exitCode: number): string {
  if (exitCode === EXIT.usage) return "INVALID_ARGUMENT";
  if (exitCode === EXIT.unavailable) return "FEATURE_UNAVAILABLE";
  if (exitCode === EXIT.environment) return "ENVIRONMENT_UNAVAILABLE";
  if (exitCode === EXIT.gate) return "QUALITY_GATE_FAILED";
  if (exitCode === EXIT.cancelled) return "CANCELLED";
  return "OPERATION_FAILED";
}

function diagnostics(text: string): ToolWarningV1[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((message) => ({ code: "CLI_DIAGNOSTIC", message }));
}

function unavailableReason(operation: UntangleMcpToolName): string {
  if (
    [
      "untangle_index",
      "untangle_update",
      "untangle_stop",
      "untangle_watch",
      "untangle_status",
    ].includes(operation)
  )
    return "the job-capable MCP composition and persisted job registry are not wired";
  if (
    ["untangle_context_index", "untangle_context_search", "untangle_context_remove"].includes(
      operation,
    )
  )
    return "context-artifact mutation/search use cases are not exposed by the current core facade";
  if (["untangle_graph_build", "untangle_graph_remove"].includes(operation))
    return "standalone graph mutation is not exposed by the current core facade";
  if (operation === "untangle_cross_repo_impact")
    return "a workspace-scoped multi-repository graph snapshot is required before cross-repository impact can be claimed";
  if (
    [
      "untangle_complexity_explain",
      "untangle_complexity_diff",
      "untangle_changes",
      "untangle_change_search",
      "untangle_quality_gate",
    ].includes(operation)
  )
    return "the change-analysis and quality-gate engine is not implemented";
  if (
    operation.startsWith("untangle_portfolio") ||
    [
      "untangle_stack_matrix",
      "untangle_who_uses",
      "untangle_conventions",
      "untangle_archetypes",
      "untangle_tech_radar",
      "untangle_blueprint",
    ].includes(operation)
  )
    return "the portfolio engine is not implemented";
  return "the operation is not implemented by this runtime";
}

function stringInput(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function numberInput(input: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function copyString(
  input: Readonly<Record<string, unknown>>,
  from: string,
  flags: Record<string, FlagValue>,
  to: string,
): void {
  const value = stringInput(input, from);
  if (value !== undefined) flags[to] = value;
}

function copyNumber(
  input: Readonly<Record<string, unknown>>,
  from: string,
  flags: Record<string, FlagValue>,
  to: string,
): void {
  const value = numberInput(input, from);
  if (value !== undefined) flags[to] = value;
}

function copyCappedNumber(
  input: Readonly<Record<string, unknown>>,
  from: string,
  flags: Record<string, FlagValue>,
  to: string,
  maximum: number,
): void {
  const value = numberInput(input, from);
  if (value !== undefined) flags[to] = Math.min(value, maximum);
}

function copyBoolean(
  input: Readonly<Record<string, unknown>>,
  from: string,
  flags: Record<string, FlagValue>,
  to: string,
): void {
  const value = input[from];
  if (typeof value === "boolean") flags[to] = value;
}

function copyStrings(
  input: Readonly<Record<string, unknown>>,
  from: string,
  flags: Record<string, FlagValue>,
  to: string,
): void {
  const value = input[from];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) flags[to] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
