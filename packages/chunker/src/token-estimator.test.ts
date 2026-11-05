import { describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_ESTIMATOR_CONFIG, estimateTokens } from "./token-estimator.js";

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns at least 1 for any non-empty text", () => {
    expect(estimateTokens("a")).toBeGreaterThanOrEqual(1);
  });

  it("grows monotonically with content length", () => {
    const short = estimateTokens("function foo() {}");
    const long = estimateTokens("function foo() { return 1 + 2 + 3 + 4 + 5; }");
    expect(long).toBeGreaterThan(short);
  });

  it("over-estimates rather than under-estimates a realistic BPE tokenizer count", () => {
    // A rough, widely-cited average for code tokenizers is ~3.5-4.5 chars/token.
    // At the default 3 chars/token, our estimate should sit at or above that.
    const code = "const total = items.reduce((sum, item) => sum + item.price, 0);";
    const realisticTokenCountUpperBound = Math.ceil(code.length / 3.5);
    expect(estimateTokens(code)).toBeGreaterThanOrEqual(realisticTokenCountUpperBound);
  });

  it("is a pure function of its inputs (no hidden state, no network)", () => {
    const a = estimateTokens("some code here", DEFAULT_TOKEN_ESTIMATOR_CONFIG);
    const b = estimateTokens("some code here", DEFAULT_TOKEN_ESTIMATOR_CONFIG);
    expect(a).toBe(b);
  });

  it("is configurable via charsPerToken", () => {
    const text = "x".repeat(30);
    const generous = estimateTokens(text, { charsPerToken: 10, perLineOverheadTokens: 0 });
    const strict = estimateTokens(text, { charsPerToken: 2, perLineOverheadTokens: 0 });
    expect(strict).toBeGreaterThan(generous);
  });
});
