import { describe, expect, it } from "vitest";

import { cosineSimilarity, dotProduct, l2Norm, l2Normalize } from "./math.js";

describe("dotProduct", () => {
  it("computes the sum of pairwise products", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it("treats a shorter operand as zero-padded", () => {
    expect(dotProduct([1, 2, 3], [4, 5])).toBe(1 * 4 + 2 * 5);
  });
});

describe("l2Norm", () => {
  it("computes the Euclidean norm", () => {
    expect(l2Norm([3, 4])).toBe(5);
  });

  it("is zero for the zero vector", () => {
    expect(l2Norm([0, 0, 0])).toBe(0);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 instead of NaN when either vector has zero norm", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });
});

describe("l2Normalize", () => {
  it("scales a vector to unit length", () => {
    const normalized = l2Normalize([3, 4]);
    expect(l2Norm(normalized)).toBeCloseTo(1, 10);
    expect(normalized).toEqual([0.6, 0.8]);
  });

  it("returns the zero vector unchanged rather than dividing by zero", () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
