/** User-private credential configuration; values never appear in output or argv. */
import { readFile } from "node:fs/promises";

import { stringFlag, type ParsedArgs } from "../../cli/args.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { line, type Io } from "../../cli/io.js";

import { explainMissing, findExtension, loadExtensionContext } from "./context.js";
import { resolveUserPath, type ExtensionEnvironmentV1 } from "./environment.js";
import { emitJson } from "./render.js";
import {
  parseSecretValues,
  readStoredSecrets,
  secretStorePath,
  withSecretLock,
  writeStoredSecrets,
} from "./secret-store.js";

export async function runConfigure(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
): Promise<number> {
  const id = args.positionals[1];
  if (!id || args.positionals.length !== 2)
    throw new UsageError(
      "configure needs exactly one extension id.",
      "untangle extensions configure <id> [--from=<private-json-file>]",
    );
  const context = await loadExtensionContext(environment);
  const extension = findExtension(context, id);
  if (!extension)
    throw new OperationalError(explainMissing(context, id), "Install the extension first.");
  const manifest = extension.manifest;
  const source = stringFlag(args, "from");
  let imported: Record<string, string> = {};
  if (source !== undefined) {
    let content: unknown;
    try {
      content = JSON.parse(await readFile(resolveUserPath(environment.cwd, source), "utf8"));
    } catch {
      throw new UsageError(
        "Cannot read credential JSON; its contents were withheld.",
        "Use a JSON object keyed by the secret names declared in the manifest.",
      );
    }
    imported = parseSecretValues(content, manifest);
  }
  const values = await withSecretLock(environment, id, async () => {
    const stored = await readStoredSecrets(environment, manifest);
    const values = {
      ...Object.fromEntries(manifest.secrets.map((secret) => [secret.name, ""])),
      ...stored,
      ...imported,
    };
    await writeStoredSecrets(environment, manifest, values);
    return values;
  });
  const path = secretStorePath(environment, id);
  const secrets = manifest.secrets.map((secret) => ({
    name: secret.name,
    envVar: secret.envVar,
    configured: Boolean(values[secret.name]),
    setupOnly: secret.setupOnly ?? false,
  }));
  if (format === "json")
    emitJson(io, { command: "extensions configure", extensionId: id, path, secrets });
  else {
    line(io, `Private credential configuration (0600): ${path}`);
    for (const secret of secrets)
      line(
        io,
        `  ${secret.name}: ${secret.configured ? "configured" : "not set"}; environment override: ${secret.envVar}${secret.setupOnly ? " (setup only)" : ""}`,
      );
    line(
      io,
      `Edit the secrets object in that file, then run: untangle extensions setup ${id} --yes`,
    );
  }
  return EXIT.ok;
}
