/**
 * Harte Ehrlichkeitsgrenze fuer den Live-Benchmark.
 *
 * Der Search-Port degradiert ausgefallene Ziele absichtlich zu Warnungen,
 * damit eine interaktive Suche andere Profile weiter anzeigen kann. Ein
 * Benchmark darf diese Semantik nicht als Messwert missverstehen: ohne
 * ausgefuehrten Abruf sind null Treffer weder Akzeptanz noch Abstention.
 */
import type { SearchResultSetV1 } from "@untangle-code/domain";

import { detectRetrievalFailure } from "./findability.js";

/** Wirft, bevor ein Benchmark eine nicht ausgefuehrte Suche serialisieren kann. */
export function assertBenchmarkRetrievalCompleted(
  questionId: string,
  result: SearchResultSetV1,
): void {
  const failure = detectRetrievalFailure(result);
  if (failure === undefined) {
    return;
  }
  throw new Error(
    `benchmark row "${questionId}" is invalid because retrieval did not complete (${failure.reason}): ${failure.detail}`,
  );
}
