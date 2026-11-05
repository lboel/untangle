#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startOwnedChild } from "./check-publishable.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");
const writeJson = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

export function manifestDigest(entries) {
  return digest(JSON.stringify(entries));
}

/** Git's source universe includes tracked configuration/docs and untracked, non-ignored work. */
export function captureSourceManifest(root) {
  const names = [
    ...new Set(
      git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const entries = [];
  for (const name of names) {
    const file = path.join(root, name);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") continue; // A pre-existing tracked deletion is part of Git dirty state.
      throw error;
    }
    if (stat.isSymbolicLink())
      entries.push({ path: name, sha256: digest(`symlink:${readlinkSync(file)}`) });
    else if (stat.isFile()) entries.push({ path: name, sha256: digest(readFileSync(file)) });
    else throw new Error(`Unsupported Git source entry: ${name}`);
  }
  return entries;
}

/** Build outputs are separate from sources; incremental compiler bookkeeping is not shipped. */
export function captureDistManifest(root) {
  const entries = [];
  function visit(file) {
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
    } else if (!file.endsWith(".tsbuildinfo")) {
      if (!stat.isFile()) throw new Error(`Unsupported build output: ${file}`);
      entries.push({ path: relative(root, file), sha256: digest(readFileSync(file)) });
    }
  }
  for (const area of ["apps", "packages"]) {
    const base = path.join(root, area);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dist = path.join(base, name, "dist");
      if (existsSync(dist)) visit(dist);
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function reserveEvidenceDirectory(root, outDir) {
  const target = path.resolve(outDir);
  // Resolve existing ancestors so a symlink cannot put evidence into the source inventory.
  let ancestor = target;
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const physical = path.join(realpathSync(ancestor), ...suffix);
  const repository = realpathSync(root);
  const inside = path.relative(repository, physical);
  if (inside === "" || (!inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside))) {
    if (!inside.startsWith(`.untangle${path.sep}`))
      throw new Error("Evidence must be outside the repository or under ignored .untangle/.");
    const ignored = execFileSync("git", ["check-ignore", "--", inside], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (!ignored) throw new Error("Evidence directory must be Git-ignored.");
  }
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(target); // Exclusive reservation: never reuse or overwrite even an empty directory.
  mkdirSync(path.join(target, "gates"));
  return target;
}

/** Preserve nonzero exits and partial output while the shared helper owns child-group cleanup. */
export async function runEvidenceCommand(
  command,
  { cwd, env = process.env, signal, timeoutMs = 1_800_000 },
) {
  let handle;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  try {
    handle = startOwnedChild(command[0], command.slice(1), { cwd, env, signal, timeoutMs });
    const collect = (stream, key) =>
      stream.on("data", (bytes) => {
        if (key === "stdout") stdout = Buffer.concat([stdout, bytes]);
        else stderr = Buffer.concat([stderr, bytes]);
        if (stdout.length + stderr.length > 64 * 1024 * 1024)
          handle.stop(new Error("Release gate exceeded output limit."));
      });
    collect(handle.child.stdout, "stdout");
    collect(handle.child.stderr, "stderr");
    handle.child.stdin.end();
    const result = await handle.closed;
    return { exitCode: result.code, signal: result.signal, stdout, stderr };
  } catch (error) {
    return {
      exitCode: handle?.child.exitCode ?? null,
      signal: handle?.child.signalCode ?? null,
      stdout,
      stderr,
      operationalError: error instanceof Error ? error.message : String(error),
    };
  }
}

function fileReference(outDir, file) {
  const bytes = readFileSync(file);
  return { path: relative(outDir, file), sha256: digest(bytes), bytes: bytes.length };
}

function saveManifest(outDir, name, entries) {
  const file = path.join(outDir, "gates", `${name}.json`);
  writeJson(file, entries);
  return fileReference(outDir, file);
}

function gitIdentity(root) {
  const revision = git(root, ["rev-parse", "HEAD"]).trim();
  return {
    revision,
    sha: revision,
    tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    dirty: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

/** A zero process exit is insufficient when the tested files changed during the gate. */
export async function captureGate({
  root,
  outDir,
  name,
  command,
  sourceDigest,
  distDigest,
  build = false,
  reports = [],
  signal,
  env,
}) {
  const startedAt = new Date().toISOString();
  const beforeSource = captureSourceManifest(root);
  const beforeDist = captureDistManifest(root);
  const beforeGit = gitIdentity(root);
  const manifests = {
    sourcesBefore: saveManifest(outDir, `${name}-sources-before`, beforeSource),
    distBefore: saveManifest(outDir, `${name}-dist-before`, beforeDist),
  };
  const result = await runEvidenceCommand(command, { cwd: root, signal, env });
  const stdoutFile = path.join(outDir, "gates", `${name}.stdout.log`);
  const stderrFile = path.join(outDir, "gates", `${name}.stderr.log`);
  writeFileSync(stdoutFile, result.stdout, { flag: "wx" });
  writeFileSync(stderrFile, result.stderr, { flag: "wx" });
  const bindingErrors = [];
  let afterSource;
  let afterDist;
  let afterGit = null;
  try {
    afterSource = captureSourceManifest(root);
    manifests.sourcesAfter = saveManifest(outDir, `${name}-sources-after`, afterSource);
  } catch (error) {
    bindingErrors.push(`Cannot capture post-gate sources: ${error.message}`);
  }
  try {
    afterDist = captureDistManifest(root);
    manifests.distAfter = saveManifest(outDir, `${name}-dist-after`, afterDist);
  } catch (error) {
    bindingErrors.push(`Cannot capture post-gate distribution: ${error.message}`);
  }
  try {
    afterGit = gitIdentity(root);
  } catch (error) {
    bindingErrors.push(`Cannot capture post-gate Git identity: ${error.message}`);
  }
  const sourceBeforeDigest = manifestDigest(beforeSource);
  const sourceAfterDigest = afterSource ? manifestDigest(afterSource) : null;
  const distBeforeDigest = manifestDigest(beforeDist);
  const distAfterDigest = afterDist ? manifestDigest(afterDist) : null;
  const sourceStable = sourceBeforeDigest === sourceDigest && sourceAfterDigest === sourceDigest;
  const distStable = distBeforeDigest === distAfterDigest;
  if (!sourceStable)
    bindingErrors.push("Source bytes changed or differ from the initial manifest.");
  if (JSON.stringify(beforeGit) !== JSON.stringify(afterGit))
    bindingErrors.push("Git revision/tree/dirty state changed during the gate.");
  if (!build && (distBeforeDigest !== distDigest || distAfterDigest !== distDigest))
    bindingErrors.push("Build outputs changed or differ from the built manifest.");
  const reportReferences = [];
  for (const report of reports) {
    try {
      if (existsSync(report)) reportReferences.push(fileReference(outDir, report));
      else bindingErrors.push(`Required report missing: ${relative(outDir, report)}`);
    } catch (error) {
      bindingErrors.push(
        `Cannot hash required report ${relative(outDir, report)}: ${error.message}`,
      );
    }
  }
  const status =
    result.exitCode === 0 &&
    !result.signal &&
    !result.operationalError &&
    bindingErrors.length === 0
      ? "passed"
      : "failed";
  const ledger = {
    name,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    command,
    exitCode: result.exitCode,
    signal: result.signal,
    ...(result.operationalError ? { operationalError: result.operationalError } : {}),
    sourceBeforeDigest,
    sourceAfterDigest,
    distBeforeDigest,
    distAfterDigest,
    sourceStable,
    distStable,
    gitBefore: beforeGit,
    gitAfter: afterGit,
    stdout: fileReference(outDir, stdoutFile),
    stderr: fileReference(outDir, stderrFile),
    manifests,
    reports: reportReferences,
    bindingErrors,
  };
  writeJson(path.join(outDir, "gates", `${name}.json`), ledger);
  return ledger;
}

export function parseOptions(args) {
  if (args.length !== 1 || !args[0].startsWith("--out-dir=") || args[0] === "--out-dir=")
    throw new Error("Usage: node scripts/release-evidence.mjs --out-dir=<new-directory>");
  return { outDir: args[0].slice("--out-dir=".length) };
}

function gatePlan(outDir) {
  return [
    ["install", ["pnpm", "install", "--frozen-lockfile"]],
    ["build", ["pnpm", "run", "build"]],
    ["typecheck", ["pnpm", "run", "typecheck"]],
    ["lint", ["pnpm", "run", "lint"]],
    [
      "unit",
      [
        "pnpm",
        "run",
        "test:unit",
        "--reporter=json",
        `--outputFile=${path.join(outDir, "gates", "unit-report.json")}`,
      ],
    ],
    ["packages", ["pnpm", "--workspace-concurrency=1", "-r", "--if-present", "run", "test"]],
    ["licenses", ["pnpm", "run", "check-licenses"]],
    ["publishable", ["pnpm", "run", "check-publishable"]],
    ["e2e-smoke", ["pnpm", "run", "e2e:smoke"]],
    ["release", ["pnpm", "run", "e2e:release", `--out-dir=${path.join(outDir, "bundle")}`]],
  ];
}

function bindBundle(outDir, revision) {
  const reportFile = path.join(outDir, "bundle", "release-report.json");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  if (report.verified !== true || report.source?.stable !== true)
    throw new Error("Candidate release report is not verified and source-stable.");
  const snapshots = [report.source.before, report.source.afterPack, report.source.after];
  if (
    snapshots.some((snapshot) => snapshot?.gitRevision !== revision) ||
    snapshots.some((snapshot) => snapshot?.contentSha256 !== snapshots[0].contentSha256)
  )
    throw new Error(
      "Candidate source snapshots do not bind the current Git revision and identical bytes.",
    );
  if (
    report.node !== process.version ||
    report.platform !== process.platform ||
    report.arch !== process.arch
  )
    throw new Error("Candidate toolchain/platform differs from the gate runner.");
  if (
    report.packages?.length !== 20 ||
    new Set(report.packages.map((entry) => entry.name)).size !== 20
  )
    throw new Error("Expected the complete 20-package release bundle.");
  if (
    JSON.stringify(report.consumers.map((entry) => entry.packageManager).sort()) !==
    '["npm","pnpm"]'
  )
    throw new Error("Candidate requires both production installers.");
  const checksums = [];
  for (const record of report.packages) {
    if (path.basename(record.file) !== record.file) throw new Error("Unsafe tarball filename.");
    const tarball = path.join(outDir, "bundle", "tarballs", record.file);
    if (fileReference(outDir, tarball).sha256 !== record.sha256)
      throw new Error(`Original tarball changed: ${record.name}`);
    checksums.push(`${record.sha256}  tarballs/${record.file}\n`);
  }
  const sbom = fileReference(outDir, path.join(outDir, "bundle", "sbom.cdx.json"));
  if (sbom.sha256 !== report.sbom?.sha256) throw new Error("Verified production SBOM changed.");
  checksums.push(`${sbom.sha256}  sbom.cdx.json\n`);
  if (readFileSync(path.join(outDir, "bundle", "SHA256SUMS"), "utf8") !== checksums.join(""))
    throw new Error("Bundle checksum manifest differs from original artifacts.");
  const order = JSON.parse(readFileSync(path.join(outDir, "bundle", "publish-order.json"), "utf8"));
  const expected = report.packages.map(({ name, version, file }) => ({
    name,
    version,
    file: `tarballs/${file}`,
  }));
  if (JSON.stringify(order) !== JSON.stringify(expected))
    throw new Error("Publish order differs from verified packages.");
  return {
    path: "bundle",
    releaseReport: fileReference(outDir, reportFile),
    gitRevision: revision,
    packages: report.packages,
    sbom,
    checksums: fileReference(outDir, path.join(outDir, "bundle", "SHA256SUMS")),
    publishOrder: fileReference(outDir, path.join(outDir, "bundle", "publish-order.json")),
  };
}

export async function main(args) {
  const options = parseOptions(args);
  const outDir = reserveEvidenceDirectory(ROOT, options.outDir);
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Release evidence cancelled."));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const evidence = {
    schemaVersion: 1,
    kind: "release_evidence",
    status: "failed",
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    env: {
      os: process.platform,
      node: process.version,
      nodeMajor: Number(process.versions.node.split(".")[0]),
      runnerOS: process.env.RUNNER_OS ?? null,
    },
    actions: {
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      job: process.env.GITHUB_JOB ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      ref: process.env.GITHUB_REF ?? null,
      runnerOS: process.env.RUNNER_OS ?? null,
      runnerArch: process.env.RUNNER_ARCH ?? null,
    },
    gates: [],
    limitations: [
      "No publication was performed; live Qdrant/Ollama acceptance is a separate evidence run.",
    ],
  };
  let exitCode = 1;
  try {
    const version = async (command) => {
      const result = await runEvidenceCommand([command, "--version"], {
        cwd: ROOT,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0 || result.operationalError)
        throw new Error(`Cannot capture ${command} version.`);
      return result.stdout.toString("utf8").trim();
    };
    evidence.toolchain = {
      node: process.version,
      nodeExecutable: realpathSync(process.execPath),
      nodeExecutableSha256: digest(readFileSync(process.execPath)),
      npm: await version("npm"),
      pnpm: await version("pnpm"),
    };
    evidence.git = gitIdentity(ROOT);
    if (evidence.actions.sha && evidence.actions.sha !== evidence.git.revision)
      throw new Error("Actions checkout differs from the scheduled Git revision.");
    const sources = captureSourceManifest(ROOT);
    const sourceDigest = manifestDigest(sources);
    let distDigest = manifestDigest(captureDistManifest(ROOT));
    evidence.source = {
      beforeDigest: sourceDigest,
      beforeManifest: saveManifest(outDir, "initial-sources", sources),
      stable: false,
    };
    evidence.dist = { initialDigest: distDigest, stableAfterBuild: false };
    for (const [name, command] of gatePlan(outDir)) {
      process.stderr.write(`Release evidence gate: ${name}\n`);
      const reports =
        name === "unit"
          ? [path.join(outDir, "gates", "unit-report.json")]
          : name === "release"
            ? [path.join(outDir, "bundle", "release-report.json")]
            : [];
      const ledger = await captureGate({
        root: ROOT,
        outDir,
        name,
        command,
        sourceDigest,
        distDigest,
        build: name === "build",
        reports,
        signal: controller.signal,
      });
      evidence.gates.push(ledger);
      if (
        ledger.gitBefore.revision !== evidence.git.revision ||
        ledger.gitBefore.tree !== evidence.git.tree ||
        ledger.gitBefore.dirty !== evidence.git.dirty
      )
        throw new Error(`Git state differs from the initial snapshot before ${name}.`);
      if (ledger.status !== "passed") {
        exitCode = ledger.exitCode && ledger.exitCode > 0 ? ledger.exitCode : 1;
        throw new Error(`Release gate ${name} failed; see immutable gate logs and ledger.`);
      }
      if (name === "unit") {
        const report = JSON.parse(readFileSync(reports[0], "utf8"));
        if (
          report.success !== true ||
          report.numFailedTests !== 0 ||
          report.numFailedTestSuites !== 0 ||
          !Number.isInteger(report.numTotalTests) ||
          report.numTotalTests < 1
        )
          throw new Error("Unit report does not confirm a nonempty successful suite.");
      }
      if (name === "build") {
        distDigest = ledger.distAfterDigest;
        evidence.dist.builtDigest = distDigest;
        evidence.dist.builtManifest = ledger.manifests.distAfter;
        if (captureDistManifest(ROOT).length === 0)
          throw new Error("Build produced no distribution files.");
      }
    }
    evidence.bundle = bindBundle(outDir, evidence.git.revision);
    const finalSources = captureSourceManifest(ROOT);
    const finalDist = captureDistManifest(ROOT);
    evidence.source.afterDigest = manifestDigest(finalSources);
    evidence.source.afterManifest = saveManifest(outDir, "final-sources", finalSources);
    evidence.source.stable = evidence.source.beforeDigest === evidence.source.afterDigest;
    evidence.dist.afterDigest = manifestDigest(finalDist);
    evidence.dist.afterManifest = saveManifest(outDir, "final-dist", finalDist);
    evidence.dist.stableAfterBuild = evidence.dist.builtDigest === evidence.dist.afterDigest;
    if (
      !evidence.source.stable ||
      !evidence.dist.stableAfterBuild ||
      JSON.stringify(gitIdentity(ROOT)) !== JSON.stringify(evidence.git)
    )
      throw new Error("Final source/build/Git binding changed.");
    controller.signal.throwIfAborted();
    evidence.status = "verified";
    exitCode = 0;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Release evidence failed: ${evidence.error}\n`);
  } finally {
    // Preserve final inventories on failed gates too, without replacing any prior report.
    try {
      if (evidence.source && !evidence.source.afterManifest) {
        const sources = captureSourceManifest(ROOT);
        evidence.source.afterDigest = manifestDigest(sources);
        evidence.source.afterManifest = saveManifest(outDir, "final-sources", sources);
        evidence.source.stable = evidence.source.beforeDigest === evidence.source.afterDigest;
      }
      if (evidence.dist && !evidence.dist.afterManifest) {
        const dist = captureDistManifest(ROOT);
        evidence.dist.afterDigest = manifestDigest(dist);
        evidence.dist.afterManifest = saveManifest(outDir, "final-dist", dist);
        evidence.dist.stableAfterBuild = evidence.dist.builtDigest === evidence.dist.afterDigest;
      }
    } catch (error) {
      evidence.finalInventoryError = error instanceof Error ? error.message : String(error);
      evidence.status = "failed";
      exitCode = exitCode || 1;
    }
    evidence.finishedAt = new Date().toISOString();
    writeJson(path.join(outDir, "evidence.json"), evidence);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Release evidence failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
