import { describe, expect, it } from "vitest";

import {
  assertValidGlobPatterns,
  globToRegExp,
  isPathSelected,
  matchesAnyGlob,
  matchesGlob,
  normalizeGlobPath,
} from "./glob.js";

describe("matchesGlob", () => {
  it("matches a literal path", () => {
    expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/b.ts", "src/a.ts")).toBe(false);
  });

  it("* does not cross a directory separator", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/deep/a.ts", "src/*.ts")).toBe(false);
  });

  it("** crosses directory separators", () => {
    expect(matchesGlob("src/deep/nested/a.ts", "src/**/a.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/**/a.ts")).toBe(true);
    expect(matchesGlob("src/deep/a.ts", "src/**")).toBe(true);
  });

  it("? matches exactly one non-separator character", () => {
    expect(matchesGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchesGlob("src/ab.ts", "src/?.ts")).toBe(false);
  });

  it("supports character classes including negation", () => {
    expect(matchesGlob("src/a.ts", "src/[abc].ts")).toBe(true);
    expect(matchesGlob("src/d.ts", "src/[abc].ts")).toBe(false);
    expect(matchesGlob("src/d.ts", "src/[!abc].ts")).toBe(true);
  });

  it("matches a separator-free pattern against the basename", () => {
    expect(matchesGlob("src/deep/a.ts", "*.ts")).toBe(true);
    expect(matchesGlob("src/deep/a.js", "*.ts")).toBe(false);
  });

  it("treats an unbalanced bracket as a literal instead of throwing", () => {
    expect(matchesGlob("src/[a.ts", "src/[a.ts")).toBe(true);
  });

  it("normalizes backslashes and a leading ./", () => {
    expect(normalizeGlobPath("./src\\a.ts")).toBe("src/a.ts");
    expect(matchesGlob("./src\\a.ts", "src/a.ts")).toBe(true);
  });
});

describe("matchesAnyGlob", () => {
  it("is false for an empty pattern list", () => {
    expect(matchesAnyGlob("src/a.ts", [])).toBe(false);
  });
});

describe("isPathSelected", () => {
  it("treats an empty include list as 'everything'", () => {
    expect(isPathSelected("src/a.ts", [], [])).toBe(true);
  });

  it("applies the include list", () => {
    expect(isPathSelected("src/a.ts", ["src/**"], [])).toBe(true);
    expect(isPathSelected("docs/a.md", ["src/**"], [])).toBe(false);
  });

  it("lets exclusion win over inclusion", () => {
    expect(isPathSelected("src/a.test.ts", ["src/**"], ["**/*.test.ts"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regressionen aus der adversarialen Pruefung (Welle 3)
// ---------------------------------------------------------------------------

describe("fehlerhafte Muster", () => {
  it("nennt das Muster, statt einen rohen SyntaxError durchzureichen", () => {
    expect(() => globToRegExp("[z-a]")).toThrow(/glob pattern "\[z-a\]" is not a valid pattern/u);
    expect(() => matchesGlob("src/a.ts", "[z-a]")).toThrow(/is not a valid pattern/u);
  });

  it("prueft eine ganze Liste vorab und nennt das Feld", () => {
    expect(() => assertValidGlobPatterns(["src/**", "[z-a]"], "pathExclude")).toThrow(
      /"pathExclude" contains an invalid pattern/u,
    );
    expect(() => assertValidGlobPatterns(["src/**", "*.ts"], "pathGlob")).not.toThrow();
  });
});
