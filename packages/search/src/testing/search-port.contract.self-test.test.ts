/**
 * Selbsttest: der {@link SearchPort}-Kontrakt gegen die In-Memory-Referenz.
 *
 * Das ist der Beleg, dass die Kontraktsuite ueberhaupt etwas aussagt — und
 * zugleich der Beweis, dass der Abrufkern ohne laufendes Qdrant vollstaendig
 * pruefbar ist (spec.md §3.2: fremde Instanzen bleiben unberuehrt).
 */
import { buildInMemorySearchEngine, TEST_EMBEDDING_PROFILE_ID } from "./in-memory-index.js";
import { runSearchPortContract } from "./search-port.contract.js";

runSearchPortContract(async (fixtures, options) => {
  const harness = await buildInMemorySearchEngine(
    fixtures,
    options?.relevance === undefined
      ? {}
      : { relevancePolicies: { [TEST_EMBEDDING_PROFILE_ID]: options.relevance } },
  );
  return harness.engine;
});
