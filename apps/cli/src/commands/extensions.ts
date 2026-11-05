/**
 * `untangle extensions` — the analyzer-extension surface (WP-127).
 *
 * ## What this command group is, and what it deliberately is not
 *
 * Untangle ships the extension RUNTIME, the manifest schema and a small set
 * of output-format parsers. It ships NO tool definitions. There is no list of
 * known analyzers in this file, no branch that recognizes a vendor, no
 * bundled manifest — Untangle understands output FORMATS (`sarif`,
 * `junit-xml`, `generic-findings`, `generic-metrics`), and every
 * tool-specific detail arrives as user data inside a manifest
 * (extensions.md §17 "X9"; E2: no third-party product name in this source
 * tree).
 *
 * That is not tidiness. It is what makes "optional" mean optional: if tool
 * definitions shipped with the product, they would be part of the product
 * even while switched off, and the license boundary that keeps AGPL code and
 * source-available analyzers apart would run through this repository instead
 * of around it.
 *
 * ## The security boundary you will notice first
 *
 * A manifest in the PROJECT directory is never loaded automatically. Only the
 * user profile is searched (`~/.untangle/extensions/<id>/manifest.toml` and
 * the OS data directory). A manifest is a description of how to start a
 * program; if the working directory were a search path, `git clone` of a
 * stranger's repository would be enough to place a program invocation in
 * front of the runtime. `add --from <path inside a project>` therefore
 * refuses unless the user types `--allow-project-local` in that very command.
 */
import type { FlagSpecs, ParsedArgs } from "../cli/args.js";
import { enumFlag } from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { EXIT, UsageError } from "../cli/exit.js";

import { runAdd } from "./extensions/add.js";
import { runConfigure } from "./extensions/configure.js";
import { runDisable, runEnable } from "./extensions/enable.js";
import { createExtensionEnvironment } from "./extensions/environment.js";
import { runList } from "./extensions/list.js";
import { runLogs } from "./extensions/logs.js";
import { runRemove } from "./extensions/remove.js";
import { runRun } from "./extensions/run.js";
import { runStatus } from "./extensions/status.js";

const FLAGS: FlagSpecs = {
  from: {
    kind: "string",
    placeholder: "URL|PATH",
    describe: "add: manifest source. configure: private JSON file containing secret values.",
  },
  digest: {
    kind: "string",
    placeholder: "sha256:HEX",
    describe: "add: expected manifest sha256. Required for a URL.",
  },
  "allow-project-local": {
    kind: "boolean",
    describe: "add: explicitly allow a path inside the project directory.",
  },
  force: {
    kind: "boolean",
    describe: "add: replace an installed extension with the same ID.",
  },
  "acknowledge-license": {
    kind: "boolean",
    describe: "add/enable: acknowledge the tool-license gate, not the ruleset gate.",
  },
  "acknowledge-ruleset": {
    kind: "list",
    placeholder: "ID",
    describe: "add/enable: acknowledge exactly one ruleset. Repeatable.",
  },
  "revoke-license": {
    kind: "boolean",
    describe: "disable/remove: revoke the stored license acknowledgment.",
  },
  category: {
    kind: "string",
    placeholder: "C,...",
    describe: "list: show only extensions in these categories.",
  },
  "enabled-only": {
    kind: "boolean",
    describe: "list: show only enabled extensions.",
  },
  yes: {
    kind: "boolean",
    describe: "run/setup: allow container provisioning and missing-credential setup (X1).",
  },
  tail: {
    kind: "number",
    placeholder: "N",
    describe: "logs: number of trailing lines.",
    defaultLabel: "200",
  },
  "remove-container": {
    kind: "boolean",
    describe: "disable: stop and remove only the owned container, verified by its labels.",
  },
  "remove-volumes": {
    kind: "boolean",
    describe: "disable: also remove named volumes. Destructive.",
  },
  workspace: {
    kind: "string",
    placeholder: "PATH",
    describe: "run: root of the analyzed workspace.",
    defaultLabel: "current directory",
  },
  target: {
    kind: "string",
    placeholder: "PATH",
    describe: "run: analysis target inside the workspace.",
    defaultLabel: "the workspace",
  },
  ruleset: {
    kind: "string",
    placeholder: "NAME",
    describe: "run: effective ruleset; otherwise the manifest's defaultRuleset applies.",
  },
  url: {
    kind: "string",
    placeholder: "URL",
    describe: "run: endpoint for invocation kind `http`.",
  },
  timeout: {
    kind: "number",
    placeholder: "MS",
    describe: "run: execution time budget in milliseconds.",
    defaultLabel: "900000",
  },
  "max-output-bytes": {
    kind: "number",
    placeholder: "N",
    describe: "run: maximum collected tool-output bytes.",
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Output format.",
    defaultLabel: "text",
  },
};

/**
 * Which flags each subcommand accepts.
 *
 * The parser validates flags against the union above; this table catches the
 * rest. Without it, `untangle extensions list --from=x` would be silently
 * accepted and silently ignored — precisely the kind of quiet skip E4
 * forbids, one layer above the pipeline.
 */
const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  add: [
    "from",
    "digest",
    "allow-project-local",
    "force",
    "acknowledge-license",
    "acknowledge-ruleset",
    "format",
  ],
  list: ["category", "enabled-only", "format"],
  status: ["format"],
  configure: ["from", "format"],
  setup: ["workspace", "url", "timeout", "max-output-bytes", "yes", "format"],
  logs: ["tail", "format"],
  enable: ["acknowledge-license", "acknowledge-ruleset", "format"],
  disable: ["revoke-license", "remove-container", "remove-volumes", "format"],
  remove: ["revoke-license", "format"],
  run: ["workspace", "target", "ruleset", "url", "timeout", "max-output-bytes", "yes", "format"],
};

const SUBCOMMANDS = Object.keys(ALLOWED_FLAGS);

export const extensionsCommand: Command = {
  spec: {
    name: "extensions",
    implementedBy: "commands/extensions.js",
    summary: "Manage and run analyzer extensions",
    usage:
      "untangle extensions <add|list|status|configure|setup|enable|disable|remove|run|logs> [options]",
    details: [
      "Untangle supplies the extension runtime, manifest schema and format parsers, without bundled tool definitions. A manifest is an external artifact you explicitly load (extensions.md §17, X9). The runtime understands formats (sarif, junit-xml, generic-findings, generic-metrics), not individual tools.",
      "Trust boundary: manifests in the project directory are never loaded automatically. Discovery searches only the user profile (~/.untangle/extensions/<id>/manifest.toml and the OS data directory). A manifest specifies how to launch a program; trusting a cloned project's manifest automatically would allow unrequested execution. `add --from` therefore rejects project-local paths unless --allow-project-local is explicit.",
      "Likewise, `add --from <https-URL>` requires --digest: changing content behind a stable URL could silently change findings. X6 forbids mutable container tags for the same reason.",
      "Installing a manifest starts nothing. `enable` records activation without launching processes or containers (X1). Restrictively licensed tools require explicit personal acknowledgment (X5).",
      "`status` previews the effective pinned image digest, running digest and comparison, license and ruleset gates, endpoint and last run. It neither starts containers nor pulls images (X1); an open gate also prevents version probes (X5).",
      "setup --yes provisions the service, configures missing credentials through the manifest's declared setup process and verifies them with an analysis run. configure creates private secret configuration or imports values with --from. Environment variables take precedence; status creates no tokens.",
      "External tool findings are `ExternalFindingV1`: evidence, never Untangle metrics. They never contribute to complexity values or Risk Score (X3), and never change the exit code.",
    ],
    flags: FLAGS,
    examples: [
      "untangle extensions add --from=./my-analyzer/manifest.toml",
      "untangle extensions add --from=https://example.invalid/manifest.toml --digest=sha256:<64 hex>",
      "untangle extensions list --format=json",
      "untangle extensions status my-analyzer",
      "untangle extensions configure my-analyzer",
      "untangle extensions setup my-analyzer --yes",
      "untangle extensions enable my-analyzer --acknowledge-license",
      "untangle extensions run my-analyzer --target=src --format=json",
      "untangle extensions remove my-analyzer --revoke-license",
    ],
    exitCodes: [
      [EXIT.ok, "The command completed. Findings do not change this code (X3)."],
      [EXIT.operational, "Invalid manifest, missing extension or failed run."],
      [EXIT.usage, "Usage error: unknown subcommand, missing or unsupported option."],
      [
        EXIT.environment,
        "License/ruleset gate is open, or a required secret is missing. Nothing was started.",
      ],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    const subcommand = args.positionals[0];
    if (subcommand === undefined) {
      throw new UsageError(
        "`untangle extensions` needs a subcommand.",
        `Choose one of: ${SUBCOMMANDS.join(", ")} — see untangle extensions --help.`,
      );
    }
    const allowed = ALLOWED_FLAGS[subcommand];
    if (allowed === undefined) {
      throw new UsageError(
        `Unknown subcommand "extensions ${subcommand}".`,
        `Choose one of: ${SUBCOMMANDS.join(", ")}.`,
      );
    }
    rejectForeignFlags(subcommand, args, allowed);

    const format = enumFlag(args, "format", ["text", "json"] as const, "text");
    const environment = await createExtensionEnvironment({ cwd: ctx.cwd, env: ctx.env });

    switch (subcommand) {
      case "add":
        return await runAdd(environment, args, ctx.io, format);
      case "list":
        return await runList(environment, args, ctx.io, format);
      case "status":
        return await runStatus(environment, args, ctx.io, format);
      case "logs":
        return await runLogs(environment, args, ctx.io, format);
      case "enable":
        return await runEnable(environment, args, ctx.io, format);
      case "disable":
        return await runDisable(environment, args, ctx.io, format);
      case "remove":
        return await runRemove(environment, args, ctx.io, format);
      case "configure":
        return await runConfigure(environment, args, ctx.io, format);
      case "setup":
      case "run":
        return await runRun(environment, args, ctx.io, format, { signal: ctx.signal });
      default:
        throw new UsageError(
          `Unknown subcommand "extensions ${subcommand}".`,
          `Choose one of: ${SUBCOMMANDS.join(", ")}.`,
        );
    }
  },
};

function rejectForeignFlags(
  subcommand: string,
  args: ParsedArgs,
  allowed: readonly string[],
): void {
  const foreign = Object.keys(args.flags)
    .filter((name) => !allowed.includes(name))
    .sort();
  if (foreign.length === 0) {
    return;
  }
  throw new UsageError(
    `"extensions ${subcommand}" does not accept ${foreign.map((name) => `--${name}`).join(", ")}.`,
    `Accepted here: ${allowed.map((name) => `--${name}`).join(", ")}.`,
  );
}
