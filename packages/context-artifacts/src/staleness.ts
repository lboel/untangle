/**
 * Staleness detection (spec.md §19.2: "Artefaktkonfiguration und
 * Inhaltshash MÜSSEN Staleness bestimmen.").
 *
 * A context artifact goes stale when EITHER its configuration changes
 * (e.g. `include`/`exclude` edited, `description` reworded, `path`
 * repointed) OR its underlying file content changes (a file was edited,
 * added, or removed), independently of each other — so both are hashed
 * separately and compared separately; collapsing them into one combined
 * hash would make "what changed" undiagnosable from the stored snapshot
 * alone.
 */
import type { ArtifactDocument, ContextArtifactConfig } from "@untangle-code/domain";
import { canonicalJson, sha256Hex } from "@untangle-code/domain";

/** The two independent inputs to staleness (spec.md §19.2), snapshotted together. */
export interface ArtifactStalenessSnapshot {
  /** SHA-256 of the canonical JSON of the artifact's `ContextArtifactConfig`. */
  configHash: string;
  /**
   * SHA-256 combining every current document's path and content hash
   * (spec.md §19.2's "Inhaltshash"). Sorted by path first so the result is
   * independent of file-discovery order.
   */
  contentHash: string;
}

/** SHA-256 of an artifact's canonical configuration (spec.md §19.2). */
export function computeArtifactConfigHash(config: ContextArtifactConfig): string {
  return sha256Hex(canonicalJson(config));
}

/**
 * Combines the per-document `contentHash`es (already SHA-256 of each
 * document's raw content, per `ArtifactDocument.contentHash`) into one
 * artifact-level content hash. A directory-backed artifact is stale when
 * any file's content changes, a file is added, or a file is removed — all
 * three change this combined hash.
 */
export function computeArtifactContentHash(documents: readonly ArtifactDocument[]): string {
  const sorted = [...documents]
    .map((document) => ({ path: document.path, contentHash: document.contentHash }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return sha256Hex(canonicalJson(sorted));
}

/** Snapshots both staleness inputs for one artifact's current config + documents. */
export function computeArtifactStalenessSnapshot(
  config: ContextArtifactConfig,
  documents: readonly ArtifactDocument[],
): ArtifactStalenessSnapshot {
  return {
    configHash: computeArtifactConfigHash(config),
    contentHash: computeArtifactContentHash(documents),
  };
}

/**
 * True when `current` differs from the last-indexed `previous` snapshot in
 * either the config hash or the content hash (spec.md §19.2) — a pure
 * comparison; persisting/loading the previous snapshot is a metadata-store
 * concern outside this package.
 */
export function isArtifactStale(
  previous: ArtifactStalenessSnapshot,
  current: ArtifactStalenessSnapshot,
): boolean {
  return previous.configHash !== current.configHash || previous.contentHash !== current.contentHash;
}
