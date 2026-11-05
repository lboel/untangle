/**
 * `untangle extensions logs <id>`
 *
 * Liest ausschliesslich die Logs des EIGENEN Containers (extensions.md §11.1).
 * Die Besitzprobe liegt im Container-Adapter: ohne beide Labels wird nichts
 * gelesen, auch wenn ein Container des erwarteten Namens existiert. Der Name
 * `untangle-ext-<id>` ist vorhersagbar, und niemand hindert einen fremden
 * Container daran, so zu heissen.
 */
import {
  defaultProcessLimits,
  createNodeProcessRunner,
  redactSecrets,
} from "@untangle-code/extension-runtime";

import { integerFlag, type ParsedArgs } from "../../cli/args.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { line, type Io } from "../../cli/io.js";

import { createContainerCli } from "./container.js";
import { explainMissing, findExtension, loadExtensionContext } from "./context.js";
import type { ExtensionEnvironmentV1 } from "./environment.js";
import { composeFilePath } from "./provision.js";
import { emitJson } from "./render.js";
import { readStoredSecrets } from "./secret-store.js";

export async function runLogs(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
): Promise<number> {
  const extensionId = args.positionals[1];
  if (extensionId === undefined) {
    throw new UsageError(
      "`untangle extensions logs` needs an extension id.",
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
  if (manifest.container === undefined) {
    throw new OperationalError(
      `"${extensionId}" declares no container; there are no container logs to read.`,
      "Logs exist only for extensions Untangle provisions as a container.",
    );
  }

  const tail = integerFlag(args, "tail", 200);
  if (tail <= 0) {
    throw new UsageError("--tail expects a positive number of lines.", "Example: --tail=200");
  }

  // Include bootstrap credentials and stored values even when an environment
  // override is active: old credentials can still occur in retained logs.
  const stored = await readStoredSecrets(environment, manifest);
  const secrets = manifest.secrets.flatMap((secret) =>
    [stored[secret.name], environment.env[secret.envVar]].filter((value): value is string =>
      Boolean(value),
    ),
  );
  const containerCli = createContainerCli({
    processRunner: createNodeProcessRunner(environment.clock),
    limits: { ...defaultProcessLimits(), timeoutMs: 60_000 },
    ...(environment.env["UNTANGLE_CONTAINER_CLI"] === undefined
      ? {}
      : { command: environment.env["UNTANGLE_CONTAINER_CLI"] }),
  });
  const result = await containerCli.logs({
    manifest,
    composeFilePath: composeFilePath(environment.userDataDir, manifest.id),
    tail,
  });
  result.detail = redactSecrets(result.detail, secrets);
  result.text = redactSecrets(result.text, secrets);

  if (format === "json") {
    emitJson(io, {
      command: "extensions logs",
      extensionId,
      ok: result.ok,
      detail: result.detail,
      lines: result.text === "" ? [] : result.text.split("\n"),
    });
  } else {
    if (!result.ok) {
      throw new OperationalError(
        `No logs were read for "${extensionId}": ${result.detail}`,
        `Check the container with untangle extensions status ${extensionId}`,
      );
    }
    for (const entry of result.text.split("\n")) {
      line(io, entry);
    }
  }
  return result.ok ? EXIT.ok : EXIT.operational;
}
