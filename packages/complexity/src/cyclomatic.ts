/**
 * CyclomaticCalculator (spec.md §16.2 "Classic", §16.3 "Extended").
 *
 * Classic: `M = 1 + decision_points`, one point per `DecisionFact` whose
 * `countsForClassic` flag is set — the language adapter, not this
 * calculator, decides which decision kinds are classic decision points
 * (spec.md §16.2 lists if/else-if/loops/catch/ternary/case/guards).
 *
 * Extended: `M = 1 + decision_points`, one point per *independent* decision
 * group whose `countsForExtended` flag is set. "Independent group" is where
 * this calculator's own logic lives: `DecisionFact.logicalGroupId` marks
 * facts that belong to the same short-circuit/pattern-alternative group
 * (spec.md §16.3); this calculator counts each group once (first occurrence
 * by source position wins), not once per operator/alternative.
 */
import type { ComplexityFacts, DecisionFact } from "@untangle-code/domain";

import type { CyclomaticContribution, CyclomaticResult } from "./types.js";

function sortByPosition(decisions: readonly DecisionFact[]): DecisionFact[] {
  return [...decisions].sort((a, b) => a.range.startByte - b.range.startByte);
}

/**
 * @param facts Facts already narrowed to the target scope (see `selectSymbolFacts`
 *   for `scope: "symbol"`; pass a file's unfiltered facts for `scope: "file"`).
 * @param baseLine Source line the synthetic "base" contribution (the `+1` in
 *   `M = 1 + decision_points`) is attributed to — typically the scope's own
 *   first line.
 * @param algorithmVersion Caller-supplied algorithm/metrics version stamp
 *   (e.g. domain's `METRICS_VERSION`); this calculator is a pure function of
 *   its inputs and never invents its own version string.
 */
export function computeCyclomatic(
  facts: ComplexityFacts,
  baseLine: number,
  algorithmVersion: string,
): CyclomaticResult {
  const contributions: CyclomaticContribution[] = [
    {
      line: baseLine,
      kind: "base",
      value: 1,
      countsForClassic: true,
      countsForExtended: true,
      note: "M = 1 + decision points (spec.md §16.2)",
    },
  ];

  const seenGroups = new Set<string>();
  for (const decision of sortByPosition(facts.decisions)) {
    if (!decision.countsForClassic && !decision.countsForExtended) {
      continue;
    }
    if (decision.logicalGroupId != null) {
      if (seenGroups.has(decision.logicalGroupId)) {
        continue;
      }
      seenGroups.add(decision.logicalGroupId);
    }
    contributions.push({
      line: decision.range.startLine,
      kind: decision.kind,
      value: 1,
      countsForClassic: decision.countsForClassic,
      countsForExtended: decision.countsForExtended,
    });
  }

  const classic = contributions
    .filter((c) => c.countsForClassic)
    .reduce((sum, c) => sum + c.value, 0);
  const extended = contributions
    .filter((c) => c.countsForExtended)
    .reduce((sum, c) => sum + c.value, 0);

  return { classic, extended, contributions, algorithmVersion };
}
