import { describe, expect, it } from "vitest";

import { detectMinifiedContent } from "./minified-detection.js";

describe("detectMinifiedContent", () => {
  it("does not flag normal, well-formatted source", () => {
    const source = Array.from(
      { length: 200 },
      (_, i) => `function fn${i}() {\n  return ${i};\n}`,
    ).join("\n\n");
    expect(detectMinifiedContent(source)).toBe(false);
  });

  it("flags a single long line typical of a minified bundle", () => {
    const source = `(function(){${"a=1;".repeat(500)}})();`;
    expect(detectMinifiedContent(source)).toBe(true);
  });

  it("never flags small files regardless of line length", () => {
    const tiny = "a".repeat(50);
    expect(detectMinifiedContent(tiny)).toBe(false);
  });

  it("respects a custom threshold configuration", () => {
    const source = "x".repeat(3000);
    expect(
      detectMinifiedContent(source, {
        minSizeBytes: 10000,
        avgLineLengthThreshold: 300,
        maxLineLengthThreshold: 1000,
      }),
    ).toBe(false);
  });
});
