/**
 * Contracts of `untangle init` (WP-125).
 *
 * `init` is the first command a user ever runs, so it has exactly one job:
 * understand a foreign project WITHOUT asking, and write down what it
 * understood in a form the user can read and correct.
 *
 * Everything the command learns lands in `ProjectFindingsV1`. Rendering,
 * comparison and reporting are pure functions over that value — which is why
 * the whole command is testable without a network, without a container and
 * without `node:fs` (every read goes through `FileSystemPort`, every probe
 * through `HttpProbePort`).
 *
 * DETERMINISMUS: `ProjectFindingsV1` is result data. It carries no wall-clock
 * time and no random value, and every list in it is sorted by an explicit,
 * documented comparator (never `String#localeCompare`). Two runs over an
 * unchanged project MUST produce byte-identical findings — that is what makes
 * the idempotency check in `diff.ts` a comparison of substance rather than of
 * noise.
 */

import type { ProductAlignmentReportV1, SkipLedgerV1 } from "@untangle-code/domain";

import type { ProductContextAssessmentV1 } from "./product-context.js";

/** One language, weighted by the lines of code found in it. */
export interface LanguageCensusEntryV1 {
  /** Scanner language id (`typescript`, `python`, …) or `"unknown"`. */
  languageId: string;
  fileCount: number;
  lineCount: number;
  byteCount: number;
  /** Share of `lineCount` across all entries, rounded to four decimals. */
  lineShare: number;
  /**
   * True when `@untangle-code/parser-registry` has an adapter for this
   * language — i.e. whether symbols, imports and complexity are available for
   * it, or only text search.
   */
  hasParserAdapter: boolean;
  /**
   * GEMESSENE Unterstuetzungsstufe, wenn es einen Adapter gibt (WP-240).
   *
   * Nicht die Konstante aus der Sprachtabelle: `init` laesst den Adapter ein
   * Wort parsen und damit seine Grammatik laden. Fehlt sie auf dieser
   * Maschine, steht hier "text" — und {@link declaredSupportLevel} sagt,
   * was der Adapter behauptet hatte.
   */
  supportLevel?: string;
  /** Nur wenn die Messung die Behauptung widerlegt hat: die Behauptung. */
  declaredSupportLevel?: string;
  /** Nur dann: der benannte Grund, warum die Grammatik nicht geladen werden konnte. */
  grammarUnavailableReason?: string;
}

/**
 * One reason the scanner excluded paths, with how often it applied.
 *
 * These are COUNTS, not skip-ledger entries, and that is deliberate. An
 * exclusion by `.gitignore`, by the default excludes or by the binary
 * classifier is the configured scope of the scan, not content lost without a
 * reason — E4 is satisfied by naming the reason and the magnitude in the
 * open. Entries in `ProjectFindingsV1.skipped` are reserved for the
 * genuinely surprising cases (unreadable file, symlink escape, size limit),
 * which stay few enough to list individually.
 */
export interface ExclusionCountV1 {
  reason: string;
  count: number;
}

/** The whole language picture of a project. */
export interface LanguageCensusV1 {
  /** Sorted by `lineCount` descending, ties broken by `languageId` codepoints. */
  entries: LanguageCensusEntryV1[];
  totalFiles: number;
  totalLines: number;
  /** Share of lines that a deep parser adapter can actually analyse. */
  parsedLineShare: number;
  /** True when the scan stopped at `InitLimitsV1.maxFilesScanned`. */
  truncated: boolean;
  /** Codepoint-sorted by `reason`. */
  excluded: ExclusionCountV1[];
}

/** A monorepo sub-project on the coarse level: a workspace package. */
export interface DetectedPackageV1 {
  name: string;
  /** Repo-relative directory, `""` for the repository root. */
  directory: string;
  /** Names of other workspace packages this one depends on. */
  workspaceDependencyCount: number;
}

/** A monorepo sub-project on the coarse level: a container service. */
export interface DetectedServiceV1 {
  name: string;
  /** Repo-relative path of the composition file it was declared in. */
  composeFile: string;
  buildContext?: string;
  image?: string;
  dependsOn: string[];
}

/**
 * Markers of workspace managers.
 *
 * `pnpm-workspace.yaml` and `package.json#workspaces` are read by
 * `@untangle-code/file-graph` itself and end up in `packages`. The other three
 * are only DETECTED here, never re-implemented: when one of them declares a
 * package layout that the topology did not find, that is reported as a gap
 * (E4), not papered over with a second package discovery.
 */
export interface WorkspaceManagerMarkersV1 {
  /** Manager marker files found at the repository root, codepoint-sorted. */
  markerFiles: string[];
  /** Globs declared by `lerna.json#packages`, codepoint-sorted. */
  lernaGlobs: string[];
  /**
   * Marker files that declare or imply a package layout which the topology
   * pass did not cover. Non-empty means: believe the report, not the config.
   */
  uncoveredByTopology: string[];
}

/** The coarse, above-the-files level of a project. */
export interface TopologyFindingsV1 {
  /** Globs of the workspace definition, codepoint-sorted. */
  workspaceGlobs: string[];
  /** Codepoint-sorted by (name, directory). */
  packages: DetectedPackageV1[];
  /** Codepoint-sorted by (composeFile, name). */
  services: DetectedServiceV1[];
  packageEdgeCount: number;
  serviceEdgeCount: number;
  managers: WorkspaceManagerMarkersV1;
  /** True when either level found more than one member. */
  isMonorepo: boolean;
}

/** What the ignore pass decided. */
export interface IgnoreFindingsV1 {
  gitignorePresent: boolean;
  /** Number of effective (non-empty, non-comment) rules in the root `.gitignore`. */
  gitignoreRuleCount: number;
  /** Negation rules (`!…`) seen and deliberately NOT lifted into the config. */
  gitignoreNegationCount: number;
  untangleIgnorePresent: boolean;
  /** The built-in defaults, spelled out so the user can see and override them. */
  defaultExcludes: string[];
  /**
   * Directory rules taken from `.gitignore` that the defaults do not already
   * cover, codepoint-sorted. These get pinned into the config because they are
   * project-specific build output the defaults cannot know about.
   */
  additionalExcludes: string[];
}

/** One reachable embedding model as the provider itself describes it. */
export interface EmbeddingModelInfoV1 {
  name: string;
  /** Vector width the provider reports; `undefined` when it does not say. */
  dimensions?: number;
  /** Context window the provider reports; `undefined` when it does not say. */
  contextLength?: number;
}

/** Result of probing one endpoint. */
export type ProbeOutcome = "reachable" | "unreachable" | "not-probed";

/**
 * Outcome of the embedding probe (WP-228).
 *
 * `timeout` is deliberately its OWN value, separate from `failed`: an
 * endpoint that answers "no" is a different thing from an endpoint that does
 * not answer at all, and only the second one is the failure mode that made
 * `untangle index` hang.
 */
export type EmbedProbeOutcome = "ok" | "timeout" | "failed" | "not-probed";

/**
 * What `/api/embed` — the endpoint indexing actually uses — answered.
 *
 * WHY THIS EXISTS: `init` used to call the provider "erreichbar" on the
 * strength of `/api/tags` alone. On the machine this was measured on,
 * `/api/tags` answered instantly while `/api/embed` hung indefinitely, so
 * the configuration promised a working service that could not embed a single
 * chunk. A reachability check that never touches the endpoint the product
 * uses claims more than it knows (E4).
 *
 * NO DURATION IS RECORDED — only the outcome and the deadline that applied.
 * A measured millisecond count would make `ProjectFindingsV1`
 * non-reproducible, and the file `init` writes is supposed to be identical
 * across two runs over an unchanged project.
 */
export interface EmbedProbeFindingsV1 {
  outcome: EmbedProbeOutcome;
  /** The deadline that applied, in milliseconds. */
  timeoutMs: number;
  /** Vector width of the probe embedding when the endpoint answered. */
  dimensions?: number;
  /** Why it was not `ok`; short, no secrets, no timings. */
  detail?: string;
}

export interface OllamaFindingsV1 {
  outcome: ProbeOutcome;
  url: string;
  /** Server version string when reachable. */
  version?: string;
  /** Every embedding-capable model, codepoint-sorted by name. */
  embeddingModels: EmbeddingModelInfoV1[];
  /** The model `init` chose, and why — see `services.ts` `chooseEmbeddingModel`. */
  chosenModel?: EmbeddingModelInfoV1;
  chosenReason?: string;
  /** What `/api/embed` answered for the chosen model (WP-228). */
  embedProbe: EmbedProbeFindingsV1;
}

export interface QdrantFindingsV1 {
  outcome: ProbeOutcome;
  /** URLs actually probed, in probe order. */
  probedUrls: string[];
  /** The first reachable URL. */
  url?: string;
  version?: string;
  /**
   * URLs deliberately NOT probed, with the reason. spec.md §3.2 forbids
   * touching third-party instances; a port that is known to host somebody
   * else's data is skipped rather than adopted (E4: with a reason, in the
   * open).
   */
  skippedUrls: { url: string; reason: string }[];
}

/** Local storage inspection is read-only; init never creates an index directory. */
export interface StorageFindingsV1 {
  backend: "lancedb" | "qdrant";
  path?: string;
  directory?: string;
  directoryStatus?: "present" | "missing" | "not-directory" | "unreadable";
  detail?: string;
  configurationWarnings?: string[];
  qdrantMode?: "managed" | "external";
  qdrantUrl?: string;
}

/** Everything `init` learned about a project. Pure data, no I/O. */
export interface ProjectFindingsV1 {
  schemaVersion: 1;
  /** Absolute, canonical repository root. */
  root: string;
  /** Derived from the root directory name; the config's `projectId`. */
  projectId: string;
  languages: LanguageCensusV1;
  topology: TopologyFindingsV1;
  /** Source-backed intent inventory; semantic feature alignment stays unverified. */
  productContext?: ProductContextAssessmentV1;
  /** Explicit feature boundaries and evidence; never inferred from embeddings. */
  featureAlignment?: ProductAlignmentReportV1;
  ignore: IgnoreFindingsV1;
  ollama: OllamaFindingsV1;
  qdrant: QdrantFindingsV1;
  /** Absent only in older findings supplied through the library API. */
  storage?: StorageFindingsV1;
  /** Everything skipped during discovery, with a reason (E4). */
  skipped: SkipLedgerV1;
}

/** Budgets. Without them a pathological repository never finishes. */
export interface InitLimitsV1 {
  /** Files whose lines are counted before the census reports itself truncated. */
  maxFilesScanned: number;
  /** Directory depth the topology pass descends. */
  maxTopologyDepth: number;
  /** Directories the topology pass visits. */
  maxTopologyDirectories: number;
  /** Per-file byte ceiling handed to the scanner. */
  maxFileSizeBytes: number;
  /** Bounded parallelism of the line-count stage. */
  concurrency: number;
  /** Timeout of a single infrastructure probe. */
  probeTimeoutMs: number;
  /**
   * Timeout of the embedding probe (WP-228). Longer than a plain GET,
   * because the provider may have to load the model first — and still short,
   * because `init` is a command a user waits for.
   */
  embedProbeTimeoutMs: number;
  /** Languages listed individually in the report and the file's comments. */
  reportedLanguages: number;
}

export const DEFAULT_INIT_LIMITS: InitLimitsV1 = {
  maxFilesScanned: 50_000,
  maxTopologyDepth: 12,
  maxTopologyDirectories: 20_000,
  maxFileSizeBytes: 5 * 1024 * 1024,
  concurrency: 8,
  probeTimeoutMs: 2_000,
  embedProbeTimeoutMs: 8_000,
  reportedLanguages: 12,
};

/** What one embedding probe answered. Never a throw — always an answer. */
export type EmbedProbeResult =
  | { readonly ok: true; readonly dimensions: number }
  | { readonly ok: false; readonly timedOut: boolean; readonly detail: string };

/**
 * Read-only HTTP probe port.
 *
 * `null` for every failure — a probe that cannot reach an endpoint is an
 * ANSWER ("not there"), not an exception. Deliberately NOT a general HTTP
 * client: `init` must be incapable of mutating a foreign service
 * (spec.md §3.2). It has exactly two verbs, and neither of them can change
 * anything:
 *
 * - {@link getJson} — a GET.
 * - {@link probeEmbedding} — the ONE POST this command may make (WP-228):
 *   the embedding of a fixed, tiny probe text. It is a POST only because
 *   that is the shape of the endpoint; it writes nothing, creates nothing
 *   and deletes nothing. It is also exactly the call `untangle index` is
 *   about to make thousands of times — which is the whole point: an
 *   "erreichbar" that never touched this endpoint was a claim about a
 *   different endpoint.
 */
export interface HttpProbePort {
  getJson(url: string, timeoutMs: number): Promise<unknown | null>;
  probeEmbedding(baseUrl: string, model: string, timeoutMs: number): Promise<EmbedProbeResult>;
}

/** What `init` did to the file on disk. */
export type InitOutcome =
  | "created"
  | "unchanged"
  | "overwritten"
  | "differs"
  | "would-create"
  | "would-be-unchanged"
  | "would-overwrite";

export interface InitResultV1 {
  outcome: InitOutcome;
  /** Absolute path of the configuration file. */
  configPath: string;
  findings: ProjectFindingsV1;
  /** The rendered `untangle.toml` text, always produced, even for `--dry-run`. */
  rendered: string;
  /** Non-empty only for `differs`/`would-overwrite`: what the file would gain and lose. */
  changes: ConfigChangeV1[];
  /** Exactly one sentence naming the single next thing to do. */
  nextStep: string;
  /** Schema warnings from `@untangle-code/config`'s validator, if any. */
  configWarnings: string[];
  /** Schema errors from `@untangle-code/config`'s validator, if any. */
  configErrors: string[];
  exitCode: number;
}

/** One line-level difference between the file on disk and a fresh render. */
export interface ConfigChangeV1 {
  kind: "added" | "removed";
  /** The line itself, trimmed of trailing whitespace. */
  line: string;
}
