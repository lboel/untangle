/**
 * Pflicht-Fixture 1 (spec.md §27.2): "TypeScript Monorepo mit Workspaces".
 * A pnpm workspace with two real packages, one depending on the other via
 * `workspace:*` — genuinely valid TypeScript, parseable by any real
 * TS-aware `LanguageAdapter`.
 */
import type { GeneratedFixture } from "../types.js";

export function generateTypescriptMonorepo(): GeneratedFixture {
  const files = [
    {
      path: "pnpm-workspace.yaml",
      content: "packages:\n  - 'packages/*'\n",
    },
    {
      path: "package.json",
      content: JSON.stringify(
        { name: "ts-monorepo-fixture", private: true, workspaces: ["packages/*"] },
        null,
        2,
      ),
    },
    {
      path: "packages/core/package.json",
      content: JSON.stringify(
        { name: "@fixture/core", version: "1.0.0", main: "src/index.ts", types: "src/index.ts" },
        null,
        2,
      ),
    },
    {
      path: "packages/core/src/index.ts",
      content: [
        "export interface Point {",
        "  x: number;",
        "  y: number;",
        "}",
        "",
        "/** Euclidean distance between two points. */",
        "export function distance(a: Point, b: Point): number {",
        "  const dx = a.x - b.x;",
        "  const dy = a.y - b.y;",
        "  return Math.sqrt(dx * dx + dy * dy);",
        "}",
        "",
        "export class Vector {",
        "  public constructor(",
        "    public readonly x: number,",
        "    public readonly y: number,",
        "  ) {}",
        "",
        "  public add(other: Vector): Vector {",
        "    return new Vector(this.x + other.x, this.y + other.y);",
        "  }",
        "",
        "  public length(): number {",
        "    return distance({ x: 0, y: 0 }, this);",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "packages/cli/package.json",
      content: JSON.stringify(
        {
          name: "@fixture/cli",
          version: "1.0.0",
          main: "src/index.ts",
          dependencies: { "@fixture/core": "workspace:*" },
        },
        null,
        2,
      ),
    },
    {
      path: "packages/cli/src/index.ts",
      content: [
        'import { Vector, distance } from "@fixture/core";',
        "",
        "export function run(args: string[]): string {",
        "  const a = new Vector(0, 0);",
        "  const b = new Vector(3, 4);",
        "  const moved = a.add(b);",
        '  return `distance=${distance(a, moved)} args=${args.join(",")}`;',
        "}",
        "",
      ].join("\n"),
    },
  ];

  return {
    files,
    groundTruth: {
      description:
        "pnpm TypeScript monorepo, @fixture/cli depends on @fixture/core via workspace:*",
      expectedParseQuality: {
        "packages/core/src/index.ts": "complete",
        "packages/cli/src/index.ts": "complete",
      },
      expectedSymbols: ["Point", "distance", "Vector", "Vector.add", "Vector.length", "run"],
    },
  };
}
