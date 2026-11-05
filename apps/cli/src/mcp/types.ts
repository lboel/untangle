import type { ToolResponseEnvelopeV1 } from "@untangle-code/domain";

export interface McpInvocationContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

/** Application boundary used by the MCP adapter. */
export interface UntangleMcpRuntime {
  invoke(
    operation: UntangleMcpToolName,
    input: Readonly<Record<string, unknown>>,
    context: McpInvocationContext,
  ): Promise<ToolResponseEnvelopeV1<unknown>>;
}

export const UNTANGLE_MCP_TOOL_NAMES = [
  "untangle_index",
  "untangle_update",
  "untangle_stop",
  "untangle_watch",
  "untangle_status",
  "untangle_health",
  "untangle_projects",
  "untangle_search",
  "untangle_search_session",
  "untangle_context_list",
  "untangle_context_index",
  "untangle_context_search",
  "untangle_context_remove",
  "untangle_graph_build",
  "untangle_graph_status",
  "untangle_graph_query",
  "untangle_graph_stats",
  "untangle_graph_cycles",
  "untangle_graph_visualize",
  "untangle_graph_remove",
  "untangle_symbols",
  "untangle_symbol",
  "untangle_flow",
  "untangle_impact",
  "untangle_cross_repo_impact",
  "untangle_complexity",
  "untangle_complexity_explain",
  "untangle_hotspots",
  "untangle_complexity_diff",
  "untangle_changes",
  "untangle_change_search",
  "untangle_quality_gate",
  "untangle_about",
  "untangle_portfolio_scan",
  "untangle_stack_matrix",
  "untangle_who_uses",
  "untangle_conventions",
  "untangle_archetypes",
  "untangle_tech_radar",
  "untangle_blueprint",
  "untangle_product",
  "untangle_boundaries",
] as const;

export type UntangleMcpToolName = (typeof UNTANGLE_MCP_TOOL_NAMES)[number];

export type { UntangleMcpInputByOperation, UntangleMcpOperationMap } from "./tools.js";
export type { UntangleMcpSuccessDataByOperation } from "./output-schemas.js";
