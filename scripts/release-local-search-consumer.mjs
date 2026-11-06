#!/usr/bin/env node
/** Installed embedded-search evidence; the release harness owns child processes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PATH = ".untangle/index/lancedb";
const SOURCES = {
  ".untangle/config.json": JSON.stringify({
    schemaVersion: 1,
    workspaceId: "release-local-search",
    repositories: [{ id: "release-local-search", path: ".." }],
  }),
  "src/users.ts":
    "export function getUserById(users: { id: string; name: string }[], id: string) {\n  return users.find(user => user.id === id);\n}\n",
  "src/main.ts":
    'import { getUserById } from "./users";\nexport function findUserName(users: { id: string; name: string }[], id: string) {\n  return getUserById(users, id)?.name;\n}\n',
};
const GUARD = `import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const rejectNetwork = () => { throw new Error('Installed local search must not use HTTP or fetch.'); };
globalThis.fetch = rejectNetwork;
http.request = http.get = https.request = https.get = rejectNetwork;
for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[key];
  childProcess[key] = function (command, ...args) {
    if (/(^|[\\\\/])(docker|podman|ollama|qdrant)(\\.exe)?$/i.test(String(command))) throw new Error('Installed local search must not start external services.');
    return original.call(this, command, ...args);
  };
}
syncBuiltinESMExports();
`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const LOCAL_SEARCH_CHECKS = Object.freeze([
  "installed-config-and-lancedb-resolution",
  "default-new-project-selects-local-storage",
  "offline-index-without-http-or-service-start",
  "fresh-exact-symbol-and-identifier-component-lexical-search",
  "second-process-reopen-same-generation",
  "persisted-import-graph-same-generation",
  "native-lance-tables-and-unchanged-fixture",
]);

export function localSearchSourceRecords() {
  return Object.entries(SOURCES)
    .map(([file, text]) => ({ path: file, sha256: sha(text) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function localSearchCommandArgs(root) {
  const query = (text, mode) => [
    "query",
    text,
    `--root=${root}`,
    "--embedder=offline",
    `--mode=${mode}`,
    "--require-fresh",
    "--format=json",
  ];
  return {
    index: ["index", `--root=${root}`, "--embedder=offline", "--format=json"],
    symbol: query("getUserById", "symbol"),
    lexical: query("user id", "lexical"),
    reopened: query("getUserById", "symbol"),
    graph: ["graph", `--root=${root}`, "--format=json"],
  };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  assert(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "Local-search consumer path escapes its root.",
  );
  return relative.split(path.sep).join("/");
}

function sourceRecords(root) {
  return localSearchSourceRecords().map((entry) => ({
    path: entry.path,
    sha256: sha(readFileSync(path.join(root, entry.path))),
  }));
}

export function createLocalSearchFixture(consumerRoot) {
  const root = path.join(consumerRoot, "local-search-fixture");
  assert(!existsSync(root), "Local-search fixture already exists.");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  for (const [file, text] of Object.entries(SOURCES)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { flag: "wx" });
  }
  const guardPath = path.join(consumerRoot, "local-search-network-guard.mjs");
  writeFileSync(guardPath, GUARD, { flag: "wx" });
  return { root, guardPath, guardSha256: sha(GUARD) };
}

/** Rechecked offline against source-bound reports; a bare verified flag is insufficient. */
export function assertLocalSearchConsumerProof(proof) {
  assert.equal(proof?.verified, true);
  assert.deepEqual(proof.checks, LOCAL_SEARCH_CHECKS);
  assert.equal(proof.backend, "lancedb");
  assert.equal(proof.relativePath, DEFAULT_PATH);
  assert.equal(proof.storagePath, path.join(proof.root, DEFAULT_PATH));
  assert.deepEqual(proof.sources, localSearchSourceRecords());
  assert.equal(proof.sourceBefore, sha(JSON.stringify(proof.sources)));
  assert.equal(proof.sourceAfter, proof.sourceBefore);
  assert.equal(proof.guardSha256, sha(GUARD));
  assert.equal(proof.networkGuardEnabled, true);
  assert.equal(proof.externalServicesStarted, false);
  for (const entry of [proof.configEntry, proof.storageEntry]) {
    assert.equal(typeof entry, "string");
    assert(
      !entry.includes("\\") && !entry.split("/").includes("..") && entry.includes("node_modules/"),
    );
    assert(!path.posix.isAbsolute(entry));
  }
  const expected = localSearchCommandArgs(proof.root);
  assert.deepEqual(Object.keys(proof.cli).sort(), Object.keys(expected).sort());
  let binary;
  const reports = {};
  for (const [name, args] of Object.entries(expected)) {
    const execution = proof.cli[name];
    assert.equal(execution.exitCode, 0, `Installed local ${name} failed.`);
    assert.equal(typeof execution.stderr, "string");
    assert.equal(typeof execution.command[0], "string");
    binary ??= execution.command[0];
    assert.equal(execution.command[0], binary);
    assert.deepEqual(execution.command.slice(1), args);
    reports[name] = JSON.parse(execution.stdout);
  }
  const index = reports.index;
  assert.equal(index.outcome, "completed");
  assert.equal(typeof index.generationId, "string");
  assert(index.generationId.length > 0);
  assert.equal(index.counts.filesAnalyzed, 2);
  assert.equal(index.counts.fileGraphNodes, 2);
  assert.equal(index.counts.fileGraphEdges, 1);
  const selected = {};
  for (const name of ["symbol", "lexical", "reopened"]) {
    const report = reports[name];
    assert.equal(report.indexFreshness.status, "fresh");
    assert.deepEqual(report.warnings, []);
    assert.equal(report.groups.length, 1);
    const group = report.groups[0];
    assert.deepEqual(group.indexGenerations, [index.generationId]);
    assert.equal(group.embeddingProfileId, index.embeddingProfileId);
    const hit = group.hits.find(
      (entry) => entry.symbolName === "getUserById" && entry.filePath === "src/users.ts",
    );
    assert(hit && hit.rank <= 3, `Installed ${name} did not retrieve getUserById within rank 3.`);
    assert.equal(group.retrieval.branchCandidateCounts.dense, 0);
    assert(group.retrieval.branchCandidateCounts[name === "lexical" ? "sparse" : "symbol"] > 0);
    assert.equal(typeof hit.chunkId, "string");
    assert(hit.chunkId.length > 0);
    assert.equal(hit.indexGeneration, index.generationId);
    selected[name] = {
      chunkId: hit.chunkId,
      symbolId: hit.symbolId,
      indexGeneration: hit.indexGeneration,
      rank: hit.rank,
    };
  }
  assert.deepEqual(selected.reopened, selected.symbol);
  const graph = reports.graph;
  assert.equal(graph.generationId, index.generationId);
  assert.equal(graph.workspaceId, index.workspaceId);
  assert.equal(graph.metrics.nodeCount, 2);
  assert.equal(graph.metrics.edgeCount, 1);
  assert.deepEqual(graph.unresolved, []);
  assert(graph.nodes.some((node) => node.filePath === "src/main.ts" && node.dependencies === 1));
  assert(graph.nodes.some((node) => node.filePath === "src/users.ts" && node.dependents === 1));
  assert(Array.isArray(proof.lanceTables) && proof.lanceTables.length > 0);
  assert.equal(new Set(proof.lanceTables).size, proof.lanceTables.length);
  for (const table of proof.lanceTables) {
    assert(
      table.endsWith(".lance") &&
        !table.includes("\\") &&
        !table.split("/").includes("..") &&
        !path.posix.isAbsolute(table),
    );
  }
}

async function installedContracts(consumerRoot) {
  const manifest = realpathSync(
    path.join(consumerRoot, "node_modules/@untangle-code/cli/package.json"),
  );
  inside(consumerRoot, manifest);
  const resolver = createRequire(manifest);
  const configEntry = realpathSync(resolver.resolve("@untangle-code/config"));
  const storageEntry = realpathSync(resolver.resolve("@untangle-code/storage-lancedb"));
  const config = await import(pathToFileURL(configEntry).href);
  await import(pathToFileURL(storageEntry).href);
  return {
    config,
    configEntry: inside(consumerRoot, configEntry),
    storageEntry: inside(consumerRoot, storageEntry),
  };
}

function lanceTableDirectories(root) {
  const tables = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = lstatSync(target);
      assert(
        !stat.isSymbolicLink(),
        "Embedded database must not escape the fixture through links.",
      );
      if (!stat.isDirectory()) continue;
      if (name.endsWith(".lance")) tables.push(inside(root, target));
      else visit(target);
    }
  }
  visit(root);
  return tables.sort();
}

async function stage(stageName, executionPath) {
  assert(["prepare", "verify"].includes(stageName), "Unknown local-search consumer stage.");
  const consumerRoot = realpathSync(process.cwd());
  const contracts = await installedContracts(consumerRoot);
  if (stageName === "prepare") {
    const fixture = createLocalSearchFixture(consumerRoot);
    const loaded = contracts.config.loadConfig({ cwd: fixture.root });
    assert.deepEqual(loaded.errors, []);
    assert.equal(
      loaded.sources.userConfigPath,
      undefined,
      "Default-storage acceptance requires an unconfigured consumer user.",
    );
    assert.deepEqual(loaded.sources.envVarsApplied, []);
    assert.deepEqual(loaded.effectiveConfig.storage, { backend: "lancedb", path: DEFAULT_PATH });
    const sources = sourceRecords(fixture.root);
    const baseline = {
      ...fixture,
      configEntry: contracts.configEntry,
      storageEntry: contracts.storageEntry,
      backend: loaded.effectiveConfig.storage.backend,
      relativePath: loaded.effectiveConfig.storage.path,
      storagePath: path.join(fixture.root, DEFAULT_PATH),
      sources,
      sourceBefore: sha(JSON.stringify(sources)),
    };
    writeFileSync(
      path.join(fixture.root, ".untangle/acceptance-before.json"),
      JSON.stringify(baseline),
      { flag: "wx" },
    );
    return baseline;
  }
  const root = path.join(consumerRoot, "local-search-fixture");
  const baseline = JSON.parse(
    readFileSync(path.join(root, ".untangle/acceptance-before.json"), "utf8"),
  );
  assert.equal(sha(readFileSync(baseline.guardPath)), baseline.guardSha256);
  assert.equal(process.env.NODE_OPTIONS, `--import=${pathToFileURL(baseline.guardPath).href}`);
  const proof = {
    ...baseline,
    sourceAfter: sha(JSON.stringify(sourceRecords(root))),
    cli: JSON.parse(readFileSync(executionPath, "utf8")),
    lanceTables: lanceTableDirectories(baseline.storagePath),
    networkGuardEnabled: true,
    externalServicesStarted: false,
    checks: LOCAL_SEARCH_CHECKS,
    verified: true,
  };
  assertLocalSearchConsumerProof(proof);
  return proof;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(await stage(process.argv[2], process.argv[3])) + "\n");
}
