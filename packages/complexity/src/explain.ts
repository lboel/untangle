/**
 * Explain path (work order: "einen Explain-Pfad"). Produces a ranked,
 * human-readable breakdown of a symbol's cyclomatic and cognitive
 * contributions, largest first.
 *
 * Operates on the *stored* `ComplexitySnapshotV1` shape
 * (`cyclomatic.contributors` is `MetricContribution[]`;
 * `cognitive.contributors` is the full `CognitiveContributionV1[]` the
 * snapshot persists per spec.md §16.4), so it works directly on whatever
 * `assembleComplexitySnapshot` produced or on any snapshot loaded back from
 * storage.
 */
import type {
  CognitiveContributionV1,
  ComplexitySnapshotV1,
  MetricContribution,
} from "@untangle-code/domain";

import type { ExplainEntry } from "./types.js";

function toCyclomaticEntries(
  contributions: readonly MetricContribution[],
): Array<Omit<ExplainEntry, "rank">> {
  return contributions
    .filter((c) => c.kind !== "base")
    .map((c) => ({
      metric: "cyclomatic" as const,
      kind: c.kind,
      line: c.line,
      value: c.value,
      text: `line ${c.line}: ${c.kind} contributes ${c.value} to cyclomatic complexity${
        c.note ? ` (${c.note})` : ""
      }`,
    }));
}

function toCognitiveEntries(
  contributions: readonly CognitiveContributionV1[],
): Array<Omit<ExplainEntry, "rank">> {
  return contributions.map((c) => ({
    metric: "cognitive" as const,
    kind: c.kind,
    line: c.line,
    value: c.total,
    text: `line ${c.line}: ${c.kind} contributes ${c.total} to cognitive complexity (base=${c.base} nestingPenalty=${c.nestingPenalty})${
      c.note ? ` (${c.note})` : ""
    }`,
  }));
}

/**
 * @param snapshot The symbol's complexity snapshot.
 * @param top Maximum number of entries to return (default 5), largest
 *   contribution first; ties keep cyclomatic before cognitive, then source
 *   order.
 */
export function explainSymbol(snapshot: ComplexitySnapshotV1, top = 5): ExplainEntry[] {
  const combined = [
    ...toCyclomaticEntries(snapshot.cyclomatic.contributors),
    ...toCognitiveEntries(snapshot.cognitive.contributors),
  ];
  combined.sort((a, b) => b.value - a.value);
  return combined.slice(0, top).map((entry, index) => ({ ...entry, rank: index + 1 }));
}
