/**
 * `untangle extensions run <id>`
 *
 * Runs one installed extension and normalizes whatever it prints into
 * `ExternalFindingV1` (X3). The order of the checks is the load-bearing part:
 *
 *   license gate  →  availability probe  →  run  →  parse  →  normalize
 *
 * The gate comes first because a version probe is already a process start,
 * and X5 forbids starting or pulling anything for a tool whose terms have not
 * been acknowledged. Checking availability first and the license second would
 * produce the same refusal — after having run the tool once.
 *
 * What comes out is evidence, never an Untangle metric: findings do not
 * change the exit code, and no number here is ever folded into a complexity
 * or risk value (X3). Everything the run could not resolve — a file outside
 * the workspace, a position that does not exist, a severity that hit the
 * mapping fallback — is reported with its reason rather than dropped (E4).
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { ExternalFindingV1, SkipLedgerEntryV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";
import {
  createLineOffsetResolver,
  defaultProcessLimits,
  normalizeToolPath,
  type ExtensionHealthV1,
  type ExtensionRunResultV1,
  type FileResolutionV1,
  type ProcessLimitsV1,
} from "@untangle-code/extension-runtime";

import { boolFlag, integerFlag, stringFlag, type ParsedArgs } from "../../cli/args.js";
import { EXIT, EnvironmentError, OperationalError, UsageError } from "../../cli/exit.js";
import { line, note, type Io } from "../../cli/io.js";

import { explainMissing, findExtension, gateFor, loadExtensionContext } from "./context.js";
import { resolveUserPath, type ExtensionEnvironmentV1 } from "./environment.js";
import { invokeExtension } from "./invoke.js";
import { emitJson, renderTable } from "./render.js";
import { saveCliState, summarizeRun } from "./state.js";

export interface RunDeps {
  /** Injected in tests so no unit test opens a socket. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function runRun(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
  deps: RunDeps = {},
): Promise<number> {
  const command = args.positionals[0] === "setup" ? "extensions setup" : "extensions run";
  const extensionId = args.positionals[1];
  if (extensionId === undefined) {
    throw new UsageError(
      `\`untangle ${command}\` needs an extension id.`,
      "Run `untangle extensions list` to see the installed ids.",
    );
  }

  const context = await loadExtensionContext(environment);
  const extension = findExtension(context, extensionId);
  if (extension === null) {
    throw new OperationalError(
      explainMissing(context, extensionId),
      "Install it first: untangle extensions add --from=<path-or-url>",
    );
  }
  const manifest = extension.manifest;

  const workspacePath = resolveUserPath(environment.cwd, stringFlag(args, "workspace") ?? ".");
  const target = resolveUserPath(environment.cwd, stringFlag(args, "target") ?? workspacePath);
  const ruleset = stringFlag(args, "ruleset") ?? manifest.defaultRuleset;

  // --- license gate BEFORE any process start (X5) -------------------------
  const gate = gateFor(context, extension, ruleset);
  if (!gate.allowed) {
    note(io, `EXTENSION_LICENSE_UNACKNOWLEDGED: ${extensionId} did not start.`);
    note(io, `  ${gate.tool.reason}`);
    for (const entry of gate.rulesets) {
      if (entry.status !== "acknowledged" && entry.status !== "not_required") {
        note(io, `  ruleset ${entry.ruleset}: ${entry.reason}`);
      }
    }
    throw new EnvironmentError(
      `The license gate for "${extensionId}" is not satisfied; nothing was started and nothing was pulled.`,
      gate.acknowledgeCommands.join(" && "),
    );
  }

  // Der eigentliche Lauf liegt in `invoke.ts` — als Daten hinein, als Ergebnis
  // heraus. `runRun` ist die MENSCHLICHE Fassung davon: es uebersetzt einen
  // nicht stattgefundenen Lauf in die Ausnahme, die ein einzelner Aufruf
  // erwartet, und berichtet danach. Ein Sammelbericht ruft dieselbe Funktion
  // auf und uebersetzt eben NICHT in eine Ausnahme.
  const limits = readLimits(args);
  const httpUrl = stringFlag(args, "url") ?? manifest.http?.defaultUrl;
  const outcome = await invokeExtension({
    environment,
    context,
    extension,
    workspacePath,
    target,
    limits,
    provisionConsent: boolFlag(args, "yes"),
    ...(ruleset === undefined ? {} : { ruleset }),
    ...(httpUrl === undefined ? {} : { httpUrl }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    onProvisionStep: (step) => {
      note(io, `  ${step}`);
    },
    onProvisionPlanned: (detail) => {
      note(io, `  ${detail}`);
    },
    resolveFile: workspaceFileResolver(workspacePath),
    resolvePosition: createLineOffsetResolver(lazyWorkspaceContents(workspacePath)),
  });

  if (outcome.status === "not_run") {
    note(io, `${extensionId} did not run: ${outcome.detail}`);
    if (outcome.reason === "license_gate_open") {
      throw new EnvironmentError(
        `The license gate for "${extensionId}" is not satisfied; nothing was started and nothing was pulled.`,
        outcome.nextStep ?? "acknowledge the licence first",
      );
    }
    throw new EnvironmentError(
      `"${extensionId}" did not run (${outcome.reason}).`,
      outcome.nextStep ?? "see the reason above",
    );
  }

  const { health, result } = outcome;

  await saveCliState(environment.fs, environment.userDataDir, {
    ...context.state,
    lastRuns: {
      ...context.state.lastRuns,
      [extensionId]: summarizeRun(result.run),
    },
  });

  report(io, format, {
    command,
    extensionId,
    workspacePath,
    target,
    health,
    result,
    warnings: context.warnings,
  });

  if (result.run.exitStatus === "completed") {
    return EXIT.ok;
  }
  throw new OperationalError(
    `"${extensionId}" ended with status ${result.run.exitStatus}` +
      `${result.run.errorCode === undefined ? "" : ` (${result.run.errorCode})`}.`,
    describeNextStep(health, result),
  );
}

function readLimits(args: ParsedArgs): ProcessLimitsV1 {
  const limits = defaultProcessLimits();
  const timeout = integerFlag(args, "timeout", limits.timeoutMs);
  const maxOutput = integerFlag(args, "max-output-bytes", limits.maxOutputBytes);
  if (timeout <= 0) {
    throw new UsageError(
      "--timeout expects a positive number of milliseconds.",
      "Example: --timeout=60000",
    );
  }
  if (maxOutput <= 0) {
    throw new UsageError(
      "--max-output-bytes expects a positive byte count.",
      "Example: --max-output-bytes=1048576",
    );
  }
  return { ...limits, timeoutMs: timeout, maxOutputBytes: maxOutput };
}

/**
 * Maps a tool-reported path onto workspace-relative form.
 *
 * `fileId` is deliberately absent with a stated reason: this command runs
 * against the working tree, not an index generation, so there is no file
 * identity to attach. Inventing one would make a finding look joined to an
 * index that never saw it.
 */
export function workspaceFileResolver(
  workspacePath: string,
): (toolPath: string) => FileResolutionV1 {
  return (toolPath: string): FileResolutionV1 => {
    const normalized = normalizeToolPath(toolPath);
    if (normalized === "") {
      return { fileIdMissingReason: "the tool reported an empty path" };
    }
    const absolute = /^([a-zA-Z]:\/|\/)/.test(normalized)
      ? normalized
      : resolve(workspacePath, normalized);
    const relativePath = relative(workspacePath, absolute).split("\\").join("/");
    if (relativePath === "" || relativePath.startsWith("../")) {
      return {
        fileIdMissingReason:
          `the tool reported "${toolPath}", which is outside the analyzed workspace ` +
          `"${workspacePath}"`,
      };
    }
    return {
      relativePath,
      fileIdMissingReason:
        "no index generation is loaded; this run resolves paths against the working tree only",
    };
  };
}

/**
 * A `ReadonlyMap` view over the working tree that reads a file the first time
 * a position inside it must be resolved.
 *
 * Reading the whole workspace eagerly to translate a handful of line numbers
 * would be the wrong trade. A failed read is cached as "absent", which makes
 * the position unresolvable — and therefore a ledger entry rather than a
 * guess (E4).
 */
export function lazyWorkspaceContents(workspacePath: string): ReadonlyMap<string, string> {
  const cache = new Map<string, string | null>();
  const load = (relativePath: string): string | null => {
    if (cache.has(relativePath)) {
      return cache.get(relativePath) ?? null;
    }
    let content: string | null;
    try {
      content = readFileSync(resolve(workspacePath, relativePath), "utf8");
    } catch {
      content = null;
    }
    cache.set(relativePath, content);
    return content;
  };
  return Object.assign(new Map<string, string>(), {
    get(key: string): string | undefined {
      return load(key) ?? undefined;
    },
    has(key: string): boolean {
      return load(key) !== null;
    },
  });
}

interface ReportInput {
  command: "extensions setup" | "extensions run";
  extensionId: string;
  workspacePath: string;
  target: string;
  health: ExtensionHealthV1;
  result: ExtensionRunResultV1;
  warnings: readonly string[];
}

function report(io: Io, format: "text" | "json", input: ReportInput): void {
  const { result } = input;
  if (format === "json") {
    emitJson(io, {
      command: input.command,
      extensionId: input.extensionId,
      workspace: input.workspacePath,
      target: input.target,
      evidenceOnly: true,
      health: input.health,
      run: result.run,
      findings: result.findings,
      measurements: result.measurements,
      skipped: result.skipped,
      error: result.error === undefined ? undefined : { message: result.error.message },
      warnings: input.warnings,
    });
  } else {
    line(io, `run ${result.run.runId} — ${input.extensionId} (${result.run.exitStatus})`);
    line(io, `  invocation  ${result.run.invocation ?? "(none)"}`);
    line(io, `  tool        ${result.run.toolVersion}`);
    line(io, `  format      ${result.run.outputFormat} via ${result.run.formatParserVersion}`);
    line(io, `  target      ${input.target}`);
    line(io, `  wall time   ${String(result.run.resources.wallTimeMs)} ms`);
    line(
      io,
      `  findings    ${String(result.run.findingsTotal)} (${describeCounts(result.run.findingCounts)})`,
    );

    if (result.findings.length > 0) {
      line(io, "");
      const rows = [...result.findings]
        .sort(
          (left, right) =>
            compareCodepoints(left.filePath, right.filePath) ||
            left.sourceRange.startByte - right.sourceRange.startByte ||
            compareCodepoints(left.ruleId, right.ruleId),
        )
        .map((finding) => [
          finding.severity.normalized,
          `${finding.filePath}:${String(finding.sourceRange.startLine ?? 0)}`,
          finding.ruleId,
          firstLine(finding.message),
        ]);
      for (const rendered of renderTable(["SEVERITY", "LOCATION", "RULE", "MESSAGE"], rows)) {
        line(io, rendered);
      }
      line(io, "");
      line(
        io,
        "These are external findings — evidence from a third-party tool. They are never folded " +
          "into Untangle complexity or risk numbers (X3).",
      );
    }
  }

  reportUnmappedSeverities(io, result.findings);
  for (const entry of result.skipped) {
    note(io, `skipped ${describeSkip(entry)}`);
  }
  for (const warning of result.run.warnings) {
    note(io, `warning: ${warning}`);
  }
  for (const warning of input.warnings) {
    note(io, `warning: ${warning}`);
  }
  for (const error of result.run.errors) {
    note(io, `${error.code}: ${error.message}`);
  }
  if (result.run.exitStatus !== "completed") {
    for (const reason of input.health.unavailableReasons) {
      note(io, `  ${reason.invocation}: ${reason.detail}`);
    }
  }
}

function describeNextStep(health: ExtensionHealthV1, result: ExtensionRunResultV1): string {
  if (!health.available) {
    const first = health.unavailableReasons[0];
    return first === undefined
      ? "Check the manifest's invocation section against what is installed on this machine."
      : `Make the ${first.invocation} invocation work: ${first.detail}`;
  }
  return result.error === undefined
    ? "Re-run with --format=json to see the full run record."
    : result.error.message;
}

function reportUnmappedSeverities(io: Io, findings: readonly ExternalFindingV1[]): void {
  const unmapped = findings.filter((finding) => !finding.severity.mappingMatched);
  if (unmapped.length === 0) {
    return;
  }
  const originals = [...new Set(unmapped.map((finding) => finding.severity.original))].sort(
    compareCodepoints,
  );
  note(
    io,
    `warning: ${String(unmapped.length)} finding(s) hit the severity fallback; the manifest maps ` +
      `no rule for: ${originals.join(", ")}`,
  );
}

function describeCounts(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

function describeSkip(entry: SkipLedgerEntryV1): string {
  const where = entry.path === undefined ? entry.subjectKind : `${entry.subjectKind} ${entry.path}`;
  return `${where}: ${entry.reason} — ${entry.detail}`;
}

function firstLine(message: string): string {
  const text = message.split("\n")[0] ?? "";
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}
