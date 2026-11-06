/**
 * Canonical effective config and embedding profile derivation
 * (architecture.md §6.3: "kanonische Effective Config", "Embedding- und
 * Indexprofil-Hashing"; spec.md §5.1 `workspace_id` fallback derivation;
 * spec.md §5.7 `embedding_profile_id`).
 */
import type { EmbeddingProfile } from "@untangle-code/domain";
import { buildEmbeddingProfileId, canonicalJson, sha256Hex } from "@untangle-code/domain";

import { DEFAULT_EMBEDDING_NORMALIZATION, PREPARED_TEXT_VERSION } from "./defaults.js";
import type { EffectiveUntangleConfigV1 } from "./types.js";

/**
 * SHA-256 of the canonical JSON of `config`. The additive storage section
 * is excluded for Qdrant to preserve existing workspace identities; its
 * connection remains represented by the unchanged qdrant section. Used as `buildWorkspaceId`'s
 * `configHash` input (spec.md §5.1) when no explicit `workspaceId` is
 * configured, and to detect effective-config drift between index runs
 * (architecture.md §6.3, §13.4 "Generation-Commit").
 */
export function computeConfigHash(config: unknown): string {
  if (typeof config === "object" && config !== null && !Array.isArray(config)) {
    const record = config as Record<string, unknown>;
    const storage = record["storage"];
    if (
      typeof storage === "object" &&
      storage !== null &&
      "backend" in storage &&
      storage.backend === "qdrant"
    ) {
      const legacyConfig = { ...record };
      delete legacyConfig["storage"];
      return sha256Hex(canonicalJson(legacyConfig));
    }
  }
  return sha256Hex(canonicalJson(config));
}

/**
 * Assembles the `EmbeddingProfile` (domain, spec.md §5.7's eight mandatory
 * fields) from an effective config's `embeddings` section and derives
 * `embedding_profile_id` via `buildEmbeddingProfileId`.
 *
 * `normalization` and `preparedTextVersion` are not part of `EmbeddingConfig`
 * (spec.md §4.5 does not list them); they default to this package's fixed
 * constants (`defaults.ts`) unless overridden here — e.g. a future config
 * revision that exposes them per-project.
 */
export function deriveEmbeddingProfile(
  config: Pick<EffectiveUntangleConfigV1, "embeddings">,
  overrides: { normalization?: string; preparedTextVersion?: string } = {},
): EmbeddingProfile {
  return {
    provider: config.embeddings.provider,
    model: config.embeddings.model,
    dimensions: config.embeddings.dimensions,
    queryPrefix: config.embeddings.queryPrefix,
    documentPrefix: config.embeddings.documentPrefix,
    includePath: config.embeddings.includePath,
    normalization: overrides.normalization ?? DEFAULT_EMBEDDING_NORMALIZATION,
    preparedTextVersion: overrides.preparedTextVersion ?? PREPARED_TEXT_VERSION,
  };
}

/** Convenience: `buildEmbeddingProfileId(deriveEmbeddingProfile(config, overrides))`. */
export function deriveEmbeddingProfileId(
  config: Pick<EffectiveUntangleConfigV1, "embeddings">,
  overrides?: { normalization?: string; preparedTextVersion?: string },
): string {
  return buildEmbeddingProfileId(deriveEmbeddingProfile(config, overrides));
}
