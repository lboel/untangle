import type { ScoreBreakdownV1, ScoreComponentV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import type { FusionResult } from "./fusion.js";
import type { ScoringContext } from "./scoring.js";
import { assembleScoreBreakdown } from "./scoring.js";
import { candidateFixture } from "./testing/candidates.js";

function fusion(normalized = 1): FusionResult {
  return {
    id: "chunk-1",
    rrf: 0.03125,
    normalized,
    ranks: { dense: 1, lexical: 2 },
    weights: { dense: 1, lexical: 0.5 },
  };
}

function context(queryText: string): ScoringContext {
  return {
    queryText,
    weights: {
      exactSymbol: 0.125,
      exactPath: 0.25,
      repoPriority: 0.125,
      graphProximity: 0.125,
      recency: 0.125,
      duplicatePenalty: 0.5,
    },
    complexityBias: "none",
    repoPriorities: {},
    graphProximity: new Map(),
    recencyHalfLifeDays: 30,
  };
}

function expectedScore(
  final: number,
  components: ScoreComponentV1[] = [],
  base = 1,
): ScoreBreakdownV1 {
  return {
    schemaVersion: 1,
    final,
    components: [
      {
        kind: "base_hybrid",
        rawValue: base,
        weight: 1,
        contribution: base,
        evidence: "RRF over dense#1 x weight 1, lexical#2 x weight 0.5",
      },
      ...components,
    ],
    inputs: { rrf: 0.03125 },
    rankerVersion: "untangle-ranker-v2",
    clamped: false,
  };
}

interface PathCase {
  name: string;
  path: string;
  query: string;
  final: number;
  raw?: number;
  contribution?: number;
  evidence?: string;
}

const cases: PathCase[] = [
  {
    name: "full path before basename",
    path: "charge.ts",
    query: "charge.ts",
    final: 1.25,
    raw: 1,
    contribution: 0.25,
    evidence: 'file_path == "charge.ts"',
  },
  {
    name: "full nested path before substring",
    path: "src/charge.ts",
    query: "src/charge.ts",
    final: 1.25,
    raw: 1,
    contribution: 0.25,
    evidence: 'file_path == "src/charge.ts"',
  },
  {
    name: "basename segment",
    path: "src/charge.ts",
    query: "charge.ts",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "charge.ts"',
  },
  {
    name: "directory segment",
    path: "src/charge/index.ts",
    query: "charge",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "charge"',
  },
  {
    name: "substring of basename",
    path: "src/billing/charge.ts",
    query: "charge",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "charge"',
  },
  {
    name: "substring of root basename",
    path: "charge.ts",
    query: "charge",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "charge"',
  },
  {
    name: "trimmed full path",
    path: "src/charge.ts",
    query: " \tsrc/charge.ts\n ",
    final: 1.25,
    raw: 1,
    contribution: 0.25,
    evidence: 'file_path == "src/charge.ts"',
  },
  {
    name: "trimmed basename",
    path: "src/charge.ts",
    query: " charge.ts ",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "charge.ts"',
  },
  { name: "empty query", path: "src/charge.ts", query: "", final: 1 },
  { name: "whitespace query", path: "src/charge.ts", query: " \t\n ", final: 1 },
  { name: "empty path", path: "", query: "charge", final: 1 },
  { name: "empty path and query", path: "", query: "", final: 1 },
  {
    name: "path whitespace is literal",
    path: " charge ",
    query: "charge",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "charge"',
  },
  {
    name: "repeated separators",
    path: "src//billing///charge.ts",
    query: "billing",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "billing"',
  },
  {
    name: "trailing separator",
    path: "src/charge/",
    query: "charge",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "charge"',
  },
  {
    name: "leading separator full path",
    path: "/src/charge.ts",
    query: "/src/charge.ts",
    final: 1.25,
    raw: 1,
    contribution: 0.25,
    evidence: 'file_path == "/src/charge.ts"',
  },
  {
    name: "slash is a substring",
    path: "///",
    query: "/",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "/"',
  },
  {
    name: "backslash is literal",
    path: "src\\charge.ts",
    query: "charge.ts",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "charge.ts"',
  },
  {
    name: "unicode directory segment",
    path: "src/über/🧶.ts",
    query: "über",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "über"',
  },
  {
    name: "unicode basename",
    path: "src/über/🧶.ts",
    query: "🧶.ts",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "🧶.ts"',
  },
  { name: "unicode is not normalized", path: "src/über/🧶.ts", query: "u\u0308ber", final: 1 },
  { name: "matching is case sensitive", path: "src/Charge.ts", query: "charge.ts", final: 1 },
  {
    name: "regex-looking basename is literal",
    path: "src/[a+b].ts",
    query: "[a+b].ts",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "[a+b].ts"',
  },
  {
    name: "regex-looking substring is literal",
    path: "src/[a+b].ts",
    query: "[a+b]",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "[a+b]"',
  },
  { name: "regex wildcard does not match", path: "src/charge.ts", query: ".*", final: 1 },
  {
    name: "duplicate segments",
    path: "src/charge.ts/charge.ts",
    query: "charge.ts",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "charge.ts"',
  },
  {
    name: "non-basename filename segment",
    path: "src/charge.ts/else.ts",
    query: "charge.ts",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "charge.ts"',
  },
  { name: "space-only path does not bypass blank guard", path: " ", query: " ", final: 1 },
  {
    name: "internal basename spaces",
    path: "src/with space.ts",
    query: "with space.ts",
    final: 1.1875,
    raw: 0.75,
    contribution: 0.1875,
    evidence: 'path segment == "with space.ts"',
  },
  {
    name: "multi-segment substring",
    path: "xsrc/charge.tsx",
    query: "src/charge.ts",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "src/charge.ts"',
  },
  {
    name: "full-width slash is literal",
    path: "src／charge.ts",
    query: "charge.ts",
    final: 1.125,
    raw: 0.5,
    contribution: 0.125,
    evidence: 'file_path contains "charge.ts"',
  },
];

describe("path boost score characterization", () => {
  it.each(cases)("preserves the complete score for $name", (testCase) => {
    const components: ScoreComponentV1[] =
      testCase.raw === undefined
        ? []
        : [
            {
              kind: "exact_path_boost",
              rawValue: testCase.raw,
              weight: 0.25,
              contribution: testCase.contribution as number,
              evidence: testCase.evidence as string,
            },
          ];
    expect(
      assembleScoreBreakdown(
        candidateFixture({ file_path: testCase.path }),
        fusion(),
        context(testCase.query),
      ),
    ).toEqual(expectedScore(testCase.final, components));
  });

  it("keeps the exact symbol component before the basename path component", () => {
    expect(
      assembleScoreBreakdown(
        candidateFixture({ file_path: "src/charge.ts", symbol_name: "charge.ts" }),
        fusion(),
        context("charge.ts"),
      ),
    ).toEqual(
      expectedScore(1.3125, [
        {
          kind: "exact_symbol_boost",
          rawValue: 1,
          weight: 0.125,
          contribution: 0.125,
          evidence: 'symbol_name == "charge.ts"',
        },
        {
          kind: "exact_path_boost",
          rawValue: 0.75,
          weight: 0.25,
          contribution: 0.1875,
          evidence: 'path segment == "charge.ts"',
        },
      ]),
    );
  });

  const invalidPrimitivePaths = [
    { name: "undefined", value: undefined },
    { name: "null", value: null },
    { name: "number", value: 42 },
    { name: "boolean", value: true },
    { name: "symbol", value: Symbol("path") },
  ];

  it.each(invalidPrimitivePaths)(
    "preserves a TypeError for a nonblank query and $name path",
    ({ value }) => {
      expect(() =>
        assembleScoreBreakdown(
          candidateFixture({ file_path: value as unknown as string }),
          fusion(),
          context("charge.ts"),
        ),
      ).toThrow(TypeError);
    },
  );

  it.each(invalidPrimitivePaths)("does not touch the $name path for a blank query", ({ value }) => {
    expect(
      assembleScoreBreakdown(
        candidateFixture({ file_path: value as unknown as string }),
        fusion(),
        context(" \t\n "),
      ),
    ).toEqual(expectedScore(1));
  });

  it("retains a negative duplicate penalty beside the path boost", () => {
    expect(
      assembleScoreBreakdown(
        candidateFixture({ file_path: "src/charge.ts" }),
        fusion(),
        context("charge.ts"),
        0.5,
      ),
    ).toEqual(
      expectedScore(0.9375, [
        {
          kind: "exact_path_boost",
          rawValue: 0.75,
          weight: 0.25,
          contribution: 0.1875,
          evidence: 'path segment == "charge.ts"',
        },
        {
          kind: "duplicate_penalty",
          rawValue: 0.5,
          weight: -0.5,
          contribution: -0.25,
          evidence: 'file "src/charge.ts" is already represented higher in the ranking',
        },
      ]),
    );
  });

  it("retains complete clamping evidence and uniformly scaled positive and negative weights", () => {
    expect(
      assembleScoreBreakdown(
        candidateFixture({ file_path: "src/charge.ts" }),
        fusion(0.25),
        context("src/charge.ts"),
        0.5,
      ),
    ).toEqual({
      ...expectedScore(
        0.25,
        [
          {
            kind: "exact_path_boost",
            rawValue: 1,
            weight: 0.0625,
            contribution: 0.0625,
            evidence: 'file_path == "src/charge.ts"',
          },
          {
            kind: "duplicate_penalty",
            rawValue: 0.5,
            weight: -0.125,
            contribution: -0.0625,
            evidence: 'file "src/charge.ts" is already represented higher in the ranking',
          },
        ],
        0.25,
      ),
      clamped: true,
      clampReason:
        "boost magnitude 0.500000 exceeded 0.5 of the base score 0.250000; all non-base weights scaled by 0.250000 (spec.md §13.3)",
    });
  });

  it("retains the complete independent retrieval inputs", () => {
    const candidate = candidateFixture(
      { file_path: "src/charge.ts" },
      { denseScore: 0.75, denseRank: 1, lexicalScore: 3, lexicalRank: 2, symbolRank: 4 },
    );
    expect(assembleScoreBreakdown(candidate, fusion(), context("charge.ts"))).toEqual({
      ...expectedScore(1.1875, [
        {
          kind: "exact_path_boost",
          rawValue: 0.75,
          weight: 0.25,
          contribution: 0.1875,
          evidence: 'path segment == "charge.ts"',
        },
      ]),
      inputs: {
        dense: 0.75,
        denseRank: 1,
        sparseRank: 2,
        lexicalRank: 2,
        lexicalScore: 3,
        symbolRank: 4,
        rrf: 0.03125,
      },
    });
  });

  it("does not mutate frozen candidates, fusion data, weights or lookups", () => {
    const candidate = candidateFixture({ file_path: "src/charge.ts" });
    const ranking = fusion();
    const scoring = context("charge.ts");
    const before = structuredClone({ candidate, ranking, scoring });
    Object.freeze(candidate.payload);
    Object.freeze(candidate.raw);
    Object.freeze(candidate.substitutedFields);
    Object.freeze(candidate);
    Object.freeze(ranking.ranks);
    Object.freeze(ranking.weights);
    Object.freeze(ranking);
    Object.freeze(scoring.weights);
    Object.freeze(scoring.repoPriorities);
    Object.freeze(scoring.graphProximity);
    Object.freeze(scoring);
    expect(assembleScoreBreakdown(candidate, ranking, scoring)).toEqual(
      expectedScore(1.1875, [
        {
          kind: "exact_path_boost",
          rawValue: 0.75,
          weight: 0.25,
          contribution: 0.1875,
          evidence: 'path segment == "charge.ts"',
        },
      ]),
    );
    expect({ candidate, ranking, scoring }).toEqual(before);
  });

  it("reads the query before the path and reads the path exactly once", () => {
    const calls: string[] = [];
    const candidate = candidateFixture({ file_path: "src/charge.ts" });
    const scoring = context("charge.ts");
    Object.defineProperty(scoring, "queryText", {
      get: () => {
        calls.push("query");
        return "charge.ts";
      },
    });
    Object.defineProperty(candidate.payload, "file_path", {
      get: () => {
        calls.push("path");
        return "src/charge.ts";
      },
    });
    expect(assembleScoreBreakdown(candidate, fusion(), scoring)).toEqual(
      expectedScore(1.1875, [
        {
          kind: "exact_path_boost",
          rawValue: 0.75,
          weight: 0.25,
          contribution: 0.1875,
          evidence: 'path segment == "charge.ts"',
        },
      ]),
    );
    expect(calls).toEqual(["query", "query", "path"]);
  });

  it("does not read a path when the trimmed query is blank", () => {
    const candidate = candidateFixture();
    Object.defineProperty(candidate.payload, "file_path", {
      get: () => {
        throw new Error("unexpected path read");
      },
    });
    expect(assembleScoreBreakdown(candidate, fusion(), context(" \t\n "))).toEqual(
      expectedScore(1),
    );
  });

  it("propagates the original query accessor error before reading the path", () => {
    const calls: string[] = [];
    const sentinel = new Error("query unavailable");
    const candidate = candidateFixture();
    const scoring = context("charge.ts");
    Object.defineProperty(scoring, "queryText", {
      get: () => {
        calls.push("query");
        throw sentinel;
      },
    });
    Object.defineProperty(candidate.payload, "file_path", {
      get: () => {
        calls.push("path");
        return "src/charge.ts";
      },
    });
    let thrown: unknown;
    try {
      assembleScoreBreakdown(candidate, fusion(), scoring);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    expect(calls).toEqual(["query"]);
  });

  it("propagates the original path accessor error after the two query reads", () => {
    const calls: string[] = [];
    const sentinel = new Error("path unavailable");
    const candidate = candidateFixture();
    const scoring = context("charge.ts");
    Object.defineProperty(scoring, "queryText", {
      get: () => {
        calls.push("query");
        return "charge.ts";
      },
    });
    Object.defineProperty(candidate.payload, "file_path", {
      get: () => {
        calls.push("path");
        throw sentinel;
      },
    });
    let thrown: unknown;
    try {
      assembleScoreBreakdown(candidate, fusion(), scoring);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    expect(calls).toEqual(["query", "query", "path"]);
  });
});
