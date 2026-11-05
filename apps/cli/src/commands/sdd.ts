import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import {
  discoverSddArtifacts,
  type SddConnectionReportV1,
  type SddFrameworkV1,
} from "@untangle-code/core";
import { canonicalJson, sha256Hex } from "@untangle-code/domain";

import { boolFlag, enumFlag, stringFlag, type FlagSpecs, type ParsedArgs } from "../cli/args.js";
import type { CommandContext } from "../cli/command.js";
import { OperationalError, UsageError } from "../cli/exit.js";
import { line, note } from "../cli/io.js";

export const SDD_CONNECT_FLAGS: FlagSpecs = {
  "dry-run": {
    kind: "boolean",
    describe: "Inspect the SDD connector draft without writing its local report or manifest.",
  },
};

export interface SddConnectionArtifactV1 {
  schemaVersion: 1;
  kind: "sdd_connection_artifact";
  report: SddConnectionReportV1;
  reportPath: string | null;
  manifestPath: string | null;
  sha256: { report: string; manifest: string } | null;
}

/** Exclusive, versioned project metadata; the upstream workspace is never modified. */
export async function writeSddConnection(
  report: SddConnectionReportV1,
  options: { signal?: AbortSignal } = {},
): Promise<SddConnectionArtifactV1> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (report.status === "stale")
    throw new OperationalError("SDD sources changed during inspection; run the connector again.");
  if (report.features.length === 0)
    return {
      schemaVersion: 1,
      kind: "sdd_connection_artifact",
      report,
      reportPath: null,
      manifestPath: null,
      sha256: null,
    };
  const root = await realpath(report.root);
  if (root !== report.root)
    throw new OperationalError("The selected SDD project root changed physical identity.");
  const current = await discoverSddArtifacts({
    root,
    framework: report.requestedFramework,
    ...(signal ? { signal } : {}),
  });
  if (
    current.status === "stale" ||
    current.sourceDigest !== report.sourceDigest ||
    canonicalJson(current) !== canonicalJson(report)
  )
    throw new OperationalError(
      "SDD source evidence changed after the preview; inspect a fresh connector plan before writing.",
    );
  const reportText = JSON.stringify(report, null, 2) + "\n";
  const manifestText = JSON.stringify(report.draft, null, 2) + "\n";
  const sha256 = { report: sha256Hex(reportText), manifest: sha256Hex(manifestText) };
  const artifactKey = sha256Hex(
    canonicalJson({ report: sha256.report, manifest: sha256.manifest }),
  );
  let directory = root;
  for (const component of [
    ".untangle",
    "sdd",
    `${report.requestedFramework}-${artifactKey.slice(0, 24)}`,
  ]) {
    signal?.throwIfAborted();
    directory = path.join(directory, component);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new OperationalError(
        "SDD metadata directories must be physical in-project directories, without symlinks.",
      );
  }
  const created: { file: string; ino: number; dev: number; expected: Buffer; complete: boolean }[] =
    [];
  try {
    for (const [name, text] of [
      ["report.json", reportText],
      ["untangle.features.json", manifestText],
    ] as const) {
      signal?.throwIfAborted();
      const file = path.join(directory, name);
      let handle;
      try {
        handle = await open(
          file,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await existing.stat();
          if (
            !info.isFile() ||
            info.size !== Buffer.byteLength(text) ||
            (await realpath(file)) !== file ||
            (await existing.readFile()).toString("utf8") !== text
          )
            throw new OperationalError("Existing SDD artifacts differ; no file was overwritten.");
        } finally {
          await existing.close();
        }
        continue;
      }
      try {
        const info = await handle.stat();
        const own = {
          file,
          ino: info.ino,
          dev: info.dev,
          expected: Buffer.from(text),
          complete: false,
        };
        created.push(own);
        await handle.writeFile(text, { signal });
        own.complete = true;
        signal?.throwIfAborted();
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    for (const own of created) {
      const info = await lstat(own.file).catch(() => null);
      if (!info?.isFile() || info.ino !== own.ino || info.dev !== own.dev) continue;
      const handle = await open(own.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        () => null,
      );
      if (!handle) continue;
      try {
        const opened = await handle.stat();
        if (opened.ino !== own.ino || opened.dev !== own.dev || opened.size > own.expected.length)
          continue;
        const bytes = await handle.readFile();
        // A failed write may leave only a prefix. Preserve replacements and unexpected edits.
        const matches = own.complete
          ? bytes.equals(own.expected)
          : bytes.equals(own.expected.subarray(0, bytes.length));
        const current = await lstat(own.file).catch(() => null);
        const unchanged =
          current?.ino === opened.ino &&
          current.dev === opened.dev &&
          current.size === opened.size &&
          current.mtimeMs === opened.mtimeMs;
        if (matches && unchanged) await unlink(own.file);
      } finally {
        await handle.close();
      }
    }
    throw error;
  }
  return {
    schemaVersion: 1,
    kind: "sdd_connection_artifact",
    report,
    reportPath: path.join(directory, "report.json"),
    manifestPath: path.join(directory, "untangle.features.json"),
    sha256,
  };
}

export async function runSddConnection(
  ctx: CommandContext,
  args: ParsedArgs,
  deps: { discover?: typeof discoverSddArtifacts; write?: typeof writeSddConnection } = {},
): Promise<number> {
  const positionals =
    args.positionals[0] === "connect" ? args.positionals.slice(1) : args.positionals;
  if (
    positionals.length > 1 ||
    !["auto", "spec-kit", "openspec"].includes(positionals[0] ?? "auto")
  )
    throw new UsageError(
      "Use `untangle product connect [auto|spec-kit|openspec] [--root=PATH] [--dry-run] [--format=json]`.",
    );
  for (const [name, value] of Object.entries(args.flags))
    if (!["root", "dry-run", "format", "help"].includes(name) && value !== undefined)
      throw new UsageError(`--${name} is not supported by product connect.`);
  const framework = (positionals[0] ?? "auto") as SddFrameworkV1 | "auto";
  const format = enumFlag(args, "format", ["text", "json"] as const, "text");
  const report = await (deps.discover ?? discoverSddArtifacts)({
    root: path.resolve(ctx.cwd, stringFlag(args, "root") ?? "."),
    framework,
    signal: ctx.signal,
  });
  ctx.signal.throwIfAborted();
  const result: SddConnectionArtifactV1 = boolFlag(args, "dry-run")
    ? {
        schemaVersion: 1,
        kind: "sdd_connection_artifact",
        report,
        reportPath: null,
        manifestPath: null,
        sha256: null,
      }
    : await (deps.write ?? writeSddConnection)(report, { signal: ctx.signal });
  if (format === "json") line(ctx.io, JSON.stringify(result, null, 2));
  else {
    line(
      ctx.io,
      `SDD connection: ${report.status}; ${String(report.features.length)} proposed features from ${report.frameworks.join(", ") || "no detected framework"}.`,
    );
    if (result.manifestPath) {
      line(ctx.io, `Review manifest: ${result.manifestPath}`);
      line(ctx.io, `Evidence report: ${result.reportPath!}`);
      line(
        ctx.io,
        `Next argv (data, not a shell command): ${JSON.stringify(["untangle", "product", `--root=${report.root}`, `--manifest=${result.manifestPath}`])}`,
      );
      line(
        ctx.io,
        `Map argv (data, not a shell command): ${JSON.stringify(["untangle", "graph", "features", `--root=${report.root}`, `--feature-map=${result.manifestPath}`])}`,
      );
    }
    for (const issue of report.issues)
      note(ctx.io, `${issue.code}: ${issue.path}: ${issue.message}`);
    note(
      ctx.io,
      "Imported declarations require review. No framework commands or tests ran; no implementation or ownership was confirmed.",
    );
  }
  return report.status === "stale" ? 1 : 0;
}
