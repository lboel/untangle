/** One report with separate own metrics, external evidence and explained gaps. */
import { analyzeProductAlignment } from "@untangle-code/core";
import { METRICS_VERSION, compareCodepoints, formatExternalNumber } from "@untangle-code/domain";
import { createLineOffsetResolver, defaultProcessLimits } from "@untangle-code/extension-runtime";

import { boolFlag, enumFlag, stringFlag, type FlagSpecs, type ParsedArgs } from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { EXIT, UsageError } from "../cli/exit.js";
import { line, note, type Io } from "../cli/io.js";

import { analyze, type AnalysisResult } from "./complexity.js";
import { explainMissing, loadExtensionContext } from "./extensions/context.js";
import {
  canonicalize,
  createExtensionEnvironment,
  resolveUserPath,
} from "./extensions/environment.js";
import {
  finishScanFeature,
  renderScanFeature,
  type ScanFeatureContext,
  type ScanProductAnalyzer,
} from "./extensions/feature-scan.js";
import { invokeExtension, type ExtensionRanV1 } from "./extensions/invoke.js";
import { emitJson, renderTable } from "./extensions/render.js";
import { workspaceFileResolver, lazyWorkspaceContents } from "./extensions/run.js";
import { saveCliState, summarizeRun } from "./extensions/state.js";

const FLAGS: FlagSpecs = {
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Measurement root directory.",
    defaultLabel: "current directory",
  },
  yes: {
    kind: "boolean",
    describe:
      "Allow container provisioning and missing-credential setup for enabled extensions; costs are shown on stderr first.",
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Output format.",
    defaultLabel: "text",
  },
  feature: {
    kind: "string",
    placeholder: "ID",
    describe:
      "Declared feature: own full-file analysis, responsibility and separately scoped external evidence.",
  },
  manifest: {
    kind: "string",
    placeholder: "PATH",
    describe: "Feature manifest inside --root; requires --feature.",
  },
  "test-evidence": {
    kind: "string",
    placeholder: "PATH",
    describe:
      "Supplied source-bound test evidence inside --root; requires --feature. Does not execute tests.",
  },
};

interface NotMeasured {
  extensionId: string;
  reason: string;
  detail: string;
  nextStep?: string;
}

interface ScanData {
  root: string;
  own: AnalysisResult;
  outcomes: ExtensionRanV1[];
  notMeasured: NotMeasured[];
  warnings: string[];
  featureAlignment?: ScanFeatureContext;
}

export const scanCommand: Command = {
  spec: {
    name: "scan",
    implementedBy: "commands/scan.js",
    summary: "Own metrics and enabled extensions in one report",
    usage:
      "untangle scan [--root=PATH] [--feature=ID] [--manifest=PATH] [--test-evidence=PATH] [--yes] [--format=text|json]",
    details: [
      "Measure local complexity without an index and run all enabled extensions through Untangle. License gates, digest pins and provenance still apply.",
      "Three separate sections: own metrics, external evidence and unmeasured extensions with reasons. comparableTo supports test cross-checks, never differences, ratios or a combined report score (X3, X8).",
      "Without --yes, no container is provisioned. With --yes, consent applies to the whole scan; resources and image are shown on stderr before each provisioning action. License gates remain independent.",
      "Individual extension failures do not stop the report. Exit code 0 means the report was created, not that every extension succeeded. JSON includes run status, provenance and skip reasons.",
      "--feature links declared intent, ownership, complete code/test measurements and external file evidence. Repository analyzer values stay repository context; remote source freshness is not inferred. Local sources are checked before and after. No feature flag preserves the existing report.",
    ],
    flags: FLAGS,
    examples: [
      "untangle scan",
      "untangle scan --format=json",
      "untangle scan --feature=search.local --format=json",
      "untangle scan --yes",
    ],
    exitCodes: [
      [EXIT.ok, "Report created, including explained extension failures."],
      [EXIT.operational, "The own-code analysis could not run."],
      [EXIT.usage, "Invalid arguments."],
      [EXIT.cancelled, "Cancelled."],
    ],
  },
  run: runScan,
};

/** Injectable HTTP boundary; analysis, discovery and execution remain real in tests. */
export async function runScan(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: { fetchImpl?: typeof fetch; analyzeProduct?: ScanProductAnalyzer } = {},
): Promise<number> {
  const format = enumFlag(args, "format", ["text", "json"] as const, "text");
  if (args.positionals.length > 0) {
    throw new UsageError("scan does not accept positional arguments.", "Use --root=PATH.");
  }
  const featureId = stringFlag(args, "feature");
  const manifestPath = stringFlag(args, "manifest");
  const testEvidencePath = stringFlag(args, "test-evidence");
  for (const [name, value] of [
    ["feature", featureId],
    ["manifest", manifestPath],
    ["test-evidence", testEvidencePath],
  ] as const) {
    if (value !== undefined && value.trim().length === 0)
      throw new UsageError(`--${name} requires a non-empty value.`);
  }
  if (featureId === undefined && (manifestPath !== undefined || testEvidencePath !== undefined))
    throw new UsageError("--manifest and --test-evidence require --feature.");
  ctx.signal.throwIfAborted();
  const requestedRoot = resolveUserPath(ctx.cwd, stringFlag(args, "root") ?? ".");
  // The analyzed project, including --root outside cwd, is the discovery boundary.
  const environment = await createExtensionEnvironment({ cwd: requestedRoot, env: ctx.env });
  const root = await canonicalize(environment.fs, requestedRoot);
  const productAnalyzer = deps.analyzeProduct ?? analyzeProductAlignment;
  const featureOptions =
    featureId === undefined
      ? undefined
      : {
          root,
          featureId,
          signal: ctx.signal,
          ...(manifestPath === undefined
            ? {}
            : { manifestPath: resolveUserPath(root, manifestPath) }),
          ...(testEvidencePath === undefined
            ? {}
            : { testEvidencePath: resolveUserPath(root, testEvidencePath) }),
        };
  const productBefore =
    featureOptions === undefined ? undefined : await productAnalyzer(featureOptions);
  const own = await analyze(root, ctx.signal);
  const context = await loadExtensionContext(environment);
  const notMeasured: NotMeasured[] = [];
  const outcomes: ExtensionRanV1[] = [];
  const warnings = [...context.warnings];

  for (const rejected of context.discovery.rejected) {
    notMeasured.push({
      extensionId: rejected.directoryName ?? rejected.manifestPath,
      reason: "manifest_rejected",
      detail: `${rejected.manifestPath}: ${rejected.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`,
      nextStep: "untangle extensions list",
    });
  }
  for (const ignored of context.discovery.ignored) {
    notMeasured.push({
      extensionId: ignored.manifestPath,
      reason: "manifest_ignored",
      detail: `${ignored.reason}: ${ignored.detail}`,
      nextStep: "untangle extensions list",
    });
  }
  const installed = new Set(context.discovery.extensions.map((entry) => entry.manifest.id));
  for (const id of context.state.enabled) {
    if (!installed.has(id) && !notMeasured.some((entry) => entry.extensionId === id)) {
      notMeasured.push({
        extensionId: id,
        reason: "extension_missing",
        detail: explainMissing(context, id),
        nextStep: "untangle extensions list",
      });
    }
  }

  const resolveFile = workspaceFileResolver(root);
  const resolvePosition = createLineOffsetResolver(lazyWorkspaceContents(root));
  const extensions = [...context.discovery.extensions].sort((a, b) =>
    compareCodepoints(a.manifest.id, b.manifest.id),
  );
  for (const extension of extensions) {
    ctx.signal.throwIfAborted();
    const outcome = await invokeExtension({
      environment,
      context,
      extension,
      workspacePath: root,
      target: root,
      limits: defaultProcessLimits(),
      provisionConsent: boolFlag(args, "yes"),
      requireEnabled: true,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      onProvisionPlanned: (detail) => {
        note(ctx.io, `Provisioning: ${detail}`);
      },
      onProvisionStep: (step) => {
        note(ctx.io, `  ${step}`);
      },
      signal: ctx.signal,
      resolveFile,
      resolvePosition,
    });
    if (outcome.status === "not_run") {
      notMeasured.push(outcome);
      continue;
    }
    outcomes.push(outcome);
    if (outcome.result.run.exitStatus !== "completed") {
      notMeasured.push({
        extensionId: outcome.extensionId,
        reason: "run_failed",
        detail: [
          outcome.result.run.exitStatus,
          outcome.result.run.errorCode,
          outcome.result.error?.message,
        ]
          .filter(Boolean)
          .join(": "),
        nextStep: `untangle extensions run ${outcome.extensionId}${extension.manifest.container === undefined ? "" : " --yes"}`,
      });
    }
  }
  ctx.signal.throwIfAborted();
  if (outcomes.length > 0) {
    try {
      await saveCliState(environment.fs, environment.userDataDir, {
        ...context.state,
        lastRuns: {
          ...context.state.lastRuns,
          ...Object.fromEntries(
            outcomes.map((outcome) => [outcome.extensionId, summarizeRun(outcome.result.run)]),
          ),
        },
      });
    } catch {
      warnings.push(
        "The report was created, but the last extension run could not be saved in the user profile.",
      );
    }
  }
  notMeasured.sort(
    (a, b) =>
      compareCodepoints(a.extensionId, b.extensionId) || compareCodepoints(a.reason, b.reason),
  );
  ctx.signal.throwIfAborted();
  const featureAlignment =
    featureOptions === undefined || productBefore === undefined
      ? undefined
      : await finishScanFeature(featureOptions, productBefore, outcomes, productAnalyzer);
  ctx.signal.throwIfAborted();
  render(ctx.io, format, {
    root,
    own,
    outcomes,
    notMeasured,
    warnings,
    ...(featureAlignment === undefined ? {} : { featureAlignment }),
  });
  return EXIT.ok;
}

function render(io: Io, format: "text" | "json", data: ScanData): void {
  if (format === "json") {
    emitJson(io, {
      command: "scan",
      root: data.root,
      ownMetrics: {
        metricsVersion: METRICS_VERSION,
        filesDiscovered: data.own.filesDiscovered,
        filesAnalyzed: data.own.filesAnalyzed,
        totals: data.own.totals,
        totalsReading: data.own.totalsReading,
        proseAnalyzed: data.own.proseAnalyzed,
        prose: data.own.prose,
        skipped: data.own.skipped,
      },
      externalSignals: data.outcomes.map((outcome) => ({
        extensionId: outcome.extensionId,
        evidenceOnly: true,
        health: outcome.health,
        run: outcome.result.run,
        measurements: outcome.result.measurements,
        findings: outcome.result.findings,
        skipped: outcome.result.skipped,
        error: outcome.result.error?.message,
      })),
      notMeasured: data.notMeasured,
      warnings: data.warnings,
      ...(data.featureAlignment === undefined ? {} : { featureAlignment: data.featureAlignment }),
    });
    return;
  }
  line(io, `# Own metrics (${METRICS_VERSION}) — ${data.root}`);
  for (const row of renderTable(
    ["KENNZAHL", "VALUE"],
    [
      ["files analyzed", String(data.own.filesAnalyzed)],
      ["Ausfuehrungseinheiten", String(data.own.totals.executionUnits)],
      ["including outermost units", String(data.own.totals.executionUnitRoots)],
      ["Cognitive total", String(data.own.totals.cognitive)],
      ["Cyclomatic total", String(data.own.totals.cyclomatic)],
      ["Prose analyzed separately", String(data.own.proseAnalyzed)],
      ["skipped with a reason", String(data.own.skipped.length)],
    ],
  ))
    line(io, `  ${row}`);
  line(io, "  Totals: execution_unit (nested functions are not counted twice).");
  for (const skip of data.own.skipped)
    note(io, `skip ${skip.path ?? ""}: ${skip.reason} — ${skip.detail}`);

  line(io, "\n# External signals — evidence, never Untangle metrics (X3)");
  if (data.outcomes.length === 0) line(io, "  no extension was executed.");
  for (const { extensionId, result } of data.outcomes) {
    line(io, `  ${extensionId} (${result.run.toolVersion}): ${result.run.exitStatus}`);
    line(
      io,
      `    Lauf ${result.run.runId}; ${result.run.findingsTotal} findings; ${result.run.formatParserVersion}`,
    );
    for (const measurement of result.measurements) {
      const signal = measurement.signal;
      line(
        io,
        `    ${measurement.key}: ${formatExternalNumber(measurement.value)} — ${signal === undefined ? "without a declared meaning" : `${signal.kind}/${signal.scope}`}`,
      );
    }
    for (const finding of result.findings)
      line(
        io,
        `    ${finding.severity.normalized} ${finding.filePath}:${finding.sourceRange.startLine ?? 0} ${finding.ruleId}: ${finding.message}`,
      );
    for (const skip of result.skipped) note(io, `${extensionId}: ${skip.reason} — ${skip.detail}`);
    for (const warning of result.run.warnings) note(io, `${extensionId}: ${warning}`);
    for (const error of result.run.errors)
      note(io, `${extensionId}: ${error.code} — ${error.message}`);
  }
  line(io, "\n# Not measured, with reasons (E4)");
  if (data.notMeasured.length === 0) line(io, "  no omitted or failed extensions.");
  for (const entry of data.notMeasured) {
    line(io, `  ${entry.extensionId}: ${entry.reason}\n    ${entry.detail}`);
    if (entry.nextStep !== undefined) line(io, `    -> ${entry.nextStep}`);
  }
  for (const warning of data.warnings) note(io, `warning: ${warning}`);
  if (data.featureAlignment !== undefined) renderScanFeature(io, data.featureAlignment);
}
