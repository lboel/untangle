import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical-json.js";
import { buildSearchQueryFingerprint } from "../identity.js";
import { RANKER_VERSION } from "../versions.js";

import type { SearchHitGroupV1 } from "./search.js";
import { SEARCH_ABSTENTIONS } from "./search.js";

import type { ScoreBreakdownV1, SearchQueryDefaults, SearchRequestV1 } from "./search.js";
import { normalizeSearchQuery, validateScoreBreakdown } from "./search.js";

const DEFAULTS: SearchQueryDefaults = {
  workspaceId: "workspace-1",
  limit: 10,
  candidateLimit: 100,
};

function request(overrides: Partial<SearchRequestV1> = {}): SearchRequestV1 {
  return { query: "parse import graph", ...overrides };
}

describe("normalizeSearchQuery", () => {
  it("fills defaults and normalizes filter lists deterministically", () => {
    const query = normalizeSearchQuery(
      request({
        repositories: ["repo-b", "repo-a", "repo-b"],
        languages: ["TypeScript", "python", "python"],
        pathGlob: ["  src/**  ", ""],
      }),
      DEFAULTS,
    );
    expect(query.workspaceId).toBe("workspace-1");
    expect(query.limit).toBe(10);
    expect(query.candidateLimit).toBe(100);
    expect(query.rankerVersion).toBe(RANKER_VERSION);
    expect(query.filters.repoIds).toEqual(["repo-a", "repo-b"]);
    // Codepoint-Ordnung, nicht Locale-Ordnung: "TypeScript" vor "python".
    expect(query.filters.languages).toEqual(["TypeScript", "python"]);
    expect(query.filters.pathGlobs).toEqual(["src/**"]);
    expect(query.filters.symbolNames).toEqual([]);
  });

  it("produces the same query for permuted, duplicated input", () => {
    const first = normalizeSearchQuery(
      request({ repositories: ["a", "b"], symbolKinds: ["function", "class"] }),
      DEFAULTS,
    );
    const second = normalizeSearchQuery(
      request({ repositories: ["b", "a", "a"], symbolKinds: ["class", "function"] }),
      DEFAULTS,
    );
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("survives canonical JSON without loss", () => {
    const query = normalizeSearchQuery(
      request({ complexity: { cognitiveMin: 5 }, changedSince: "2026-01-01T00:00:00.000Z" }),
      DEFAULTS,
    );
    expect(JSON.parse(canonicalJson(query))).toEqual(query);
  });

  it("rejects contradictory or unusable input instead of guessing", () => {
    expect(() => normalizeSearchQuery(request({ query: "   " }), DEFAULTS)).toThrowError(/empty/);
    expect(() => normalizeSearchQuery(request({ limit: 0 }), DEFAULTS)).toThrowError(/limit/);
    expect(() =>
      normalizeSearchQuery(request({ limit: 10, candidateLimit: 5 }), DEFAULTS),
    ).toThrowError(/candidateLimit/);
    expect(() =>
      normalizeSearchQuery(request({ complexity: { cognitiveMin: 9, cognitiveMax: 2 } }), DEFAULTS),
    ).toThrowError(/min > max/);
    expect(() =>
      normalizeSearchQuery(request({ changedSince: "letzte Woche" }), DEFAULTS),
    ).toThrowError(/ISO-8601/);
  });

  it("keeps identifier characters untouched (spec.md §13.2 step 3)", () => {
    const query = normalizeSearchQuery(request({ query: "  buildFileEdgeId(input)  " }), DEFAULTS);
    expect(query.text).toBe("buildFileEdgeId(input)");
  });
});

describe("buildSearchQueryFingerprint", () => {
  it("ignores paging parameters but reacts to the question itself", () => {
    const base = normalizeSearchQuery(request({ limit: 10 }), DEFAULTS);
    const paged = normalizeSearchQuery(request({ limit: 25, candidateLimit: 250 }), DEFAULTS);
    expect(buildSearchQueryFingerprint(base)).toBe(buildSearchQueryFingerprint(paged));

    const filtered = normalizeSearchQuery(request({ languages: ["python"] }), DEFAULTS);
    expect(buildSearchQueryFingerprint(base)).not.toBe(buildSearchQueryFingerprint(filtered));

    const otherText = normalizeSearchQuery(request({ query: "something else" }), DEFAULTS);
    expect(buildSearchQueryFingerprint(base)).not.toBe(buildSearchQueryFingerprint(otherText));
  });

  it("separates queries that differ only in result-changing ranking options", () => {
    const query = normalizeSearchQuery(request(), DEFAULTS);
    const base = buildSearchQueryFingerprint(query);
    // Ohne Zusatzangaben bleibt der Fingerabdruck derselbe wie zuvor.
    expect(buildSearchQueryFingerprint({ ...query, rankingOptions: undefined })).toBe(base);
    const lexical = buildSearchQueryFingerprint({ ...query, rankingOptions: { mode: "lexical" } });
    const symbol = buildSearchQueryFingerprint({ ...query, rankingOptions: { mode: "symbol" } });
    const sorted = buildSearchQueryFingerprint({ ...query, rankingOptions: { sort: "path" } });
    expect(new Set([base, lexical, symbol, sorted]).size).toBe(4);
  });

  it("is a stable 64-character hex digest", () => {
    const query = normalizeSearchQuery(request(), DEFAULTS);
    expect(buildSearchQueryFingerprint(query)).toMatch(/^[0-9a-f]{64}$/);
    expect(buildSearchQueryFingerprint(query)).toBe(buildSearchQueryFingerprint(query));
  });

  // -------------------------------------------------------------------------
  // Nachpruefung Welle 3b, Befund A1: die erste Reparatur ergaenzte die
  // Zusatzangaben des Abrufkerns (`rankingOptions`) und liess drei Felder
  // liegen, die laengst in `SearchQueryV1` stehen und die Treffermenge bzw.
  // die Rangfolge veraendern. Ursache war die EINSCHLUSSLISTE {text, filters,
  // rankerVersion}; sie laesst jedes nicht genannte Feld lautlos heraus.
  // -------------------------------------------------------------------------
  it("unterscheidet Anfragen, die sich nur in minScore, diversify oder workspaceId unterscheiden", () => {
    const base = normalizeSearchQuery(request(), DEFAULTS);
    const scored = normalizeSearchQuery(request({ minScore: 0.9 }), DEFAULTS);
    const diversified = normalizeSearchQuery(request({ diversify: true }), DEFAULTS);
    const elsewhere = normalizeSearchQuery(request({ workspaceId: "workspace-2" }), DEFAULTS);
    const fingerprints = [base, scored, diversified, elsewhere].map(buildSearchQueryFingerprint);
    expect(new Set(fingerprints).size).toBe(4);
  });

  it("zaehlt jedes NEUE Feld der normalisierten Anfrage mit, statt es zu uebergehen", () => {
    // Der eigentliche Schutz vor einer Wiederholung des Befunds: was nicht
    // ausdruecklich als Darstellungsfeld gelistet ist, geht ein.
    const query = normalizeSearchQuery(request(), DEFAULTS);
    const base = buildSearchQueryFingerprint(query);
    expect(buildSearchQueryFingerprint({ ...query, aFutureRankingKnob: "on" })).not.toBe(base);
    for (const presentationField of [
      "limit",
      "candidateLimit",
      "includeContent",
      "includeGraphContext",
      "includeLinked",
    ]) {
      expect(buildSearchQueryFingerprint({ ...query, [presentationField]: 4242 })).toBe(base);
    }
  });
});

function breakdown(overrides: Partial<ScoreBreakdownV1> = {}): ScoreBreakdownV1 {
  return {
    schemaVersion: 1,
    final: 0.72,
    components: [
      { kind: "base_hybrid", rawValue: 0.6, weight: 1, contribution: 0.6 },
      {
        kind: "exact_symbol_boost",
        rawValue: 0.4,
        weight: 0.3,
        contribution: 0.12,
        evidence: "symbol name == query text",
      },
    ],
    inputs: { dense: 0.71, sparseRank: 3, rrf: 0.6 },
    rankerVersion: RANKER_VERSION,
    clamped: false,
    ...overrides,
  };
}

describe("validateScoreBreakdown", () => {
  it("accepts a decomposition whose parts add up to the final score", () => {
    const result = validateScoreBreakdown(breakdown());
    expect(result.valid).toBe(true);
    expect(result.computedFinal).toBeCloseTo(0.72, 12);
    expect(result.baseShare).toBeCloseTo(0.6 / 0.72, 12);
  });

  it("detects a final score that does not match its parts", () => {
    const result = validateScoreBreakdown(breakdown({ final: 0.95 }));
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain("sum_mismatch");
  });

  it("detects a contribution that is not rawValue * weight", () => {
    const result = validateScoreBreakdown(
      breakdown({
        final: 0.9,
        components: [
          { kind: "base_hybrid", rawValue: 0.6, weight: 1, contribution: 0.6 },
          { kind: "recency_boost", rawValue: 0.5, weight: 0.2, contribution: 0.3 },
        ],
      }),
    );
    expect(result.issues.map((issue) => issue.kind)).toContain("contribution_mismatch");
  });

  it("requires exactly one base_hybrid component", () => {
    const missing = validateScoreBreakdown(
      breakdown({
        final: 0.12,
        components: [
          { kind: "exact_symbol_boost", rawValue: 0.4, weight: 0.3, contribution: 0.12 },
        ],
      }),
    );
    expect(missing.issues.map((issue) => issue.kind)).toContain("missing_base");

    const duplicated = validateScoreBreakdown(
      breakdown({
        final: 1.2,
        components: [
          { kind: "base_hybrid", rawValue: 0.6, weight: 1, contribution: 0.6 },
          { kind: "base_hybrid", rawValue: 0.6, weight: 1, contribution: 0.6 },
        ],
      }),
    );
    expect(duplicated.issues.map((issue) => issue.kind)).toContain("duplicate_base");
  });

  it("demands a reason whenever boosts were clamped", () => {
    const result = validateScoreBreakdown(breakdown({ clamped: true }));
    expect(result.issues.map((issue) => issue.kind)).toContain("no_clamp_reason");

    const documented = validateScoreBreakdown(
      breakdown({ clamped: true, clampReason: "boost sum capped at 40 % of the hybrid score" }),
    );
    expect(documented.valid).toBe(true);
  });

  it("reports the base share so callers can see boosts taking over", () => {
    const boostHeavy = validateScoreBreakdown(
      breakdown({
        final: 1.1,
        components: [
          { kind: "base_hybrid", rawValue: 0.1, weight: 1, contribution: 0.1 },
          { kind: "repo_priority_boost", rawValue: 1, weight: 1, contribution: 1 },
        ],
      }),
    );
    expect(boostHeavy.valid).toBe(true);
    expect(boostHeavy.baseShare).toBeCloseTo(0.1 / 1.1, 12);
  });

  it("counts penalties by magnitude, not by sign", () => {
    const withPenalty = validateScoreBreakdown(
      breakdown({
        final: 0.5,
        components: [
          { kind: "base_hybrid", rawValue: 0.6, weight: 1, contribution: 0.6 },
          { kind: "duplicate_penalty", rawValue: 0.5, weight: -0.2, contribution: -0.1 },
        ],
      }),
    );
    expect(withPenalty.valid).toBe(true);
    expect(withPenalty.baseShare).toBeCloseTo(0.6 / 0.7, 12);
  });
});

describe("SearchRelevanceVerdictV1 (Abstinenz als Feld, nicht als Listenlaenge)", () => {
  it("kennt genau zwei Abstinenzverhalten", () => {
    expect(SEARCH_ABSTENTIONS).toEqual(["strict", "evidence"]);
  });

  it("traegt das Verdikt an der Gruppe, unabhaengig davon ob Treffer da sind", () => {
    // Der Kern der Sache: `hits.length` sagt nichts ueber das Verdikt. Unter
    // `evidence` stehen Treffer da UND die Policy hat sie fuer unzureichend
    // gehalten. Wer das aus der Listenlaenge liest, liest falsch.
    const rejectedWithHits: SearchHitGroupV1 = {
      embeddingProfileId: "p1",
      repoIds: ["repo-1"],
      hits: [],
      rankNormalized: false,
      caveats: [],
      relevanceDecision: {
        abstention: "evidence",
        status: "rejected",
        basis: "insufficient_evidence",
        calibrationId: "test/force-abstention",
      },
    };
    expect(rejectedWithHits.relevanceDecision?.status).toBe("rejected");
    expect(rejectedWithHits.relevanceDecision?.abstention).toBe("evidence");
  });

  it("laesst das Feld weg, wenn gar keine Policy gebunden ist", () => {
    const noPolicy: SearchHitGroupV1 = {
      embeddingProfileId: "p1",
      repoIds: ["repo-1"],
      hits: [],
      rankNormalized: false,
      caveats: [],
    };
    expect(noPolicy.relevanceDecision).toBeUndefined();
  });
});
