#!/usr/bin/env node
/** Explicit checkout setup and an index-free first analysis; no global or host configuration writes. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runEvidenceCommand } from "./release-evidence.mjs";

const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

export function supportsSetupNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  return (
    match !== null &&
    (Number(match[1]) >= 24 || (Number(match[1]) === 22 && Number(match[2]) >= 13))
  );
}

export function parseSetupOptions(args, cwd = process.cwd()) {
  const options = {
    project: CHECKOUT,
    skipBuild: false,
    dryRun: false,
    format: "text",
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (seen.has(name)) throw new Error(`Duplicate option ${name}.`);
    seen.add(name);
    if (name === "--skip-build" || name === "--dry-run") {
      if (separator !== -1) throw new Error(`${name} accepts no value.`);
      options[name === "--skip-build" ? "skipBuild" : "dryRun"] = true;
    } else if (name === "--project" || name === "--format") {
      const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw new Error(`${name} requires a value.`);
      if (name === "--project") options.project = path.resolve(cwd, value);
      else if (value === "text" || value === "json") options.format = value;
      else throw new Error("--format must be text or json.");
    } else throw new Error(`Unknown option ${argument}. Run pnpm setup:local --help.`);
  }
  return options;
}

/** Quotes are only for display. Every real command uses an argv array without a shell. */
export function displaySetupCommand(command) {
  return command.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
}

function validAnalysis(analysis, project) {
  return (
    analysis !== null &&
    typeof analysis === "object" &&
    analysis.schemaVersion === 1 &&
    analysis.root === project &&
    Number.isInteger(analysis.filesDiscovered) &&
    analysis.filesDiscovered >= 0 &&
    Number.isInteger(analysis.filesAnalyzed) &&
    analysis.filesAnalyzed >= 0 &&
    analysis.filesAnalyzed <= analysis.filesDiscovered &&
    analysis.totalsReading === "execution_unit" &&
    typeof analysis.totals?.cognitive === "number" &&
    Number.isFinite(analysis.totals.cognitive) &&
    Array.isArray(analysis.hotspots) &&
    Array.isArray(analysis.skipped)
  );
}

export async function runLocalSetup(options, dependencies = {}) {
  const checkout = realpathSync(dependencies.checkout ?? CHECKOUT);
  const project = realpathSync(options.project ?? checkout);
  if (!statSync(project).isDirectory())
    throw new Error("--project must name an existing directory.");
  const node = dependencies.node ?? process.execPath;
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  const platform = dependencies.platform ?? process.platform;
  const manifest = JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf8"));
  const pnpmVersion = /^pnpm@([^+]+)(?:\+.*)?$/u.exec(manifest.packageManager)?.[1];
  if (!pnpmVersion) throw new Error("The checkout must declare an exact pnpm packageManager.");
  const cli = path.join(checkout, "apps/cli/dist/index.js");
  const commands = {
    complexity: [node, cli, "complexity", `--root=${project}`, "--top=5", "--format=json"],
    initPreview: [node, cli, "init", project, "--offline", "--dry-run", "--format=json"],
    product: [node, cli, "product", `--root=${project}`, "--format=json"],
  };
  const mcpConfig = {
    mcpServers: { untangle: { command: node, args: [cli, "mcp", "--stdio", `--root=${project}`] } },
  };
  const plan = [
    ...(options.skipBuild
      ? []
      : [
          { id: "pnpm-version", command: ["pnpm", "--version"], cwd: checkout },
          { id: "install", command: ["pnpm", "install", "--frozen-lockfile"], cwd: checkout },
          { id: "build", command: ["pnpm", "run", "build"], cwd: checkout },
        ]),
    { id: "analysis", command: commands.complexity, cwd: checkout },
  ];
  const result = {
    schemaVersion: 1,
    status: "planned",
    checkout,
    project,
    node,
    nodeVersion,
    requirements: {
      node: manifest.engines.node,
      pnpm: pnpmVersion,
      platforms: ["darwin", "linux"],
    },
    plan,
    steps: [],
    analysis: null,
    commands,
    mcpConfig,
    notes: [
      "Default setup explicitly installs locked dependencies and builds this checkout. Analysis reads the selected project without an index or services.",
      "No project configuration, feature map, shell profile, MCP host settings, global installation or services are created by this helper.",
      "MCP JSON is a local stdio host template; copy it into a host that supports mcpServers. It is not registered automatically.",
      ...(options.skipBuild
        ? [
            "--skip-build uses existing distribution files; it does not attest that they match edited source files.",
          ]
        : []),
    ],
  };
  const fail = (message) => ({ ...result, status: "failed", error: message });
  if (!supportsSetupNode(nodeVersion))
    return fail(`Unsupported Node.js ${nodeVersion}. Use ${manifest.engines.node}.`);
  if (platform !== "darwin" && platform !== "linux")
    return fail(
      `Checkout setup is verified for Linux and macOS; unsupported platform ${platform}.`,
    );
  if (options.dryRun) return result;
  if (options.skipBuild && !existsSync(cli))
    return fail("No built CLI found. Run pnpm setup:local without --skip-build.");
  const execute = dependencies.execute ?? runEvidenceCommand;
  for (const step of plan) {
    if (dependencies.signal?.aborted) return fail("Setup cancelled.");
    dependencies.onProgress?.(`${step.id}: ${displaySetupCommand(step.command)}`);
    let execution;
    try {
      execution = await execute(step.command, {
        cwd: step.cwd,
        env: dependencies.env ?? process.env,
        signal: dependencies.signal,
        timeoutMs: step.id === "analysis" ? 120_000 : 600_000,
      });
    } catch (error) {
      return fail(`${step.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const captured = {
      ...step,
      exitCode: execution.exitCode,
      stdout: execution.stdout.toString(),
      stderr: execution.stderr.toString(),
      ...(execution.operationalError ? { operationalError: execution.operationalError } : {}),
    };
    result.steps.push(captured);
    if (execution.exitCode !== 0 || execution.operationalError || execution.signal)
      return fail(`${step.id} failed; inspect its exit code and output.`);
    if (step.id === "pnpm-version" && captured.stdout.trim() !== pnpmVersion)
      return fail(
        `Expected pnpm ${pnpmVersion}; got ${captured.stdout.trim()}. Install the declared version and retry.`,
      );
    if (step.id === "analysis") {
      let analysis;
      try {
        analysis = JSON.parse(captured.stdout);
      } catch {
        return fail("The built CLI did not return a JSON complexity report.");
      }
      if (!validAnalysis(analysis, project))
        return fail("The built CLI report is invalid or belongs to another project.");
      result.analysis = analysis;
    }
  }
  if (dependencies.signal?.aborted) return fail("Setup cancelled.");
  result.status = "ready";
  return result;
}

export function renderLocalSetup(result) {
  const lines = [
    result.status === "ready"
      ? `Untangle is ready for ${result.project}.`
      : result.status === "planned"
        ? `Setup plan for ${result.project}; no commands executed.`
        : `Setup failed: ${result.error}`,
  ];
  if (result.status === "failed") {
    const failed = result.steps.at(-1);
    if (failed?.stderr) lines.push(failed.stderr);
    lines.push("Resolve the reported step, then retry pnpm setup:local with the same --project.");
    return lines.join("\n");
  }
  if (result.status === "planned")
    for (const step of result.plan) lines.push(`${step.id}: ${displaySetupCommand(step.command)}`);
  if (result.analysis) {
    const analysis = result.analysis;
    lines.push(
      `Analyzed ${analysis.filesAnalyzed} of ${analysis.filesDiscovered} discovered files. Cognitive complexity (${analysis.totalsReading}): ${analysis.totals.cognitive}.`,
    );
    for (const hotspot of analysis.hotspots)
      lines.push(
        `  ${hotspot.filePath}:${hotspot.line}  ${hotspot.name}  cognitive=${hotspot.cognitive}`,
      );
    lines.push(
      `${analysis.skipped.length} source entries skipped; full coverage and reasons are available with --format=json.`,
    );
    if (analysis.filesAnalyzed === 0)
      lines.push(
        "No analyzable code was measured. Review file types and skipped reasons before interpreting the totals.",
      );
  }
  lines.push(
    "",
    "Preview optional project configuration:",
    displaySetupCommand(result.commands.initPreview),
    "",
    "Inspect declared features:",
    displaySetupCommand(result.commands.product),
    "",
    "MCP configuration (copy into your host):",
    JSON.stringify(result.mcpConfig, null, 2),
    "",
    "Search is optional: configure Qdrant and an embedding service separately before indexing. Lexical/symbol search can use --embedder=offline with Qdrant; offline vectors carry no language semantics.",
  );
  return lines.join("\n");
}

async function main(args) {
  let options;
  try {
    options = parseSetupOptions(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(
      "Untangle checkout setup\n\nUsage: pnpm setup:local [--project=PATH] [--dry-run] [--skip-build] [--format=text|json]\n\nDefault: explicitly install locked checkout dependencies, build all packages, then analyze the selected project locally.\n--project: existing target directory; default is this Untangle checkout.\n--dry-run: show the plan without running commands or creating files.\n--skip-build: do not install or build; use an existing CLI distribution.\nNo services, tests, global installs or host configuration writes. Requires the Node/pnpm versions in package.json.\n",
    );
    return 0;
  }
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Setup interrupted."));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const result = await runLocalSetup(options, {
      signal: controller.signal,
      onProgress: (line) => process.stderr.write(`Setup ${line}\n`),
    });
    process.stdout.write(
      (options.format === "json" ? JSON.stringify(result, null, 2) : renderLocalSetup(result)) +
        "\n",
    );
    return controller.signal.aborted ? 130 : result.status === "failed" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
