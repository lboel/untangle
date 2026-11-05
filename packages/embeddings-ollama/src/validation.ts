/**
 * Vector-dimension validation (spec.md §9.1 step 6, §4.8 "Falsch
 * konfigurierte Dimensionen MÜSSEN vor dem ersten Index-Upsert erkannt
 * werden"). Applied both to the readiness probe vector and to every
 * subsequent batch result — defense in depth, not just a one-time check.
 */
import { embeddingDimensionMismatchError } from "@untangle-code/observability";

export function assertVectorDimension(
  vector: number[],
  expectedDimensions: number,
  context: Record<string, unknown>,
): void {
  if (vector.length !== expectedDimensions) {
    throw embeddingDimensionMismatchError(
      `Ollama returned a ${vector.length}-dimensional vector but the embedding profile expects ${expectedDimensions} dimensions.`,
      {
        retryable: false,
        context: { ...context, actualDimensions: vector.length, expectedDimensions },
      },
    );
  }
}
