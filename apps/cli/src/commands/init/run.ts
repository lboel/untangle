/**
 * `untangle init` — the command a user runs first.
 *
 * It reads a project, decides, writes one commented file, and names one next
 * step. It asks nothing. Everything it cannot determine becomes a documented
 * finding, never a prompt and never an abort: an absent embedding provider,
 * an absent vector store, an unreadable manifest are all things a
 * configuration can be written AROUND (WP-125).
 *
 * WRITE SAFETY: the file goes to a temporary sibling and is renamed into
 * place, so an interrupted run can never leave half a configuration behind.
 * An existing file is replaced only with `--force`; the run that declines to
 * replace it says exactly which lines would have differed.
 *
 * This module is free of argv and of output formatting — `command.ts` binds
 * it to the CLI shell. That split is what lets the whole command be tested
 * against an in-memory file system and a probe that answers nothing.
 */

import path from "node:path";

import { analyzeProductAlignment } from "@untangle-code/core";
import type { FileSystemPort, ParserRegistry, SkipLedgerEntryV1 } from "@untangle-code/domain";
import { summarizeSkipReasons } from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import type { ScannedFileV1 } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import { OperationalError } from "../../cli/exit.js";
import { qdrantProbePlan } from "../../cli/vector-store-policy.js";

import { buildConfigDraft, deriveProjectId, nextStepFor } from "./config-draft.js";
import { diffLines, toLines } from "./diff.js";
import { nodeHttpProbe, offlineProbe } from "./http-probe.js";
import { detectIgnoreRules } from "./ignore-rules.js";
import { buildLanguageCensus } from "./languages.js";
import { assessProductContext } from "./product-context.js";
import { renderUntangleToml } from "./render.js";
import { DEFAULT_OLLAMA_URL, probeOllama, probeQdrant } from "./services.js";
import { inspectInitStorage } from "./storage.js";
import { detectTopology } from "./topology.js";
import { DEFAULT_INIT_LIMITS } from "./types.js";
import type {
  HttpProbePort,
  InitLimitsV1,
  InitOutcome,
  InitResultV1,
  ProjectFindingsV1,
  StorageFindingsV1,
} from "./types.js";

/** The file `init` writes. */
export const CONFIG_FILE_NAME = "untangle.toml";
/** Suffix of the temporary sibling used for the atomic write. */
export const TEMP_SUFFIX = ".untangle-init-tmp";

/** Ports and overrides. Every one of them has a real default; tests replace them. */
export interface InitDepsV1 {
  fs?: FileSystemPort;
  http?: HttpProbePort;
  parserRegistry?: ParserRegistry;
  env?: Readonly<Record<string, string | undefined>>;
  limits?: Partial<InitLimitsV1>;
  signal?: AbortSignal;
}

export interface InitOptionsV1 {
  /** Absolute directory to initialise. */
  root: string;
  force: boolean;
  dryRun: boolean;
  /** Skip every network probe; the infrastructure counts as absent. */
  offline: boolean;
  /** Explicit selection; otherwise environment and existing configuration apply. */
  storageBackend?: "lancedb" | "qdrant";
  preferredModel?: string;
  /** Product intent sources, relative to the chosen project root. */
  visionPath?: string;
  specPath?: string;
  featureManifestPath?: string;
}

/** The command proper. Returns a result; never writes to a terminal. */
export async function runInit(
  options: InitOptionsV1,
  deps: InitDepsV1 = {},
): Promise<InitResultV1> {
  deps.signal?.throwIfAborted();
  const fs = deps.fs ?? new NodeFileSystem();
  const http = deps.http ?? (options.offline ? offlineProbe() : nodeHttpProbe());
  const parserRegistry = deps.parserRegistry ?? createParserRegistry();
  const env = deps.env ?? process.env;
  const limits: InitLimitsV1 = { ...DEFAULT_INIT_LIMITS, ...deps.limits };

  const root = await canonicalRoot(fs, options.root);
  const storage = await inspectInitStorage(fs, root, options.storageBackend, env, deps.signal);
  const findings = await collectFindings({
    fs,
    http,
    parserRegistry,
    env,
    limits,
    root,
    storage,
    ...(options.preferredModel === undefined ? {} : { preferredModel: options.preferredModel }),
    ...(options.visionPath === undefined ? {} : { visionPath: options.visionPath }),
    ...(options.specPath === undefined ? {} : { specPath: options.specPath }),
    ...(options.featureManifestPath === undefined
      ? {}
      : { featureManifestPath: options.featureManifestPath }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  deps.signal?.throwIfAborted();

  const draft = buildConfigDraft(findings);
  const nextStep = nextStepFor(findings);
  const rendered = renderUntangleToml({ findings, draft, limits, nextStep });
  const configPath = path.join(root, CONFIG_FILE_NAME);

  const base = {
    configPath,
    findings,
    rendered,
    nextStep,
    configWarnings: draft.warnings,
    configErrors: draft.errors,
  };

  if (draft.errors.length > 0) {
    // A configuration the rest of the product would reject is not written at
    // all. Reporting it and stopping is the only honest outcome.
    return { ...base, outcome: "differs", changes: [], exitCode: 1 };
  }

  const existing = await readOptionalText(fs, configPath);
  deps.signal?.throwIfAborted();
  const outcome = decideOutcome(existing, rendered, options);
  const changes =
    existing === null || existing === rendered
      ? []
      : diffLines(toLines(existing), toLines(rendered));

  if (outcome === "created" || outcome === "overwritten") {
    await writeAtomically(fs, configPath, rendered, deps.signal);
  }

  return { ...base, outcome, changes, exitCode: outcome === "differs" ? 1 : 0 };
}

/**
 * The whole decision table of idempotency, in one place.
 *
 * `--dry-run` never writes and never fails: it reports. Without `--force` an
 * existing, differing file is left alone — the second run "meldet, was sich
 * geaendert hat" instead of quietly rewriting a file the user may well have
 * edited on purpose.
 */
export function decideOutcome(
  existing: string | null,
  rendered: string,
  options: Pick<InitOptionsV1, "force" | "dryRun">,
): InitOutcome {
  if (existing === null) {
    return options.dryRun ? "would-create" : "created";
  }
  if (existing === rendered) {
    return options.dryRun ? "would-be-unchanged" : "unchanged";
  }
  if (options.dryRun) {
    return "would-overwrite";
  }
  return options.force ? "overwritten" : "differs";
}

interface CollectInput {
  fs: FileSystemPort;
  http: HttpProbePort;
  parserRegistry: ParserRegistry;
  env: Readonly<Record<string, string | undefined>>;
  limits: InitLimitsV1;
  root: string;
  storage: StorageFindingsV1;
  preferredModel?: string;
  visionPath?: string;
  specPath?: string;
  featureManifestPath?: string;
  signal?: AbortSignal;
}

async function collectFindings(input: CollectInput): Promise<ProjectFindingsV1> {
  const { fs, http, parserRegistry, env, limits, root } = input;
  const skipEntries: SkipLedgerEntryV1[] = [];
  const onSkipEntry = (entry: SkipLedgerEntryV1): void => {
    skipEntries.push(entry);
  };

  // Ignore rules first: their result narrows the scan that follows.
  const ignore = await detectIgnoreRules({ fs, repoRoot: root });
  const files: ScannedFileV1[] = [];

  const languages = await buildLanguageCensus({
    fs,
    parserRegistry,
    repoRoot: root,
    limits,
    additionalExcludes: ignore.additionalExcludes,
    selfManagedPaths: [CONFIG_FILE_NAME, `${CONFIG_FILE_NAME}${TEMP_SUFFIX}`],
    onSkipEntry,
    onDiscoveredFile: (file) => files.push(file),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const topology = await detectTopology({ fs, repoRoot: root, limits, onSkipEntry });
  const productContext = await assessProductContext({
    fs,
    root,
    files,
    inventoryTruncated: languages.truncated,
    ...(input.visionPath === undefined ? {} : { visionPath: input.visionPath }),
    ...(input.specPath === undefined ? {} : { specPath: input.specPath }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const featureAlignment = await analyzeProductAlignment({
    fs,
    root,
    files,
    inventoryTruncated: languages.truncated,
    inventoryExcluded: languages.excluded.reduce((sum, entry) => sum + entry.count, 0),
    inventoryScope: {
      additionalDefaultExcludes: ignore.additionalExcludes,
      maxFileSizeBytes: limits.maxFileSizeBytes,
      maxFilesScanned: limits.maxFilesScanned,
      concurrency: limits.concurrency,
    },
    parserRegistry,
    ...(input.featureManifestPath === undefined ? {} : { manifestPath: input.featureManifestPath }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const probeInput = {
    http,
    limits,
    ollamaUrl: env["UNTANGLE_OLLAMA_URL"] ?? env["UNTANGLE_EMBEDDINGS_URL"] ?? DEFAULT_OLLAMA_URL,
    qdrantUrls: qdrantProbeList({
      ...env,
      ...(input.storage.qdrantUrl === undefined
        ? {}
        : { UNTANGLE_QDRANT_URL: input.storage.qdrantUrl }),
    }),
    ...(input.preferredModel === undefined ? {} : { preferredModel: input.preferredModel }),
  };
  const ollama = await probeOllama(probeInput);
  const qdrant =
    input.storage.backend === "qdrant"
      ? await probeQdrant(probeInput)
      : { outcome: "not-probed" as const, probedUrls: [], skippedUrls: [] };

  return {
    schemaVersion: 1,
    root,
    projectId: deriveProjectId(path.basename(root)),
    languages,
    topology,
    productContext,
    featureAlignment,
    ignore,
    ollama,
    qdrant,
    storage: input.storage,
    skipped: {
      schemaVersion: 1,
      generationId: "untangle-init",
      entries: skipEntries,
      countsByReason: summarizeSkipReasons(skipEntries),
    },
  };
}

/**
 * Which vector-store URLs get probed.
 *
 * WP-222: this no longer decides anything — it asks
 * `cli/vector-store-policy.ts`, the one place that knows which store Untangle
 * may use, and which `untangle doctor` obeys through `wireStorage`. An
 * explicitly configured `UNTANGLE_QDRANT_URL` comes first ("this one is
 * mine"), the managed default follows, and upstream's default port is
 * skipped WITH ITS REASON rather than silently absent (E4).
 */
export function qdrantProbeList(env: Readonly<Record<string, string | undefined>>): string[] {
  return qdrantProbePlan(env).probe;
}

async function canonicalRoot(fs: FileSystemPort, candidate: string): Promise<string> {
  const stat = await fs.stat(candidate);
  if (stat === null) {
    throw new OperationalError(
      `Directory "${candidate}" does not exist.`,
      "Create it or select an existing directory with --root.",
    );
  }
  if (stat.kind !== "directory") {
    throw new OperationalError(
      `"${candidate}" is not a directory.`,
      "init requires a project's root directory.",
    );
  }
  try {
    return await fs.realPath(candidate);
  } catch {
    return candidate;
  }
}

async function readOptionalText(fs: FileSystemPort, filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath);
  if (stat === null || stat.kind !== "file") {
    return null;
  }
  return fs.readTextFile(filePath);
}

/**
 * Temp file plus rename. `rename` is atomic within a directory on every
 * platform Untangle supports, so a reader sees either the old file or the new
 * one — never a truncated one.
 */
async function writeAtomically(
  fs: FileSystemPort,
  filePath: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = `${filePath}${TEMP_SUFFIX}`;
  signal?.throwIfAborted();
  const callOptions = signal === undefined ? undefined : { signal };
  try {
    await fs.writeFile(temporary, new TextEncoder().encode(text), callOptions);
    signal?.throwIfAborted();
    await fs.rename(temporary, filePath, callOptions);
  } catch (error) {
    await fs.remove(temporary).catch(() => undefined);
    signal?.throwIfAborted();
    throw new OperationalError(
      `Writing "${filePath}" failed: ${error instanceof Error ? error.message : String(error)}`,
      `Check write permissions for "${path.dirname(filePath)}".`,
      { cause: error },
    );
  }
}
