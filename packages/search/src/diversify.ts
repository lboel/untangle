/**
 * Diversifizierung (spec.md §13.2 Schritt 10, architecture.md §18.5).
 *
 * Ziel ist der Fall „zehn nahezu identische Treffer derselben Datei". Nach der
 * Deduplizierung ueber `metrics_scope_id` bleiben immer noch mehrere Symbole
 * derselben Datei uebrig — und wer nach „Funktion X" sucht, will nicht
 * zehnmal dieselbe Datei sehen, sondern die zehn besten STELLEN.
 *
 * Verfahren (bewusst ohne Inhaltsvektoren): Die Liste wird in Rangfolge
 * durchlaufen; jeder Treffer bekommt eine Strafe, die davon abhaengt, wie oft
 * seine Datei (und, schwaecher, sein Repository) vorher schon vertreten war:
 *
 *     strafe(n) = 1 - 1 / (1 + n)
 *
 * mit `n` = Zahl der vorher schon vertretenen Treffer derselben Datei. Der
 * erste Treffer einer Datei bekommt also 0, der zweite 0.5, der dritte 0.667 —
 * eine saettigende Kurve, die nie 1 erreicht. Damit verschwindet keine Datei
 * vollstaendig aus dem Ergebnis; sie wird nur immer teurer.
 *
 * Warum keine Content-MMR: dafuer braeuchte es die dichten Vektoren aller
 * Kandidaten. Der `VectorStore`-Port liefert sie beim Suchen nicht mit
 * (`hybridQuery` gibt Payload, keine Vektoren), und sie nachzuladen kostet
 * eine zweite Runde ueber den Speicher. Die datei-/repo-basierte Streuung ist
 * die Dimension, die architecture.md §18.5 zuerst nennt, und sie kostet nichts.
 * Der Verzicht auf die Content-Dimension steht in der README unter „Bekannte
 * Grenzen".
 */
import type { CodeChunkPayloadV1 } from "@untangle-code/domain";
import { ID_COMPONENT_SEPARATOR } from "@untangle-code/domain";

/** Anteil der Datei-Strafe, den ein reiner Repo-Wiederholer bekommt. */
export const REPO_REPETITION_SHARE = 0.25;

/** Ein Eintrag der Diversifizierung: Gegenstand plus zugeteilte Strafe. */
export interface DiversificationEntry<T> {
  item: T;
  /** Rohwert der `duplicate_penalty` in [0, 1). */
  penaltyRawValue: number;
}

function saturatingPenalty(previousOccurrences: number): number {
  return 1 - 1 / (1 + previousOccurrences);
}

/**
 * Berechnet die Duplikatsstrafen in Rangfolge.
 *
 * Die Funktion sortiert NICHT um — sie bewertet nur. Die Neuordnung passiert
 * spaeter ueber den fertigen Endscore, damit jede Verschiebung in der
 * Score-Zerlegung sichtbar ist statt in einem unsichtbaren Sortierschritt.
 */
export function assignDuplicatePenalties<T>(
  items: readonly T[],
  payloadOf: (item: T) => CodeChunkPayloadV1,
): DiversificationEntry<T>[] {
  const fileCounts = new Map<string, number>();
  const repoCounts = new Map<string, number>();
  return items.map((item) => {
    const payload = payloadOf(item);
    const repoKey = [payload.repo_id, payload.ref_id].join(ID_COMPONENT_SEPARATOR);
    const fileKey = [repoKey, payload.file_id].join(ID_COMPONENT_SEPARATOR);
    const previousFile = fileCounts.get(fileKey) ?? 0;
    const previousRepo = repoCounts.get(repoKey) ?? 0;
    fileCounts.set(fileKey, previousFile + 1);
    repoCounts.set(repoKey, previousRepo + 1);
    const filePenalty = saturatingPenalty(previousFile);
    const repoPenalty =
      previousFile === 0 ? saturatingPenalty(previousRepo) * REPO_REPETITION_SHARE : 0;
    return { item, penaltyRawValue: Math.min(1, filePenalty + repoPenalty) };
  });
}
