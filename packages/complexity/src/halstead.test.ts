import { describe, expect, it } from "vitest";

import { computeHalstead } from "./halstead.js";
import { range, token } from "./test-support/builders.js";

const SCOPE = "sym1";

describe("computeHalstead", () => {
  it("matches a hand-computed example", () => {
    // operators: =, +, =, +  (N1=4, n1=2: {"=","+"})
    // operands:  a, b, c, a, b (N2=5, n2=3: {"a","b","c"})
    const operators = ["=", "+", "=", "+"].map((t) => token(t, range(1, 1), SCOPE));
    const operands = ["a", "b", "c", "a", "b"].map((t) => token(t, range(1, 1), SCOPE));

    const result = computeHalstead({ operators, operands });

    // n1=2, n2=3, N1=4, N2=5, n=5, N=9
    // volume = 9 * log2(5) = 9 * 2.321928... = 20.897352...
    // difficulty = (2/2) * (5/3) = 1.6666...
    // effort = 1.6666... * 20.897352... = 34.828920...
    expect(result.metrics).toMatchObject({ n1: 2, n2: 3, N1: 4, N2: 5, n: 5, N: 9 });
    expect(result.metrics["volume"]).toBeCloseTo(20.89735, 4);
    expect(result.metrics["difficulty"]).toBeCloseTo(1.66667, 4);
    expect(result.metrics["effort"]).toBeCloseTo(34.82892, 3);
    expect(result.estimates).toBeUndefined();
  });

  it("applies max(n,1) and max(n2,1) guards on an empty token stream", () => {
    const result = computeHalstead({ operators: [], operands: [] });
    expect(result.metrics).toMatchObject({
      n1: 0,
      n2: 0,
      N1: 0,
      N2: 0,
      n: 0,
      N: 0,
      volume: 0,
      difficulty: 0,
      effort: 0,
    });
    expect(Number.isFinite(result.metrics["volume"])).toBe(true);
  });

  it("labels time/bugs explicitly as estimates and only includes them when asked", () => {
    const operators = ["=", "+"].map((t) => token(t, range(1, 1), SCOPE));
    const operands = ["a", "b"].map((t) => token(t, range(1, 1), SCOPE));

    const withoutEstimates = computeHalstead({ operators, operands });
    expect(withoutEstimates.estimates).toBeUndefined();

    const withEstimates = computeHalstead({ operators, operands }, { includeEstimates: true });
    expect(withEstimates.estimates).toBeDefined();
    expect(withEstimates.estimates?.timeSeconds).toBeCloseTo(
      (withEstimates.metrics["effort"] as number) / 18,
      10,
    );
    expect(withEstimates.estimates?.estimatedBugs).toBeCloseTo(
      (withEstimates.metrics["volume"] as number) / 3000,
      10,
    );
  });
});
