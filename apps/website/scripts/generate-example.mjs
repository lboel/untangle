#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const KINDS = ["feature", "code", "test", "owner", "intent", "unmapped"];
const EDGE_KINDS = ["code", "test", "ownership", "intent", "dependency"];
const METRIC_KEYS = [
  "metricsVersion",
  "cognitiveAlgorithm",
  "cognitive",
  "cyclomaticClassic",
  "cyclomaticExtended",
  "files",
  "scopes",
  "executionUnitRoots",
  "sloc",
  "cyclomaticPerScopeBase",
];
const DIMENSION_KEYS = [
  "requirements",
  "owners",
  "codeFiles",
  "testFiles",
  "sharedCodeFiles",
  "declaredDependencies",
  "dependentFeatures",
];
const MEASUREMENT_RENDERER_SOURCES = [
  "apps/cli/src/commands/graph/feature-html.ts",
  "apps/cli/src/commands/graph/feature-3d.ts",
];
const RENDERER_SOURCES = [
  ...MEASUREMENT_RENDERER_SOURCES,
  "apps/cli/src/commands/graph/feature-clusters.ts",
  "apps/cli/src/commands/graph/feature-untangle-motion.ts",
  "apps/cli/src/commands/graph/category-clusters.ts",
];
const RENDERER_DIST = RENDERER_SOURCES.map((name) =>
  name.replace("/src/", "/dist/").replace(/\.ts$/u, ".js"),
);
export const PUBLIC_EXAMPLE_LIMITATION =
  "This public metadata projection preserves every graph node, edge, complete feature metric and evidence status. It omits source text, documentation bodies, criterion descriptions, per-symbol hotspot lists and symbol-level budget hints. It is a frozen repository example, not a live scan or a test execution.";
const hash = (bytes, encoding = "hex") => createHash("sha256").update(bytes).digest(encoding);
const clone = (value) => JSON.parse(JSON.stringify(value));
const keys = (value, required, optional = []) => {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected a metadata object.",
  );
  assert(
    required.every((key) => Object.hasOwn(value, key)),
    "Required metadata field is missing.",
  );
  assert(
    Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    "Unexpected metadata field.",
  );
};
const text = (value, maximum = 2000) => {
  assert(typeof value === "string" && value.length <= maximum, "Invalid public metadata text.");
  assert(
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
    "Control characters are not public metadata.",
  );
  assert(
    !/(?:https?:|file:|\/\/|\/Users\/|\/home\/|[A-Za-z]:\\|<\/?script\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu.test(
      value,
    ),
    "Private path, remote URL or unsafe metadata text.",
  );
};
const number = (value) =>
  assert(Number.isSafeInteger(value) && value >= 0, "Invalid metadata count.");
const bool = (value) => assert(typeof value === "boolean", "Invalid metadata boolean.");
const digest = (value) =>
  assert(typeof value === "string" && SHA256.test(value), "Invalid SHA-256 digest.");
const texts = (values) => {
  assert(Array.isArray(values));
  values.forEach((value) => text(value));
};

export function assertRelativeExamplePath(value) {
  text(value, 500);
  assert(
    value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes(":"),
    "Public paths must be repository-relative.",
  );
  assert(
    value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Public paths must remain inside the repository.",
  );
  return value;
}

function metrics(value) {
  if (value === null) return;
  keys(value, METRIC_KEYS);
  text(value.metricsVersion);
  text(value.cognitiveAlgorithm);
  for (const key of ["cognitive", "cyclomaticClassic", "cyclomaticExtended"]) {
    keys(value[key], ["top_level", "execution_unit", "self"]);
    Object.values(value[key]).forEach(number);
  }
  for (const key of ["files", "scopes", "executionUnitRoots", "sloc"]) number(value[key]);
  assert.equal(value.cyclomaticPerScopeBase, 1);
}

function sourceReference(value) {
  keys(value, ["path", "heading", "status"], ["contentHash", "startLine", "endLine"]);
  assertRelativeExamplePath(value.path);
  text(value.heading);
  text(value.status);
  if (value.contentHash !== undefined) digest(value.contentHash);
  for (const key of ["startLine", "endLine"]) if (value[key] !== undefined) number(value[key]);
}

function hint(value) {
  keys(value, ["code", "severity", "message", "paths", "suggestedAction"]);
  assert(
    ["ownership_review", "test_execution_evidence", "shared_code", "missing_evidence"].includes(
      value.code,
    ),
    "Only feature-level evidence hints are public.",
  );
  for (const key of ["code", "severity", "message", "suggestedAction"]) text(value[key]);
  assert(Array.isArray(value.paths));
  value.paths.forEach(assertRelativeExamplePath);
}

function details(node) {
  const value = node.details;
  if (node.kind === "feature") {
    keys(value, [
      "featureId",
      "stage",
      "review",
      "codeComplete",
      "testComplete",
      "metrics",
      "testMetrics",
      "testEvidence",
      "dimensions",
      "criteria",
      "agentHints",
      "issues",
    ]);
    text(value.featureId);
    text(value.stage);
    text(value.review);
    bool(value.codeComplete);
    bool(value.testComplete);
    metrics(value.metrics);
    metrics(value.testMetrics);
    if (value.metrics === null)
      assert.equal(node.cognitive, undefined, "Missing feature measurements must not become zero.");
    else
      assert.equal(
        node.cognitive,
        value.metrics.cognitive.execution_unit,
        "Feature size must use its complete execution_unit reading.",
      );
    keys(value.testEvidence, ["status", "passed", "failed", "skipped", "proof"]);
    assert.deepEqual(
      value.testEvidence,
      { status: "not_run", passed: 0, failed: 0, skipped: 0, proof: "none" },
      "This map does not contain a test run.",
    );
    keys(value.dimensions, DIMENSION_KEYS);
    Object.values(value.dimensions).forEach(number);
    assert(Array.isArray(value.criteria));
    value.criteria.forEach((criterion) => {
      keys(criterion, ["id", "matchedFiles", "status"]);
      text(criterion.id);
      text(criterion.status);
      assert(Array.isArray(criterion.matchedFiles));
      criterion.matchedFiles.forEach(assertRelativeExamplePath);
    });
    assert(Array.isArray(value.agentHints));
    value.agentHints.forEach(hint);
    texts(value.issues);
  } else if (node.kind === "owner") {
    keys(value, ["ownerId", "authority", "sources"]);
    text(value.ownerId);
    assert(value.ownerId.startsWith("role."), "Only declared work-package roles are published.");
    assert(["declared", "missing"].includes(node.status), "Ownership remains declared or missing.");
    assert.equal(value.authority, "manifest_declarations");
    assert(Array.isArray(value.sources));
    value.sources.forEach(sourceReference);
  } else if (node.kind === "intent") {
    keys(value, ["role", "heading"], ["contentHash", "startLine", "endLine"]);
    text(value.role);
    text(value.heading);
    if (value.contentHash !== undefined) digest(value.contentHash);
    for (const key of ["startLine", "endLine"]) if (value[key] !== undefined) number(value[key]);
  } else if (node.kind === "unmapped") {
    keys(value, ["featureAssignment", "measurement"]);
    assert.equal(value.featureAssignment, "none");
    assert.equal(value.measurement, "not_provided_by_feature_report");
    assert.equal(node.cognitive, undefined);
  } else {
    keys(value, ["roles", "sharedFeatures"], ["contentHash"]);
    assert(
      Array.isArray(value.roles) && value.roles.every((role) => ["code", "test"].includes(role)),
    );
    texts(value.sharedFeatures);
    if (value.contentHash !== undefined) digest(value.contentHash);
    assert.equal(node.cognitive, undefined, "File size is not a file complexity measurement.");
  }
}

function records(value) {
  assert(Array.isArray(value) && value.length > 0);
  const seen = new Set();
  for (const record of value) {
    keys(record, ["path", "sha256"]);
    assertRelativeExamplePath(record.path);
    digest(record.sha256);
    assert(!seen.has(record.path), "Duplicate provenance path.");
    seen.add(record.path);
  }
}

/** Side-effect-free allowlist shared by the website's build and mutation tests. */
export function validatePublicExampleProjection(example) {
  keys(example, ["schemaVersion", "kind", "provenance", "graph"]);
  assert.equal(example.schemaVersion, 1);
  assert.equal(example.kind, "public_repository_example");
  const p = example.provenance;
  keys(p, [
    "repository",
    "revision",
    "node",
    "sourceTreeDigest",
    "gitSourceManifestSha256",
    "builtDistManifestSha256",
    "featureManifest",
    "rawGraphSha256",
    "publishedGraphSha256",
    "sourceFiles",
    "renderer",
    "omittedFields",
  ]);
  assert.equal(p.repository, "Untangle");
  assert(REVISION.test(p.revision));
  assert(/^v(?:22|24)\./u.test(p.node));
  for (const key of [
    "sourceTreeDigest",
    "gitSourceManifestSha256",
    "builtDistManifestSha256",
    "rawGraphSha256",
    "publishedGraphSha256",
  ])
    digest(p[key]);
  keys(p.featureManifest, ["path", "sha256"]);
  assert.equal(p.featureManifest.path, "untangle.features.json");
  digest(p.featureManifest.sha256);
  records(p.sourceFiles);
  keys(p.renderer, [
    "revision",
    "node",
    "gitSourceManifestSha256",
    "builtDistManifestSha256",
    "sourceFiles",
    "distFiles",
    "scriptSha256",
    "styleSha256",
    "scriptSha256Base64",
    "styleSha256Base64",
  ]);
  assert(REVISION.test(p.renderer.revision), "Renderer revision must be explicit.");
  assert(/^v(?:22|24)\./u.test(p.renderer.node), "Invalid renderer runtime version.");
  digest(p.renderer.gitSourceManifestSha256);
  digest(p.renderer.builtDistManifestSha256);
  records(p.renderer.sourceFiles);
  records(p.renderer.distFiles);
  assert.deepEqual(
    p.renderer.sourceFiles.map((record) => record.path).sort(),
    [...RENDERER_SOURCES].sort(),
  );
  assert.deepEqual(
    p.renderer.distFiles.map((record) => record.path).sort(),
    [...RENDERER_DIST].sort(),
  );
  for (const key of ["scriptSha256", "styleSha256"]) digest(p.renderer[key]);
  for (const key of ["scriptSha256Base64", "styleSha256Base64"]) {
    assert(typeof p.renderer[key] === "string" && /^[A-Za-z0-9+/]{43}=$/u.test(p.renderer[key]));
    assert.equal(
      Buffer.from(p.renderer[key], "base64").toString("hex"),
      p.renderer[key.replace("Base64", "")],
    );
  }
  assert.deepEqual(p.omittedFields, [
    "report",
    "sourceText",
    "documentationBodies",
    "criteria.description",
    "hotspots",
    "symbolBudgetHints",
  ]);
  const g = example.graph;
  keys(g, [
    "schemaVersion",
    "sourceTreeDigest",
    "nodes",
    "edges",
    "summary",
    "limits",
    "issues",
    "dependencyCycles",
    "limitations",
  ]);
  assert.equal(g.schemaVersion, 1);
  assert.equal(g.sourceTreeDigest, p.sourceTreeDigest);
  assert.equal(hash(JSON.stringify(g)), p.publishedGraphSha256, "Published graph digest mismatch.");
  keys(g.limits, ["maxNodes", "maxEdges"]);
  number(g.limits.maxNodes);
  number(g.limits.maxEdges);
  assert(g.limits.maxNodes <= 2000 && g.limits.maxEdges <= 10000);
  keys(g.summary, [
    "status",
    "features",
    "shownNodes",
    "totalNodes",
    "shownEdges",
    "totalEdges",
    "truncated",
    "mappedCodeFiles",
    "unmappedCodeFiles",
    "inventoryFiles",
  ]);
  text(g.summary.status);
  bool(g.summary.truncated);
  for (const key of Object.keys(g.summary).filter((key) => !["status", "truncated"].includes(key)))
    number(g.summary[key]);
  assert(Array.isArray(g.nodes) && Array.isArray(g.edges));
  const ids = new Set();
  for (const node of g.nodes) {
    keys(node, ["id", "kind", "label", "status", "details"], ["path", "cognitive"]);
    assert(UUID.test(node.id) && !ids.has(node.id), "Invalid or duplicate graph node identity.");
    ids.add(node.id);
    assert(KINDS.includes(node.kind));
    text(node.label);
    text(node.status);
    if (node.path !== undefined) assertRelativeExamplePath(node.path);
    if (node.cognitive !== undefined) number(node.cognitive);
    details(node);
  }
  const sourceByPath = new Map(p.sourceFiles.map((record) => [record.path, record.sha256]));
  assert.equal(
    sourceByPath.get(p.featureManifest.path),
    p.featureManifest.sha256,
    "Feature manifest provenance mismatch.",
  );
  const expectedPaths = [
    ...new Set([...referencedPaths(g), p.featureManifest.path, ...MEASUREMENT_RENDERER_SOURCES]),
  ].sort();
  assert.deepEqual(
    [...sourceByPath.keys()].sort(),
    expectedPaths,
    "Source provenance must cover exactly the referenced repository paths.",
  );
  for (const node of g.nodes.filter(
    (node) => ["code", "test"].includes(node.kind) && node.details.contentHash,
  )) {
    assert.equal(
      sourceByPath.get(node.path),
      node.details.contentHash,
      "Measured file provenance mismatch.",
    );
  }
  const byId = new Map(g.nodes.map((node) => [node.id, node]));
  const edgeIds = new Set();
  for (const edge of g.edges) {
    keys(edge, ["id", "from", "to", "kind"]);
    assert(
      UUID.test(edge.id) && !edgeIds.has(edge.id),
      "Invalid or duplicate graph edge identity.",
    );
    edgeIds.add(edge.id);
    assert(ids.has(edge.from) && ids.has(edge.to), "Unresolved graph edge endpoint.");
    assert(EDGE_KINDS.includes(edge.kind));
    assert.equal(
      byId.get(edge.from).kind,
      "feature",
      "Declared relationships must start at a feature.",
    );
    const target = byId.get(edge.to);
    if (["code", "test"].includes(edge.kind))
      assert(
        target.details.roles?.includes(edge.kind),
        "Code/test relation lacks that declared file role.",
      );
    else
      assert.equal(
        target.kind,
        { ownership: "owner", intent: "intent", dependency: "feature" }[edge.kind],
        "Relationship kind and endpoint disagree.",
      );
  }
  assert.equal(g.summary.shownNodes, g.nodes.length);
  assert.equal(g.summary.shownEdges, g.edges.length);
  assert.equal(g.summary.features, g.nodes.filter((node) => node.kind === "feature").length);
  assert.equal(
    g.summary.truncated,
    false,
    "The public example must retain the entire measured graph.",
  );
  assert.equal(g.summary.totalNodes, g.nodes.length);
  assert.equal(g.summary.totalEdges, g.edges.length);
  assert.equal(
    g.summary.unmappedCodeFiles,
    g.nodes.filter((node) => node.kind === "unmapped").length,
  );
  assert.equal(
    g.summary.mappedCodeFiles,
    g.nodes.filter((node) => node.details.roles?.includes("code")).length,
  );
  assert(g.nodes.length <= g.limits.maxNodes && g.edges.length <= g.limits.maxEdges);
  texts(g.issues);
  texts(g.limitations);
  assert(g.limitations.includes(PUBLIC_EXAMPLE_LIMITATION));
  assert(Array.isArray(g.dependencyCycles));
  g.dependencyCycles.forEach(texts);
  return example;
}

function projectDetails(node) {
  if (node.kind !== "feature") return clone(node.details);
  const {
    featureId,
    stage,
    review,
    codeComplete,
    testComplete,
    metrics,
    testMetrics,
    testEvidence,
    dimensions,
    criteria,
    agentHints,
    issues,
  } = node.details;
  return clone({
    featureId,
    stage,
    review,
    codeComplete,
    testComplete,
    metrics,
    testMetrics,
    testEvidence,
    dimensions,
    criteria: criteria.map(({ id, matchedFiles, status }) => ({ id, matchedFiles, status })),
    agentHints: agentHints.filter((entry) => entry.code !== "cognitive_unit_budget"),
    issues,
  });
}

/** Projection never changes topology, measurements, statuses, identities or evidence gaps. */
export function createPublicExampleProjection(raw, provenance) {
  const graph = {
    ...clone(raw.graph),
    nodes: raw.graph.nodes.map((node) => ({ ...clone(node), details: projectDetails(node) })),
    limitations: [...raw.graph.limitations, PUBLIC_EXAMPLE_LIMITATION],
  };
  return validatePublicExampleProjection({
    schemaVersion: 1,
    kind: "public_repository_example",
    provenance: {
      ...provenance,
      sourceTreeDigest: graph.sourceTreeDigest,
      rawGraphSha256: hash(JSON.stringify(raw.graph)),
      publishedGraphSha256: hash(JSON.stringify(graph)),
      omittedFields: [
        "report",
        "sourceText",
        "documentationBodies",
        "criteria.description",
        "hotspots",
        "symbolBudgetHints",
      ],
    },
    graph,
  });
}

export function renderPublicExample(example, renderer) {
  validatePublicExampleProjection(example);
  const html = renderer(example.graph);
  const introduction = `<p class="scope">Untangle's own codebase · Frozen measurement <code>${example.provenance.revision}</code> · Renderer <code>${example.provenance.renderer.revision}</code>. Complete graph metadata; source text, per-symbol hotspots and symbol-level hints are omitted. Test execution is not supplied; ownership remains declared or missing.</p>`;
  return html
    .replace(
      "<title>Untangle · Feature map</title>",
      "<title>Untangle · Real repository example</title>",
    )
    .replace("</header>", `</header>\n${introduction}`);
}

function sourceRecords(root, revision, paths) {
  const names = [...new Set(paths)].sort();
  names.forEach(assertRelativeExamplePath);
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: names.map((name) => `${revision}:${name}\n`).join(""),
    maxBuffer: 64 * 1024 * 1024,
  });
  let offset = 0;
  return names.map((name) => {
    const end = output.indexOf(10, offset);
    assert(end !== -1);
    const header = output
      .subarray(offset, end)
      .toString("utf8")
      .match(/^[a-f0-9]{40} blob (\d+)$/u);
    assert(header, `Source is not a committed regular blob: ${name}`);
    const size = Number(header[1]);
    offset = end + 1;
    const bytes = output.subarray(offset, offset + size);
    assert.equal(bytes.length, size);
    offset += size;
    assert.equal(output[offset++], 10);
    return { path: name, sha256: hash(bytes) };
  });
}

function referencedPaths(graph) {
  return graph.nodes.flatMap((node) => [
    ...(node.path ? [node.path] : []),
    ...(node.details.sources ?? []).map((source) => source.path),
    ...(node.details.criteria ?? []).flatMap((criterion) => criterion.matchedFiles),
    ...(node.details.agentHints ?? []).flatMap((entry) => entry.paths),
  ]);
}

/** The renderer may evolve; the published measurement remains the same frozen observation. */
export function assertFrozenExampleMeasurement(example) {
  assert.equal(example.provenance.revision, "d11bdaf0b474cbe4c09095d59a9da05463cc1134");
  assert.equal(
    hash(JSON.stringify(example.graph)),
    "df6495ef685f8d01b5470ea62e4572ca6e39b2e2fefc3e3a19cb5b7c0f7d32e9",
    "Frozen measurement graph changed.",
  );
  const measurement = Object.fromEntries(
    Object.entries(example.provenance).filter(([key]) => key !== "renderer"),
  );
  assert.equal(
    hash(JSON.stringify(measurement)),
    "44346d10b198cdb6157b7235f036d4ff8d2ed9b68e7110c1a95256a0d2f04e1a",
    "Frozen measurement provenance changed.",
  );
}

function readEvidenceReference(root, reference) {
  keys(reference, ["path", "sha256", "bytes"]);
  assertRelativeExamplePath(reference.path);
  digest(reference.sha256);
  number(reference.bytes);
  const file = path.join(root, reference.path);
  const physical = path.relative(realpathSync(root), realpathSync(file));
  assert(physical && !physical.startsWith("..") && !path.isAbsolute(physical));
  assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
  const bytes = readFileSync(file);
  assert.equal(bytes.length, reference.bytes);
  assert.equal(hash(bytes), reference.sha256, "Renderer build evidence hash mismatch.");
  return bytes;
}

function readEvidenceManifest(root, reference, expectedDigest) {
  const entries = JSON.parse(readEvidenceReference(root, reference));
  records(entries);
  assert.equal(hash(JSON.stringify(entries)), expectedDigest, "Renderer manifest digest mismatch.");
  return new Map(entries.map((entry) => [entry.path, entry.sha256]));
}

async function readRendererBinding({ root, graph, rendererRevision, rendererEvidenceDir }) {
  assert(REVISION.test(rendererRevision), "An explicit renderer revision is required.");
  assert(rendererEvidenceDir, "A source-bound renderer build directory is required.");
  const build = JSON.parse(readFileSync(path.join(rendererEvidenceDir, "gates/build.json")));
  assert(
    build.name === "build" &&
      build.status === "passed" &&
      build.exitCode === 0 &&
      build.signal === null &&
      !build.operationalError &&
      build.sourceStable &&
      Array.isArray(build.bindingErrors) &&
      build.bindingErrors.length === 0,
    "Renderer build did not pass its source-bound gate.",
  );
  assert.deepEqual(build.gitBefore, build.gitAfter, "Renderer build Git identity changed.");
  assert.equal(build.gitBefore.revision, rendererRevision);
  assert.equal(build.gitBefore.sha, rendererRevision);
  assert.equal(build.gitBefore.dirty, "", "Renderer build must identify a clean commit.");
  assert.equal(build.sourceBeforeDigest, build.sourceAfterDigest);
  const before = readEvidenceManifest(
    rendererEvidenceDir,
    build.manifests.sourcesBefore,
    build.sourceBeforeDigest,
  );
  const after = readEvidenceManifest(
    rendererEvidenceDir,
    build.manifests.sourcesAfter,
    build.sourceAfterDigest,
  );
  const built = readEvidenceManifest(
    rendererEvidenceDir,
    build.manifests.distAfter,
    build.distAfterDigest,
  );
  readEvidenceReference(rendererEvidenceDir, build.stdout);
  readEvidenceReference(rendererEvidenceDir, build.stderr);
  const sources = sourceRecords(root, rendererRevision, RENDERER_SOURCES);
  for (const record of sources) {
    assert.equal(
      before.get(record.path),
      record.sha256,
      "Renderer source differs from its Git revision.",
    );
    assert.equal(after.get(record.path), record.sha256, "Renderer source changed during build.");
    assert.equal(
      hash(readFileSync(path.join(root, record.path))),
      record.sha256,
      "Working renderer source differs from its revision.",
    );
  }
  const distFiles = RENDERER_DIST.map((name) => {
    const file = path.join(root, name);
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    const sha256 = hash(readFileSync(file));
    assert.equal(built.get(name), sha256, "Renderer Dist differs from its verified build.");
    return { path: name, sha256 };
  });
  const { createFeatureMapHtml } = await import(
    pathToFileURL(path.join(root, RENDERER_DIST[0])).href
  );
  const rendered = createFeatureMapHtml(graph);
  const script = rendered.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  const style = rendered.match(/<style>([\s\S]*?)<\/style>/u)?.[1];
  assert(script && style, "Expected the product renderer's standalone script and style.");
  return {
    render: createFeatureMapHtml,
    metadata: {
      revision: rendererRevision,
      node: process.version,
      gitSourceManifestSha256: build.sourceAfterDigest,
      builtDistManifestSha256: build.distAfterDigest,
      sourceFiles: sources,
      distFiles,
      scriptSha256: hash(script),
      styleSha256: hash(style),
      scriptSha256Base64: hash(script, "base64"),
      styleSha256Base64: hash(style, "base64"),
    },
  };
}

function writeExample(outDir, example, html) {
  writeFileSync(
    path.join(outDir, "untangle-example.json"),
    JSON.stringify(example, null, 2) + "\n",
    { flag: "wx" },
  );
  writeFileSync(path.join(outDir, "untangle-example.html"), html, { flag: "wx" });
}

export async function renderFrozenPublicExample({
  input,
  outDir,
  rendererRevision,
  rendererEvidenceDir,
  root = ROOT,
}) {
  const frozen = JSON.parse(readFileSync(input, "utf8"));
  assertFrozenExampleMeasurement(frozen);
  const graphBytes = Buffer.from(JSON.stringify(frozen.graph));
  const renderer = await readRendererBinding({
    root,
    graph: frozen.graph,
    rendererRevision,
    rendererEvidenceDir,
  });
  const example = validatePublicExampleProjection({
    ...frozen,
    provenance: { ...frozen.provenance, renderer: renderer.metadata },
  });
  const html = renderPublicExample(example, renderer.render);
  assertFrozenExampleMeasurement(example);
  const encoded = html.match(
    /<script type="application\/json" id="map-data">([A-Za-z0-9+/=]+)<\/script>/u,
  )?.[1];
  assert(
    encoded && Buffer.from(encoded, "base64").equals(graphBytes),
    "Rendered graph bytes changed.",
  );
  writeExample(outDir, example, html);
  return example;
}

export async function generatePublicExample({
  input,
  baseline,
  outDir,
  rendererRevision,
  rendererEvidenceDir,
  root = ROOT,
}) {
  const receipt = JSON.parse(readFileSync(baseline, "utf8"));
  assert(
    receipt.sourceStable && receipt.distStable && receipt.exitCode === 0,
    "Unverified CLI baseline.",
  );
  assert(REVISION.test(receipt.commit));
  const raw = JSON.parse(readFileSync(input, "utf8"));
  const originalSources = JSON.parse(
    readFileSync(path.join(path.dirname(baseline), "sources-before.json"), "utf8"),
  );
  const originalDist = JSON.parse(
    readFileSync(path.join(path.dirname(baseline), "dist-before.json"), "utf8"),
  );
  assert.equal(hash(JSON.stringify(originalSources)), receipt.sourceDigest);
  assert.equal(hash(JSON.stringify(originalDist)), receipt.distDigest);
  const sources = sourceRecords(root, receipt.commit, [
    ...referencedPaths(raw.graph),
    "untangle.features.json",
    ...MEASUREMENT_RENDERER_SOURCES,
  ]);
  for (const record of sources)
    assert.equal(
      originalSources.find((entry) => entry.path === record.path)?.sha256,
      record.sha256,
      `Source does not match baseline: ${record.path}`,
    );
  for (const node of raw.graph.nodes.filter(
    (node) => ["code", "test"].includes(node.kind) && node.details.contentHash,
  )) {
    assert.equal(
      sources.find((record) => record.path === node.path)?.sha256,
      node.details.contentHash,
      `Measured source differs from committed blob: ${node.path}`,
    );
  }
  const renderer = await readRendererBinding({
    root,
    graph: raw.graph,
    rendererRevision,
    rendererEvidenceDir,
  });
  const example = createPublicExampleProjection(raw, {
    repository: "Untangle",
    revision: receipt.commit,
    node: receipt.node,
    gitSourceManifestSha256: receipt.sourceDigest,
    builtDistManifestSha256: receipt.distDigest,
    featureManifest: { path: "untangle.features.json", sha256: raw.report.manifest.contentHash },
    sourceFiles: sources,
    renderer: renderer.metadata,
  });
  const html = renderPublicExample(example, renderer.render);
  writeExample(outDir, example, html);
  return example;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const match = argument.match(
        /^--(input|frozen-example|baseline|renderer-revision|renderer-evidence-dir|out-dir)=(.+)$/u,
      );
      assert(
        match,
        "Usage: generate-example.mjs --frozen-example=<public-example.json> OR --input=<raw-cli-output.json> --baseline=<measurement-receipt.json>; both modes require --renderer-revision=<40hex> --renderer-evidence-dir=<build-proof-directory> --out-dir=<new-assets-directory>",
      );
      return [match[1], match[2]];
    }),
  );
  assert(options["out-dir"] && options["renderer-revision"] && options["renderer-evidence-dir"]);
  assert(
    Boolean(options["frozen-example"]) !== Boolean(options.input || options.baseline),
    "Select exactly one input mode.",
  );
  assert(options["frozen-example"] || (options.input && options.baseline));
  const generate = options["frozen-example"] ? renderFrozenPublicExample : generatePublicExample;
  const example = await generate({
    input: options["frozen-example"] ?? options.input,
    baseline: options.baseline,
    rendererRevision: options["renderer-revision"],
    rendererEvidenceDir: options["renderer-evidence-dir"],
    outDir: options["out-dir"],
  });
  console.log(
    JSON.stringify({
      status: "generated",
      revision: example.provenance.revision,
      summary: example.graph.summary,
      renderer: example.provenance.renderer,
    }),
  );
}
