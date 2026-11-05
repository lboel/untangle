/**
 * Pflicht-Fixture 7 (spec.md §27.2): "Parserfehler und teilweise gültiger
 * Code". One file with a genuine, unrecoverable syntax error, and one file
 * that is partially valid — a real, parseable symbol followed by broken
 * syntax, so a real TS parser's error recovery can be exercised honestly
 * (spec.md §7.3: `complete` / `partial` / `failed`).
 */
import type { GeneratedFixture } from "../types.js";

export function generateParseError(): GeneratedFixture {
  const files = [
    {
      path: "src/broken.ts",
      content: [
        "export function broken(a: number, b: number) {",
        "  return a +", // truncated expression — unrecoverable syntax error
        "",
      ].join("\n"),
    },
    {
      path: "src/partial.ts",
      content: [
        "export function valid(x: number): number {",
        "  return x * 2;",
        "}",
        "",
        "export function alsoValid(): string {",
        '  return "ok";',
        "}",
        "",
        "export function trailingBroken(a: number, b: number) {",
        "  return a *", // second, later syntax error after two good symbols
        "",
      ].join("\n"),
    },
    {
      path: "src/clean.ts",
      content: ["export function clean(): number {", "  return 42;", "}", ""].join("\n"),
    },
  ];

  return {
    files,
    groundTruth: {
      description:
        "broken.ts fails to parse at all; partial.ts has two valid symbols before a syntax error; clean.ts is a negative control",
      expectedParseQuality: {
        "src/broken.ts": "failed",
        "src/partial.ts": "partial",
        "src/clean.ts": "complete",
      },
      expectedSymbols: ["valid", "alsoValid", "clean"],
    },
  };
}
