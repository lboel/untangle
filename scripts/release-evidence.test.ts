import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface Entry {
  path: string;
  sha256: string;
}
interface Reference {
  path: string;
  sha256: string;
  bytes: number;
}
interface Ledger {
  name: string;
  status: "passed" | "failed";
  command: string[];
  exitCode: number | null;
  signal: string | null;
  operationalError?: string;
  sourceStable: boolean;
  distStable: boolean;
  sourceBeforeDigest: string;
  sourceAfterDigest: string | null;
  distBeforeDigest: string;
  distAfterDigest: string | null;
  stdout: Reference;
  stderr: Reference;
  reports: Reference[];
  bindingErrors: string[];
}
interface EvidenceModule {
  parseOptions(args: string[]): { outDir: string };
  manifestDigest(entries: Entry[]): string;
  captureSourceManifest(root: string): Entry[];
  captureDistManifest(root: string): Entry[];
  reserveEvidenceDirectory(root: string, outDir: string): string;
  captureGate(options: {
    root: string;
    outDir: string;
    name: string;
    command: string[];
    sourceDigest: string;
    distDigest: string;
    build?: boolean;
    reports?: string[];
    signal?: AbortSignal;
  }): Promise<Ledger>;
}
const evidence = (await import(
  pathToFileURL(path.resolve("scripts/release-evidence.mjs")).href
)) as EvidenceModule;
const directories: string[] = [];
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function fixture(): { root: string; outDir: string; sourceDigest: string; distDigest: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "untangle-evidence-test-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  mkdirSync(root);
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(root, "packages", "core", "dist"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), ".untangle/\n**/dist/\n**/*.tsbuildinfo\n");
  writeFileSync(path.join(root, ".npmrc"), "engine-strict=true\n");
  writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(path.join(root, "README.md"), "Release docs\n");
  writeFileSync(
    path.join(root, "packages", "core", "dist", "index.js"),
    "export const value = 1;\n",
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Evidence Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  writeFileSync(path.join(root, "untracked.ts"), "export const untracked = true;\n");
  const outDir = evidence.reserveEvidenceDirectory(root, path.join(directory, "proof"));
  return {
    root,
    outDir,
    sourceDigest: evidence.manifestDigest(evidence.captureSourceManifest(root)),
    distDigest: evidence.manifestDigest(evidence.captureDistManifest(root)),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("release evidence source and artifact identity", () => {
  it("includes configuration, workflows, documentation and untracked sources with sorted byte hashes", () => {
    const { root } = fixture();
    mkdirSync(path.join(root, ".untangle"));
    writeFileSync(path.join(root, ".untangle", "old-evidence.json"), "ignored");
    const entries = evidence.captureSourceManifest(root);
    expect(entries.map((entry) => entry.path)).toEqual([
      ".github/workflows/ci.yml",
      ".gitignore",
      ".npmrc",
      "README.md",
      "untracked.ts",
    ]);
    expect(entries.find((entry) => entry.path === ".npmrc")?.sha256).toBe(
      sha256("engine-strict=true\n"),
    );
    expect(evidence.manifestDigest(entries)).toBe(sha256(JSON.stringify(entries)));
    writeFileSync(path.join(root, ".npmrc"), "engine-strict=TRUE\n");
    expect(evidence.manifestDigest(evidence.captureSourceManifest(root))).not.toBe(
      evidence.manifestDigest(entries),
    );
  });
  it("detects deleted and newly added source paths independently of HEAD", () => {
    const { root, sourceDigest } = fixture();
    rmSync(path.join(root, "README.md"));
    expect(evidence.captureSourceManifest(root).some((entry) => entry.path === "README.md")).toBe(
      false,
    );
    expect(evidence.manifestDigest(evidence.captureSourceManifest(root))).not.toBe(sourceDigest);
    writeFileSync(path.join(root, "new.ts"), "new source");
    expect(evidence.captureSourceManifest(root).some((entry) => entry.path === "new.ts")).toBe(
      true,
    );
  });
  it("binds actual distribution bytes while excluding incremental bookkeeping", () => {
    const { root, distDigest } = fixture();
    writeFileSync(path.join(root, "packages", "core", "dist", "ignored.tsbuildinfo"), "first");
    expect(evidence.manifestDigest(evidence.captureDistManifest(root))).toBe(distDigest);
    writeFileSync(path.join(root, "packages", "core", "dist", "index.js"), "different build");
    expect(evidence.manifestDigest(evidence.captureDistManifest(root))).not.toBe(distDigest);
  });
  it("reserves a new output once and preserves existing artifacts on retry", () => {
    const { root, outDir } = fixture();
    writeFileSync(path.join(outDir, "sentinel"), "preserve me");
    expect(() => evidence.reserveEvidenceDirectory(root, outDir)).toThrow();
    expect(readFileSync(path.join(outDir, "sentinel"), "utf8")).toBe("preserve me");
    expect(() => evidence.reserveEvidenceDirectory(root, path.join(root, "evidence"))).toThrow(
      "outside",
    );
    const ignored = evidence.reserveEvidenceDirectory(root, path.join(root, ".untangle", "proof"));
    expect(ignored).toBe(path.join(root, ".untangle", "proof"));
  });
  it("requires one explicit new output directory and rejects bypass arguments", () => {
    expect(evidence.parseOptions(["--out-dir=/tmp/new"])).toEqual({ outDir: "/tmp/new" });
    for (const args of [
      [],
      ["--out-dir="],
      ["--out-dir=/tmp/new", "--skip-tests"],
      ["--ignore-errors"],
    ])
      expect(() => evidence.parseOptions(args)).toThrow("Usage:");
  });
});

describe("release evidence gate execution", () => {
  it("retains exact failed exit and separate partial output hashes in an immutable ledger", async () => {
    const context = fixture();
    const command = [
      process.execPath,
      "-e",
      "process.stdout.write('partial stdout');process.stderr.write('partial stderr');process.exitCode=7",
    ];
    const ledger = await evidence.captureGate({ ...context, name: "failed", command });
    expect(ledger).toMatchObject({
      status: "failed",
      exitCode: 7,
      signal: null,
      sourceStable: true,
      distStable: true,
      command,
    });
    expect(ledger.stdout).toMatchObject({ sha256: sha256("partial stdout"), bytes: 14 });
    expect(ledger.stderr).toMatchObject({ sha256: sha256("partial stderr"), bytes: 14 });
    expect(readFileSync(path.join(context.outDir, ledger.stdout.path), "utf8")).toBe(
      "partial stdout",
    );
    expect(
      JSON.parse(readFileSync(path.join(context.outDir, "gates", "failed.json"), "utf8")),
    ).toEqual(ledger);
    await expect(evidence.captureGate({ ...context, name: "failed", command })).rejects.toThrow();
    expect(readFileSync(path.join(context.outDir, ledger.stderr.path), "utf8")).toBe(
      "partial stderr",
    );
  });
  it("fails a zero-exit command that mutates a tracked configuration file", async () => {
    const context = fixture();
    const ledger = await evidence.captureGate({
      ...context,
      name: "config-change",
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('.npmrc','engine-strict=false\\n')",
      ],
    });
    expect(ledger).toMatchObject({
      status: "failed",
      exitCode: 0,
      sourceStable: false,
      distStable: true,
    });
    expect(ledger.bindingErrors).toContain(
      "Source bytes changed or differ from the initial manifest.",
    );
    expect(readFileSync(path.join(context.root, ".npmrc"), "utf8")).toBe("engine-strict=false\n");
  });
  it("rejects a pre-gate untracked edit even when the executed command changes nothing", async () => {
    const context = fixture();
    writeFileSync(path.join(context.root, "untracked.ts"), "edited before execution");
    const ledger = await evidence.captureGate({
      ...context,
      name: "pre-change",
      command: [process.execPath, "-e", ""],
    });
    expect(ledger).toMatchObject({ status: "failed", exitCode: 0, sourceStable: false });
  });
  it("allows build output changes only during build and freezes the resulting distribution", async () => {
    const context = fixture();
    const command = [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('packages/core/dist/index.js','built output')",
    ];
    const build = await evidence.captureGate({ ...context, name: "build", command, build: true });
    expect(build).toMatchObject({
      status: "passed",
      exitCode: 0,
      sourceStable: true,
      distStable: false,
    });
    expect(build.distAfterDigest).not.toBeNull();
    if (build.distAfterDigest === null) throw new Error("Missing built distribution identity.");
    const bound = { ...context, distDigest: build.distAfterDigest };
    const stable = await evidence.captureGate({
      ...bound,
      name: "stable",
      command: [process.execPath, "-e", ""],
    });
    expect(stable.status).toBe("passed");
    const mutation = await evidence.captureGate({
      ...bound,
      name: "late-build",
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('packages/core/dist/index.js','late output')",
      ],
    });
    expect(mutation).toMatchObject({
      status: "failed",
      exitCode: 0,
      sourceStable: true,
      distStable: false,
    });
    expect(mutation.bindingErrors).toContain(
      "Build outputs changed or differ from the built manifest.",
    );
  });
  it("fails closed when a successful process omits its required report", async () => {
    const context = fixture();
    const report = path.join(context.outDir, "gates", "unit-report.json");
    const ledger = await evidence.captureGate({
      ...context,
      name: "unit",
      command: [process.execPath, "-e", ""],
      reports: [report],
    });
    expect(ledger).toMatchObject({ status: "failed", exitCode: 0, reports: [] });
    expect(ledger.bindingErrors).toEqual(["Required report missing: gates/unit-report.json"]);
  });
  it("preserves exit and output evidence when post-command inventory capture fails", async () => {
    const context = fixture();
    const ledger = await evidence.captureGate({
      ...context,
      name: "invalid-dist",
      command: [
        process.execPath,
        "-e",
        "require('node:fs').symlinkSync('index.js','packages/core/dist/link.js');process.stdout.write('captured output')",
      ],
    });
    expect(ledger).toMatchObject({ status: "failed", exitCode: 0, distAfterDigest: null });
    expect(
      ledger.bindingErrors.some((message) =>
        message.startsWith("Cannot capture post-gate distribution:"),
      ),
    ).toBe(true);
    expect(ledger.stdout.sha256).toBe(sha256("captured output"));
    expect(
      JSON.parse(readFileSync(path.join(context.outDir, "gates", "invalid-dist.json"), "utf8")),
    ).toEqual(ledger);
  });
  it("hashes the actual generated report bytes", async () => {
    const context = fixture();
    const report = path.join(context.outDir, "gates", "unit-report.json");
    const bytes = '{"success":true}\n';
    const ledger = await evidence.captureGate({
      ...context,
      name: "unit",
      reports: [report],
      command: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(report)},${JSON.stringify(bytes)})`,
      ],
    });
    expect(ledger.status).toBe("passed");
    expect(ledger.reports).toEqual([
      { path: "gates/unit-report.json", sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) },
    ]);
  });
  it("records a cancellation as failure without running a pre-aborted command", async () => {
    const context = fixture();
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    const ledger = await evidence.captureGate({
      ...context,
      name: "cancelled",
      signal: controller.signal,
      command: [process.execPath, "-e", "process.stdout.write('must not run')"],
    });
    expect(ledger).toMatchObject({
      status: "failed",
      exitCode: null,
      operationalError: "test cancellation",
    });
    expect(ledger.stdout.bytes).toBe(0);
  });
});
