/**
 * `untangle extensions add --from <url|path>`
 *
 * Installs ONE manifest into the user's extension root
 * (`~/.untangle/extensions/<id>/manifest.toml`). Four gates stand between the
 * argument and the file on disk, and none of them is optional:
 *
 * 1. **Transport.** A URL must be https and must carry `--digest`
 *    (`source.ts` explains why).
 * 2. **Project boundary.** A path inside a project directory is refused
 *    unless the user types `--allow-project-local` in the same invocation.
 *    Automatic loading from a project directory does not exist at all: a
 *    cloned repository must not be able to hand a tool definition to the
 *    runtime (extensions.md §17).
 * 3. **Manifest validity.** Structure and semantics both, X6 included: a
 *    container manifest without a fully pinned sha256 digest is rejected.
 * 4. **License gate (X5).** Installing never acknowledges anything. A
 *    restricted tool is installed in state `unacknowledged`, and the exact
 *    command that would grant the acknowledgment is printed.
 *
 * `add` starts nothing — no process, no pull, no container (X1).
 */
import { join } from "node:path";

import {
  MANIFEST_FILE_NAME,
  buildAcknowledgment,
  extensionDirectory,
  extensionManifestPath,
  isProjectLocalManifest,
  loadExtensionManifestFile,
  parseExtensionManifest,
} from "@untangle-code/extension-runtime";

import { boolFlag, listFlag, stringFlag, type ParsedArgs } from "../../cli/args.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { line, note, type Io } from "../../cli/io.js";

import { gateFor, loadExtensionContext } from "./context.js";
import { canonicalize, resolveUserPath, type ExtensionEnvironmentV1 } from "./environment.js";
import { emitJson } from "./render.js";
import {
  DIGEST_PATTERN,
  ManifestSourceError,
  fetchManifestFromUrl,
  isUrlSource,
  readManifestFromPath,
  type FetchManifestOptions,
  type ManifestSourceV1,
} from "./source.js";
import { saveAcknowledgments, upsertAcknowledgment } from "./state.js";

export interface AddDeps {
  /** Injected in tests so no unit test opens a socket. */
  fetchOptions?: FetchManifestOptions;
}

export async function runAdd(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
  deps: AddDeps = {},
): Promise<number> {
  const from = stringFlag(args, "from");
  if (from === undefined) {
    throw new UsageError(
      "`untangle extensions add` needs a source.",
      "Write --from=<path to a manifest.toml> or --from=<https URL> --digest=sha256:<64 hex>.",
    );
  }
  const expectedDigest = stringFlag(args, "digest");
  if (expectedDigest !== undefined && !DIGEST_PATTERN.test(expectedDigest)) {
    throw new UsageError(
      `--digest must look like "sha256:<64 lowercase hex>", got "${expectedDigest}".`,
      "Compute it with: shasum -a 256 manifest.toml",
    );
  }

  const source = await readSource(environment, from, expectedDigest, args, deps);

  if (expectedDigest !== undefined && source.digest !== expectedDigest) {
    throw new OperationalError(
      `Digest mismatch for ${source.resolved}: expected ${expectedDigest}, got ${source.digest}. ` +
        "Nothing was installed.",
      "Verify the digest with the publisher before installing this manifest.",
    );
  }

  // --- manifest validity (structure + semantics, X6 included) -------------
  const parsed = parseExtensionManifest(source.text);
  if (parsed.manifest === null) {
    note(io, `The manifest at ${source.resolved} is not valid; nothing was installed:`);
    for (const issue of parsed.issues) {
      note(io, `  ${issue.field}: ${issue.message}`);
    }
    throw new OperationalError(
      `${String(parsed.issues.length)} problem(s) in the manifest at ${source.resolved}.`,
      "Fix the fields listed above; the manifest schema is documented in extensions.md §5.2.",
    );
  }
  const manifest = parsed.manifest;

  // --- write --------------------------------------------------------------
  const root = environment.roots[0];
  if (root === undefined) {
    throw new OperationalError(
      "No extension root could be resolved for this user profile.",
      "Set UNTANGLE_EXTENSIONS_HOME to a writable directory outside any project.",
    );
  }
  const targetDirectory = extensionDirectory(root, manifest.id);
  const targetPath = extensionManifestPath(root, manifest.id);
  const existing = await environment.fs.stat(targetPath);
  if (existing !== null && !boolFlag(args, "force")) {
    throw new OperationalError(
      `"${manifest.id}" is already installed at ${targetPath}.`,
      `Repeat with --force to replace it, or remove it first: untangle extensions remove ${manifest.id}`,
    );
  }

  await environment.fs.mkdir(targetDirectory, { recursive: true });
  const temporary = join(targetDirectory, `${MANIFEST_FILE_NAME}.tmp`);
  await environment.fs.writeFile(temporary, source.bytes);
  await environment.fs.rename(temporary, targetPath);

  // Re-read through the loader, so what is reported is what the runtime will
  // see — not what this command believed it wrote.
  const loaded = await loadExtensionManifestFile(environment.fs, targetPath, "user-data-dir", {
    expectedId: manifest.id,
  });
  if (loaded.extension === null) {
    for (const issue of loaded.issues) {
      note(io, `  ${issue.field}: ${issue.message}`);
    }
    throw new OperationalError(
      `The installed manifest at ${targetPath} does not load back.`,
      "Remove the directory and install the manifest again.",
    );
  }
  const installed = loaded.extension;

  // --- license gate (X5) --------------------------------------------------
  const context = await loadExtensionContext(environment);
  let acknowledgments = context.acknowledgments;
  const acknowledgedNow: string[] = [];
  if (boolFlag(args, "acknowledge-license")) {
    acknowledgments = upsertAcknowledgment(
      acknowledgments,
      buildAcknowledgment({
        manifest,
        acknowledgedAt: environment.clock.nowIso(),
        acknowledgedBy: environment.userName,
      }),
    );
    acknowledgedNow.push(`tool:${manifest.id}`);
  }
  for (const ruleset of listFlag(args, "acknowledge-ruleset")) {
    acknowledgments = upsertAcknowledgment(
      acknowledgments,
      buildAcknowledgment({
        manifest,
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

  const gate = gateFor({ ...context, acknowledgments }, installed);

  if (format === "json") {
    emitJson(io, {
      command: "extensions add",
      extensionId: manifest.id,
      displayName: manifest.displayName,
      category: manifest.category,
      invocation: manifest.invocation,
      outputFormat: manifest.outputFormat,
      source: { kind: source.kind, requested: source.requested, resolved: source.resolved },
      manifestDigest: source.digest,
      manifestSha256: installed.manifestSha256,
      installedTo: targetPath,
      replacedExisting: existing !== null,
      containerDigest: manifest.container?.digest,
      license: {
        spdxId: manifest.license.spdxId,
        usageRestriction: manifest.license.usageRestriction,
        requiresAcknowledgment: manifest.requiresLicenseAcknowledgment,
        gateStatus: gate.tool.status,
        gateReason: gate.tool.reason,
        rulesets: gate.rulesets.map((entry) => ({
          ruleset: entry.ruleset,
          status: entry.status,
          reason: entry.reason,
        })),
        acknowledgedNow,
        acknowledgmentFile,
      },
      networkAccess: manifest.networkAccess,
      telemetry: manifest.telemetry,
      enabled: false,
      started: false,
      nextSteps: gate.allowed
        ? [`untangle extensions enable ${manifest.id}`]
        : gate.acknowledgeCommands,
      warnings: context.warnings,
    });
  } else {
    line(io, `installed "${manifest.id}" (${manifest.displayName})`);
    line(io, `  from        ${source.resolved}`);
    line(io, `  manifest    ${targetPath}`);
    line(io, `  digest      ${source.digest}`);
    if (manifest.container !== undefined) {
      line(io, `  image       ${manifest.container.image}@${manifest.container.digest}`);
    }
    line(io, `  invocation  ${manifest.invocation.join(", ")}`);
    line(io, `  format      ${manifest.outputFormat}`);
    line(
      io,
      `  license     ${manifest.license.spdxId} (${manifest.license.usageRestriction}) — gate: ${gate.tool.status}`,
    );
    for (const entry of gate.rulesets) {
      line(io, `  ruleset     ${entry.ruleset} — gate: ${entry.status}`);
    }
    line(io, `  network     ${manifest.networkAccess}`);
    line(
      io,
      "  enabled     no — installing starts nothing (X1); enable it with " +
        `untangle extensions enable ${manifest.id}`,
    );
  }

  for (const warning of context.warnings) {
    note(io, `warning: ${warning}`);
  }
  if (!gate.allowed) {
    note(io, `The license gate is not satisfied: ${gate.tool.reason}`);
    note(io, "Nothing will run until you acknowledge it:");
    for (const command of gate.acknowledgeCommands) {
      note(io, `  ${command}`);
    }
  }

  // Installing succeeded even when the gate is still open: the manifest is on
  // disk and `list` will show it. The gate is enforced where it matters — at
  // `run` — so a successful install is not reported as a failure.
  return EXIT.ok;
}

async function readSource(
  environment: ExtensionEnvironmentV1,
  from: string,
  expectedDigest: string | undefined,
  args: ParsedArgs,
  deps: AddDeps,
): Promise<ManifestSourceV1> {
  if (isUrlSource(from)) {
    if (expectedDigest === undefined) {
      throw new UsageError(
        `Refusing to install from a URL without --digest. "${from}" is not a fixed artifact: ` +
          "whatever the server returns today would become a program invocation on this machine.",
        "Ask the publisher for the sha256 of the manifest and pass --digest=sha256:<64 hex>, " +
          "or download the file and use --from=<path>.",
      );
    }
    try {
      return await fetchManifestFromUrl(from, deps.fetchOptions ?? {});
    } catch (cause) {
      throw new OperationalError(
        cause instanceof ManifestSourceError ? cause.message : String(cause),
        "Check the URL, or download the manifest and install the local copy with --from=<path>.",
        { cause },
      );
    }
  }

  // The boundary check compares lexically and does not resolve symlinks — the
  // runtime says so explicitly. Canonicalizing here is what makes the check
  // sound: without it a symlink (or, on macOS, the /var alias alone) would
  // carry a path out of the project it really lives in.
  const path = await canonicalize(environment.fs, resolveUserPath(environment.cwd, from));
  if (
    isProjectLocalManifest(path, environment.projectRoots) &&
    !boolFlag(args, "allow-project-local")
  ) {
    throw new UsageError(
      `Refusing to read a manifest from a project directory: "${path}" lies inside ` +
        `${environment.projectRoots.join(", ")}. A manifest describes how to start a program, so a ` +
        "cloned repository must never be able to supply one unnoticed (extensions.md §17).",
      "If you wrote this manifest yourself, repeat the command with --allow-project-local.",
    );
  }
  try {
    return await readManifestFromPath(environment.fs, path);
  } catch (cause) {
    throw new OperationalError(
      cause instanceof ManifestSourceError ? cause.message : String(cause),
      "Check the path; --from accepts a manifest.toml or the directory containing it.",
      { cause },
    );
  }
}
