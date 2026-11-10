import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

interface Compatibility {
  status: string;
  matrix: { os: string; nodeMajor: number; artifactTreeDigest: string }[];
  canonical: {
    os: string;
    nodeMajor: number;
    tarballs: { name: string; file: string; sha256: string }[];
    sbom: { file: string; sha256: string };
  };
}
interface Verifier {
  PUBLIC_PACKAGES: string[];
  RELEASE_VERSION: string;
  verifyReleaseCandidates(input: { artifactsDir: string; commit: string }): Compatibility;
  writeCompatibilityManifest(out: string, result: Compatibility, artifactsDir: string): void;
  parseOptions(args: string[]): {
    help?: boolean;
    artifactsDir?: string;
    commit?: string;
    out?: string;
  };
  readPackedManifest(bytes: Buffer): { name: string; version: string };
}
const verifier = (await import(
  pathToFileURL(path.resolve("scripts/verify-release-candidate.mjs")).href
)) as Verifier;
const { RELEASE_VERSION } = verifier;
const frontendConsumer = (await import(
  pathToFileURL(path.resolve("scripts/release-frontend-consumer.mjs")).href
)) as {
  FRONTEND_CHECKS: string[];
  frontendSourceRecords(): { path: string; sha256: string }[];
  createFrontendFixture(root: string): {
    root: string;
    vueRoot: string;
    nativeRoot: string;
    incompleteRoot: string;
  };
};
const localSearchConsumer = (await import(
  pathToFileURL(path.resolve("scripts/release-local-search-consumer.mjs")).href
)) as {
  LOCAL_SEARCH_CHECKS: string[];
  localSearchSourceRecords(): { path: string; sha256: string }[];
  localSearchCommandArgs(root: string): Record<string, string[]>;
  createLocalSearchFixture(root: string): { root: string; guardPath: string; guardSha256: string };
};
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
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
const owned: string[] = [];
const hash = (bytes: string | Buffer, algorithm = "sha256", encoding: "hex" | "base64" = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "untangle-candidate-verifier-"));
  owned.push(dir);
  return dir;
}
function json(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function reference(root: string, file: string) {
  const bytes = readFileSync(path.join(root, file));
  return { path: file, sha256: hash(bytes), bytes: bytes.length };
}

function localSearchProofFixture() {
  const prepared = localSearchConsumer.createLocalSearchFixture(directory());
  const sources = localSearchConsumer.localSearchSourceRecords();
  const index = {
    outcome: "completed",
    generationId: "local-generation",
    embeddingProfileId: "local-profile",
    workspaceId: "release-local-search",
    counts: { filesAnalyzed: 2, fileGraphNodes: 2, fileGraphEdges: 1 },
  };
  const query = (mode: string) => ({
    indexFreshness: { status: "fresh" },
    warnings: [],
    groups: [
      {
        embeddingProfileId: index.embeddingProfileId,
        indexGenerations: [index.generationId],
        hits: [
          {
            symbolName: "getUserById",
            filePath: "src/users.ts",
            rank: 1,
            chunkId: "user-chunk",
            symbolId: "user-symbol",
            indexGeneration: index.generationId,
          },
        ],
        retrieval: {
          branchCandidateCounts: {
            dense: 0,
            sparse: mode === "lexical" ? 1 : 0,
            symbol: mode === "lexical" ? 0 : 1,
          },
        },
      },
    ],
  });
  const reports: Record<string, unknown> = {
    index,
    symbol: query("symbol"),
    lexical: query("lexical"),
    reopened: query("symbol"),
    graph: {
      generationId: index.generationId,
      workspaceId: index.workspaceId,
      metrics: { nodeCount: 2, edgeCount: 1 },
      unresolved: [],
      nodes: [
        { filePath: "src/main.ts", dependencies: 1 },
        { filePath: "src/users.ts", dependents: 1 },
      ],
    },
  };
  return {
    ...prepared,
    verified: true,
    checks: [...localSearchConsumer.LOCAL_SEARCH_CHECKS],
    backend: "lancedb",
    relativePath: ".untangle/index/lancedb",
    storagePath: path.join(prepared.root, ".untangle/index/lancedb"),
    configEntry: "node_modules/@untangle-code/config/dist/index.js",
    storageEntry: "node_modules/@untangle-code/storage-lancedb/dist/index.js",
    sources,
    sourceBefore: hash(JSON.stringify(sources)),
    sourceAfter: hash(JSON.stringify(sources)),
    networkGuardEnabled: true,
    externalServicesStarted: false,
    lanceTables: ["code.lance", "graph.lance"],
    cli: Object.fromEntries(
      Object.entries(localSearchConsumer.localSearchCommandArgs(prepared.root)).map(
        ([name, args]) => [
          name,
          {
            command: ["/consumer/node_modules/.bin/untangle", ...args],
            exitCode: 0,
            stdout: JSON.stringify(reports[name]),
            stderr: "",
          },
        ],
      ),
    ),
  };
}

/** Explicit synthetic consumer evidence for testing the offline verifier, not a release run. */
function frontendProofFixture() {
  const prepared = frontendConsumer.createFrontendFixture(directory());
  const sourceFiles = frontendConsumer.frontendSourceRecords();
  const sourceHash = (file: string) => sourceFiles.find((entry) => entry.path === file)!.sha256;
  const sourceTreeDigest = "e".repeat(64);
  const api = {
    schemaVersion: 1,
    kind: "frontend-boundaries",
    root: prepared.root,
    status: "incomplete",
    sourceTreeDigest,
    freshness: {
      status: "fresh",
      sourceTreeBefore: sourceTreeDigest,
      sourceTreeAfter: sourceTreeDigest,
      changedPaths: [],
    },
    http: {
      summary: { files: 3, requests: 2, endpoints: 1, resolved: 1, unresolved: 1, ambiguous: 0 },
      requests: [
        {
          status: "resolved",
          method: "GET",
          path: "/api/orders/{*}",
          source: { path: "src/api.ts", contentHash: sourceHash("frontend-fixture/src/api.ts") },
          targets: [
            {
              handler: "load_order",
              serviceId: "fixture-api",
              path: "/api/orders/{id}",
              provenance: [
                {
                  path: "backend/app.py",
                  contentHash: sourceHash("frontend-fixture/backend/app.py"),
                },
              ],
            },
          ],
        },
        { status: "unresolved", path: null, reason: "unbounded dynamic URL or path", targets: [] },
      ],
    },
    importContext: {
      kind: "file-imports-not-function-calls",
      requestImporters: [{ requestPath: "src/api.ts", path: "src/App.vue", distance: 1 }],
    },
    features: { dependencySemantics: "declared_dependencies_unchanged" },
    truncation: { truncated: false },
  };
  const selectedApi = {
    ...api,
    selection: { path: "src/App.vue", inInventory: true, matchingRequests: 2 },
  };
  const control = {
    path: ".untangle/services.json",
    status: "loaded",
    contentHash: sourceHash("frontend-fixture/.untangle/services.json"),
  };
  const boundaries = { ...api, servicesManifest: control };
  const selected = { ...selectedApi, servicesManifest: control };
  const totals = { executionUnits: 2, executionUnitRoots: 2, cognitive: 2, cyclomatic: 5 };
  const hotspots = [
    { name: "feature", cognitive: 1, cyclomatic: 3 },
    { name: "helper", cognitive: 1, cyclomatic: 2 },
  ];
  const widget = readFileSync(path.join(prepared.vueRoot, "Widget.vue"));
  const block = (tag: string) => ({
    path: "Widget.vue",
    reason: "no_metric_defined",
    subjectKind: "range",
    range: {
      startByte: widget.indexOf(Buffer.from(`<${tag}>`)) + tag.length + 2,
      endByte: widget.indexOf(Buffer.from(`</${tag}>`)),
    },
  });
  const vue = { filesAnalyzed: 1, totals, hotspots, skipped: [block("template"), block("style")] };
  const native = { filesAnalyzed: 1, totals, hotspots, skipped: [] };
  const incomplete = {
    filesAnalyzed: 0,
    hotspots: [],
    skipped: [
      { path: "Broken.vue", reason: "parse_failed" },
      { path: "OnlyTemplate.vue", reason: "parse_failed" },
    ],
  };
  const binary = path.join(path.dirname(prepared.root), "node_modules/.bin/untangle");
  const command = (args: string[], value: unknown, exitCode = 0) => ({
    command: [binary, ...args],
    exitCode,
    stdout: exitCode === 0 ? JSON.stringify(value) : "",
    stderr: exitCode === 0 ? "" : "Invalid frontend selector or limit.",
  });
  const args = ["graph", "boundaries", `--root=${prepared.root}`];
  const cli = {
    vue: command(["complexity", `--root=${prepared.vueRoot}`, "--format=json"], vue),
    native: command(["complexity", `--root=${prepared.nativeRoot}`, "--format=json"], native),
    incomplete: command(
      ["complexity", `--root=${prepared.incompleteRoot}`, "--format=json"],
      incomplete,
    ),
    boundaries: command([...args, "--format=json"], boundaries),
    selected: command([...args, "--path=src/App.vue", "--format=json"], selected),
    invalidPath: command([...args, "--path=../outside.vue", "--format=json"], null, 2),
    invalidLimit: command([...args, "--max-relations=0", "--format=json"], null, 2),
  };
  const response = (value: unknown, ok = true) => {
    const structuredContent = {
      schemaVersion: 1,
      ok,
      operation: "untangle_boundaries",
      warnings: [],
      ...(ok
        ? { data: value }
        : { error: { code: "INVALID_ARGUMENT", message: "Invalid limit.", retryable: false } }),
    };
    return {
      isError: !ok,
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    };
  };
  const tool = {
    name: "untangle_boundaries",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { root: { type: "string" }, maxRelations: { minimum: 1, maximum: 1000 } },
    },
    outputSchema: {
      oneOf: [
        {
          properties: {
            ok: { const: true },
            operation: { const: "untangle_boundaries" },
            data: {
              type: "object",
              properties: {
                kind: { const: "frontend-boundaries" },
                http: {
                  properties: {
                    requests: {
                      items: {
                        properties: { status: { enum: ["resolved", "ambiguous", "unresolved"] } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  };
  return {
    verified: true,
    ...prepared,
    sourceFiles,
    sourceBefore: hash(JSON.stringify(sourceFiles)),
    sourceAfter: hash(JSON.stringify(sourceFiles)),
    coreEntry: "node_modules/@untangle-code/core/dist/index.js",
    mcpEntry: "node_modules/@untangle-code/cli/dist/mcp/index.js",
    mcpExports: [
      "UNTANGLE_MCP_TOOLS",
      "toolResponseEnvelopeSchema",
      "createUntangleMcpServer",
      "serveUntangleMcpStdio",
    ],
    api,
    selectedApi,
    cli,
    mcp: {
      tool,
      boundaries: response(boundaries),
      selected: response(selected),
      invalidLimit: response(null, false),
    },
    checks: [...frontendConsumer.FRONTEND_CHECKS],
  };
}

/** Actual minimal gzip/tar bytes, not text pretending to be a packed manifest. */
function tar(entries: [string, string][]): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, text] of entries) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    for (const [offset, size, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, body.length],
      [136, 12, 0],
    ])
      header.write(value!.toString(8).padStart(size! - 1, "0") + "\0", offset!, size!, "ascii");
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
interface PackedManifest {
  name: string;
  version: string;
  private: boolean;
  publishConfig: { access: string };
  dependencies: Record<string, string>;
}
interface FixtureOptions {
  editManifest?: (manifest: PackedManifest) => void;
  sbomHash?: string;
}
function fixture(options: FixtureOptions = {}) {
  const parent = directory();
  const artifactsDir = path.join(parent, "download");
  mkdirSync(artifactsDir);
  const names = verifier.PUBLIC_PACKAGES;
  const ordered = [
    names[0]!,
    "@untangle-code/domain",
    "@untangle-code/cli",
    ...names.filter(
      (name) => ![names[0]!, "@untangle-code/domain", "@untangle-code/cli"].includes(name),
    ),
  ];
  const dirs: string[] = [];
  for (const [os, nodeMajor] of [
    ["linux", 22],
    ["linux", 24],
    ["darwin", 22],
    ["darwin", 24],
  ] as const) {
    const root = path.join(artifactsDir, `${os}-${nodeMajor}`);
    dirs.push(root);
    mkdirSync(root);
    mkdirSync(path.join(root, "gates"));
    mkdirSync(path.join(root, "bundle"));
    mkdirSync(path.join(root, "bundle/tarballs"));
    const node = `v${nodeMajor}.20.0`;
    const git = { revision: COMMIT, sha: COMMIT, tree: TREE, dirty: "" };
    const sourceEntries = [
      { path: "example.test.ts", sha256: hash("same committed test") },
      { path: "package.json", sha256: hash("same committed source") },
    ];
    const distEntries = [
      { path: "packages/domain/dist/index.js", sha256: hash(`built ${os}-${nodeMajor}`) },
    ];
    const sourceDigest = hash(JSON.stringify(sourceEntries));
    const distDigest = hash(JSON.stringify(distEntries));
    const initialDist = hash("[]");
    json(path.join(root, "gates/source.json"), sourceEntries);
    json(path.join(root, "gates/dist.json"), distEntries);
    json(path.join(root, "gates/empty-dist.json"), []);
    json(path.join(root, "gates/unit-report.json"), {
      success: true,
      numTotalTests: 5,
      numPassedTests: 5,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 2,
      numPassedTestSuites: 2,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      testResults: [
        {
          name: "/checkout/example.test.ts",
          status: "passed",
          assertionResults: Array.from({ length: 5 }, (_, n) => ({
            fullName: `contract case ${n}`,
            status: "passed",
            failureMessages: [],
          })),
        },
      ],
    });
    const records = ordered.map((name) => {
      const manifest: PackedManifest = {
        name,
        version: RELEASE_VERSION,
        private: false,
        publishConfig: { access: "public" },
        dependencies:
          name === "@untangle-code/cli" ? { "@untangle-code/domain": RELEASE_VERSION } : {},
      };
      options.editManifest?.(manifest);
      const bytes = tar([
        ["package/package.json", JSON.stringify(manifest)],
        ["package/dist/context.txt", `${os}-${nodeMajor}`],
      ]);
      const file = `${name.slice(1).replace("/", "-")}-${RELEASE_VERSION}.tgz`;
      writeFileSync(path.join(root, "bundle/tarballs", file), bytes);
      return {
        name,
        version: RELEASE_VERSION,
        file,
        bytes: bytes.length,
        sha256: hash(bytes),
        integrity: `sha512-${hash(bytes, "sha512", "base64")}`,
      };
    });
    const sbomContent = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: records.map((record) => ({
        type: "library",
        name: record.name,
        version: record.version,
        purl: `pkg:npm/%40untangle-code/${record.name.split("/")[1]}@${RELEASE_VERSION}`,
        hashes: [
          {
            alg: "SHA-512",
            content:
              options.sbomHash ?? Buffer.from(record.integrity.slice(7), "base64").toString("hex"),
          },
        ],
      })),
    });
    writeFileSync(path.join(root, "bundle/sbom.cdx.json"), sbomContent);
    const sbom = {
      file: "sbom.cdx.json",
      format: "CycloneDX",
      specVersion: "1.5",
      componentCount: 21,
      generatedBy: {
        command: ["npm", "sbom", "--sbom-format=cyclonedx", "--omit=dev"],
        exitCode: 0,
      },
      sha256: hash(sbomContent),
      bytes: Buffer.byteLength(sbomContent),
      content: sbomContent,
    };
    const snapshot = {
      contentSha256: hash(`${os}-${nodeMajor}`),
      files: 2,
      gitRevision: COMMIT,
      dirty: "",
    };
    const productRoot = "/consumer/product-fixture";
    const productSource = "c".repeat(64);
    const productApi = {
      sourceTreeDigest: productSource,
      status: "needs_review",
      semanticConformance: "not_independently_proven",
      ownershipAuthority: "manifest_declarations",
      features: [
        {
          id: "fixture.classification",
          code: { complete: true, metrics: { executionUnitRoots: 1 } },
          tests: { complete: true, metrics: { executionUnitRoots: 3 } },
          testEvidence: { status: "bound_passed" },
          criteria: [{ status: "passed" }],
        },
      ],
    };
    const executionCommand = [
      "/opt/node/bin/node",
      "--test",
      "--test-reporter=tap",
      `${productRoot}/main.test.js`,
    ];
    const executionEvidence = {
      schemaVersion: 1,
      sourceTreeBefore: productSource,
      sourceTreeAfter: productSource,
      command: executionCommand,
      exitCode: 0,
      tests: ["positive", "nonpositive", "invalid"].map((name) => ({
        path: "main.test.js",
        name,
        status: "passed",
      })),
    };
    const mcpProduct = { ok: true, operation: "untangle_product", data: productApi };
    const product = {
      verified: true,
      root: productRoot,
      coreEntry: "node_modules/@untangle-code/core/dist/index.js",
      sourceBefore: productSource,
      sourceAfterTests: productSource,
      api: productApi,
      tests: {
        command: executionCommand,
        exitCode: 0,
        stderr: "",
        stdout:
          "ok 1 - positive\nok 2 - nonpositive\nok 3 - invalid\n# tests 3\n# pass 3\n# fail 0\n",
        evidence: executionEvidence,
        evidenceSha256: hash(JSON.stringify(executionEvidence)),
      },
      cli: { exitCode: 0, stderr: "", stdout: JSON.stringify(productApi) },
      reviewGate: { exitCode: 5, stderr: "", stdout: JSON.stringify(productApi) },
      init: {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          outcome: "would-create",
          findings: {
            featureAlignment: {
              features: [
                {
                  id: "fixture.classification",
                  code: { complete: true },
                  testEvidence: { status: "not_run" },
                },
              ],
            },
          },
        }),
      },
      mcp: mcpProduct,
      stale: {
        exitCode: 5,
        stderr: "",
        stdout: JSON.stringify({
          sourceTreeDigest: "d".repeat(64),
          features: [{ testEvidence: { status: "stale" }, criteria: [{ status: "not_run" }] }],
        }),
      },
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
    };
    const frontend = frontendProofFixture();
    const report = {
      schemaVersion: 1,
      verified: true,
      node,
      platform: os,
      arch: "x64",
      packages: records,
      source: { before: snapshot, afterPack: snapshot, after: snapshot, stable: true },
      publishable: { packed: true, findings: [], published: names },
      sbom,
      consumers: ["npm", "pnpm"].map((packageManager) => ({
        packageManager,
        cliOnly: {
          requested: `@untangle-code/cli@${RELEASE_VERSION}`,
          installation: {
            command: [packageManager, "install", `@untangle-code/cli@${RELEASE_VERSION}`],
            exitCode: 0,
          },
          runtime: {
            cliVersion: `untangle ${RELEASE_VERSION}`,
            complexity: { filesAnalyzed: 2, totals: { executionUnits: 2 }, skipped: [] },
            mcp: {
              about: { ok: true, data: { version: RELEASE_VERSION } },
              stderr: "",
              toolNames: ["untangle_about", "untangle_product", "untangle_boundaries"],
              product: mcpProduct,
              frontend: frontend.mcp,
            },
            product,
            frontend,
            localSearch: localSearchProofFixture(),
          },
        },
        imports: { installed: names.map((name) => ({ name, version: RELEASE_VERSION })) },
      })),
    };
    json(path.join(root, "bundle/release-report.json"), report);
    writeFileSync(
      path.join(root, "bundle/SHA256SUMS"),
      records.map((p) => `${p.sha256}  tarballs/${p.file}\n`).join("") +
        `${sbom.sha256}  sbom.cdx.json\n`,
    );
    json(
      path.join(root, "bundle/publish-order.json"),
      records.map(({ name, version, file }) => ({ name, version, file: `tarballs/${file}` })),
    );
    const gates = GATES.map((name, index) => {
      const beforeBuilt = index < 2;
      const afterBuilt = index < 1;
      writeFileSync(path.join(root, `gates/${name}.stdout.log`), "passed\n");
      writeFileSync(path.join(root, `gates/${name}.stderr.log`), "");
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
          `--outputFile=${root}/gates/unit-report.json`,
        ],
        ["pnpm", "--workspace-concurrency=1", "-r", "--if-present", "run", "test"],
        ["pnpm", "run", "check-licenses"],
        ["pnpm", "run", "check-publishable"],
        ["pnpm", "run", "e2e:smoke"],
        ["pnpm", "run", "e2e:release", `--out-dir=${root}/bundle`],
      ];
      const gate = {
        name,
        status: "passed",
        command: commands[index]!,
        exitCode: 0,
        signal: null,
        sourceBeforeDigest: sourceDigest,
        sourceAfterDigest: sourceDigest,
        sourceStable: true,
        distBeforeDigest: beforeBuilt ? initialDist : distDigest,
        distAfterDigest: afterBuilt ? initialDist : distDigest,
        distStable: name !== "build",
        gitBefore: git,
        gitAfter: git,
        stdout: reference(root, `gates/${name}.stdout.log`),
        stderr: reference(root, `gates/${name}.stderr.log`),
        manifests: {
          sourcesBefore: reference(root, "gates/source.json"),
          sourcesAfter: reference(root, "gates/source.json"),
          distBefore: reference(root, beforeBuilt ? "gates/empty-dist.json" : "gates/dist.json"),
          distAfter: reference(root, afterBuilt ? "gates/empty-dist.json" : "gates/dist.json"),
        },
        reports:
          name === "unit"
            ? [reference(root, "gates/unit-report.json")]
            : name === "release"
              ? [reference(root, "bundle/release-report.json")]
              : [],
        bindingErrors: [],
      };
      json(path.join(root, `gates/${name}.json`), gate);
      return gate;
    });
    const evidence = {
      schemaVersion: 1,
      kind: "release_evidence",
      status: "verified",
      node,
      platform: os,
      arch: "x64",
      toolchain: { node, nodeExecutable: "/opt/node/bin/node", npm: "10.9.0", pnpm: "10.34.5" },
      git,
      actions: {
        sha: COMMIT,
        runId: "12345",
        runAttempt: "1",
        workflow: "Release candidate",
        job: "candidate",
        repository: "owner/untangle",
        runnerOS: os === "linux" ? "Linux" : "macOS",
      },
      source: {
        beforeDigest: sourceDigest,
        afterDigest: sourceDigest,
        stable: true,
        beforeManifest: reference(root, "gates/source.json"),
        afterManifest: reference(root, "gates/source.json"),
      },
      dist: {
        initialDigest: initialDist,
        builtDigest: distDigest,
        afterDigest: distDigest,
        stableAfterBuild: true,
        builtManifest: reference(root, "gates/dist.json"),
        afterManifest: reference(root, "gates/dist.json"),
      },
      gates,
      bundle: {
        path: "bundle",
        gitRevision: COMMIT,
        packages: records,
        releaseReport: reference(root, "bundle/release-report.json"),
        sbom: reference(root, "bundle/sbom.cdx.json"),
        checksums: reference(root, "bundle/SHA256SUMS"),
        publishOrder: reference(root, "bundle/publish-order.json"),
      },
    };
    json(path.join(root, "evidence.json"), evidence);
  }
  return { parent, artifactsDir, dirs };
}
function evidence(root: string): { gates: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf8")) as {
    gates: Record<string, unknown>[];
  };
}
function rebindReport(root: string, name: "unit" | "release"): void {
  const value = JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf8")) as {
    gates: { reports: ReturnType<typeof reference>[] }[];
    bundle: { releaseReport: ReturnType<typeof reference> };
  };
  const index = name === "unit" ? 4 : 9;
  const ref = reference(
    root,
    name === "unit" ? "gates/unit-report.json" : "bundle/release-report.json",
  );
  value.gates[index]!.reports = [ref];
  if (name === "release") value.bundle.releaseReport = ref;
  json(path.join(root, `gates/${name}.json`), value.gates[index]);
  json(path.join(root, "evidence.json"), value);
}

afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("offline original release candidate verification", () => {
  it("retains every previous public package and adds the LanceDB adapter", () => {
    expect(verifier.PUBLIC_PACKAGES).toEqual(
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
        "storage-lancedb",
        "storage-local",
        "storage-qdrant",
        "symbol-graph",
        "watcher",
      ].map((name) => `@untangle-code/${name}`),
    );
  });
  it("verifies all four contexts and 21 real archives, accepting distinct build bytes", () => {
    const f = fixture();
    const result = verifier.verifyReleaseCandidates({
      artifactsDir: f.artifactsDir,
      commit: COMMIT,
    });
    expect(result.status).toBe("verified");
    expect(result.matrix).toHaveLength(4);
    expect(new Set(result.matrix.map((m) => m.artifactTreeDigest)).size).toBe(4);
    expect(result.canonical).toMatchObject({ os: "ubuntu-latest", nodeMajor: 22 });
    expect(result.canonical.tarballs).toHaveLength(21);
    expect(
      result.canonical.tarballs.every((entry) =>
        entry.file.startsWith("linux-22/bundle/tarballs/"),
      ),
    ).toBe(true);
    const out = path.join(f.parent, "compatibility-manifest.json");
    verifier.writeCompatibilityManifest(out, result, f.artifactsDir);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(result);
    expect(() => verifier.writeCompatibilityManifest(out, result, f.artifactsDir)).toThrow(
      "overwrite",
    );
    expect(() =>
      verifier.writeCompatibilityManifest(
        path.join(f.dirs[0]!, "new.json"),
        result,
        f.artifactsDir,
      ),
    ).toThrow("outside immutable");
  });
  it("rejects changed original bytes without writing a success artifact", () => {
    const f = fixture();
    const file = path.join(
      f.dirs[0]!,
      `bundle/tarballs/untangle-code-domain-${RELEASE_VERSION}.tgz`,
    );
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("changed")]));
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("integrity");
    expect(existsSync(path.join(f.parent, "compatibility-manifest.json"))).toBe(false);
  });
  it("rejects a missing matrix context and a checkout from another commit", () => {
    const f = fixture();
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: "c".repeat(40) }),
    ).toThrow("Git SHA");
    rmSync(f.dirs[3]!, { recursive: true });
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("four matrix");
  });
  it.each(["exitCode", "sourceStable", "distStable"])(
    "rejects falsely verified gate %s",
    (field) => {
      const f = fixture();
      const value = evidence(f.dirs[0]!);
      value.gates[3]![field] = field === "exitCode" ? 1 : false;
      json(path.join(f.dirs[0]!, "evidence.json"), value);
      expect(() =>
        verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
      ).toThrow(/failed|binding|stability/);
    },
  );
  it("rejects changed report bindings and unsafe artifact symlinks", () => {
    const f = fixture();
    writeFileSync(path.join(f.dirs[0]!, "gates/unit-report.json"), "{}\n");
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("hash mismatch");
    symlinkSync(path.join(f.parent, "outside"), path.join(f.dirs[0]!, "linked"));
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("symlink");
  });
  it("rejects a success gate name backed by the wrong executable", () => {
    const f = fixture();
    const value = evidence(f.dirs[0]!);
    value.gates[1]!["command"] = ["echo", "passed"];
    json(path.join(f.dirs[0]!, "evidence.json"), value);
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("Wrong required gate command");
  });
  it("reconciles case identities even when summaries and report hashes claim success", () => {
    const f = fixture();
    const root = f.dirs[0]!;
    const file = path.join(root, "gates/unit-report.json");
    const unit = JSON.parse(readFileSync(file, "utf8")) as {
      numPassedTests: number;
      numTotalTests: number;
    };
    unit.numPassedTests = 6;
    unit.numTotalTests = 6;
    json(file, unit);
    rebindReport(root, "unit");
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("identity counts");
  });
  it("preserves normalized case identities across operating systems and Node versions", () => {
    const f = fixture();
    const root = f.dirs[3]!;
    const file = path.join(root, "gates/unit-report.json");
    const unit = JSON.parse(readFileSync(file, "utf8")) as {
      testResults: { assertionResults: { fullName: string }[] }[];
    };
    unit.testResults[0]!.assertionResults[0]!.fullName = "silently renamed contract";
    json(file, unit);
    rebindReport(root, "unit");
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("identities/statuses differ");
  });
  it("requires the actual product/core/init and MCP consumer proof in addition to installation", () => {
    const f = fixture();
    const root = f.dirs[0]!;
    const file = path.join(root, "bundle/release-report.json");
    const report = JSON.parse(readFileSync(file, "utf8")) as {
      consumers: { cliOnly: { runtime: { product: { checks: string[] } } } }[];
    };
    report.consumers[0]!.cliOnly.runtime.product.checks.pop();
    json(file, report);
    rebindReport(root, "release");
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("product source/API proof");
  });
  const frontendChanges: [string, (runtime: Record<string, unknown>) => void][] = [
    [
      "absent proof",
      (runtime) => {
        delete runtime["frontend"];
      },
    ],
    [
      "bare verified boolean",
      (runtime) => {
        runtime["frontend"] = { verified: true };
      },
    ],
    [
      "wrong Vue metrics",
      (runtime) => {
        const proof = runtime["frontend"] as ReturnType<typeof frontendProofFixture>;
        proof.cli.vue.stdout = JSON.stringify({
          ...JSON.parse(proof.cli.vue.stdout),
          totals: { executionUnits: 2, executionUnitRoots: 2, cognitive: 0, cyclomatic: 5 },
        });
      },
    ],
    [
      "changed source",
      (runtime) => {
        (runtime["frontend"] as ReturnType<typeof frontendProofFixture>).sourceAfter = "0".repeat(
          64,
        );
      },
    ],
    [
      "missing SDK exports",
      (runtime) => {
        (runtime["frontend"] as ReturnType<typeof frontendProofFixture>).mcpExports = [];
      },
    ],
    [
      "workspace SDK import",
      (runtime) => {
        (runtime["frontend"] as ReturnType<typeof frontendProofFixture>).mcpEntry =
          "../workspace/apps/cli/src/mcp/index.ts";
      },
    ],
    [
      "untyped MCP schema",
      (runtime) => {
        (
          runtime["frontend"] as ReturnType<typeof frontendProofFixture>
        ).mcp.tool.outputSchema.oneOf[0]!.properties.data.properties.kind.const = "unknown";
      },
    ],
    [
      "wrong MCP operation",
      (runtime) => {
        (
          runtime["frontend"] as ReturnType<typeof frontendProofFixture>
        ).mcp.boundaries.structuredContent.operation = "untangle_about";
      },
    ],
    [
      "wrong CLI selector",
      (runtime) => {
        (runtime["frontend"] as ReturnType<typeof frontendProofFixture>).cli.selected.command = [
          "/wrong/binary",
          "graph",
          "boundaries",
        ];
      },
    ],
    [
      "accepted invalid limit",
      (runtime) => {
        (runtime["frontend"] as ReturnType<typeof frontendProofFixture>).cli.invalidLimit.exitCode =
          0;
      },
    ],
  ];
  it.each(frontendChanges)(
    "requires concrete installed Vue/HTTP/MCP evidence: %s",
    (_name, change) => {
      const f = fixture();
      const root = f.dirs[0]!;
      const file = path.join(root, "bundle/release-report.json");
      const report = JSON.parse(readFileSync(file, "utf8")) as {
        consumers: { cliOnly: { runtime: Record<string, unknown> } }[];
      };
      change(report.consumers[0]!.cliOnly.runtime);
      json(file, report);
      rebindReport(root, "release");
      expect(() =>
        verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
      ).toThrow("frontend/Vue/HTTP consumer proof");
    },
  );
  const localSearchChanges: [string, (runtime: Record<string, unknown>) => void][] = [
    [
      "missing proof",
      (runtime) => {
        delete runtime["localSearch"];
      },
    ],
    [
      "bare verified flag",
      (runtime) => {
        runtime["localSearch"] = { verified: true };
      },
    ],
    [
      "wrong backend",
      (runtime) => {
        (runtime["localSearch"] as ReturnType<typeof localSearchProofFixture>).backend = "qdrant";
      },
    ],
    [
      "workspace import",
      (runtime) => {
        (runtime["localSearch"] as ReturnType<typeof localSearchProofFixture>).storageEntry =
          "../workspace/packages/storage-lancedb/dist/index.js";
      },
    ],
    [
      "network guard absent",
      (runtime) => {
        (runtime["localSearch"] as ReturnType<typeof localSearchProofFixture>).networkGuardEnabled =
          false;
      },
    ],
    [
      "fixture changed",
      (runtime) => {
        (runtime["localSearch"] as ReturnType<typeof localSearchProofFixture>).sourceAfter =
          "0".repeat(64);
      },
    ],
    [
      "no native Lance tables",
      (runtime) => {
        (runtime["localSearch"] as ReturnType<typeof localSearchProofFixture>).lanceTables = [];
      },
    ],
    ...[
      "failed index",
      "stale lexical results",
      "changed reopened generation",
      "wrong graph generation",
      "missing import edge",
    ].map((name): [string, (runtime: Record<string, unknown>) => void] => [
      name,
      (runtime) => {
        const proof = runtime["localSearch"] as ReturnType<typeof localSearchProofFixture>;
        const stage =
          name === "failed index"
            ? "index"
            : name === "stale lexical results"
              ? "lexical"
              : name === "changed reopened generation"
                ? "reopened"
                : "graph";
        const execution = proof.cli[stage]!;
        const report = JSON.parse(execution.stdout);
        if (name === "failed index") report.outcome = "failed";
        if (name === "stale lexical results") report.indexFreshness.status = "stale";
        if (name === "changed reopened generation")
          report.groups[0].indexGenerations = ["another-generation"];
        if (name === "wrong graph generation") report.generationId = "another-generation";
        if (name === "missing import edge") report.metrics.edgeCount = 0;
        execution.stdout = JSON.stringify(report);
      },
    ]),
  ];
  it.each(localSearchChanges)(
    "rejects incomplete installed embedded-search evidence: %s",
    (_name, change) => {
      const f = fixture();
      const root = f.dirs[0]!;
      const file = path.join(root, "bundle/release-report.json");
      const report = JSON.parse(readFileSync(file, "utf8")) as {
        consumers: { cliOnly: { runtime: Record<string, unknown> } }[];
      };
      change(report.consumers[0]!.cliOnly.runtime);
      json(file, report);
      rebindReport(root, "release");
      expect(() =>
        verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
      ).toThrow("LanceDB search consumer proof");
    },
  );
  it.each(["version", "private", "workspace", "range"])(
    "checks packed manifests after valid metadata hashes: %s",
    (change) => {
      const f = fixture({
        editManifest: (manifest) => {
          if (manifest.name !== "@untangle-code/cli") return;
          if (change === "version") manifest.version = "0.2.0";
          else if (change === "private") manifest.private = true;
          else
            manifest.dependencies["@untangle-code/domain"] =
              change === "workspace" ? "workspace:*" : `^${RELEASE_VERSION}`;
        },
      });
      expect(() =>
        verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
      ).toThrow(/manifest differs|workspace|exact packed version/);
    },
  );
  it("rejects SBOM integrity claims that differ from original tarballs", () => {
    const f = fixture({ sbomHash: "0".repeat(128) });
    expect(() =>
      verifier.verifyReleaseCandidates({ artifactsDir: f.artifactsDir, commit: COMMIT }),
    ).toThrow("SBOM SHA-512 differs");
  });
  it("exposes explicit CLI options and refuses weakening flags", () => {
    expect(verifier.parseOptions(["--help"])).toEqual({ help: true });
    expect(
      verifier.parseOptions([
        "--artifacts-dir=/tmp/a",
        `--commit=${COMMIT}`,
        "--out=/tmp/out.json",
      ]),
    ).toEqual({ artifactsDir: "/tmp/a", commit: COMMIT, out: "/tmp/out.json" });
    expect(() => verifier.parseOptions(["--allow-missing"])).toThrow("Unknown");
    expect(() => verifier.parseOptions(["--commit=a", "--commit=b"])).toThrow("duplicate");
  });
  it("rejects fake archive bytes and duplicate package manifests", () => {
    expect(() => verifier.readPackedManifest(Buffer.from("fake gzip"))).toThrow();
    expect(() =>
      verifier.readPackedManifest(
        tar([
          ["package/package.json", "{}"],
          ["package/package.json", "{}"],
        ]),
      ),
    ).toThrow("Duplicate");
    const linked = gunzipSync(tar([["package/package.json", "{}"]]));
    linked[156] = 50;
    linked.write("../../outside", 157, "ascii");
    linked.fill(32, 148, 156);
    const checksum = linked.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    linked.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    expect(() => verifier.readPackedManifest(gzipSync(linked))).toThrow("links/special");
  });
});
