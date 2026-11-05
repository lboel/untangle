import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const {
  createQuickstartFixture,
  captureQuickstartTree,
  assertQuickstartAnalysis,
  assertQuickstartMcpConfig,
} = (await import(new URL("./quickstart-smoke.mjs", import.meta.url).href)) as {
  createQuickstartFixture(project: string): void;
  captureQuickstartTree(
    project: string,
  ): readonly { path: string; kind: string; sha256?: string }[];
  assertQuickstartAnalysis(analysis: unknown, project: string): void;
  assertQuickstartMcpConfig(config: unknown, project: string, node?: string): unknown;
};

const directories: string[] = [];
const fixture = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "quickstart-contract-"));
  directories.push(directory);
  createQuickstartFixture(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("checkout quickstart acceptance", () => {
  it("starts from two actual languages without requiring Git, services or declared features", () => {
    const project = fixture();
    expect(captureQuickstartTree(project).map((entry) => entry.path)).toEqual([
      "src",
      "src/lookup.ts",
      "src/normalize.py",
    ]);
    expect(readFileSync(path.join(project, "src/lookup.ts"), "utf8")).toContain("if (!id)");
    expect(readFileSync(path.join(project, "src/normalize.py"), "utf8")).toContain(
      "if value is None:",
    );
  });

  it("detects both source changes and undeclared files rather than trusting CLI exit codes", () => {
    const project = fixture();
    const before = captureQuickstartTree(project);
    writeFileSync(path.join(project, "src/lookup.ts"), "export const replaced = true;\n");
    expect(captureQuickstartTree(project)).not.toEqual(before);
    writeFileSync(path.join(project, "untangle.toml"), "schema_version = 1\n");
    expect(captureQuickstartTree(project).some((entry) => entry.path === "untangle.toml")).toBe(
      true,
    );
  });

  it("rejects coverage gaps, the wrong project and missing measured branches", () => {
    const project = "/fixture/project with spaces";
    const report = {
      schemaVersion: 1,
      root: project,
      filesDiscovered: 2,
      filesAnalyzed: 2,
      totalsReading: "execution_unit",
      totals: { executionUnitRoots: 2, cognitive: 2 },
      skipped: [],
      hotspots: [
        { filePath: "src/lookup.ts", name: "lookup" },
        { filePath: "src/normalize.py", name: "normalize" },
      ],
    };
    expect(() => assertQuickstartAnalysis(report, project)).not.toThrow();
    expect(() => assertQuickstartAnalysis({ ...report, root: "/unrelated" }, project)).toThrow();
    expect(() => assertQuickstartAnalysis({ ...report, filesAnalyzed: 1 }, project)).toThrow();
    expect(() =>
      assertQuickstartAnalysis({ ...report, skipped: [{ path: "src/normalize.py" }] }, project),
    ).toThrow();
    expect(() =>
      assertQuickstartAnalysis(
        { ...report, totals: { executionUnitRoots: 2, cognitive: 0 } },
        project,
      ),
    ).toThrow();
  });

  it("requires generated MCP args to pin the canonical project without cwd repair", () => {
    const checkout = path.resolve(import.meta.dirname, "..");
    const project = "/fixture/project with spaces";
    const server = {
      command: process.execPath,
      args: [path.join(checkout, "apps/cli/dist/index.js"), "mcp", "--stdio", `--root=${project}`],
    };
    expect(assertQuickstartMcpConfig({ mcpServers: { untangle: server } }, project)).toBe(server);
    expect(() =>
      assertQuickstartMcpConfig({ mcpServers: { untangle: { ...server, cwd: project } } }, project),
    ).toThrow();
    expect(() =>
      assertQuickstartMcpConfig(
        { mcpServers: { untangle: { ...server, args: server.args.slice(0, -1) } } },
        project,
      ),
    ).toThrow();
    expect(() =>
      assertQuickstartMcpConfig(
        { mcpServers: { untangle: { ...server, command: "node" } } },
        project,
      ),
    ).toThrow();
  });
});
