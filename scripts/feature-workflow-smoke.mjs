#!/usr/bin/env node
/** Exercise the built CLI and MCP on independent projects, without external services. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const CLI = path.join(ROOT, "apps/cli/dist/index.js");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export function featureWorkflowManifest(language) {
  const extension = language === "python" ? "py" : "ts";
  return {
    schemaVersion: 1,
    owners: [
      {
        id: "accounts-role",
        label: "Fixture accounts role",
        kind: "role",
        status: "declared",
        sources: [{ path: "vision.md", heading: "Accounts" }],
      },
    ],
    features: ["accounts.lookup", "accounts.audit"].map((id) => ({
      id,
      title: id,
      stage: "implemented",
      review: "proposed",
      intent: [
        { role: "vision", path: "vision.md", heading: "Accounts" },
        { role: "specification", path: "spec.md", heading: "Contract" },
      ],
      owners: ["accounts-role"],
      code: {
        include:
          id === "accounts.lookup"
            ? [`src/lookup.${extension}`, `src/shared.${extension}`]
            : [`src/shared.${extension}`],
      },
      tests: { include: id === "accounts.lookup" ? [`src/lookup.test.${extension}`] : [] },
      criteria:
        id === "accounts.lookup"
          ? [
              {
                id: "lookup.regression",
                description: "All lookup cases pass without skips",
                tests: [`src/lookup.test.${extension}`],
              },
            ]
          : [],
      dependsOn: [],
    })),
  };
}

export async function runFeatureWorkflowSmoke(outDir) {
  const output = reserveEvidenceDirectory(ROOT, outDir);
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-feature-workflow-")));
  const sources = captureSourceManifest(ROOT);
  const dist = captureDistManifest(ROOT);
  writeJson(path.join(output, "sources.json"), sources);
  writeJson(path.join(output, "dist.json"), dist);
  const report = {
    schemaVersion: 1,
    status: "running",
    node: process.version,
    sourceDigest: manifestDigest(sources),
    distDigest: manifestDigest(dist),
    cases: [],
    commands: [],
    limitations: [
      "Small controlled projects verify contracts and usability paths; they do not establish productivity gains or generalization to production repositories.",
      "The explicit test adapter consumes Vitest JSON only; Python sources are analyzed, but their tests are not executed by this adapter.",
      "No Sentrux/Sonar scans or services are provisioned by this smoke.",
    ],
  };
  let sequence = 0;
  const cli = async (name, args, expected = 0) => {
    const command = [process.execPath, CLI, ...args];
    const started = performance.now();
    const result = await runEvidenceCommand(command, { cwd: temporary, timeoutMs: 120_000 });
    const base = `${String(++sequence).padStart(2, "0")}-${name}`;
    writeFileSync(path.join(output, "gates", `${base}.stdout`), result.stdout, { flag: "wx" });
    writeFileSync(path.join(output, "gates", `${base}.stderr`), result.stderr, { flag: "wx" });
    report.commands.push({
      name,
      command,
      exitCode: result.exitCode,
      operationalError: result.operationalError ?? null,
      elapsedMs: performance.now() - started,
      stdout: { path: `gates/${base}.stdout`, sha256: sha(result.stdout) },
      stderr: { path: `gates/${base}.stderr`, sha256: sha(result.stderr) },
    });
    assert.equal(result.operationalError, undefined, result.operationalError);
    assert.equal(result.exitCode, expected, result.stderr.toString() + result.stdout.toString());
    return result.stdout.length === 0 || expected === 2
      ? null
      : JSON.parse(result.stdout.toString());
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
  const seed = (language) => {
    const root = path.join(temporary, language);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, ".gitignore"), ".untangle/\n");
    writeFileSync(
      path.join(root, "vision.md"),
      "# Accounts\nFind accounts and inspect lookup responsibilities.\n",
    );
    writeFileSync(
      path.join(root, "spec.md"),
      "# Contract\nEmpty input returns null; known ids are normalized.\n",
    );
    writeJson(path.join(root, "untangle.features.json"), featureWorkflowManifest(language));
    if (language === "python") {
      writeFileSync(
        path.join(root, "src/lookup.py"),
        "from .shared import normalize\n\ndef lookup(value):\n    if not value:\n        return None\n    return normalize(value)\n",
      );
      writeFileSync(
        path.join(root, "src/shared.py"),
        "def normalize(value):\n    return value.strip()\n",
      );
      writeFileSync(
        path.join(root, "src/lookup.test.py"),
        "from .lookup import lookup\n\ndef test_empty():\n    assert lookup('') is None\n",
      );
    } else {
      writeFileSync(
        path.join(root, "src/lookup.ts"),
        "import { normalize } from './shared.js';\nexport function lookup(id: string): string | null {\n  if (!id) return null;\n  return normalize(id);\n}\n",
      );
      writeFileSync(
        path.join(root, "src/shared.ts"),
        "export function normalize(id: string): string { return id.trim(); }\n",
      );
      writeFileSync(path.join(root, "src/unmapped.ts"), "export const unassigned = true;\n");
      writeFileSync(
        path.join(root, "vitest.config.mjs"),
        "export default { test: { include: ['src/**/*.test.ts'] } };\n",
      );
    }
    return root;
  };
  const ts = seed("typescript");
  const python = seed("python");
  const vitestImport = pathToFileURL(path.join(ROOT, "node_modules/vitest/dist/index.js")).href;
  const testFile = path.join(ts, "src/lookup.test.ts");
  const testHeader = `import { test, expect } from ${JSON.stringify(vitestImport)};\nimport { lookup } from './lookup.js';\n`;
  const passing = `${testHeader}test('finds known account', () => expect(lookup(' account ')).toBe('account'));\ntest('rejects empty input', () => expect(lookup('')).toBeNull());\n`;
  const runTests = (name, expected) =>
    cli(
      name,
      [
        "product",
        `--root=${ts}`,
        "--path=src/lookup.ts",
        "--format=json",
        "--run-tests",
        "--",
        process.execPath,
        path.join(ROOT, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        ts,
        "--config",
        path.join(ts, "vitest.config.mjs"),
      ],
      expected,
    );
  const archiveRun = (name, run) => {
    const directory = path.join(output, name);
    cpSync(run.directory, directory, { recursive: true, errorOnExist: true, force: false });
    const receiptBytes = readFileSync(path.join(directory, "receipt.json"));
    const receipt = JSON.parse(receiptBytes.toString());
    for (const artifact of receipt.artifacts)
      assert.equal(sha(readFileSync(path.join(directory, artifact.path))), artifact.sha256);
    report.commands.at(-1).testReceipt = {
      path: `${name}/receipt.json`,
      sha256: sha(receiptBytes),
    };
  };
  try {
    writeFileSync(testFile, passing);
    await check(
      "offline init exposes declared product context without writing configuration",
      async () => {
        const result = await cli("init", ["init", ts, "--offline", "--dry-run", "--format=json"]);
        assert.equal(result.outcome, "would-create");
        assert(result.findings.productContext);
        assert.equal(existsSync(path.join(ts, "untangle.toml")), false);
      },
    );
    await check("repository path resolves responsibility and measures all helpers", async () => {
      const result = await cli("path", [
        "product",
        `--root=${ts}`,
        "--path=src/lookup.ts",
        "--format=json",
      ]);
      assert.equal(result.selection.status, "matched");
      assert.deepEqual(
        result.features.map((feature) => feature.id),
        ["accounts.lookup"],
      );
      assert.deepEqual(
        result.features[0].code.files.map((file) => file.path),
        ["src/lookup.ts", "src/shared.ts"],
      );
      assert.equal(result.features[0].code.complete, true);
      assert.equal(result.features[0].testEvidence.status, "not_run");
      assert.equal(result.features[0].ownership[0].status, "declared");
      assert.deepEqual(result.coverage.sharedFiles[0].featureIds, [
        "accounts.audit",
        "accounts.lookup",
      ]);
    });
    await check(
      "shared paths and intent references resolve every declared association",
      async () => {
        const shared = await cli("shared", [
          "product",
          `--root=${ts}`,
          "--path=src/shared.ts",
          "--format=json",
        ]);
        assert.equal(shared.features.length, 2);
        const intent = await cli("intent", [
          "product",
          `--root=${ts}`,
          "--path=vision.md",
          "--format=json",
        ]);
        assert(
          intent.selection.matches.every(
            (match) => match.roles.includes("intent") && match.roles.includes("ownership"),
          ),
        );
      },
    );
    await check("missing, unassigned and unsafe paths remain explicit", async () => {
      const missing = await cli("missing", [
        "product",
        `--root=${ts}`,
        "--path=src/missing.ts",
        "--format=json",
      ]);
      const unmapped = await cli("unmapped", [
        "product",
        `--root=${ts}`,
        "--path=src/unmapped.ts",
        "--format=json",
      ]);
      assert.equal(missing.selection.status, "missing");
      assert.equal(unmapped.selection.status, "unmapped");
      assert.deepEqual(unmapped.features, []);
      await cli("unsafe", ["product", `--root=${ts}`, "--path=../escape.ts", "--format=json"], 2);
    });
    await check(
      "a separate Python repository receives full AST metrics and honest unexecuted tests",
      async () => {
        const result = await cli("python", [
          "product",
          `--root=${python}`,
          "--path=src/lookup.py",
          "--format=json",
        ]);
        assert.equal(result.features[0].code.complete, true);
        assert.equal(result.features[0].code.metrics.files, 2);
        assert.equal(result.features[0].code.metrics.executionUnitRoots, 2);
        assert.equal(result.features[0].testEvidence.status, "not_run");
      },
    );
    await check(
      "actual Vitest execution binds passed case identities and immutable original reports",
      async () => {
        const result = await runTests("tests-pass", 0);
        assert.equal(result.testRun.status, "completed");
        assert.equal(result.features[0].testEvidence.status, "bound_passed");
        assert.equal(result.features[0].testEvidence.passed, 2);
        assert.equal(result.features[0].criteria[0].status, "passed");
        archiveRun("tests-pass", result.testRun);
      },
    );
    await check(
      "actual failing tests keep failed identities and return the gate exit",
      async () => {
        writeFileSync(
          testFile,
          `${testHeader}test('detects wrong result', () => expect(lookup('x')).toBe('wrong'));\n`,
        );
        const result = await runTests("tests-fail", 5);
        assert.equal(result.features[0].testEvidence.status, "bound_failed");
        assert.equal(result.features[0].testEvidence.failed, 1);
        archiveRun("tests-fail", result.testRun);
      },
    );
    await check("actual skipped tests cannot satisfy acceptance", async () => {
      writeFileSync(testFile, passing + "test.skip('missing scenario', () => {});\n");
      const result = await runTests("tests-skip", 0);
      assert.equal(result.features[0].testEvidence.skipped, 1);
      assert.notEqual(result.features[0].criteria[0].status, "passed");
      archiveRun("tests-skip", result.testRun);
    });
    await check("source writes during a passing test make its evidence stale", async () => {
      writeFileSync(
        testFile,
        `${testHeader}import { writeFileSync } from 'node:fs';\ntest('writes source', () => { writeFileSync(new URL('./generated.ts', import.meta.url), 'export const changed = true;\\n'); expect(lookup('')).toBeNull(); });\n`,
      );
      const result = await runTests("tests-stale", 1);
      assert.equal(result.testRun.status, "stale");
      assert.notEqual(result.features[0].testEvidence.status, "bound_passed");
      archiveRun("tests-stale", result.testRun);
    });
    await check(
      "a complete feature simplification lowers measured control flow with frozen real assertions",
      async () => {
        const sourceFile = path.join(ts, "src/lookup.ts");
        const afterSource = readFileSync(sourceFile, "utf8");
        const beforeSource =
          "import { normalize } from './shared.js';\nexport function lookup(id: string): string | null {\n  if (id) {\n    if (id.trim()) return normalize(id);\n    return '';\n  }\n  return null;\n}\n";
        const frozenTests =
          passing + "test('preserves whitespace result', () => expect(lookup('   ')).toBe(''));\n";
        writeFileSync(testFile, frozenTests);
        writeFileSync(sourceFile, beforeSource);
        const helperHash = sha(readFileSync(path.join(ts, "src/shared.ts")));
        const before = await runTests("simplification-before", 0);
        archiveRun("simplification-before", before.testRun);
        writeFileSync(sourceFile, afterSource);
        const after = await runTests("simplification-after", 0);
        archiveRun("simplification-after", after.testRun);
        assert.equal(sha(readFileSync(testFile)), sha(frozenTests));
        assert.equal(sha(readFileSync(path.join(ts, "src/shared.ts"))), helperHash);
        assert.equal(before.features[0].testEvidence.status, "bound_passed");
        assert.equal(after.features[0].testEvidence.status, "bound_passed");
        assert.equal(before.features[0].testEvidence.passed, 3);
        assert.equal(after.features[0].testEvidence.passed, 3);
        const beforeMetrics = before.features[0].code.metrics;
        const afterMetrics = after.features[0].code.metrics;
        for (const reading of ["top_level", "execution_unit", "self"]) {
          assert(afterMetrics.cognitive[reading] < beforeMetrics.cognitive[reading]);
        }
        assert.equal(beforeMetrics.executionUnitRoots, afterMetrics.executionUnitRoots);
        assert.equal(beforeMetrics.files, 2);
        assert.equal(afterMetrics.files, 2);
        const comparison = {
          beforeSource,
          afterSource,
          frozenTests,
          frozenTestsHash: sha(frozenTests),
          unchangedHelperHash: helperHash,
          beforeMetrics,
          afterMetrics,
          interpretation:
            "Controlled fixture with three frozen behavior cases and all declared helpers measured; this is not a proof of arbitrary program equivalence or production productivity.",
        };
        writeJson(path.join(output, "fixture-simplification.json"), comparison);
        report.fixtureSimplification = {
          path: "fixture-simplification.json",
          sha256: sha(readFileSync(path.join(output, "fixture-simplification.json"))),
        };
      },
    );
    await check(
      "an undeclared repository gets only an explicit unconfirmed stdout draft",
      async () => {
        const root = path.join(temporary, "undeclared");
        mkdirSync(root);
        writeFileSync(
          path.join(root, "main.ts"),
          "export function lookup(id: string) { return id; }\n",
        );
        const result = await cli("draft", [
          "product",
          `--root=${root}`,
          "--draft",
          "--feature=declared.lookup",
          "--path=main.ts",
          "--format=json",
        ]);
        assert.equal(result.status, "needs_manifest");
        assert.equal(result.draft.features[0].id, "declared.lookup");
        assert.equal(result.draft.features[0].review, "proposed");
        assert.equal(result.draft.features[0].stage, "planned");
        assert.deepEqual(result.draft.features[0].owners, []);
        assert.deepEqual(result.draft.features[0].intent, []);
        assert.equal(existsSync(path.join(root, "untangle.features.json")), false);
      },
    );
    await check(
      "built MCP stdio resolves paths and records redacted execution conditions with abandonment",
      async () => {
        const requireCli = createRequire(path.join(ROOT, "apps/cli/package.json"));
        const { Client } = await import(
          pathToFileURL(requireCli.resolve("@modelcontextprotocol/client")).href
        );
        const { StdioClientTransport } = await import(
          pathToFileURL(requireCli.resolve("@modelcontextprotocol/client/stdio")).href
        );
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [CLI, "mcp", "--stdio"],
          cwd: ts,
          stderr: "pipe",
        });
        const client = new Client({ name: "feature-workflow-smoke", version: "1.0.0" });
        try {
          await client.connect(transport);
          const product = await client.callTool({
            name: "untangle_product",
            arguments: { root: ts, path: "src/lookup.ts" },
          });
          assert.equal(product.isError ?? false, false);
          assert.equal(product.structuredContent.data.selection.status, "matched");
          const start = await client.callTool({
            name: "untangle_search_session",
            arguments: {
              root: ts,
              action: "start",
              goal: "Locate account normalization",
              featureId: "accounts.lookup",
              executionContext: {
                agentModel: "fixture-model",
                harness: "fixture-harness",
                searchStrategy: "lexical-first",
                taskClass: "locate-regression",
                taskMix: "fixture-v1",
                priorContext: "empty",
              },
            },
          });
          assert.equal(start.isError ?? false, false);
          const session = start.structuredContent.data.session;
          assert.match(session.executionContext.agentModel.fingerprint, /^[a-f0-9]{64}$/u);
          assert.equal(session.executionContext.agentModel.text, undefined);
          await client.callTool({
            name: "untangle_search_session",
            arguments: {
              root: ts,
              action: "abandon",
              sessionId: session.sessionId,
              reasonCode: "target-not-found",
            },
          });
          const outcome = await client.callTool({
            name: "untangle_search_session",
            arguments: { root: ts, action: "report" },
          });
          assert.equal(outcome.isError ?? false, false);
          assert.equal(
            outcome.structuredContent.data.report.outcomeCohorts[0].terminalCompletionRate,
            0,
          );
          writeJson(path.join(output, "mcp-results.json"), { product, start, outcome });
          report.mcpResults = {
            path: "mcp-results.json",
            sha256: sha(readFileSync(path.join(output, "mcp-results.json"))),
            command: [process.execPath, CLI, "mcp", "--stdio"],
            verification:
              "SDK-asserted structured responses; child exit is not a separately captured command gate.",
          };
        } finally {
          await client.close();
        }
      },
    );
    assert.deepEqual(captureSourceManifest(ROOT), sources, "Source changed during smoke.");
    assert.deepEqual(captureDistManifest(ROOT), dist, "Build output changed during smoke.");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
  } finally {
    writeJson(path.join(output, "report.json"), report);
    rmSync(temporary, { recursive: true, force: true });
  }
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.slice(2).find((value) => value.startsWith("--out-dir="));
  const output =
    arg?.slice("--out-dir=".length) ??
    path.join(tmpdir(), `untangle-feature-evidence-${process.pid}`);
  const result = await runFeatureWorkflowSmoke(output);
  console.log(
    JSON.stringify(
      { status: result.report.status, cases: result.report.cases, output: result.output },
      null,
      2,
    ),
  );
  if (result.report.status !== "passed") process.exitCode = 1;
}
