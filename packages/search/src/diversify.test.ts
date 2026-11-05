import { describe, expect, it } from "vitest";

import { REPO_REPETITION_SHARE, assignDuplicatePenalties } from "./diversify.js";
import { payloadFixture } from "./testing/candidates.js";

describe("assignDuplicatePenalties", () => {
  it("does not penalize the first hit of a file", () => {
    const entries = assignDuplicatePenalties([payloadFixture()], (payload) => payload);
    expect(entries[0]?.penaltyRawValue).toBe(0);
  });

  it("penalizes repeated hits of the same file with a saturating curve", () => {
    const payloads = [payloadFixture(), payloadFixture(), payloadFixture()];
    const entries = assignDuplicatePenalties(payloads, (payload) => payload);
    expect(entries[0]?.penaltyRawValue).toBe(0);
    expect(entries[1]?.penaltyRawValue).toBeCloseTo(0.5, 12);
    expect(entries[2]?.penaltyRawValue).toBeCloseTo(2 / 3, 12);
  });

  it("never reaches 1, so a file is never removed outright", () => {
    const payloads = Array.from({ length: 20 }, () => payloadFixture());
    const entries = assignDuplicatePenalties(payloads, (payload) => payload);
    for (const entry of entries) {
      expect(entry.penaltyRawValue).toBeLessThan(1);
    }
  });

  it("charges a smaller repetition penalty for a second file of the same repository", () => {
    const payloads = [payloadFixture({ file_id: "f1" }), payloadFixture({ file_id: "f2" })];
    const entries = assignDuplicatePenalties(payloads, (payload) => payload);
    expect(entries[1]?.penaltyRawValue).toBeCloseTo(0.5 * REPO_REPETITION_SHARE, 12);
  });

  it("treats the same file on a different ref as a different file", () => {
    const payloads = [payloadFixture({ ref_id: "ref-a" }), payloadFixture({ ref_id: "ref-b" })];
    const entries = assignDuplicatePenalties(payloads, (payload) => payload);
    expect(entries[1]?.penaltyRawValue).toBe(0);
  });

  it("does not reorder its input", () => {
    const payloads = [payloadFixture({ file_id: "f1" }), payloadFixture({ file_id: "f2" })];
    const entries = assignDuplicatePenalties(payloads, (payload) => payload);
    expect(entries.map((entry) => entry.item.file_id)).toEqual(["f1", "f2"]);
  });
});
