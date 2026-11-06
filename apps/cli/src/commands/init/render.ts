/**
 * Rendering `untangle.toml`.
 *
 * The file is the deliverable of `untangle init`, and its comments are not
 * decoration: they are the record of what was decided and on what evidence.
 * A user opening this file must be able to answer "why is `dimensions` 1024?"
 * without reading the source of the tool that wrote it.
 *
 * DETERMINISM: this function is pure over `ProjectFindingsV1` and
 * `ConfigDraftV1`. No clock, no random, no environment. That is what makes
 * the idempotency check a real comparison — a second run over an unchanged
 * project renders byte-identical text, so any difference the diff reports is
 * a difference in the PROJECT or in the file, never in the writer.
 */

import { PRODUCT_DEFAULT_CONFIG } from "@untangle-code/config";
import type { RawConfigLayer } from "@untangle-code/config";

import type { ConfigDraftV1 } from "./config-draft.js";
import { TomlWriter } from "./toml.js";
import type { InitLimitsV1, LanguageCensusEntryV1, ProjectFindingsV1 } from "./types.js";

const RULE = "-".repeat(72);

/** Formats a share as a percentage with one decimal, e.g. `62.4 %`. */
export function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)} %`;
}

/** `12345` → `12.345` (dot as thousands separator, the German convention). */
export function formatCount(value: number): string {
  return value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/gu, ".");
}

/**
 * Der Befund ueber `/api/embed` in der Sprache der Datei (WP-228).
 *
 * Getrennt vom Terminalbericht, weil die Datei laenger lebt als das
 * Terminal: hier steht auch die Frist, gegen die geprueft wurde, damit ein
 * spaeterer Leser den Befund einordnen kann.
 */
export function describeEmbedProbeForFile(ollama: ProjectFindingsV1["ollama"]): string {
  const probe = ollama.embedProbe;
  switch (probe.outcome) {
    case "ok":
      return `Embedding endpoint /api/embed checked: responded${probe.dimensions === undefined ? "" : ` (${formatCount(probe.dimensions)} dimensions)`}, deadline ${formatCount(probe.timeoutMs)} ms.`;
    case "timeout":
      return `Embedding endpoint /api/embed did not respond within ${formatCount(probe.timeoutMs)} ms. "Reachable" above refers only to /api/tags; indexing cannot use it. Alternative: untangle index --embedder=offline.`;
    case "failed":
      return `Embedding endpoint /api/embed failed: ${probe.detail ?? "no details"}. Alternative: untangle index --embedder=offline.`;
    default:
      return `Embedding endpoint /api/embed not checked: ${probe.detail ?? "no details"}.`;
  }
}

function describeLanguage(entry: LanguageCensusEntryV1): string {
  // WP-240: steht hier eine widerlegte Behauptung, wird sie BENANNT statt
  // ersetzt. "Parser: text" allein liesse den Leser glauben, diese Sprache
  // sei nie mehr gewesen als Text; sie war als "deep" angekuendigt, und dass
  // sie es hier nicht ist, ist die Nachricht.
  const coverage =
    entry.declaredSupportLevel === undefined
      ? entry.hasParserAdapter
        ? `Parser: ${entry.supportLevel ?? "available"}`
        : "no parser; text search only"
      : `Parser: ${entry.supportLevel ?? "text"} — "${entry.declaredSupportLevel}" declared, ` +
        "grammar unavailable here";
  return `${entry.languageId.padEnd(12)} ${formatShare(entry.lineShare).padStart(7)}  ${formatCount(entry.lineCount).padStart(9)} Lines  ${formatCount(entry.fileCount).padStart(6)} files  (${coverage})`;
}

export interface RenderInput {
  findings: ProjectFindingsV1;
  draft: ConfigDraftV1;
  limits: InitLimitsV1;
  nextStep: string;
}

export function renderUntangleToml(input: RenderInput): string {
  const { findings, draft, limits, nextStep } = input;
  const writer = new TomlWriter();

  renderHeader(writer, findings, limits);
  renderIdentity(writer, draft.layer);
  renderRepositories(writer, findings, draft.layer);
  renderStorage(writer, findings, draft.layer);
  renderQdrant(writer, findings, draft.layer);
  renderEmbeddings(writer, findings, draft.layer);
  renderIndex(writer, draft.layer);
  renderGraph(writer, findings, draft.layer);
  renderTelemetry(writer, draft.layer);
  renderContextArtifacts(writer, draft.layer);
  renderFooter(writer, nextStep);

  return writer.render();
}

function renderHeader(writer: TomlWriter, findings: ProjectFindingsV1, limits: InitLimitsV1): void {
  writer.comments([
    RULE,
    "untangle.toml — written by `untangle init`.",
    "",
    "This file is a proposal, not a mandate. Every value may be edited by hand.",
    "`untangle init` overwrites it only with --force and first reports",
    "what would differ. Omitted settings come from product defaults",
    "(spec.md §4.1, lowest layer). This file deliberately lists only",
    "decisions made by init, rather than every default.",
    RULE,
    "",
    "FINDING 1 — LANGUAGES (weighted by lines)",
  ]);

  const languages = findings.languages;
  if (languages.entries.length === 0) {
    writer.comment("  no analyzable files found");
  } else {
    for (const entry of languages.entries.slice(0, limits.reportedLanguages)) {
      writer.comment(`  ${describeLanguage(entry)}`);
    }
    const rest = languages.entries.length - limits.reportedLanguages;
    if (rest > 0) {
      writer.comment(`  … and ${formatCount(rest)} additional languages`);
    }
  }
  writer.comment(
    `  Total: ${formatCount(languages.totalFiles)} files, ${formatCount(languages.totalLines)} lines; ${formatShare(languages.parsedLineShare)} have a parser (symbols, imports, complexity); the rest support text search only.`,
  );
  if (languages.truncated) {
    writer.comment(
      `  Warning: stopped after ${formatCount(limits.maxFilesScanned)} files; the proportions above describe only this subset.`,
    );
  }
  for (const exclusion of languages.excluded) {
    writer.comment(`  skipped (${exclusion.reason}): ${formatCount(exclusion.count)}`);
  }

  writer.comment("");
  writer.comment("FINDING 2 — TOPOLOGY");
  const topology = findings.topology;
  if (topology.workspaceGlobs.length > 0) {
    writer.comment(`  Workspace-Globs: ${topology.workspaceGlobs.join(", ")}`);
  }
  if (topology.packages.length === 0) {
    writer.comment("  no workspace packages; a single project");
  } else {
    writer.comment(
      `  ${formatCount(topology.packages.length)} packages, ${formatCount(topology.packageEdgeCount)} edges between them:`,
    );
    for (const pkg of topology.packages) {
      writer.comment(`    ${pkg.name} — ${pkg.directory === "" ? "." : pkg.directory}`);
    }
  }
  if (topology.services.length > 0) {
    writer.comment(
      `  ${formatCount(topology.services.length)} container services, ${formatCount(topology.serviceEdgeCount)} edges; the coarser layer above packages:`,
    );
    for (const service of topology.services) {
      const target = service.buildContext ?? service.image ?? "?";
      writer.comment(`    ${service.name} — ${service.composeFile} → ${target}`);
    }
  }
  if (topology.managers.markerFiles.length > 0) {
    writer.comment(`  Tool markers: ${topology.managers.markerFiles.join(", ")}`);
  }
  for (const uncovered of topology.managers.uncoveredByTopology) {
    writer.comment(
      `  GAP: ${uncovered} declares a package layout missing from the discovered topology; those subprojects are absent above.`,
    );
  }

  writer.comment("");
  writer.comment("FINDING 3 — INFRASTRUCTURE");
  const ollama = findings.ollama;
  writer.comment(
    ollama.outcome === "reachable"
      ? `  Embedding provider: reachable at ${ollama.url}${ollama.version === undefined ? "" : ` (version ${ollama.version})`}, ${formatCount(ollama.embeddingModels.length)} embedding models`
      : `  Embedding provider: unreachable at ${ollama.url}; configuration is still available.`,
  );
  for (const model of ollama.embeddingModels) {
    const marker = model.name === ollama.chosenModel?.name ? "→" : " ";
    writer.comment(
      `   ${marker} ${model.name} (${model.dimensions === undefined ? "unknown width" : `${formatCount(model.dimensions)} dimensions`}, ${model.contextLength === undefined ? "unknown context" : `${formatCount(model.contextLength)} context`})`,
    );
  }
  if (ollama.chosenReason !== undefined) {
    writer.comment(`     selected because: ${ollama.chosenReason}`);
  }
  // WP-228: Der Befund ueber den Endpunkt, den der Indexlauf wirklich
  // benutzt. Er steht auch dann in der Datei, wenn er gut ausfiel — sonst
  // liesse sich spaeter nicht unterscheiden, ob er gut ausfiel oder fehlte.
  writer.comment(`  ${describeEmbedProbeForFile(ollama)}`);
  if (findings.storage?.backend === "lancedb") {
    writer.comment(
      `  Vector store: embedded LanceDB at ${findings.storage.directory} (directory ${findings.storage.directoryStatus}).`,
    );
    writer.comment("  No database was opened or created. Docker and Qdrant were not probed.");
  } else {
    const qdrant = findings.qdrant;
    writer.comment(
      qdrant.outcome === "reachable"
        ? `  Vector store: reachable at ${qdrant.url ?? "?"}`
        : `  Vector store: unreachable (checked: ${qdrant.probedUrls.join(", ")}); this is not an error.`,
    );
    for (const skipped of qdrant.skippedUrls) {
      writer.comment(`  DELIBERATELY NOT CHECKED: ${skipped.url}`);
      writer.comment(`     ${skipped.reason}`);
    }
  }

  writer.comment("");
  writer.comment("FINDING 4 — IGNORE RULES");
  const ignore = findings.ignore;
  writer.comment(
    ignore.gitignorePresent
      ? `  .gitignore: ${formatCount(ignore.gitignoreRuleCount)} rules. The scanner evaluates them on every run (spec.md §6.2); they are not duplicated here, avoiding divergence.`
      : "  .gitignore: none found. Only the defaults below apply.",
  );
  if (ignore.gitignoreNegationCount > 0) {
    writer.comment(
      `  ${formatCount(ignore.gitignoreNegationCount)} negation rules (!…) deliberately remain there; removing their original ordering would reverse their meaning.`,
    );
  }
  if (ignore.untangleIgnorePresent) {
    writer.comment("  .untangleignore found; takes precedence over .gitignore.");
  }

  renderProductContextFinding(writer, findings);
  renderFeatureAlignmentFinding(writer, findings);

  if (findings.skipped.entries.length > 0) {
    writer.comment("");
    writer.comment(
      `FINDING 5 — SKIPPED WITH REASONS (${formatCount(findings.skipped.entries.length)} entries)`,
    );
    for (const entry of findings.skipped.entries.slice(0, 20)) {
      writer.comment(
        `  [${entry.reason}] ${entry.path ?? entry.subjectId ?? "-"}: ${entry.detail}`,
      );
    }
    if (findings.skipped.entries.length > 20) {
      writer.comment(
        `  … ${formatCount(findings.skipped.entries.length - 20)} more; complete list in \`untangle init --format json\`.`,
      );
    }
  }

  writer.comment(RULE);
  writer.blank();
}

function renderFeatureAlignmentFinding(writer: TomlWriter, findings: ProjectFindingsV1): void {
  const alignment = findings.featureAlignment;
  if (alignment === undefined) return;
  writer.comments([
    "",
    "FEATURE EVIDENCE — DECLARED PRODUCT BOUNDARIES",
    `  Status: ${alignment.status}; manifest ${JSON.stringify(alignment.manifest.path)} (${alignment.manifest.status}).`,
    `  Semantic conformance: ${alignment.semanticConformance}; ownership authority: ${alignment.ownershipAuthority}.`,
    "  Full report and agent hints: untangle product --format=json. No feature map is written.",
  ]);
  for (const feature of alignment.features) {
    writer.comment(
      `  ${JSON.stringify(feature.id)}: ${feature.status}; review ${feature.review}; test evidence ${feature.testEvidence.status}.`,
    );
    writer.comment(
      `    Ownership: ${feature.ownership.map((owner) => `${JSON.stringify(owner.id)}:${owner.status}`).join(", ") || "none"}.`,
    );
    if (feature.code.metrics !== null) {
      const cognitive = feature.code.metrics.cognitive;
      writer.comment(
        `    Code cognitive: execution_unit=${String(cognitive.execution_unit)}, self=${String(cognitive.self)}, top_level=${String(cognitive.top_level)}.`,
      );
    }
    for (const hint of feature.agentHints) {
      writer.comment(`    Hint ${hint.code}: ${hint.message.replace(/[\r\n]/gu, " ")}`);
    }
  }
  for (const limitation of alignment.limitations) {
    writer.comment(`  Limit: ${limitation.replace(/[\r\n]/gu, " ")}`);
  }
}

function renderProductContextFinding(writer: TomlWriter, findings: ProjectFindingsV1): void {
  const productContext = findings.productContext;
  if (productContext === undefined) return;
  writer.comments([
    "",
    "PRODUCT CONTEXT — LOCAL DOCUMENT INSPECTION",
    `  Status: ${productContext.status}; features and ownership remain unconfirmed.`,
  ]);
  for (const source of productContext.sources) {
    writer.comment(
      `  ${source.role}: ${JSON.stringify(source.path)} — ${source.status}${source.selected ? ", selected" : ", not selected"}; SHA-256: ${source.contentHash ?? "unavailable"}`,
    );
  }
  for (const warning of productContextWarnings(findings)) {
    writer.comment(`  WARNING: ${warning}`);
  }
  writer.comment("  Review draft: no confirmed features or ownership.");
  for (const question of productContext.reviewDraft.questions) {
    writer.comment(`  Open question: ${question.replace(/[\r\n]/gu, " ")}`);
  }
}

/** Same bounded findings in the configuration comments and terminal report. */
export function productContextWarnings(findings: ProjectFindingsV1): string[] {
  const productContext = findings.productContext;
  if (productContext === undefined) return [];
  const warnings = ["Semantic conformance unverified; features and ownership unconfirmed."];
  if (productContext.missingRoles.length > 0) {
    warnings.push(`Missing product sources: ${productContext.missingRoles.join(", ")}.`);
  }
  if (productContext.ambiguousRoles.length > 0) {
    warnings.push(`Ambiguous source selection: ${productContext.ambiguousRoles.join(", ")}.`);
  }
  if (productContext.status === "incomplete") {
    warnings.push("Product evidence incomplete; inspect read errors, limits and changed sources.");
  }
  for (const limitation of productContext.limitations) {
    warnings.push(limitation.replace(/[\r\n]/gu, " "));
  }
  return warnings;
}

function renderIdentity(writer: TomlWriter, layer: RawConfigLayer): void {
  writer.comments([
    "This file's schema version. `untangle` reads it and migrates older",
    "versions automatically; manual version increments are never required.",
  ]);
  writer.scalar("schemaVersion", 1);
  writer.comment("Derived from the directory name. Editable; it only identifies this project.");
  writer.scalar("projectId", layer.projectId ?? "project");
  writer.blank();
}

function renderRepositories(
  writer: TomlWriter,
  findings: ProjectFindingsV1,
  layer: RawConfigLayer,
): void {
  const repository = layer.repositories?.[0];
  if (repository === undefined) {
    return;
  }
  writer.comments([
    RULE,
    "REPOSITORIES",
    "",
    "One entry per Git repository, not per package: the packages and services in",
    "finding 2 all belong to this repository and are rediscovered",
    "automatically during indexing. Add a second repository (a neighboring project or",
    "a shared library repository) as another [[repositories]] block;",
    "as another entry; `path` is relative to this file or absolute.",
    RULE,
  ]);
  writer.arrayTable(["repositories"]);
  writer.scalar("id", repository.id ?? findings.projectId);
  writer.scalar("path", repository.path ?? ".");
  if (repository.label !== undefined) {
    writer.scalar("label", repository.label);
  }
  writer.blank();
  writer.comments([
    "Content excluded from indexing. The list is explicit because",
    "defaults may be wrong for a project whose authored",
    "sources live in build/; such a project must be able to remove this entry.",
  ]);
  const additional = findings.ignore.additionalExcludes;
  if (additional.length > 0) {
    writer.comment(
      `Added from .gitignore because product defaults could not know them: ${additional.join(", ")}`,
    );
  }
  writer.array("exclude", repository.exclude ?? []);
  writer.blank();
}

function renderStorage(
  writer: TomlWriter,
  findings: ProjectFindingsV1,
  layer: RawConfigLayer,
): void {
  const storage = layer.storage;
  if (storage === undefined) return;
  const backend = storage.backend ?? "lancedb";
  writer.comments([
    RULE,
    "SEARCH STORAGE",
    backend === "lancedb"
      ? "Embedded LanceDB stores local search data without Docker or a running service."
      : "Qdrant was explicitly selected; its server configuration follows below.",
    "Changing backend selects a separate index. Rebuild it with `untangle index`.",
    RULE,
  ]);
  writer.table(["storage"]);
  writer.scalar("backend", backend);
  if (backend === "lancedb" && storage.path !== undefined) {
    writer.comment(
      "Relative to this project root. The directory is created only when indexing writes data.",
    );
    writer.scalar("path", storage.path);
    writer.comment(
      `Inspection: ${findings.storage?.directoryStatus ?? "not inspected"}; no database was opened.`,
    );
  }
  writer.blank();
}

function renderQdrant(
  writer: TomlWriter,
  findings: ProjectFindingsV1,
  layer: RawConfigLayer,
): void {
  const qdrant = layer.qdrant;
  if (qdrant === undefined) {
    return;
  }
  writer.comments([
    RULE,
    "VECTOR STORE",
    "",
    qdrant.mode === "external"
      ? "An external Qdrant endpoint was selected at the address below."
      : "An owned Qdrant endpoint was selected. Plain init starts no containers.",
    qdrant.mode === "external"
      ? findings.qdrant.outcome === "reachable"
        ? "The server responded during discovery. Untangle writes only owned collections."
        : "The server is not currently reachable; selecting it does not start a service."
      : "Guided setup can prepare or explicitly execute an isolated service recipe.",
    qdrant.mode === "external"
      ? "Only collections with the configured prefix belong to this project."
      : "A foreign instance is never taken over (spec.md §3.2).",
    RULE,
  ]);
  writer.table(["qdrant"]);
  writer.scalar("mode", qdrant.mode ?? "managed");
  if (qdrant.url !== undefined) {
    writer.scalar("url", qdrant.url);
  } else {
    writer.comment('url = "http://127.0.0.1:16333"   # owned instance, once running');
  }
  writer.comment("Separates this project from others on the same instance.");
  writer.scalar("collectionPrefix", qdrant.collectionPrefix ?? "untangle_");
  writer.comment("API keys are never stored here; only the environment variable name:");
  writer.comment('apiKeyEnv = "UNTANGLE_QDRANT_API_KEY"');
  if (findings.qdrant.skippedUrls.length > 0) {
    writer.blank();
    for (const skipped of findings.qdrant.skippedUrls) {
      writer.comment(`Not checked: ${skipped.url} — ${skipped.reason}`);
    }
  }
  writer.blank();
}

function renderEmbeddings(
  writer: TomlWriter,
  findings: ProjectFindingsV1,
  layer: RawConfigLayer,
): void {
  const embeddings = layer.embeddings;
  if (embeddings === undefined) {
    return;
  }
  const reachable =
    findings.ollama.outcome === "reachable" && findings.ollama.chosenModel !== undefined;
  writer.comments([
    RULE,
    "EMBEDDINGS",
    "",
    reachable
      ? "The model, vector width and context window come from the provider's"
      : "No provider responded, so this uses the default profile and",
    reachable
      ? "own report (/api/tags), rather than guesses."
      : '`mode = "auto"`: the next run discovers a provider automatically.',
    "",
    "Important: `dimensions` determines the collection width. If the model is",
    "changed later, reindexing is required; `untangle` detects the",
    "conflict before the first write and aborts instead of mixing incompatible data.",
    RULE,
  ]);
  writer.table(["embeddings"]);
  writer.scalar("provider", embeddings.provider ?? "ollama");
  writer.scalar("mode", embeddings.mode ?? "auto");
  if (embeddings.url !== undefined) {
    writer.scalar("url", embeddings.url);
  }
  if (findings.ollama.chosenReason !== undefined) {
    writer.comment(`Selected because: ${findings.ollama.chosenReason}.`);
  }
  if (findings.ollama.embeddingModels.length > 1) {
    writer.comment(
      `Also available: ${findings.ollama.embeddingModels
        .filter((model) => model.name !== findings.ollama.chosenModel?.name)
        .map((model) => model.name)
        .join(", ")}`,
    );
  }
  writer.scalar("model", embeddings.model ?? "");
  writer.comment(
    reachable
      ? "Provider-reported vector width (embedding_length), not an assumption."
      : "Product default, replaced on the next run with an available provider.",
  );
  writer.scalar("dimensions", embeddings.dimensions ?? 0);
  writer.comment(
    reachable ? "Provider-reported context window (context_length)." : "Product default.",
  );
  writer.scalar("contextLength", embeddings.contextLength ?? 0);
  writer.blank();
}

function renderIndex(writer: TomlWriter, layer: RawConfigLayer): void {
  const index = layer.index;
  if (index === undefined) {
    return;
  }
  const defaults = PRODUCT_DEFAULT_CONFIG.index;
  writer.comments([
    RULE,
    "INDEX",
    "",
    "Only the two settings that commonly need a decision. Other settings",
    `(chunk sizes, concurrency, checkpoint interval, for example`,
    `targetChunkTokens = ${String(defaults?.targetChunkTokens ?? 0)}, scanConcurrency = ${String(defaults?.scanConcurrency ?? 0)})`,
    "come from product defaults and may be added here.",
    RULE,
  ]);
  writer.table(["index"]);
  writer.comment("Larger files are not read and receive a skip-ledger entry.");
  writer.scalar("maxFileSizeMb", index.maxFileSizeMb ?? 5);
  writer.comment("Track filesystem changes rather than waiting for the next run.");
  writer.scalar("watch", index.watch ?? true);
  writer.blank();
}

function renderGraph(writer: TomlWriter, findings: ProjectFindingsV1, layer: RawConfigLayer): void {
  const graph = layer.graph;
  if (graph === undefined) {
    return;
  }
  writer.comments([
    RULE,
    "GRAPH",
    "",
    findings.topology.isMonorepo
      ? `This project contains several subprojects (${String(findings.topology.packages.length)} packages, ${String(findings.topology.services.length)} services); the graph`
      : "A single project also has a dependency graph; it is simply",
    findings.topology.isMonorepo
      ? "also identifies dependencies between subprojects."
      : "shallower. It answers which dependents may break when this file changes.",
    RULE,
  ]);
  writer.table(["graph"]);
  writer.scalar("enabled", graph.enabled ?? true);
  writer.blank();
}

function renderTelemetry(writer: TomlWriter, layer: RawConfigLayer): void {
  const telemetry = layer.telemetry;
  if (telemetry === undefined) {
    return;
  }
  writer.comments([
    RULE,
    "TELEMETRY",
    "",
    "Disabled. Listed explicitly so it is clear that",
    "nothing leaves the device (spec.md §24).",
    RULE,
  ]);
  writer.table(["telemetry"]);
  writer.scalar("enabled", telemetry.enabled ?? false);
  writer.blank();
}

function renderFooter(writer: TomlWriter, nextStep: string): void {
  writer.comments([RULE, `NEXT STEP: ${nextStep}`, RULE]);
}

function renderContextArtifacts(writer: TomlWriter, layer: RawConfigLayer): void {
  const artifacts = layer.contextArtifacts ?? [];
  if (artifacts.length === 0) return;
  writer.comments([
    RULE,
    "PRODUKTQUELLEN",
    "Selected readable documents for provisional product context.",
    "Paths are relative to this file; this entry confirms no features.",
    RULE,
  ]);
  for (const artifact of artifacts) {
    writer.arrayTable(["contextArtifacts"]);
    writer.scalar("name", artifact.name ?? "");
    writer.scalar("path", artifact.path ?? "");
    writer.scalar("description", artifact.description ?? "Provisional product context.");
    writer.scalar("type", artifact.type ?? "markdown");
    writer.blank();
  }
}
