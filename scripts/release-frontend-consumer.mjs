#!/usr/bin/env node
/** Consumer-side fixtures and assertions; the release harness owns all processes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT =
  "export function feature(enabled: boolean): boolean {\n  if (enabled) return helper(enabled);\n  return false;\n}\nfunction helper(value: boolean): boolean {\n  if (value) return true;\n  return false;\n}\n";
const TEMPLATE = '<button v-if="ready" @click="feature">TemplateOnlyMarker 🌿</button>';
const STYLE = ".ready { color: green; }";
const SERVICES = [
  { id: "fixture-api", frontendRoots: ["src"], backendRoots: ["backend"], sameOrigin: true },
];
const SOURCES = {
  "frontend-fixture/.gitignore": ".untangle/\n",
  "frontend-fixture/.untangle/services.json": JSON.stringify({
    schemaVersion: 1,
    services: SERVICES,
  }),
  "frontend-fixture/src/App.vue":
    '<template><button @click="load">Load</button></template>\n<script setup lang="ts">\nimport { load } from "./api";\n</script>\n',
  "frontend-fixture/src/api.ts":
    'export function load(id: string) { return fetch(`/api/orders/${encodeURIComponent(id)}`, { method: "GET" }); }\nexport function unknown(url: string) { return fetch(url); }\n',
  "frontend-fixture/backend/app.py":
    'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/api/orders/{id}")\ndef load_order(id: str):\n    return {"id": id}\n',
  "vue-fixture/Widget.vue": `<template>${TEMPLATE}</template>\n<script lang="ts">\n${SCRIPT}</script>\n<style>${STYLE}</style>\n`,
  "native-fixture/reference.ts": SCRIPT,
  "vue-incomplete-fixture/OnlyTemplate.vue": `<template>${TEMPLATE}</template>\n`,
  "vue-incomplete-fixture/Broken.vue": '<script setup lang="ts">const broken = ;</script>\n',
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const FRONTEND_CHECKS = Object.freeze([
  "installed-public-core-and-mcp-exports",
  "vue-native-metric-equality-and-private-helper",
  "vue-template-style-unmeasured-ranges",
  "vue-incomplete-scripts-not-zero-success",
  "http-resolved-and-unresolved-static-evidence",
  "import-context-not-template-function-calls",
  "cli-api-and-mcp-boundary-equality",
  "mcp-advertised-and-installed-output-schemas",
  "cli-path-and-mcp-limit-errors",
  "fixture-source-and-service-control-unchanged",
]);

export function frontendSourceRecords() {
  return Object.entries(SOURCES)
    .map(([file, text]) => ({ path: file, sha256: sha(text) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function assertFrontendConsumerPath(root, target) {
  const relative = path.relative(root, target);
  assert(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return relative.split(path.sep).join("/");
}

function hashes(consumerRoot) {
  return frontendSourceRecords().map((entry) => ({
    path: entry.path,
    sha256: sha(readFileSync(path.join(consumerRoot, entry.path))),
  }));
}

export function createFrontendFixture(consumerRoot) {
  const directories = [
    "frontend-fixture",
    "vue-fixture",
    "native-fixture",
    "vue-incomplete-fixture",
  ];
  for (const directory of directories)
    assert.equal(existsSync(path.join(consumerRoot, directory)), false, "Frontend fixture exists.");
  for (const [file, text] of Object.entries(SOURCES)) {
    const target = path.join(consumerRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { flag: "wx" });
  }
  return {
    root: path.join(consumerRoot, "frontend-fixture"),
    vueRoot: path.join(consumerRoot, "vue-fixture"),
    nativeRoot: path.join(consumerRoot, "native-fixture"),
    incompleteRoot: path.join(consumerRoot, "vue-incomplete-fixture"),
  };
}

export function assertVueConsumerMetrics(vue, native, incomplete) {
  assert.equal(vue.filesAnalyzed, 1);
  assert.equal(native.filesAnalyzed, 1);
  const totals = { executionUnits: 2, executionUnitRoots: 2, cognitive: 2, cyclomatic: 5 };
  assert.deepEqual(vue.totals, totals);
  assert.deepEqual(native.totals, totals);
  const symbols = (report) =>
    report.hotspots
      .map(({ name, cognitive, cyclomatic }) => ({ name, cognitive, cyclomatic }))
      .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(symbols(vue), symbols(native));
  assert.deepEqual(
    symbols(vue).map((entry) => entry.name),
    ["feature", "helper"],
  );
  const ranges = vue.skipped.filter((entry) => entry.reason === "no_metric_defined");
  assert.equal(ranges.length, 2);
  assert(ranges.every((entry) => entry.path === "Widget.vue" && entry.subjectKind === "range"));
  assert.deepEqual(
    ranges.map((entry) =>
      Buffer.from(SOURCES["vue-fixture/Widget.vue"])
        .subarray(entry.range.startByte, entry.range.endByte)
        .toString("utf8"),
    ),
    [TEMPLATE, STYLE],
  );
  assert(
    !vue.skipped.some((entry) => ["parse_failed", "unsupported_language"].includes(entry.reason)),
  );
  assert.equal(incomplete.filesAnalyzed, 0);
  assert.deepEqual(incomplete.hotspots, []);
  assert.deepEqual(
    incomplete.skipped
      .filter((entry) => entry.reason === "parse_failed")
      .map((entry) => entry.path)
      .sort(),
    ["Broken.vue", "OnlyTemplate.vue"],
  );
}

export function assertFrontendBoundaryReport(report, selected = false) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "frontend-boundaries");
  assert.equal(report.status, "incomplete");
  assert.equal(report.freshness.status, "fresh");
  assert.equal(report.freshness.sourceTreeBefore, report.sourceTreeDigest);
  assert.equal(report.freshness.sourceTreeAfter, report.sourceTreeDigest);
  assert.deepEqual(report.freshness.changedPaths, []);
  assert.match(report.sourceTreeDigest, /^[a-f0-9]{64}$/u);
  assert.equal(report.http.summary.requests, 2);
  assert.equal(report.http.summary.resolved, 1);
  assert.equal(report.http.summary.unresolved, 1);
  assert.equal(report.http.summary.ambiguous, 0);
  assert.equal(report.http.summary.endpoints, 1);
  assert.equal(report.http.requests.length, 2);
  const resolved = report.http.requests.find((request) => request.status === "resolved");
  assert.equal(resolved.method, "GET");
  assert.equal(resolved.path, "/api/orders/{*}");
  assert.equal(resolved.source.path, "src/api.ts");
  assert.equal(resolved.source.contentHash, sha(SOURCES["frontend-fixture/src/api.ts"]));
  assert.equal(resolved.targets.length, 1);
  assert.equal(resolved.targets[0].handler, "load_order");
  assert.equal(resolved.targets[0].serviceId, "fixture-api");
  assert.equal(resolved.targets[0].path, "/api/orders/{id}");
  assert(
    resolved.targets[0].provenance.some(
      (entry) =>
        entry.path === "backend/app.py" &&
        entry.contentHash === sha(SOURCES["frontend-fixture/backend/app.py"]),
    ),
  );
  const unresolved = report.http.requests.find((request) => request.status === "unresolved");
  assert.equal(unresolved.path, null);
  assert.equal(unresolved.reason, "unbounded dynamic URL or path");
  assert.deepEqual(unresolved.targets, []);
  assert.equal(report.importContext.kind, "file-imports-not-function-calls");
  assert(
    report.importContext.requestImporters.some(
      (entry) =>
        entry.requestPath === "src/api.ts" && entry.path === "src/App.vue" && entry.distance === 1,
    ),
  );
  assert.equal(report.features.dependencySemantics, "declared_dependencies_unchanged");
  assert.equal(report.truncation.truncated, false);
  if (selected)
    assert.deepEqual(report.selection, {
      path: "src/App.vue",
      inInventory: true,
      matchingRequests: 2,
    });
}

export function assertAdvertisedFrontendTool(tool) {
  assert.equal(tool.name, "untangle_boundaries");
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.root.type, "string");
  assert.equal(tool.inputSchema.properties.maxRelations.minimum, 1);
  assert.equal(tool.inputSchema.properties.maxRelations.maximum, 1000);
  const branches = tool.outputSchema.oneOf ?? tool.outputSchema.anyOf;
  assert(Array.isArray(branches));
  const success = branches.find((branch) => branch.properties?.ok?.const === true);
  assert.equal(success.properties.operation.const, "untangle_boundaries");
  const data = success.properties.data;
  assert.equal(data.type, "object");
  assert.equal(data.properties.kind.const, "frontend-boundaries");
  assert.deepEqual(data.properties.http.properties.requests.items.properties.status.enum, [
    "resolved",
    "ambiguous",
    "unresolved",
  ]);
}

function response(result, ok) {
  assert.equal(result.isError, !ok);
  assert.equal(result.structuredContent.schemaVersion, 1);
  assert.equal(result.structuredContent.ok, ok);
  assert.equal(result.structuredContent.operation, "untangle_boundaries");
  assert.deepEqual(result.content, [
    { type: "text", text: JSON.stringify(result.structuredContent) },
  ]);
  return result.structuredContent;
}

/** Offline verifier shares concrete fixture assertions, never just a success boolean. */
export function assertFrontendConsumerProof(proof) {
  assert.equal(proof.verified, true);
  assert.deepEqual(proof.checks, FRONTEND_CHECKS);
  assert.deepEqual(proof.sourceFiles, frontendSourceRecords());
  assert.equal(proof.sourceBefore, sha(JSON.stringify(proof.sourceFiles)));
  assert.equal(proof.sourceAfter, proof.sourceBefore);
  assert(path.isAbsolute(proof.root));
  assert.equal(path.basename(proof.root), "frontend-fixture");
  const consumerRoot = path.dirname(proof.root);
  assert.equal(proof.vueRoot, path.join(consumerRoot, "vue-fixture"));
  assert.equal(proof.nativeRoot, path.join(consumerRoot, "native-fixture"));
  assert.equal(proof.incompleteRoot, path.join(consumerRoot, "vue-incomplete-fixture"));
  for (const name of ["coreEntry", "mcpEntry"]) {
    assert.equal(path.posix.isAbsolute(proof[name]), false);
    assert(!proof[name].split("/").includes(".."));
    assert(proof[name].includes("node_modules/"));
    assert(
      proof[name].endsWith(name === "coreEntry" ? "/core/dist/index.js" : "/cli/dist/mcp/index.js"),
    );
  }
  for (const name of [
    "UNTANGLE_MCP_TOOLS",
    "toolResponseEnvelopeSchema",
    "createUntangleMcpServer",
    "serveUntangleMcpStdio",
  ])
    assert(proof.mcpExports.includes(name));
  const reports = {};
  const binary = proof.cli.vue.command[0];
  assert.equal(assertFrontendConsumerPath(consumerRoot, binary), "node_modules/.bin/untangle");
  for (const execution of Object.values(proof.cli)) assert.equal(execution.command[0], binary);
  for (const name of ["vue", "native", "incomplete", "boundaries", "selected"]) {
    assert.equal(proof.cli[name].exitCode, 0);
    assert.equal(proof.cli[name].stderr, "");
    reports[name] = JSON.parse(proof.cli[name].stdout);
  }
  for (const [name, root] of [
    ["vue", proof.vueRoot],
    ["native", proof.nativeRoot],
    ["incomplete", proof.incompleteRoot],
  ])
    assert.deepEqual(proof.cli[name].command.slice(1), [
      "complexity",
      `--root=${root}`,
      "--format=json",
    ]);
  assert.deepEqual(proof.cli.boundaries.command.slice(1), [
    "graph",
    "boundaries",
    `--root=${proof.root}`,
    "--format=json",
  ]);
  assert.deepEqual(proof.cli.selected.command.slice(1), [
    "graph",
    "boundaries",
    `--root=${proof.root}`,
    "--path=src/App.vue",
    "--format=json",
  ]);
  for (const name of ["invalidPath", "invalidLimit"]) {
    assert.equal(proof.cli[name].exitCode, 2);
    assert(proof.cli[name].stderr.length > 0);
  }
  assert.deepEqual(proof.cli.invalidPath.command.slice(1), [
    "graph",
    "boundaries",
    `--root=${proof.root}`,
    "--path=../outside.vue",
    "--format=json",
  ]);
  assert.deepEqual(proof.cli.invalidLimit.command.slice(1), [
    "graph",
    "boundaries",
    `--root=${proof.root}`,
    "--max-relations=0",
    "--format=json",
  ]);
  assertVueConsumerMetrics(reports.vue, reports.native, reports.incomplete);
  assertFrontendBoundaryReport(reports.boundaries);
  assertFrontendBoundaryReport(reports.selected, true);
  const control = {
    path: ".untangle/services.json",
    status: "loaded",
    contentHash: sha(SOURCES["frontend-fixture/.untangle/services.json"]),
  };
  assert.equal(reports.boundaries.root, proof.root);
  assert.equal(reports.selected.root, proof.root);
  assert.deepEqual(reports.boundaries.servicesManifest, control);
  assert.deepEqual(reports.selected.servicesManifest, control);
  assertAdvertisedFrontendTool(proof.mcp.tool);
  assert.deepEqual(response(proof.mcp.boundaries, true).data, reports.boundaries);
  assert.deepEqual(response(proof.mcp.selected, true).data, reports.selected);
  const error = response(proof.mcp.invalidLimit, false).error;
  assert.equal(error.code, "INVALID_ARGUMENT");
  assert.equal(error.retryable, false);
  const withoutControl = ({ servicesManifest: _control, ...data }) => data;
  assert.deepEqual(withoutControl(reports.boundaries), proof.api);
  assert.deepEqual(withoutControl(reports.selected), proof.selectedApi);
}

async function installedContracts(consumerRoot) {
  const cliManifest = realpathSync(
    path.join(consumerRoot, "node_modules/@untangle-code/cli/package.json"),
  );
  assertFrontendConsumerPath(consumerRoot, cliManifest);
  const resolver = createRequire(cliManifest);
  const coreEntry = realpathSync(resolver.resolve("@untangle-code/core"));
  const mcpEntry = realpathSync(resolver.resolve("@untangle-code/cli/mcp"));
  const coreRelative = assertFrontendConsumerPath(consumerRoot, coreEntry);
  const mcpRelative = assertFrontendConsumerPath(consumerRoot, mcpEntry);
  const core = await import(pathToFileURL(coreEntry).href);
  const mcp = await import(pathToFileURL(mcpEntry).href);
  assert.equal(typeof core.analyzeFrontendBoundaries, "function");
  assert.equal(typeof mcp.toolResponseEnvelopeSchema.safeParse, "function");
  return { core, mcp, coreEntry: coreRelative, mcpEntry: mcpRelative };
}

async function consumerStage(stage, executionPath) {
  assert(["prepare", "verify"].includes(stage), "Unknown frontend consumer stage.");
  const consumerRoot = realpathSync(process.cwd());
  const contracts = await installedContracts(consumerRoot);
  const root = path.join(consumerRoot, "frontend-fixture");
  const baselinePath = path.join(root, ".untangle/baseline.json");
  if (stage === "prepare") {
    const prepared = createFrontendFixture(consumerRoot);
    const sourceFiles = hashes(consumerRoot);
    assert.deepEqual(sourceFiles, frontendSourceRecords());
    const api = await contracts.core.analyzeFrontendBoundaries({
      root,
      services: SERVICES,
      maxRelations: 200,
    });
    const selectedApi = await contracts.core.analyzeFrontendBoundaries({
      root,
      services: SERVICES,
      path: "src/App.vue",
      maxRelations: 200,
    });
    assertFrontendBoundaryReport(api);
    assertFrontendBoundaryReport(selectedApi, true);
    const baseline = {
      ...prepared,
      sourceFiles,
      sourceBefore: sha(JSON.stringify(sourceFiles)),
      api,
      selectedApi,
    };
    writeFileSync(baselinePath, JSON.stringify(baseline), { flag: "wx" });
    return { ...prepared, executionPath: path.join(root, ".untangle/execution.json") };
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const execution = JSON.parse(readFileSync(executionPath, "utf8"));
  assert.deepEqual(hashes(consumerRoot), baseline.sourceFiles);
  for (const name of ["boundaries", "selected", "invalidLimit"])
    contracts.mcp.toolResponseEnvelopeSchema.parse(execution.mcp[name].structuredContent);
  const proof = {
    verified: true,
    ...baseline,
    sourceAfter: sha(JSON.stringify(hashes(consumerRoot))),
    coreEntry: contracts.coreEntry,
    mcpEntry: contracts.mcpEntry,
    mcpExports: Object.keys(contracts.mcp).sort(),
    cli: execution.cli,
    mcp: execution.mcp,
    checks: FRONTEND_CHECKS,
  };
  assertFrontendConsumerProof(proof);
  return proof;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(
    JSON.stringify(await consumerStage(process.argv[2], process.argv[3])) + "\n",
  );
}
