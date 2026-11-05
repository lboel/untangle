import path from "node:path";

import type {
  HttpBoundaryFileFactsV1,
  HttpBoundaryRequestV1,
  SourceFile,
} from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";
import { analyzeHttpBoundaries } from "@untangle-code/file-graph";
import { createParserRegistry, extractHttpBoundaryFacts } from "@untangle-code/parser-registry";

import {
  collectProductInventory,
  readFreshProductFile,
  type ProductInventory,
} from "../product-alignment/analysis.js";
import { validProductPath } from "../product-alignment/manifest.js";

import {
  frontendFeatureAssociations,
  frontendFeatureFreshness,
  loadFrontendFeatures,
} from "./features.js";
import { frontendImportContext } from "./import-context.js";
import type {
  FrontendBoundaryIssueV1,
  FrontendBoundaryOptionsV1,
  FrontendBoundaryReportV1,
} from "./types.js";

const MAX_OUTPUT_RELATIONS = 1000;
const MAX_ANALYZED_FILES = 5000;
const MAX_EXTRACTED_FACTS = 100_000;
const BOUNDARY_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx|vue|py)$/u;
const LIMITATIONS = [
  "HTTP boundaries are static source relationships, separate from synchronous call edges. No project code, HTTP server or service is executed.",
  "Only JavaScript, TypeScript, JSX, TSX, Vue script blocks and Python FastAPI syntax are inspected for HTTP facts; other accepted files still contribute to source freshness.",
  "Vue template expressions, directives and styles are outside script complexity and HTTP extraction. Template-to-function invocation is not proven by file import context.",
  "Relative file imports provide UI-to-client context, not function-level call proof. Non-relative packages and configured aliases remain in an explicit unresolved ledger.",
  "Import context follows at most four file edges and discovers at most 10000 importer contexts. Counts cover discovered relations within those bounds. Cycles are visited once and only one shortest file path is shown; this is not all possible call paths.",
  "Service boundaries require caller declarations. Equal endpoint paths alone do not identify deployment ownership, runtime origin, credentials or branch execution.",
  "Feature association uses declared code/test globs and owner declarations. Observed HTTP relationships never change declared feature dependencies or independently prove semantic conformance.",
  "Freshness compares the complete accepted scanner census and selected feature control file before and after analysis; it is not an atomic filesystem transaction.",
];

function outputLimit(value: number | undefined): number {
  const limit = value ?? MAX_OUTPUT_RELATIONS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTPUT_RELATIONS)
    throw new TypeError("maxRelations must be an integer from 1 to 1000");
  return limit;
}

function selectedPath(value: string | undefined): string | undefined {
  if (value !== undefined && (!validProductPath(value) || /[*?[\]{}]/u.test(value)))
    throw new TypeError("path must be one literal repository-relative file path");
  return value;
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (
    error instanceof Error &&
    (error.name === "AbortError" || ("code" in error && error.code === "JOB_CANCELLED"))
  )
    throw error;
}

async function extractFiles(
  inventory: ProductInventory,
  options: FrontendBoundaryOptionsV1,
): Promise<{
  facts: HttpBoundaryFileFactsV1[];
  issues: FrontendBoundaryIssueV1[];
  unsupported: number;
  failed: number;
  truncated: boolean;
}> {
  const registry = options.parserRegistry ?? createParserRegistry();
  const facts: HttpBoundaryFileFactsV1[] = [];
  const issues: FrontendBoundaryIssueV1[] = [];
  let unsupported = 0;
  let failed = 0;
  let extracted = 0;
  let truncated = false;
  for (const file of inventory.files) {
    options.signal?.throwIfAborted();
    if (!BOUNDARY_EXTENSIONS.test(file.relativePath)) {
      unsupported += 1;
      continue;
    }
    if (facts.length >= MAX_ANALYZED_FILES) {
      truncated = true;
      issues.push({ path: file.relativePath, reason: "analyzed_file_budget_exceeded" });
      continue;
    }
    const read = await readFreshProductFile(inventory, file.relativePath, options.signal);
    if (read.status !== "resolved" || read.text === undefined || read.contentHash === undefined) {
      failed += 1;
      issues.push({ path: file.relativePath, reason: `source_${read.status}` });
      continue;
    }
    const adapter = registry.getAdapterForPath(file.relativePath, read.text.slice(0, 1024));
    if (adapter === null || adapter.supportLevel === "text") {
      unsupported += 1;
      issues.push({ path: file.relativePath, reason: "boundary_parser_unavailable" });
      continue;
    }
    const source: SourceFile = {
      fileId: file.relativePath,
      repoId: "frontend-boundaries",
      refId: "working-tree",
      path: file.relativePath,
      languageId: adapter.languageId,
      content: read.text,
      contentHash: read.contentHash,
      sizeBytes: file.sizeBytes,
    };
    try {
      const parsed = adapter.parse(source);
      options.signal?.throwIfAborted();
      if (parsed.ast === null || parsed.parseQuality !== "complete") {
        failed += 1;
        issues.push({ path: file.relativePath, reason: `parse_${parsed.parseQuality}` });
        continue;
      }
      const fileFacts = extractHttpBoundaryFacts(source, parsed.ast, adapter);
      options.signal?.throwIfAborted();
      const count =
        fileFacts.calls.length +
        fileFacts.functions.length +
        fileFacts.bindings.length +
        fileFacts.routers.length +
        fileFacts.routes.length +
        fileFacts.includes.length +
        fileFacts.imports.length +
        fileFacts.pythonImports.length;
      if (extracted + count > MAX_EXTRACTED_FACTS) {
        truncated = true;
        issues.push({ path: file.relativePath, reason: "extracted_fact_budget_exceeded" });
        continue;
      }
      extracted += count;
      facts.push(fileFacts);
    } catch (error) {
      rethrowCancellation(error, options.signal);
      failed += 1;
      issues.push({ path: file.relativePath, reason: "boundary_parse_or_extraction_failed" });
    }
  }
  return { facts, issues, unsupported, failed, truncated };
}

async function sourceFreshness(
  inventory: ProductInventory,
  options: FrontendBoundaryOptionsV1,
): Promise<{ after: ProductInventory; changedPaths: string[] }> {
  const changed = new Set<string>();
  for (const file of inventory.files) {
    const fresh = await readFreshProductFile(inventory, file.relativePath, options.signal);
    if (fresh.status !== "resolved" && fresh.sourceUnchanged !== true)
      changed.add(file.relativePath);
  }
  const after = await collectProductInventory({
    root: inventory.root,
    fs: inventory.fs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.inventoryScope === undefined ? {} : { scope: options.inventoryScope }),
  });
  const beforeFiles = new Map(inventory.files.map((file) => [file.relativePath, file]));
  const afterFiles = new Map(after.files.map((file) => [file.relativePath, file]));
  for (const file of inventory.files) {
    const current = afterFiles.get(file.relativePath);
    if (
      current === undefined ||
      current.contentHash !== file.contentHash ||
      current.absolutePath !== file.absolutePath
    )
      changed.add(file.relativePath);
  }
  for (const file of after.files)
    if (!beforeFiles.has(file.relativePath)) changed.add(file.relativePath);
  return { after, changedPaths: [...changed].sort(compareCodepoints) };
}

function requestMatches(
  request: HttpBoundaryRequestV1,
  selection: string | undefined,
  importers: FrontendBoundaryReportV1["importContext"]["requestImporters"],
): boolean {
  return (
    selection === undefined ||
    request.source.path === selection ||
    request.provenance.some((item) => item.path === selection) ||
    request.targets.some((endpoint) =>
      endpoint.provenance.some((item) => item.path === selection),
    ) ||
    importers.some((item) => item.path === selection && item.requestPath === request.source.path)
  );
}

/** Offline fresh source census -> explicit HTTP relationship evidence and declared feature context. */
export async function analyzeFrontendBoundaries(
  options: FrontendBoundaryOptionsV1,
): Promise<FrontendBoundaryReportV1> {
  options.signal?.throwIfAborted();
  if (typeof options.root !== "string" || options.root.trim().length === 0)
    throw new TypeError("root must be a non-empty project directory");
  const limit = outputLimit(options.maxRelations);
  const selection = selectedPath(options.path);
  const inventory = await collectProductInventory({
    root: path.resolve(options.root),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.inventoryScope === undefined ? {} : { scope: options.inventoryScope }),
  });
  const loadedFeatures = await loadFrontendFeatures(
    inventory,
    options.featureManifestPath,
    options.signal,
  );
  const extracted = await extractFiles(inventory, options);
  const http = analyzeHttpBoundaries({
    files: extracted.facts,
    services: options.services ?? [],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  options.signal?.throwIfAborted();
  const importContext = frontendImportContext(
    inventory,
    extracted.facts,
    http.requests.map((request) => request.source.path),
    limit,
    options.signal,
  );
  const requests = http.requests.filter((request) =>
    requestMatches(request, selection, importContext.requestImporters),
  );
  const endpointPaths = new Set(
    requests.flatMap((request) =>
      request.targets.flatMap((endpoint) => endpoint.provenance.map((item) => item.path)),
    ),
  );
  const endpoints =
    selection === undefined
      ? http.endpoints
      : http.endpoints.filter((endpoint) =>
          endpoint.provenance.some(
            (item) => item.path === selection || endpointPaths.has(item.path),
          ),
        );
  const contextPaths = new Set([
    ...(selection === undefined ? [] : [selection]),
    ...requests.flatMap((request) => [
      request.source.path,
      ...request.provenance.map((item) => item.path),
    ]),
    ...endpoints.flatMap((endpoint) => endpoint.provenance.map((item) => item.path)),
    ...importContext.requestImporters
      .filter((item) => requests.some((request) => request.source.path === item.requestPath))
      .map((item) => item.path),
  ]);
  const associations = frontendFeatureAssociations(
    loadedFeatures,
    [...contextPaths].sort(compareCodepoints),
  );
  const fresh = await sourceFreshness(inventory, options);
  const featureFresh = await frontendFeatureFreshness(inventory, loadedFeatures, options.signal);
  if (featureFresh.changed) fresh.changedPaths.push(loadedFeatures.path);
  const stale =
    fresh.changedPaths.length > 0 || inventory.sourceTreeDigest !== fresh.after.sourceTreeDigest;
  const issues: FrontendBoundaryIssueV1[] = [
    ...extracted.issues,
    ...loadedFeatures.issues.map((reason) => ({ path: loadedFeatures.path, reason })),
    ...http.limitations.map((item) => ({ path: item.path, reason: item.reason })),
    ...fresh.changedPaths.map((filePath) => ({
      path: filePath,
      reason: "changed_during_analysis",
    })),
  ];
  const truncated =
    inventory.truncated ||
    fresh.after.truncated ||
    extracted.truncated ||
    importContext.truncated ||
    requests.length > limit ||
    endpoints.length > limit ||
    issues.length > limit ||
    associations.length > limit ||
    http.limitations.length > limit ||
    fresh.changedPaths.length > limit;
  const incomplete =
    truncated ||
    extracted.failed > 0 ||
    extracted.issues.length > 0 ||
    http.summary.ambiguous > 0 ||
    http.summary.unresolved > 0 ||
    http.limitations.length > 0 ||
    ["invalid", "changed", "unreadable", "not_in_scan"].includes(featureFresh.manifest.status);
  const selectedRequestPaths = new Set(requests.map((request) => request.source.path));
  const selectedImporters = importContext.requestImporters.filter((item) =>
    selectedRequestPaths.has(item.requestPath),
  );
  const selectedImportEdges =
    selection === undefined
      ? importContext.edges
      : importContext.edges.filter(
          (edge) => contextPaths.has(edge.fromPath) && contextPaths.has(edge.toPath),
        );
  const selectedImportIssues =
    selection === undefined
      ? importContext.unresolved
      : importContext.unresolved.filter((item) => contextPaths.has(item.path));
  options.signal?.throwIfAborted();
  return {
    schemaVersion: 1,
    kind: "frontend-boundaries",
    root: inventory.root,
    status: stale ? "stale" : incomplete ? "incomplete" : "complete",
    sourceTreeDigest: inventory.sourceTreeDigest,
    freshness: {
      status: stale ? "stale" : "fresh",
      sourceTreeBefore: inventory.sourceTreeDigest,
      sourceTreeAfter: fresh.after.sourceTreeDigest,
      changedPaths: [...new Set(fresh.changedPaths)].sort(compareCodepoints).slice(0, limit),
    },
    inventory: {
      files: inventory.files.length,
      excluded: inventory.excluded,
      truncated: inventory.truncated || extracted.truncated || fresh.after.truncated,
      analyzed: extracted.facts.length,
      unsupported: extracted.unsupported,
      failed: extracted.failed,
    },
    ...(selection === undefined
      ? {}
      : {
          selection: {
            path: selection,
            inInventory: inventory.files.some((file) => file.relativePath === selection),
            matchingRequests: requests.length,
          },
        }),
    http: {
      ...http,
      requests: requests.slice(0, limit),
      endpoints: endpoints.slice(0, limit),
      limitations: http.limitations.slice(0, limit),
    },
    importContext: {
      ...importContext,
      edges: selectedImportEdges.slice(0, limit),
      unresolved: selectedImportIssues.slice(0, limit),
      requestImporters: selectedImporters.slice(0, limit),
    },
    features: {
      manifest: featureFresh.manifest,
      associations: associations.slice(0, limit),
      associationCount: associations.length,
      dependencySemantics: "declared_dependencies_unchanged",
    },
    truncation: {
      truncated,
      limit,
      omittedRequests: Math.max(0, requests.length - limit),
      omittedEndpoints: Math.max(0, endpoints.length - limit),
      omittedIssues: Math.max(0, issues.length - limit),
      omittedFeatureAssociations: Math.max(0, associations.length - limit),
    },
    issues: issues.slice(0, limit),
    limitations: [...LIMITATIONS],
  };
}
