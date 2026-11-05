/**
 * Default in-memory {@link EmbeddingCachePort} (spec.md §9.4).
 *
 * Process-local only — a fresh process starts with an empty cache. This is
 * the right default for a library that must work without any storage
 * adapter configured; `storage-local` (or another persistent adapter) can
 * inject a durable implementation of the same port instead.
 */
import type { EmbeddingCacheEntry, EmbeddingCacheKey, EmbeddingCachePort } from "./types.js";

function cacheKeyString(key: EmbeddingCacheKey): string {
  return `${key.embeddingProfileId}:${key.preparedTextHash}`;
}

export class InMemoryEmbeddingCache implements EmbeddingCachePort {
  private readonly entries = new Map<string, EmbeddingCacheEntry>();

  public async get(key: EmbeddingCacheKey): Promise<EmbeddingCacheEntry | null> {
    return this.entries.get(cacheKeyString(key)) ?? null;
  }

  public async set(key: EmbeddingCacheKey, entry: EmbeddingCacheEntry): Promise<void> {
    this.entries.set(cacheKeyString(key), entry);
  }

  /** Test/debug helper: number of cached entries. */
  public get size(): number {
    return this.entries.size;
  }
}
