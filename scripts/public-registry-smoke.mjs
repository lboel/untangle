#!/usr/bin/env node
/** Verify already published originals anonymously; never publish or repack. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  orderReleasePackages,
  runOwnedCommand,
  smokeConsumer,
  validateProductionSbom,
} from "./release-smoke.mjs";
import { PUBLIC_PACKAGES, RELEASE_VERSION } from "./verify-release-candidate.mjs";

export const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const hash = (data, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(data).digest(encoding);
const binding = (file) => {
  const data = readFileSync(file);
  return { path: file, bytes: data.length, sha256: hash(data) };
};

export function parseOptions(args) {
  const options = {};
  for (const arg of args) {
    const key = arg.startsWith("--bundle=")
      ? "bundle"
      : arg.startsWith("--out=")
        ? "out"
        : undefined;
    if (!key) throw new Error(`Unknown option: ${arg}`);
    if (options[key] !== undefined) throw new Error(`Duplicate option: --${key}`);
    const value = arg.slice(key.length + 3);
    if (!value) throw new Error(`--${key} requires a path.`);
    options[key] = path.resolve(value);
  }
  assert(options.bundle && options.out, "--bundle and --out are required.");
  assert(!existsSync(options.out), "Output report already exists; it will not be overwritten.");
  return options;
}

/** No token, inherited npm config, Node injection or workspace lookup reaches a consumer. */
export function anonymousEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) {
    if (
      /^(npm_config_|pnpm_|NODE_PATH$|NODE_OPTIONS$)/i.test(key) ||
      /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)
    )
      delete clean[key];
  }
  return clean;
}

/** Exact release versions and original tarball integrity must already be public. */
export async function preflightPublicRegistry(
  packages,
  requests,
  { fetchImpl = fetch, signal } = {},
) {
  for (const expected of packages) {
    signal?.throwIfAborted();
    const url = `${PUBLIC_REGISTRY}/${encodeURIComponent(expected.name)}`;
    const request = { name: expected.name, version: expected.version, url };
    requests.push(request);
    const deadline = AbortSignal.timeout(30_000);
    const response = await fetchImpl(url, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: "error",
      credentials: "omit",
    });
    request.status = response.status;
    assert.equal(
      response.status,
      200,
      `Public package is unavailable: ${expected.name} (HTTP ${response.status}).`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length <= 16 * 1024 * 1024, "Registry metadata exceeds 16 MiB.");
    request.metadataSha256 = hash(bytes);
    const document = JSON.parse(bytes.toString("utf8"));
    assert.equal(document.name, expected.name, "Registry package name differs.");
    const manifest = document.versions?.[expected.version];
    assert(manifest, `Public version is missing: ${expected.name}@${expected.version}.`);
    assert.equal(manifest.name, expected.name, "Registry version package name differs.");
    assert.equal(manifest.version, expected.version, "Registry version differs.");
    assert.equal(
      manifest.dist?.integrity,
      expected.integrity,
      `Public tarball integrity differs: ${expected.name}.`,
    );
    const tarball = new URL(manifest.dist.tarball);
    assert.equal(
      tarball.origin,
      PUBLIC_REGISTRY,
      "Tarball must come from the public npm registry.",
    );
    assert(
      !tarball.username && !tarball.password && !tarball.hash,
      "Tarball URL contains credentials or a fragment.",
    );
    request.integrity = manifest.dist.integrity;
    request.tarball = tarball.href;
  }
}

async function loadOriginalBundle(bundle, signal, env) {
  const root = realpathSync(bundle);
  const read = (name) => {
    const file = path.join(root, name);
    assert(
      lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(),
      `Original artifact must be a regular file: ${name}`,
    );
    return readFileSync(file);
  };
  assert(
    lstatSync(path.join(root, "tarballs")).isDirectory() &&
      !lstatSync(path.join(root, "tarballs")).isSymbolicLink(),
  );
  const reportBytes = read("release-report.json");
  const report = JSON.parse(reportBytes.toString("utf8"));
  assert.equal(report.verified, true, "Original release report is not verified.");
  assert.equal(report.source?.stable, true, "Original source binding is not stable.");
  assert.match(report.source.before.gitRevision, /^[a-f0-9]{40}$/u);
  assert.equal(report.source.before.contentSha256, report.source.after.contentSha256);
  assert.equal(report.packages.length, PUBLIC_PACKAGES.length);
  assert.deepEqual(
    report.packages.map((record) => record.name).sort(),
    [...PUBLIC_PACKAGES].sort(),
  );
  const artifacts = [];
  const packages = [];
  for (const expected of report.packages) {
    assert.match(expected.file, /^[^/\\]+\.tgz$/u);
    assert.equal(expected.version, RELEASE_VERSION);
    const name = `tarballs/${expected.file}`;
    const bytes = read(name);
    assert.equal(hash(bytes), expected.sha256, `Original SHA-256 differs: ${expected.name}.`);
    assert.equal(bytes.length, expected.bytes, `Original size differs: ${expected.name}.`);
    const integrity = `sha512-${hash(bytes, "sha512", "base64")}`;
    assert.equal(integrity, expected.integrity, `Original SHA-512 differs: ${expected.name}.`);
    const tarball = path.join(root, name);
    const inspected = await runOwnedCommand("tar", ["-xOzf", tarball, "package/package.json"], {
      cwd: root,
      env,
      signal,
      timeoutMs: 30_000,
    });
    const manifest = JSON.parse(inspected.stdout);
    assert.equal(manifest.name, expected.name);
    assert.equal(manifest.version, expected.version);
    assert.equal(hash(read(name)), expected.sha256, "Original tarball changed while inspected.");
    artifacts.push({ tarball, manifest });
    packages.push({
      ...expected,
      inspectedManifest: {
        command: inspected.command,
        exitCode: inspected.exitCode,
        sha256: hash(inspected.stdout),
      },
    });
  }
  const ordered = orderReleasePackages(artifacts);
  const publishOrder = JSON.parse(read("publish-order.json").toString("utf8"));
  assert.deepEqual(
    publishOrder,
    ordered.map((artifact) => ({
      name: artifact.manifest.name,
      version: artifact.manifest.version,
      file: `tarballs/${path.basename(artifact.tarball)}`,
    })),
  );
  const sbom = read("sbom.cdx.json");
  assert.equal(hash(sbom), report.sbom.sha256, "Canonical SBOM differs.");
  assert.equal(sbom.length, report.sbom.bytes);
  validateProductionSbom(sbom.toString("utf8"), packages);
  return {
    artifacts: ordered,
    packages,
    original: {
      root,
      source: report.source,
      releaseReport: {
        path: "release-report.json",
        bytes: reportBytes.length,
        sha256: hash(reportBytes),
      },
      publishOrder: binding(path.join(root, "publish-order.json")),
      sbom: { path: "sbom.cdx.json", bytes: sbom.length, sha256: hash(sbom) },
    },
  };
}

export async function runPublicRegistrySmoke(options) {
  assert(!existsSync(options.out), "Output report already exists; it will not be overwritten.");
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Public registry smoke interrupted."));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const workDir = mkdtempSync(path.join(tmpdir(), "untangle-public-registry-"));
  const originalEnvironment = process.env;
  const env = anonymousEnvironment(originalEnvironment);
  const report = {
    schemaVersion: 1,
    verified: false,
    status: "unverified",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    registry: { origin: PUBLIC_REGISTRY, requests: [] },
    tooling: [
      "public-registry-smoke.mjs",
      "release-smoke.mjs",
      "release-product-consumer.mjs",
      "release-frontend-consumer.mjs",
      "release-local-search-consumer.mjs",
      "check-publishable.mjs",
      "verify-release-candidate.mjs",
    ].map((file) => binding(fileURLToPath(new URL(file, import.meta.url)))),
    consumers: [],
    limitations: [
      "No publishing or repacking is performed.",
      "Live Qdrant/Ollama search, other platforms and optional parser peers remain separate acceptance checks.",
    ],
  };
  let failure;
  try {
    const loaded = await loadOriginalBundle(options.bundle, controller.signal, env);
    report.original = loaded.original;
    report.packages = loaded.packages;
    process.stderr.write(
      "Checking all original release integrities against the anonymous public registry…\n",
    );
    await preflightPublicRegistry(loaded.packages, report.registry.requests, {
      signal: controller.signal,
    });
    // Existing consumers retain owned child deadlines and cleanup; credentials never reach package scripts.
    process.env = env;
    for (const manager of ["npm", "pnpm"]) {
      process.stderr.write(
        `Checking actual public ${manager} CLI-only installation and product/Core/init/MCP contracts…\n`,
      );
      report.consumers.push(
        await smokeConsumer(manager, workDir, loaded.artifacts, report.registry, controller.signal),
      );
    }
    for (const record of loaded.packages)
      assert.equal(
        hash(readFileSync(path.join(loaded.original.root, "tarballs", record.file))),
        record.sha256,
        "Original artifact changed during public acceptance.",
      );
    for (const tool of report.tooling)
      assert.equal(
        binding(tool.path).sha256,
        tool.sha256,
        "Acceptance tooling changed during verification.",
      );
    controller.signal.throwIfAborted();
    report.verified = true;
    report.status = "verified_public_installation";
  } catch (error) {
    failure = error;
    report.failure = { message: error instanceof Error ? error.message : String(error) };
  } finally {
    process.env = originalEnvironment;
    rmSync(workDir, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runPublicRegistrySmoke(parseOptions(process.argv.slice(2)));
    process.stdout.write(
      `Verified public installation of ${report.packages.length} original packages with npm + pnpm.\n`,
    );
  } catch (error) {
    process.stderr.write(`Public registry smoke failed (unverified): ${error.message}\n`);
    process.exitCode = 1;
  }
}
