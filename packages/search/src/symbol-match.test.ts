import { describe, expect, it } from "vitest";

import { matchSymbolName, symbolNameFilterCandidates } from "./symbol-match.js";
import { payloadFixture } from "./testing/candidates.js";

describe("matchSymbolName", () => {
  it("rates a character-identical name highest", () => {
    expect(matchSymbolName(payloadFixture({ symbol_name: "charge" }), "charge")?.strength).toBe(1);
  });

  it("rates a case-only difference lower", () => {
    expect(matchSymbolName(payloadFixture({ symbol_name: "Charge" }), "charge")?.strength).toBe(
      0.8,
    );
  });

  it("matches a qualified name via its last segment", () => {
    expect(
      matchSymbolName(
        payloadFixture({ symbol_name: "other", symbol_fqn: "PaymentService.charge" }),
        "charge",
      )?.strength,
    ).toBe(0.6);
  });

  it("matches when the name contains every query part", () => {
    expect(
      matchSymbolName(payloadFixture({ symbol_name: "getUserById" }), "get user")?.strength,
    ).toBe(0.4);
  });

  it("returns null when nothing matches", () => {
    expect(matchSymbolName(payloadFixture({ symbol_name: "refund" }), "charge")).toBeNull();
  });

  it("returns null for a chunk without a symbol", () => {
    expect(matchSymbolName(payloadFixture(), "charge")).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(matchSymbolName(payloadFixture({ symbol_name: "charge" }), "   ")).toBeNull();
  });

  it("always names the evidence for the score breakdown", () => {
    expect(
      matchSymbolName(payloadFixture({ symbol_name: "charge" }), "charge")?.evidence,
    ).toContain("symbol_name");
  });
});

describe("symbolNameFilterCandidates", () => {
  it("returns the query itself", () => {
    expect(symbolNameFilterCandidates("charge")).toEqual(["charge"]);
  });

  it("adds the last segment of a qualified name", () => {
    expect(symbolNameFilterCandidates("PaymentService.charge")).toEqual([
      "PaymentService.charge",
      "charge",
    ]);
  });

  it("does not invent casing variants", () => {
    expect(symbolNameFilterCandidates("charge")).not.toContain("Charge");
  });

  it("is empty for an empty query", () => {
    expect(symbolNameFilterCandidates("  ")).toEqual([]);
  });

  it("is sorted by codepoints, never by locale", () => {
    const candidates = symbolNameFilterCandidates("a/b");
    expect(candidates).toEqual([...candidates].sort());
  });
});
