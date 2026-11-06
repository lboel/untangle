#!/usr/bin/env node
/** Install the exact inspected release tarballs outside the workspace. No publishing. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkPublishable,
  runOwnedCommand,
  startOwnedChild,
  terminateOwnedChild,
} from "./check-publishable.mjs";
import { localSearchCommandArgs } from "./release-local-search-consumer.mjs";

export { runOwnedCommand } from "./check-publishable.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_NAME = "@untangle-code/cli";
const CONSUMER_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const NATIVE_BUILDS = ["tree-sitter", "tree-sitter-javascript", "tree-sitter-typescript"];
const PRODUCT_PROBE = fileURLToPath(new URL("./release-product-consumer.mjs", import.meta.url));
const FRONTEND_PROBE = fileURLToPath(new URL("./release-frontend-consumer.mjs", import.meta.url));
const LOCAL_SEARCH_PROBE = fileURLToPath(new URL("./release-local-search-consumer.mjs", import.meta.url));

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function digest(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

export function parseOptions(argv) {
  const options = { json: false, packageManagers: ["npm", "pnpm"], outDir: undefined };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg.startsWith("--out-dir=")) {
      const value = arg.slice("--out-dir=".length);
      if (!value) throw new Error("--out-dir requires a new directory path.");
      options.outDir = path.resolve(value);
    } else if (arg.startsWith("--package-manager=")) {
      const value = arg.slice("--package-manager=".length);
      if (!["npm", "pnpm", "both"].includes(value))
        throw new Error(`Unknown package manager: ${value}`);
      options.packageManagers = value === "both" ? ["npm", "pnpm"] : [value];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.outDir && existsSync(options.outDir)) {
    throw new Error(`Output path already exists; it will not be overwritten: ${options.outDir}`);
  }
  if (options.outDir && !options.packageManagers.includes("npm"))
    throw new Error("A verified bundle requires the npm consumer and its production SBOM.");
  return options;
}

/** Exact internal edges keep npm from quietly fetching another Untangle release. */
export function orderReleasePackages(artifacts) {
  const byName = new Map();
  for (const artifact of artifacts) {
    const manifest = artifact.manifest;
    if (
      !manifest?.name?.startsWith("@untangle-code/") ||
      !manifest.version ||
      manifest.private === true
    ) {
      throw new Error("Invalid or private release package manifest.");
    }
    if (byName.has(manifest.name)) throw new Error(`Duplicate release package: ${manifest.name}`);
    byName.set(manifest.name, artifact);
  }
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error(`Internal dependency cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const manifest = byName.get(name).manifest;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, version] of Object.entries(manifest[field] ?? {}).sort(([a], [b]) =>
        compare(a, b),
      )) {
        if (String(version).startsWith("workspace:"))
          throw new Error(`Unpacked workspace dependency: ${name} -> ${dependency}`);
        if (!dependency.startsWith("@untangle-code/")) continue;
        const target = byName.get(dependency);
        if (!target) throw new Error(`Missing public release dependency: ${name} -> ${dependency}`);
        if (version !== target.manifest.version) {
          throw new Error(
            `Internal dependency must match the exact packed version: ${name} -> ${dependency}@${version} (packed ${target.manifest.version})`,
          );
        }
        visit(dependency);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(byName.get(name));
  }
  for (const name of [...byName.keys()].sort(compare)) visit(name);
  return ordered;
}

function artifactRecord(artifact) {
  const bytes = readFileSync(artifact.tarball);
  return {
    name: artifact.manifest.name,
    version: artifact.manifest.version,
    file: path.basename(artifact.tarball),
    bytes: bytes.length,
    sha256: digest(bytes),
    integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
  };
}

function assertArtifactBytes(artifacts, records) {
  for (let index = 0; index < artifacts.length; index += 1) {
    if (artifactRecord(artifacts[index]).sha256 !== records[index].sha256) {
      throw new Error(`Inspected tarball changed during smoke test: ${records[index].name}`);
    }
  }
}

/** Scope-only registry: external packages still use the ordinary npm registry. */
export async function startReleaseRegistry(artifacts) {
  const records = artifacts.map(artifactRecord);
  const byName = new Map(
    artifacts.map((artifact, index) => [
      artifact.manifest.name,
      { artifact, record: records[index] },
    ]),
  );
  const requests = [];
  let origin;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    let name;
    try {
      name = decodeURIComponent(pathname.slice(1));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (name.startsWith("tarballs/")) {
      const record = records.find((entry) => entry.file === name.slice("tarballs/".length));
      const entry = record && byName.get(record.name);
      if (!entry) {
        response.writeHead(404).end();
        return;
      }
      requests.push({
        kind: "tarball",
        name: record.name,
        version: record.version,
        sha256: record.sha256,
      });
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(readFileSync(entry.artifact.tarball));
      return;
    }
    const entry = byName.get(name);
    if (!entry) {
      response.writeHead(404).end();
      return;
    }
    requests.push({ kind: "manifest", name, version: entry.record.version });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: entry.record.version },
        versions: {
          [entry.record.version]: {
            ...entry.artifact.manifest,
            dist: {
              tarball: `${origin}/tarballs/${entry.record.file}`,
              shasum: digest(readFileSync(entry.artifact.tarball), "sha1"),
              integrity: entry.record.integrity,
            },
          },
        },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function consumerEnvironment(consumerRoot, registry) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(npm_config_|pnpm_|NODE_PATH$|NODE_OPTIONS$)/i.test(key)) delete env[key];
  }
  const configPath = path.join(consumerRoot, "consumer.npmrc");
  writeFileSync(
    configPath,
    [
      "registry=https://registry.npmjs.org/",
      `@untangle-code:registry=${registry.origin}/`,
      "engine-strict=true",
      "ignore-scripts=false",
      "audit=false",
      "fund=false",
      `cache=${path.join(consumerRoot, "npm-cache")}`,
      `store-dir=${path.join(consumerRoot, "pnpm-store")}`,
      "verify-store-integrity=true",
      "update-notifier=false",
      "\n",
    ].join("\n"),
  );
  const emptyGlobalConfig = path.join(consumerRoot, "global.npmrc");
  writeFileSync(emptyGlobalConfig, "");
  env.npm_config_userconfig = configPath;
  env.npm_config_globalconfig = emptyGlobalConfig;
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
  return env;
}

function dependencyNames(artifact, byName, selected = new Set()) {
  if (selected.has(artifact.manifest.name)) return selected;
  selected.add(artifact.manifest.name);
  for (const name of Object.keys(artifact.manifest.dependencies ?? {})) {
    if (byName.has(name)) dependencyNames(byName.get(name), byName, selected);
  }
  return selected;
}

/** Probe runs in the consumer, so every resolution starts outside the monorepo. */
function writeImportProbe(consumerRoot) {
  const probePath = path.join(consumerRoot, "import-probe.mjs");
  writeFileSync(
    probePath,
    `import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const expected = JSON.parse(process.argv[2]);
const expectedByName = new Map(expected.map(entry => [entry.name, entry]));
const consumerRequire = createRequire(import.meta.url);
const queue = expected.map(({name}) => ({name, resolver: consumerRequire}));
const found = new Map();
function inspect(name, resolver) {
  let resolved;
  try { resolved = realpathSync(resolver.resolve(name)); } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return;
    throw error;
  }
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workspace escape: ' + resolved);
  let directory = path.dirname(resolved);
  let manifest;
  for (;;) {
    try { manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')); } catch { /* Walk to the owning package. */ }
    if (manifest?.name === name) break;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Package manifest missing for ' + name);
    directory = parent;
  }
  if (manifest.version !== expectedByName.get(name)?.version) throw new Error('Version mismatch: ' + name);
  if (found.has(name)) return;
  found.set(name, {name, version: manifest.version, dependencies: manifest.dependencies ?? {}, resolved, relative});
  const packageRequire = createRequire(path.join(directory, 'package.json'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (expectedByName.has(dependency)) queue.push({name: dependency, resolver: packageRequire});
  }
}
while (queue.length) { const {name, resolver} = queue.shift(); inspect(name, resolver); }
for (const name of expectedByName.keys()) if (!found.has(name)) throw new Error('Package not resolved from installed dependency tree: ' + name);
const modules = [];
for (const entry of found.values()) {
  await import(pathToFileURL(entry.resolved).href);
  modules.push({name: entry.name, resolved: entry.relative});
}
const mcpResolved = realpathSync(consumerRequire.resolve('@untangle-code/cli/mcp'));
if (path.relative(process.cwd(), mcpResolved).startsWith('..')) throw new Error('MCP import escapes consumer.');
const mcp = await import(pathToFileURL(mcpResolved).href);
if (typeof mcp.createUntangleMcpServer !== 'function' || typeof mcp.serveUntangleMcpStdio !== 'function') throw new Error('MCP public exports missing.');
modules.push({name: '@untangle-code/cli/mcp', resolved: path.relative(process.cwd(), mcpResolved)});
console.log(JSON.stringify({modules, installed: [...found.values()].map(({name, version, dependencies}) => ({name, version, dependencies}))}));
`,
  );
  return probePath;
}

/** Capture the actual dependency tree, including every nested internal resolution. */
export function validateDependencyTree(tree, expected) {
  const versions = new Map(expected.map((entry) => [entry.name, entry.version]));
  const seen = new Set();
  function visit(node) {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
      for (const [name, dependency] of Object.entries(node?.[field] ?? {})) {
        if (name.startsWith("@untangle-code/")) {
          if (!versions.has(name) || dependency.version !== versions.get(name)) {
            throw new Error(
              `Installed dependency tree contains unexpected ${name}@${dependency.version}`,
            );
          }
          seen.add(name);
        }
        visit(dependency);
      }
    }
  }
  visit(tree);
  for (const name of versions.keys())
    if (!seen.has(name)) throw new Error(`Installed dependency tree is missing ${name}`);
  return [...seen].sort(compare);
}

async function probeMcp(binary, options, product, frontend) {
  const handle = startOwnedChild(binary, ["mcp", "--stdio"], options);
  let stderr = "";
  let stdoutBytes = 0;
  let nextId = 0;
  let wireError;
  const pending = new Map();
  const lines = createInterface({ input: handle.child.stdout });
  handle.child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > OUTPUT_LIMIT) handle.stop(new Error("MCP stderr exceeded output limit."));
  });
  function failPending(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  lines.on("line", (line) => {
    try {
      stdoutBytes += line.length;
      if (stdoutBytes > OUTPUT_LIMIT) throw new Error("MCP stdout exceeded output limit.");
      const message = JSON.parse(line);
      if (message.jsonrpc !== "2.0") throw new Error("Non-JSON-RPC data on MCP stdout.");
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      if (!waiter) throw new Error(`Unexpected MCP response id ${message.id}`);
      pending.delete(message.id);
      if (message.error)
        waiter.reject(new Error(`MCP RPC failed: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
    } catch (error) {
      wireError = error;
      failPending(error);
      handle.stop(error);
    }
  });
  handle.closed.then(() => failPending(new Error("MCP exited before responding.")), failPending);
  function request(method, params) {
    if (wireError) throw wireError;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      handle.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "untangle-release-smoke", version: "1.0.0" },
    });
    handle.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    const listed = await request("tools/list", {});
    if (!listed.tools?.some((tool) => tool.name === "untangle_about"))
      throw new Error("Installed MCP server did not list untangle_about.");
    const about = await request("tools/call", { name: "untangle_about", arguments: {} });
    if (
      about.isError !== false ||
      about.structuredContent?.ok !== true ||
      about.structuredContent?.operation !== "untangle_about"
    ) {
      throw new Error(`Installed MCP about failed: ${JSON.stringify(about)}`);
    }
    if (stderr) throw new Error(`Installed MCP polluted stderr: ${stderr}`);
    let productResult;
    if (product !== undefined) {
      assert(listed.tools.some((tool) => tool.name === "untangle_product"));
      productResult = await request("tools/call", {
        name: "untangle_product",
        arguments: { root: product.root, testEvidence: product.evidencePath },
      });
      assert.equal(productResult.isError, false);
      assert.equal(productResult.structuredContent?.ok, true);
      assert.equal(productResult.structuredContent?.operation, "untangle_product");
      assert.deepEqual(productResult.structuredContent?.data, product.api);
      if (stderr) throw new Error(`Installed MCP product polluted stderr: ${stderr}`);
    }
    let frontendResult;
    if (frontend !== undefined) {
      const tool = listed.tools.find((entry) => entry.name === "untangle_boundaries");
      assert(tool, "Installed MCP server did not list untangle_boundaries.");
      const boundaries = await request("tools/call", {
        name: "untangle_boundaries",
        arguments: { root: frontend.root },
      });
      const selected = await request("tools/call", {
        name: "untangle_boundaries",
        arguments: { root: frontend.root, path: "src/App.vue" },
      });
      const invalidLimit = await request("tools/call", {
        name: "untangle_boundaries",
        arguments: { root: frontend.root, maxRelations: 0 },
      });
      frontendResult = { tool, boundaries, selected, invalidLimit };
      if (stderr) throw new Error(`Installed MCP boundaries polluted stderr: ${stderr}`);
    }
    return {
      protocolVersion: initialized.protocolVersion,
      toolNames: listed.tools.map((tool) => tool.name),
      about: about.structuredContent,
      ...(productResult === undefined ? {} : { product: productResult.structuredContent }),
      ...(frontendResult === undefined ? {} : { frontend: frontendResult }),
      stderr,
    };
  } finally {
    lines.close();
    handle.child.stdin.end();
    terminateOwnedChild(handle.child);
    await handle.closed;
  }
}

/** Expected gate failures still retain output, but share the owned-child cleanup and time budget. */
export async function runExpectedCommand(command, args, options, expectedExit = 0) {
  const handle = startOwnedChild(command, args, options);
  let stdout = "";
  let stderr = "";
  for (const [stream, append] of [
    [handle.child.stdout, (chunk) => (stdout += chunk)],
    [handle.child.stderr, (chunk) => (stderr += chunk)],
  ])
    stream.on("data", (chunk) => {
      append(chunk);
      if (stdout.length + stderr.length > OUTPUT_LIMIT)
        handle.stop(new Error(`${command} exceeded output limit.`));
    });
  handle.child.stdin.end();
  const exit = await handle.closed;
  assert.equal(exit.code, expectedExit, `${command} ${args.join(" ")}: ${stderr || stdout}`);
  return { command: [command, ...args], exitCode: exit.code, stdout, stderr };
}

async function productStage(stage, commandOptions, executionPath) {
  const args = [PRODUCT_PROBE, stage];
  if (executionPath !== undefined) args.push(executionPath);
  const result = await runOwnedCommand(process.execPath, args, commandOptions());
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

async function frontendStage(stage, commandOptions, executionPath) {
  const args = [FRONTEND_PROBE, stage];
  if (executionPath !== undefined) args.push(executionPath);
  const result = await runOwnedCommand(process.execPath, args, commandOptions());
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

async function probeInstalledFrontend(binary, commandOptions) {
  const prepared = await frontendStage("prepare", commandOptions);
  const cli = {};
  for (const [name, root] of [
    ["vue", prepared.vueRoot],
    ["native", prepared.nativeRoot],
    ["incomplete", prepared.incompleteRoot],
  ]) {
    cli[name] = await runExpectedCommand(
      binary,
      ["complexity", `--root=${root}`, "--format=json"],
      commandOptions(),
    );
  }
  const args = ["graph", "boundaries", `--root=${prepared.root}`];
  cli.boundaries = await runExpectedCommand(binary, [...args, "--format=json"], commandOptions());
  cli.selected = await runExpectedCommand(
    binary,
    [...args, "--path=src/App.vue", "--format=json"],
    commandOptions(),
  );
  cli.invalidPath = await runExpectedCommand(
    binary,
    [...args, "--path=../outside.vue", "--format=json"],
    commandOptions(),
    2,
  );
  cli.invalidLimit = await runExpectedCommand(
    binary,
    [...args, "--max-relations=0", "--format=json"],
    commandOptions(),
    2,
  );
  return { ...prepared, cli };
}

/** Real local tables and fresh search in separate installed CLI processes. */
async function probeInstalledLocalSearch(binary, commandOptions) {
  let guardPath;
  function localOptions() {
    const options = commandOptions();
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !key.startsWith("UNTANGLE_")));
    if (guardPath !== undefined) env.NODE_OPTIONS = `--import=${pathToFileURL(guardPath).href}`;
    return { ...options, env };
  }
  async function stage(name, executionPath) {
    const args = [LOCAL_SEARCH_PROBE, name];
    if (executionPath !== undefined) args.push(executionPath);
    const result = await runOwnedCommand(process.execPath, args, localOptions());
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  }
  const prepared = await stage("prepare");
  guardPath = prepared.guardPath;
  const cli = {};
  for (const [name, args] of Object.entries(localSearchCommandArgs(prepared.root))) {
    cli[name] = await runExpectedCommand(binary, args, localOptions());
  }
  const executionPath = path.join(prepared.root, ".untangle/acceptance-execution.json");
  writeFileSync(executionPath, JSON.stringify(cli), { flag: "wx" });
  return stage("verify", executionPath);
}

async function probeInstalledProduct(binary, commandOptions) {
  const prepared = await productStage("prepare", commandOptions);
  const testArgs = ["--test", "--test-reporter=tap", path.join(prepared.root, "main.test.js")];
  const tests = await runExpectedCommand(process.execPath, testArgs, commandOptions());
  const executionPath = path.join(prepared.root, ".untangle/execution.json");
  writeFileSync(executionPath, JSON.stringify(tests));
  const product = await productStage("verify", commandOptions, executionPath);
  const args = [
    "product",
    `--root=${product.root}`,
    `--test-evidence=${product.evidencePath}`,
    "--format=json",
  ];
  const cli = await runExpectedCommand(binary, args, commandOptions());
  assert.equal(cli.stderr, "");
  assert.deepEqual(JSON.parse(cli.stdout), product.api);
  const reviewGate = await runExpectedCommand(
    binary,
    [...args, "--require-complete"],
    commandOptions(),
    5,
  );
  assert.equal(reviewGate.stderr, "");
  assert.deepEqual(JSON.parse(reviewGate.stdout), product.api);
  const init = await runExpectedCommand(
    binary,
    [
      "init",
      product.root,
      "--offline",
      "--dry-run",
      "--feature-map=untangle.features.json",
      "--format=json",
    ],
    commandOptions(),
  );
  assert.equal(init.stderr, "");
  const initData = JSON.parse(init.stdout);
  assert.equal(initData.findings.featureAlignment?.features[0]?.id, "fixture.classification");
  assert.equal(initData.findings.featureAlignment?.features[0]?.code.complete, true);
  assert.equal(initData.findings.featureAlignment?.features[0]?.testEvidence.status, "not_run");
  assert.equal(initData.outcome, "would-create");
  await productStage("unchanged", commandOptions);
  return { ...product, cli, reviewGate, init };
}

async function probeStaleProduct(binary, product, commandOptions) {
  await productStage("mutate", commandOptions);
  const stale = await runExpectedCommand(
    binary,
    [
      "product",
      `--root=${product.root}`,
      `--test-evidence=${product.evidencePath}`,
      "--format=json",
      "--require-complete",
    ],
    commandOptions(),
    5,
  );
  assert.equal(stale.stderr, "");
  const data = JSON.parse(stale.stdout);
  assert.equal(data.features[0]?.testEvidence.status, "stale");
  assert.equal(data.features[0]?.criteria[0]?.status, "not_run");
  assert.notEqual(data.sourceTreeDigest, product.sourceAfterTests);
  return stale;
}

/** Run every operational probe before adding any package outside the CLI graph. */
async function probeInstalledRuntime(
  consumerRoot,
  probePath,
  packages,
  cliVersionExpected,
  commandOptions,
) {
  const imports = JSON.parse(
    (
      await runOwnedCommand(
        process.execPath,
        [probePath, JSON.stringify(packages)],
        commandOptions(),
      )
    ).stdout,
  );
  const binary = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "untangle.cmd" : "untangle",
  );
  if (!existsSync(binary)) throw new Error("Installed untangle executable is missing.");
  const binaryTarget = realpathSync(binary);
  if (path.relative(consumerRoot, binaryTarget).startsWith(".."))
    throw new Error("Installed binary escapes the isolated consumer.");
  const cliVersion = (await runOwnedCommand(binary, ["--version"], commandOptions())).stdout.trim();
  if (!cliVersion.includes(cliVersionExpected))
    throw new Error(`Installed CLI version mismatch: ${cliVersion}`);
  await runOwnedCommand(binary, ["--help"], commandOptions());
  const fixture = path.join(consumerRoot, "fixture");
  mkdirSync(fixture);
  writeFileSync(
    path.join(fixture, "example.ts"),
    "export function classify(value: number) { if (value > 0) return 1; return 0; }\n",
  );
  writeFileSync(
    path.join(fixture, "example.py"),
    "def classify(value):\n    if value > 0:\n        return 1\n    return 0\n",
  );
  const complexity = JSON.parse(
    (
      await runOwnedCommand(
        binary,
        ["complexity", `--root=${fixture}`, "--format=json"],
        commandOptions(),
      )
    ).stdout,
  );
  if (
    complexity.filesAnalyzed !== 2 ||
    complexity.skipped.length !== 0 ||
    complexity.totals.executionUnits < 2
  ) {
    throw new Error(
      `Installed native parser/complexity smoke failed: ${JSON.stringify(complexity)}`,
    );
  }
  const product = await probeInstalledProduct(binary, commandOptions);
  const frontend = await probeInstalledFrontend(binary, commandOptions);
  const localSearch = await probeInstalledLocalSearch(binary, commandOptions);
  const mcp = await probeMcp(binary, commandOptions(), product, frontend);
  if (mcp.about.data?.version !== cliVersionExpected)
    throw new Error("MCP about version differs from the inspected CLI artifact.");
  writeFileSync(frontend.executionPath, JSON.stringify({ cli: frontend.cli, mcp: mcp.frontend }), {
    flag: "wx",
  });
  const frontendProof = await frontendStage("verify", commandOptions, frontend.executionPath);
  const stale = await probeStaleProduct(binary, product, commandOptions);
  return {
    imports,
    cliVersion,
    complexity,
    mcp,
    frontend: frontendProof,
    localSearch,
    product: {
      ...product,
      mcp: mcp.product,
      stale,
      checks: [
        "installed-core-resolution",
        "real-node-tests-source-bound",
        "installed-product-code-and-test-metrics",
        "cli-api-report-equality",
        "declared-ownership-needs-review-exit5",
        "installed-init-feature-map-dry-run",
        "installed-mcp-product-report-equality",
        "stale-evidence-fails-gate",
      ],
    },
  };
}

/** Validate npm's actual production graph rather than constructing a dependency inventory. */
export function validateProductionSbom(content, packages) {
  const document = JSON.parse(content);
  assert.equal(document.bomFormat, "CycloneDX", "npm did not produce a CycloneDX SBOM.");
  assert.equal(typeof document.specVersion, "string");
  assert(Array.isArray(document.components), "SBOM components are missing.");
  for (const expected of packages) {
    const components = document.components.filter((component) => {
      const name = component.group ? `${component.group}/${component.name}` : component.name;
      return name === expected.name;
    });
    assert(components.length > 0, `SBOM is missing ${expected.name}.`);
    assert(
      components.every((component) => component.version === expected.version),
      `SBOM has an unexpected version of ${expected.name}.`,
    );
  }
  return { specVersion: document.specVersion, componentCount: document.components.length };
}

export async function smokeConsumer(packageManager, workDir, artifacts, registry, signal) {
  const consumerPath = path.join(workDir, `consumer-${packageManager}`);
  mkdirSync(consumerPath);
  const consumerRoot = realpathSync(consumerPath);
  const env = consumerEnvironment(consumerRoot, registry);
  writeFileSync(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({
      name: "untangle-release-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
    }),
  );
  if (packageManager === "pnpm") {
    writeFileSync(
      path.join(consumerRoot, "pnpm-workspace.yaml"),
      "packages: []\nonlyBuiltDependencies:\n" +
        NATIVE_BUILDS.map((name) => `  - ${name}\n`).join(""),
    );
  }
  const started = performance.now();
  function commandOptions() {
    signal.throwIfAborted();
    const remaining = CONSUMER_TIMEOUT_MS - (performance.now() - started);
    if (remaining <= 0) throw new Error(`${packageManager} consumer exceeded its time budget.`);
    return { cwd: consumerRoot, env, signal, timeoutMs: Math.min(COMMAND_TIMEOUT_MS, remaining) };
  }
  const version = (
    await runOwnedCommand(packageManager, ["--version"], commandOptions())
  ).stdout.trim();
  const byName = new Map(artifacts.map((artifact) => [artifact.manifest.name, artifact]));
  const cli = byName.get(CLI_NAME);
  if (!cli) throw new Error("The CLI release package is missing.");
  const installArgs =
    packageManager === "npm"
      ? [
          "install",
          "--omit=dev",
          "--ignore-scripts=false",
          "--engine-strict",
          "--no-audit",
          "--no-fund",
        ]
      : ["add", "--prod", "--ignore-scripts=false", "--reporter=append-only"];
  const firstRequest = registry.requests.length;
  const installation = await runOwnedCommand(
    packageManager,
    [...installArgs, `${CLI_NAME}@${cli.manifest.version}`],
    {
      ...commandOptions(),
      timeoutMs: CONSUMER_TIMEOUT_MS - (performance.now() - started),
    },
  );
  const cliNames = dependencyNames(cli, byName);
  const cliPackages = artifacts
    .filter((artifact) => cliNames.has(artifact.manifest.name))
    .map(artifactRecord);
  const treeArgs =
    packageManager === "npm"
      ? ["ls", "--omit=dev", "--all", "--json"]
      : ["list", "--prod", "--depth=Infinity", "--json"];
  const cliTree = JSON.parse(
    (await runOwnedCommand(packageManager, treeArgs, commandOptions())).stdout,
  );
  const cliInstalled = validateDependencyTree(cliTree, cliPackages);
  const cliRequests = registry.requests.slice(firstRequest);
  const probePath = writeImportProbe(consumerRoot);
  const runtime = await probeInstalledRuntime(
    consumerRoot,
    probePath,
    cliPackages,
    cli.manifest.version,
    commandOptions,
  );
  const remaining = artifacts.filter((artifact) => !cliNames.has(artifact.manifest.name));
  let additionalInstallation;
  if (remaining.length) {
    additionalInstallation = await runOwnedCommand(
      packageManager,
      [
        ...installArgs,
        ...remaining.map((artifact) => `${artifact.manifest.name}@${artifact.manifest.version}`),
      ],
      {
        ...commandOptions(),
        timeoutMs: CONSUMER_TIMEOUT_MS - (performance.now() - started),
      },
    );
  }
  const allPackages = artifacts.map(artifactRecord);
  const allTree = JSON.parse(
    (await runOwnedCommand(packageManager, treeArgs, commandOptions())).stdout,
  );
  validateDependencyTree(allTree, allPackages);
  const imports = JSON.parse(
    (
      await runOwnedCommand(
        process.execPath,
        [probePath, JSON.stringify(allPackages)],
        commandOptions(),
      )
    ).stdout,
  );
  let sbom;
  if (packageManager === "npm") {
    const generated = await runOwnedCommand(
      "npm",
      ["sbom", "--sbom-format=cyclonedx", "--omit=dev"],
      commandOptions(),
    );
    const detail = validateProductionSbom(generated.stdout, allPackages);
    sbom = {
      file: "sbom.cdx.json",
      format: "CycloneDX",
      ...detail,
      generatedBy: {
        command: generated.command,
        exitCode: generated.exitCode,
        npmVersion: version,
      },
      sha256: digest(generated.stdout),
      bytes: Buffer.byteLength(generated.stdout),
      content: generated.stdout,
      scope:
        "Production dependencies actually installed in the npm all-public candidate consumer on this platform; optional dependencies for other platforms are not an inventory claim.",
    };
  }
  return {
    packageManager,
    version,
    cliOnly: {
      requested: `${CLI_NAME}@${cli.manifest.version}`,
      installed: cliInstalled,
      tree: cliTree,
      registryRequests: cliRequests,
      installation,
      runtime,
    },
    additionalPublicPackages: remaining.map((artifact) => artifact.manifest.name),
    additionalInstallation,
    allTree,
    imports,
    ...(sbom === undefined ? {} : { sbom }),
    elapsedMs: Math.round(performance.now() - started),
    nativeBuildAllowlist: packageManager === "pnpm" ? NATIVE_BUILDS : undefined,
  };
}

/** Content binding includes dirty/untracked sources and build outputs, excluding local indexes. */
function captureWorkspace() {
  const hash = createHash("sha256");
  let files = 0;
  function visit(relative) {
    const absolute = path.join(REPO_ROOT, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort(compare)) {
        if (["node_modules", ".untangle", ".git", "coverage", ".turbo"].includes(entry)) continue;
        visit(path.join(relative, entry));
      }
    } else if (stat.isFile() && !relative.endsWith(".tsbuildinfo")) {
      hash
        .update(relative.replaceAll(path.sep, "/") + "\0")
        .update(readFileSync(absolute))
        .update("\0");
      files += 1;
    }
  }
  for (const relative of [
    "packages",
    "apps",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ])
    visit(relative);
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(`Cannot bind release artifacts to git: ${result.stderr}`);
    return result.stdout.trim();
  };
  return {
    contentSha256: hash.digest("hex"),
    files,
    gitRevision: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain=v1", "--untracked-files=normal"]),
  };
}

/** Atomic rename publishes only a verified bundle; an existing path is never removed. */
export function writeVerifiedBundle(outDir, artifacts, report, renameDirectory = renameSync) {
  if (existsSync(outDir)) throw new Error(`Output path already exists: ${outDir}`);
  mkdirSync(path.dirname(outDir), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(outDir), ".untangle-release-bundle-"));
  try {
    mkdirSync(path.join(staging, "tarballs"));
    const records = artifacts.map(artifactRecord);
    const filenames = new Set();
    for (let index = 0; index < artifacts.length; index += 1) {
      const record = records[index];
      if (filenames.has(record.file)) throw new Error(`Duplicate tarball filename: ${record.file}`);
      filenames.add(record.file);
      if (record.sha256 !== report.packages[index].sha256)
        throw new Error(`Verified artifact changed: ${record.name}`);
      copyFileSync(artifacts[index].tarball, path.join(staging, "tarballs", record.file));
      if (digest(readFileSync(path.join(staging, "tarballs", record.file))) !== record.sha256)
        throw new Error(`Copied artifact changed: ${record.name}`);
    }
    const checksumLines = records.map((record) => `${record.sha256}  tarballs/${record.file}\n`);
    if (report.sbom !== undefined) {
      const sbom = report.sbom;
      assert.equal(sbom.file, "sbom.cdx.json");
      assert.equal(sbom.format, "CycloneDX");
      assert.equal(digest(sbom.content), sbom.sha256, "Verified SBOM changed.");
      assert.equal(Buffer.byteLength(sbom.content), sbom.bytes, "Verified SBOM length changed.");
      const detail = validateProductionSbom(sbom.content, records);
      assert.equal(sbom.specVersion, detail.specVersion);
      assert.equal(sbom.componentCount, detail.componentCount);
      writeFileSync(path.join(staging, sbom.file), sbom.content);
      checksumLines.push(`${sbom.sha256}  ${sbom.file}\n`);
    }
    writeFileSync(path.join(staging, "SHA256SUMS"), checksumLines.join(""));
    writeFileSync(
      path.join(staging, "publish-order.json"),
      JSON.stringify(
        records.map(({ name, version, file }) => ({ name, version, file: `tarballs/${file}` })),
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      path.join(staging, "release-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    // mkdir reserves the destination against concurrent creators; never overwrite even an empty directory.
    mkdirSync(outDir);
    try {
      renameDirectory(staging, outDir);
    } catch (error) {
      try {
        rmdirSync(outDir);
      } catch (cleanupError) {
        // Do not remove contents another process may have placed in our reservation.
        error.message += ` (output reservation cleanup failed: ${cleanupError.message})`;
      }
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main(argv) {
  const options = parseOptions(argv);
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Release smoke interrupted."));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const workDir = mkdtempSync(path.join(tmpdir(), "untangle-release-smoke-"));
  let registry;
  try {
    const before = captureWorkspace();
    process.stderr.write("Packing and inspecting original release tarballs…\n");
    const checked = await checkPublishable({ workDir, signal: controller.signal });
    if (checked.findings.length)
      throw new Error(
        `Release artifact checks failed:\n${JSON.stringify(checked.findings, null, 2)}`,
      );
    controller.signal.throwIfAborted();
    const artifacts = orderReleasePackages(checked.artifacts);
    const packages = artifacts.map(artifactRecord);
    const afterPack = captureWorkspace();
    if (before.contentSha256 !== afterPack.contentSha256)
      throw new Error(
        "Workspace source/dist changed during packing; candidate is not bound to a stable snapshot.",
      );
    registry = await startReleaseRegistry(artifacts);
    const consumers = [];
    for (const packageManager of options.packageManagers) {
      process.stderr.write(
        `Installing CLI-only candidate with ${packageManager}, then checking all public packages, CLI/native parsers and MCP…\n`,
      );
      consumers.push(
        await smokeConsumer(packageManager, workDir, artifacts, registry, controller.signal),
      );
    }
    assertArtifactBytes(artifacts, packages);
    const after = captureWorkspace();
    if (before.contentSha256 !== after.contentSha256)
      throw new Error(
        "Workspace source/dist changed during verification; refusing a verified bundle.",
      );
    controller.signal.throwIfAborted();
    const { artifacts: _artifacts, ...publishable } = checked;
    const sbom = consumers.find((consumer) => consumer.packageManager === "npm")?.sbom;
    if (options.outDir && sbom === undefined)
      throw new Error("No production SBOM from the verified npm consumer; refusing a bundle.");
    const report = {
      schemaVersion: 1,
      verified: true,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      packages,
      source: { before, afterPack, after, stable: true },
      publishable,
      consumers,
      ...(sbom === undefined ? {} : { sbom }),
      limitations: [
        "No publication or public registry lookup of Untangle packages was performed.",
        "The local registry proves CLI-only dependency resolution against candidate artifacts; external production dependencies are downloaded from npm.",
        "Live Qdrant/Ollama search and optional parser peer packages are separate integration checks.",
        ...(sbom === undefined
          ? [
              "An npm all-public consumer was not selected; no production SBOM or publishable bundle is asserted.",
            ]
          : [sbom.scope]),
      ],
    };
    if (options.outDir) writeVerifiedBundle(options.outDir, artifacts, report);
    if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else
      process.stdout.write(
        `Verified ${packages.length} original release tarballs with ${options.packageManagers.join(" + ")}: CLI-only installation, public imports, native parsers, product/core/init contracts and MCP stdio.${sbom ? " Production CycloneDX SBOM included." : ""}${options.outDir ? ` Bundle: ${options.outDir}` : ""}\n`,
      );
    return 0;
  } finally {
    try {
      await registry?.close();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Release smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
