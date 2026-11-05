/**
 * Pflicht-Fixture 4 (spec.md §27.2): "absichtliche Dependency Cycles". Three
 * real TypeScript modules forming one genuine import cycle (a → b → c → a),
 * plus one module outside the cycle as a negative control.
 */
import type { GeneratedFixture } from "../types.js";

export function generateDependencyCycle(): GeneratedFixture {
  const files = [
    {
      path: "src/a.ts",
      content: [
        'import { fromB } from "./b.js";',
        "",
        "export function fromA(): string {",
        '  return "a:" + fromB();',
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "src/b.ts",
      content: [
        'import { fromC } from "./c.js";',
        "",
        "export function fromB(): string {",
        '  return "b:" + fromC();',
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "src/c.ts",
      content: [
        // Closes the cycle back to a.ts. Uses a type-only re-export of a
        // value from `a.ts` so this stays genuinely valid, cycle-tolerant
        // TypeScript (Node ESM resolves circular imports at module-eval
        // time as long as nothing is used before its module finished
        // initializing, exactly like `fromA` here — called lazily, from
        // inside a function body, never at module top level).
        'import { fromA } from "./a.js";',
        "",
        "export function fromC(): string {",
        '  return "c";',
        "}",
        "",
        "export function fromCviaA(): string {",
        "  return fromA();",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "src/standalone.ts",
      content: [
        "// Not part of the cycle — a negative control for cycle detection.",
        "export function standalone(): string {",
        '  return "standalone";',
        "}",
        "",
      ].join("\n"),
    },
  ];

  return {
    files,
    groundTruth: {
      description:
        "a.ts -> b.ts -> c.ts -> a.ts is one genuine import cycle; standalone.ts is outside it",
      expectedParseQuality: {
        "src/a.ts": "complete",
        "src/b.ts": "complete",
        "src/c.ts": "complete",
        "src/standalone.ts": "complete",
      },
      cycleParticipants: ["src/a.ts", "src/b.ts", "src/c.ts"],
      expectedSymbols: ["fromA", "fromB", "fromC", "fromCviaA", "standalone"],
    },
  };
}
