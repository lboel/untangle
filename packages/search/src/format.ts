/**
 * Ausgabeformate (Nutzerwunsch A4: „Text, JSON, JSONL").
 *
 * Drei Formate, drei Zwecke:
 *
 * - `text` — fuer Menschen im Terminal. Eine Zeile Kopf je Treffer, darunter
 *   die Score-Zerlegung in Klartext. Die Zerlegung ist hier KEIN Debug-Anhang,
 *   sondern der eigentliche Mehrwert: sie beantwortet „warum steht das oben?".
 * - `json` — ein Dokument, vollstaendig, mit Ledger und Warnungen. Fuer
 *   Werkzeuge, die das Ganze wollen.
 * - `jsonl` — eine Zeile je Treffer, streambar. Fuer Agents und Pipes.
 *   Die erste Zeile ist ein Kopfsatz mit Anfrage-Fingerabdruck, Warnungen und
 *   Ledger — sonst wuerde beim Streamen genau die Information verloren gehen,
 *   die E4 sichtbar machen soll.
 *
 * Alle drei sind deterministisch: gleiche Ergebnismenge, gleiche Bytes.
 */
import type {
  ScoreComponentV1,
  SearchGraphRelationsV1,
  SearchHitV1,
  SearchResultSetV1,
} from "@untangle-code/domain";

import type { GrepResultSetV1, OutputFormat } from "./types.js";

/** Formatiert eine Zahl mit fester Stellenzahl — stabil ueber Plattformen. */
function fixed(value: number, digits = 4): string {
  return value.toFixed(digits);
}

function formatComponent(component: ScoreComponentV1): string {
  const sign = component.contribution < 0 ? "-" : "+";
  const evidence = component.evidence === undefined ? "" : `  [${component.evidence}]`;
  return `      ${sign} ${component.kind} = ${fixed(Math.abs(component.contribution))} (raw ${fixed(component.rawValue)} x weight ${fixed(component.weight)})${evidence}`;
}

/** Kompakte, aber vollstaendige Textdarstellung einer begrenzten Graphfacette. */
export function formatSearchGraphRelationsAsText(
  label: "context" | "linked",
  value: SearchGraphRelationsV1,
): string[] {
  const lines = value.relations.map((relation) => {
    const arrow = relation.direction === "incoming" ? "<-" : "->";
    const symbol = relation.symbol === undefined ? "" : ` symbol=${relation.symbol.id}`;
    return (
      `      ${label} ${arrow} ${relation.repoId}@${relation.refId} ` +
      `${relation.path} file=${relation.fileId}${symbol} ` +
      `edge=${relation.edgeId} kind=${relation.edgeKind} crossRepository=${String(relation.crossRepository)}`
    );
  });
  for (const omission of value.omissions) {
    lines.push(
      `      ${label} omitted ${omission.reason} x${String(omission.count)}: ${omission.detail}`,
    );
  }
  return lines;
}

/** Eine Trefferzeile plus Score-Zerlegung im Textformat. */
export function formatHitAsText(hit: SearchHitV1): string {
  const lines: string[] = [];
  const symbol =
    hit.symbolName === undefined ? "" : ` ${hit.symbolKind ?? "symbol"} ${hit.symbolName}`;
  lines.push(
    `${String(hit.rank).padStart(3, " ")}. ${fixed(hit.score.final)}  ${hit.repoLabel}@${hit.refName} ${hit.filePath}:${hit.range.startLine}-${hit.range.endLine}${symbol}`,
  );
  if (hit.complexity?.cognitive !== undefined) {
    lines.push(`      complexity: cognitive ${hit.complexity.cognitive}`);
  }
  if (hit.findability !== undefined) {
    lines.push(
      `      findability: ${fixed(hit.findability.score, 2)} (heuristic${hit.findability.primaryCause === undefined ? "" : `, ${hit.findability.primaryCause}`})`,
    );
  }
  lines.push("      why:");
  for (const component of hit.score.components) {
    lines.push(formatComponent(component));
  }
  if (hit.score.clamped) {
    lines.push(`      clamped: ${hit.score.clampReason ?? ""}`);
  }
  if (hit.relatedFragments.length > 0) {
    lines.push(
      `      related fragments: ${hit.relatedFragments.map((fragment) => `${fragment.chunkKind}@${fragment.startLine}`).join(", ")}`,
    );
  }
  if (hit.graphContext !== undefined) {
    lines.push(...formatSearchGraphRelationsAsText("context", hit.graphContext));
  }
  if (hit.linkedSymbols !== undefined) {
    lines.push(...formatSearchGraphRelationsAsText("linked", hit.linkedSymbols));
  }
  if (hit.contentOmittedReason !== undefined) {
    lines.push(`      content omitted: ${hit.contentOmittedReason}`);
  }
  if (hit.content !== undefined) {
    for (const line of hit.content.split("\n")) {
      lines.push(`      | ${line}`);
    }
  }
  return lines.join("\n");
}

/** Formatiert eine ganze Ergebnismenge. */
export function formatSearchResultSet(set: SearchResultSetV1, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(set, null, 2);
  }
  if (format === "jsonl") {
    const header = {
      kind: "header" as const,
      queryFingerprint: set.queryFingerprint,
      ...(set.indexFreshness === undefined ? {} : { indexFreshness: set.indexFreshness }),
      query: set.query,
      profileSeparation: set.profileSeparation,
      totalHits: set.totalHits,
      warnings: set.warnings,
      skipped: set.skipped,
    };
    const lines = [JSON.stringify(header)];
    for (const group of set.groups) {
      for (const hit of group.hits) {
        lines.push(
          JSON.stringify({ kind: "hit", embeddingProfileId: group.embeddingProfileId, hit }),
        );
      }
    }
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push(`query: ${set.query.text}`);
  lines.push(`fingerprint: ${set.queryFingerprint}`);
  if (set.profileSeparation) {
    lines.push(
      `NOTE: ${set.groups.length} embedding profiles — scores are comparable only within a group (spec.md §13.4)`,
    );
  }
  for (const group of set.groups) {
    lines.push("");
    lines.push(`profile ${group.embeddingProfileId} (repos: ${group.repoIds.join(", ")})`);
    for (const caveat of group.caveats) {
      lines.push(`  caveat: ${caveat}`);
    }
    // Das Verdikt kommt aus der Entscheidung, nie aus der Listenlaenge. Ein
    // blosses „(no hits)" waere bei einer Ablehnung eine Tatsachenbehauptung
    // ueber den Code: es GAB Kandidaten, die Policy hat sie verworfen.
    const verdict = group.relevanceDecision;
    if (verdict?.status === "rejected") {
      lines.push(
        `  (relevance policy ${verdict.calibrationId ?? "unknown"} judged the evidence ` +
          `insufficient: ${verdict.basis}; abstention=${verdict.abstention})`,
      );
    }
    if (group.hits.length === 0 && verdict?.status !== "rejected") {
      lines.push("  (no hits)");
    }
    for (const hit of group.hits) {
      lines.push(formatHitAsText(hit));
    }
  }
  if (set.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of set.warnings) {
      lines.push(`  ${warning.code}: ${warning.message}`);
    }
  }
  if (set.skipped.length > 0) {
    lines.push("");
    lines.push(`skipped (${set.skipped.length}) — nothing is dropped silently:`);
    for (const entry of set.skipped) {
      lines.push(
        `  ${entry.reason} ${entry.subjectKind} ${entry.subjectId ?? entry.path ?? ""}: ${entry.detail}`,
      );
    }
  }
  return lines.join("\n");
}

/** Formatiert grep-Treffer. */
export function formatGrepResultSet(set: GrepResultSetV1, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(set, null, 2);
  }
  if (format === "jsonl") {
    const header = {
      kind: "header" as const,
      pattern: set.pattern,
      ...(set.indexFreshness === undefined ? {} : { indexFreshness: set.indexFreshness }),
      isRegex: set.isRegex,
      totalMatches: set.totalMatches,
      truncated: set.truncated,
      ...(set.truncationReason === undefined ? {} : { truncationReason: set.truncationReason }),
      scannedChunks: set.scannedChunks,
      warnings: set.warnings,
      skipped: set.skipped,
    };
    return [header, ...set.matches.map((match) => ({ kind: "match" as const, match }))]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
  }

  const lines: string[] = [];
  for (const match of set.matches) {
    for (const context of match.before) {
      lines.push(`${match.filePath}-${context.line}- ${context.text}`);
    }
    lines.push(`${match.filePath}:${match.line}:${match.column}: ${match.lineText}`);
    for (const context of match.after) {
      lines.push(`${match.filePath}-${context.line}- ${context.text}`);
    }
    if (match.before.length > 0 || match.after.length > 0) {
      lines.push("--");
    }
  }
  lines.push(
    `${set.totalMatches} match(es) in ${set.scannedChunks} scanned chunk(s)${set.truncated ? ` — TRUNCATED (${set.truncationReason ?? "unknown"})` : ""}`,
  );
  if (set.skipped.length > 0) {
    lines.push(`skipped (${set.skipped.length}):`);
    for (const entry of set.skipped) {
      lines.push(`  ${entry.reason} ${entry.subjectId ?? entry.path ?? ""}: ${entry.detail}`);
    }
  }
  return lines.join("\n");
}
