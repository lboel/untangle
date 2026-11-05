/**
 * Exakte und nahe Symbolnamen-Treffer (dritter Abrufzweig).
 *
 * Der Nutzerfall aus vision.md §1d ist woertlich: „wenn ich nach ‚Funktion X'
 * suche". Ein dichter Vektor kann einen exakten Namen verfehlen, weil er
 * Bedeutung und nicht Zeichen vergleicht; BM25 kann ihn unter langen Rumpf-
 * texten begraben. Der Symbolzweig ist deshalb kein Bonus auf einen anderen
 * Zweig, sondern eine eigene Rangliste mit eigener Begruendung.
 *
 * Vier Stufen, absichtlich grob und vollstaendig dokumentiert (jede feinere
 * Abstufung waere ein magisches Gewicht ohne Beleg):
 *
 * | Staerke | Bedingung |
 * |---|---|
 * | 1.00 | `symbol_name` ist zeichengleich mit dem Suchtext |
 * | 0.80 | zeichengleich bis auf Gross-/Kleinschreibung |
 * | 0.60 | `symbol_fqn` endet auf den Suchtext (`Service.charge`) |
 * | 0.40 | alle Teilwoerter der Anfrage stecken im Namen (`getUser` ⊂ `getUserById`) |
 */
import { compareCodepoints } from "@untangle-code/domain";
import type { CodeChunkPayloadV1 } from "@untangle-code/domain";

import { identifierParts } from "./tokenize.js";

/** Ergebnis eines Namensvergleichs. */
export interface SymbolMatch {
  strength: number;
  /** Beleg fuer die Score-Zerlegung, z. B. `symbol_name == "charge"`. */
  evidence: string;
}

/** Vergleicht den Suchtext mit den Namensfeldern eines Chunks. */
export function matchSymbolName(
  payload: CodeChunkPayloadV1,
  queryText: string,
): SymbolMatch | null {
  const name = payload.symbol_name;
  const query = queryText.trim();
  if (query === "") {
    return null;
  }
  if (name !== undefined && name === query) {
    return { strength: 1, evidence: `symbol_name == "${name}"` };
  }
  if (name !== undefined && name.toLowerCase() === query.toLowerCase()) {
    return { strength: 0.8, evidence: `symbol_name ~= "${name}" (case-insensitive)` };
  }
  const fqn = payload.symbol_fqn;
  if (
    fqn !== undefined &&
    (fqn === query || fqn.endsWith(`.${query}`) || fqn.endsWith(`::${query}`))
  ) {
    return { strength: 0.6, evidence: `symbol_fqn "${fqn}" ends with "${query}"` };
  }
  if (name === undefined) {
    return null;
  }
  const queryParts = identifierParts(query);
  const nameParts = new Set(identifierParts(name));
  if (queryParts.length > 0 && queryParts.every((part) => nameParts.has(part))) {
    return { strength: 0.4, evidence: `symbol_name "${name}" contains all query parts` };
  }
  return null;
}

/**
 * Kandidatenwerte fuer den Speicher-Filter auf `symbol_name`.
 *
 * Der Payload-Filter des Speichers kann nur exakte Werte vergleichen. Deshalb
 * werden hier deterministisch die Schreibweisen erzeugt, die derselbe Name
 * ueblicherweise hat: der Suchtext selbst, sein letztes Pfad-/FQN-Glied und —
 * falls der Suchtext genau ein Wort ist — dieses Wort. Mehr NICHT: eine
 * Kombinatorik ueber camelCase/snake_case-Varianten wuerde Treffer erfinden,
 * die im Index gar nicht so heissen.
 */
export function symbolNameFilterCandidates(queryText: string): string[] {
  const query = queryText.trim();
  if (query === "") {
    return [];
  }
  const candidates = new Set<string>([query]);
  const lastSegment = query.split(/[.:#/]/u).at(-1);
  if (lastSegment !== undefined && lastSegment !== "") {
    candidates.add(lastSegment);
  }
  return [...candidates].sort(compareCodepoints);
}
