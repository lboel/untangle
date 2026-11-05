import { DEFAULT_TRAVERSAL_LIMITS } from "@untangle-code/file-graph";

/** Public CLI/MCP resource ceilings for symbol-graph reads. */
export const DEFAULT_FLOW_DEPTH = 6;
export const MAX_FLOW_DEPTH = 64;
export const DEFAULT_FLOW_RESULT_LIMIT = 20;
export const MAX_FLOW_RESULT_LIMIT = 1_000;
export const MAX_FLOW_NODES = DEFAULT_TRAVERSAL_LIMITS.maxNodes;
export const MAX_FLOW_EDGES = DEFAULT_TRAVERSAL_LIMITS.maxEdges;

/** MCP graph queries deliberately expose the bounded neighborhood form only. */
export const MAX_GRAPH_QUERY_DEPTH = DEFAULT_TRAVERSAL_LIMITS.maxDepth;
export const MAX_GRAPH_QUERY_NODES = DEFAULT_TRAVERSAL_LIMITS.maxNodes;
export const MAX_GRAPH_QUERY_EDGES = DEFAULT_TRAVERSAL_LIMITS.maxEdges;
