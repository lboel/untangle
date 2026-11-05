/**
 * Fusion der drei Ranglisten (spec.md §13.2 Schritt 6, §13.4).
 *
 * Verfahren: gewichtete Reciprocal Rank Fusion.
 *
 *     rrf(d) = Σ_zweig  w_zweig / (k + rang_zweig(d))
 *
 * WARUM RRF UND NICHT EINE SCORE-SUMME: Cosine-Aehnlichkeit, BM25 und eine
 * Namensuebereinstimmung leben in drei verschiedenen Wertebereichen. Sie zu
 * addieren hiesse, sie stillschweigend gleich zu skalieren. RRF benutzt nur
 * die RANGFOLGE jedes Zweigs und ist damit gegen die Skala jedes einzelnen
 * Zweigs unempfindlich — dieselbe Eigenschaft, wegen der spec.md §13.4 RRF
 * als einziges Fusionsverfahren fuer v1 festlegt.
 *
 * WARUM k = 60: der Wert aus der RRF-Originalarbeit (Cormack, Clarke,
 * Buettcher 2009), seither die uebliche Voreinstellung — unter anderem in
 * Qdrants eigener RRF-Implementierung, gegen die dieser Abrufkern austauschbar
 * bleiben soll. Grosses k daempft den Vorsprung der ersten Plaetze, kleines k
 * ueberhoeht ihn; 60 ist der dokumentierte Mittelweg, nicht ein geratener.
 *
 * WARUM DIE ZWEIGGEWICHTE SO GEWAEHLT SIND:
 * - dicht 1.0 und lexikalisch 1.0 — die beiden Abrufzweige sind gleichwertig;
 *   welcher besser ist, haengt an der Anfrage (Absichtsfrage vs. Bezeichner),
 *   und genau deshalb werden beide gefragt;
 * - Symbolname 0.5 — der Zweig ist eine PRAEZISIONS-, keine Abrufquelle. Ein
 *   exakter Namenstreffer wird zusaetzlich als `exact_symbol_boost` belohnt
 *   (spec.md §13.3). Mit vollem Gewicht in der Fusion UND vollem Boost
 *   wuerde derselbe Beleg doppelt zaehlen; das halbe Gewicht ist der
 *   ausdrueckliche Abschlag dafuer.
 */
import { compareCodepoints } from "@untangle-code/domain";

/** Glaettungskonstante der RRF-Formel (siehe Modulkommentar). */
export const RRF_K = 60;

/** Voreingestellte Zweiggewichte (siehe Modulkommentar). */
export const DEFAULT_BRANCH_WEIGHTS = {
  dense: 1,
  lexical: 1,
  symbol: 0.5,
} as const;

export type FusionBranch = keyof typeof DEFAULT_BRANCH_WEIGHTS;

/** Eine Rangliste eines Zweigs: IDs, bester zuerst. */
export interface FusionInput {
  branch: FusionBranch;
  /** IDs in Rangfolge; Position 0 ist Rang 1. */
  rankedIds: readonly string[];
}

export interface FusionResult {
  id: string;
  /** Roher RRF-Wert. */
  rrf: number;
  /** Auf [0, 1] normalisierter RRF-Wert (siehe {@link maximumRrf}). */
  normalized: number;
  /** Beitragende Zweige mit ihrem 1-basierten Rang. */
  ranks: Partial<Record<FusionBranch, number>>;
  /** Wirksame Gewichte der beteiligten Zweige (fuer die Score-Evidenz). */
  weights?: Partial<Record<FusionBranch, number>>;
}

export type BranchWeights = Record<FusionBranch, number>;

/**
 * Der groesstmoegliche RRF-Wert: jeder beteiligte Zweig auf Rang 1.
 *
 * Damit wird auf [0, 1] normalisiert, OHNE durch den Maximalwert der aktuellen
 * Trefferliste zu teilen. Das ist der Unterschied zwischen „dieser Treffer ist
 * gut" und „dieser Treffer war der beste, den wir hatten": eine Normalisierung
 * am Listenmaximum gaebe dem besten Treffer immer 1.0, auch wenn er schlecht
 * ist — und die Findability-Diagnose (vision.md §1d) braucht genau diesen
 * Unterschied.
 */
export function maximumRrf(branches: readonly FusionBranch[], weights: BranchWeights): number {
  const uniqueBranches = [...new Set(branches)];
  return uniqueBranches.reduce((sum, branch) => sum + weights[branch] / (RRF_K + 1), 0);
}

/**
 * Fusioniert die Ranglisten. Ein Kandidat, der in einem Zweig nicht vorkommt,
 * bekommt von diesem Zweig schlicht keinen Beitrag — er wird nicht bestraft.
 *
 * Die Ausgabe ist absteigend nach RRF sortiert, bei Gleichstand nach
 * Codepoints der ID (deterministisch).
 */
export function fuseRankings(
  inputs: readonly FusionInput[],
  weights: BranchWeights = { ...DEFAULT_BRANCH_WEIGHTS },
): FusionResult[] {
  const accumulator = new Map<
    string,
    { rrf: number; ranks: Partial<Record<FusionBranch, number>> }
  >();
  for (const input of inputs) {
    const weight = weights[input.branch];
    input.rankedIds.forEach((id, index) => {
      const rank = index + 1;
      const entry = accumulator.get(id) ?? { rrf: 0, ranks: {} };
      entry.rrf += weight / (RRF_K + rank);
      entry.ranks[input.branch] = rank;
      accumulator.set(id, entry);
    });
  }
  const maximum = maximumRrf(
    inputs.map((input) => input.branch),
    weights,
  );
  const results: FusionResult[] = [...accumulator.entries()].map(([id, entry]) => ({
    id,
    rrf: entry.rrf,
    normalized: maximum === 0 ? 0 : entry.rrf / maximum,
    ranks: entry.ranks,
    weights: Object.fromEntries(
      [...new Set(inputs.map((input) => input.branch))].map((branch) => [branch, weights[branch]]),
    ),
  }));
  results.sort((a, b) => (a.rrf === b.rrf ? compareCodepoints(a.id, b.id) : b.rrf - a.rrf));
  return results;
}
