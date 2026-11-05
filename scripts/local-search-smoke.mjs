#!/usr/bin/env node
/**
 * Real local search acceptance against the built CLI, Qdrant on its own
 * Untangle port and an installed qwen3 embedding model. No fake store or vectors.
 *
 * Run after `pnpm build`: node scripts/local-search-smoke.mjs
 * Requires http://127.0.0.1:16333 and http://127.0.0.1:11434. The services
 * are never started, stopped or reconfigured. Each run owns a temporary Git
 * repository and a UUID collection prefix; cleanup touches only those resources.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_INDEX_CONFIG } from "../packages/config/dist/index.js";
import {
  canonicalJson,
  CHUNKER_VERSION,
  knownParserLanguages,
  parserVersionForLanguage,
  sha256Hex,
} from "../packages/domain/dist/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(REPO_ROOT, "apps/cli/dist/index.js");
const QDRANT_URL = "http://127.0.0.1:16333";
const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = "qwen3-embedding:0.6b";
const DIMENSIONS = 1024;
const FIXED_MTIME = new Date("2026-01-01T00:00:00.000Z");
const runId = randomUUID().replaceAll("-", "");
const collectionPrefix = `untangle_search_smoke_${runId}_`;
const abort = new AbortController();
const checks = [];
const children = new Set();
let fixtureRoot;

const sources = {
  "src/users.ts": `/** Retrieve an existing user account by its unique identifier from the directory. */
export function getUserById(id: string): { id: string; name: string } | undefined {
  const users = new Map([["42", { id: "42", name: "Ada" }]]);
  return users.get(id);
}
`,
  "src/orders.ts": `/** Calculate the total price of an order from item prices. */
export function calculate_order_total(prices: number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
`,
  "src/http.ts": `/** Start the HTTP server that accepts incoming web requests. */
export function HTTPServer(port: number): string {
  return "listening:" + port;
}
`,
  "src/unicode.ts": `/** Change the dimensions of an image while preserving its aspect ratio. */
export function größenÄnderung(width: number, height: number): number {
  return width / height;
}
`,
  "src/retired.ts": `/** A fixture capability that will be deleted after the initial index. */
export function retiredFeatureForDeletion(): string {
  return "retired";
}
`,
  "src/search-engine.ts": [
    "export class HybridSearchEngine {",
    "  private enrichFinalHits(value: number): number {",
    `    const diagnostic = "${"diagnostic ".repeat(90)}";`,
    "    let result = value;",
    ...Array.from({ length: 250 }, (_, i) => `    result += value + ${i};`),
    "    return result + diagnostic.length;",
    "  }",
    "  run(value: number): number { return this.enrichFinalHits(value); }",
    "}",
    "",
  ].join("\n"),
  "docs/retries.md": `# Retry policy\n\nTransient network failures use exponential retry backoff.
The first retry waits one second. Later retries double the waiting interval.
After four failed attempts the caller receives the original error.
`,
  "docs/cache.md": `# Cache policy\n\nCached currency conversion rates expire after five minutes.
Expired entries are discarded before a fresh exchange rate is stored.
`,
};

function signalStop(signal) {
  abort.abort(new Error(`Interrupted by ${signal}`));
  for (const child of children) child.kill("SIGTERM");
}
const onSigint = () => signalStop("SIGINT");
const onSigterm = () => signalStop("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

/** Do not inherit routing/configuration or Git overrides from the caller. */
function childEnvironment() {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("UNTANGLE_") && !key.startsWith("GIT_"),
      ),
    ),
    // Keep every write inside this run's namespace even if config discovery regresses.
    UNTANGLE_QDRANT_MODE: "external",
    UNTANGLE_QDRANT_URL: QDRANT_URL,
    UNTANGLE_QDRANT_COLLECTION_PREFIX: collectionPrefix,
  };
}

async function command(binary, args, timeoutMs = 180_000, { onStdout, onSpawn, cwd } = {}) {
  abort.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: cwd ?? fixtureRoot,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    onSpawn?.(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hardKill;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const capture = (channel) => (chunk) => {
      if (channel === "stdout") {
        stdout += chunk;
        onStdout?.(stdout);
      } else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 8 * 1024 * 1024) {
        timedOut = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(hardKill);
      children.delete(child);
      if (timedOut || abort.signal.aborted) {
        reject(
          new Error(`Command interrupted: ${binary} ${args.join(" ")}\n${stderr.slice(-4000)}`),
        );
      } else {
        resolve({ code, signal, stdout, stderr });
      }
    });
  });
}

function requireExit(result, expected, label) {
  assert.equal(
    result.code,
    expected,
    `${label}: expected exit ${expected}, received ${result.code}\n${result.stderr}\n${result.stdout}`,
  );
}

function jsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${label}: stdout is not one JSON document\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function hits(result) {
  return result.groups.flatMap((group) => group.hits);
}

async function query(text, mode, flags = [], expectedExit = 0) {
  const label = `${mode}: ${text}`;
  const started = performance.now();
  const result = await command(
    process.execPath,
    [
      CLI,
      "query",
      text,
      `--mode=${mode}`,
      "--format=json",
      "--limit=10",
      "--abstention=evidence",
      "--timeout=20000",
      ...flags,
    ],
    30_000,
  );
  requireExit(result, expectedExit, label);
  const output = jsonOutput(result, label);
  checks.push({
    check: label,
    flags,
    exitCode: result.code,
    freshness: output.indexFreshness?.status,
    hits: hits(output).map((hit) => ({
      file: hit.filePath,
      symbol: hit.symbolName,
      rank: hit.rank,
    })),
    warnings: output.warnings.map((warning) => warning.code),
    durationMs: Math.round(performance.now() - started),
  });
  return output;
}

function targetRank(result, symbol) {
  return hits(result).find((hit) => hit.symbolName === symbol)?.rank;
}

function requireTarget(result, symbol, maximumRank = 3) {
  const rank = targetRank(result, symbol);
  assert.ok(
    rank !== undefined && rank <= maximumRank,
    `${symbol}: expected rank <= ${maximumRank}, got ${rank}`,
  );
}

async function requestJson(base, endpoint, init = {}) {
  const response = await fetch(new URL(endpoint, base), {
    ...init,
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
  });
  assert.ok(response.ok, `${base}${endpoint}: HTTP ${response.status}`);
  return response.json();
}

function fixtureConfig(workspaceId, repositories) {
  return {
    schemaVersion: 1,
    workspaceId,
    projectId: "local-search-smoke",
    repositories,
    qdrant: {
      mode: "external",
      url: QDRANT_URL,
      collectionPrefix,
      requestTimeoutMs: 10_000,
    },
    embeddings: {
      provider: "ollama",
      mode: "external",
      url: OLLAMA_URL,
      model: MODEL,
      dimensions: DIMENSIONS,
      contextLength: 32768,
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      includePath: true,
      batchSize: 8,
      maxConnections: 2,
      requestTimeoutMs: 120_000,
    },
    search: { defaultLimit: 10, defaultCandidateLimit: 50, maxCandidateLimit: 200 },
    telemetry: { enabled: false },
  };
}

async function initializeGitRepo(root) {
  await writeFile(path.join(root, ".gitignore"), ".untangle/\n.untangle.local.json\n");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "core.hooksPath", "/dev/null"],
    ["add", "."],
    [
      "-c",
      "user.name=Untangle Search Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "search acceptance fixture",
    ],
  ])
    requireExit(await command("git", args, 30_000, { cwd: root }), 0, `git ${args[0]}`);
}

async function prepareFixture() {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "untangle-local-search-"));
  for (const [file, contents] of Object.entries(sources)) {
    const target = path.join(fixtureRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    await utimes(target, FIXED_MTIME, FIXED_MTIME);
  }
  const config = fixtureConfig(`local-search-smoke-${runId}`, [
    {
      id: "fixture",
      path: ".",
      label: "local search fixture",
      include: ["src/**/*.ts", "docs/**/*.md"],
      exclude: [".git", ".untangle", "node_modules"],
    },
  ]);
  await writeFile(path.join(fixtureRoot, ".untangle.json"), JSON.stringify(config, null, 2));
  await initializeGitRepo(fixtureRoot);
}

async function requireFreshGate(text) {
  const result = await command(process.execPath, [
    CLI,
    "query",
    text,
    "--mode=symbol",
    "--format=json",
    "--require-fresh",
  ]);
  requireExit(result, 4, "require-fresh must reject stale sources");
  assert.match(result.stderr, /stale/u);
  checks.push({ check: "require-fresh refuses stale sources", query: text, exitCode: result.code });
}

/** Allocate and close an owned port; connection refusal does not stop the user's daemon. */
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

async function checkOutage(profileId) {
  const localConfig = path.join(fixtureRoot, ".untangle.local.json");
  await writeFile(
    localConfig,
    JSON.stringify({
      embeddings: { mode: "external", url: await unavailableEndpoint(), requestTimeoutMs: 500 },
    }),
  );
  try {
    for (const [text, mode, symbol] of [
      ["user id", "lexical", "getUserById"],
      ["getUserById", "symbol", "getUserById"],
    ]) {
      const result = await query(text, mode);
      requireTarget(result, symbol);
      assert.equal(
        result.groups[0].embeddingProfileId,
        profileId,
        "outage must preserve the indexed embedding profile",
      );
      assert.equal(result.indexFreshness.status, "fresh");
      assert.ok(!result.warnings.some((warning) => warning.code === "SEARCH_BRANCH_UNAVAILABLE"));
    }
    const partial = await query("getUserById", "hybrid", [], 4);
    requireTarget(partial, "getUserById", 1);
    assert.equal(partial.groups[0].embeddingProfileId, profileId);
    assert.ok(
      partial.warnings.some(
        (warning) =>
          warning.code === "SEARCH_BRANCH_UNAVAILABLE" && warning.details?.branch === "dense",
      ),
    );
    assert.ok(
      partial.skipped.some(
        (entry) => entry.reason === "provider_unavailable" && entry.detail.includes('"dense"'),
      ),
    );
    assert.ok(partial.groups[0].retrieval.branchCandidateCounts.sparse > 0);
    assert.ok(partial.groups[0].retrieval.branchCandidateCounts.symbol > 0);
    await checkMcpOutage(profileId);
    const semantic = await command(
      process.execPath,
      [
        CLI,
        "query",
        "Benutzer anhand seiner Kennung finden",
        "--mode=semantic",
        "--format=json",
        "--timeout=20000",
      ],
      30_000,
    );
    requireExit(semantic, 4, "semantic must fail honestly while Ollama is unavailable");
    if (semantic.stdout.trim() !== "")
      assert.equal(hits(jsonOutput(semantic, "semantic outage")).length, 0);
    checks.push({ check: "semantic refuses unavailable embedding", exitCode: semantic.code });
  } finally {
    await rm(localConfig, { force: true });
  }
}

/** Invoke the built MCP runtime over the same real Qdrant fixture and unavailable provider. */
async function checkMcpOutage(profileId) {
  const { DefaultUntangleMcpRuntime } = await import(
    new URL("../apps/cli/dist/mcp/default-runtime.js", import.meta.url).href
  );
  const { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } = await import(
    new URL("../apps/cli/dist/mcp/output-schemas.js", import.meta.url).href
  );
  const runtime = new DefaultUntangleMcpRuntime();
  for (const mode of ["lexical", "symbol", "hybrid"]) {
    const started = performance.now();
    const envelope = await runtime.invoke(
      "untangle_search",
      {
        root: fixtureRoot,
        query: "getUserById",
        mode,
        abstention: "evidence",
        limit: 10,
        requireFresh: true,
      },
      {
        cwd: fixtureRoot,
        env: childEnvironment(),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      },
    );
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.operation, "untangle_search");
    assert.equal(envelope.ok, mode !== "hybrid");
    const data = envelope.ok ? envelope.data : envelope.error?.details?.data;
    assert.ok(
      UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search.safeParse(data).success,
      "MCP must preserve valid structured search data even in an honest partial failure",
    );
    requireTarget(data, "getUserById", 1);
    assert.equal(data.indexFreshness.status, "fresh");
    assert.equal(data.groups[0].embeddingProfileId, profileId);
    if (mode === "hybrid") {
      assert.ok(envelope.error);
      assert.ok(
        envelope.warnings.some((warning) => warning.code === "SEARCH_BRANCH_UNAVAILABLE"),
        "MCP failure envelope must preserve the branch warning",
      );
      assert.ok(data.warnings.some((warning) => warning.code === "SEARCH_BRANCH_UNAVAILABLE"));
    } else {
      assert.ok(!data.warnings.some((warning) => warning.code === "SEARCH_BRANCH_UNAVAILABLE"));
    }
    checks.push({
      check: `MCP ${mode} preserves real search results during provider outage`,
      ok: envelope.ok,
      errorCode: envelope.error?.code,
      targetRank: targetRank(data, "getUserById"),
      warnings: envelope.warnings.map((warning) => warning.code),
      durationMs: Math.round(performance.now() - started),
    });
  }
}

/** A real TCP connection that never responds exercises the hybrid branch deadline. */
async function checkHungEmbedding(profileId) {
  const sockets = new Set();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.resume();
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const localConfig = path.join(fixtureRoot, ".untangle.local.json");
  try {
    await writeFile(
      localConfig,
      JSON.stringify({
        embeddings: {
          mode: "external",
          url: `http://127.0.0.1:${port}`,
          requestTimeoutMs: 120_000,
        },
      }),
    );
    const started = performance.now();
    const partial = await query("getUserById", "hybrid", [], 4);
    const durationMs = Math.round(performance.now() - started);
    requireTarget(partial, "getUserById", 1);
    assert.equal(partial.groups[0].embeddingProfileId, profileId);
    assert.equal(partial.indexFreshness.status, "fresh");
    assert.ok(connections > 0, "the real embedder must attempt the hanging network endpoint");
    const timeout = partial.warnings.find(
      (warning) => warning.code === "SEARCH_BRANCH_TIMEOUT" && warning.details?.branch === "dense",
    );
    assert.ok(timeout, "hybrid must report the dense branch deadline");
    assert.ok(
      partial.warnings.some(
        (warning) =>
          warning.code === "SEARCH_BRANCH_UNAVAILABLE" &&
          warning.details?.branch === "dense" &&
          warning.details?.timedOut === true,
      ),
    );
    assert.ok(partial.groups[0].retrieval.branchCandidateCounts.sparse > 0);
    assert.ok(partial.groups[0].retrieval.branchCandidateCounts.symbol > 0);
    assert.ok(
      durationMs < timeout.details.timeoutMs + 5_000,
      "fallback must return near the branch deadline, before the 20-second overall timeout",
    );
    checks.push({
      check: "hybrid survives hung embedding transport",
      exitCode: 4,
      connections,
      branchTimeoutMs: timeout.details.timeoutMs,
      durationMs,
    });
  } finally {
    await rm(localConfig, { force: true });
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function checkFreshness() {
  const usersFile = path.join(fixtureRoot, "src/users.ts");
  const before = await stat(usersFile);
  await writeFile(
    usersFile,
    (await readFile(usersFile, "utf8")).replace("getUserById", "mapUserById"),
  );
  await utimes(usersFile, FIXED_MTIME, FIXED_MTIME);
  const after = await stat(usersFile);
  assert.equal(after.mtimeMs, before.mtimeMs, "mutation must preserve mtime");
  assert.equal(after.size, before.size, "mutation must preserve file size");
  const changed = await query("getUserById", "symbol");
  assert.equal(
    changed.indexFreshness.status,
    "stale",
    "content changes must be detected despite identical size/mtime",
  );
  await requireFreshGate("getUserById");
  const refreshed = await query("mapUserById", "symbol", ["--refresh"]);
  assert.equal(refreshed.indexFreshness.status, "fresh");
  requireTarget(refreshed, "mapUserById", 1);
  assert.equal(
    targetRank(await query("getUserById", "symbol", ["--require-fresh"]), "getUserById"),
    undefined,
  );

  await writeFile(
    path.join(fixtureRoot, "src/added.ts"),
    "export function newlyAddedFeature(): string { return 'added'; }\n",
  );
  const added = await query("newlyAddedFeature", "symbol");
  assert.equal(added.indexFreshness.status, "stale", "new source files must invalidate freshness");
  await requireFreshGate("newlyAddedFeature");
  const addedFresh = await query("newlyAddedFeature", "symbol", ["--refresh"]);
  assert.equal(addedFresh.indexFreshness.status, "fresh");
  requireTarget(addedFresh, "newlyAddedFeature", 1);

  await rm(path.join(fixtureRoot, "src/retired.ts"));
  const deleted = await query("retiredFeatureForDeletion", "symbol");
  assert.equal(
    deleted.indexFreshness.status,
    "stale",
    "deleted source files must invalidate freshness",
  );
  await requireFreshGate("retiredFeatureForDeletion");
  const deletedFresh = await query("retiredFeatureForDeletion", "symbol", ["--refresh"]);
  assert.equal(deletedFresh.indexFreshness.status, "fresh");
  assert.equal(targetRank(deletedFresh, "retiredFeatureForDeletion"), undefined);
  assert.ok(
    !hits(deletedFresh).some((hit) => hit.filePath === "src/retired.ts"),
    "deleted file must disappear from search",
  );
}

/** Wait for the real watcher to inspect a fresh index before changing its sources. */
async function checkIndexWatch() {
  let watcher;
  let observedBytes = 0;
  let settled = false;
  let resolveChecked;
  let rejectChecked;
  const checked = new Promise((resolve, reject) => {
    resolveChecked = resolve;
    rejectChecked = reject;
  });
  const readyTimeout = setTimeout(
    () => rejectChecked(new Error("watch --index did not emit its first check in 30 seconds")),
    30_000,
  );
  const watchDone = command(
    process.execPath,
    [CLI, "watch", "--index", "--format=json", "--reconcile=200", "--exit-after=1"],
    180_000,
    {
      onSpawn: (child) => {
        watcher = child;
      },
      onStdout: (output) => {
        let newline;
        while ((newline = output.indexOf("\n", observedBytes)) !== -1) {
          const line = output.slice(observedBytes, newline);
          observedBytes = newline + 1;
          if (line.trim() === "") continue;
          try {
            const event = JSON.parse(line);
            if (event.kind === "index_watch" && event.event === "checked") resolveChecked(event);
          } catch (error) {
            rejectChecked(error);
          }
        }
      },
    },
  ).finally(() => {
    settled = true;
  });
  try {
    const initial = await Promise.race([
      checked,
      watchDone.then((result) => {
        throw new Error(
          `watch --index stopped before readiness\n${result.stderr}\n${result.stdout}`,
        );
      }),
    ]);
    clearTimeout(readyTimeout);
    assert.equal(initial.indexFreshness.status, "fresh");
    assert.equal(initial.refreshes, 0);
    await writeFile(
      path.join(fixtureRoot, "src/watch-added.ts"),
      "export function watchedFeatureAdded(): string { return 'watched'; }\n",
    );
    const result = await watchDone;
    requireExit(result, 0, "watch --index polling refresh");
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.every((event) => event.kind === "index_watch"));
    assert.ok(
      events.some((event) => event.event === "checked" && event.indexFreshness.status === "stale"),
      "watch must detect the newly added file on a later polling pass",
    );
    assert.ok(events.some((event) => event.event === "refresh_started"));
    assert.ok(
      events.some(
        (event) =>
          event.event === "refreshed" &&
          event.refreshes === 1 &&
          event.indexFreshness.status === "fresh",
      ),
    );
    assert.equal(events.at(-1).event, "stopped");
    assert.equal(events.at(-1).indexFreshness.status, "fresh");
    checks.push({
      check: "watch --index polling refresh",
      exitCode: result.code,
      events: events.map((event) => ({
        event: event.event,
        refreshes: event.refreshes,
        freshness: event.indexFreshness?.status,
      })),
    });
    requireTarget(
      await query("watchedFeatureAdded", "symbol", ["--require-fresh"]),
      "watchedFeatureAdded",
      1,
    );
  } finally {
    clearTimeout(readyTimeout);
    if (!settled) {
      watcher?.kill("SIGTERM");
      await watchDone.catch(() => {});
    }
  }
}

/** Mark only this run's persisted snapshot as pre-v2, then exercise the real migration gate. */
async function checkLexicalMigration() {
  const records = path.join(fixtureRoot, ".untangle/index-states-v1/records");
  const recordPaths = (await readdir(records)).filter((name) => name.endsWith(".json"));
  assert.equal(
    recordPaths.length,
    1,
    "the single-repository fixture must have one current profile",
  );
  const statePath = path.join(records, recordPaths[0]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.lexicalTokenizerVersion, "untangle-identifier-tokenizer-v2");
  await writeFile(
    statePath,
    JSON.stringify({ ...state, lexicalTokenizerVersion: "untangle-identifier-tokenizer-v1" }),
  );
  const gated = await command(process.execPath, [
    CLI,
    "query",
    "user id",
    "--mode=lexical",
    "--format=json",
    "--require-fresh",
  ]);
  requireExit(gated, 4, "legacy lexical format must require reindexing");
  assert.match(gated.stderr, /incompatible/u);
  checks.push({ check: "legacy lexical snapshot requires reindexing", exitCode: gated.code });
  const refreshed = await query("mapUserById", "lexical", ["--refresh"]);
  requireTarget(refreshed, "mapUserById", 1);
  assert.equal(refreshed.indexFreshness.status, "fresh");
  const migrated = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(migrated.lexicalTokenizerVersion, "untangle-identifier-tokenizer-v2");
  assert.notEqual(migrated.generationId, state.generationId, "legacy generation must not resume");
  checks.push({
    check: "lexical migration publishes a fresh v2 generation",
    lexicalTokenizerVersion: migrated.lexicalTokenizerVersion,
    generationReplaced: true,
  });
}

/** The same sources and lexical format must rebuild when the chunk semantics change. */
async function checkChunkerMigration() {
  const records = path.join(fixtureRoot, ".untangle/index-states-v1/records");
  const recordNames = (await readdir(records)).filter((name) => name.endsWith(".json"));
  assert.equal(recordNames.length, 1);
  const statePath = path.join(records, recordNames[0]);
  const config = JSON.parse(await readFile(path.join(fixtureRoot, ".untangle.json"), "utf8"));
  const repository = config.repositories[0];
  const fingerprintInput = {
    // Hold parser semantics fixed so migration varies only the chunker version.
    parserVersions: knownParserLanguages().map((language) => [
      language,
      parserVersionForLanguage(language),
    ]),
    maxFileSizeMb: config.index?.maxFileSizeMb ?? DEFAULT_INDEX_CONFIG.maxFileSizeMb,
    maxChunkTokens: config.index?.maxChunkTokens ?? DEFAULT_INDEX_CONFIG.maxChunkTokens,
    include: repository.include ?? [],
    exclude: repository.exclude ?? [],
  };
  const currentFingerprint = sha256Hex(
    canonicalJson({ chunkerVersion: CHUNKER_VERSION, ...fingerprintInput }),
  );
  for (const chunkerVersion of [undefined, "untangle-chunker-v1"]) {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.lexicalTokenizerVersion, "untangle-identifier-tokenizer-v2");
    assert.equal(state.indexConfigFingerprint, currentFingerprint);
    const legacyFingerprint = sha256Hex(canonicalJson({ chunkerVersion, ...fingerprintInput }));
    assert.notEqual(legacyFingerprint, currentFingerprint);
    await writeFile(
      statePath,
      JSON.stringify({ ...state, indexConfigFingerprint: legacyFingerprint }),
    );
    const gated = await command(process.execPath, [
      CLI,
      "query",
      "enrichFinalHits",
      "--mode=symbol",
      "--format=json",
      "--require-fresh",
    ]);
    requireExit(gated, 4, "legacy chunk semantics must require reindexing");
    assert.match(gated.stderr, /stale/u);
    checks.push({
      check: "legacy chunker snapshot requires reindexing",
      chunkerVersion: chunkerVersion ?? "unversioned",
      exitCode: gated.code,
    });
    const stale = await query("enrichFinalHits", "symbol");
    assert.equal(stale.indexFreshness.status, "stale");
    assert.equal(stale.indexFreshness.repositories[0].reason, "index_configuration_changed");
    const result = await command(process.execPath, [CLI, "index", "--format=json"]);
    requireExit(result, 0, "default index must rebuild source-identical legacy chunks");
    const rebuilt = jsonOutput(result, "chunker migration index");
    assert.equal(rebuilt.outcome, "completed");
    assert.notEqual(rebuilt.generationId, state.generationId, "legacy generation must not resume");
    assert.equal(rebuilt.counts.filesUnchanged, 0, "every unchanged file must be rewritten");
    assert.ok(rebuilt.counts.filesAnalyzed > 0);
    assert.ok(rebuilt.counts.points > 0);
    const migrated = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(migrated.indexConfigFingerprint, currentFingerprint);
    assert.equal(migrated.lexicalTokenizerVersion, state.lexicalTokenizerVersion);
    assert.equal(migrated.corpusRevisionFingerprint, state.corpusRevisionFingerprint);
    checks.push({
      check: "chunker migration rewrites source-identical files in a fresh generation",
      chunkerVersion: chunkerVersion ?? "unversioned",
      generationReplaced: true,
      filesUnchanged: rebuilt.counts.filesUnchanged,
      filesAnalyzed: rebuilt.counts.filesAnalyzed,
      points: rebuilt.counts.points,
    });
    const fresh = await query("HybridSearchEngine.enrichFinalHits", "symbol", ["--require-fresh"]);
    requireTarget(fresh, "enrichFinalHits", 1);
    assert.equal(fresh.indexFreshness.status, "fresh");
    assert.ok(
      hits(fresh)
        .filter((hit) => hit.symbolName === "enrichFinalHits")
        .every((hit) => hit.indexGeneration === rebuilt.generationId),
    );
    const points = await ownedQdrantRequest(rebuilt.collection, "/points/scroll", {
      filter: {
        must: [
          { key: "workspace_id", match: { value: rebuilt.workspaceId } },
          { key: "repo_id", match: { value: rebuilt.repoId } },
          { key: "ref_id", match: { value: rebuilt.refId } },
          { key: "symbol_name", match: { value: "enrichFinalHits" } },
        ],
      },
      limit: 100,
      with_payload: true,
      with_vector: false,
    });
    assert.ok(points.points.length > 1, "the large method must retain all searchable fragments");
    assert.ok(
      points.points.every(
        (point) =>
          point.payload.chunker_version === CHUNKER_VERSION &&
          point.payload.generation_id === rebuilt.generationId &&
          point.payload.chunk_kind === "symbol_fragment" &&
          typeof point.payload.symbol_id === "string",
      ),
    );
  }
}

/** Losing the registry must not resurrect a checkpoint whose lexical format is unverified. */
async function checkMissingRegistryMigration() {
  const stateRoot = path.join(fixtureRoot, ".untangle");
  const records = path.join(stateRoot, "index-states-v1/records");
  const recordName = (await readdir(records)).find((name) => name.endsWith(".json"));
  assert.ok(recordName);
  const previous = JSON.parse(await readFile(path.join(records, recordName), "utf8"));
  const jobs = path.join(stateRoot, "jobs");
  const checkpoints = (await readdir(jobs)).filter((name) => name.endsWith(".json"));
  assert.ok(checkpoints.length > 0, "the old checkpoint must exist before registry removal");
  await rm(path.join(stateRoot, "index-states-v1"), { recursive: true });
  await rm(path.join(stateRoot, "index-state.json"), { force: true });
  for (const checkpoint of checkpoints) await access(path.join(jobs, checkpoint));
  const result = await command(process.execPath, [CLI, "index", "--format=json"]);
  requireExit(result, 0, "default index must rebuild safely after registry loss");
  const rebuilt = jsonOutput(result, "missing-registry index");
  assert.equal(rebuilt.outcome, "completed");
  assert.notEqual(
    rebuilt.generationId,
    previous.generationId,
    "unverified checkpoint must not resume",
  );
  assert.equal(rebuilt.counts.filesUnchanged, 0, "fresh generation must rewrite unchanged files");
  assert.ok(rebuilt.counts.filesAnalyzed > 0);
  assert.ok(rebuilt.counts.points > 0);
  checks.push({
    check: "missing registry rebuilds instead of resuming an existing checkpoint",
    exitCode: result.code,
    previousCheckpointCount: checkpoints.length,
    generationReplaced: true,
    filesUnchanged: rebuilt.counts.filesUnchanged,
    filesAnalyzed: rebuilt.counts.filesAnalyzed,
    points: rebuilt.counts.points,
  });
  const fresh = await query("mapUserById", "lexical", ["--require-fresh"]);
  requireTarget(fresh, "mapUserById", 1);
  assert.equal(fresh.indexFreshness.status, "fresh");
}

async function ownedQdrantRequest(collection, endpoint, body, method = "POST") {
  assert.ok(
    collection.startsWith(collectionPrefix),
    "direct Qdrant requests must stay in the owned UUID namespace",
  );
  const response = await requestJson(
    QDRANT_URL,
    `/collections/${encodeURIComponent(collection)}${endpoint}`,
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return response.result;
}

/** Real indexed vectors model legacy rows whose file/chunk identities have lost their manifests. */
async function checkOrphanMigration() {
  const symbols = ["legacyOrphanMissingGeneration", "legacyOrphanObsoleteGeneration"];
  const files = symbols.map((symbol) => `src/${symbol}.ts`);
  for (const [index, symbol] of symbols.entries()) {
    await writeFile(
      path.join(fixtureRoot, files[index]),
      `/** Historical capability used only by the orphan migration acceptance fixture. */\nexport function ${symbol}(): string { return '${symbol}'; }\n`,
    );
  }
  const indexed = await command(process.execPath, [CLI, "index", "--format=json", "--no-resume"]);
  requireExit(indexed, 0, "index orphan fixture through real providers");
  const report = jsonOutput(indexed, "orphan fixture index");
  assert.equal(report.outcome, "completed");
  assert.ok(report.collection.startsWith(collectionPrefix));
  assert.ok(
    report.counts.embeddingsComputed > 0,
    "orphan source vectors must come from real Ollama",
  );
  checks.push({
    check: "orphan fixture uses real indexed embedding vectors",
    exitCode: indexed.code,
  });

  const baseFilter = [
    { key: "workspace_id", match: { value: report.workspaceId } },
    { key: "repo_id", match: { value: report.repoId } },
    { key: "ref_id", match: { value: report.refId } },
  ];
  const sourcePoints = [];
  for (const symbol of symbols) {
    const result = await ownedQdrantRequest(report.collection, "/points/scroll", {
      filter: { must: [...baseFilter, { key: "symbol_name", match: { value: symbol } }] },
      limit: 10,
      with_payload: true,
      with_vector: true,
    });
    assert.equal(result.points.length, 1, "each indexed legacy symbol must have one actual point");
    const point = result.points[0];
    assert.equal(point.vector.dense.length, DIMENSIONS);
    assert.ok(point.vector.bm25.indices.length > 0);
    sourcePoints.push(point);
  }
  const clonePoint = (source, filePath) => {
    const id = randomUUID();
    const symbolId = randomUUID();
    return {
      id,
      vector: source.vector,
      payload: {
        ...source.payload,
        file_id: randomUUID(),
        chunk_id: randomUUID(),
        symbol_id: symbolId,
        metrics_scope_id: symbolId,
        file_path: filePath,
        untangle_stored_point_id: id,
      },
    };
  };
  const missing = clonePoint(sourcePoints[0], "src/orphan-missing-generation.ts");
  delete missing.payload.generation_id;
  const obsolete = clonePoint(sourcePoints[1], "src/orphan-obsolete-generation.ts");
  obsolete.payload.generation_id = randomUUID();
  const outsideRepo = clonePoint(sourcePoints[0], "src/control-outside-repository.ts");
  outsideRepo.payload.repo_id = `outside-${runId}`;
  outsideRepo.payload.ref_id = `${outsideRepo.payload.repo_id}:main`;
  delete outsideRepo.payload.generation_id;
  const outsideRef = clonePoint(sourcePoints[1], "src/control-outside-ref.ts");
  outsideRef.payload.ref_id = `${report.repoId}:orphan-control`;
  outsideRef.payload.ref_name = "orphan-control";
  outsideRef.payload.generation_id = randomUUID();
  const outsideWorkspace = clonePoint(sourcePoints[0], "src/control-outside-workspace.ts");
  outsideWorkspace.payload.workspace_id = `outside-workspace-${runId}`;
  delete outsideWorkspace.payload.generation_id;
  const orphans = [missing, obsolete];
  const controls = [outsideRepo, outsideRef, outsideWorkspace];
  await ownedQdrantRequest(
    report.collection,
    "/points?wait=true",
    { points: [...orphans, ...controls] },
    "PUT",
  );
  const absentManifests = await ownedQdrantRequest(
    `${collectionPrefix}metadata_v1`,
    "/points/scroll",
    {
      filter: {
        must: [
          { key: "point_type", match: { value: "file_manifest" } },
          { key: "record_id", match: { any: orphans.map((point) => point.payload.file_id) } },
        ],
      },
      limit: 10,
      with_payload: true,
    },
  );
  assert.equal(absentManifests.points.length, 0, "legacy copies must have no known file manifest");
  checks.push({
    check: "legacy orphan rows have unknown file identities and real vectors",
    missingGenerationPoints: 1,
    obsoleteGenerationPoints: 1,
    outsideScopeControls: controls.length,
    knownFileManifests: absentManifests.points.length,
  });
  for (const file of files) await rm(path.join(fixtureRoot, file));
  for (const [index, symbol] of symbols.entries()) {
    const before = await query(symbol, "symbol");
    assert.equal(before.indexFreshness.status, "stale");
    assert.ok(
      hits(before).some((hit) => hit.filePath === orphans[index].payload.file_path),
      "the orphan must be a real visible search hit before completed indexing",
    );
  }

  const rebuilt = await command(process.execPath, [CLI, "index", "--format=json"]);
  requireExit(rebuilt, 0, "completed index must prune legacy orphan rows");
  assert.equal(jsonOutput(rebuilt, "orphan pruning index").outcome, "completed");
  const retained = await ownedQdrantRequest(report.collection, "/points", {
    ids: [...orphans, ...controls].map((point) => point.id),
    with_payload: true,
    with_vector: true,
  });
  assert.deepEqual(
    retained.map((point) => point.id).sort(),
    controls.map((point) => point.id).sort(),
    "completed indexing must delete both orphan types and preserve outside workspace/repo/ref controls",
  );
  for (const control of controls) {
    const actual = retained.find((point) => point.id === control.id);
    assert.deepEqual(actual.payload, control.payload, "control payload must remain unchanged");
    assert.deepEqual(actual.vector, control.vector, "control vectors must remain unchanged");
  }
  checks.push({
    check: "completed index prunes orphan generations and preserves outside workspace/repo/ref",
    exitCode: rebuilt.code,
    orphanPointsRemaining: 0,
    outsideScopeControlsPreserved: retained.length,
  });
  for (const symbol of symbols) {
    for (const mode of ["symbol", "lexical"]) {
      const current = await query(symbol, mode, ["--require-fresh"]);
      assert.equal(current.indexFreshness.status, "fresh");
      assert.ok(
        !hits(current).some(
          (hit) =>
            hit.symbolName === symbol ||
            orphans.some((point) => point.payload.file_path === hit.filePath),
        ),
        "completed migration must remove old orphan hits from both retrieval modes",
      );
    }
  }
}

/** Configuration lives above both repositories, so changing it cannot change either corpus. */
async function checkMultiRepoAndExplicitBranch() {
  const workspaceRoot = path.join(fixtureRoot, "multi-workspace");
  const repoA = path.join(workspaceRoot, "repo-a");
  const repoB = path.join(workspaceRoot, "repo-b");
  for (const [root, symbol] of [
    [repoA, "repoAlphaFeature"],
    [repoB, "repoBetaFeature"],
  ]) {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/features.ts"),
      `export function ${symbol}(): string { return '${symbol}'; }\n`,
    );
    await initializeGitRepo(root);
  }
  const config = fixtureConfig(`local-search-multi-smoke-${runId}`, [
    { id: "repo-a", path: "./repo-a", ref: "main", exclude: [".git", ".untangle"] },
    { id: "repo-b", path: "./repo-b", ref: "main", exclude: [".git", ".untangle"] },
  ]);
  await writeFile(path.join(workspaceRoot, ".untangle.json"), JSON.stringify(config, null, 2));
  const rootFlag = `--root=${workspaceRoot}`;
  const indexedA = await command(process.execPath, [
    CLI,
    "index",
    rootFlag,
    "--repo=repo-a",
    "--format=json",
    "--no-resume",
    "--no-incremental",
  ]);
  requireExit(indexedA, 0, "multi-repo index only repo-a");
  assert.equal(jsonOutput(indexedA, "multi-repo index").outcome, "completed");
  checks.push({ check: "multi-repo initially indexes only repo-a", exitCode: 0 });

  const incomplete = await query("repoAlphaFeature", "symbol", [rootFlag]);
  requireTarget(incomplete, "repoAlphaFeature", 1);
  assert.equal(incomplete.indexFreshness.status, "unknown");
  const missing = incomplete.indexFreshness.repositories.find((entry) => entry.repoId === "repo-b");
  assert.equal(missing?.status, "unknown");
  assert.equal(missing?.reason, "index_snapshot_missing");
  assert.ok(
    incomplete.indexFreshness.repositories.some(
      (entry) => entry.repoId === "repo-a" && entry.status === "fresh",
    ),
  );
  checks.push({
    check: "multi-repo unindexed repository is visible",
    freshness: incomplete.indexFreshness.status,
    missingRepository: missing.repoId,
    reason: missing.reason,
  });
  const gate = await command(process.execPath, [
    CLI,
    "query",
    "repoAlphaFeature",
    "--mode=symbol",
    "--format=json",
    rootFlag,
    "--require-fresh",
  ]);
  requireExit(gate, 4, "multi-repo require-fresh must reject the missing repo-b snapshot");
  checks.push({ check: "multi-repo require-fresh refuses missing snapshot", exitCode: gate.code });

  const scoped = await query("repoAlphaFeature", "symbol", [
    rootFlag,
    "--repo=repo-a",
    "--require-fresh",
  ]);
  requireTarget(scoped, "repoAlphaFeature", 1);
  assert.equal(scoped.indexFreshness.status, "fresh");
  assert.ok(scoped.indexFreshness.repositories.every((entry) => entry.repoId === "repo-a"));
  const refreshed = await query("repoBetaFeature", "symbol", [rootFlag, "--refresh"]);
  requireTarget(refreshed, "repoBetaFeature", 1);
  assert.equal(refreshed.indexFreshness.status, "fresh");
  assert.deepEqual(
    [...new Set(refreshed.indexFreshness.repositories.map((entry) => entry.repoId))].sort(),
    ["repo-a", "repo-b"],
  );
  assert.ok(refreshed.indexFreshness.repositories.every((entry) => entry.status === "fresh"));

  const branch = "feature/search-smoke";
  requireExit(
    await command("git", ["checkout", "-b", branch], 30_000, { cwd: repoA }),
    0,
    "explicit branch fixture checkout",
  );
  await writeFile(
    path.join(repoA, "src/branch.ts"),
    "export function explicitBranchFeature(): string { return 'explicit branch'; }\n",
  );
  const branchFlags = [rootFlag, "--repo=repo-a", `--ref=${branch}`];
  const branchFresh = await query("explicitBranchFeature", "symbol", [...branchFlags, "--refresh"]);
  requireTarget(branchFresh, "explicitBranchFeature", 1);
  assert.equal(branchFresh.indexFreshness.status, "fresh");
  assert.ok(
    branchFresh.indexFreshness.repositories.every(
      (entry) => entry.repoId === "repo-a" && entry.refId === `repo-a:${branch}`,
    ),
  );
  requireTarget(
    await query("explicitBranchFeature", "symbol", [...branchFlags, "--require-fresh"]),
    "explicitBranchFeature",
    1,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(workspaceRoot, ".untangle.json"), "utf8")).repositories[0]
      .ref,
    "main",
    "explicit ref must work while the repository configuration still defaults to main",
  );
  checks.push({
    check: "explicit branch overrides configured main during refresh",
    configuredRef: "main",
    checkedOutRef: branch,
    freshness: branchFresh.indexFreshness.status,
  });
}

async function cleanup() {
  const errors = [];
  try {
    const response = await fetch(`${QDRANT_URL}/collections`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.ok, `collection cleanup listing failed: HTTP ${response.status}`);
    const listing = await response.json();
    const own = listing.result.collections.filter((collection) =>
      collection.name.startsWith(collectionPrefix),
    );
    for (const { name } of own) {
      assert.ok(name.startsWith(collectionPrefix) && collectionPrefix.includes(runId));
      const deleted = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      assert.ok(deleted.ok, `cleanup failed for owned collection ${name}: HTTP ${deleted.status}`);
    }
    checks.push({ check: "cleanup owned collections", deletedCollections: own.length });
  } catch (error) {
    errors.push(error);
  }
  if (fixtureRoot !== undefined) {
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Fixture cleanup incomplete");
}

async function main() {
  await access(CLI);
  const qdrant = await requestJson(QDRANT_URL, "/");
  const tags = await requestJson(OLLAMA_URL, "/api/tags");
  const installed = tags.models.find((model) => model.name === MODEL);
  assert.ok(installed, `${MODEL} must already be installed; this script never downloads models`);
  const probe = await requestJson(OLLAMA_URL, "/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: "local search acceptance readiness",
      truncate: false,
    }),
  });
  assert.equal(
    probe.embeddings?.[0]?.length,
    DIMENSIONS,
    "real embedding dimension must match the index configuration",
  );
  await prepareFixture();
  process.stderr.write(
    `Local search smoke: real Qdrant ${QDRANT_URL}, Ollama ${MODEL}, isolated prefix ${collectionPrefix}\n`,
  );
  const indexed = await command(process.execPath, [
    CLI,
    "index",
    "--format=json",
    "--no-resume",
    "--no-incremental",
  ]);
  requireExit(indexed, 0, "real service index");
  const indexReport = jsonOutput(indexed, "index");
  assert.equal(indexReport.outcome, "completed");
  assert.ok(indexReport.collection.startsWith(collectionPrefix));
  checks.push({
    check: "real service index",
    collection: indexReport.collection,
    embeddingProfileId: indexReport.embeddingProfileId,
  });
  const exact = await query("getUserById", "symbol", ["--require-fresh"]);
  requireTarget(exact, "getUserById", 1);
  assert.equal(exact.indexFreshness.status, "fresh");
  for (const text of ["enrichFinalHits", "HybridSearchEngine.enrichFinalHits"]) {
    const result = await query(text, "symbol", ["--require-fresh", "--context", "--linked"]);
    requireTarget(result, "enrichFinalHits", 1);
    const method = hits(result).find((hit) => hit.symbolName === "enrichFinalHits");
    assert.equal(method.symbolFqn, "HybridSearchEngine.enrichFinalHits");
    assert.equal(method.filePath, "src/search-engine.ts");
    assert.equal(method.chunkKind, "symbol_fragment");
    assert.equal(typeof method.symbolId, "string");
    assert.equal(result.indexFreshness.status, "fresh");
    assert.ok(method.graphContext && method.linkedSymbols);
    assert.ok(
      method.linkedSymbols.omissions.every((omission) => omission.reason !== "symbol_id_missing"),
    );
  }
  for (const [text, symbol] of [
    ["user id", "getUserById"],
    ["getUserById", "getUserById"],
    ["order total", "calculate_order_total"],
    ["calculate_order_total", "calculate_order_total"],
    ["http server", "HTTPServer"],
    ["HTTPServer", "HTTPServer"],
    ["größen änderung", "größenÄnderung"],
    ["größenÄnderung", "größenÄnderung"],
  ])
    requireTarget(await query(text, "lexical", ["--require-fresh"]), symbol);
  const intent = await query("Wo wird ein Benutzer anhand seiner Kennung gefunden?", "semantic", [
    "--require-fresh",
  ]);
  requireTarget(intent, "getUserById");
  assert.ok(
    intent.groups[0].retrieval.branchCandidateCounts.dense > 0,
    "German intent must use real dense retrieval",
  );
  const markdown = await query("exponential retry backoff", "lexical", ["--require-fresh"]);
  assert.ok(hits(markdown).some((hit) => hit.filePath === "docs/retries.md" && hit.rank <= 3));
  requireTarget(await query("retiredFeatureForDeletion", "symbol"), "retiredFeatureForDeletion", 1);
  await checkOutage(indexReport.embeddingProfileId);
  await checkHungEmbedding(indexReport.embeddingProfileId);
  await checkFreshness();
  await checkIndexWatch();
  await checkLexicalMigration();
  await checkChunkerMigration();
  await checkMissingRegistryMigration();
  await checkOrphanMigration();
  await checkMultiRepoAndExplicitBranch();
  return {
    schemaVersion: 1,
    ok: true,
    nodeVersion: process.version,
    qdrantVersion: qdrant.version,
    model: MODEL,
    modelDigest: installed.digest,
    dimensions: DIMENSIONS,
    checks,
  };
}

let report;
let failure;
try {
  report = await main();
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], "Acceptance and cleanup failed");
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
if (failure !== undefined) {
  process.stderr.write(`${failure.stack ?? String(failure)}\n`);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, checks }, null, 2)}\n`);
  process.exitCode = abort.signal.aborted ? 130 : 1;
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
