import { describe, expect, it } from "vitest";

import {
  compareByKeys,
  compareCodepoints,
  isSortedByCodepoints,
  sortByCodepoints,
  uniqueSortedByCodepoints,
} from "./ordering.js";

describe("compareCodepoints", () => {
  it("orders by code points, not by locale", () => {
    // Eine Locale-Sortierung (en-US) liefert ["a", "B"]; Codepoints liefern
    // ["B", "a"], weil "B" (U+0042) vor "a" (U+0061) steht. Genau diese
    // Unabhaengigkeit von der Maschine ist der Grund fuer das Verbot von
    // String#localeCompare.
    expect(sortByCodepoints(["a", "B"])).toEqual(["B", "a"]);
    expect(sortByCodepoints(["z", "ä"])).toEqual(["z", "ä"]);
    expect(compareCodepoints("a", "a")).toBe(0);
    expect(compareCodepoints("a", "b")).toBeLessThan(0);
    expect(compareCodepoints("b", "a")).toBeGreaterThan(0);
  });

  it("is stable across permutations of the same input", () => {
    const values = ["src/b.ts", "src/a.ts", "README.md", "src/a.ts"];
    expect(uniqueSortedByCodepoints(values)).toEqual(
      uniqueSortedByCodepoints([...values].reverse()),
    );
    expect(uniqueSortedByCodepoints(values)).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
  });

  it("recognizes sorted and unsorted lists", () => {
    expect(isSortedByCodepoints(["A", "B", "a"])).toBe(true);
    expect(isSortedByCodepoints(["a", "B"])).toBe(false);
    expect(isSortedByCodepoints([])).toBe(true);
  });
});

describe("compareByKeys", () => {
  it("compares field by field", () => {
    const rows = [
      { repo: "b", path: "a" },
      { repo: "a", path: "z" },
      { repo: "a", path: "b" },
    ];
    const sorted = [...rows].sort((left, right) => compareByKeys(["repo", "path"], left, right));
    expect(sorted).toEqual([
      { repo: "a", path: "b" },
      { repo: "a", path: "z" },
      { repo: "b", path: "a" },
    ]);
  });

  it("rejects non-string fields instead of comparing them silently", () => {
    expect(() => compareByKeys(["value"], { value: 1 }, { value: 2 })).toThrowError(TypeError);
  });
});
