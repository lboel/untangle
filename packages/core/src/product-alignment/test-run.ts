import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductAlignmentReportV1, ProductTestEvidenceV1 } from "@untangle-code/domain";

import { collectProductInventory } from "./analysis.js";
import { productInputPath } from "./evidence.js";

export interface ProductTestProcessRequestV1 {
  root: string;
  command: readonly string[];
  timeoutMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
}

export interface ProductTestProcessResultV1 {
  status: "completed" | "spawn_failed" | "timed_out" | "output_limit" | "cancelled";
  exitCode: number | null;
  terminationSignal?: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ProductTestRunOptionsV1 {
  root: string;
  /** Explicitly authorized executable and arguments, invoked without a shell. */
  command: readonly string[];
  execute: (request: ProductTestProcessRequestV1) => Promise<ProductTestProcessResultV1>;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

export interface ProductTestRunResultV1 {
  run: NonNullable<ProductAlignmentReportV1["testRun"]>;
  evidence: ProductTestEvidenceV1 | null;
}

const REPORT_LIMIT = 16 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Vitest JSON only: every reported case must map to an accepted, root-relative source. */
export function parseVitestProductReport(
  text: string,
  root: string,
  acceptedPaths: ReadonlySet<string>,
): ProductTestEvidenceV1["tests"] {
  const value: unknown = JSON.parse(text);
  if (!record(value) || !Array.isArray(value["testResults"]) || value["testResults"].length === 0)
    throw new Error("Expected a nonempty Vitest JSON testResults array.");
  if (typeof value["success"] !== "boolean" || (value["numRuntimeErrorTestSuites"] ?? 0) !== 0)
    throw new Error("Vitest reported runtime errors or omitted its success status.");
  for (const key of [
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ]) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0)
      throw new Error(`Invalid Vitest summary field: ${key}.`);
  }
  if (
    value["numTotalTestSuites"] !==
    (value["numPassedTestSuites"] as number) +
      (value["numFailedTestSuites"] as number) +
      (value["numPendingTestSuites"] as number)
  )
    throw new Error("Vitest suite summary is inconsistent.");
  if (record(value["snapshot"]) && value["snapshot"]["failure"] === true)
    throw new Error("Vitest reported snapshot failure.");
  const tests: ProductTestEvidenceV1["tests"] = [];
  const identities = new Set<string>();
  for (const suite of value["testResults"]) {
    if (
      !record(suite) ||
      typeof suite["name"] !== "string" ||
      !Array.isArray(suite["assertionResults"])
    )
      throw new Error("Invalid Vitest test-file result.");
    const file = productInputPath(root, suite["name"]);
    if (file === null || !acceptedPaths.has(file) || suite["assertionResults"].length === 0)
      throw new Error(
        "Vitest test file is empty, outside the root or outside the accepted inventory.",
      );
    if (!["passed", "failed"].includes(String(suite["status"])))
      throw new Error("Unsupported Vitest test-file status.");
    const suiteHasFailedCase = suite["assertionResults"].some(
      (assertion: unknown) => record(assertion) && assertion["status"] === "failed",
    );
    if (
      (suite["status"] === "failed" ||
        (typeof suite["message"] === "string" && suite["message"].length > 0)) &&
      !suiteHasFailedCase
    )
      throw new Error("Vitest reported a suite or hook failure outside individual case results.");
    if (suite["status"] === "passed" && suiteHasFailedCase)
      throw new Error("Vitest test-file status contradicts failed cases.");
    for (const assertion of suite["assertionResults"]) {
      if (
        !record(assertion) ||
        typeof assertion["fullName"] !== "string" ||
        assertion["fullName"].length === 0 ||
        assertion["fullName"].length > 4096
      )
        throw new Error("Invalid Vitest fully qualified test identity.");
      const status = assertion["status"];
      if (!["passed", "failed", "pending", "todo", "skipped", "disabled"].includes(String(status)))
        throw new Error("Unsupported Vitest test status.");
      const identity = `${file}\0${assertion["fullName"]}`;
      if (identities.has(identity))
        throw new Error(
          `Duplicate Vitest test identity in ${JSON.stringify(file)}: ${JSON.stringify(assertion["fullName"])}. Use a unique test title; for it.each, include the row index or distinguishing parameters in the title.`,
        );
      if (tests.length >= 100_000) throw new Error("Vitest case limit exceeded (100000).");
      identities.add(identity);
      tests.push({
        path: file,
        name: assertion["fullName"],
        status: status === "passed" || status === "failed" ? status : "skipped",
      });
    }
  }
  if (
    value["numTotalTests"] !== tests.length ||
    value["numPassedTests"] !== tests.filter((test) => test.status === "passed").length ||
    value["numFailedTests"] !== tests.filter((test) => test.status === "failed").length
  )
    throw new Error("Vitest summary and case identities disagree.");
  if (
    (value["numPendingTests"] as number) + (value["numTodoTests"] as number) !==
    tests.filter((test) => test.status === "skipped").length
  )
    throw new Error("Vitest skipped/todo summary and case identities disagree.");
  const failed = tests.some((test) => test.status === "failed");
  if (
    value["success"] !== (!failed && value["numFailedTestSuites"] === 0) ||
    (value["success"] === false && !failed)
  )
    throw new Error("Vitest success or suite failure contradicts individual case results.");
  return tests;
}

function positiveLimit(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum)
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}.`);
  return value;
}

/** Capture an actual, explicitly requested runner invocation and immutable original artifacts. */
export async function runProductTests(
  options: ProductTestRunOptionsV1,
): Promise<ProductTestRunResultV1> {
  options.signal?.throwIfAborted();
  if (
    options.command.length === 0 ||
    options.command.length > 124 ||
    options.command.some(
      (arg) =>
        typeof arg !== "string" || arg.length === 0 || arg.length > 4096 || arg.includes("\0"),
    )
  )
    throw new TypeError("Provide an executable and bounded nonempty command arguments.");
  if (options.command.some((arg) => /^--(?:reporter|outputFile)(?:[.=]|$)/u.test(arg)))
    throw new TypeError(
      "Runner reporter and outputFile arguments are managed by Untangle; remove explicit overrides.",
    );
  const timeoutMs = positiveLimit(options.timeoutMs ?? 120_000, 3_600_000, "timeoutMs");
  const outputLimitBytes = positiveLimit(
    options.outputLimitBytes ?? REPORT_LIMIT,
    REPORT_LIMIT,
    "outputLimitBytes",
  );
  const before = await collectProductInventory({
    root: options.root,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (before.truncated)
    throw new Error("Cannot run source-bound tests on a truncated accepted inventory.");
  const directory = await mkdtemp(path.join(tmpdir(), "untangle-product-tests-"));
  const reportPath = path.join(directory, "vitest.json");
  const command = [...options.command, "--reporter=json", `--outputFile=${reportPath}`];
  const receiptPath = path.join(directory, "receipt.json");
  const artifacts: { path: string; sha256: string; bytes: number }[] = [];
  const save = async (name: string, bytes: Uint8Array | string): Promise<void> => {
    const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    await writeFile(path.join(directory, name), buffer, { flag: "wx", mode: 0o400 });
    artifacts.push({
      path: name,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.byteLength,
    });
  };
  await save(
    "before.json",
    JSON.stringify(
      {
        sourceTreeDigest: before.sourceTreeDigest,
        truncated: before.truncated,
        files: before.files.map((file) => ({
          path: file.relativePath,
          contentHash: file.contentHash,
        })),
      },
      null,
      2,
    ),
  );
  let execution: ProductTestProcessResultV1;
  try {
    execution = await options.execute({
      root: before.root,
      command,
      timeoutMs,
      outputLimitBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    execution = {
      status: options.signal?.aborted === true ? "cancelled" : "spawn_failed",
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: Buffer.from(error instanceof Error ? error.message : String(error)),
    };
  }
  await save("stdout.log", execution.stdout.subarray(0, outputLimitBytes));
  await save("stderr.log", execution.stderr.subarray(0, outputLimitBytes));
  // Capture cancellation evidence too; an aborted runner never produces an accepted report.
  let after: Awaited<ReturnType<typeof collectProductInventory>> | undefined;
  let inventoryError: string | undefined;
  try {
    after = await collectProductInventory({ root: before.root });
  } catch (error) {
    inventoryError = error instanceof Error ? error.message : String(error);
  }
  await save(
    "after.json",
    JSON.stringify(
      {
        sourceTreeDigest: after?.sourceTreeDigest ?? null,
        truncated: after?.truncated ?? true,
        ...(inventoryError === undefined ? {} : { error: inventoryError }),
        files: (after?.files ?? []).map((file) => ({
          path: file.relativePath,
          contentHash: file.contentHash,
        })),
      },
      null,
      2,
    ),
  );
  let status: ProductTestRunResultV1["run"]["status"] = execution.status;
  let issue: string | undefined;
  let evidence: ProductTestEvidenceV1 | null = null;
  if (after === undefined && status === "completed") {
    status = "invalid_report";
    issue = `Could not bind the accepted source inventory after test execution: ${inventoryError ?? "unavailable"}.`;
  }
  if (execution.stdout.byteLength + execution.stderr.byteLength > outputLimitBytes)
    status = "output_limit";
  if (options.signal?.aborted === true) status = "cancelled";
  if (status === "completed" && after !== undefined) {
    try {
      const information = await lstat(reportPath);
      if (!information.isFile() || information.size > REPORT_LIMIT)
        throw new Error("Vitest JSON is missing or exceeds 16 MiB.");
      const bytes = await readFile(reportPath);
      if (bytes.byteLength > REPORT_LIMIT) throw new Error("Vitest JSON grew beyond 16 MiB.");
      artifacts.push({
        path: "vitest.json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      });
      await save("vitest.raw.json", bytes);
      const tests = parseVitestProductReport(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        before.root,
        new Set(before.files.map((file) => file.relativePath)),
      );
      if (!Number.isInteger(execution.exitCode))
        throw new Error("Runner did not provide an integer exit code.");
      evidence = {
        schemaVersion: 1,
        sourceTreeBefore: before.sourceTreeDigest,
        sourceTreeAfter: after.sourceTreeDigest,
        command,
        exitCode: execution.exitCode!,
        tests,
      };
      await save("evidence.json", JSON.stringify(evidence, null, 2));
      if (after.truncated || after.sourceTreeDigest !== before.sourceTreeDigest) {
        status = "stale";
        issue =
          "Accepted sources changed during test execution; this report is not current evidence.";
      }
    } catch (error) {
      status = "invalid_report";
      evidence = null;
      issue = error instanceof Error ? error.message : String(error);
    }
  }
  const run: ProductTestRunResultV1["run"] = {
    status,
    directory,
    receiptPath,
    exitCode: execution.exitCode,
    ...(issue === undefined ? {} : { issue }),
  };
  await save(
    "receipt.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        ...run,
        root: before.root,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        command,
        requestedCommand: options.command,
        shell: false,
        timeoutMs,
        outputLimitBytes,
        terminationSignal: execution.terminationSignal ?? null,
        stdoutCapturedBytes: execution.stdout.byteLength,
        stderrCapturedBytes: execution.stderr.byteLength,
        sourceTreeBefore: before.sourceTreeDigest,
        sourceTreeAfter: after?.sourceTreeDigest ?? null,
        proof: "local_runner_capture_not_authenticated",
        artifacts,
      },
      null,
      2,
    ),
  );
  return { run, evidence };
}
