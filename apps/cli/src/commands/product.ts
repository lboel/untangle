import path from "node:path";

import { analyzeProductAlignment, runProductTests } from "@untangle-code/core";
import type { ProductAlignmentReportV1 } from "@untangle-code/domain";

import {
  boolFlag,
  enumFlag,
  numberFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { EXIT, UsageError } from "../cli/exit.js";
import { line, note } from "../cli/io.js";

import { executeProductTests } from "./product-test-runner.js";
import { runSddConnection, SDD_CONNECT_FLAGS } from "./sdd.js";

const FLAGS: FlagSpecs = {
  ...SDD_CONNECT_FLAGS,
  root: { kind: "string", placeholder: "PATH", describe: "Project directory." },
  manifest: {
    kind: "string",
    placeholder: "PATH",
    describe: "Declared feature map, relative to the project directory.",
    defaultLabel: "untangle.features.json",
  },
  feature: { kind: "string", placeholder: "ID", describe: "Inspect one declared feature." },
  path: {
    kind: "string",
    placeholder: "PATH",
    describe: "Find declared features for one repository-relative literal search-hit path.",
  },
  draft: {
    kind: "boolean",
    describe:
      "With explicit --feature and --path, show an unwritten review draft only when the feature manifest is missing.",
  },
  "run-tests": {
    kind: "boolean",
    describe:
      "Explicitly run a Vitest-compatible argv after --, without a shell; capture source-bound test evidence.",
  },
  "test-timeout": {
    kind: "number",
    placeholder: "MS",
    describe: "Explicit test-run timeout in milliseconds (1..3600000).",
    defaultLabel: "120000",
  },
  "test-evidence": {
    kind: "string",
    placeholder: "PATH",
    describe: "Supplied source-bound test report, relative to the project directory.",
  },
  "max-cognitive": {
    kind: "number",
    placeholder: "N",
    describe: "Default cognitive threshold per execution unit.",
    defaultLabel: "15",
  },
  "require-complete": {
    kind: "boolean",
    describe: "Exit 5 unless the report status is evidence_consistent.",
  },
  format: { kind: "string", placeholder: "text|json", describe: "Output format." },
};

type ProductAnalyzer = typeof analyzeProductAlignment;

/** Resolve evidence paths only after selecting the target project. */
export function productOptionsFrom(
  args: ParsedArgs,
  cwd: string,
  signal: AbortSignal,
): Parameters<ProductAnalyzer>[0] {
  const runTests = boolFlag(args, "run-tests");
  if (!runTests && args.positionals.length !== 0) {
    throw new UsageError(
      "product does not accept positional arguments.",
      "untangle product --help",
    );
  }
  const root = path.resolve(cwd, stringFlag(args, "root") ?? ".");
  const manifest = stringFlag(args, "manifest");
  const testEvidence = stringFlag(args, "test-evidence");
  const featureId = stringFlag(args, "feature");
  const selectedPath = stringFlag(args, "path");
  if (
    selectedPath !== undefined &&
    (selectedPath.length === 0 ||
      selectedPath.length > 4096 ||
      path.isAbsolute(selectedPath) ||
      /[:\\*?[\]{}]/u.test(selectedPath) ||
      Array.from(selectedPath).some((character) => character.charCodeAt(0) < 32) ||
      selectedPath.split("/").some((part) => part === "" || part === "." || part === ".."))
  )
    throw new UsageError(
      "--path requires one repository-relative literal file path without glob syntax.",
    );
  if (runTests && testEvidence !== undefined)
    throw new UsageError(
      "--run-tests cannot be combined with --test-evidence; existing evidence is never replaced.",
    );
  if (boolFlag(args, "draft") && (featureId === undefined || selectedPath === undefined))
    throw new UsageError("--draft requires an explicitly chosen --feature=ID and --path=PATH.");
  if (boolFlag(args, "draft") && (runTests || testEvidence !== undefined))
    throw new UsageError(
      "--draft cannot be combined with test execution or supplied test evidence.",
    );
  if (runTests && args.positionals.length === 0)
    throw new UsageError(
      "--run-tests requires a Vitest-compatible command after --.",
      "untangle product --run-tests -- pnpm exec vitest run",
    );
  if (!runTests && numberFlag(args, "test-timeout") !== undefined)
    throw new UsageError("--test-timeout requires --run-tests.");
  const timeout = numberFlag(args, "test-timeout") ?? 120_000;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 3_600_000)
    throw new UsageError("--test-timeout must be an integer between 1 and 3600000 milliseconds.");
  const maxCognitive = numberFlag(args, "max-cognitive") ?? 15;
  if (!Number.isFinite(maxCognitive) || maxCognitive < 0) {
    throw new UsageError("--max-cognitive must be a finite number >= 0.");
  }
  for (const [name, value] of [
    ["manifest", manifest],
    ["test-evidence", testEvidence],
    ["feature", featureId],
  ] as const) {
    if (value !== undefined && value.trim().length === 0) {
      throw new UsageError(`--${name} requires a non-empty value.`);
    }
  }
  return {
    root,
    ...(manifest === undefined ? {} : { manifestPath: path.resolve(root, manifest) }),
    ...(testEvidence === undefined ? {} : { testEvidencePath: path.resolve(root, testEvidence) }),
    ...(featureId === undefined ? {} : { featureId }),
    ...(selectedPath === undefined ? {} : { path: selectedPath }),
    maxCognitive,
    signal,
  };
}

export function createProductCommand(
  deps: { analyze?: ProductAnalyzer; runTests?: typeof runProductTests } = {},
): Command {
  return {
    spec: {
      name: "product",
      implementedBy: "commands/product.js",
      summary: "Inspect declared features, evidence, ownership and complexity",
      usage:
        "untangle product [connect [auto|spec-kit|openspec] [--dry-run]] [--root=PATH] [--manifest=PATH] [--feature=ID] [--path=PATH] [--require-complete] [--run-tests -- <vitest command argv>]",
      details: [
        "product connect [auto|spec-kit|openspec] reads supported local framework artifacts and explicit source references. --dry-run writes nothing; an explicit connection saves a source-bound proposed feature manifest and report under .untangle/sdd/. It runs no framework scripts or tests, replaces no declarations, and confirms no implementation or ownership.",
        "Reads a declared feature map and current local files. No index or embedding provider is required. The default analysis executes no tests and writes no files.",
        "--path connects one literal repository-relative search hit to every declared code, test, intent or ownership association. Matching features retain their complete code/test measurements and global shared-file coverage.",
        "--draft --feature=ID --path=PATH shows a review draft on stdout when the manifest is missing and the literal file is accepted and fresh. It invents no owners, intent references, criteria or test paths, confirms no implementation, and writes no manifest.",
        "Only --run-tests explicitly executes the supplied Vitest-compatible command argv without a shell. Untangle adds JSON reporter/output arguments and captures original output, full before/after source inventories, evidence and hashes in a unique OS-temporary directory. This is local execution capture, not authenticated evidence; inspect testRun.receiptPath. Default timeout: 120 seconds; stdout/stderr and JSON limits: 16 MiB each. No tests run automatically.",
        "Vision/spec references, code/test selections, declared ownership, metrics and supplied source-bound test evidence stay inspectable. Semantic conformance and ownership authority are not independently proven.",
        "Normal reports exit 0 even when evidence needs review. --require-complete exits 5 for every status except evidence_consistent; the report remains available.",
        "Code and test metrics are separate. Shared files are reported explicitly; their union is not the sum of per-feature metrics. Agent hints identify missing evidence and bounded next actions.",
      ],
      flags: FLAGS,
      examples: [
        "untangle product connect auto --dry-run --format=json",
        "untangle product connect spec-kit --format=json",
        "untangle product connect openspec --format=json",
        "untangle product --format=json",
        "untangle product --feature=search.local --test-evidence=checks/unit.json",
        "untangle product --require-complete --max-cognitive=15",
        "untangle product --path=src/accounts/lookup.ts --format=json",
        "untangle product --draft --feature=accounts.lookup --path=src/accounts/lookup.ts --format=json",
        "untangle product --run-tests -- pnpm exec vitest run src/accounts/lookup.test.ts",
      ],
      exitCodes: [
        [EXIT.ok, "Report produced; inspect its evidence status."],
        [EXIT.operational, "Local analysis failed."],
        [EXIT.usage, "Invalid arguments."],
        [EXIT.gate, "--require-complete requested, but evidence is not consistent."],
        [EXIT.cancelled, "Cancelled."],
      ],
    },
    async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
      if (args.positionals[0] === "connect") return runSddConnection(ctx, args);
      if (args.flags["dry-run"] !== undefined)
        throw new UsageError("--dry-run is supported only by product connect.");
      const format = enumFlag(args, "format", ["text", "json"] as const, "text");
      const options = productOptionsFrom(args, ctx.cwd, ctx.signal);
      ctx.signal.throwIfAborted();
      const execution = boolFlag(args, "run-tests")
        ? await (deps.runTests ?? runProductTests)({
            root: options.root,
            command: args.positionals,
            execute: executeProductTests,
            signal: ctx.signal,
            timeoutMs: numberFlag(args, "test-timeout") ?? 120_000,
          })
        : undefined;
      if (ctx.signal.aborted && execution !== undefined)
        note(ctx.io, `Explicit test run interrupted; receipt ${execution.run.receiptPath}`);
      ctx.signal.throwIfAborted();
      if (execution?.evidence !== undefined && execution.evidence !== null)
        options.testEvidence = execution.evidence;
      const report = await (deps.analyze ?? analyzeProductAlignment)(options);
      ctx.signal.throwIfAborted();
      if (boolFlag(args, "draft")) {
        if (report.manifest.status !== "missing")
          throw new UsageError(
            "--draft requires a missing manifest; inspect the existing map instead of replacing its declarations.",
          );
        if (report.selection?.status !== "unmapped")
          throw new UsageError(
            "--draft requires a fresh accepted file; missing, ignored or changed paths cannot seed a declaration.",
          );
        report.draft = {
          schemaVersion: 1,
          owners: [],
          features: [
            {
              id: options.featureId!,
              title: options.featureId!,
              stage: "planned",
              review: "proposed",
              intent: [],
              owners: [],
              code: { include: [options.path!] },
              tests: { include: [] },
              criteria: [],
              dependsOn: [],
            },
          ],
        };
        report.issues.push(
          "Review draft only: extend the complete code boundary, declare vision/specification, owners, tests and acceptance criteria, and confirm implementation explicitly. No manifest was written.",
        );
      }
      if (execution !== undefined) {
        report.testRun = execution.run;
        if (execution.run.status !== "completed") {
          report.issues.push(
            `Explicit test run: ${execution.run.status}. ${execution.run.issue ?? "Inspect the immutable runner receipt."}`,
          );
          if (report.status !== "violated") report.status = "incomplete";
        }
      }
      line(
        ctx.io,
        format === "json" ? JSON.stringify(report, null, 2) : formatProductReport(report),
      );
      if (execution !== undefined && execution.run.status !== "completed") return EXIT.operational;
      if (
        execution !== undefined &&
        (execution.run.exitCode !== 0 ||
          execution.evidence?.tests.some((test) => test.status === "failed") === true)
      )
        return EXIT.gate;
      return boolFlag(args, "require-complete") && report.status !== "evidence_consistent"
        ? EXIT.gate
        : EXIT.ok;
    },
  };
}

/** Keep evidence statuses and metrics visible in the agent-facing text view. */
export function formatProductReport(report: ProductAlignmentReportV1): string {
  const lines = [
    `untangle product — ${oneLine(report.root)}`,
    `Status: ${report.status}; manifest ${oneLine(report.manifest.path)} (${report.manifest.status})`,
    `Source tree: ${report.sourceTreeDigest}; inventory ${String(report.inventory.files)} files${report.inventory.truncated ? " (truncated)" : ""}`,
    `Semantic conformance: ${report.semanticConformance}; ownership authority: ${report.ownershipAuthority}`,
  ];
  if (report.selection !== undefined)
    lines.push(
      `Selected path: ${oneLine(report.selection.path)} (${report.selection.status}); features: ${report.selection.matches.map((match) => `${oneLine(match.featureId)} [${match.roles.join(", ")}]`).join("; ") || "none"}`,
    );
  if (report.testRun !== undefined)
    lines.push(
      `Explicit test run: ${report.testRun.status}; exit=${String(report.testRun.exitCode)}; receipt ${oneLine(report.testRun.receiptPath)}`,
    );
  for (const feature of report.features) {
    lines.push("", `${oneLine(feature.id)} — ${oneLine(feature.title)}: ${feature.status}`);
    lines.push(
      `  Declaration: ${feature.stage}, ${feature.review}; owners ${feature.ownership.map((owner) => `${oneLine(owner.id)}:${owner.status}`).join(", ") || "none"}`,
    );
    lines.push(
      `  Code: ${String(feature.code.files.length)} files, complete=${String(feature.code.complete)}; tests: ${String(feature.tests.files.length)} files, complete=${String(feature.tests.complete)}`,
    );
    if (feature.code.metrics !== null) {
      const metrics = feature.code.metrics;
      lines.push(
        `  Cognitive: execution_unit=${String(metrics.cognitive.execution_unit)}, self=${String(metrics.cognitive.self)}, top_level=${String(metrics.cognitive.top_level)}; ${metrics.metricsVersion}/${metrics.cognitiveAlgorithm}`,
      );
    }
    lines.push(
      `  Test evidence: ${feature.testEvidence.status} (${String(feature.testEvidence.passed)} passed, ${String(feature.testEvidence.failed)} failed, ${String(feature.testEvidence.skipped)} skipped); ${feature.testEvidence.proof}`,
    );
    for (const criterion of feature.criteria) {
      lines.push(
        `  Criterion ${oneLine(criterion.id)}: ${criterion.status} — ${oneLine(criterion.description)}`,
      );
    }
    for (const hint of feature.agentHints) {
      lines.push(
        `  ${hint.severity.toUpperCase()} ${oneLine(hint.code)}: ${oneLine(hint.message)}`,
      );
      lines.push(
        `    Action: ${oneLine(hint.suggestedAction)}; paths: ${hint.paths.map(oneLine).join(", ") || "none"}`,
      );
      if (hint.search !== undefined) lines.push(`    Search: ${JSON.stringify(hint.search)}`);
    }
    for (const issue of feature.issues) lines.push(`  Issue: ${oneLine(issue)}`);
  }
  lines.push(
    "",
    `Coverage: ${String(report.coverage.mappedCodeFiles)} mapped / ${String(report.coverage.measuredCodeFiles)} measured code files; ${String(report.coverage.unmappedCodeFileCount)} unmapped; ${String(report.coverage.sharedFiles.length)} shared files`,
  );
  for (const issue of report.issues) lines.push(`Issue: ${oneLine(issue)}`);
  for (const limitation of report.limitations) lines.push(`Limit: ${oneLine(limitation)}`);
  if (report.draft !== null)
    lines.push(`Review draft (not written): ${JSON.stringify(report.draft)}`);
  return lines.join("\n");
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]/gu, " ");
}

export const productCommand: Command = createProductCommand();
