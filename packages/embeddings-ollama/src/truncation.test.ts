import { describe, expect, it } from "vitest";

import { estimateTokenCount, wouldProviderTruncate } from "./truncation.js";

describe("estimateTokenCount", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("returns at least 1 for any non-empty text", () => {
    expect(estimateTokenCount("a")).toBeGreaterThanOrEqual(1);
  });

  it("grows roughly with text length (conservative chars-per-token estimate)", () => {
    const short = estimateTokenCount("a".repeat(30));
    const long = estimateTokenCount("a".repeat(300));
    expect(long).toBeGreaterThan(short * 5);
  });
});

describe("wouldProviderTruncate", () => {
  it("is false when the estimate fits comfortably within the context length", () => {
    expect(wouldProviderTruncate("short text", 2048)).toBe(false);
  });

  it("is true once the estimate exceeds the context length", () => {
    const longText = "word ".repeat(10_000);
    expect(wouldProviderTruncate(longText, 128)).toBe(true);
  });

  it("is false exactly at the boundary and true one token past it", () => {
    // estimateTokenCount uses ceil(length / 3); build a text at exactly N estimated tokens.
    const contextLength = 10;
    const atBoundary = "a".repeat(contextLength * 3); // estimate === contextLength
    const pastBoundary = "a".repeat(contextLength * 3 + 1); // estimate === contextLength + 1
    expect(wouldProviderTruncate(atBoundary, contextLength)).toBe(false);
    expect(wouldProviderTruncate(pastBoundary, contextLength)).toBe(true);
  });
});
