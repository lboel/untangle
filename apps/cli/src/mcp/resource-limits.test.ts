import {
  MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH,
  MAX_SEARCH_JOURNEY_LOCATOR_LENGTH,
  MAX_SEARCH_JOURNEY_REASON_LENGTH,
  MAX_SEARCH_JOURNEY_TEXT_LENGTH,
  MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH,
} from "@untangle-code/domain";
import { MAX_MAX_EDGES, MAX_MAX_NODES } from "@untangle-code/graph-explorer";
import { describe, expect, it, vi } from "vitest";

import type { ParsedArgs } from "../cli/args.js";
import { EXIT } from "../cli/exit.js";
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
import { graphCommand } from "../commands/graph/index.js";

import { DefaultUntangleMcpRuntime } from "./default-runtime.js";
import { UNTANGLE_MCP_TOOLS } from "./tools.js";

const CONTEXT = {
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

function definition(name: string) {
  const found = UNTANGLE_MCP_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing MCP tool ${name}`);
  return found;
}

function successData(envelope: Awaited<ReturnType<DefaultUntangleMcpRuntime["invoke"]>>) {
  expect(envelope.ok).toBe(true);
  if (!envelope.ok || typeof envelope.data !== "object" || envelope.data === null) {
    throw new Error("expected MCP success data");
  }
  return envelope.data as Record<string, unknown>;
}

describe("MCP graph/flow resource limits", () => {
  it("bounds every free-text and locator input of search journeys", () => {
    const schema = definition("untangle_search_session").inputSchema;

    expect(
      schema.safeParse({ action: "start", goal: "Find owner", featureId: "feature.cards" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        action: "start",
        goal: "g".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH),
        featureId: "f".repeat(MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        action: "start",
        goal: "Find owner",
        featureId: "f".repeat(MAX_SEARCH_JOURNEY_FEATURE_ID_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        action: "start",
        goal: "g".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        action: "complete",
        sessionId: "session",
        target: { filePath: "p".repeat(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH + 1) },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        action: "complete",
        sessionId: "session",
        target: { filePath: "p".repeat(MAX_SEARCH_JOURNEY_LOCATOR_LENGTH) },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        action: "observe",
        sessionId: "session",
        kind: "other-tool",
        toolName: "t".repeat(MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        action: "observe",
        sessionId: "session",
        kind: "other-tool",
        toolName: "t".repeat(MAX_SEARCH_JOURNEY_TOOL_NAME_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        action: "abandon",
        sessionId: "session",
        reason: "r".repeat(MAX_SEARCH_JOURNEY_REASON_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        action: "abandon",
        sessionId: "session",
        reason: "r".repeat(MAX_SEARCH_JOURNEY_REASON_LENGTH),
      }).success,
    ).toBe(true);

    const searchSchema = definition("untangle_search").inputSchema;
    expect(
      searchSchema.safeParse({ query: "q".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      searchSchema.safeParse({ query: "q".repeat(MAX_SEARCH_JOURNEY_TEXT_LENGTH) }).success,
    ).toBe(true);
  });

  it("requires a bounded file neighborhood for graph_query", () => {
    const schema = definition("untangle_graph_query").inputSchema;

    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({
        file: "src/index.ts",
        depth: MAX_GRAPH_QUERY_DEPTH + 1,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        file: "src/index.ts",
        maxNodes: MAX_GRAPH_QUERY_NODES + 1,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        file: "src/index.ts",
        depth: MAX_GRAPH_QUERY_DEPTH,
        maxNodes: MAX_GRAPH_QUERY_NODES,
        maxEdges: MAX_GRAPH_QUERY_EDGES,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ file: "src/index.ts", maxEdges: MAX_GRAPH_QUERY_EDGES + 1 }).success,
    ).toBe(false);
  });

  it.each(["untangle_flow", "untangle_impact"])("caps %s traversal and result inputs", (name) => {
    const schema = definition(name).inputSchema;
    const required = name === "untangle_flow" ? { from: "main" } : { symbol: "main" };

    for (const oversized of [
      { depth: MAX_FLOW_DEPTH + 1 },
      { limit: MAX_FLOW_RESULT_LIMIT + 1 },
      { maxNodes: MAX_FLOW_NODES + 1 },
      { maxEdges: MAX_FLOW_EDGES + 1 },
    ]) {
      expect(schema.safeParse({ ...required, ...oversized }).success).toBe(false);
    }
  });

  it("advertises the same hard explorer limits enforced by the graph command", () => {
    const schema = definition("untangle_graph_visualize").inputSchema;

    expect(
      schema.safeParse({ out: "graph.html", maxNodes: MAX_MAX_NODES, maxEdges: MAX_MAX_EDGES })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ out: "graph.html", maxNodes: MAX_MAX_NODES + 1 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ out: "graph.html", maxEdges: MAX_MAX_EDGES + 1 }).success).toBe(
      false,
    );
  });

  it("passes the direct-edge budget and preserves the command's pre-serialization bound", async () => {
    const command = vi.spyOn(graphCommand, "run").mockImplementation((ctx, args) => {
      expect(args.flags["max-nodes"]).toBe(1);
      expect(args.flags["max-edges"]).toBe(1);
      ctx.io.out(
        `${JSON.stringify({
          generationId: "generation",
          workspaceId: "workspace",
          node: { fileId: "root" },
          edges: [{ edgeId: "one" }],
          truncated: true,
          omittedCount: 2,
          issues: [],
        })}\n`,
      );
      return Promise.resolve(EXIT.ok);
    });
    const runtime = new DefaultUntangleMcpRuntime();

    const envelope = await runtime.invoke(
      "untangle_graph_query",
      { file: "src/index.ts", maxNodes: 1, maxEdges: 1 },
      CONTEXT,
    );
    const data = successData(envelope);

    expect(data["edges"]).toEqual([{ edgeId: "one" }]);
    expect(data["truncated"]).toBe(true);
    expect(data["omittedCount"]).toBe(2);
    expect(command).toHaveBeenCalledOnce();
  });

  it("rejects the graph overview through a direct runtime call", async () => {
    const command = vi.spyOn(graphCommand, "run");
    const runtime = new DefaultUntangleMcpRuntime();

    const envelope = await runtime.invoke("untangle_graph_query", {}, CONTEXT);

    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error("expected MCP failure");
    expect(envelope.error?.code).toBe("INVALID_ARGUMENT");
    expect(command).not.toHaveBeenCalled();
  });

  it("passes structural flow limits and clamps unvalidated direct calls", async () => {
    let captured: ParsedArgs | undefined;
    vi.spyOn(flowCommand, "run").mockImplementation((ctx, args) => {
      captured = args;
      ctx.io.out(`${JSON.stringify({ generationId: "generation" })}\n`);
      return Promise.resolve(EXIT.ok);
    });
    const runtime = new DefaultUntangleMcpRuntime();

    await runtime.invoke(
      "untangle_impact",
      {
        symbol: "main",
        depth: MAX_FLOW_DEPTH + 100,
        limit: MAX_FLOW_RESULT_LIMIT + 100,
        maxNodes: MAX_FLOW_NODES + 100,
        maxEdges: MAX_FLOW_EDGES + 100,
      },
      CONTEXT,
    );

    expect(captured?.flags).toMatchObject({
      depth: MAX_FLOW_DEPTH,
      limit: MAX_FLOW_RESULT_LIMIT,
      "max-nodes": MAX_FLOW_NODES,
      "max-edges": MAX_FLOW_EDGES,
      impact: true,
    });
  });
});
