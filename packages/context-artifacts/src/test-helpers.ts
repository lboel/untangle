/**
 * Test-only helpers shared across `src/**\/*.test.ts` (excluded from the
 * production build by `tsconfig.json`, same convention as
 * `packages/chunker/src/test-helpers.ts`).
 */
import type { ArtifactChunk, ArtifactDocument, ContextArtifactConfig } from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";

export function artifactConfig(
  overrides: Partial<ContextArtifactConfig> & { name: string; path: string },
): ContextArtifactConfig {
  return { description: "test artifact", ...overrides };
}

export function inputFile(
  path: string,
  content: string,
): { path: string; content: string; contentHash: string } {
  return { path, content, contentHash: sha256Hex(content) };
}

/** Golden-friendly projection of a chunk: everything a reviewer needs to see a section/range/content diff. */
export function projectChunk(chunk: ArtifactChunk): Record<string, unknown> {
  return {
    kind: chunk.kind,
    title: chunk.title ?? null,
    range: chunk.range,
    content: chunk.content,
  };
}

export function projectDocument(document: ArtifactDocument): Record<string, unknown> {
  return {
    path: document.path,
    type: document.type,
    language: document.language ?? null,
    contentHash: document.contentHash,
  };
}
