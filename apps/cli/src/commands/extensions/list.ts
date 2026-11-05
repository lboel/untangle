/**
 * `untangle extensions list`
 *
 * Shows what is installed for THIS user: name, license, status, last run.
 *
 * The listing is also where the two silences E4 forbids are broken. A
 * manifest that was found but rejected, and a manifest that was found but
 * deliberately not loaded — a project-local one above all — both appear with
 * their reason. So do the roots that were searched, including the ones that
 * do not exist: "no extensions" must be a statement about a place, not an
 * unexplained blank.
 */
import { compareCodepoints } from "@untangle-code/domain";

import { boolFlag, stringFlag, type ParsedArgs } from "../../cli/args.js";
import { EXIT } from "../../cli/exit.js";
import { line, note, type Io } from "../../cli/io.js";

import { gateFor, loadExtensionContext } from "./context.js";
import type { ExtensionEnvironmentV1 } from "./environment.js";
import { emitJson, renderTable } from "./render.js";
import type { LastRunRecordV1 } from "./state.js";

interface ListRowV1 {
  id: string;
  displayName: string;
  category: string;
  invocation: string[];
  outputFormat: string;
  license: { spdxId: string; usageRestriction: string; gateStatus: string; gateReason: string };
  enabled: boolean;
  status: string;
  networkAccess: string;
  /** The manifest pin (X6); null when the extension is not container-invoked. */
  pin: { image: string; digest: string } | null;
  manifestPath: string;
  origin: string;
  lastRun?: LastRunRecordV1;
}

export async function runList(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
): Promise<number> {
  const context = await loadExtensionContext(environment);
  const categoryFilter = stringFlag(args, "category")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const enabledOnly = boolFlag(args, "enabled-only");

  const rows: ListRowV1[] = [];
  for (const extension of context.discovery.extensions) {
    const manifest = extension.manifest;
    if (categoryFilter !== undefined && !categoryFilter.includes(manifest.category)) {
      continue;
    }
    const enabled = context.state.enabled.includes(manifest.id);
    if (enabledOnly && !enabled) {
      continue;
    }
    const gate = gateFor(context, extension);
    const lastRun = context.state.lastRuns[manifest.id];
    rows.push({
      id: manifest.id,
      displayName: manifest.displayName,
      category: manifest.category,
      invocation: manifest.invocation,
      outputFormat: manifest.outputFormat,
      license: {
        spdxId: manifest.license.spdxId,
        usageRestriction: manifest.license.usageRestriction,
        gateStatus: gate.tool.status,
        gateReason: gate.tool.reason,
      },
      enabled,
      status: statusOf(enabled, gate.allowed, gate.tool.status),
      networkAccess: manifest.networkAccess,
      pin:
        manifest.container === undefined
          ? null
          : { image: manifest.container.image, digest: manifest.container.digest },
      manifestPath: extension.manifestPath,
      origin: extension.origin,
      ...(lastRun === undefined ? {} : { lastRun }),
    });
  }
  rows.sort((left, right) => compareCodepoints(left.id, right.id));

  if (format === "json") {
    emitJson(io, {
      command: "extensions list",
      rootsScanned: context.discovery.rootsScanned,
      projectRootsExcluded: environment.projectRoots,
      extensions: rows,
      rejected: context.discovery.rejected,
      ignored: context.discovery.ignored,
      warnings: context.warnings,
    });
  } else {
    if (rows.length === 0) {
      line(io, "no extensions installed.");
    } else {
      for (const rendered of renderTable(
        ["ID", "LICENSE", "RESTRICTION", "STATUS", "LAST RUN"],
        rows.map((row) => [
          row.id,
          row.license.spdxId,
          row.license.usageRestriction,
          row.status,
          describeLastRun(row.lastRun),
        ]),
      )) {
        line(io, rendered);
      }
    }
    line(io, "");
    line(io, "roots searched (project directories are never searched):");
    for (const root of context.discovery.rootsScanned) {
      line(io, `  ${root.root}${root.exists ? "" : "  (does not exist)"}`);
    }
    if (environment.projectRoots.length > 0) {
      line(io, `  excluded as project directories: ${environment.projectRoots.join(", ")}`);
    }
  }

  for (const rejected of context.discovery.rejected) {
    note(io, `rejected ${rejected.manifestPath}:`);
    for (const issue of rejected.issues) {
      note(io, `  ${issue.field}: ${issue.message}`);
    }
  }
  for (const ignored of context.discovery.ignored) {
    note(io, `ignored ${ignored.manifestPath} (${ignored.reason}): ${ignored.detail}`);
  }
  for (const warning of context.warnings) {
    note(io, `warning: ${warning}`);
  }
  return EXIT.ok;
}

function statusOf(enabled: boolean, gateAllowed: boolean, gateStatus: string): string {
  if (!gateAllowed) {
    return `blocked (license ${gateStatus})`;
  }
  return enabled ? "enabled" : "installed, not enabled";
}

function describeLastRun(lastRun: LastRunRecordV1 | undefined): string {
  if (lastRun === undefined) {
    return "never";
  }
  const when = lastRun.finishedAt ?? lastRun.startedAt;
  const suffix = lastRun.errorCode === undefined ? "" : ` ${lastRun.errorCode}`;
  return `${when} ${lastRun.exitStatus}${suffix} (${String(lastRun.findingsTotal)} findings)`;
}
