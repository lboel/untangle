import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical-json.js";
import { buildSymbolEdgeId } from "../identity.js";
import { SYMBOL_GRAPH_VERSION } from "../versions.js";

import type { SymbolEdgeV1 } from "./symbol-graph.js";
import { symbolEdgeResolutionFromCallConfidence, validateSymbolEdge } from "./symbol-graph.js";

const WORKSPACE = "11111111-1111-5111-9111-111111111111";
const REPO_A = "aaaaaaaa-aaaa-5aaa-9aaa-aaaaaaaaaaaa";
const REPO_B = "bbbbbbbb-bbbb-5bbb-9bbb-bbbbbbbbbbbb";

function exactEdge(): SymbolEdgeV1 {
  return {
    schemaVersion: 1,
    edgeId: buildSymbolEdgeId({
      workspaceId: WORKSPACE,
      fromSymbolId: "symbol-1",
      edgeKind: "calls",
      toName: "run",
      occurrenceOrdinal: 0,
    }),
    workspaceId: WORKSPACE,
    repoId: REPO_A,
    refId: `${REPO_A}:main`,
    fromSymbolId: "symbol-1",
    kind: "calls",
    toName: "run",
    resolution: "exact",
    target: {
      symbolId: "symbol-2",
      qualifiedName: "Service.run",
      repoId: REPO_A,
      refId: `${REPO_A}:main`,
      filePath: "src/service.ts",
    },
    confidence: { value: 1, basis: "deterministic", signals: ["unique_export", "import_resolved"] },
    crossRepo: false,
    sites: [
      {
        repoId: REPO_A,
        refId: `${REPO_A}:main`,
        filePath: "src/index.ts",
        range: { startLine: 12, endLine: 12, startByte: 300, endByte: 312 },
        column: 4,
      },
    ],
    occurrenceOrdinal: 0,
    graphGeneration: "gen-1",
    graphVersion: SYMBOL_GRAPH_VERSION,
  };
}

/** Kante ohne `target` — unter `exactOptionalPropertyTypes` muss das Feld fehlen, nicht `undefined` sein. */
function edgeWithoutTarget(): SymbolEdgeV1 {
  const { target: _target, ...rest } = exactEdge();
  return rest;
}

describe("SymbolEdgeV1 round-trip", () => {
  it("survives canonical JSON without loss and is key-order independent", () => {
    const edge = exactEdge();
    expect(JSON.parse(canonicalJson(edge))).toEqual(edge);
    const reordered = Object.fromEntries(Object.entries(edge).reverse()) as unknown as SymbolEdgeV1;
    expect(canonicalJson(reordered)).toBe(canonicalJson(edge));
  });
});

describe("buildSymbolEdgeId", () => {
  it("is stable and separates repeated calls of the same name", () => {
    const first = buildSymbolEdgeId({
      workspaceId: WORKSPACE,
      fromSymbolId: "symbol-1",
      edgeKind: "calls",
      toName: "run",
      occurrenceOrdinal: 0,
    });
    expect(first).toBe(
      buildSymbolEdgeId({
        workspaceId: WORKSPACE,
        fromSymbolId: "symbol-1",
        edgeKind: "calls",
        toName: "run",
        occurrenceOrdinal: 0,
      }),
    );
    expect(first).not.toBe(
      buildSymbolEdgeId({
        workspaceId: WORKSPACE,
        fromSymbolId: "symbol-1",
        edgeKind: "calls",
        toName: "run",
        occurrenceOrdinal: 1,
      }),
    );
  });

  it("distinguishes qualified from unqualified calls", () => {
    const bare = buildSymbolEdgeId({
      workspaceId: WORKSPACE,
      fromSymbolId: "symbol-1",
      edgeKind: "calls",
      toName: "run",
      occurrenceOrdinal: 0,
    });
    const qualified = buildSymbolEdgeId({
      workspaceId: WORKSPACE,
      fromSymbolId: "symbol-1",
      edgeKind: "calls",
      toName: "run",
      toQualifier: "service",
      occurrenceOrdinal: 0,
    });
    expect(bare).not.toBe(qualified);
  });
});

describe("symbolEdgeResolutionFromCallConfidence", () => {
  it("maps every CallEdgeV1 confidence level exactly once", () => {
    expect(symbolEdgeResolutionFromCallConfidence("local")).toBe("exact");
    expect(symbolEdgeResolutionFromCallConfidence("unique")).toBe("exact");
    expect(symbolEdgeResolutionFromCallConfidence("ambiguous")).toBe("ambiguous");
    expect(symbolEdgeResolutionFromCallConfidence("external")).toBe("heuristic");
    expect(symbolEdgeResolutionFromCallConfidence("unresolved")).toBe("unresolved");
  });
});

describe("validateSymbolEdge", () => {
  it("accepts a well-formed exact edge", () => {
    expect(validateSymbolEdge(exactEdge())).toEqual([]);
  });

  it("accepts an ambiguous edge with two weighted candidates", () => {
    const edge: SymbolEdgeV1 = {
      ...edgeWithoutTarget(),
      resolution: "ambiguous",
      candidates: [
        {
          symbolId: "symbol-2",
          qualifiedName: "A.run",
          repoId: REPO_A,
          refId: `${REPO_A}:main`,
          filePath: "src/a.ts",
          weight: 0.5,
        },
        {
          symbolId: "symbol-3",
          qualifiedName: "B.run",
          repoId: REPO_A,
          refId: `${REPO_A}:main`,
          filePath: "src/b.ts",
          weight: 0.5,
        },
      ],
      confidence: { value: 0.5, basis: "heuristic", signals: ["name_match"] },
    };
    expect(validateSymbolEdge(edge)).toEqual([]);
  });

  it("never lets an ambiguous edge claim certainty", () => {
    const edge: SymbolEdgeV1 = {
      ...edgeWithoutTarget(),
      resolution: "ambiguous",
      candidates: [
        {
          symbolId: "symbol-2",
          qualifiedName: "A.run",
          repoId: REPO_A,
          refId: `${REPO_A}:main`,
          filePath: "src/a.ts",
          weight: 0.5,
        },
        {
          symbolId: "symbol-3",
          qualifiedName: "B.run",
          repoId: REPO_A,
          refId: `${REPO_A}:main`,
          filePath: "src/b.ts",
          weight: 0.5,
        },
      ],
      confidence: { value: 1, basis: "deterministic", signals: ["name_match"] },
    };
    const kinds = validateSymbolEdge(edge).map((issue) => issue.kind);
    expect(kinds).toContain("overclaimed_confidence");
  });

  it("rejects an ambiguous edge with a single candidate", () => {
    const edge: SymbolEdgeV1 = {
      ...edgeWithoutTarget(),
      resolution: "ambiguous",
      candidates: [
        {
          symbolId: "symbol-2",
          qualifiedName: "A.run",
          repoId: REPO_A,
          refId: `${REPO_A}:main`,
          filePath: "src/a.ts",
          weight: 1,
        },
      ],
      confidence: { value: 0.9, basis: "heuristic", signals: ["name_match"] },
    };
    expect(validateSymbolEdge(edge).map((issue) => issue.kind)).toContain(
      "insufficient_candidates",
    );
  });

  it("rejects a heuristic edge that claims a deterministic basis", () => {
    const edge: SymbolEdgeV1 = {
      ...exactEdge(),
      resolution: "heuristic",
      confidence: { value: 0.6, basis: "deterministic", signals: ["name_match"] },
    };
    expect(validateSymbolEdge(edge).map((issue) => issue.kind)).toContain("overclaimed_confidence");
  });

  it("keeps the written name and demands a reason for an unresolved call", () => {
    const edge: SymbolEdgeV1 = {
      ...edgeWithoutTarget(),
      resolution: "unresolved",
      confidence: { value: 0, basis: "heuristic", signals: ["no_candidate"] },
    };
    expect(validateSymbolEdge(edge).map((issue) => issue.kind)).toContain("missing_reason");

    const documented: SymbolEdgeV1 = {
      ...edge,
      unresolvedReason: "target_outside_index",
      unresolvedDetail: "callee lives in a package that is not part of the workspace",
    };
    expect(validateSymbolEdge(documented)).toEqual([]);
    expect(documented.toName).toBe("run");
    expect(documented.kind).toBe("calls");
  });

  it("rejects an unresolved edge that still names a target", () => {
    const edge: SymbolEdgeV1 = {
      ...exactEdge(),
      resolution: "unresolved",
      unresolvedReason: "no_candidate_found",
      unresolvedDetail: "none",
      confidence: { value: 0, basis: "heuristic", signals: ["none"] },
    };
    expect(validateSymbolEdge(edge).map((issue) => issue.kind)).toContain("unexpected_target");
  });

  it('rejects kind "unresolved" with a successful resolution', () => {
    const edge: SymbolEdgeV1 = { ...exactEdge(), kind: "unresolved" };
    expect(validateSymbolEdge(edge).map((issue) => issue.kind)).toContain(
      "kind_resolution_mismatch",
    );
  });

  it("rejects confidence without signals or outside [0, 1]", () => {
    const noSignals: SymbolEdgeV1 = {
      ...exactEdge(),
      confidence: { value: 1, basis: "deterministic", signals: [] },
    };
    expect(validateSymbolEdge(noSignals).map((issue) => issue.kind)).toContain("missing_signals");

    const outOfRange: SymbolEdgeV1 = {
      ...exactEdge(),
      confidence: { value: 1.5, basis: "deterministic", signals: ["x"] },
    };
    expect(validateSymbolEdge(outOfRange).map((issue) => issue.kind)).toContain(
      "confidence_out_of_range",
    );
  });

  it("rejects a crossRepo flag that contradicts the target", () => {
    const edge: SymbolEdgeV1 = {
      ...exactEdge(),
      target: {
        symbolId: "symbol-9",
        qualifiedName: "Other.run",
        repoId: REPO_B,
        refId: `${REPO_B}:main`,
        filePath: "src/other.ts",
      },
      crossRepo: false,
    };
    expect(validateSymbolEdge(edge).map((issue) => issue.kind)).toContain("cross_repo_mismatch");
  });

  it("demands a reason when the parser delivered no call sites", () => {
    const edge: SymbolEdgeV1 = { ...exactEdge(), sites: [] };
    expect(validateSymbolEdge(edge).map((issue) => issue.kind)).toContain("missing_sites");
  });
});
