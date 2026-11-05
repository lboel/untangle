import type { FieldCondition, PayloadFilter } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { matchesPayloadFilter } from "./payload-filter.js";

const payload: Record<string, unknown> = {
  point_type: "chunk",
  language: "typescript",
  risk_score: 42,
};

describe("matchesPayloadFilter", () => {
  it("matches everything when no filter is given", () => {
    expect(matchesPayloadFilter(payload, undefined)).toBe(true);
  });

  it("evaluates an eq match condition", () => {
    const filter: PayloadFilter = { must: [{ field: "language", match: { eq: "typescript" } }] };
    expect(matchesPayloadFilter(payload, filter)).toBe(true);
    expect(
      matchesPayloadFilter(payload, {
        must: [{ field: "language", match: { eq: "python" } }],
      }),
    ).toBe(false);
  });

  it("evaluates an in match condition", () => {
    const filter: PayloadFilter = {
      must: [{ field: "point_type", match: { in: ["chunk", "symbol"] } }],
    };
    expect(matchesPayloadFilter(payload, filter)).toBe(true);
  });

  it("evaluates a numeric range condition", () => {
    const inRange: FieldCondition = { field: "risk_score", range: { gte: 40, lt: 50 } };
    const outOfRange: FieldCondition = { field: "risk_score", range: { gt: 50 } };
    expect(matchesPayloadFilter(payload, { must: [inRange] })).toBe(true);
    expect(matchesPayloadFilter(payload, { must: [outOfRange] })).toBe(false);
  });

  it("fails a range condition when the field is not a number", () => {
    expect(matchesPayloadFilter(payload, { must: [{ field: "language", range: { gt: 0 } }] })).toBe(
      false,
    );
  });

  it("combines must clauses with AND", () => {
    const filter: PayloadFilter = {
      must: [
        { field: "language", match: { eq: "typescript" } },
        { field: "risk_score", range: { gte: 100 } },
      ],
    };
    expect(matchesPayloadFilter(payload, filter)).toBe(false);
  });

  it("rejects when any mustNot condition matches", () => {
    const filter: PayloadFilter = { mustNot: [{ field: "language", match: { eq: "typescript" } }] };
    expect(matchesPayloadFilter(payload, filter)).toBe(false);
  });

  it("requires at least one should condition to match when should is non-empty", () => {
    const matching: PayloadFilter = {
      should: [{ field: "language", match: { eq: "typescript" } }],
    };
    const nonMatching: PayloadFilter = { should: [{ field: "language", match: { eq: "python" } }] };
    expect(matchesPayloadFilter(payload, matching)).toBe(true);
    expect(matchesPayloadFilter(payload, nonMatching)).toBe(false);
  });

  it("combines must, mustNot and should clauses with AND", () => {
    const filter: PayloadFilter = {
      must: [{ field: "language", match: { eq: "typescript" } }],
      mustNot: [{ field: "point_type", match: { eq: "symbol" } }],
      should: [{ field: "risk_score", range: { gt: 0 } }],
    };
    expect(matchesPayloadFilter(payload, filter)).toBe(true);
  });
});
