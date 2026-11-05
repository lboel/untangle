/**
 * `untangle init` as the CLI shell sees it.
 *
 * This is the ONLY file of the command that knows about argv, exit codes and
 * a terminal. Everything else (`run.ts` and below) is a library over ports,
 * which is why the whole detection pipeline is testable without a process,
 * without a network and without `node:fs`.
 */

import path from "node:path";

import { boolFlag, enumFlag, stringFlag, type FlagSpecs, type ParsedArgs } from "../../cli/args.js";
import type { Command, CommandContext } from "../../cli/command.js";
import { EXIT, UsageError } from "../../cli/exit.js";
import { line, note, processIo } from "../../cli/io.js";

import { formatTextReport } from "./report.js";
import { CONFIG_FILE_NAME, runInit, type InitDepsV1, type InitOptionsV1 } from "./run.js";
import { createWizardTerminal } from "./wizard-terminal.js";
import { runInitWizard, type InitWizardDepsV1 } from "./wizard.js";

const FLAGS: FlagSpecs = {
  interactive: {
    kind: "boolean",
    describe: "Guided terminal setup. --no-interactive keeps the scriptable config-only workflow.",
    defaultLabel: "automatic only on an interactive terminal, text output and online mode",
  },
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: `Project directory where ${CONFIG_FILE_NAME} is written.`,
    defaultLabel: "current directory",
  },
  force: {
    kind: "boolean",
    describe: `Overwrite an existing ${CONFIG_FILE_NAME}.`,
  },
  "dry-run": {
    kind: "boolean",
    describe: "Preview what would be created. Writes nothing.",
  },
  offline: {
    kind: "boolean",
    describe: "No network probes; Ollama and Qdrant are treated as absent.",
  },
  "embedding-model": {
    kind: "string",
    placeholder: "NAME",
    describe: "Select a specific embedding model instead of automatic discovery.",
    defaultLabel: "largest context window",
  },
  vision: {
    kind: "string",
    placeholder: "PATH",
    describe: "Vision for local document inspection; path relative to the project directory.",
  },
  spec: {
    kind: "string",
    placeholder: "PATH",
    describe:
      "Specification for local document inspection; path relative to the project directory.",
  },
  "feature-map": {
    kind: "string",
    placeholder: "PATH",
    describe:
      "Declared feature map for local evidence inspection; relative to the project directory.",
    defaultLabel: "untangle.features.json",
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Output format. `json` contains all findings, including the skip ledger.",
    defaultLabel: "text",
  },
};

/** argv → options. Rejects the ambiguous call rather than picking a winner. */
export function initOptionsFrom(args: ParsedArgs, cwd: string): InitOptionsV1 {
  if (args.positionals.length > 1) {
    throw new UsageError(
      `init accepts at most one path; received ${String(args.positionals.length)}.`,
      "untangle init [PATH]",
    );
  }
  const positional = args.positionals[0];
  const flagRoot = stringFlag(args, "root");
  if (positional !== undefined && flagRoot !== undefined) {
    throw new UsageError(
      "Specify the path as either an argument or --root, not both.",
      "untangle init /path/to/project",
    );
  }
  const preferredModel = stringFlag(args, "embedding-model");
  const visionPath = stringFlag(args, "vision");
  const specPath = stringFlag(args, "spec");
  const featureManifestPath = stringFlag(args, "feature-map");
  return {
    root: path.resolve(cwd, flagRoot ?? positional ?? "."),
    force: boolFlag(args, "force"),
    dryRun: boolFlag(args, "dry-run"),
    offline: boolFlag(args, "offline"),
    ...(preferredModel === undefined ? {} : { preferredModel }),
    ...(visionPath === undefined ? {} : { visionPath }),
    ...(specPath === undefined ? {} : { specPath }),
    ...(featureManifestPath === undefined ? {} : { featureManifestPath }),
  };
}

/**
 * Builds the command. `deps` exists so a test can hand in an in-memory file
 * system and a probe that answers nothing; production calls it with none.
 */
export interface InitCommandDepsV1 extends InitDepsV1 {
  wizard?: Partial<InitWizardDepsV1>;
}

export function createInitCommand(deps: InitCommandDepsV1 = {}): Command {
  return {
    spec: {
      name: "init",
      implementedBy: "commands/init/index.js",
      summary: "Discover a project and write a commented untangle.toml",
      usage:
        "untangle init [PATH] [--interactive|--no-interactive] [--vision=PATH] [--spec=PATH] [--feature-map=PATH] [--force] [--dry-run] [--offline]",
      details: [
        "On a terminal, guided setup previews configuration, optional local search/analyzer installation and a local feature/code map. No file, download or service is changed before the final selection. Preparing recipes and executing the displayed setup are separate choices. Prompts stay on stderr. Escape and Ctrl-C cancel; raw terminal mode is restored before external tools run.",
        "Pipes, agents, --format=json, --dry-run, --offline and --no-interactive retain config-only behavior. Explicit --interactive requires a terminal and cannot be combined with JSON or dry-run. Explicit offline interactive setup may prepare local files but cannot download or start tools.",
        `Discovers project languages weighted by lines, identifying parsed and search-only languages; monorepo topology across workspace packages and container services; an available embedding provider with its reported model, vector width and context window; an available vector store; and .gitignore rules plus defaults.`,
        `Writes a ${CONFIG_FILE_NAME} with comments explaining each value's evidence. Omitted values come from product defaults; the file includes only decisions made by init.`,
        "Missing Ollama or Qdrant is not an error. Configuration is still written with one next step.",
        "Vision and specification are inspected locally through filenames, readability, hashes and document references. --vision and --spec select sources relative to the project directory. The review draft confirms neither features nor ownership and does not claim semantic conformance.",
        "A supplied --feature-map, or untangle.features.json when present, makes declared features, code/test evidence, ownership declarations and feature complexity visible. No tests are executed and semantic conformance is not independently proven. Noninteractive init writes no visual map; confirmed guided setup may save a separate HTML/JSON snapshot. No ownership or implementation is confirmed automatically.",
        "Spec-driven setup can inspect detected local Spec Kit or OpenSpec artifacts when no explicit feature manifest was chosen. Only final confirmation saves a source-bound proposed manifest under .untangle/sdd/ and uses it for this setup's feature report/map. Existing declarations are preserved. No framework commands or tests run; imported features remain planned/proposed without invented owners. The same connector is available through `untangle product connect [auto|spec-kit|openspec]`.",
        "Discovery reads service information with GET and probes /api/embed with a small POST. Noninteractive init does not start or modify foreign services. A foreign vector store's usual default port is deliberately not probed (spec.md §3.2); set UNTANGLE_QDRANT_URL to select it explicitly. Only a confirmed interactive tool selection can install/start prepared owned services.",
        "A second identical run changes nothing. If an existing file differs, init displays line-by-line differences and preserves it unless --force is explicit.",
      ],
      flags: FLAGS,
      examples: [
        "untangle init",
        "untangle init --interactive",
        "untangle init --no-interactive --offline",
        "untangle init /path/to/another/project --dry-run",
        "untangle init --offline --force",
        "untangle init --format=json",
        "untangle init /path/to/project --vision=docs/vision.md --spec=docs/requirements.md",
      ],
      exitCodes: [
        [EXIT.ok, `${CONFIG_FILE_NAME} written or already current.`],
        [
          EXIT.operational,
          "An existing file differs and was preserved (use --force), or the generated configuration would be invalid.",
        ],
        [EXIT.usage, "Invalid arguments."],
      ],
    },

    async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
      const format = enumFlag(args, "format", ["text", "json"] as const, "text");
      const options = initOptionsFrom(args, ctx.cwd);
      const explicit = args.flags["interactive"];
      if (explicit === true && (format === "json" || options.dryRun))
        throw new UsageError(
          "--interactive cannot be combined with --format=json or --dry-run.",
          "Use --no-interactive for a machine-readable or write-free preview.",
        );
      const automatic =
        explicit === undefined &&
        ctx.io === processIo &&
        process.stdin.isTTY === true &&
        process.stderr.isTTY === true &&
        !ctx.env["CI"] &&
        format === "text" &&
        !options.dryRun &&
        !options.offline;
      const { wizard, ...ports } = deps;
      const initDeps = {
        env: ctx.env,
        signal: ctx.signal,
        ...ports,
      };
      let result;
      if (explicit === true || automatic) {
        if (
          wizard?.terminal === undefined &&
          (process.stdin.isTTY !== true || process.stderr.isTTY !== true)
        )
          throw new UsageError(
            "--interactive requires a terminal on stdin and stderr.",
            "Use `untangle init --no-interactive` in a pipe or coding agent.",
          );
        const terminal =
          wizard?.terminal ??
          createWizardTerminal({ write: (text) => ctx.io.err(text), signal: ctx.signal });
        if (
          !terminal.interactive ||
          (wizard?.terminal === undefined && process.stderr.isTTY !== true)
        )
          throw new UsageError(
            "--interactive requires a terminal on stdin and stderr.",
            "Use `untangle init --no-interactive` in a pipe or coding agent.",
          );
        const completed = await runInitWizard(ctx, options, initDeps, { ...wizard, terminal });
        if (completed.result === null) return completed.exitCode;
        result = completed.result;
        if (completed.exitCode !== result.exitCode) return completed.exitCode;
      } else result = await runInit(options, initDeps);

      if (format === "json") {
        line(ctx.io, JSON.stringify(result, null, 2));
        return result.exitCode;
      }

      // The path goes to stdout — it is the payload of this command, the one
      // thing a script would pipe. Everything else is diagnosis (cli/io.ts).
      line(ctx.io, result.configPath);
      for (const reportLine of formatTextReport(result)) {
        note(ctx.io, reportLine);
      }
      return result.exitCode;
    },
  };
}

/** The command with production ports. */
export const initCommand: Command = createInitCommand();
