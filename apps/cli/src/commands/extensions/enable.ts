/**
 * `untangle extensions enable <id>` / `disable <id>`
 *
 * These exist because the runtime's license gate prints them. When a gate is
 * unacknowledged the runtime hands back the exact command that would grant
 * the acknowledgment (extensions.md §9.5), and a printed command that does
 * not exist is worse than no hint at all.
 *
 * `enable` records the opt-in and, with the acknowledgment flags, the
 * personal license declaration. It starts nothing: no process, no pull, no
 * container (X1). `disable` reverses the opt-in and, with `--revoke-license`,
 * the declaration (§9.3).
 *
 * The tool gate and the ruleset gate are separate. `--acknowledge-license`
 * covers the tool ONLY; a restricted ruleset still needs its own
 * `--acknowledge-ruleset=<id>`, which is repeatable.
 */
import {
  buildAcknowledgment,
  createNodeProcessRunner,
  defaultProcessLimits,
} from "@untangle-code/extension-runtime";

import { boolFlag, listFlag, type ParsedArgs } from "../../cli/args.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { line, note, type Io } from "../../cli/io.js";

import { createContainerCli } from "./container.js";
import { explainMissing, findExtension, gateFor, loadExtensionContext } from "./context.js";
import type { ExtensionEnvironmentV1 } from "./environment.js";
import { composeFilePath } from "./provision.js";
import { emitJson } from "./render.js";
import {
  revokeAcknowledgments,
  saveAcknowledgments,
  saveCliState,
  upsertAcknowledgment,
} from "./state.js";

export async function runEnable(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
): Promise<number> {
  const extensionId = args.positionals[1];
  if (extensionId === undefined) {
    throw new UsageError(
      "`untangle extensions enable` needs an extension id.",
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

  let acknowledgments = context.acknowledgments;
  const acknowledgedNow: string[] = [];
  if (boolFlag(args, "acknowledge-license")) {
    acknowledgments = upsertAcknowledgment(
      acknowledgments,
      buildAcknowledgment({
        manifest: extension.manifest,
        acknowledgedAt: environment.clock.nowIso(),
        acknowledgedBy: environment.userName,
      }),
    );
    acknowledgedNow.push(`tool:${extensionId}`);
  }
  for (const ruleset of listFlag(args, "acknowledge-ruleset")) {
    acknowledgments = upsertAcknowledgment(
      acknowledgments,
      buildAcknowledgment({
        manifest: extension.manifest,
        ruleset,
        acknowledgedAt: environment.clock.nowIso(),
        acknowledgedBy: environment.userName,
      }),
    );
    acknowledgedNow.push(`ruleset:${ruleset}`);
  }
  let acknowledgmentFile: string | undefined;
  if (acknowledgedNow.length > 0) {
    acknowledgmentFile = await saveAcknowledgments(
      environment.fs,
      environment.userDataDir,
      acknowledgments,
    );
  }

  const enabled = context.state.enabled.includes(extensionId)
    ? context.state.enabled
    : [...context.state.enabled, extensionId];
  const statePath = await saveCliState(environment.fs, environment.userDataDir, {
    ...context.state,
    enabled,
  });

  const gate = gateFor({ ...context, acknowledgments }, extension);

  if (format === "json") {
    emitJson(io, {
      command: "extensions enable",
      extensionId,
      enabled: true,
      started: false,
      stateFile: statePath,
      acknowledgedNow,
      acknowledgmentFile,
      licenseGate: {
        allowed: gate.allowed,
        tool: { status: gate.tool.status, reason: gate.tool.reason },
        rulesets: gate.rulesets.map((entry) => ({
          ruleset: entry.ruleset,
          status: entry.status,
          reason: entry.reason,
        })),
        acknowledgeCommands: gate.acknowledgeCommands,
      },
    });
  } else {
    line(io, `enabled "${extensionId}" — nothing was started (X1).`);
    line(io, `  state       ${statePath}`);
    line(io, `  license     ${gate.tool.status} — ${gate.tool.reason}`);
    for (const entry of gate.rulesets) {
      line(io, `  ruleset     ${entry.ruleset}: ${entry.status} — ${entry.reason}`);
    }
  }

  if (!gate.allowed) {
    note(io, "The license gate is still open; run:");
    for (const command of gate.acknowledgeCommands) {
      note(io, `  ${command}`);
    }
    return EXIT.environment;
  }
  return EXIT.ok;
}

export async function runDisable(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
): Promise<number> {
  const extensionId = args.positionals[1];
  if (extensionId === undefined) {
    throw new UsageError(
      "`untangle extensions disable` needs an extension id.",
      "Run `untangle extensions list` to see the installed ids.",
    );
  }
  // Die Flag-Pruefung steht VOR jeder Zustandsaenderung. Zuvor lag sie danach:
  // ein Aufruf, den die CLI im selben Atemzug als Aufruffehler zurueckwies,
  // hatte die Extension bereits deaktiviert. Ein abgelehnter Befehl darf nichts
  // getan haben.
  const removeContainer = boolFlag(args, "remove-container");
  const removeVolumes = boolFlag(args, "remove-volumes");
  if (removeVolumes && !removeContainer) {
    throw new UsageError(
      "--remove-volumes only applies together with --remove-container.",
      `Run untangle extensions disable ${extensionId} --remove-container --remove-volumes`,
    );
  }

  const context = await loadExtensionContext(environment);
  const statePath = await saveCliState(environment.fs, environment.userDataDir, {
    ...context.state,
    enabled: context.state.enabled.filter((id) => id !== extensionId),
  });
  // `--remove-container` fasst NUR den eigenen Container an; die Besitzprobe
  // liegt im Adapter und laesst einen fremden gleichen Namens unberuehrt.
  // Volumes bleiben ohne die zweite, ausdrueckliche Anweisung erhalten: ein
  // geloeschtes Volume ist die einzige hier moegliche Handlung, die Arbeit
  // vernichtet, die niemand wiederherstellen kann.
  let containerDetail: string | undefined;
  if (removeContainer) {
    const installed = findExtension(context, extensionId);
    const manifest = installed?.manifest;
    if (manifest?.container === undefined) {
      containerDetail = `"${extensionId}" declares no container; nothing to remove`;
    } else {
      const containerCli = createContainerCli({
        processRunner: createNodeProcessRunner(environment.clock),
        limits: { ...defaultProcessLimits(), timeoutMs: 120_000 },
        ...(environment.env["UNTANGLE_CONTAINER_CLI"] === undefined
          ? {}
          : { command: environment.env["UNTANGLE_CONTAINER_CLI"] }),
      });
      const down = await containerCli.down({
        manifest,
        composeFilePath: composeFilePath(environment.userDataDir, manifest.id),
        removeVolumes,
      });
      containerDetail = down.detail;
    }
  }

  let acknowledgmentFile: string | undefined;
  const revoked = boolFlag(args, "revoke-license");
  if (revoked) {
    acknowledgmentFile = await saveAcknowledgments(
      environment.fs,
      environment.userDataDir,
      revokeAcknowledgments(context.acknowledgments, extensionId, environment.clock.nowIso()),
    );
  }

  if (format === "json") {
    emitJson(io, {
      command: "extensions disable",
      extensionId,
      enabled: false,
      stateFile: statePath,
      licenseAcknowledgment: revoked ? "revoked" : "kept",
      acknowledgmentFile,
      ...(containerDetail === undefined ? {} : { container: containerDetail }),
    });
  } else {
    line(io, `disabled "${extensionId}".`);
    line(
      io,
      revoked
        ? `  license     acknowledgment revoked in ${String(acknowledgmentFile)}`
        : "  license     acknowledgment kept (use --revoke-license to drop it)",
    );
    if (containerDetail !== undefined) {
      line(io, `  container   ${containerDetail}`);
    }
  }
  return EXIT.ok;
}
