import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import { analyzeProductAlignment } from "@untangle-code/core";
import { canonicalJson, sha256Hex, type ProductAlignmentReportV1 } from "@untangle-code/domain";
import { discoverFiles } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import { enumFlag, integerFlag, stringFlag, type ParsedArgs } from "../../cli/args.js";
import type { CommandContext } from "../../cli/command.js";
import { UsageError } from "../../cli/exit.js";
import { line, note } from "../../cli/io.js";

import { createFeatureMapHtml } from "./feature-html.js";
import {
  buildFeatureMapGraph,
  featureMapLimits,
  type FeatureMapGraphV1,
  type FeatureMapLimitsV1,
} from "./feature-model.js";

export interface FeatureMapOptionsV1 extends FeatureMapLimitsV1 {
  root: string;
  manifestPath?: string;
  testEvidencePath?: string;
  signal?: AbortSignal;
}
export interface FeatureMapWriteResultV1 {
  schemaVersion: 1;
  kind: "feature_map_artifact";
  htmlPath: string;
  jsonPath: string;
  sha256: { html: string; json: string };
  summary: FeatureMapGraphV1["summary"];
  graph: FeatureMapGraphV1;
  report: ProductAlignmentReportV1;
}

/** Reuse the safe scanner for a declared-feature-free census; never invent ownership or metrics. */
async function unassignedCensus(root: string, signal?: AbortSignal): Promise<string[]> {
  const paths: string[] = [];
  for await (const file of discoverFiles({
    fs: new NodeFileSystem(),
    roots: [root],
    repoRoot: root,
    ignore: {
      additionalDefaultExcludes: [
        "/.untangle",
        "/untangle.toml",
        "/untangle.toml.untangle-init-tmp",
      ],
    },
    ...(signal === undefined ? {} : { signal }),
  })) {
    signal?.throwIfAborted();
    if (
      file.languageId === "unknown" ||
      file.languageId === "markdown" ||
      /\.(?:json|toml|ya?ml|lock)$/iu.test(file.relativePath)
    )
      continue;
    paths.push(file.relativePath);
    if (paths.length >= 50_000) break;
  }
  return paths;
}

interface CreatedDirectory {
  path: string;
  ino: number;
  dev: number;
}
async function metadataDirectory(
  root: string,
  created: CreatedDirectory[],
  signal?: AbortSignal,
): Promise<string> {
  let directory = root;
  for (const component of [".untangle", "feature-map"]) {
    signal?.throwIfAborted();
    directory = path.join(directory, component);
    let made = true;
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      made = false;
    });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Error(
        "Feature-map metadata directories must be physical in-project directories, not symlinks.",
      );
    if (made) created.push({ path: directory, ino: info.ino, dev: info.dev });
  }
  return directory;
}

async function removeEmptyOwnDirectories(created: CreatedDirectory[]): Promise<void> {
  for (const directory of [...created].reverse()) {
    const current = await lstat(directory.path).catch(() => null);
    if (current?.ino === directory.ino && current.dev === directory.dev && current.isDirectory())
      await rmdir(directory.path).catch((error: unknown) => {
        if (
          !["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
        )
          throw error;
      });
  }
}

async function readRegular(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Feature-map artifact must be a regular file.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Exclusive creation preserves foreign bytes; interrupted own partial files are removed. */
async function preserve(filePath: string, content: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readRegular(filePath)) !== content)
      throw new Error("Existing feature-map artifact differs; refusing to overwrite it.");
    return null;
  });
  if (handle === null) return false;
  try {
    signal?.throwIfAborted();
    await handle.writeFile(content, "utf8");
    await handle.sync();
    signal?.throwIfAborted();
  } catch (error) {
    const identity = await handle.stat();
    const observed = await lstat(filePath).catch(() => null);
    if (observed?.ino === identity.ino && observed.dev === identity.dev) await rm(filePath);
    throw error;
  } finally {
    await handle.close();
  }
  return true;
}

/** Builds an index-free, source-bound artifact without executing tests or opening a browser. */
export async function writeFeatureMap(
  options: FeatureMapOptionsV1,
  deps: { analyze?: typeof analyzeProductAlignment } = {},
): Promise<FeatureMapWriteResultV1> {
  options.signal?.throwIfAborted();
  const limits = featureMapLimits(options);
  const root = await realpath(path.resolve(options.root));
  if (!(await stat(root)).isDirectory())
    throw new TypeError("Feature-map root must be a directory.");
  // Own metadata exists before the census, so its excluded-directory event is
  // stable on the second run; every measurement and source digest remains raw.
  const createdDirectories: CreatedDirectory[] = [];
  try {
    const directory = await metadataDirectory(root, createdDirectories, options.signal);
    const report = await (deps.analyze ?? analyzeProductAlignment)({
      root,
      ...(options.manifestPath === undefined
        ? {}
        : { manifestPath: path.resolve(root, options.manifestPath) }),
      ...(options.testEvidencePath === undefined
        ? {}
        : { testEvidencePath: path.resolve(root, options.testEvidencePath) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    options.signal?.throwIfAborted();
    const unassigned =
      report.status === "needs_manifest" ? await unassignedCensus(root, options.signal) : [];
    if (unassigned.length > 0) {
      const current = await (deps.analyze ?? analyzeProductAlignment)({
        root,
        ...(options.manifestPath === undefined
          ? {}
          : { manifestPath: path.resolve(root, options.manifestPath) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (current.sourceTreeDigest !== report.sourceTreeDigest)
        throw new Error(
          "Project sources changed while collecting unassigned file paths; regenerate the feature map.",
        );
    }
    const graph = buildFeatureMapGraph(report, limits, unassigned);
    const json =
      JSON.stringify({ schemaVersion: 1, kind: "feature_map_snapshot", graph, report }, null, 2) +
      "\n";
    const html = createFeatureMapHtml(graph);
    const digest = sha256Hex(canonicalJson({ json, html }));
    const prefix = path.join(directory, `feature-map-${digest.slice(0, 16)}`);
    const jsonPath = `${prefix}.json`,
      htmlPath = `${prefix}.html`;
    let createdJson = false;
    let createdHtml = false;
    try {
      createdJson = await preserve(jsonPath, json, options.signal);
      createdHtml = await preserve(htmlPath, html, options.signal);
      options.signal?.throwIfAborted();
    } catch (error) {
      if (createdHtml && (await readRegular(htmlPath).catch(() => null)) === html)
        await rm(htmlPath);
      if (createdJson && (await readRegular(jsonPath).catch(() => null)) === json)
        await rm(jsonPath);
      throw error;
    }
    return {
      schemaVersion: 1,
      kind: "feature_map_artifact",
      htmlPath,
      jsonPath,
      sha256: { html: sha256Hex(html), json: sha256Hex(json) },
      summary: graph.summary,
      graph,
      report,
    };
  } catch (error) {
    await removeEmptyOwnDirectories(createdDirectories);
    throw error;
  }
}

/** `graph features`: deliberately bypasses stored-graph loading and all service probes. */
export async function runFeatureMap(ctx: CommandContext, args: ParsedArgs): Promise<number> {
  if (args.positionals.length !== 0)
    throw new UsageError("graph features accepts no additional positional arguments.");
  const format = enumFlag(args, "format", ["text", "json"] as const, "text");
  const root = path.resolve(ctx.cwd, stringFlag(args, "root") ?? ".");
  const manifestPath = stringFlag(args, "feature-map");
  const testEvidencePath = stringFlag(args, "test-evidence");
  const maxNodes = integerFlag(args, "max-nodes", 500),
    maxEdges = integerFlag(args, "max-edges", 2_000);
  try {
    featureMapLimits({ maxNodes, maxEdges });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const result = await writeFeatureMap({
    root,
    maxNodes,
    maxEdges,
    signal: ctx.signal,
    ...(manifestPath === undefined ? {} : { manifestPath }),
    ...(testEvidencePath === undefined ? {} : { testEvidencePath }),
  });
  if (format === "json") line(ctx.io, JSON.stringify(result, null, 2));
  else {
    line(ctx.io, result.htmlPath);
    note(
      ctx.io,
      `Feature map: ${result.summary.features} declared features, ${result.summary.shownNodes}/${result.summary.totalNodes} nodes, ${result.summary.shownEdges}/${result.summary.totalEdges} edges; ${result.summary.status}.`,
    );
    note(ctx.io, `Complete report: ${result.jsonPath}`);
    note(
      ctx.io,
      "Open the local HTML file in a browser. No index, service, network request or test execution is required.",
    );
    if (result.summary.truncated)
      note(ctx.io, "Bounded diagram; complete feature metrics remain in the JSON report.");
  }
  return 0;
}
