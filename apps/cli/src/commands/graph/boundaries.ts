import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { analyzeFrontendBoundaries } from "@untangle-code/core";
import type { HttpServiceBindingV1 } from "@untangle-code/domain";

import { enumFlag, integerFlag, stringFlag, type ParsedArgs } from "../../cli/args.js";
import type { CommandContext } from "../../cli/command.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { line } from "../../cli/io.js";
import { loadWorkspace } from "../../cli/workspace.js";

import { httpServicesFileSchema } from "./boundaries-input.js";

interface ServiceControl {
  path: string;
  status: "loaded" | "missing";
  contentHash?: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function readServices(
  root: string,
  requested: string | undefined,
): {
  services: HttpServiceBindingV1[];
  control: ServiceControl;
  verify: () => void;
} {
  const selected = requested ?? ".untangle/services.json";
  const candidate = path.resolve(root, selected);
  if (!inside(root, candidate))
    throw new UsageError("Service configuration must be inside the project root.");
  const controlPath = path.relative(root, candidate).split(path.sep).join("/");
  let physical: string;
  try {
    physical = realpathSync(candidate);
  } catch (error) {
    if (requested === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        services: [],
        control: { path: controlPath, status: "missing" },
        verify: () => {
          try {
            realpathSync(candidate);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === "ENOENT") return;
            throw failure;
          }
          throw new OperationalError(
            "Service configuration appeared during the analysis; repeat it.",
          );
        },
      };
    }
    throw new OperationalError("Service configuration could not be read.");
  }
  if (!inside(root, physical))
    throw new UsageError("Service configuration resolves outside the project root.");
  const stat = statSync(physical);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new UsageError("Service configuration must be a regular JSON file no larger than 1 MiB.");
  const bytes = readFileSync(physical);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new UsageError("Service configuration is not valid UTF-8 JSON.");
  }
  const parsed = httpServicesFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new UsageError(
      "Invalid service configuration: " +
        parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "),
    );
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const contentHash = digest(bytes);
  return {
    services: parsed.data.services.map((service) => ({
      id: service.id,
      frontendRoots: service.frontendRoots,
      backendRoots: service.backendRoots,
      ...(service.sameOrigin === undefined ? {} : { sameOrigin: service.sameOrigin }),
      ...(service.origins === undefined ? {} : { origins: service.origins }),
    })),
    control: { path: controlPath, status: "loaded", contentHash },
    verify: () => {
      if (realpathSync(candidate) !== physical || digest(readFileSync(physical)) !== contentHash)
        throw new OperationalError("Service configuration changed during the analysis; repeat it.");
    },
  };
}

export async function runBoundaries(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  const allowed = new Set(["root", "services", "path", "max-relations", "format"]);
  for (const flag of Object.keys(args.flags))
    if (!allowed.has(flag))
      throw new UsageError(`Option --${flag} is not supported by graph boundaries.`);
  const format = enumFlag(args, "format", ["text", "json"] as const, "text");
  const maxRelations = integerFlag(args, "max-relations", 200);
  if (maxRelations < 1 || maxRelations > 1000)
    throw new UsageError("--max-relations must be between 1 and 1000.");
  const rootFlag = stringFlag(args, "root");
  const workspace = loadWorkspace({
    cwd: path.resolve(ctx.cwd, rootFlag ?? "."),
    env: ctx.env,
    strict: true,
  });
  const root = realpathSync(
    rootFlag === undefined ? workspace.root : path.resolve(ctx.cwd, rootFlag),
  );
  const services = readServices(root, stringFlag(args, "services"));
  const selectedPath = stringFlag(args, "path");
  if (
    selectedPath !== undefined &&
    (!selectedPath ||
      selectedPath.length > 4096 ||
      selectedPath.startsWith("/") ||
        /[:\\*?[\]{}]/u.test(selectedPath) ||
      selectedPath.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new UsageError("--path must be one literal repository-relative file path.");
  const repository = (workspace.config.repositories ?? []).find(
    (entry) => path.resolve(workspace.load.sources.configBaseDir, entry.path) === root,
  );
  const report = await analyzeFrontendBoundaries({
    root,
    services: services.services,
    maxRelations,
    ...(selectedPath === undefined ? {} : { path: selectedPath }),
    ...(repository?.exclude === undefined
      ? {}
      : { inventoryScope: { additionalDefaultExcludes: repository.exclude } }),
    signal: ctx.signal,
  });
  ctx.signal.throwIfAborted();
  services.verify();
  const data = { ...report, servicesManifest: services.control };
  if (format === "json") line(ctx.io, JSON.stringify(data, null, 2));
  else {
    line(
      ctx.io,
      `Frontend/backend HTTP dependencies: ${report.status}; sources ${report.freshness.status}`,
    );
    line(
      ctx.io,
      `${report.http.summary.endpoints} endpoints; ${report.http.summary.requests} requests: ${report.http.summary.resolved} resolved, ${report.http.summary.ambiguous} ambiguous, ${report.http.summary.unresolved} unresolved.`,
    );
    for (const request of report.http.requests) {
      line(
        ctx.io,
        `${request.source.path}:${request.source.range.startLine} ${request.method ?? "?"} ${request.path ?? "?"} [${request.status}]`,
      );
      for (const target of request.targets) {
        const route = target.provenance.find((item) => item.kind === "route");
        line(
          ctx.io,
          `  -> ${target.serviceId ?? "unbound"} ${target.handler}${route ? " " + route.path + ":" + route.range.startLine : ""}`,
        );
      }
      if (request.reason) line(ctx.io, "  " + request.reason);
    }
    for (const importer of report.importContext.requestImporters)
      line(
        ctx.io,
        `Import context: ${importer.path} -> ${importer.requestPath} (${importer.distance} import edges; no function-call proof)`,
      );
    line(
      ctx.io,
      `Feature associations: ${report.features.associationCount}; declared dependsOn remains unchanged.`,
    );
    if (report.truncation.truncated)
      line(ctx.io, "Output was truncated; inspect the JSON counts and limits.");
    for (const limitation of report.limitations) line(ctx.io, "Limit: " + limitation);
  }
  return report.freshness.status === "stale" ? EXIT.environment : EXIT.ok;
}
