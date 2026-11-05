import { describe, expect, it } from "vitest";

import { frequenciesOf, shannonEntropy } from "./entropy.js";

describe("shannonEntropy", () => {
  it("is 0 for a single-outcome distribution", () => {
    expect(shannonEntropy([5])).toBe(0);
  });

  it("is 1 bit for a fair 50/50 split (hand-computed)", () => {
    expect(shannonEntropy([1, 1])).toBeCloseTo(1, 10);
  });

  it("is 2 bits for a uniform 4-outcome distribution (hand-computed)", () => {
    expect(shannonEntropy([1, 1, 1, 1])).toBeCloseTo(2, 10);
  });

  it("is 0 for an empty distribution", () => {
    expect(shannonEntropy([])).toBe(0);
  });

  it("ignores zero/negative frequencies", () => {
    expect(shannonEntropy([2, 0, 2])).toBeCloseTo(1, 10);
  });
});

describe("frequenciesOf", () => {
  it("counts occurrences by key", () => {
    const freq = frequenciesOf(["a", "b", "a", "c", "a"], (x) => x);
    expect(freq.get("a")).toBe(3);
    expect(freq.get("b")).toBe(1);
    expect(freq.get("c")).toBe(1);
  });
});
