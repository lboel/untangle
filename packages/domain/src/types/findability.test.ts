import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical-json.js";
import { buildFindabilityId } from "../identity.js";
import { FINDABILITY_ALGORITHM_ID, RANKER_VERSION } from "../versions.js";

import type { FindabilityDiagnosisV1, FindabilityProbeV1, FindabilityV1 } from "./findability.js";
import {
  FINDABILITY_CODE_EVIDENCE_REASONS,
  FINDABILITY_RANK_MISSING_REASONS,
  FINDABILITY_REASON_CLASSIFICATION_IS_TOTAL,
  FINDABILITY_RETRIEVAL_FAILURE_REASONS,
  assertFindabilityMeasured,
  isFindabilityMeasured,
  isFindabilityUnavailable,
  isRetrievalFailureReason,
  makeFindabilityUnavailable,
  openFindabilityDiagnosisBasis,
  toFindabilitySummary,
  validateFindability,
} from "./findability.js";

const WORKSPACE = "workspace-1";
const REPO = "repo-1";

function record(overrides: Partial<FindabilityV1> = {}): FindabilityV1 {
  return {
    schemaVersion: 1,
    findabilityId: buildFindabilityId({
      workspaceId: WORKSPACE,
      symbolId: "symbol-1",
      algorithm: FINDABILITY_ALGORITHM_ID,
      rankerVersion: RANKER_VERSION,
    }),
    workspaceId: WORKSPACE,
    repoId: REPO,
    refId: `${REPO}:main`,
    symbolId: "symbol-1",
    symbolFqn: "ImportResolver.resolve",
    filePath: "src/resolve.ts",
    algorithm: FINDABILITY_ALGORITHM_ID,
    rankerVersion: RANKER_VERSION,
    score: 0.42,
    isHeuristic: true,
    nameProbe: {
      kind: "self-name",
      queryText: "resolve",
      queryFingerprint: "a".repeat(64),
      rank: 7,
      hitCount: 20,
      topScore: 0.9,
      selfScore: 0.31,
    },
    signatureProbe: {
      kind: "self-signature",
      queryText: "resolve(raw, context)",
      queryFingerprint: "b".repeat(64),
      rank: null,
      rankMissingReason: "outside_result_limit",
      hitCount: 20,
    },
    dispersion: {
      matchedFileCount: 9,
      matchedHitCount: 20,
      ownFileHitCount: 2,
      dispersion: 0.8,
    },
    dispersionFormula: "(matchedFileCount - 1) / max(matchedHitCount - 1, 1)",
    hops: { hops: 2, path: ["symbol-4", "symbol-3", "symbol-1"], pathUsesUncertainEdges: false },
    confidence: { value: 0.7, basis: "heuristic", signals: ["rank", "dispersion"] },
    diagnoses: [
      {
        cause: "scattered-responsibility",
        confidence: { value: 0.7, basis: "heuristic", signals: ["dispersion"] },
        evidence: [
          {
            kind: "matched_file_count",
            observedValue: 9,
            threshold: 4,
            references: ["src/a.ts", "src/b.ts"],
          },
        ],
        isHeuristic: true,
      },
    ],
    measuredAt: "2026-09-05T00:00:00.000Z",
    generationId: "gen-1",
    ...overrides,
  };
}

describe("FindabilityV1", () => {
  it("survives canonical JSON without loss", () => {
    const value = record();
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  it("is structurally a heuristic — isHeuristic cannot be false", () => {
    const value = record();
    expect(value.isHeuristic).toBe(true);
    // @ts-expect-error Findability ist eine Heuristik; `false` ist nicht typisierbar.
    value.isHeuristic = false;
    // @ts-expect-error Eine Findability-Confidence kann nie deterministisch sein.
    value.confidence.basis = "deterministic";
  });

  it("accepts a well-formed record", () => {
    expect(validateFindability(record())).toEqual([]);
  });

  it('treats "no hit" as a finding, not as a missing value', () => {
    const missingReason = record({
      signatureProbe: {
        kind: "self-signature",
        queryText: "resolve(raw, context)",
        queryFingerprint: "b".repeat(64),
        rank: null,
        hitCount: 0,
      },
    });
    expect(validateFindability(missingReason).map((issue) => issue.kind)).toContain(
      "rank_without_reason",
    );

    const documented = record({
      signatureProbe: {
        kind: "self-signature",
        queryText: "resolve(raw, context)",
        queryFingerprint: "b".repeat(64),
        rank: null,
        rankMissingReason: "no_match",
        hitCount: 0,
      },
    });
    expect(validateFindability(documented)).toEqual([]);
  });

  it("rejects a rank that also carries a missing-rank reason", () => {
    const value = record({
      nameProbe: {
        kind: "self-name",
        queryText: "resolve",
        queryFingerprint: "a".repeat(64),
        rank: 3,
        rankMissingReason: "no_match",
        hitCount: 5,
      },
    });
    expect(validateFindability(value).map((issue) => issue.kind)).toContain("reason_without_rank");
  });

  it("rejects out-of-range scores, dispersion and confidence", () => {
    expect(validateFindability(record({ score: 1.4 })).map((issue) => issue.kind)).toContain(
      "score_out_of_range",
    );
    expect(
      validateFindability(
        record({
          dispersion: {
            matchedFileCount: 1,
            matchedHitCount: 1,
            ownFileHitCount: 1,
            dispersion: 2,
          },
        }),
      ).map((issue) => issue.kind),
    ).toContain("dispersion_out_of_range");
    expect(
      validateFindability(
        record({ confidence: { value: -0.1, basis: "heuristic", signals: ["x"] } }),
      ).map((issue) => issue.kind),
    ).toContain("confidence_out_of_range");
  });

  it("rejects a missing hop count without a reason", () => {
    const value = record({ hops: { hops: null, path: [], pathUsesUncertainEdges: false } });
    expect(validateFindability(value).map((issue) => issue.kind)).toContain("hops_without_reason");
  });

  it("rejects a diagnosis without evidence (WP-121)", () => {
    const diagnosis: FindabilityDiagnosisV1 = {
      cause: "weak-naming",
      confidence: { value: 0.5, basis: "heuristic", signals: ["rank"] },
      evidence: [],
      isHeuristic: true,
    };
    expect(
      validateFindability(record({ diagnoses: [diagnosis] })).map((issue) => issue.kind),
    ).toContain("diagnosis_without_evidence");
  });
});

describe("toFindabilitySummary", () => {
  it("names the cause with the highest confidence", () => {
    const value = record({
      diagnoses: [
        {
          cause: "weak-naming",
          confidence: { value: 0.4, basis: "heuristic", signals: ["rank"] },
          evidence: [{ kind: "self_rank", observedValue: 7, references: [] }],
          isHeuristic: true,
        },
        {
          cause: "high-entanglement",
          confidence: { value: 0.8, basis: "heuristic", signals: ["hops"] },
          evidence: [{ kind: "hop_count", observedValue: 4, references: [] }],
          isHeuristic: true,
        },
      ],
    });
    const summary = toFindabilitySummary(value);
    expect(summary.primaryCause).toBe("high-entanglement");
    expect(summary.primaryCauseConfidence).toBe(0.8);
    expect(summary.isHeuristic).toBe(true);
  });

  it("breaks ties by code point order, never at random", () => {
    const value = record({
      diagnoses: [
        {
          cause: "weak-naming",
          confidence: { value: 0.5, basis: "heuristic", signals: ["rank"] },
          evidence: [{ kind: "self_rank", observedValue: 7, references: [] }],
          isHeuristic: true,
        },
        {
          cause: "undocumented",
          confidence: { value: 0.5, basis: "heuristic", signals: ["doc"] },
          evidence: [{ kind: "documentation_coverage", observedValue: 0, references: [] }],
          isHeuristic: true,
        },
      ],
    });
    expect(toFindabilitySummary(value).primaryCause).toBe("undocumented");
    const reversed = record({ diagnoses: [...value.diagnoses].reverse() });
    expect(toFindabilitySummary(reversed).primaryCause).toBe("undocumented");
  });

  it("omits the cause when nothing was diagnosed", () => {
    const summary = toFindabilitySummary(record({ diagnoses: [] }));
    expect(summary.primaryCause).toBeUndefined();
    expect(canonicalJson(summary)).toBe(
      canonicalJson({ algorithm: FINDABILITY_ALGORITHM_ID, isHeuristic: true, score: 0.42 }),
    );
  });
});

describe("buildFindabilityId", () => {
  it("is stable per symbol and changes with the algorithm", () => {
    const first = buildFindabilityId({
      workspaceId: WORKSPACE,
      symbolId: "symbol-1",
      algorithm: FINDABILITY_ALGORITHM_ID,
      rankerVersion: RANKER_VERSION,
    });
    expect(first).toBe(
      buildFindabilityId({
        workspaceId: WORKSPACE,
        symbolId: "symbol-1",
        algorithm: FINDABILITY_ALGORITHM_ID,
        rankerVersion: RANKER_VERSION,
      }),
    );
    expect(first).not.toBe(
      buildFindabilityId({
        workspaceId: WORKSPACE,
        symbolId: "symbol-1",
        algorithm: "untangle-findability-v2",
        rankerVersion: RANKER_VERSION,
      }),
    );
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/**
 * Der Entwurfsfehler aus vision.md §1d: eine AUSGEFALLENE Suche darf nie als
 * Aussage ueber den Code erscheinen. Die Trennung Messung/Zustandsvermerk ist
 * strukturell — diese Tests halten fest, dass sie es bleibt.
 */
describe("findability: measurement vs. retrieval status", () => {
  const note = makeFindabilityUnavailable({
    workspaceId: WORKSPACE,
    repoId: REPO,
    refId: `${REPO}:main`,
    symbolId: "symbol-1",
    symbolFqn: "ImportResolver.resolve",
    filePath: "src/resolve.ts",
    reason: "search_unavailable",
    detail: "QDRANT_UNAVAILABLE: connection refused",
    probeKinds: ["self-name", "self-signature"],
    observedAt: "2026-09-05T00:00:00.000Z",
    generationId: "gen-1",
  });

  it("carries no score, no probe and no diagnoses — the fields do not exist", () => {
    expect(Object.keys(note)).not.toContain("score");
    expect(Object.keys(note)).not.toContain("diagnoses");
    expect(Object.keys(note)).not.toContain("nameProbe");
    expect(note.retrievalPerformed).toBe(false);
    // @ts-expect-error Ein Zustandsvermerk hat keine Diagnosen — auch nicht im Typ.
    expect(note.diagnoses).toBeUndefined();
  });

  it("is not assignable where a measurement is expected", () => {
    // @ts-expect-error Ein Zustandsvermerk ist keine Messung (vision.md §1d).
    const wrong: FindabilityV1 = note;
    expect(wrong).toBe(note);
  });

  it("survives canonical JSON without loss", () => {
    expect(JSON.parse(canonicalJson(note))).toEqual(note);
  });

  it("refuses a status note without a reason (E4)", () => {
    expect(() =>
      makeFindabilityUnavailable({
        workspaceId: WORKSPACE,
        repoId: REPO,
        refId: `${REPO}:main`,
        symbolId: "symbol-1",
        symbolFqn: "ImportResolver.resolve",
        filePath: "src/resolve.ts",
        reason: "search_unavailable",
        detail: "   ",
        probeKinds: ["self-name"],
        observedAt: "2026-09-05T00:00:00.000Z",
        generationId: "gen-1",
      }),
    ).toThrow(/non-empty detail/);
  });

  it("guards the measurement paths at runtime, like assertUntangleMetricNumber does for X3", () => {
    expect(() => assertFindabilityMeasured(note, "hotspot list")).toThrow(/never about the code/);
    expect(assertFindabilityMeasured(record(), "hotspot list")).toBeDefined();
    expect(isFindabilityUnavailable(note)).toBe(true);
    expect(isFindabilityMeasured(record())).toBe(true);
  });

  it("splits the missing-rank reasons into tool failures and code evidence", () => {
    expect(FINDABILITY_REASON_CLASSIFICATION_IS_TOTAL).toBe(true);
    for (const reason of FINDABILITY_RANK_MISSING_REASONS) {
      const isTool = (FINDABILITY_RETRIEVAL_FAILURE_REASONS as readonly string[]).includes(reason);
      const isCode = (FINDABILITY_CODE_EVIDENCE_REASONS as readonly string[]).includes(reason);
      expect(isTool !== isCode).toBe(true);
    }
    expect(isRetrievalFailureReason("search_unavailable")).toBe(true);
    expect(isRetrievalFailureReason("symbol_not_indexed")).toBe(true);
    expect(isRetrievalFailureReason("no_match")).toBe(false);
    expect(isRetrievalFailureReason(undefined)).toBe(false);
  });
});

describe("openFindabilityDiagnosisBasis", () => {
  const dispersion = {
    matchedFileCount: 9,
    matchedHitCount: 20,
    ownFileHitCount: 2,
    dispersion: 0.8,
  };
  const hops = { hops: 2, path: ["a"], pathUsesUncertainEdges: false };

  function probe(
    kind: "self-name" | "self-signature",
    overrides: Partial<FindabilityProbeV1> = {},
  ): FindabilityProbeV1 {
    return {
      kind,
      queryText: "resolve",
      queryFingerprint: "a".repeat(64),
      rank: 1,
      hitCount: 5,
      ...overrides,
    };
  }

  it("opens when both probes actually searched", () => {
    const basis = openFindabilityDiagnosisBasis({
      nameProbe: probe("self-name"),
      signatureProbe: probe("self-signature"),
      dispersion,
      hops,
    });
    expect(basis?.retrievalPerformed).toBe(true);
  });

  it("still opens when the search ran and simply found nothing — that IS a code finding", () => {
    for (const reason of FINDABILITY_CODE_EVIDENCE_REASONS) {
      const basis = openFindabilityDiagnosisBasis({
        nameProbe: probe("self-name", { rank: null, rankMissingReason: reason, hitCount: 0 }),
        signatureProbe: probe("self-signature"),
        dispersion,
        hops,
      });
      expect(basis).toBeDefined();
    }
  });

  it("stays shut when a probe reports a tool failure — never a diagnosis from that", () => {
    for (const reason of FINDABILITY_RETRIEVAL_FAILURE_REASONS) {
      expect(
        openFindabilityDiagnosisBasis({
          nameProbe: probe("self-name", { rank: null, rankMissingReason: reason, hitCount: 0 }),
          signatureProbe: probe("self-signature"),
          dispersion,
          hops,
        }),
      ).toBeUndefined();
      expect(
        openFindabilityDiagnosisBasis({
          nameProbe: probe("self-name"),
          signatureProbe: probe("self-signature", {
            rank: null,
            rankMissingReason: reason,
            hitCount: 0,
          }),
          dispersion,
          hops,
        }),
      ).toBeUndefined();
    }
  });
});

describe("validateFindability and the retrieval precondition", () => {
  const brokenProbe: FindabilityProbeV1 = {
    kind: "self-name",
    queryText: "resolve",
    queryFingerprint: "a".repeat(64),
    rank: null,
    rankMissingReason: "search_unavailable",
    hitCount: 0,
  };

  it("rejects a record that diagnoses the code although the search failed", () => {
    const value = record({ nameProbe: brokenProbe });
    expect(validateFindability(value).map((issue) => issue.kind)).toContain(
      "diagnosis_without_retrieval",
    );
  });

  it("accepts the same record once the diagnoses are gone", () => {
    expect(validateFindability(record({ nameProbe: brokenProbe, diagnoses: [] }))).toEqual([]);
  });

  it("never names a primary cause in the summary when the search failed", () => {
    const summary = toFindabilitySummary(record({ nameProbe: brokenProbe }));
    expect(summary.primaryCause).toBeUndefined();
    expect(summary.primaryCauseConfidence).toBeUndefined();
  });
});
