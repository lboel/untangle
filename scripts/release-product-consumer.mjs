#!/usr/bin/env node
/** Consumer-side stages contain no child processes; the release harness owns their deadlines. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CASE_NAMES = ["positive", "nonpositive", "invalid"];
const SOURCE =
  "export function classify(value) { if (typeof value !== 'number') throw new TypeError('Number required'); return value > 0 ? 1 : 0; }\n";
const SOURCE_FILES = [
  ".gitignore",
  "vision.md",
  "spec.md",
  "ownership.md",
  "main.js",
  "main.test.js",
  "untangle.features.json",
];
const EVIDENCE = ".untangle/tests.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertConsumerPath(consumerRoot, target) {
  const relative = path.relative(consumerRoot, target);
  assert(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Installed resolution escapes the consumer: ${target}`,
  );
  return relative;
}

/** Case identities come from the real TAP result, not from a success exit alone. */
export function fixtureTestIdentities(execution) {
  assert.equal(execution.exitCode, 0, execution.stderr + execution.stdout);
  assert.equal(execution.stderr, "");
  assert.match(execution.stdout, /^# tests 3\s*$/mu);
  assert.match(execution.stdout, /^# pass 3\s*$/mu);
  assert.match(execution.stdout, /^# fail 0\s*$/mu);
  const cases = [...execution.stdout.matchAll(/^ok \d+ - ([^\r\n]+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(cases, CASE_NAMES);
  return cases.map((name) => ({ path: "main.test.js", name, status: "passed" }));
}

function fixtureManifest() {
  return {
    schemaVersion: 1,
    owners: [
      {
        id: "fixture.maintainer",
        label: "Owned fixture role",
        kind: "role",
        status: "declared",
        sources: [{ path: "ownership.md", heading: "Maintainer" }],
      },
    ],
    features: [
      {
        id: "fixture.classification",
        title: "Classify numbers",
        stage: "implemented",
        review: "proposed",
        intent: [
          { role: "vision", path: "vision.md", heading: "Classification" },
          { role: "specification", path: "spec.md", heading: "Contract" },
        ],
        owners: ["fixture.maintainer"],
        code: { include: ["main.js"] },
        tests: { include: ["main.test.js"] },
        criteria: [
          {
            id: "fixture.behavior",
            description: "Positive, nonpositive, and invalid input contracts",
            tests: ["main.test.js"],
            testNames: CASE_NAMES,
          },
        ],
        dependsOn: [],
      },
    ],
  };
}

function hashes(root) {
  return SOURCE_FILES.map((relative) => ({
    path: relative,
    sha256: sha(readFileSync(path.join(root, relative))),
  }));
}

async function consumerStage(stage, executionPath) {
  const consumerRoot = realpathSync(process.cwd());
  const cliManifest = realpathSync(
    path.join(consumerRoot, "node_modules/@untangle-code/cli/package.json"),
  );
  assertConsumerPath(consumerRoot, cliManifest);
  const cliRequire = createRequire(cliManifest);
  const coreEntry = realpathSync(cliRequire.resolve("@untangle-code/core"));
  const coreRelative = assertConsumerPath(consumerRoot, coreEntry);
  const { analyzeProductAlignment } = await import(pathToFileURL(coreEntry).href);
  assert.equal(typeof analyzeProductAlignment, "function");
  const root = path.join(consumerRoot, "product-fixture");
  const baselinePath = path.join(root, ".untangle/baseline.json");
  if (stage === "prepare") {
    assert.equal(existsSync(root), false, "Product fixture must be fresh.");
    mkdirSync(path.join(root, ".untangle"), { recursive: true });
    writeFileSync(path.join(root, ".gitignore"), ".untangle/\n");
    writeFileSync(path.join(root, "vision.md"), "# Classification\nClassify numbers locally.\n");
    writeFileSync(
      path.join(root, "spec.md"),
      "# Contract\nPositive is one; nonpositive is zero; invalid input throws.\n",
    );
    writeFileSync(path.join(root, "ownership.md"), "# Maintainer\nOwned release-fixture role.\n");
    writeFileSync(path.join(root, "main.js"), SOURCE);
    writeFileSync(
      path.join(root, "main.test.js"),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { classify } from './main.js';\ntest('positive', () => assert.equal(classify(1), 1));\ntest('nonpositive', () => { assert.equal(classify(0), 0); assert.equal(classify(-1), 0); });\ntest('invalid', () => assert.throws(() => classify('x'), { name: 'TypeError', message: 'Number required' }));\n",
    );
    writeFileSync(path.join(root, "untangle.features.json"), JSON.stringify(fixtureManifest()));
    const sourceFiles = hashes(root);
    const before = await analyzeProductAlignment({ root });
    assert.equal(before.features[0]?.testEvidence.status, "not_run");
    const baseline = {
      root,
      coreEntry: coreRelative,
      sourceFiles,
      sourceTreeDigest: before.sourceTreeDigest,
    };
    writeFileSync(baselinePath, JSON.stringify(baseline));
    return baseline;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.deepEqual(hashes(root), baseline.sourceFiles);
  if (stage === "mutate") {
    writeFileSync(path.join(root, "main.js"), SOURCE.replace("value > 0", "value >= 0"));
    return { root, evidencePath: EVIDENCE };
  }
  if (stage === "unchanged") {
    assert.equal(existsSync(path.join(root, "untangle.toml")), false);
    return { sourceFiles: hashes(root), initWroteConfiguration: false };
  }
  assert.equal(stage, "verify", "Unknown consumer probe stage.");
  const execution = JSON.parse(readFileSync(executionPath, "utf8"));
  const tests = fixtureTestIdentities(execution);
  const after = await analyzeProductAlignment({ root });
  assert.equal(after.sourceTreeDigest, baseline.sourceTreeDigest);
  assert.deepEqual(hashes(root), baseline.sourceFiles);
  const evidence = {
    schemaVersion: 1,
    sourceTreeBefore: baseline.sourceTreeDigest,
    sourceTreeAfter: after.sourceTreeDigest,
    command: execution.command,
    exitCode: execution.exitCode,
    tests,
  };
  writeFileSync(path.join(root, EVIDENCE), JSON.stringify(evidence));
  const api = await analyzeProductAlignment({ root, testEvidencePath: EVIDENCE });
  assert.equal(api.status, "needs_review");
  assert.equal(api.features[0]?.testEvidence.status, "bound_passed");
  assert.equal(api.features[0]?.criteria[0]?.status, "passed");
  assert.equal(api.semanticConformance, "not_independently_proven");
  assert.equal(api.ownershipAuthority, "manifest_declarations");
  assert(api.features[0].code.metrics?.executionUnitRoots >= 1);
  assert(api.features[0].tests.metrics?.executionUnitRoots >= 1);
  assert.deepEqual(hashes(root), baseline.sourceFiles);
  return {
    verified: true,
    root,
    evidencePath: EVIDENCE,
    coreEntry: coreRelative,
    sourceBefore: baseline.sourceTreeDigest,
    sourceAfterTests: after.sourceTreeDigest,
    sourceFiles: baseline.sourceFiles,
    tests: { ...execution, evidence, evidenceSha256: sha(readFileSync(path.join(root, EVIDENCE))) },
    api,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await consumerStage(process.argv[2], process.argv[3]);
  process.stdout.write(JSON.stringify(result) + "\n");
}
