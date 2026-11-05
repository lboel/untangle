import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DefaultUntangleMcpRuntime } from "./default-runtime.js";
import { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } from "./output-schemas.js";
import { UNTANGLE_MCP_TOOLS } from "./tools.js";

const executionContext = {
  agentModel: "model-a",
  harness: "local-harness",
  searchStrategy: "lexical-first",
  taskClass: "bug-location",
  taskMix: "lookup-regressions-v1",
  priorContext: "fresh-session",
};

describe("caller-declared journey conditions and outcome MCP contracts", () => {
  let root: string;
  const runtime = new DefaultUntangleMcpRuntime();
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-journey-context-mcp-")));
    writeFileSync(path.join(root, "main.ts"), "export const example = true;\n");
    writeFileSync(path.join(root, ".gitignore"), ".untangle/\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function invoke(input: Record<string, unknown>) {
    const result = await runtime.invoke(
      "untangle_search_session",
      { root, ...input },
      {
        cwd: root,
        env: {},
        signal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(true);
    return UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search_session.parse(result.data);
  }

  it("validates explicit bounded input and rejects missing or unknown conditions", () => {
    const schema = UNTANGLE_MCP_TOOLS.find(
      (tool) => tool.name === "untangle_search_session",
    )?.inputSchema;
    const start = { action: "start", goal: "Find lookup", executionContext };
    expect(schema?.safeParse(start).success).toBe(true);
    expect(
      schema?.safeParse({ ...start, executionContext: { agentModel: "model-a" } }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({
        ...start,
        executionContext: { ...executionContext, harness: "x".repeat(257) },
      }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({
        ...start,
        executionContext: { ...executionContext, inferredQuality: "good" },
      }).success,
    ).toBe(false);
  });

  it("redacts caller labels, separates context cohorts and retains abandoned denominators", async () => {
    const first = await invoke({
      action: "start",
      goal: "Find lookup",
      featureId: "lookup",
      executionContext,
    });
    if (first.action !== "start") throw new Error("Expected a started session.");
    expect(first.session.executionContext?.agentModel.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.session.executionContext?.agentModel.text).toBeUndefined();
    await invoke({
      action: "abandon",
      sessionId: first.session.sessionId,
      reasonCode: "target-not-found",
    });
    await invoke({
      action: "start",
      goal: "Find lookup",
      featureId: "lookup",
      executionContext: { ...executionContext, agentModel: "model-b" },
    });
    await invoke({ action: "start", goal: "Find legacy lookup" });
    const response = await invoke({ action: "report" });
    if (response.action !== "report") throw new Error("Expected a report.");
    expect(response.report.sessionCounts).toMatchObject({
      total: 3,
      completed: 0,
      abandoned: 1,
      active: 2,
    });
    expect(response.report.cohorts).toEqual([]);
    expect(response.report.outcomeCohorts).toHaveLength(3);
    const abandoned = response.report.outcomeCohorts?.find(
      (cohort) => cohort.sessionCounts.abandoned === 1,
    );
    expect(abandoned?.terminalCompletionRate).toBe(0);
    expect(abandoned?.abandonmentReasons).toEqual([{ reasonCode: "target-not-found", count: 1 }]);
    expect(abandoned?.statusEffort.find((effort) => effort.status === "abandoned")).toMatchObject({
      sessionCount: 1,
      totalSearches: 0,
      medianSearches: 0,
    });
    expect(
      response.report.outcomeCohorts?.some(
        (cohort) => cohort.executionContext.status === "not-recorded",
      ),
    ).toBe(true);
    const invalid = structuredClone(response);
    const invalidAbandoned = invalid.report.outcomeCohorts?.find(
      (cohort) => cohort.sessionCounts.abandoned === 1,
    );
    if (invalidAbandoned !== undefined) invalidAbandoned.terminalCompletionRate = 1;
    expect(
      UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search_session.safeParse(invalid).success,
    ).toBe(false);
    const falseContext = structuredClone(response);
    const legacy = falseContext.report.outcomeCohorts?.find(
      (cohort) => cohort.executionContext.status === "not-recorded",
    );
    if (legacy !== undefined) legacy.executionContext.uncontrolledDimensions = [];
    expect(
      UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search_session.safeParse(falseContext).success,
    ).toBe(false);
    const falseEffort = structuredClone(response);
    const emptyStatus = falseEffort.report.outcomeCohorts?.[0]?.statusEffort.find(
      (effort) => effort.sessionCount === 0,
    );
    if (emptyStatus !== undefined) {
      emptyStatus.totalSearches = 100;
      emptyStatus.totalNavigationEvents = 100;
      emptyStatus.totalObservedHops = 200;
    }
    expect(
      UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search_session.safeParse(falseEffort).success,
    ).toBe(false);
  });
});
