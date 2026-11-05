import type { SourceRange } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { classifyLines, scopeLines } from "./text-lines.js";

const SOURCE = ["/** doc */", "function f() {", "", "  return 1;", "}"].join("\n");
const RANGE: SourceRange = { startLine: 1, endLine: 5, startByte: 0, endByte: SOURCE.length };

describe("classifyLines", () => {
  it("classifies doc comments, blank lines and physical line count", () => {
    const docComment: SourceRange = { startLine: 1, endLine: 1, startByte: 0, endByte: 10 };
    const result = classifyLines(SOURCE, RANGE, [docComment]);
    expect(result.physicalLoc).toBe(5);
    expect(result.docLines.has(1)).toBe(true);
    expect(result.commentLines.has(1)).toBe(true);
    expect(result.blankLines.has(3)).toBe(true);
  });
});

describe("scopeLines", () => {
  it("splits a scope into its physical lines without a trailing empty line", () => {
    expect(scopeLines(SOURCE, RANGE)).toEqual([
      "/** doc */",
      "function f() {",
      "",
      "  return 1;",
      "}",
    ]);
  });

  it("drops the artifact line from a trailing newline", () => {
    const withTrailingNewline = `${SOURCE}\n`;
    const range: SourceRange = {
      startLine: 1,
      endLine: 6,
      startByte: 0,
      endByte: withTrailingNewline.length,
    };
    expect(scopeLines(withTrailingNewline, range)).toHaveLength(5);
  });
});
