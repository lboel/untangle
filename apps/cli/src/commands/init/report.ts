/**
 * The terminal report of `untangle init`.
 *
 * Separate from the file it writes, and deliberately shorter: the file is the
 * record, the report is the answer to "what just happened and what do I do
 * now". It ends in exactly one next step — never a list — because a first
 * command that hands back five errands is a first command nobody finishes.
 *
 * Wall-clock time is allowed in a report (it is not result data), and is
 * still not used here: there is nothing about `init` whose duration a user
 * needs to be told.
 */

import { formatCount, formatShare, productContextWarnings } from "./render.js";
import type { InitResultV1, ProjectFindingsV1 } from "./types.js";

/** Human report. One line per array element, no trailing newline. */
export function formatTextReport(result: InitResultV1): string[] {
  const { findings } = result;
  const lines: string[] = [];

  lines.push(`untangle init — ${findings.root}`);
  lines.push("");

  const languages = findings.languages;
  if (languages.entries.length === 0) {
    lines.push("Languages       no analyzable files found");
  } else {
    const top = languages.entries
      .slice(0, 5)
      .map((entry) => `${entry.languageId} ${formatShare(entry.lineShare)}`)
      .join(", ");
    lines.push(`Languages       ${top}`);
    lines.push(
      `                ${formatCount(languages.totalFiles)} files, ${formatCount(languages.totalLines)} lines; ${formatShare(languages.parsedLineShare)} with a parser`,
    );
    const withoutParser = languages.entries.filter(
      (entry) => !entry.hasParserAdapter && entry.lineShare >= 0.05,
    );
    if (withoutParser.length > 0) {
      lines.push(
        `                no parser (text search only): ${withoutParser.map((entry) => entry.languageId).join(", ")}`,
      );
    }
  }

  const topology = findings.topology;
  lines.push(
    `Topology        ${formatCount(topology.packages.length)} packages, ${formatCount(topology.services.length)} Container-Dienste${topology.isMonorepo ? "; monorepo" : "; single project"}`,
  );
  if (topology.workspaceGlobs.length > 0) {
    lines.push(`                Globs: ${topology.workspaceGlobs.join(", ")}`);
  }
  if (topology.packages.length > 0) {
    lines.push(`                ${topology.packages.map((pkg) => pkg.name).join(", ")}`);
  }
  if (topology.services.length > 0) {
    lines.push(
      `                Services: ${topology.services.map((service) => service.name).join(", ")}`,
    );
  }
  for (const uncovered of topology.managers.uncoveredByTopology) {
    lines.push(`                GAP: ${uncovered} declares packages that were not found`);
  }

  const productContext = findings.productContext;
  if (productContext !== undefined) {
    const readable = productContext.sources.filter(
      (source) => source.selected && source.status === "readable",
    ).length;
    lines.push(
      `Produktkontext  ${formatCount(readable)} selected sources readable; ${productContext.status}; ${formatCount(productContext.reviewDraft.questions.length)} open questions in the review draft`,
    );
    for (const warning of productContextWarnings(findings)) {
      lines.push(`WARNING         ${warning}`);
    }
  }

  const ollama = findings.ollama;
  if (findings.featureAlignment !== undefined) {
    const alignment = findings.featureAlignment;
    lines.push(
      `Feature evidence ${alignment.status}; ${formatCount(alignment.features.length)} declared features; semantic conformance ${alignment.semanticConformance}`,
    );
    for (const feature of alignment.features) {
      lines.push(
        `                ${feature.id.replace(/[\r\n]/gu, " ")}: ${feature.status}; ownership ${feature.ownership.map((owner) => `${owner.id.replace(/[\r\n]/gu, " ")}:${owner.status}`).join(", ") || "none"}; test evidence ${feature.testEvidence.status}`,
      );
      for (const hint of feature.agentHints) {
        lines.push(`HINT            ${hint.code}: ${hint.message.replace(/[\r\n]/gu, " ")}`);
      }
    }
    for (const limitation of alignment.limitations) {
      lines.push(`LIMIT           ${limitation.replace(/[\r\n]/gu, " ")}`);
    }
  }
  lines.push(
    ollama.outcome === "reachable"
      ? `Embeddings      ${ollama.url} erreichbar${ollama.chosenModel === undefined ? "; no embedding model" : ` — ${ollama.chosenModel.name} (${ollama.chosenModel.dimensions === undefined ? "?" : formatCount(ollama.chosenModel.dimensions)} dimensions)`}`
      : `Embeddings      ${ollama.url} unreachable; this is not an error`,
  );
  // WP-228: Die Zeile darueber sagt nur, dass /api/tags geantwortet hat.
  // Diese hier sagt, ob der Dienst das kann, wofuer er gebraucht wird.
  lines.push(`                ${describeEmbedProbe(ollama)}`);
  const qdrant = findings.qdrant;
  lines.push(
    qdrant.outcome === "reachable"
      ? `Vektorspeicher  ${qdrant.url ?? "?"} erreichbar`
      : `Vector store    unreachable (${qdrant.probedUrls.join(", ")}); this is not an error`,
  );
  for (const skipped of qdrant.skippedUrls) {
    lines.push(`                not checked: ${skipped.url}`);
  }

  const ignore = findings.ignore;
  lines.push(
    ignore.gitignorePresent
      ? `Ignore rules    .gitignore with ${formatCount(ignore.gitignoreRuleCount)} rules + ${formatCount(ignore.defaultExcludes.length)} defaults${ignore.additionalExcludes.length > 0 ? `, ${formatCount(ignore.additionalExcludes.length)} imported (${ignore.additionalExcludes.join(", ")})` : ""}`
      : `Ignore rules    no .gitignore; ${formatCount(ignore.defaultExcludes.length)} defaults`,
  );

  if (findings.skipped.entries.length > 0) {
    lines.push(
      `Skipped         ${formatCount(findings.skipped.entries.length)} entries with reasons (--format json shows all)`,
    );
  }

  lines.push("");
  lines.push(...formatOutcome(result));

  for (const warning of result.configWarnings) {
    lines.push(`WARNING         ${warning}`);
  }
  for (const error of result.configErrors) {
    lines.push(`ERROR           ${error}`);
  }

  lines.push("");
  lines.push(result.nextStep);
  return lines;
}

/**
 * Der Satz zum Probe-Embedding (WP-228).
 *
 * Er nennt IMMER, was geprueft wurde — auch im Erfolgsfall. Eine Zeile, die
 * nur bei Problemen erscheint, liest sich in ihrer Abwesenheit wie „geprueft
 * und in Ordnung", und genau das war der Befund.
 */
export function describeEmbedProbe(ollama: ProjectFindingsV1["ollama"]): string {
  const probe = ollama.embedProbe;
  switch (probe.outcome) {
    case "ok":
      return `/api/embed checked: responds${probe.dimensions === undefined ? "" : ` (${formatCount(probe.dimensions)} dimensions)`}; the service is usable`;
    case "timeout":
      return `/api/embed NO RESPONSE within ${formatCount(probe.timeoutMs)} ms; reachable does not mean usable here; use \`--embedder=offline\``;
    case "failed":
      return `/api/embed failed (${probe.detail ?? "no details"}); use \`--embedder=offline\``;
    default:
      return `/api/embed not checked (${probe.detail ?? "no details"})`;
  }
}

function formatOutcome(result: InitResultV1): string[] {
  switch (result.outcome) {
    case "created":
      return [`Written         ${result.configPath}`];
    case "overwritten":
      return [`Overwritten     ${result.configPath} (--force)`];
    case "unchanged":
      return [`Unchanged       ${result.configPath}; a second identical run changes nothing.`];
    case "would-create":
      return [`--dry-run       ${result.configPath} would be created (nothing written).`];
    case "would-be-unchanged":
      return [`--dry-run       ${result.configPath} is already current (nothing written).`];
    case "would-overwrite":
    case "differs":
      return [
        result.outcome === "differs"
          ? `Difference      ${result.configPath} differs. Nothing written; use --force to overwrite.`
          : `--dry-run       ${result.configPath} would change (nothing written).`,
        ...formatChanges(result),
      ];
    default:
      return [];
  }
}

/** At most 40 changed lines; more than that is a rewrite, not a diff. */
function formatChanges(result: InitResultV1): string[] {
  const shown = result.changes.slice(0, 40);
  const lines = shown.map((change) => `  ${change.kind === "added" ? "+" : "-"} ${change.line}`);
  if (result.changes.length > shown.length) {
    lines.push(`  … ${formatCount(result.changes.length - shown.length)} additional lines`);
  }
  return lines;
}
