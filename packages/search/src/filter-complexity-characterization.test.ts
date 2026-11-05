import type { SearchFiltersV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildPayloadFilter } from "./filter.js";

type Complexity = NonNullable<SearchFiltersV1["complexity"]>;
const SCOPE = { workspaceId: "ws-1" };
const BASE_MUST = [
  { field: "point_type", match: { eq: "code_chunk" } },
  { field: "workspace_id", match: { eq: "ws-1" } },
];
const BOUNDS = [
  ["cyclomaticMin", "cyclomatic_extended", "gte", 2],
  ["cyclomaticMax", "cyclomatic_extended", "lte", 12],
  ["cognitiveMin", "cognitive", "gte", 3],
  ["cognitiveMax", "cognitive", "lte", 13],
  ["riskMin", "risk_score", "gte", 0.1],
  ["riskMax", "risk_score", "lte", 0.8],
] as const;

function filters(overrides: Partial<SearchFiltersV1> = {}): SearchFiltersV1 {
  return {
    repoIds: [],
    refIds: [],
    languages: [],
    pathGlobs: [],
    symbolNames: [],
    symbolKinds: [],
    chunkKinds: [],
    ...overrides,
  };
}

function observedFilters(complexity: unknown, trace: string[]): SearchFiltersV1 {
  const input = filters();
  Object.defineProperties(input, {
    complexity: {
      get() {
        trace.push("complexity");
        return complexity;
      },
    },
    changed: {
      get() {
        trace.push("changed");
        return undefined;
      },
    },
    pathGlobs: {
      get() {
        trace.push("pathGlobs");
        return [];
      },
    },
    findability: {
      get() {
        trace.push("findability");
        return undefined;
      },
    },
  });
  return input;
}

describe("payload complexity condition characterization", () => {
  it("keeps absent, explicitly undefined and empty complexity output identical", () => {
    const absent = filters();
    const explicit = filters();
    Object.defineProperty(explicit, "complexity", { value: undefined });
    const expected = {
      filter: { must: BASE_MUST },
      residual: [],
      scopeRepoIds: [],
      outOfScopeRepoIds: [],
    };
    expect(Object.hasOwn(absent, "complexity")).toBe(false);
    expect(Object.hasOwn(explicit, "complexity")).toBe(true);
    expect(buildPayloadFilter(absent, SCOPE)).toEqual(expected);
    expect(buildPayloadFilter(explicit, SCOPE)).toEqual(expected);
    expect(buildPayloadFilter(filters({ complexity: {} }), SCOPE)).toEqual(expected);
  });

  it.each(BOUNDS)("maps only %s to its own inclusive bound", (key, field, direction, value) => {
    expect(buildPayloadFilter(filters({ complexity: { [key]: value } }), SCOPE)).toEqual({
      filter: { must: [...BASE_MUST, { field, range: { [direction]: value } }] },
      residual: [],
      scopeRepoIds: [],
      outOfScopeRepoIds: [],
    });
  });

  it("omits every explicitly undefined range bound", () => {
    const complexity: Complexity = {};
    for (const [key] of BOUNDS)
      Object.defineProperty(complexity, key, { value: undefined, enumerable: true });
    expect(Object.keys(complexity)).toEqual(BOUNDS.map(([key]) => key));
    expect(buildPayloadFilter(filters({ complexity }), SCOPE)).toEqual({
      filter: { must: BASE_MUST },
      residual: [],
      scopeRepoIds: [],
      outOfScopeRepoIds: [],
    });
  });

  it.each([0, -0])("keeps all six zero bounds and their signs for %s", (value) => {
    const complexity: Complexity = {
      cyclomaticMin: value,
      cyclomaticMax: value,
      cognitiveMin: value,
      cognitiveMax: value,
      riskMin: value,
      riskMax: value,
    };
    const result = buildPayloadFilter(filters({ complexity }), SCOPE);
    expect(result.filter.must).toEqual([
      ...BASE_MUST,
      ...["cyclomatic_extended", "cognitive", "risk_score"].map((field) => ({
        field,
        range: { gte: value, lte: value },
      })),
    ]);
    for (const condition of result.filter.must?.slice(2) ?? []) {
      expect(
        Object.is((condition as { range?: { gte?: number; lte?: number } }).range?.gte, value),
      ).toBe(true);
      expect(
        Object.is((condition as { range?: { gte?: number; lte?: number } }).range?.lte, value),
      ).toBe(true);
    }
  });

  it("preserves the complete condition and residual order with deeply frozen inputs", () => {
    const input = filters({
      repoIds: ["repo-b", "missing", "repo-a"],
      refIds: ["ref-z", "ref-a"],
      languages: ["typescript"],
      symbolNames: ["B", "a"],
      symbolKinds: ["function"],
      chunkKinds: ["function", "class"],
      commitSha: "abc123",
      complexity: {
        cyclomaticMin: 2,
        cyclomaticMax: 12,
        cognitiveMin: 3,
        cognitiveMax: 13,
        riskMin: 0.1,
        riskMax: 0.8,
      },
      changed: { since: "1970-01-01T00:00:00.000Z", until: "1970-01-02T00:00:00.000Z" },
      pathGlobs: ["src/**"],
      findability: { maxScore: 0.3 },
    });
    for (const list of [
      input.repoIds,
      input.refIds,
      input.languages,
      input.symbolNames,
      input.symbolKinds,
      input.chunkKinds,
      input.pathGlobs,
    ])
      Object.freeze(list);
    Object.freeze(input.complexity);
    Object.freeze(input.changed);
    Object.freeze(input.findability);
    Object.freeze(input);
    const scope = Object.freeze({
      workspaceId: " ws-1 ",
      targetRepoIds: Object.freeze(["repo-c", "repo-b", "repo-a"]),
    });
    const before = JSON.stringify({ input, scope });
    const first = buildPayloadFilter(input, scope);
    expect(first).toEqual({
      filter: {
        must: [
          ...BASE_MUST,
          { field: "repo_id", match: { in: ["repo-a", "repo-b"] } },
          { field: "ref_id", match: { in: ["ref-z", "ref-a"] } },
          { field: "language", match: { eq: "typescript" } },
          { field: "symbol_name", match: { in: ["B", "a"] } },
          { field: "symbol_kind", match: { eq: "function" } },
          { field: "chunk_kind", match: { in: ["function", "class"] } },
          { field: "commit_sha", match: { eq: "abc123" } },
          { field: "cyclomatic_extended", range: { gte: 2, lte: 12 } },
          { field: "cognitive", range: { gte: 3, lte: 13 } },
          { field: "risk_score", range: { gte: 0.1, lte: 0.8 } },
          { field: "changed_at_epoch_ms", range: { gte: 0, lt: 86400000 } },
        ],
      },
      residual: [
        {
          name: "pathGlobs",
          reason:
            "the vector store's payload filter matches exact values and ranges only, not glob patterns",
        },
        {
          name: "findability",
          reason: "findability is derived per symbol and is not part of the stored chunk payload",
        },
      ],
      scopeRepoIds: ["repo-a", "repo-b"],
      outOfScopeRepoIds: ["missing"],
    });
    const second = buildPayloadFilter(input, scope);
    expect(second).toEqual(first);
    expect(second.filter.must).not.toBe(first.filter.must);
    expect(second.filter.must?.[9]).not.toBe(first.filter.must?.[9]);
    expect(JSON.stringify({ input, scope })).toBe(before);
  });
});

describe("payload complexity evaluation and failure order", () => {
  it("reads complexity once and all six proxy fields before changed and residual filters", () => {
    const trace: string[] = [];
    const target: Complexity = {
      cyclomaticMin: 2,
      cyclomaticMax: 12,
      cognitiveMin: 3,
      cognitiveMax: 13,
      riskMin: 0.1,
      riskMax: 0.8,
    };
    const complexity = new Proxy(target, {
      get(object, key, receiver) {
        trace.push(`complexity.${String(key)}`);
        return Reflect.get(object, key, receiver);
      },
    });
    const result = buildPayloadFilter(observedFilters(complexity, trace), SCOPE);
    expect(trace).toEqual([
      "complexity",
      ...BOUNDS.map(([key]) => `complexity.${key}`),
      "changed",
      "pathGlobs",
      "findability",
    ]);
    expect(result.filter.must?.slice(2)).toEqual([
      { field: "cyclomatic_extended", range: { gte: 2, lte: 12 } },
      { field: "cognitive", range: { gte: 3, lte: 13 } },
      { field: "risk_score", range: { gte: 0.1, lte: 0.8 } },
    ]);
  });

  it.each(BOUNDS)(
    "propagates the exact %s getter error before later fields, dates or residuals",
    (sentinel) => {
      const trace: string[] = [];
      const failure = new Error(`cannot read ${sentinel}`);
      const complexity = new Proxy({} as Complexity, {
        get(_object, key) {
          trace.push(`complexity.${String(key)}`);
          if (key === sentinel) throw failure;
          return undefined;
        },
      });
      const input = observedFilters(complexity, trace);
      let caught: unknown;
      try {
        buildPayloadFilter(input, SCOPE);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(trace).toEqual([
        "complexity",
        ...BOUNDS.slice(0, BOUNDS.findIndex(([key]) => key === sentinel) + 1).map(
          ([key]) => `complexity.${key}`,
        ),
      ]);
    },
  );

  it("preserves the null-complexity TypeError before changed or residual getters", () => {
    const trace: string[] = [];
    let caught: unknown;
    try {
      buildPayloadFilter(observedFilters(null, trace), SCOPE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(
      "Cannot read properties of null (reading 'cyclomaticMin')",
    );
    expect(trace).toEqual(["complexity"]);
  });

  it("returns the exact empty-scope result before touching complexity, dates or residuals", () => {
    const trace: string[] = [];
    const complexity = new Proxy(
      {},
      {
        get() {
          throw new Error("complexity must remain unvisited");
        },
      },
    );
    const input = observedFilters(complexity, trace);
    input.repoIds = ["outside"];
    expect(buildPayloadFilter(input, { workspaceId: "ws-1", targetRepoIds: ["inside"] })).toEqual({
      filter: { must: BASE_MUST },
      residual: [],
      scopeRepoIds: [],
      outOfScopeRepoIds: ["outside"],
      emptyScopeReason:
        "the requested repositories [outside] are not part of this target's repositories [inside]; this target was not searched",
    });
    expect(trace).toEqual([]);
  });

  it.each(["", " \n\t"])(
    "rejects empty workspace %j before reading complexity or later filters",
    (workspaceId) => {
      const trace: string[] = [];
      expect(() => buildPayloadFilter(observedFilters(null, trace), { workspaceId })).toThrow(
        "buildPayloadFilter requires a non-empty workspaceId: without it the store filter would span every workspace in the collection",
      );
      expect(trace).toEqual([]);
    },
  );

  it("rejects a null workspace before reading complexity or later filters", () => {
    const trace: string[] = [];
    const scope = { workspaceId: "ws-1" };
    Object.defineProperty(scope, "workspaceId", { value: null });
    expect(() => buildPayloadFilter(observedFilters(null, trace), scope)).toThrow(TypeError);
    expect(trace).toEqual([]);
  });
});
