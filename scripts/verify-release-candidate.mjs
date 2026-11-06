#!/usr/bin/env node
/** Offline verification of downloaded evidence; never repacks or publishes. */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { assertFrontendConsumerProof } from "./release-frontend-consumer.mjs";
import { assertLocalSearchConsumerProof } from "./release-local-search-consumer.mjs";
import { orderReleasePackages, validateProductionSbom } from "./release-smoke.mjs";

export const PUBLIC_PACKAGES = Object.freeze(
  [
    "chunker",
    "cli",
    "complexity",
    "config",
    "context-artifacts",
    "core",
    "domain",
    "embeddings-ollama",
    "extension-runtime",
    "file-graph",
    "graph-explorer",
    "jobs",
    "observability",
    "parser-registry",
    "scanner",
    "search",
    "storage-local",
    "storage-lancedb",
    "storage-qdrant",
    "symbol-graph",
    "watcher",
  ].map((name) => `@untangle-code/${name}`).sort(),
);
const GATES = [
  "install",
  "build",
  "typecheck",
  "lint",
  "unit",
  "packages",
  "licenses",
  "publishable",
  "e2e-smoke",
  "release",
];
const VERSION = "0.1.0";
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort(compare)
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");

function safePath(value) {
  requireThat(
    typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !path.posix.isAbsolute(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    `Unsafe artifact path: ${String(value)}`,
  );
  return value;
}

/** Reject links and preserve every directory/file identity, including empty directories. */
function snapshot(root) {
  const entries = [];
  let bytes = 0;
  function visit(file) {
    const stat = lstatSync(file);
    requireThat(!stat.isSymbolicLink(), `Artifact symlink is not allowed: ${file}`);
    requireThat(stat.isDirectory() || stat.isFile(), `Unsupported artifact entry: ${file}`);
    requireThat(entries.length < 50_000, "Artifact inventory exceeds 50000 entries.");
    const item = {
      path: relative(root, file),
      type: stat.isDirectory() ? "directory" : "file",
      mode: stat.mode & 0o777,
    };
    if (stat.isDirectory()) {
      if (file !== root) entries.push(item);
      for (const name of readdirSync(file).sort(compare)) visit(path.join(file, name));
    } else {
      requireThat(stat.size <= 256 * 1024 * 1024, `Artifact is too large: ${file}`);
      const data = readFileSync(file);
      bytes += data.length;
      requireThat(bytes <= 512 * 1024 * 1024, "Artifact inventory exceeds 512 MiB.");
      entries.push({ ...item, bytes: data.length, sha256: hash(data) });
    }
  }
  requireThat(
    lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
    `Artifact root is not a regular directory: ${root}`,
  );
  visit(root);
  return entries;
}

function reader(root, entries) {
  const files = new Map(
    entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]),
  );
  function bytes(file) {
    safePath(file);
    const entry = files.get(file);
    requireThat(entry, `Missing artifact: ${file}`);
    const data = readFileSync(path.join(root, file));
    requireThat(
      hash(data) === entry.sha256 && data.length === entry.bytes,
      `Artifact changed during verification: ${file}`,
    );
    return data;
  }
  function bound(reference) {
    requireThat(
      object(reference) && HASH.test(reference.sha256),
      "Invalid artifact hash reference.",
    );
    const data = bytes(reference.path);
    requireThat(hash(data) === reference.sha256, `Artifact hash mismatch: ${reference.path}`);
    if (reference.bytes !== undefined)
      requireThat(reference.bytes === data.length, `Artifact size mismatch: ${reference.path}`);
    return data;
  }
  function json(file) {
    return JSON.parse(bytes(file).toString("utf8"));
  }
  function manifest(reference, expected, allowEmpty = false) {
    const entries = JSON.parse(bound(reference).toString("utf8"));
    requireThat(
      Array.isArray(entries) && (allowEmpty || entries.length > 0),
      "Missing source/dist manifest entries.",
    );
    let previous;
    for (const item of entries) {
      requireThat(
        object(item) && Object.keys(item).length === 2 && HASH.test(item.sha256),
        "Invalid source/dist manifest entry.",
      );
      safePath(item.path);
      requireThat(
        previous === undefined || compare(previous, item.path) < 0,
        "Source/dist manifest must be unique and sorted.",
      );
      previous = item.path;
    }
    requireThat(
      HASH.test(expected) && hash(JSON.stringify(entries)) === expected,
      "Source/dist canonical digest mismatch.",
    );
    return entries;
  }
  return { bytes, bound, json, manifest, files };
}

function tarNumber(bytes) {
  requireThat((bytes[0] & 0x80) === 0, "Unsupported tar numeric encoding.");
  const text = bytes.toString("ascii").replaceAll("\0", "").trim();
  requireThat(/^[0-7]+$/u.test(text), "Invalid tar size/checksum.");
  const value = Number.parseInt(text, 8);
  requireThat(Number.isSafeInteger(value), "Unsafe tar size.");
  return value;
}

function paxFields(bytes) {
  const fields = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    requireThat(space > offset, "Invalid PAX record.");
    const length = Number(bytes.subarray(offset, space).toString("ascii"));
    requireThat(
      Number.isSafeInteger(length) &&
        length > space - offset + 1 &&
        offset + length <= bytes.length &&
        bytes[offset + length - 1] === 10,
      "Invalid PAX record length.",
    );
    const text = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const separator = text.indexOf("=");
    requireThat(separator > 0, "Invalid PAX field.");
    fields[text.slice(0, separator)] = text.slice(separator + 1);
    offset += length;
  }
  return fields;
}

/** Inspect without extracting archive paths or running package code. */
export function readPackedManifest(compressed) {
  const data = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
  let manifest;
  let localPax = {};
  let globalPax = {};
  let ended = false;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      requireThat(
        data.subarray(offset).every((byte) => byte === 0),
        "Nonzero bytes after tar terminator.",
      );
      ended = true;
      break;
    }
    const storedChecksum = tarNumber(header.subarray(148, 156));
    const actualChecksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    requireThat(storedChecksum === actualChecksum, "Tar header checksum mismatch.");
    const size = tarNumber(header.subarray(124, 136));
    const end = offset + 512 + size;
    requireThat(end <= data.length, "Truncated tar entry.");
    const body = data.subarray(offset + 512, end);
    const type = header[156];
    if (type === 120 || type === 103) {
      const fields = paxFields(body);
      requireThat(
        fields.size === undefined && fields.linkpath === undefined,
        "Unsupported PAX size/link override.",
      );
      if (type === 120) localPax = fields;
      else globalPax = { ...globalPax, ...fields };
    } else {
      requireThat(
        type === 0 || type === 48 || type === 53,
        "Tar links/special entries are not allowed.",
      );
      requireThat(
        header.subarray(157, 257).every((byte) => byte === 0),
        "Tar link target is not allowed.",
      );
      const text = (start, end) => header.subarray(start, end).toString("utf8").split("\0")[0];
      const prefix = text(345, 500);
      const name =
        localPax.path ?? globalPax.path ?? `${prefix ? `${prefix}/` : ""}${text(0, 100)}`;
      safePath(name.replace(/\/$/u, ""));
      if (name === "package/package.json") {
        requireThat(type === 0 || type === 48, "Packed package.json must be a regular file.");
        requireThat(
          manifest === undefined && size <= 2 * 1024 * 1024,
          "Duplicate or oversized packed package.json.",
        );
        manifest = JSON.parse(body.toString("utf8"));
      }
      localPax = {};
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireThat(ended && object(manifest), "Tarball has no complete package/package.json.");
  return manifest;
}

function verifyGit(value, commit, tree) {
  requireThat(
    object(value) &&
      value.revision === commit &&
      (!value.sha || value.sha === commit) &&
      COMMIT.test(value.tree) &&
      value.dirty === "",
    "Evidence Git SHA/tree/clean-worktree mismatch.",
  );
  if (tree !== undefined) requireThat(value.tree === tree, "Gate Git tree differs from checkout.");
}

function unitIdentities(unit, sourcePaths) {
  const keys = [
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
  ];
  requireThat(
    keys.every((key) => Number.isInteger(unit[key]) && unit[key] >= 0) &&
      unit.success === true &&
      unit.numPassedTests > 0 &&
      unit.numFailedTests === 0 &&
      unit.numFailedTestSuites === 0 &&
      unit.numPendingTestSuites === 0,
    "Unit report is not a successful executed suite.",
  );
  requireThat(
    unit.numTotalTests ===
      unit.numPassedTests + unit.numFailedTests + unit.numPendingTests + unit.numTodoTests &&
      unit.numTotalTestSuites > 0 &&
      unit.numTotalTestSuites ===
        unit.numPassedTestSuites + unit.numFailedTestSuites + unit.numPendingTestSuites,
    "Unit summary counts do not reconcile.",
  );
  requireThat(
    Array.isArray(unit.testResults) && unit.testResults.length > 0,
    "Unit test identities are missing.",
  );
  const cases = [];
  const seen = new Set();
  const counts = { passed: 0, skipped: 0, todo: 0 };
  for (const file of unit.testResults) {
    requireThat(
      typeof file.name === "string" &&
        file.status === "passed" &&
        Array.isArray(file.assertionResults),
      "Unit file result did not pass.",
    );
    const matches = sourcePaths.filter(
      (name) => file.name === name || file.name.endsWith(`/${name}`),
    );
    requireThat(
      matches.length === 1,
      "Unit source path is not uniquely bound to the source manifest.",
    );
    for (const test of file.assertionResults) {
      requireThat(
        typeof test.fullName === "string" &&
          test.fullName.length > 0 &&
          Object.hasOwn(counts, test.status) &&
          (!test.failureMessages || test.failureMessages.length === 0),
        "Invalid or unfinished unit case.",
      );
      const id = JSON.stringify([matches[0], test.fullName]);
      requireThat(!seen.has(id), "Duplicate unit case identity.");
      seen.add(id);
      counts[test.status] += 1;
      cases.push({ path: matches[0], name: test.fullName, status: test.status });
    }
  }
  requireThat(
    cases.length === unit.numTotalTests &&
      counts.passed === unit.numPassedTests &&
      counts.skipped === unit.numPendingTests &&
      counts.todo === unit.numTodoTests,
    "Unit identity counts differ from summary.",
  );
  cases.sort((a, b) => compare(a.path, b.path) || compare(a.name, b.name));
  return cases;
}

function verifyGates(evidence, read, commit) {
  const source = evidence.source;
  const dist = evidence.dist;
  requireThat(
    source?.stable === true && source.beforeDigest === source.afterDigest,
    "Source snapshot is not stable.",
  );
  requireThat(
    dist?.stableAfterBuild === true && dist.builtDigest === dist.afterDigest,
    "Built dist snapshot is not stable.",
  );
  const sources = read.manifest(source.beforeManifest, source.beforeDigest);
  read.manifest(source.afterManifest, source.afterDigest);
  read.manifest(dist.builtManifest, dist.builtDigest);
  read.manifest(dist.afterManifest, dist.afterDigest);
  requireThat(
    Array.isArray(evidence.gates) &&
      equal(
        evidence.gates.map((gate) => gate.name),
        GATES,
      ),
    "Missing, duplicate or out-of-order required release gates.",
  );
  const unitOutput = evidence.gates[4].command?.[4];
  const releaseOutput = evidence.gates[9].command?.[3];
  const origin =
    typeof unitOutput === "string" &&
    unitOutput.startsWith("--outputFile=") &&
    unitOutput.endsWith("/gates/unit-report.json")
      ? unitOutput.slice(13, -"/gates/unit-report.json".length)
      : undefined;
  requireThat(
    origin &&
      path.posix.isAbsolute(origin) &&
      path.posix.normalize(origin) === origin &&
      releaseOutput === `--out-dir=${origin}/bundle`,
    "Unit/release output commands do not bind one evidence root.",
  );
  const commands = [
    ["pnpm", "install", "--frozen-lockfile"],
    ["pnpm", "run", "build"],
    ["pnpm", "run", "typecheck"],
    ["pnpm", "run", "lint"],
    [
      "pnpm",
      "run",
      "test:unit",
      "--reporter=json",
      `--outputFile=${origin}/gates/unit-report.json`,
    ],
    ["pnpm", "--workspace-concurrency=1", "-r", "--if-present", "run", "test"],
    ["pnpm", "run", "check-licenses"],
    ["pnpm", "run", "check-publishable"],
    ["pnpm", "run", "e2e:smoke"],
    ["pnpm", "run", "e2e:release", `--out-dir=${origin}/bundle`],
  ];
  let lastDist = dist.initialDigest;
  let identities;
  for (const gate of evidence.gates) {
    requireThat(
      gate.status === "passed" &&
        gate.exitCode === 0 &&
        gate.signal === null &&
        !gate.operationalError &&
        (!gate.bindingErrors || gate.bindingErrors.length === 0),
      `Release gate failed: ${gate.name}`,
    );
    requireThat(
      equal(gate.command, commands[GATES.indexOf(gate.name)]),
      `Wrong required gate command: ${gate.name}`,
    );
    requireThat(
      gate.sourceStable === true &&
        gate.sourceBeforeDigest === source.beforeDigest &&
        gate.sourceAfterDigest === source.beforeDigest,
      `Gate source binding changed: ${gate.name}`,
    );
    requireThat(gate.distBeforeDigest === lastDist, `Dist sequence changed before ${gate.name}`);
    requireThat(
      gate.distStable === (gate.distBeforeDigest === gate.distAfterDigest),
      `False dist stability flag: ${gate.name}`,
    );
    if (gate.name === "build")
      requireThat(gate.distAfterDigest === dist.builtDigest, "Build did not bind final dist.");
    else requireThat(gate.distStable === true, `Dist changed outside build: ${gate.name}`);
    for (const side of ["Before", "After"]) {
      read.manifest(gate.manifests?.[`sources${side}`], gate[`source${side}Digest`]);
      read.manifest(gate.manifests?.[`dist${side}`], gate[`dist${side}Digest`], true);
    }
    verifyGit(gate.gitBefore, commit, evidence.git.tree);
    verifyGit(gate.gitAfter, commit, evidence.git.tree);
    read.bound(gate.stdout);
    read.bound(gate.stderr);
    requireThat(Array.isArray(gate.reports), `Missing gate report bindings: ${gate.name}`);
    for (const report of gate.reports) read.bound(report);
    const retained = read.json(`gates/${gate.name}.json`);
    requireThat(equal(retained, gate), `Retained gate ledger differs: ${gate.name}`);
    if (gate.name === "unit") {
      requireThat(
        gate.reports.some((report) => report.path === "gates/unit-report.json"),
        "Missing bound unit report.",
      );
      const unit = read.json("gates/unit-report.json");
      identities = unitIdentities(
        unit,
        sources.map((file) => file.path),
      );
    }
    if (gate.name === "release")
      requireThat(
        gate.reports.some(
          (report) =>
            report.path === "bundle/release-report.json" &&
            report.sha256 === evidence.bundle?.releaseReport?.sha256,
        ),
        "Release gate did not bind bundle report.",
      );
    lastDist = gate.distAfterDigest;
  }
  requireThat(lastDist === dist.afterDigest, "Final dist differs from last gate.");
  return identities;
}

function verifyProduct(runtime, executable) {
  const product = runtime.product;
  const checkNames = [
    "installed-core-resolution",
    "real-node-tests-source-bound",
    "installed-product-code-and-test-metrics",
    "cli-api-report-equality",
    "declared-ownership-needs-review-exit5",
    "installed-init-feature-map-dry-run",
    "installed-mcp-product-report-equality",
    "stale-evidence-fails-gate",
  ];
  requireThat(
    product?.verified === true &&
      equal(product.checks, checkNames) &&
      typeof product.coreEntry === "string" &&
      safePath(product.coreEntry).includes("node_modules/") &&
      HASH.test(product.sourceBefore) &&
      product.sourceBefore === product.sourceAfterTests &&
      product.api?.sourceTreeDigest === product.sourceBefore,
    "Installed product source/API proof is missing.",
  );
  const tests = product.tests;
  const evidence = tests?.evidence;
  requireThat(
    tests?.exitCode === 0 &&
      tests.stderr === "" &&
      equal(tests.command, [
        executable,
        "--test",
        "--test-reporter=tap",
        `${product.root}/main.test.js`,
      ]) &&
      evidence?.sourceTreeBefore === product.sourceBefore &&
      evidence.sourceTreeAfter === product.sourceAfterTests &&
      evidence.exitCode === 0 &&
      equal(evidence.command, tests.command) &&
      hash(JSON.stringify(evidence)) === tests.evidenceSha256,
    "Installed product test execution is not source-bound.",
  );
  const cases = ["positive", "nonpositive", "invalid"];
  requireThat(
    equal(
      evidence.tests,
      cases.map((name) => ({ path: "main.test.js", name, status: "passed" })),
    ) &&
      equal(
        [...tests.stdout.matchAll(/^ok \d+ - ([^\r\n]+)$/gmu)].map((m) => m[1]),
        cases,
      ) &&
      /^# tests 3\s*$/mu.test(tests.stdout) &&
      /^# pass 3\s*$/mu.test(tests.stdout) &&
      /^# fail 0\s*$/mu.test(tests.stdout),
    "Installed product case identities did not all pass.",
  );
  const api = product.api;
  const feature = api.features?.[0];
  requireThat(
    api.status === "needs_review" &&
      api.semanticConformance === "not_independently_proven" &&
      api.ownershipAuthority === "manifest_declarations" &&
      feature?.id === "fixture.classification" &&
      feature.code?.complete === true &&
      feature.tests?.complete === true &&
      feature.code.metrics?.executionUnitRoots >= 1 &&
      feature.tests.metrics?.executionUnitRoots >= 1 &&
      feature.testEvidence?.status === "bound_passed" &&
      feature.criteria?.[0]?.status === "passed",
    "Installed product metrics/authority proof differs.",
  );
  for (const [name, expected] of [
    ["cli", 0],
    ["reviewGate", 5],
  ]) {
    const command = product[name];
    requireThat(
      command?.exitCode === expected &&
        command.stderr === "" &&
        equal(JSON.parse(command.stdout), api),
      "Installed product CLI/API equality or review gate differs.",
    );
  }
  const init = JSON.parse(product.init?.stdout ?? "null");
  requireThat(
    product.init?.exitCode === 0 &&
      product.init.stderr === "" &&
      init?.outcome === "would-create" &&
      init.findings?.featureAlignment?.features?.[0]?.id === feature.id &&
      init.findings.featureAlignment.features[0].code.complete === true &&
      init.findings.featureAlignment.features[0].testEvidence.status === "not_run",
    "Installed init dry-run proof differs.",
  );
  requireThat(
    product.mcp?.ok === true &&
      product.mcp.operation === "untangle_product" &&
      equal(product.mcp.data, api) &&
      equal(runtime.mcp.product, product.mcp),
    "Installed MCP product/API equality differs.",
  );
  const stale = JSON.parse(product.stale?.stdout ?? "null");
  requireThat(
    product.stale?.exitCode === 5 &&
      product.stale.stderr === "" &&
      HASH.test(stale?.sourceTreeDigest) &&
      stale.sourceTreeDigest !== product.sourceAfterTests &&
      stale.features?.[0]?.testEvidence?.status === "stale" &&
      stale.features[0].criteria?.[0]?.status === "not_run",
    "Installed stale evidence gate differs.",
  );
}

function verifyConsumers(report, executable) {
  requireThat(
    Array.isArray(report.consumers) &&
      equal(report.consumers.map((c) => c.packageManager).sort(compare), ["npm", "pnpm"]),
    "Both npm and pnpm consumers must pass.",
  );
  for (const consumer of report.consumers) {
    const cli = consumer.cliOnly;
    requireThat(
      cli?.requested === `@untangle-code/cli@${VERSION}` &&
        cli.installation?.exitCode === 0 &&
        strings(cli.installation.command) &&
        cli.installation.command[0] === consumer.packageManager &&
        equal(
          cli.installation.command.filter((arg) => arg.startsWith("@untangle-code/")),
          [cli.requested],
        ),
      "CLI-only original install proof is missing.",
    );
    const runtime = cli.runtime;
    requireThat(
      typeof runtime?.cliVersion === "string" && runtime.cliVersion.includes(VERSION),
      "Installed CLI runtime version differs.",
    );
    requireThat(
      runtime.complexity?.filesAnalyzed === 2 &&
        runtime.complexity.totals?.executionUnits >= 2 &&
        equal(runtime.complexity.skipped, []),
      "Installed native parser proof is missing.",
    );
    requireThat(
      runtime.mcp?.about?.ok === true &&
        runtime.mcp.about.data?.version === VERSION &&
        runtime.mcp.stderr === "" &&
        strings(runtime.mcp.toolNames) &&
        runtime.mcp.toolNames.includes("untangle_about") &&
        runtime.mcp.toolNames.includes("untangle_product"),
      "Installed MCP stdio proof is missing.",
    );
    requireThat(
      Array.isArray(consumer.imports?.installed) &&
        consumer.imports.installed.length === PUBLIC_PACKAGES.length &&
        equal(consumer.imports.installed.map((item) => item.name).sort(compare), PUBLIC_PACKAGES) &&
        consumer.imports.installed.every((item) => item.version === VERSION),
      "All public package import proof is missing.",
    );
    verifyProduct(runtime, executable);
    try {
      assertLocalSearchConsumerProof(runtime.localSearch);
    } catch (error) {
      throw new Error(`Installed LanceDB search consumer proof is missing or invalid: ${error.message}`);
    }
    try {
      requireThat(
        runtime.mcp.toolNames.includes("untangle_boundaries"),
        "Missing boundaries tool.",
      );
      assertFrontendConsumerProof(runtime.frontend);
      requireThat(equal(runtime.mcp.frontend, runtime.frontend.mcp), "MCP frontend proof differs.");
    } catch (error) {
      throw new Error(
        `Installed frontend/Vue/HTTP consumer proof is missing or invalid: ${error.message}`,
      );
    }
  }
}

function verifyBundle(evidence, read, commit) {
  const bundle = evidence.bundle;
  requireThat(
    bundle?.path === "bundle" &&
      bundle.gitRevision === commit &&
      bundle.releaseReport?.path === "bundle/release-report.json",
    "Bundle Git/path binding differs.",
  );
  const report = JSON.parse(read.bound(bundle.releaseReport).toString("utf8"));
  requireThat(
    report.schemaVersion === 1 &&
      report.verified === true &&
      report.source?.stable === true &&
      report.node === evidence.node &&
      report.platform === evidence.platform &&
      report.arch === evidence.arch,
    "Release report is not verified for this context.",
  );
  const snapshots = [report.source.before, report.source.afterPack, report.source.after];
  requireThat(
    snapshots.every(
      (item) =>
        item?.gitRevision === commit &&
        item.dirty === "" &&
        HASH.test(item.contentSha256) &&
        item.contentSha256 === snapshots[0].contentSha256 &&
        item.files > 0 &&
        item.files === snapshots[0].files,
    ),
    "Release source report is not bound to stable clean checkout bytes.",
  );
  requireThat(
    Array.isArray(report.packages) &&
      report.packages.length === 21 &&
      equal(report.packages.map((p) => p.name).sort(compare), PUBLIC_PACKAGES) &&
      equal(bundle.packages, report.packages),
    "Expected exactly 21 bound public packages.",
  );
  requireThat(
    report.publishable?.packed === true &&
      equal(report.publishable.findings, []) &&
      equal([...report.publishable.published].sort(compare), PUBLIC_PACKAGES),
    "Packed package checks did not pass.",
  );
  const artifacts = [];
  const records = [];
  for (const record of report.packages) {
    const expectedFile = `${record.name.slice(1).replace("/", "-")}-${VERSION}.tgz`;
    requireThat(
      record.version === VERSION && record.file === expectedFile && HASH.test(record.sha256),
      "Tarball identity/version differs.",
    );
    const file = `bundle/tarballs/${record.file}`;
    const bytes = read.bytes(file);
    requireThat(
      bytes.length === record.bytes &&
        hash(bytes) === record.sha256 &&
        `sha512-${hash(bytes, "sha512", "base64")}` === record.integrity,
      `Original tarball integrity differs: ${record.name}`,
    );
    const manifest = readPackedManifest(bytes);
    requireThat(
      manifest.name === record.name &&
        manifest.version === VERSION &&
        manifest.private !== true &&
        manifest.publishConfig?.access === "public",
      `Packed public manifest differs: ${record.name}`,
    );
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      requireThat(
        manifest[field] === undefined || object(manifest[field]),
        `Invalid packed dependency field: ${record.name}`,
      );
      for (const spec of Object.values(manifest[field] ?? {}))
        requireThat(
          typeof spec === "string" && !spec.startsWith("workspace:"),
          `Unresolved workspace dependency: ${record.name}`,
        );
    }
    artifacts.push({ manifest, tarball: file });
    records.push({ ...record, file });
  }
  requireThat(
    equal(
      orderReleasePackages(artifacts).map((item) => item.manifest.name),
      report.packages.map((p) => p.name),
    ),
    "Publish order is not deterministic dependency-first order.",
  );
  requireThat(
    equal(
      [...read.files.keys()].filter((file) => file.startsWith("bundle/tarballs/")).sort(compare),
      records.map((record) => record.file).sort(compare),
    ),
    "Unexpected or missing tarball files.",
  );
  const order = read.json("bundle/publish-order.json");
  requireThat(
    equal(
      order,
      report.packages.map(({ name, version, file }) => ({
        name,
        version,
        file: `tarballs/${file}`,
      })),
    ),
    "Publish-order manifest differs from original tarballs.",
  );
  requireThat(
    bundle.sbom?.path === "bundle/sbom.cdx.json" &&
      bundle.sbom.sha256 === report.sbom?.sha256 &&
      report.sbom.file === "sbom.cdx.json" &&
      report.sbom.format === "CycloneDX",
    "SBOM report binding is missing.",
  );
  const sbomBytes = read.bound(bundle.sbom);
  requireThat(
    sbomBytes.length === report.sbom.bytes &&
      sbomBytes.toString("utf8") === report.sbom.content &&
      report.sbom.generatedBy?.exitCode === 0 &&
      equal(report.sbom.generatedBy.command, [
        "npm",
        "sbom",
        "--sbom-format=cyclonedx",
        "--omit=dev",
      ]),
    "Original npm production SBOM differs.",
  );
  const detail = validateProductionSbom(sbomBytes.toString("utf8"), report.packages);
  requireThat(
    detail.specVersion === report.sbom.specVersion &&
      detail.componentCount === report.sbom.componentCount,
    "SBOM inventory metadata differs.",
  );
  const document = JSON.parse(sbomBytes.toString("utf8"));
  for (const record of report.packages) {
    const components = document.components.filter(
      (item) => (item.group ? `${item.group}/${item.name}` : item.name) === record.name,
    );
    requireThat(
      components.every(
        (item) =>
          typeof item.purl === "string" &&
          decodeURIComponent(item.purl.split(/[?#]/u)[0]) === `pkg:npm/${record.name}@${VERSION}`,
      ),
      `SBOM purl differs: ${record.name}`,
    );
    for (const component of components) {
      for (const digest of component.hashes ?? []) {
        if (digest.alg === "SHA-256")
          requireThat(digest.content === record.sha256, `SBOM SHA-256 differs: ${record.name}`);
        if (digest.alg === "SHA-512")
          requireThat(
            digest.content ===
              Buffer.from(record.integrity.slice("sha512-".length), "base64").toString("hex"),
            `SBOM SHA-512 differs: ${record.name}`,
          );
      }
    }
  }
  const checksums =
    report.packages.map((record) => `${record.sha256}  tarballs/${record.file}\n`).join("") +
    `${bundle.sbom.sha256}  sbom.cdx.json\n`;
  requireThat(
    read.bytes("bundle/SHA256SUMS").toString("utf8") === checksums,
    "SHA256SUMS differs from bound original bytes.",
  );
  requireThat(
    bundle.checksums?.path === "bundle/SHA256SUMS" &&
      bundle.publishOrder?.path === "bundle/publish-order.json",
    "Missing checksum/order artifact bindings.",
  );
  read.bound(bundle.checksums);
  read.bound(bundle.publishOrder);
  verifyConsumers(report, evidence.toolchain.nodeExecutable);
  return { records, report, manifests: artifacts.map((artifact) => artifact.manifest) };
}

export function verifyReleaseCandidates({ artifactsDir, commit }) {
  requireThat(
    typeof commit === "string" && COMMIT.test(commit),
    "--commit requires the exact lowercase 40-hex Git SHA.",
  );
  const root = path.resolve(artifactsDir);
  requireThat(
    lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
    "Artifact download root must be a regular directory.",
  );
  const names = readdirSync(root).sort(compare);
  requireThat(names.length === 4, "Exactly four matrix artifact directories are required.");
  const initial = names.map((name) => ({
    name,
    root: path.join(root, name),
    entries: snapshot(path.join(root, name)),
  }));
  const contexts = [];
  let actionRun;
  let sourceDigest;
  let gitTree;
  for (const artifact of initial) {
    const read = reader(artifact.root, artifact.entries);
    const evidence = read.json("evidence.json");
    requireThat(
      evidence.schemaVersion === 1 &&
        evidence.kind === "release_evidence" &&
        evidence.status === "verified" &&
        (evidence.verified === undefined || evidence.verified === true),
      "Candidate evidence is not verified.",
    );
    const major = /^v(22|24)\.[0-9]+\.[0-9]+$/u.exec(evidence.node)?.[1];
    const os =
      evidence.platform === "linux"
        ? "ubuntu-latest"
        : evidence.platform === "darwin"
          ? "macos-latest"
          : undefined;
    requireThat(
      major &&
        os &&
        evidence.toolchain?.node === evidence.node &&
        typeof evidence.toolchain.npm === "string" &&
        typeof evidence.toolchain.pnpm === "string",
      "Unsupported or inconsistent matrix toolchain.",
    );
    verifyGit(evidence.git, commit);
    const actions = evidence.actions;
    requireThat(
      actions?.sha === commit &&
        /^(?:[1-9][0-9]*)$/u.test(actions.runId) &&
        /^(?:[1-9][0-9]*)$/u.test(actions.runAttempt) &&
        actions.workflow === "Release candidate" &&
        actions.job === "candidate" &&
        typeof actions.repository === "string" &&
        actions.repository.includes("/") &&
        actions.runnerOS === (os === "ubuntu-latest" ? "Linux" : "macOS"),
      "Actions provenance/context mismatch.",
    );
    const run = {
      runId: actions.runId,
      runAttempt: actions.runAttempt,
      repository: actions.repository,
      workflow: actions.workflow,
    };
    if (actionRun === undefined) actionRun = run;
    else requireThat(equal(actionRun, run), "Matrix artifacts came from different Actions runs.");
    if (sourceDigest === undefined) {
      sourceDigest = evidence.source?.beforeDigest;
      gitTree = evidence.git.tree;
    } else
      requireThat(
        evidence.source?.beforeDigest === sourceDigest && evidence.git.tree === gitTree,
        "Matrix source inventories or Git trees differ.",
      );
    const unitCases = verifyGates(evidence, read, commit);
    const bundle = verifyBundle(evidence, read, commit);
    const fileReference = (ref) => ({ file: `${artifact.name}/${ref.path}`, sha256: ref.sha256 });
    contexts.push({
      os,
      nodeMajor: Number(major),
      nodeVersion: evidence.node,
      arch: evidence.arch,
      evidenceFile: `${artifact.name}/evidence.json`,
      evidenceSha256: hash(read.bytes("evidence.json")),
      artifactTreeDigest: hash(JSON.stringify(artifact.entries)),
      sourceDigest: evidence.source.afterDigest,
      distDigest: evidence.dist.afterDigest,
      unitIdentitiesSha256: hash(JSON.stringify(unitCases)),
      unitCases: unitCases.length,
      releaseReport: fileReference(evidence.bundle.releaseReport),
      sbom: fileReference(evidence.bundle.sbom),
      canonicalFiles: {
        bundleDirectory: `${artifact.name}/bundle`,
        checksumFile: fileReference(evidence.bundle.checksums),
        publishOrder: fileReference(evidence.bundle.publishOrder),
        tarballs: bundle.records.map((item) => ({
          ...item,
          file: `${artifact.name}/${item.file}`,
        })),
      },
      packedManifests: bundle.manifests,
    });
  }
  contexts.sort((a, b) => compare(a.os, b.os) || a.nodeMajor - b.nodeMajor);
  requireThat(
    equal(contexts.map((c) => `${c.os}:${c.nodeMajor}`).sort(compare), [
      "macos-latest:22",
      "macos-latest:24",
      "ubuntu-latest:22",
      "ubuntu-latest:24",
    ]),
    "Missing or duplicate OS/Node matrix context.",
  );
  const canonical = contexts.find((c) => c.os === "ubuntu-latest" && c.nodeMajor === 22);
  for (const context of contexts) {
    requireThat(
      equal(context.packedManifests, canonical.packedManifests),
      "Packed package manifests differ across the matrix.",
    );
    requireThat(
      context.unitIdentitiesSha256 === canonical.unitIdentitiesSha256,
      "Unit case identities/statuses differ across the matrix.",
    );
  }
  for (const artifact of initial)
    requireThat(
      equal(snapshot(artifact.root), artifact.entries),
      "Artifact directory changed during verification.",
    );
  requireThat(
    equal(readdirSync(root).sort(compare), names),
    "Artifact matrix changed during verification.",
  );
  return {
    schemaVersion: 1,
    kind: "release_compatibility",
    status: "verified",
    commit,
    version: VERSION,
    actions: actionRun,
    matrix: contexts.map(
      ({ canonicalFiles: _files, packedManifests: _manifests, ...context }) => context,
    ),
    canonical: {
      os: canonical.os,
      nodeMajor: canonical.nodeMajor,
      releaseReport: canonical.releaseReport,
      sbom: canonical.sbom,
      ...canonical.canonicalFiles,
    },
    limitations: [
      "Offline content verification relies on the committed CI wrapper and downloaded Actions provenance; the caller separately checks the workflow/run conclusions with GitHub.",
      "Each context verifies its own original archive bytes. Different OS/Node archive hashes are not claimed identical.",
      "The production SBOM describes npm's installed graph on its producing platform, not optional dependencies on every platform.",
      "No publishing, repacking, registry mutation or source modification was performed.",
    ],
  };
}

export function writeCompatibilityManifest(out, result, artifactsDir) {
  const destination = path.resolve(out);
  const root = realpathSync(artifactsDir);
  const parent = realpathSync(path.dirname(destination));
  const physical = path.join(parent, path.basename(destination));
  const inside = path.relative(root, physical);
  requireThat(
    inside !== "" && (inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)),
    "Compatibility output must be outside immutable artifacts.",
  );
  requireThat(!existsSync(destination), "Compatibility output already exists; refusing overwrite.");
  writeFileSync(destination, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
}

export function parseOptions(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = {};
  for (const arg of args) {
    const match = /^--(artifacts-dir|commit|out)=(.+)$/u.exec(arg);
    requireThat(
      match && options[match[1]] === undefined,
      `Unknown, empty or duplicate option: ${arg}`,
    );
    options[match[1]] = match[2];
  }
  requireThat(
    options["artifacts-dir"] && options.commit && options.out,
    "Required: --artifacts-dir=<download-root> --commit=<40hexSHA> --out=<new-file>",
  );
  return { artifactsDir: options["artifacts-dir"], commit: options.commit, out: options.out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help)
      process.stdout.write(
        "Usage: node scripts/verify-release-candidate.mjs --artifacts-dir=<four-downloaded-artifacts> --commit=<40hexSHA> --out=<new-compatibility-manifest.json>\nOffline only; the output must be outside the immutable artifact directories.\n",
      );
    else {
      const result = verifyReleaseCandidates(options);
      writeCompatibilityManifest(options.out, result, options.artifactsDir);
      process.stdout.write(
        `Verified four candidate contexts and 21 original ${VERSION} packages. Canonical: ubuntu-latest / Node 22.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Release candidate verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
