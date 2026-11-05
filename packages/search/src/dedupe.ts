/**
 * Deduplizierung (spec.md §13.5, architecture.md §18.4).
 *
 * Mehrere Fragmente desselben Symbols duerfen nicht alle Top-Plaetze belegen.
 * Der Dedupe-Schluessel ist woertlich der aus architecture.md §18.4:
 *
 *     workspace_id + repo_id + ref_id + metrics_scope_id
 *
 * Der Ref gehoert bewusst hinein: derselbe Code in zwei Branches oder zwei
 * Worktrees sind ZWEI Antworten, nicht eine — wer ueber mehrere Refs sucht,
 * will beide sehen, jeweils mit ihrer Herkunft (vision.md §1a „Branch- und
 * Worktree-Bewusstsein").
 *
 * Verbunden werden die Bestandteile mit `ID_COMPONENT_SEPARATOR` (U+001F),
 * derselben Trennzeichenkonvention wie bei allen Untangle-IDs — ein Pfad oder
 * Name kann so keinen Schluessel „ueberlaufen" lassen.
 */
import type { CodeChunkPayloadV1, RelatedFragmentV1 } from "@untangle-code/domain";
import { ID_COMPONENT_SEPARATOR, compareCodepoints } from "@untangle-code/domain";

import type { SearchCandidate } from "./payload.js";

/** Baut den Dedupe-Schluessel eines Chunk-Payloads. */
export function buildDedupeKey(payload: CodeChunkPayloadV1): string {
  return [payload.workspace_id, payload.repo_id, payload.ref_id, payload.metrics_scope_id].join(
    ID_COMPONENT_SEPARATOR,
  );
}

/** Ein Kandidat mit seinem Basisscore, wie ihn die Fusion geliefert hat. */
export interface ScoredCandidate {
  candidate: SearchCandidate;
  /** Normalisierter Basisscore aus der Fusion, in [0, 1]. */
  baseScore: number;
}

/** Ergebnis der Deduplizierung einer Gruppe. */
export interface DedupedCandidate {
  primary: ScoredCandidate;
  dedupeKey: string;
  relatedFragments: RelatedFragmentV1[];
  /** Die verdraengten Kandidaten — fuer den Skip-Ledger (E4). */
  absorbed: ScoredCandidate[];
}

/**
 * Fasst Kandidaten mit gleichem Dedupe-Schluessel zusammen.
 *
 * Primaer bleibt der bestbewertete; bei Gleichstand entscheidet die
 * Codepoint-Ordnung der Chunk-ID — nie die Reihenfolge, in der der Speicher
 * geantwortet hat.
 *
 * Die Eingabereihenfolge bleibt fuer die Ausgabe massgeblich: die Gruppen
 * erscheinen in der Reihenfolge ihres ersten Vorkommens, damit die Rangfolge
 * der Fusion erhalten bleibt.
 */
export function dedupeCandidates(scored: readonly ScoredCandidate[]): DedupedCandidate[] {
  const groups = new Map<string, ScoredCandidate[]>();
  for (const entry of scored) {
    const key = buildDedupeKey(entry.candidate.payload);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [entry]);
    } else {
      existing.push(entry);
    }
  }

  return [...groups].map(([key, group]) => {
    const members = [...group].sort(compareScored);
    const primary = members[0] as ScoredCandidate;
    const absorbed = members.slice(1);
    return {
      primary,
      dedupeKey: key,
      absorbed,
      relatedFragments: absorbed.map((member) => toRelatedFragment(member)),
    };
  });
}

function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.baseScore !== b.baseScore) {
    return b.baseScore - a.baseScore;
  }
  return compareCodepoints(a.candidate.payload.chunk_id, b.candidate.payload.chunk_id);
}

function toRelatedFragment(entry: ScoredCandidate): RelatedFragmentV1 {
  const { payload } = entry.candidate;
  return {
    chunkId: payload.chunk_id,
    chunkKind: payload.chunk_kind,
    ...(payload.fragment_index === undefined ? {} : { fragmentIndex: payload.fragment_index }),
    startLine: payload.start_line,
    endLine: payload.end_line,
    score: entry.baseScore,
  };
}
