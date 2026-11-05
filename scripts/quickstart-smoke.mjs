#!/usr/bin/env node
/** Verify the checkout quick start from an unrelated directory without project writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  captureDistManifest,
  captureSourceManifest,
  manifestDigest,
  reserveEvidenceDirectory,
  runEvidenceCommand,
} from "./release-evidence.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const SETUP = path.join(ROOT, "scripts/setup-local.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

/** The first-value fixture deliberately has no Git, configuration or declared feature map. */
export function createQuickstartFixture(project) {
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(
    path.join(project, "src/lookup.ts"),
    "export function lookup(id: string): string | null {\n  if (!id) return null;\n  return id.trim();\n}\n",
    { flag: "wx" },
  );
  writeFileSync(
    path.join(project, "src/normalize.py"),
    "def normalize(value):\n    if value is None:\n        return ''\n    return value.strip()\n",
    { flag: "wx" },
  );
}

/** Include directories and symlinks so a supposedly read-only command cannot hide extra files. */
export function captureQuickstartTree(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, kind: "symlink", target: readlinkSync(file) });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, kind: "directory" });
        visit(file);
      } else {
        assert(stat.isFile(), `Unsupported fixture entry: ${relative}`);
        entries.push({ path: relative, kind: "file", sha256: sha(readFileSync(file)) });
      }
    }
  };
  visit(root);
  return entries;
}

export function assertQuickstartAnalysis(analysis, project) {
  assert.equal(analysis.schemaVersion, 1);
  assert.equal(analysis.root, project);
  assert.equal(analysis.filesDiscovered, 2);
  assert.equal(analysis.filesAnalyzed, 2);
  assert.equal(analysis.totalsReading, "execution_unit");
  assert.equal(analysis.totals.executionUnitRoots, 2);
  assert(analysis.totals.cognitive > 0, "Fixture branches must be measured.");
  assert.deepEqual(analysis.skipped, [], "Both supported fixture languages must be measured.");
  assert.deepEqual(
    analysis.hotspots.map((hotspot) => `${hotspot.filePath}:${hotspot.name}`).sort(),
    ["src/lookup.ts:lookup", "src/normalize.py:normalize"],
  );
}

/** Validate the generated template without adding cwd or repairing its command arguments. */
export function assertQuickstartMcpConfig(config, project, node = process.execPath) {
  const server = config.mcpServers.untangle;
  assert.equal(server.command, node);
  assert.deepEqual(server.args, [
    path.join(ROOT, "apps/cli/dist/index.js"),
    "mcp",
    "--stdio",
    `--root=${project}`,
  ]);
  assert.equal(server.cwd, undefined, "The generated command must pin its own project root.");
  return server;
}

/** Separate child process makes the real SDK exchange an exit-code-bound evidence command. */
async function probeMcp(configFile, project) {
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const server = assertQuickstartMcpConfig(config, project);
  const requireCli = createRequire(path.join(ROOT, "apps/cli/package.json"));
  const { Client } = await import(
    pathToFileURL(requireCli.resolve("@modelcontextprotocol/client")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(requireCli.resolve("@modelcontextprotocol/client/stdio")).href
  );
  const transport = new StdioClientTransport(server);
  const client = new Client({ name: "untangle-quickstart-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const complexity = await client.callTool({ name: "untangle_complexity", arguments: {} });
    assert.equal(complexity.isError ?? false, false, JSON.stringify(complexity));
    assertQuickstartAnalysis(complexity.structuredContent.data, project);
    const product = await client.callTool({
      name: "untangle_product",
      arguments: { path: "src/lookup.ts" },
    });
    assert.equal(product.isError ?? false, false, JSON.stringify(product));
    assert.equal(product.structuredContent.data.root, project);
    assert.equal(product.structuredContent.data.status, "needs_manifest");
    return {
      schemaVersion: 1,
      status: "passed",
      clientCwd: process.cwd(),
      config,
      complexity,
      product,
    };
  } finally {
    await client.close();
  }
}

export async function runQuickstartSmoke(outDir) {
  const output = reserveEvidenceDirectory(ROOT, outDir);
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-quickstart-")));
  const project = path.join(temporary, "project with spaces");
  const unrelated = path.join(temporary, "unrelated cwd");
  mkdirSync(unrelated);
  writeFileSync(path.join(unrelated, "wrong-project.ts"), "export const wrongProject = true;\n");
  createQuickstartFixture(project);
  const sources = captureSourceManifest(ROOT);
  const dist = captureDistManifest(ROOT);
  const tree = captureQuickstartTree(project);
  const unrelatedTree = captureQuickstartTree(unrelated);
  writeJson(path.join(output, "sources.json"), sources);
  writeJson(path.join(output, "dist.json"), dist);
  writeJson(path.join(output, "project-before.json"), tree);
  const report = {
    schemaVersion: 1,
    status: "running",
    node: process.version,
    sourceDigest: manifestDigest(sources),
    distDigest: manifestDigest(dist),
    fixture: { languages: ["typescript", "python"], hasGit: false, hasConfiguration: false },
    cases: [],
    commands: [],
    limitations: [
      "This smoke uses existing built files with --skip-build. Source and distribution hashes are recorded; build correspondence must be established by the release build gate.",
      "It verifies the index-free checkout workflow and local MCP, not global installation, host-specific MCP registration or optional search/analyzer services.",
      "The MCP command gate records the SDK probe process exit and transcript; the server process exit is managed by the SDK and is not separately attested.",
    ],
  };
  let sequence = 0;
  const command = async (name, argv) => {
    const sourceBefore = captureSourceManifest(ROOT);
    const distBefore = captureDistManifest(ROOT);
    const started = performance.now();
    const result = await runEvidenceCommand(argv, { cwd: unrelated, timeoutMs: 120_000 });
    const base = `${String(++sequence).padStart(2, "0")}-${name}`;
    writeFileSync(path.join(output, "gates", `${base}.stdout`), result.stdout, { flag: "wx" });
    writeFileSync(path.join(output, "gates", `${base}.stderr`), result.stderr, { flag: "wx" });
    const sourceAfter = captureSourceManifest(ROOT);
    const distAfter = captureDistManifest(ROOT);
    report.commands.push({
      name,
      command: argv,
      cwd: unrelated,
      exitCode: result.exitCode,
      signal: result.signal,
      operationalError: result.operationalError ?? null,
      elapsedMs: performance.now() - started,
      sourceBefore: manifestDigest(sourceBefore),
      sourceAfter: manifestDigest(sourceAfter),
      distBefore: manifestDigest(distBefore),
      distAfter: manifestDigest(distAfter),
      stdout: { path: `gates/${base}.stdout`, sha256: sha(result.stdout) },
      stderr: { path: `gates/${base}.stderr`, sha256: sha(result.stderr) },
    });
    assert.deepEqual(sourceBefore, sources, "Source changed before command.");
    assert.deepEqual(sourceAfter, sources, "Source changed during command.");
    assert.deepEqual(distBefore, dist, "Distribution changed before command.");
    assert.deepEqual(distAfter, dist, "Distribution changed during command.");
    assert.equal(result.operationalError, undefined, result.operationalError);
    assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
    assert.equal(result.signal, null);
    assert.deepEqual(captureQuickstartTree(project), tree, `${name} wrote into the target.`);
    assert.deepEqual(
      captureQuickstartTree(unrelated),
      unrelatedTree,
      `${name} wrote into its cwd.`,
    );
    return JSON.parse(result.stdout.toString());
  };
  const check = async (name, action) => {
    try {
      await action();
      report.cases.push({ name, status: "passed" });
    } catch (error) {
      report.cases.push({ name, status: "failed", error: String(error) });
      throw error;
    }
  };
  let setup;
  try {
    await check(
      "dry run is executable from an unrelated cwd and performs no setup steps",
      async () => {
        const planned = await command("dry-run", [
          process.execPath,
          SETUP,
          `--project=${project}`,
          "--dry-run",
          "--format=json",
        ]);
        assert.equal(planned.status, "planned");
        assert.deepEqual(planned.steps, []);
        assert.equal(planned.analysis, null);
        assert.equal(planned.project, project);
      },
    );
    await check(
      "existing checkout analyzes TS and Python without Git, config or services",
      async () => {
        setup = await command("setup", [
          process.execPath,
          SETUP,
          `--project=${project}`,
          "--skip-build",
          "--format=json",
        ]);
        assert.equal(setup.status, "ready");
        assert.deepEqual(
          setup.steps.map((step) => step.id),
          ["analysis"],
        );
        assertQuickstartAnalysis(setup.analysis, project);
        assertQuickstartMcpConfig(setup.mcpConfig, project);
        writeJson(path.join(output, "mcp-config.json"), setup.mcpConfig);
      },
    );
    await check("generated analysis argv works unchanged from another cwd", async () => {
      assertQuickstartAnalysis(await command("analysis-argv", setup.commands.complexity), project);
    });
    await check("generated init preview argv remains read-only", async () => {
      const preview = await command("init-preview-argv", setup.commands.initPreview);
      assert.equal(preview.outcome, "would-create");
    });
    await check("generated product argv reports missing declarations honestly", async () => {
      const product = await command("product-argv", setup.commands.product);
      assert.equal(product.root, project);
      assert.equal(product.status, "needs_manifest");
    });
    await check("a declared feature starts as an unconfirmed stdout draft", async () => {
      const draft = await command("product-draft", [
        process.execPath,
        path.join(ROOT, "apps/cli/dist/index.js"),
        "product",
        `--root=${project}`,
        "--draft",
        "--feature=example.lookup",
        "--path=src/lookup.ts",
        "--format=json",
      ]);
      assert.equal(draft.status, "needs_manifest");
      assert.equal(draft.draft.features[0].id, "example.lookup");
      assert.equal(draft.draft.features[0].stage, "planned");
      assert.equal(draft.draft.features[0].review, "proposed");
      assert.deepEqual(draft.draft.features[0].owners, []);
      assert.deepEqual(draft.draft.features[0].code.include, ["src/lookup.ts"]);
    });
    await check(
      "generated MCP config pins the project without transport cwd or tool root arguments",
      async () => {
        const result = await command("mcp-generated-config", [
          process.execPath,
          SCRIPT,
          "--mcp-probe",
          `--config=${path.join(output, "mcp-config.json")}`,
          `--project=${project}`,
        ]);
        assert.equal(result.status, "passed");
        assert.equal(result.clientCwd, unrelated);
        assert.deepEqual(result.config, setup.mcpConfig);
      },
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
  } finally {
    const finalTree = captureQuickstartTree(project);
    writeJson(path.join(output, "project-after.json"), finalTree);
    report.projectUnchanged = JSON.stringify(tree) === JSON.stringify(finalTree);
    if (!report.projectUnchanged) report.status = "failed";
    writeJson(path.join(output, "report.json"), report);
    rmSync(temporary, { recursive: true, force: true });
  }
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  const args = process.argv.slice(2);
  if (args.includes("--mcp-probe")) {
    const config = args.find((arg) => arg.startsWith("--config="))?.slice("--config=".length);
    const project = args.find((arg) => arg.startsWith("--project="))?.slice("--project=".length);
    assert(config && project, "MCP probe requires --config and --project.");
    console.log(JSON.stringify(await probeMcp(config, project)));
  } else {
    const outDir =
      args.find((arg) => arg.startsWith("--out-dir="))?.slice("--out-dir=".length) ??
      path.join(tmpdir(), `untangle-quickstart-evidence-${process.pid}`);
    assert(
      args.every((arg) => arg.startsWith("--out-dir=")),
      "Unknown quickstart smoke option.",
    );
    const result = await runQuickstartSmoke(outDir);
    console.log(
      JSON.stringify(
        { status: result.report.status, cases: result.report.cases, output: result.output },
        null,
        2,
      ),
    );
    if (result.report.status !== "passed") process.exitCode = 1;
  }
}
