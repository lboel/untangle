/**
 * Persistent embedding cache under `cache/embeddings/` (architecture.md §12;
 * spec.md §9.4: cache key `embedding_profile_id + SHA256(prepared_text)`,
 * "Unveränderte vorbereitete Texte DÜRFEN NICHT erneut eingebettet werden,
 * sofern der Cache gültig ist").
 *
 * Layout:
 * - one entry file per cached vector, sharded two hex characters deep
 *   (`<hash[0:2]>/<hash>.json`) so a large cache never puts thousands of
 *   files in one directory;
 * - one small `index.json` manifest tracking, per logical cache key, which
 *   entry file holds it, its size, and its last-access time — the LRU
 *   bookkeeping used for size-bounded eviction.
 *
 * Every mutation (`set`, and `get` on a hit, since a hit updates recency)
 * rewrites the manifest via atomic temp+rename. This is O(entry count) per
 * call, a documented, accepted simplification for an MVP-sized local cache
 * (see README "Entscheidungen") — not the right shape for a cache with
 * millions of entries, which would want a real embedded index instead of one
 * JSON file.
 *
 * Reads degrade in a controlled way rather than throwing (docs/BUILD_PLAN.md
 * WP-12 acceptance: "Cache-Löschung ist verlustfrei rekonstruierbar (Reads
 * degradieren kontrolliert)"): a missing entry file, a corrupted entry, or a
 * corrupted manifest are all treated as a cache miss (or an empty cache),
 * self-healing the manifest where relevant — never a thrown error, because
 * the cache is documented as disposable and reconstructible from source
 * (architecture.md §12: "Lokale Caches sind löschbar und rekonstruierbar").
 */
import * as nodePath from "node:path";

import type { Clock, FileSystemPort, PortCallOptions, Random } from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";

import { assertNotAborted } from "./abort.js";
import { isNotFoundError } from "./fs-errors.js";

/** 512 MiB — an Untangle default, not spec-mandated (spec.md §9.4 leaves the
 * limit open); callers pass their own `maxBytes` where config specifies one. */
export const DEFAULT_EMBEDDING_CACHE_MAX_BYTES = 512 * 1024 * 1024;

const MANIFEST_FILE_NAME = "index.json";

export interface EmbeddingCacheStatsV1 {
  entryCount: number;
  totalBytes: number;
}

interface ManifestEntryV1 {
  fileName: string;
  sizeBytes: number;
  lastAccessEpochMs: number;
}

interface ManifestV1 {
  version: 1;
  entries: Record<string, ManifestEntryV1>;
}

interface StoredEntryV1 {
  profileId: string;
  vector: number[];
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function signalOptions(options: PortCallOptions | undefined): PortCallOptions | undefined {
  return options?.signal ? { signal: options.signal } : undefined;
}

function totalBytesOf(manifest: ManifestV1): number {
  let total = 0;
  for (const entry of Object.values(manifest.entries)) {
    total += entry.sizeBytes;
  }
  return total;
}

function pickEvictionCandidate(manifest: ManifestV1, protectedKey: string): string | null {
  const keys = Object.keys(manifest.entries);
  let best: string | null = null;
  let bestAccess = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (key === protectedKey && keys.length === 1) {
      // The just-written entry is the sole entry left — evicting it would
      // silently discard the very value `set()` was asked to store. A
      // single entry larger than `maxBytes` is kept anyway (documented edge
      // case, README "Entscheidungen") rather than making `set()` a no-op.
      continue;
    }
    const entry = manifest.entries[key];
    if (entry !== undefined && entry.lastAccessEpochMs < bestAccess) {
      bestAccess = entry.lastAccessEpochMs;
      best = key;
    }
  }
  return best;
}

/**
 * Cache key exactly per spec.md §9.4: `embedding_profile_id + SHA256(prepared_text)`.
 * Exported so callers/tests can reason about identity without depending on
 * this class's internal file sharding.
 */
export function buildEmbeddingCacheKey(embeddingProfileId: string, preparedText: string): string {
  return `${embeddingProfileId}${sha256Hex(preparedText)}`;
}

export class LocalEmbeddingCache {
  private readonly maxBytes: number;
  private manifest: ManifestV1 | null = null;

  public constructor(
    private readonly fs: FileSystemPort,
    private readonly dir: string,
    private readonly clock: Clock,
    private readonly random: Random,
    options?: { maxBytes?: number },
  ) {
    this.maxBytes = options?.maxBytes ?? DEFAULT_EMBEDDING_CACHE_MAX_BYTES;
  }

  private manifestPath(): string {
    return nodePath.join(this.dir, MANIFEST_FILE_NAME);
  }

  private entryFileName(logicalKey: string): string {
    const hash = sha256Hex(logicalKey);
    return nodePath.join(hash.slice(0, 2), `${hash}.json`);
  }

  private entryPath(fileName: string): string {
    return nodePath.join(this.dir, fileName);
  }

  private async loadManifest(options: PortCallOptions | undefined): Promise<ManifestV1> {
    if (this.manifest !== null) {
      return this.manifest;
    }
    let text: string;
    try {
      text = await this.fs.readTextFile(this.manifestPath(), options);
    } catch (error) {
      if (isNotFoundError(error)) {
        this.manifest = { version: 1, entries: {} };
        return this.manifest;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<ManifestV1>;
      this.manifest =
        parsed.entries !== undefined
          ? { version: 1, entries: parsed.entries }
          : { version: 1, entries: {} };
    } catch {
      // Corrupted manifest — degrade to an empty cache (see file doc comment).
      this.manifest = { version: 1, entries: {} };
    }
    return this.manifest;
  }

  private async persistManifest(
    manifest: ManifestV1,
    options: PortCallOptions | undefined,
  ): Promise<void> {
    await this.fs.mkdir(this.dir, { recursive: true, ...signalOptions(options) });
    const tempPath = `${this.manifestPath()}.${this.random.uuid()}.tmp`;
    await this.fs.writeFile(tempPath, encode(JSON.stringify(manifest)), options);
    await this.fs.rename(tempPath, this.manifestPath(), options);
    this.manifest = manifest;
  }

  public async get(
    embeddingProfileId: string,
    preparedText: string,
    options?: PortCallOptions,
  ): Promise<number[] | null> {
    assertNotAborted(options, "embedding_cache_get");
    const logicalKey = buildEmbeddingCacheKey(embeddingProfileId, preparedText);
    const manifest = await this.loadManifest(options);
    const entry = manifest.entries[logicalKey];
    if (entry === undefined) {
      return null;
    }
    let text: string;
    try {
      text = await this.fs.readTextFile(this.entryPath(entry.fileName), options);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      // Manifest references a file that is gone — self-heal and miss.
      delete manifest.entries[logicalKey];
      await this.persistManifest(manifest, options);
      return null;
    }
    let stored: StoredEntryV1;
    try {
      stored = JSON.parse(text) as StoredEntryV1;
    } catch {
      delete manifest.entries[logicalKey];
      await this.persistManifest(manifest, options);
      return null;
    }
    entry.lastAccessEpochMs = this.clock.nowEpochMs();
    await this.persistManifest(manifest, options);
    return stored.vector;
  }

  public async set(
    embeddingProfileId: string,
    preparedText: string,
    vector: readonly number[],
    options?: PortCallOptions,
  ): Promise<void> {
    assertNotAborted(options, "embedding_cache_set");
    const logicalKey = buildEmbeddingCacheKey(embeddingProfileId, preparedText);
    const fileName = this.entryFileName(logicalKey);
    const entryPath = this.entryPath(fileName);
    const stored: StoredEntryV1 = { profileId: embeddingProfileId, vector: Array.from(vector) };
    const bytes = encode(JSON.stringify(stored));

    await this.fs.mkdir(nodePath.dirname(entryPath), {
      recursive: true,
      ...signalOptions(options),
    });
    const tempPath = `${entryPath}.${this.random.uuid()}.tmp`;
    await this.fs.writeFile(tempPath, bytes, options);
    await this.fs.rename(tempPath, entryPath, options);

    const manifest = await this.loadManifest(options);
    manifest.entries[logicalKey] = {
      fileName,
      sizeBytes: bytes.length,
      lastAccessEpochMs: this.clock.nowEpochMs(),
    };
    await this.evictUntilWithinLimit(manifest, logicalKey, options);
    await this.persistManifest(manifest, options);
  }

  private async evictUntilWithinLimit(
    manifest: ManifestV1,
    justWrittenKey: string,
    options: PortCallOptions | undefined,
  ): Promise<void> {
    let total = totalBytesOf(manifest);
    while (total > this.maxBytes) {
      const victim = pickEvictionCandidate(manifest, justWrittenKey);
      if (victim === null) {
        break;
      }
      const entry = manifest.entries[victim];
      delete manifest.entries[victim];
      if (entry !== undefined) {
        total -= entry.sizeBytes;
        try {
          await this.fs.remove(this.entryPath(entry.fileName), options);
        } catch {
          // Best-effort: the manifest entry is already gone either way, so a
          // future `get()` for this key will miss regardless.
        }
      }
    }
  }

  public async stats(options?: PortCallOptions): Promise<EmbeddingCacheStatsV1> {
    assertNotAborted(options, "embedding_cache_stats");
    const manifest = await this.loadManifest(options);
    return { entryCount: Object.keys(manifest.entries).length, totalBytes: totalBytesOf(manifest) };
  }

  /** Explicit, whole-cache removal (the one "clear everything" operation this
   * class exposes — always naming its exact target: this cache's own directory). */
  public async clear(options?: PortCallOptions): Promise<void> {
    assertNotAborted(options, "embedding_cache_clear");
    await this.fs.remove(this.dir, { recursive: true, ...signalOptions(options) });
    this.manifest = { version: 1, entries: {} };
  }
}
