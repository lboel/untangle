#!/usr/bin/env node
/** Real built-CLI LanceDB acceptance. --semantic also requires the configured local Ollama. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureDistManifest,
  captureSourceManifest,
  manifestDigest,
  reserveEvidenceDirectory,
  runEvidenceCommand,
} from "./release-evidence.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "apps/cli/dist/index.js");
const semantic = process.argv.includes("--semantic");
const outFlag = process.argv.find((arg) => arg.startsWith("--out-dir="));
assert(process.argv.slice(2).every((arg) => arg === "--semantic" || arg.startsWith("--out-dir=")));
const output = reserveEvidenceDirectory(
  ROOT,
  outFlag?.slice(10) ?? path.join(ROOT, ".untangle", "lancedb-search", randomUUID()),
);
const root = mkdtempSync(path.join(tmpdir(), "untangle-lancedb-search-"));
const source = captureSourceManifest(ROOT);
const dist = captureDistManifest(ROOT);
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("LanceDB acceptance interrupted."));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  schemaVersion: 1,
  backend: "lancedb",
  semantic,
  sourceDigest: manifestDigest(source),
  distDigest: manifestDigest(dist),
  status: "running",
  commands: [],
  cases: [],
};
const initial = {
  "src/users.ts":
    '/** Find existing user accounts by their unique identifier. */\nexport function getUserById(id: string): string { return id === "42" ? "Ada" : "unknown"; }\n',
  "src/main.ts":
    'import { getUserById } from "./users";\nexport function displayUser(id: string): string { return getUserById(id); }\n',
  "src/orders.ts":
    "/** Sum line item prices to compute the order total. */\nexport function calculate_order_total(prices: number[]): number { return prices.reduce((a, b) => a + b, 0); }\n",
  "src/http.ts":
    'export function HTTPServer(port: number): string { return "listening:" + port; }\n',
  "src/unicode.ts":
    "export function größenÄnderung(width: number, height: number): number { return width / height; }\n",
  "src/retired.ts": 'export function retiredFeatureForDeletion(): string { return "retired"; }\n',
};
const configPath = path.join(root, ".untangle", "config.json");
const config = {
  schemaVersion: 1,
  workspaceId: `lancedb-smoke-${randomUUID()}`,
  repositories: [
    { id: "fixture", path: "..", include: ["src/**/*.ts"], exclude: [".untangle", ".git"] },
  ],
  ...(semantic
    ? {
        embeddings: {
          provider: "ollama",
          mode: "external",
          url: "http://127.0.0.1:11434",
          model: "qwen3-embedding:0.6b",
          dimensions: 1024,
          contextLength: 32768,
          queryPrefix: "search_query: ",
          documentPrefix: "search_document: ",
          includePath: true,
          batchSize: 8,
          maxConnections: 2,
          requestTimeoutMs: 120_000,
        },
      }
    : {}),
};
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("UNTANGLE_") && !key.startsWith("GIT_"),
    ),
  ),
  XDG_CONFIG_HOME: path.join(root, ".untangle", "user-config"),
};
const profileFlags = semantic ? [] : ["--embedder=offline"];
const fixedTime = new Date("2026-01-01T00:00:00.000Z");
let commandNo = 0;
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function storeConfig(value = config) {
  writeFileSync(configPath, JSON.stringify(value, null, 2));
}
async function command(args, expectedExit = 0, extraEnv = {}) {
  const command = [process.execPath, CLI, ...args, `--root=${root}`, "--format=json"];
  const result = await runEvidenceCommand(command, {
    cwd: root,
    env: { ...env, ...extraEnv },
    timeoutMs: 180_000,
    signal: abort.signal,
  });
  const id = `${String(++commandNo).padStart(3, "0")}-${args[0]}`;
  const record = {
    command,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    operationalError: result.operationalError,
  };
  save(path.join(output, "gates", `${id}.json`), record);
  report.commands.push({
    path: `gates/${id}.json`,
    sha256: createHash("sha256")
      .update(readFileSync(path.join(output, "gates", `${id}.json`)))
      .digest("hex"),
    exitCode: result.exitCode,
  });
  assert.equal(
    result.exitCode,
    expectedExit,
    `${args.join(" ")}\n${record.stderr}\n${record.stdout}`,
  );
  return record.stdout.trim() ? JSON.parse(record.stdout) : undefined;
}
const hits = (result) => result.groups.flatMap((group) => group.hits);
async function query(text, mode, flags = [], expected = 0, extraEnv) {
  return command(
    [
      "query",
      text,
      `--mode=${mode}`,
      "--limit=10",
      "--abstention=evidence",
      ...profileFlags,
      ...flags,
    ],
    expected,
    extraEnv,
  );
}
function target(result, symbol, maxRank = 3) {
  const hit = hits(result).find((hit) => hit.symbolName === symbol);
  assert(
    hit && hit.rank <= maxRank,
    `Expected ${symbol} within rank ${maxRank}: ${JSON.stringify(hits(result).map((h) => [h.symbolName, h.rank]))}`,
  );
  return hit;
}
async function fresh(text, symbol, mode = "symbol") {
  const result = await query(text, mode, ["--require-fresh", "--context", "--linked"]);
  assert.equal(result.indexFreshness.status, "fresh");
  target(result, symbol);
  return result;
}
/** Reserve then close our own port; do not stop or reconfigure an existing service. */
async function unavailableEndpoint() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return `http://127.0.0.1:${port}`;
}

async function stale(text) {
  const result = await query(text, "symbol");
  assert.equal(result.indexFreshness.status, "stale");
  await query(text, "symbol", ["--require-fresh"], 4);
}
async function check(name, work) {
  abort.signal.throwIfAborted();
  await work();
  report.cases.push({ name, status: "passed" });
}
try {
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".untangle"), { recursive: true });
  for (const [file, text] of Object.entries(initial)) writeFileSync(path.join(root, file), text);
  storeConfig();
  // XDG_CONFIG_HOME is not the user-config location on macOS. Fail before any
  // index write if the host user could redirect this true-default fixture.
  const { loadConfig } = await import("../packages/config/dist/index.js");
  const loaded = loadConfig({ cwd: root, env });
  assert.equal(
    loaded.sources.userConfigPath,
    undefined,
    "Default LanceDB acceptance requires an unconfigured user; no host database was opened.",
  );
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.sources.envVarsApplied, []);
  assert.deepEqual(loaded.effectiveConfig.storage, {
    backend: "lancedb",
    path: ".untangle/index/lancedb",
  });
  const guard = path.join(root, ".untangle", "network-guard.mjs");
  mkdirSync(path.dirname(guard), { recursive: true });
  writeFileSync(
    guard,
    `import http from 'node:http'; import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module';\nconst forbidden = () => { throw new Error('Offline LanceDB search must not contact HTTP services.'); }; globalThis.fetch = forbidden; http.get = http.request = https.get = https.request = forbidden; syncBuiltinESMExports();\n`,
  );
  if (!semantic) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${guard}`.trim();
  let indexed;
  await check("default embedded offline/service index persists real Lance tables", async () => {
    indexed = await command(["index", ...profileFlags]);
    assert.equal(indexed.outcome, "completed");
    assert.equal(indexed.counts.filesAnalyzed, Object.keys(initial).length);
    const tables = readdirSync(path.join(root, ".untangle/index/lancedb")).filter((name) =>
      name.endsWith(".lance"),
    );
    assert(tables.length > 1);
    report.lanceTables = tables;
  });
  let exact;
  await check(
    "separate processes reopen exact symbols, shared identifier tokens and Unicode",
    async () => {
      exact = await fresh("getUserById", "getUserById");
      for (const [text, symbol] of [
        ["user id", "getUserById"],
        ["calculate order total", "calculate_order_total"],
        ["http server", "HTTPServer"],
        ["größen änderung", "größenÄnderung"],
      ]) {
        const result = await fresh(text, symbol, "lexical");
        assert.equal(result.groups[0].retrieval.branchCandidateCounts.dense, 0);
        assert(result.groups[0].retrieval.branchCandidateCounts.sparse > 0);
      }
      target(await fresh("HTTPServer", "HTTPServer"), "HTTPServer", 1);
      target(await fresh("größenÄnderung", "größenÄnderung"), "größenÄnderung", 1);
      const reopened = await fresh("getUserById", "getUserById");
      assert.equal(target(reopened, "getUserById").chunkId, target(exact, "getUserById").chunkId);
      assert.deepEqual(reopened.groups[0].indexGenerations, [indexed.generationId]);
    },
  );
  await check("MCP reuses the persistent fresh local index with structured evidence", async () => {
    const { DefaultUntangleMcpRuntime } = await import("../apps/cli/dist/mcp/default-runtime.js");
    const { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } =
      await import("../apps/cli/dist/mcp/output-schemas.js");
    const runtime = new DefaultUntangleMcpRuntime();
    const oldFetch = globalThis.fetch;
    if (!semantic)
      globalThis.fetch = () => {
        throw new Error("Offline MCP search must not contact a service.");
      };
    try {
      for (const mode of ["symbol", "lexical"]) {
        const envelope = await runtime.invoke(
          "untangle_search",
          {
            root,
            query: "getUserById",
            mode,
            requireFresh: true,
            includeContext: true,
            includeLinked: true,
            abstention: "evidence",
            limit: 10,
          },
          { cwd: root, env, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) },
        );
        save(path.join(output, "gates", `mcp-${mode}.json`), envelope);
        report.mcpEvidence ??= [];
        report.mcpEvidence.push({
          path: `gates/mcp-${mode}.json`,
          sha256: createHash("sha256")
            .update(readFileSync(path.join(output, "gates", `mcp-${mode}.json`)))
            .digest("hex"),
        });
        assert.equal(envelope.ok, true, JSON.stringify(envelope));
        assert(UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search.safeParse(envelope.data).success);
        assert.equal(envelope.data.indexFreshness.status, "fresh");
        assert.deepEqual(envelope.data.groups[0].indexGenerations, [indexed.generationId]);
        target(envelope.data, "getUserById", 1);
      }
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
  await check("persisted import graph uses the indexed generation", async () => {
    const graph = await command(["graph"]);
    assert.equal(graph.generationId, indexed.generationId);
    assert.equal(graph.metrics.nodeCount, Object.keys(initial).length);
    assert.equal(graph.metrics.edgeCount, 1);
    assert.deepEqual(graph.unresolved, []);
  });
  await check("backend and local-path switches cannot reuse a foreign fresh index", async () => {
    const ownPath = path.join(root, ".untangle/index/lancedb");
    const catalogBefore = readdirSync(ownPath).sort();
    await query("getUserById", "symbol", ["--require-fresh"], 4, {
      UNTANGLE_STORAGE_BACKEND: "qdrant",
      UNTANGLE_QDRANT_MODE: "external",
      UNTANGLE_QDRANT_URL: "http://127.0.0.1:1",
    });
    const alternate = ".untangle/index/alternate-lance";
    await query("getUserById", "symbol", ["--require-fresh"], 4, {
      UNTANGLE_LANCEDB_PATH: alternate,
    });
    assert(!readdirSync(path.join(root, ".untangle/index")).includes("alternate-lance"));
    storeConfig({ ...config, storage: { backend: "lancedb", path: alternate } });
    const otherIndex = await command(["index", ...profileFlags]);
    assert.notEqual(otherIndex.generationId, indexed.generationId);
    const other = await fresh("getUserById", "getUserById");
    assert.deepEqual(other.groups[0].indexGenerations, [otherIndex.generationId]);
    storeConfig();
    const original = await fresh("getUserById", "getUserById");
    assert.deepEqual(original.groups[0].indexGenerations, [indexed.generationId]);
    assert.deepEqual(readdirSync(ownPath).sort(), catalogBefore);
  });
  await check(
    "same-size same-mtime edits invalidate freshness and refresh replaces symbols",
    async () => {
      const file = path.join(root, "src/users.ts");
      utimesSync(file, fixedTime, fixedTime);
      const before = statSync(file);
      writeFileSync(file, readFileSync(file, "utf8").replace("getUserById", "mapUserById"));
      utimesSync(file, fixedTime, fixedTime);
      assert.equal(statSync(file).size, before.size);
      assert.equal(statSync(file).mtimeMs, before.mtimeMs);
      await stale("getUserById");
      const result = await query("mapUserById", "symbol", ["--refresh", "--require-fresh"]);
      assert.equal(result.indexFreshness.status, "fresh");
      target(result, "mapUserById", 1);
      assert(
        !hits(await query("getUserById", "symbol", ["--require-fresh"])).some(
          (hit) => hit.symbolName === "getUserById",
        ),
      );
    },
  );
  await check(
    "added and deleted files invalidate the corpus and refresh prunes old hits",
    async () => {
      const added = path.join(root, "src/added.ts");
      writeFileSync(added, 'export function newlyAddedFeature(): string { return "added"; }\n');
      await stale("newlyAddedFeature");
      target(
        await query("newlyAddedFeature", "symbol", ["--refresh", "--require-fresh"]),
        "newlyAddedFeature",
        1,
      );
      rmSync(path.join(root, "src/retired.ts"));
      await stale("retiredFeatureForDeletion");
      const result = await query("retiredFeatureForDeletion", "symbol", [
        "--refresh",
        "--require-fresh",
      ]);
      assert.equal(result.indexFreshness.status, "fresh");
      assert(!hits(result).some((hit) => hit.filePath === "src/retired.ts"));
    },
  );
  if (semantic) {
    await check(
      "real local model semantic and hybrid search retrieve the intended responsibility",
      async () => {
        await fresh(
          "Find an existing user account by its unique identifier",
          "mapUserById",
          "semantic",
        );
        const result = await fresh("calculate_order_total", "calculate_order_total", "hybrid");
        assert(result.groups[0].retrieval.branchCandidateCounts.dense > 0);
        assert(result.groups[0].retrieval.branchCandidateCounts.sparse > 0);
        assert(result.groups[0].retrieval.branchCandidateCounts.symbol > 0);
      },
    );
    await check(
      "embedding outage preserves independent lexical and symbol paths with honest hybrid failure",
      async () => {
        const offlineProvider = {
          ...config,
          embeddings: {
            ...config.embeddings,
            url: await unavailableEndpoint(),
            requestTimeoutMs: 500,
          },
        };
        storeConfig(offlineProvider);
        await fresh("user id", "mapUserById", "lexical");
        await fresh("mapUserById", "mapUserById");
        const result = await query("mapUserById", "hybrid", ["--require-fresh"], 4);
        target(result, "mapUserById", 1);
        assert(
          result.warnings.some(
            (w) => w.code === "SEARCH_BRANCH_UNAVAILABLE" && w.details?.branch === "dense",
          ),
        );
        assert(result.groups[0].retrieval.branchCandidateCounts.sparse > 0);
        assert(result.groups[0].retrieval.branchCandidateCounts.symbol > 0);
        await query("user account", "semantic", ["--require-fresh"], 4);
        const { DefaultUntangleMcpRuntime } =
          await import("../apps/cli/dist/mcp/default-runtime.js");
        const { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } =
          await import("../apps/cli/dist/mcp/output-schemas.js");
        const envelope = await new DefaultUntangleMcpRuntime().invoke(
          "untangle_search",
          {
            root,
            query: "mapUserById",
            mode: "hybrid",
            requireFresh: true,
            abstention: "evidence",
            limit: 10,
          },
          { cwd: root, env, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) },
        );
        save(path.join(output, "gates", "mcp-provider-outage.json"), envelope);
        report.mcpEvidence.push({
          path: "gates/mcp-provider-outage.json",
          sha256: createHash("sha256")
            .update(readFileSync(path.join(output, "gates", "mcp-provider-outage.json")))
            .digest("hex"),
        });
        assert.equal(envelope.ok, false);
        const partial = envelope.error?.details?.data;
        assert(UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search.safeParse(partial).success);
        assert.equal(partial.indexFreshness.status, "fresh");
        target(partial, "mapUserById", 1);
        assert(
          partial.warnings.some(
            (warning) =>
              warning.code === "SEARCH_BRANCH_UNAVAILABLE" && warning.details?.branch === "dense",
          ),
        );

        storeConfig();
      },
    );
  }
  assert.deepEqual(captureSourceManifest(ROOT), source);
  assert.deepEqual(captureDistManifest(ROOT), dist);
  report.status = "verified";
  process.stdout.write(
    JSON.stringify({ status: report.status, cases: report.cases.length, semantic, output }) + "\n",
  );
} catch (error) {
  report.status = abort.signal.aborted ? "cancelled" : "failed";
  report.error = error.stack ?? String(error);
  process.stderr.write(`${report.error}\n`);
  process.exitCode = abort.signal.aborted ? 130 : 1;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  save(path.join(output, "acceptance.json"), report);
  rmSync(root, { recursive: true, force: true });
}
