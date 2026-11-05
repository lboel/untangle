/**
 * Deterministic `ArtifactChunk.chunkId` derivation.
 *
 * `packages/domain/src/identity.ts` defines one `buildXId` helper per ID
 * kind from spec.md §5, but `ArtifactChunk` (architecture.md §20) is an
 * Untangle-decision shape with no spec.md §5 identity formula of its own —
 * domain deliberately leaves it to this package (see README
 * "Entscheidungen"). This mirrors `buildChunkId`'s approach exactly: a
 * `uuidv5` under the shared Untangle namespace, over a kind-tagged,
 * unit-separator-joined component list, so a re-chunk of unchanged input
 * reproduces the exact same id (stable across index runs) while chunk ids
 * from different artifacts/documents/kinds can never collide.
 *
 * No `Date.now()`/`Math.random()` anywhere — pure function of its inputs
 * (rule 5).
 */
import { ID_COMPONENT_SEPARATOR, uuidv5 } from "@untangle-code/domain";

export interface ArtifactChunkIdInput {
  artifactName: string;
  /** "/"-normalized document path (as carried on `ArtifactDocument.path`). */
  documentPath: string;
  /** Semantic chunk kind, e.g. "sql_table", "markdown_section". */
  kind: string;
  /** 0-based position among this document's chunks, so equal-kind chunks never collide. */
  ordinal: number;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`buildArtifactChunkId: "${label}" must not be empty`);
  }
  if (value.includes(ID_COMPONENT_SEPARATOR)) {
    throw new Error(`buildArtifactChunkId: "${label}" must not contain the U+001F separator`);
  }
}

/** Deterministic `ArtifactChunk.chunkId` (see module doc). */
export function buildArtifactChunkId(input: ArtifactChunkIdInput): string {
  assertNonEmpty(input.artifactName, "artifactName");
  assertNonEmpty(input.documentPath, "documentPath");
  assertNonEmpty(input.kind, "kind");
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error(
      `buildArtifactChunkId: ordinal must be a non-negative integer, got ${input.ordinal}`,
    );
  }
  return uuidv5(
    [
      "artifact_chunk",
      input.artifactName,
      input.documentPath,
      input.kind,
      String(input.ordinal),
    ].join(ID_COMPONENT_SEPARATOR),
  );
}
