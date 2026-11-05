import { describe, expect, it } from "vitest";

import { compilePatterns, evaluateLayer } from "./gitignore-pattern.js";

function decide(
  content: string,
  baseDir: string,
  path: string,
  isDirectory = false,
): boolean | undefined {
  return evaluateLayer(compilePatterns(content, baseDir), path, isDirectory);
}

describe("gitignore pattern compiler", () => {
  it("matches an unanchored name at any depth", () => {
    expect(decide("node_modules", "", "node_modules", true)).toBe(true);
    expect(decide("node_modules", "", "a/b/node_modules", true)).toBe(true);
    expect(decide("node_modules", "", "a/node_modules/pkg/index.js")).toBe(true);
  });

  it("anchors a leading-slash pattern to the base directory only", () => {
    expect(decide("/build", "", "build", true)).toBe(true);
    expect(decide("/build", "", "a/build", true)).toBeUndefined();
  });

  it("scopes patterns to the base directory of nested ignore files", () => {
    const compiled = compilePatterns("*.log", "packages/app");
    expect(evaluateLayer(compiled, "packages/app/debug.log", false)).toBe(true);
    expect(evaluateLayer(compiled, "packages/other/debug.log", false)).toBeUndefined();
  });

  it("applies negation to re-include a previously excluded path (last match wins)", () => {
    const content = ["*.log", "!important.log"].join("\n");
    expect(decide(content, "", "debug.log")).toBe(true);
    expect(decide(content, "", "important.log")).toBe(false);
  });

  it("respects pattern order for last-match-wins semantics", () => {
    const content = ["!keep.txt", "*.txt"].join("\n");
    // Here the exclude comes *after* the negation, so it wins.
    expect(decide(content, "", "keep.txt")).toBe(true);
  });

  it("treats a trailing slash as directory-only", () => {
    const compiled = compilePatterns("build/", "");
    expect(evaluateLayer(compiled, "build", true)).toBe(true);
    expect(evaluateLayer(compiled, "build", false)).toBeUndefined();
  });

  it("supports ** for arbitrary-depth matches", () => {
    expect(decide("**/*.min.js", "", "a/b/c/app.min.js")).toBe(true);
    expect(decide("**/*.min.js", "", "app.min.js")).toBe(true);
    expect(decide("**/*.min.js", "", "app.js")).toBeUndefined();
  });

  it("supports * as an unanchored wildcard matching at any depth", () => {
    expect(decide("*.ts", "", "index.ts")).toBe(true);
    // No "/" in the pattern means unanchored: matches at any depth, per gitignore semantics.
    expect(decide("*.ts", "", "src/index.ts")).toBe(true);
  });

  it("anchors a pattern containing a slash to its own directory depth", () => {
    expect(decide("src/*.ts", "", "src/index.ts")).toBe(true);
    expect(decide("src/*.ts", "", "src/nested/index.ts")).toBeUndefined();
  });

  it("ignores blank lines and comments", () => {
    const compiled = compilePatterns(["", "# a comment", "*.tmp", ""].join("\n"), "");
    expect(compiled).toHaveLength(1);
    expect(evaluateLayer(compiled, "x.tmp", false)).toBe(true);
  });

  it("returns undefined (no opinion) when nothing matches", () => {
    expect(decide("*.log", "", "readme.md")).toBeUndefined();
  });
});
