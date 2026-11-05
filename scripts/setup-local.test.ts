import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

interface Options {
  project?: string;
  skipBuild?: boolean;
  dryRun?: boolean;
  format?: string;
}
interface Execution {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  operationalError?: string;
}
interface Step {
  id: string;
  command: string[];
  exitCode: number;
}
interface Result {
  status: string;
  project: string;
  error?: string;
  steps: Step[];
  plan: Step[];
  analysis: unknown;
  mcpConfig: { mcpServers: { untangle: { command: string; args: string[] } } };
  commands: Record<string, string[]>;
}
interface Dependencies {
  checkout?: string;
  node?: string;
  nodeVersion?: string;
  platform?: string;
  signal?: AbortSignal;
  execute?: (command: string[], context: { cwd: string }) => Promise<Execution>;
}
const setup = (await import(new URL("./setup-local.mjs", import.meta.url).href)) as {
  parseSetupOptions(args: string[], cwd?: string): Options;
  supportsSetupNode(version: string): boolean;
  displaySetupCommand(args: string[]): string;
  runLocalSetup(options: Options, dependencies?: Dependencies): Promise<Result>;
  renderLocalSetup(result: Result): string;
};
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function fixture(built = true) {
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-setup-local-")));
  directories.push(temporary);
  const checkout = path.join(temporary, "checkout with spaces");
  const project = path.join(temporary, "project ' quoted $ literal");
  mkdirSync(path.join(checkout, "apps/cli/dist"), { recursive: true });
  mkdirSync(project);
  writeFileSync(
    path.join(checkout, "package.json"),
    JSON.stringify({ packageManager: "pnpm@10.34.5", engines: { node: "^22.13.0 || >=24.0.0" } }),
  );
  if (built) writeFileSync(path.join(checkout, "apps/cli/dist/index.js"), "// unit fixture\n");
  writeFileSync(path.join(project, "main.ts"), "export const example = true;\n");
  const analysis = {
    schemaVersion: 1,
    root: project,
    filesDiscovered: 1,
    filesAnalyzed: 1,
    totalsReading: "execution_unit",
    totals: { cognitive: 1 },
    hotspots: [],
    skipped: [],
  };
  const calls: { command: string[]; cwd: string }[] = [];
  const dependencies: Dependencies = {
    checkout,
    node: "/actual node/bin/node",
    nodeVersion: "v22.23.3",
    platform: "darwin",
    execute: async (command, context) => {
      calls.push({ command, cwd: context.cwd });
      return {
        exitCode: 0,
        stdout: Buffer.from(
          command[1] === "--version"
            ? "10.34.5\n"
            : command.includes("complexity")
              ? JSON.stringify(analysis)
              : "completed\n",
        ),
        stderr: Buffer.alloc(0),
      };
    },
  };
  return { checkout, project, analysis, calls, dependencies };
}

describe("explicit local checkout setup", () => {
  it("rejects ambiguous flags and preserves paths as literal arguments", () => {
    expect(
      setup.parseSetupOptions(
        ["--project", "a ' path", "--skip-build", "--format=json"],
        "/caller",
      ),
    ).toMatchObject({ project: "/caller/a ' path", skipBuild: true, format: "json" });
    for (const args of [
      ["--unknown"],
      ["--format=yaml"],
      ["--project"],
      ["--project="],
      ["--skip-build=false"],
      ["--dry-run", "--dry-run"],
    ])
      expect(() => setup.parseSetupOptions(args)).toThrow();
    expect(setup.displaySetupCommand(["node", "a ' path; $(literal)"])).toBe(
      "'node' 'a '\\'' path; $(literal)'",
    );
  });

  it("supports the declared stable Node lines and rejects unsupported runtimes", () => {
    for (const version of ["v22.13.0", "22.23.3", "24.0.0", "25.1.0"])
      expect(setup.supportsSetupNode(version)).toBe(true);
    for (const version of ["22.12.9", "23.0.0", "20.19.0", "22.13.0-pre", "unknown"])
      expect(setup.supportsSetupNode(version)).toBe(false);
  });

  it("dry-run needs no existing build and executes no install or analysis", async () => {
    const f = fixture(false);
    const result = await setup.runLocalSetup({ project: f.project, dryRun: true }, f.dependencies);
    expect(result.status).toBe("planned");
    expect(result.plan.map((step) => step.id)).toEqual([
      "pnpm-version",
      "install",
      "build",
      "analysis",
    ]);
    expect(f.calls).toEqual([]);
    expect(result.analysis).toBeNull();
    expect(readFileSync(path.join(f.project, "main.ts"), "utf8")).toBe(
      "export const example = true;\n",
    );
  });

  it("runs frozen checkout install and full build before a root-pinned real-analysis handoff", async () => {
    const f = fixture();
    const result = await setup.runLocalSetup({ project: f.project }, f.dependencies);
    expect(result.status).toBe("ready");
    expect(f.calls.slice(0, 3).map((call) => call.command)).toEqual([
      ["pnpm", "--version"],
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "run", "build"],
    ]);
    expect(f.calls.every((call) => call.cwd === f.checkout)).toBe(true);
    expect(result.analysis).toEqual(f.analysis);
    expect(result.mcpConfig.mcpServers.untangle).toEqual({
      command: "/actual node/bin/node",
      args: [
        path.join(f.checkout, "apps/cli/dist/index.js"),
        "mcp",
        "--stdio",
        `--root=${f.project}`,
      ],
    });
    expect(result.commands["product"]).toContain(`--root=${f.project}`);
    expect(setup.renderLocalSetup(result)).toContain("Analyzed 1 of 1 discovered files");
  });

  it("skip-build avoids package installation and fails honestly if dist is absent", async () => {
    const f = fixture();
    const result = await setup.runLocalSetup(
      { project: f.project, skipBuild: true },
      f.dependencies,
    );
    expect(result.status).toBe("ready");
    expect(f.calls).toHaveLength(1);
    const missing = fixture(false);
    expect(
      (
        await setup.runLocalSetup(
          { project: missing.project, skipBuild: true },
          missing.dependencies,
        )
      ).status,
    ).toBe("failed");
    expect(missing.calls).toEqual([]);
  });

  it.each(["pnpm-version", "install", "build", "analysis"])(
    "stops on a failed %s step",
    async (failedStep) => {
      const f = fixture();
      const execute = f.dependencies.execute!;
      const index = ["pnpm-version", "install", "build", "analysis"].indexOf(failedStep);
      let calls = 0;
      const result = await setup.runLocalSetup(
        { project: f.project },
        {
          ...f.dependencies,
          execute: async (command, context) => {
            const current = calls++;
            return current === index
              ? { exitCode: 7, stdout: Buffer.alloc(0), stderr: Buffer.from("actual failure") }
              : execute(command, context);
          },
        },
      );
      expect(result.status).toBe("failed");
      expect(calls).toBe(index + 1);
      expect(result.analysis).toBeNull();
      expect(setup.renderLocalSetup(result)).toContain("actual failure");
    },
  );

  it("rejects wrong package-manager versions and wrong-project or malformed reports", async () => {
    const f = fixture();
    const wrongVersion = await setup.runLocalSetup(
      { project: f.project },
      {
        ...f.dependencies,
        execute: async () => ({
          exitCode: 0,
          stdout: Buffer.from("9.0.0\n"),
          stderr: Buffer.alloc(0),
        }),
      },
    );
    expect(wrongVersion.status).toBe("failed");
    expect(wrongVersion.steps).toHaveLength(1);
    for (const body of ["not json", JSON.stringify({ ...f.analysis, root: "/other" })]) {
      const invalid = await setup.runLocalSetup(
        { project: f.project, skipBuild: true },
        {
          ...f.dependencies,
          execute: async () => ({
            exitCode: 0,
            stdout: Buffer.from(body),
            stderr: Buffer.alloc(0),
          }),
        },
      );
      expect(invalid.status).toBe("failed");
      expect(invalid.analysis).toBeNull();
      expect(setup.renderLocalSetup(invalid)).not.toContain("MCP configuration");
    }
  });

  it("exposes zero measurement coverage instead of presenting zero as code simplicity", async () => {
    const f = fixture();
    const empty = {
      ...f.analysis,
      filesDiscovered: 1,
      filesAnalyzed: 0,
      totals: { cognitive: 0 },
      skipped: [{ path: "main.ts", reason: "unsupported_language" }],
    };
    const result = await setup.runLocalSetup(
      { project: f.project, skipBuild: true },
      {
        ...f.dependencies,
        execute: async () => ({
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify(empty)),
          stderr: Buffer.alloc(0),
        }),
      },
    );
    expect(result.status).toBe("ready");
    expect(setup.renderLocalSetup(result)).toContain("No analyzable code was measured");
    expect(setup.renderLocalSetup(result)).toContain("1 source entries skipped");
  });

  it("does not start commands under unsupported or already-cancelled conditions", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    for (const dependencies of [
      { ...f.dependencies, nodeVersion: "23.0.0" },
      { ...f.dependencies, platform: "win32" },
      { ...f.dependencies, signal: controller.signal },
    ]) {
      expect((await setup.runLocalSetup({ project: f.project }, dependencies)).status).toBe(
        "failed",
      );
    }
    expect(f.calls).toEqual([]);
  });
});
