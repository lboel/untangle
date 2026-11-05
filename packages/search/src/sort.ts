/**
 * Sortierung der Trefferliste (Nutzerwunsch A4: „Sortierung").
 *
 * Jede Sortierung ist zweistufig: erst das gewaehlte Kriterium, dann — IMMER —
 * der Dedupe-Schluessel nach Codepoints. Der zweite Schritt ist nicht Kosmetik:
 * ohne ihn haengt die Reihenfolge gleichbewerteter Treffer an der
 * Antwortreihenfolge des Speichers, und dieselbe Anfrage liefert auf zwei
 * Maschinen zwei Listen. `String#localeCompare` kommt dabei nie zum Einsatz
 * (docs/BUILD_PLAN.md §3).
 *
 * Treffer ohne den jeweiligen Wert (keine Komplexitaet gemessen, keine
 * Findability berechnet) landen ans ENDE der Liste, nicht an den Anfang: ein
 * fehlender Wert ist kein Bestwert.
 */
import type { SearchHitV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

import type { SearchSort } from "./types.js";

function tiebreak(a: SearchHitV1, b: SearchHitV1): number {
  return compareCodepoints(a.dedupeKey, b.dedupeKey);
}

function compareOptionalNumber(
  a: number | undefined,
  b: number | undefined,
  direction: "asc" | "desc",
): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return direction === "asc" ? a - b : b - a;
}

/** Sortiert eine Kopie der Treffer nach dem gewaehlten Kriterium. */
export function sortHits(hits: readonly SearchHitV1[], sort: SearchSort): SearchHitV1[] {
  const copy = [...hits];
  switch (sort) {
    case "relevance":
      copy.sort((a, b) =>
        a.score.final === b.score.final ? tiebreak(a, b) : b.score.final - a.score.final,
      );
      break;
    case "path":
      copy.sort(
        (a, b) =>
          compareCodepoints(a.repoId, b.repoId) ||
          compareCodepoints(a.filePath, b.filePath) ||
          (a.range.startLine !== b.range.startLine
            ? a.range.startLine - b.range.startLine
            : tiebreak(a, b)),
      );
      break;
    case "complexity-desc":
    case "complexity-asc": {
      const direction = sort === "complexity-asc" ? "asc" : "desc";
      copy.sort((a, b) => {
        const result = compareOptionalNumber(
          a.complexity?.cognitive,
          b.complexity?.cognitive,
          direction,
        );
        return result === 0 ? tiebreak(a, b) : result;
      });
      break;
    }
    case "findability-asc":
      copy.sort((a, b) => {
        const result = compareOptionalNumber(a.findability?.score, b.findability?.score, "asc");
        return result === 0 ? tiebreak(a, b) : result;
      });
      break;
  }
  return copy;
}

/** Weist die 1-basierten Raenge INNERHALB einer Profilgruppe zu. */
export function assignRanks(hits: readonly SearchHitV1[]): SearchHitV1[] {
  return hits.map((hit, index) => ({ ...hit, rank: index + 1 }));
}
