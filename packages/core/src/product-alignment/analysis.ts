import { createHash } from "node:crypto";
import path from "node:path";

import {
  COGNITIVE_ALGORITHM_ID,
  METRICS_VERSION,
  canonicalJson,
  classifyTextFormat,
  compareCodepoints,
  sha256Hex,
} from "@untangle-code/domain";
import type {
  FileSystemPort,
  ParserRegistry,
  ProductCodeMetricsV1,
  ProductFileEvidenceV1,
  ProductHotspotV1,
} from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import { discoverFiles } from "@untangle-code/scanner";
import type { ScannedFileV1 } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import {
  addProductMetrics,
  emptyProductMetrics,
  measureParsedProductFile,
} from "./analysis-metrics.js";

const MAX_INVENTORY_FILES = 50_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SELF_MANAGED_PATHS = ["untangle.toml", "untangle.toml.untangle-init-tmp"];
const defaultRegistry = createParserRegistry();
const fileLookups = new WeakMap<ProductInventory, ReadonlyMap<string, ScannedFileV1>>();

function isProductMetadata(relativePath: string): boolean {
  return relativePath === ".untangle" || relativePath.startsWith(".untangle/");
}

export interface ProductInventory {
  root: string;
  fs: FileSystemPort;
  files: readonly ScannedFileV1[];
  sourceTreeDigest: string;
  truncated: boolean;
  /** Scanner exclusion events, which may refer to entire directories. */
  excluded: number;
}

export interface ProductInventoryScopeV1 {
  additionalDefaultExcludes?: readonly string[];
  maxFileSizeBytes?: number;
  maxFilesScanned?: number;
  concurrency?: number;
}

export interface ProductFileMeasurement {
  evidence: ProductFileEvidenceV1;
  metrics: ProductCodeMetricsV1 | null;
  hotspots: ProductHotspotV1[];
  limitations?: string[];
}

export interface FreshProductFile {
  status: "resolved" | "missing" | "not_in_scan" | "changed" | "unreadable";
  contentHash?: string;
  text?: string;
  /** Raw content and original physical identity were verified, even if decoding failed. */
  sourceUnchanged?: true;
}

export interface FreshProductManifestFile extends FreshProductFile {
  /** Control-file identity is separate from the accepted production inventory. */
  physicalPath?: string;
}

export async function collectProductInventory(input: {
  root: string;
  fs?: FileSystemPort;
  signal?: AbortSignal;
  scope?: ProductInventoryScopeV1;
}): Promise<ProductInventory> {
  input.signal?.throwIfAborted();
  const fs = input.fs ?? new NodeFileSystem();
  const options = input.signal === undefined ? {} : { signal: input.signal };
  const scope = input.scope ?? {};
  const maxFiles = Math.min(MAX_INVENTORY_FILES, scope.maxFilesScanned ?? MAX_INVENTORY_FILES);
  if (!Number.isInteger(maxFiles) || maxFiles < 0)
    throw new TypeError("maxFilesScanned must be a nonnegative integer");
  const root = await fs.realPath(path.resolve(input.root), options);
  input.signal?.throwIfAborted();
  if ((await fs.stat(root, options))?.kind !== "directory")
    throw new Error("Product inventory root must be a directory");
  let excluded = 0;
  let truncated = false;
  const files: ScannedFileV1[] = [];
  for await (const file of discoverFiles({
    fs,
    roots: [root],
    repoRoot: root,
    ...options,
    ignore: {
      additionalDefaultExcludes: [
        ...SELF_MANAGED_PATHS,
        "/.untangle",
        ...(scope.additionalDefaultExcludes ?? []),
      ],
    },
    ...(scope.maxFileSizeBytes === undefined ? {} : { maxFileSizeBytes: scope.maxFileSizeBytes }),
    ...(scope.concurrency === undefined ? {} : { concurrency: scope.concurrency }),
    onSkip: (skip) => {
      if (!SELF_MANAGED_PATHS.includes(skip.relativePath)) excluded += 1;
    },
  })) {
    input.signal?.throwIfAborted();
    if (isProductMetadata(file.relativePath)) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push(file);
  }
  input.signal?.throwIfAborted();
  return createProductInventory({ root, fs, files, truncated, excluded });
}

export function createProductInventory(input: {
  root: string;
  fs: FileSystemPort;
  files: readonly ScannedFileV1[];
  truncated?: boolean;
  excluded?: number;
}): ProductInventory {
  const root = path.resolve(input.root);
  const byPath = new Map<string, ScannedFileV1>();
  for (const file of input.files) {
    const relativePath = normalizedPath(root, file.relativePath);
    if (SELF_MANAGED_PATHS.includes(relativePath) || isProductMetadata(relativePath)) continue;
    const prior = byPath.get(relativePath);
    if (
      prior !== undefined &&
      (prior.contentHash !== file.contentHash || prior.absolutePath !== file.absolutePath)
    )
      throw new Error(`Conflicting accepted source path: ${relativePath}`);
    byPath.set(relativePath, Object.freeze({ ...file, relativePath }));
  }
  const files = Object.freeze(
    [...byPath.values()].sort((left, right) =>
      compareCodepoints(left.relativePath, right.relativePath),
    ),
  );
  const inventory = Object.freeze({
    root,
    fs: input.fs,
    files,
    sourceTreeDigest: sha256Hex(
      canonicalJson(files.map((file) => [file.relativePath, file.contentHash])),
    ),
    truncated: input.truncated ?? false,
    excluded: input.excluded ?? 0,
  });
  fileLookups.set(inventory, byPath);
  return inventory;
}

function acceptedFile(inventory: ProductInventory, filePath: string): ScannedFileV1 | undefined {
  let files = fileLookups.get(inventory);
  if (files === undefined) {
    files = new Map(inventory.files.map((file) => [file.relativePath, file]));
    fileLookups.set(inventory, files);
  }
  return files.get(filePath);
}

function normalizedPath(root: string, requested: string): string {
  return path
    .relative(root, path.resolve(root, requested.replaceAll("\\", "/")))
    .split(path.sep)
    .join("/");
}

function withinRoot(root: string, absolute: string): boolean {
  const relative = path.relative(root, path.resolve(absolute));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (
    error instanceof Error &&
    (error.name === "AbortError" || ("code" in error && error.code === "JOB_CANCELLED"))
  )
    throw error;
}

export async function readFreshProductFile(
  inventory: ProductInventory,
  requested: string,
  signal?: AbortSignal,
): Promise<FreshProductFile> {
  signal?.throwIfAborted();
  const filePath = normalizedPath(inventory.root, requested);
  const file = acceptedFile(inventory, filePath);
  if (!withinRoot(inventory.root, path.resolve(inventory.root, filePath)))
    return { status: "not_in_scan" };
  if (file === undefined) return unacceptedProductFile(inventory, filePath, signal);
  if (!withinRoot(inventory.root, file.absolutePath)) return { status: "not_in_scan" };
  const options = signal === undefined ? {} : { signal };
  let contentHash: string | undefined;
  let sourceUnchanged = false;
  try {
    const physical = await inventory.fs.realPath(path.resolve(inventory.root, filePath), options);
    signal?.throwIfAborted();
    if (!withinRoot(inventory.root, physical)) return { status: "not_in_scan" };
    if (path.resolve(physical) !== path.resolve(file.absolutePath)) return { status: "changed" };
    const stat = await inventory.fs.stat(physical, options);
    signal?.throwIfAborted();
    if (stat === null) return { status: "missing" };
    if (stat.kind !== "file" || stat.sizeBytes > MAX_FILE_BYTES) return { status: "unreadable" };
    const bytes = await inventory.fs.readFile(physical, options);
    signal?.throwIfAborted();
    contentHash = createHash("sha256").update(bytes).digest("hex");
    const after = await inventory.fs.realPath(path.resolve(inventory.root, filePath), options);
    signal?.throwIfAborted();
    if (!withinRoot(inventory.root, after)) return { status: "not_in_scan", contentHash };
    if (path.resolve(after) !== path.resolve(physical) || contentHash !== file.contentHash)
      return { status: "changed", contentHash };
    sourceUnchanged = true;
    if (
      bytes.byteLength > MAX_FILE_BYTES ||
      file.encoding === "utf16le" ||
      file.encoding === "utf16be"
    )
      return { status: "unreadable", contentHash, sourceUnchanged: true };
    return {
      status: "resolved",
      contentHash,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch (error) {
    rethrowCancellation(error, signal);
    const status =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "missing"
        : "unreadable";
    return {
      status,
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(sourceUnchanged ? { sourceUnchanged: true as const } : {}),
    };
  }
}

/** Only the selected manifest may read root-owned metadata outside the source census. */
export async function readFreshProductManifestFile(
  inventory: ProductInventory,
  requested: string,
  signal?: AbortSignal,
  previous?: FreshProductManifestFile,
): Promise<FreshProductManifestFile> {
  signal?.throwIfAborted();
  const filePath = normalizedPath(inventory.root, requested);
  if (!isProductMetadata(filePath)) return readFreshProductFile(inventory, requested, signal);
  const absolute = path.resolve(inventory.root, filePath);
  if (!withinRoot(inventory.root, absolute)) return { status: "not_in_scan" };
  const options = signal === undefined ? {} : { signal };
  let contentHash: string | undefined;
  try {
    const physical = await inventory.fs.realPath(absolute, options);
    signal?.throwIfAborted();
    if (!withinRoot(inventory.root, physical)) return { status: "not_in_scan" };
    if (previous !== undefined && previous.physicalPath !== physical) return { status: "changed" };
    const stat = await inventory.fs.stat(physical, options);
    signal?.throwIfAborted();
    if (stat === null) return { status: "missing" };
    if (stat.kind !== "file" || stat.sizeBytes > MAX_FILE_BYTES) return { status: "unreadable" };
    const bytes = await inventory.fs.readFile(physical, options);
    signal?.throwIfAborted();
    contentHash = createHash("sha256").update(bytes).digest("hex");
    const after = await inventory.fs.realPath(absolute, options);
    signal?.throwIfAborted();
    if (!withinRoot(inventory.root, after)) return { status: "not_in_scan", contentHash };
    if (
      path.resolve(after) !== path.resolve(physical) ||
      (previous !== undefined && previous.contentHash !== contentHash)
    )
      return { status: "changed", contentHash };
    if (bytes.byteLength > MAX_FILE_BYTES) return { status: "unreadable", contentHash };
    return {
      status: "resolved",
      contentHash,
      physicalPath: physical,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch (error) {
    rethrowCancellation(error, signal);
    return {
      status:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unreadable",
      ...(contentHash === undefined ? {} : { contentHash }),
    };
  }
}

async function unacceptedProductFile(
  inventory: ProductInventory,
  filePath: string,
  signal?: AbortSignal,
): Promise<FreshProductFile> {
  try {
    const stat = await inventory.fs.stat(
      path.resolve(inventory.root, filePath),
      signal === undefined ? {} : { signal },
    );
    signal?.throwIfAborted();
    return { status: stat === null ? "missing" : "not_in_scan" };
  } catch (error) {
    rethrowCancellation(error, signal);
    return {
      status:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unreadable",
    };
  }
}

export function isProductCodeFile(
  file: ScannedFileV1,
  parserRegistry: ParserRegistry = defaultRegistry,
): boolean {
  const adapter = parserRegistry.getAdapterForPath(file.relativePath);
  return (
    classifyTextFormat(file.relativePath) !== "generated" &&
    adapter !== null &&
    adapter.supportLevel !== "text"
  );
}

export async function measureProductFiles(
  inventory: ProductInventory,
  paths: readonly string[],
  options: { parserRegistry?: ParserRegistry; signal?: AbortSignal } = {},
): Promise<Map<string, ProductFileMeasurement>> {
  const registry = options.parserRegistry ?? defaultRegistry;
  const measurements = new Map<string, ProductFileMeasurement>();
  const uniquePaths = [
    ...new Set(paths.map((filePath) => normalizedPath(inventory.root, filePath))),
  ].sort(compareCodepoints);
  for (const filePath of uniquePaths) {
    options.signal?.throwIfAborted();
    measurements.set(
      filePath,
      await measureProductFile(inventory, filePath, registry, options.signal),
    );
  }
  options.signal?.throwIfAborted();
  return measurements;
}

function unresolvedMeasurement(
  filePath: string,
  read: FreshProductFile,
  scannedHash?: string,
): ProductFileMeasurement {
  const status = read.status === "missing" ? "unreadable" : read.status;
  return {
    evidence: {
      path: filePath,
      status: status === "resolved" ? "invalid_metrics" : status,
      ...(read.contentHash === undefined ? {} : { contentHash: read.contentHash }),
      ...(read.status === "changed" && scannedHash !== undefined
        ? { scannedContentHash: scannedHash }
        : {}),
    },
    metrics: null,
    hotspots: [],
  };
}

async function measureProductFile(
  inventory: ProductInventory,
  filePath: string,
  registry: ParserRegistry,
  signal?: AbortSignal,
): Promise<ProductFileMeasurement> {
  const file = acceptedFile(inventory, filePath);
  const read = await readFreshProductFile(inventory, filePath, signal);
  if (
    read.status !== "resolved" ||
    read.text === undefined ||
    read.contentHash === undefined ||
    file === undefined
  )
    return unresolvedMeasurement(filePath, read, file?.contentHash);
  const evidence = { path: filePath, contentHash: read.contentHash };
  const adapter = registry.getAdapterForPath(filePath);
  if (
    adapter === null ||
    adapter.supportLevel === "text" ||
    classifyTextFormat(filePath) === "generated"
  )
    return { evidence: { ...evidence, status: "unsupported" }, metrics: null, hotspots: [] };
  let parsed;
  try {
    parsed = adapter.parse({
      fileId: filePath,
      repoId: "product",
      refId: "product:working-tree",
      path: filePath,
      languageId: adapter.languageId,
      content: read.text,
      contentHash: read.contentHash,
      sizeBytes: Buffer.byteLength(read.text, "utf8"),
    });
    signal?.throwIfAborted();
  } catch (error) {
    rethrowCancellation(error, signal);
    return { evidence: { ...evidence, status: "partial" }, metrics: null, hotspots: [] };
  }
  if (parsed.ast === null || parsed.parseQuality !== "complete")
    return { evidence: { ...evidence, status: "partial" }, metrics: null, hotspots: [] };
  try {
    const measured = measureParsedProductFile(
      adapter,
      parsed.ast,
      filePath,
      read.contentHash,
      read.text,
    );
    signal?.throwIfAborted();
    const after = await readFreshProductFile(inventory, filePath, signal);
    if (after.status !== "resolved")
      return unresolvedMeasurement(filePath, after, file.contentHash);
    const scopeLimitations = parsed.diagnostics
      .filter((diagnostic) => diagnostic.code === "analysis_scope_limited")
      .map((diagnostic) => `${filePath}: ${diagnostic.message}`);
    if (adapter.languageId === "vue")
      scopeLimitations.push(
        `${filePath}: File-level SLOC covers the original SFC including markup/styles; control-flow metrics cover inline scripts.`,
      );
    return {
      evidence: { ...evidence, status: "measured" },
      ...measured,
      ...(scopeLimitations.length === 0
        ? {}
        : { limitations: [...new Set([...(measured.limitations ?? []), ...scopeLimitations])] }),
    };
  } catch (error) {
    rethrowCancellation(error, signal);
    return { evidence: { ...evidence, status: "invalid_metrics" }, metrics: null, hotspots: [] };
  }
}

export function aggregateProductMeasurements(
  paths: readonly string[],
  measurements: ReadonlyMap<string, ProductFileMeasurement>,
): ProductCodeMetricsV1 | null {
  const total = emptyProductMetrics();
  for (const filePath of [...new Set(paths)].sort(compareCodepoints)) {
    const measured = measurements.get(filePath);
    if (
      measured === undefined ||
      measured.evidence.status !== "measured" ||
      measured.metrics === null ||
      measured.metrics.metricsVersion !== METRICS_VERSION ||
      measured.metrics.cognitiveAlgorithm !== COGNITIVE_ALGORITHM_ID
    )
      return null;
    addProductMetrics(total, measured.metrics);
  }
  return total;
}
