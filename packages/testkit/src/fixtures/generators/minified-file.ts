/**
 * Pflicht-Fixture 8 (spec.md §27.2): "minifizierte Datei". A real,
 * genuinely-minified single-line bundle (produced by hand in the same
 * style a bundler would emit: no whitespace, short identifiers, semicolons
 * as separators) alongside its un-minified source for comparison.
 */
import type { GeneratedFixture } from "../types.js";

const MINIFIED_LINE =
  'function e(t,n){return t.reduce(function(t,e){return t+e},n)}function r(e,t){return e.filter(function(e){return e>t})}var o={sum:e,above:r};"undefined"!=typeof module&&(module.exports=o);';

export function generateMinifiedFile(): GeneratedFixture {
  const files = [
    {
      path: "dist/bundle.min.js",
      // Genuinely one physical line, no trailing newline manipulation that
      // would defeat the point of the fixture.
      content: MINIFIED_LINE,
    },
    {
      path: "src/bundle.js",
      content: [
        "function sum(list, initial) {",
        "  return list.reduce(function (acc, x) {",
        "    return acc + x;",
        "  }, initial);",
        "}",
        "",
        "function above(list, threshold) {",
        "  return list.filter(function (x) {",
        "    return x > threshold;",
        "  });",
        "}",
        "",
        "var lib = { sum: sum, above: above };",
        'if (typeof module !== "undefined") {',
        "  module.exports = lib;",
        "}",
        "",
      ].join("\n"),
    },
  ];

  return {
    files,
    groundTruth: {
      description:
        "dist/bundle.min.js is one real minified line; src/bundle.js is its readable source",
      expectedParseQuality: {
        "src/bundle.js": "complete",
      },
    },
  };
}
