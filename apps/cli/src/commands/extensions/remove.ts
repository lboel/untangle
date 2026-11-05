/**
 * `untangle extensions remove <id>`
 *
 * Deletes one installed extension directory from the user's extension root.
 *
 * Two guards. The directory must lie inside a resolved extension root — the
 * command deletes recursively, and a recursive delete driven by an id from
 * the command line has to prove where it is pointing. And it must not lie
 * inside a project directory, which would mean the boundary was crossed
 * earlier and deleting is not the right repair.
 *
 * The license acknowledgment is kept by default. It is a personal declaration
 * about a tool's terms, not a property of the installed file, and
 * re-installing the same tool should not quietly need a fresh one. Dropping
 * it is `--revoke-license`, what extensions.md §9.3 calls revocation.
 */
import { dirname } from "node:path";

import { boolFlag, type ParsedArgs } from "../../cli/args.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { line, note, type Io } from "../../cli/io.js";

import { explainMissing, findExtension, loadExtensionContext } from "./context.js";
import { isInsideAnyRoot, type ExtensionEnvironmentV1 } from "./environment.js";
import { emitJson } from "./render.js";
import { removeAcknowledgments, saveAcknowledgments, saveCliState } from "./state.js";

export async function runRemove(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
): Promise<number> {
  const extensionId = args.positionals[1];
  if (extensionId === undefined) {
    throw new UsageError(
      "`untangle extensions remove` needs an extension id.",
      "Run `untangle extensions list` to see the installed ids.",
    );
  }

  const context = await loadExtensionContext(environment);
  const extension = findExtension(context, extensionId);
  if (extension === null) {
    throw new OperationalError(
      explainMissing(context, extensionId),
      "Run `untangle extensions list` to see what is installed and why something was rejected.",
    );
  }

  const directory = dirname(extension.manifestPath);
  if (!isInsideAnyRoot(directory, environment.roots)) {
    throw new OperationalError(
      `Refusing to delete "${directory}": it is not inside a resolved extension root ` +
        `(${environment.roots.join(", ")}).`,
      "Delete the directory yourself if that is really what you want.",
    );
  }
  if (isInsideAnyRoot(directory, environment.projectRoots)) {
    throw new OperationalError(
      `Refusing to delete "${directory}": it lies inside a project directory.`,
      "Extensions are user-profile artifacts; remove this one with your own tools.",
    );
  }

  await environment.fs.remove(directory, { recursive: true });

  const statePath = await saveCliState(environment.fs, environment.userDataDir, {
    ...context.state,
    enabled: context.state.enabled.filter((id) => id !== extensionId),
    lastRuns: Object.fromEntries(
      Object.entries(context.state.lastRuns).filter(([id]) => id !== extensionId),
    ),
  });

  let acknowledgmentFile: string | undefined;
  const revoked = boolFlag(args, "revoke-license");
  if (revoked) {
    acknowledgmentFile = await saveAcknowledgments(
      environment.fs,
      environment.userDataDir,
      removeAcknowledgments(context.acknowledgments, extensionId),
    );
  }

  if (format === "json") {
    emitJson(io, {
      command: "extensions remove",
      extensionId,
      removedDirectory: directory,
      stateFile: statePath,
      licenseAcknowledgment: revoked ? "revoked" : "kept",
      acknowledgmentFile,
      warnings: context.warnings,
    });
  } else {
    line(io, `removed "${extensionId}"`);
    line(io, `  directory   ${directory}`);
    line(
      io,
      revoked
        ? `  license     acknowledgment revoked in ${String(acknowledgmentFile)}`
        : "  license     acknowledgment kept (use --revoke-license to drop it)",
    );
  }
  for (const warning of context.warnings) {
    note(io, `warning: ${warning}`);
  }
  return EXIT.ok;
}
