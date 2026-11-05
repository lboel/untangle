/** Executes only the explicitly selected onboarding plan; ordinary init never calls this. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  createNodeProcessRunner,
  defaultProcessLimits,
  parseExtensionManifest,
  type ProcessResultV1,
  type ProcessRunnerPort,
} from "@untangle-code/extension-runtime";

import { parseArgs } from "../../cli/args.js";
import { OperationalError } from "../../cli/exit.js";
import { BufferIo } from "../../cli/io.js";
import { systemClock } from "../../cli/system.js";
import { findExtension, loadExtensionContext } from "../extensions/context.js";
import { createExtensionEnvironment } from "../extensions/environment.js";
import { extensionsCommand } from "../extensions.js";

import {
  planIntegrationSetup,
  type IntegrationCommandV1,
  type IntegrationDownloadV1,
  type IntegrationPlanItemV1,
  type IntegrationSetupPlanV1,
} from "./integrations-plan.js";

export interface IntegrationCommandResultV1 {
  exitCode: number;
  reused?: boolean;
  /** In-memory result only; raw stdout/stderr are never persisted in a setup report. */
  value?: unknown;
}

export interface IntegrationExecutedCommandV1 {
  command: string;
  args: readonly string[];
  exitCode: number | null;
  reused?: boolean;
  outcome?: string;
}

export interface IntegrationSetupDepsV1 {
  execute?: boolean;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  runner?: ProcessRunnerPort;
  fetchImpl?: typeof fetch;
  runExtensionCommand?: (
    args: readonly string[],
    root: string,
    signal?: AbortSignal,
  ) => Promise<IntegrationCommandResultV1>;
}

export interface IntegrationSetupItemResultV1 {
  id: IntegrationPlanItemV1["id"];
  status: "prepared" | "installed" | "needs_configuration" | "failed" | "cancelled";
  detail: string;
  files: string[];
  executed: IntegrationExecutedCommandV1[];
  nextSteps: readonly string[];
  metricsRead?: number;
}

export interface IntegrationSetupReportV1 {
  schemaVersion: 1;
  root: string;
  executeRequested: boolean;
  offline: boolean;
  items: IntegrationSetupItemResultV1[];
  reportPath: string;
  cancelled?: true;
}

class IntegrationSetupError extends OperationalError {}

export class IntegrationSetupCancelledError extends Error {
  override name = "AbortError";
  constructor(readonly reportPath: string | undefined) {
    super(
      reportPath === undefined
        ? "Integration setup cancelled. Its partial receipt could not be written safely."
        : `Integration setup cancelled. Partial receipt: ${reportPath}`,
    );
  }
}

function trackedRunner(
  runner: ProcessRunnerPort,
  receipts: IntegrationExecutedCommandV1[],
): ProcessRunnerPort {
  return {
    async run(invocation, limits, options) {
      const receipt: IntegrationExecutedCommandV1 = {
        command: invocation.command,
        args: [...invocation.args],
        exitCode: null,
      };
      receipts.push(receipt);
      const outcome = await runner.run(invocation, limits, options);
      receipt.exitCode = outcome.exitCode;
      receipt.outcome = outcome.outcome;
      return outcome;
    },
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Never traverse a symlink in a project-owned metadata path. */
async function safeTarget(root: string, relativePath: string, create: boolean): Promise<string> {
  const parts = relativePath.split("/");
  if (
    parts[0] !== ".untangle" ||
    parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))
  ) {
    throw new IntegrationSetupError(
      "Integration artifacts must stay below the project .untangle directory.",
    );
  }
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (!(await exists(parent))) {
      if (!create) return path.join(root, ...parts);
      try {
        await mkdir(parent, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(parent)) !== parent) {
      throw new IntegrationSetupError(
        "Integration metadata contains a symlink or a non-directory; no file was overwritten.",
      );
    }
  }
  const target = path.join(root, ...parts);
  if (await exists(target)) {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new IntegrationSetupError(
        "An integration artifact is not a regular file; it was preserved.",
      );
    }
  }
  return target;
}

async function checkArtifact(root: string, relativePath: string, bytes: Uint8Array): Promise<void> {
  const target = await safeTarget(root, relativePath, false);
  if ((await exists(target)) && !Buffer.from(await readFile(target)).equals(Buffer.from(bytes))) {
    throw new IntegrationSetupError(
      "An integration artifact already exists with different content; it was preserved.",
    );
  }
}

async function writeArtifact(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
  mode = 0o600,
): Promise<string> {
  const target = await safeTarget(root, relativePath, true);
  await checkArtifact(root, relativePath, bytes);
  if (await exists(target)) return target;
  const file = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return target;
}

export async function downloadIntegrationBinary(
  download: IntegrationDownloadV1,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const response = await fetchImpl(download.url, { signal: requestSignal, credentials: "omit" });
  if (!response.ok || response.body === null) {
    throw new IntegrationSetupError(
      "The pinned analyzer binary could not be downloaded; no binary was installed.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > download.maxBytes) {
        await reader.cancel();
        throw new IntegrationSetupError(
          "The analyzer download exceeded its byte limit; no binary was installed.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (sha256(bytes) !== download.sha256) {
    throw new IntegrationSetupError(
      "The analyzer SHA256 did not match the pinned release; no binary was installed or executed.",
    );
  }
  return bytes;
}

function processFailed(result: ProcessResultV1): boolean {
  return result.outcome !== "completed" || result.exitCode !== 0;
}

async function verifyContainerOwnership(
  item: IntegrationPlanItemV1,
  root: string,
  runner: ProcessRunnerPort,
  signal?: AbortSignal,
): Promise<void> {
  if (item.projectName === undefined) return;
  const limits = { ...defaultProcessLimits(), timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 };
  const result = await runner.run(
    {
      command: "docker",
      args: [
        "ps",
        "--all",
        "--filter",
        `label=com.docker.compose.project=${item.projectName}`,
        "--format",
        "{{.ID}}",
      ],
      cwd: root,
    },
    limits,
    signal === undefined ? {} : { signal },
  );
  signal?.throwIfAborted();
  if (processFailed(result))
    throw new IntegrationSetupError("Docker is unavailable; the server was not started.");
  for (const id of result.stdout.split(/\s+/u).filter(Boolean)) {
    if (!/^[a-f0-9]{12,64}$/u.test(id))
      throw new IntegrationSetupError("Docker returned an invalid container identity.");
    const inspected = await runner.run(
      {
        command: "docker",
        args: ["inspect", "--format", "{{json .Config.Labels}}", id],
        cwd: root,
      },
      limits,
      signal === undefined ? {} : { signal },
    );
    signal?.throwIfAborted();
    if (processFailed(inspected))
      throw new IntegrationSetupError(
        "Container ownership could not be verified; nothing was started.",
      );
    let labels: unknown;
    try {
      labels = JSON.parse(inspected.stdout) as unknown;
    } catch {
      throw new IntegrationSetupError("Container labels were not readable; nothing was started.");
    }
    if (
      typeof labels !== "object" ||
      labels === null ||
      (labels as Record<string, unknown>)["dev.untangle.init-managed"] !== "true" ||
      (labels as Record<string, unknown>)["dev.untangle.init-project"] !== item.projectName
    ) {
      throw new IntegrationSetupError(
        "A container already occupies this project name without Untangle ownership labels; it was not touched.",
      );
    }
  }
}

function extensionRunner(
  deps: IntegrationSetupDepsV1,
): NonNullable<IntegrationSetupDepsV1["runExtensionCommand"]> {
  if (deps.runExtensionCommand !== undefined) return deps.runExtensionCommand;
  return async (args, root, signal) => {
    const io = new BufferIo();
    const exitCode = await extensionsCommand.run(
      {
        cwd: root,
        env: deps.env ?? process.env,
        signal: signal ?? new AbortController().signal,
        io,
      },
      parseArgs([...args, "--format=json"], extensionsCommand.spec.flags),
    );
    let value: unknown;
    try {
      value = JSON.parse(io.outText) as unknown;
    } catch {
      value = undefined;
    }
    return { exitCode, ...(value === undefined ? {} : { value }) };
  };
}

async function executeCommand(
  command: IntegrationCommandV1,
  root: string,
  deps: IntegrationSetupDepsV1,
  runner: ProcessRunnerPort,
): Promise<IntegrationCommandResultV1> {
  deps.signal?.throwIfAborted();
  if (command.kind === "extension")
    return extensionRunner(deps)(command.args.slice(1), root, deps.signal);
  const result = await runner.run(
    { command: command.command, args: command.args, cwd: root },
    { ...defaultProcessLimits(), timeoutMs: 300_000, maxOutputBytes: 1024 * 1024 },
    deps.signal === undefined ? {} : { signal: deps.signal },
  );
  deps.signal?.throwIfAborted();
  return {
    exitCode: processFailed(result) ? (result.exitCode === 0 ? 1 : (result.exitCode ?? 1)) : 0,
  };
}

/** Only a generated, byte-equal selected manifest may reuse an existing profile entry. */
async function reuseSelectedManifest(
  plan: IntegrationSetupPlanV1,
  item: IntegrationPlanItemV1,
  command: IntegrationCommandV1,
  deps: IntegrationSetupDepsV1,
): Promise<boolean> {
  if (
    deps.runExtensionCommand !== undefined ||
    !item.id.startsWith("sonarqube-") ||
    command.args[1] !== "add"
  )
    return false;
  const source = item.files.find((file) => file.relativePath.endsWith("/manifest.toml"));
  if (source === undefined) return false;
  const parsed = parseExtensionManifest(source.content);
  if (parsed.manifest === null) return false;
  const environment = await createExtensionEnvironment({
    cwd: plan.root,
    env: deps.env ?? process.env,
  });
  const installed = findExtension(await loadExtensionContext(environment), parsed.manifest.id);
  return installed !== null && installed.manifestSha256 === sha256(Buffer.from(source.content));
}

export async function verifySelectedBinary(
  plan: IntegrationSetupPlanV1,
  item: IntegrationPlanItemV1,
  command: IntegrationCommandV1,
): Promise<void> {
  const download = item.downloads.find(
    (candidate) => path.join(plan.root, candidate.relativePath) === command.command,
  );
  if (download === undefined) return;
  const target = await safeTarget(plan.root, download.relativePath, false);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (sha256(await file.readFile()) !== download.sha256)
      throw new IntegrationSetupError(
        "The selected analyzer binary changed before execution; it was not started.",
      );
  } finally {
    await file.close();
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new IntegrationSetupError(
      "The selected analyzer binary path changed before execution; it was not started.",
    );
}

async function applyItem(
  plan: IntegrationSetupPlanV1,
  item: IntegrationPlanItemV1,
  deps: IntegrationSetupDepsV1,
  result: IntegrationSetupItemResultV1,
): Promise<IntegrationSetupItemResultV1> {
  for (const file of item.files)
    await checkArtifact(plan.root, file.relativePath, Buffer.from(file.content));
  for (const download of item.downloads) {
    const target = await safeTarget(plan.root, download.relativePath, false);
    if ((await exists(target)) && sha256(await readFile(target)) !== download.sha256) {
      throw new IntegrationSetupError(
        "An installed analyzer binary differs from the pinned release; it was preserved.",
      );
    }
  }
  for (const file of item.files) {
    deps.signal?.throwIfAborted();
    result.files.push(await writeArtifact(plan.root, file.relativePath, Buffer.from(file.content)));
  }
  if (deps.execute !== true || plan.offline) {
    if (plan.offline && deps.execute === true)
      result.detail = "Offline setup prepared; installation and network execution were skipped.";
    return result;
  }
  if (item.blockers.length > 0) {
    return { ...result, status: "needs_configuration", detail: item.blockers.join(" ") };
  }
  const runner = trackedRunner(
    deps.runner ?? createNodeProcessRunner(systemClock),
    result.executed,
  );
  await verifyContainerOwnership(item, plan.root, runner, deps.signal);
  for (const download of item.downloads) {
    deps.signal?.throwIfAborted();
    const target = await safeTarget(plan.root, download.relativePath, false);
    if (!(await exists(target))) {
      const bytes = await downloadIntegrationBinary(download, deps.fetchImpl ?? fetch, deps.signal);
      deps.signal?.throwIfAborted();
      result.files.push(await writeArtifact(plan.root, download.relativePath, bytes, 0o700));
    } else result.files.push(target);
  }
  for (const command of item.commands) {
    for (const file of item.files)
      await checkArtifact(plan.root, file.relativePath, Buffer.from(file.content));
    await verifySelectedBinary(plan, item, command);
    const isMetricsRead = command.kind === "extension" && command.args[1] === "run";
    const receipt: IntegrationExecutedCommandV1 | undefined =
      command.kind === "extension"
        ? { command: command.command, args: [...command.args], exitCode: null }
        : undefined;
    if (receipt !== undefined) result.executed.push(receipt);
    let execution: IntegrationCommandResultV1;
    try {
      execution = (await reuseSelectedManifest(plan, item, command, deps))
        ? { exitCode: 0, reused: true }
        : await executeCommand(command, plan.root, deps, runner);
    } catch (error) {
      deps.signal?.throwIfAborted();
      if (!isMetricsRead) throw error;
      return {
        ...result,
        status: "needs_configuration",
        detail:
          "The metrics read did not succeed. Check the named token, project key, server reachability and prior scanner analysis; no connection success or source freshness is claimed.",
      };
    }
    if (receipt !== undefined) {
      receipt.exitCode = execution.exitCode;
      if (execution.reused === true) receipt.reused = true;
    }
    if (execution.exitCode !== 0) {
      return {
        ...result,
        status: "failed",
        detail:
          "A selected setup command failed. Existing files were preserved; review the displayed command and prerequisites before retrying.",
      };
    }
    if (
      isMetricsRead &&
      typeof execution.value === "object" &&
      execution.value !== null &&
      "measurements" in execution.value &&
      Array.isArray(execution.value.measurements)
    ) {
      result.metricsRead = execution.value.measurements.length;
    }
  }
  if (item.id.startsWith("sonarqube-")) {
    if ((result.metricsRead ?? 0) > 0) {
      return {
        ...result,
        status: "installed",
        detail:
          "The configured server returned numeric project metrics through the existing extension runtime. These are external evidence from prior analysis; remote source freshness is not verified.",
      };
    }
    return {
      ...result,
      status: "needs_configuration",
      detail:
        "Selected server/manifest setup completed. Account, project, scanner and token configuration must be completed before a real metrics read; remote source freshness is not verified.",
    };
  }
  return {
    ...result,
    status: "installed",
    detail:
      item.id === "local-search"
        ? "The selected search services started and the default model pull completed. No index was built; use the generated endpoint configuration, doctor and index next."
        : item.id === "sentrux"
          ? "The hash-verified binary passed --version; its separate MCP template is prepared. No normalized Untangle adapter or scan is claimed."
          : "The trusted extension manifest was installed. Enable its ID and run the analyzer explicitly; installation starts no analyzer.",
  };
}

export async function applyIntegrationSetup(
  supplied: IntegrationSetupPlanV1,
  deps: IntegrationSetupDepsV1 = {},
): Promise<IntegrationSetupReportV1> {
  deps.signal?.throwIfAborted();
  const physicalRoot = await realpath(supplied.root);
  const plan = planIntegrationSetup({
    root: physicalRoot,
    selections: supplied.selections,
    offline: supplied.offline,
    platform: supplied.platform,
    arch: supplied.arch,
  });
  const items: IntegrationSetupItemResultV1[] = [];
  let active: IntegrationSetupItemResultV1 | undefined;
  try {
    for (const item of plan.items) {
      deps.signal?.throwIfAborted();
      active = {
        id: item.id,
        status: "prepared",
        detail: "Setup files prepared; no analyzer process or network request was started.",
        files: [],
        executed: [],
        nextSteps: item.nextSteps,
      };
      try {
        items.push(await applyItem(plan, item, deps, active));
      } catch (error) {
        deps.signal?.throwIfAborted();
        items.push({
          ...active,
          status: "failed",
          detail:
            error instanceof IntegrationSetupError
              ? error.message
              : "Integration setup failed. Existing files and credentials were preserved; review the plan and prerequisites.",
        });
      }
      active = undefined;
    }
    deps.signal?.throwIfAborted();
    const report = await persistSetupReport(plan, items, deps.execute === true);
    deps.signal?.throwIfAborted();
    return report;
  } catch (error) {
    if (deps.signal?.aborted !== true) throw error;
    if (active !== undefined)
      items.push({
        ...active,
        status: "cancelled",
        detail:
          "Setup cancelled before completion. Already prepared files or started owned services may remain; no automatic cleanup or success is claimed.",
      });
    for (const item of plan.items) {
      if (!items.some((result) => result.id === item.id))
        items.push({
          id: item.id,
          status: "cancelled",
          detail: "Not started because setup was cancelled.",
          files: [],
          executed: [],
          nextSteps: item.nextSteps,
        });
    }
    let reportPath: string | undefined;
    try {
      reportPath = (await persistSetupReport(plan, items, deps.execute === true, true)).reportPath;
    } catch {
      /* An unsafe or unwritable metadata directory never permits an outside fallback. */
    }
    throw new IntegrationSetupCancelledError(reportPath);
  }
}

async function persistSetupReport(
  plan: IntegrationSetupPlanV1,
  items: IntegrationSetupItemResultV1[],
  executeRequested: boolean,
  cancelled = false,
): Promise<IntegrationSetupReportV1> {
  const payload = {
    schemaVersion: 1 as const,
    root: plan.root,
    executeRequested,
    offline: plan.offline,
    items,
    ...(cancelled ? { cancelled: true as const } : {}),
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  const reportPath = await writeArtifact(
    plan.root,
    `.untangle/setup/integrations/results/${sha256(bytes)}.json`,
    bytes,
  );
  return { ...payload, reportPath };
}
