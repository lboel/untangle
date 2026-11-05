import type {
  SearchGraphOmissionReason,
  SearchGraphOmissionV1,
  SearchGraphRelationsV1,
  SearchGraphRelationV1,
} from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

/** Harte Obergrenze je Treffer UND Graphart. */
export const SEARCH_GRAPH_RELATION_LIMIT = 32;
/** Maximale Textlaenge eines einzelnen Auslassungsdetails. */
export const SEARCH_GRAPH_OMISSION_DETAIL_LIMIT = 512;

/** Begrenzt freie Providerdiagnostik mit einem sichtbaren Restzaehler. */
export function boundSearchGraphDetail(detail: string): string {
  if (detail.length <= SEARCH_GRAPH_OMISSION_DETAIL_LIMIT) return detail;
  const previewLength = 440;
  const suffix = `… [${String(detail.length - previewLength)} further character(s) omitted]`;
  return `${detail.slice(0, previewLength)}${suffix}`;
}

function compareRelation(left: SearchGraphRelationV1, right: SearchGraphRelationV1): number {
  const fields: Array<[string, string]> = [
    [left.source, right.source],
    [left.direction, right.direction],
    [left.repoId, right.repoId],
    [left.refId, right.refId],
    [left.path, right.path],
    [left.fileId, right.fileId],
    [left.edgeKind, right.edgeKind],
    [left.edgeId, right.edgeId],
    [left.symbol?.id ?? "", right.symbol?.id ?? ""],
  ];
  for (const [leftValue, rightValue] of fields) {
    const compared = compareCodepoints(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  return 0;
}

function normalizeOmissions(
  input: readonly SearchGraphOmissionV1[],
  truncatedRelationCount: number,
): SearchGraphOmissionV1[] {
  const counts = new Map<SearchGraphOmissionReason, { count: number; details: Set<string> }>();
  const add = (omission: SearchGraphOmissionV1): void => {
    if (!Number.isInteger(omission.count) || omission.count <= 0 || omission.detail.trim() === "") {
      throw new TypeError(
        "search graph omission requires a positive integer count and non-empty detail",
      );
    }
    const previous = counts.get(omission.reason) ?? { count: 0, details: new Set<string>() };
    previous.count += omission.count;
    previous.details.add(omission.detail);
    counts.set(omission.reason, previous);
  };
  for (const omission of input) add(omission);
  if (truncatedRelationCount > 0) {
    add({
      reason: "relation_limit",
      count: truncatedRelationCount,
      detail: `${String(truncatedRelationCount)} direct persisted relation(s) were omitted by the per-hit limit`,
    });
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareCodepoints(left, right))
    .map(([reason, aggregate]) => {
      const details = [...aggregate.details].sort(compareCodepoints);
      const first = details[0] as string;
      return {
        reason,
        count: aggregate.count,
        detail: boundSearchGraphDetail(
          details.length === 1
            ? first
            : `${first} (+${String(details.length - 1)} further distinct detail(s), aggregated deterministically)`,
        ),
      };
    });
}

/**
 * Macht ein Provider-Ergebnis deterministisch und erzwingt die Grenze erneut
 * an der Search-Paketgrenze. Ein Adapter darf also nicht versehentlich eine
 * unbeschraenkte Nachbarschaft an einen Treffer haengen.
 */
export function createSearchGraphRelations(
  relations: readonly SearchGraphRelationV1[],
  omissions: readonly SearchGraphOmissionV1[] = [],
  relationLimit = SEARCH_GRAPH_RELATION_LIMIT,
): SearchGraphRelationsV1 {
  if (!Number.isInteger(relationLimit) || relationLimit <= 0) {
    throw new TypeError("search graph relationLimit must be a positive integer");
  }
  const sorted = [...relations].sort(compareRelation);
  const kept = sorted.slice(0, relationLimit);
  const normalizedOmissions = normalizeOmissions(omissions, sorted.length - kept.length);
  return {
    schemaVersion: 1,
    relations: kept,
    relationLimit,
    truncated: normalizedOmissions.some((omission) => omission.reason === "relation_limit"),
    omittedCount: normalizedOmissions.reduce((sum, omission) => sum + omission.count, 0),
    omissions: normalizedOmissions,
  };
}

/** Eine leere, aber erklaerte Facette fuer einen sichtbaren Degradationsfall. */
export function unavailableSearchGraphRelations(
  reason: SearchGraphOmissionReason,
  detail: string,
  relationLimit = SEARCH_GRAPH_RELATION_LIMIT,
): SearchGraphRelationsV1 {
  return createSearchGraphRelations([], [{ reason, count: 1, detail }], relationLimit);
}
