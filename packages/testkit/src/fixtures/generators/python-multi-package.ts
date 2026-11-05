/**
 * Pflicht-Fixture 2 (spec.md §27.2): "Python Multi-Package-Workspace". Two
 * real, independently-packaged Python packages, one importing the other —
 * genuinely valid Python 3.
 */
import type { GeneratedFixture } from "../types.js";

export function generatePythonMultiPackage(): GeneratedFixture {
  const files = [
    {
      path: "packages/geometry/pyproject.toml",
      content: ["[project]", 'name = "fixture-geometry"', 'version = "1.0.0"', ""].join("\n"),
    },
    {
      path: "packages/geometry/geometry/__init__.py",
      content: "",
    },
    {
      path: "packages/geometry/geometry/shapes.py",
      content: [
        "import math",
        "",
        "",
        "class Point:",
        '    """A 2D point."""',
        "",
        "    def __init__(self, x: float, y: float) -> None:",
        "        self.x = x",
        "        self.y = y",
        "",
        '    def distance_to(self, other: "Point") -> float:',
        "        dx = self.x - other.x",
        "        dy = self.y - other.y",
        "        return math.sqrt(dx * dx + dy * dy)",
        "",
        "",
        "def midpoint(a: Point, b: Point) -> Point:",
        "    return Point((a.x + b.x) / 2, (a.y + b.y) / 2)",
        "",
      ].join("\n"),
    },
    {
      path: "packages/cli/pyproject.toml",
      content: [
        "[project]",
        'name = "fixture-cli"',
        'version = "1.0.0"',
        "dependencies = [",
        '    "fixture-geometry",',
        "]",
        "",
      ].join("\n"),
    },
    {
      path: "packages/cli/cli/__init__.py",
      content: "",
    },
    {
      path: "packages/cli/cli/main.py",
      content: [
        "from geometry.shapes import Point, midpoint",
        "",
        "",
        "def describe(a: Point, b: Point) -> str:",
        "    m = midpoint(a, b)",
        '    return f"midpoint=({m.x}, {m.y}) distance={a.distance_to(b)}"',
        "",
        "",
        'if __name__ == "__main__":',
        "    print(describe(Point(0, 0), Point(4, 3)))",
        "",
      ].join("\n"),
    },
  ];

  return {
    files,
    groundTruth: {
      description: "Two Python packages (fixture-geometry, fixture-cli); cli imports geometry",
      expectedParseQuality: {
        "packages/geometry/geometry/shapes.py": "complete",
        "packages/cli/cli/main.py": "complete",
      },
      expectedSymbols: ["Point", "Point.distance_to", "midpoint", "describe"],
    },
  };
}
