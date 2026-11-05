/**
 * Convenience wiring: one call that builds the `.untangle/` layout, ensures
 * every directory exists, and hands back the adapters this package provides
 * — a `FileSystemPort` sandboxed to that state root, the embedding cache,
 * the three content-addressed analysis caches (WP-100), the checkpoint mirror
 * and the file-based lock provider, all sharing the same underlying
 * `FileSystemPort`.
 */
import type {
  Clock,
  FileSystemPort,
  LockProvider,
  PortCallOptions,
  Random,
} from "@untangle-code/domain";

import {
  DEFAULT_ANALYSIS_CACHE_MAX_BYTES,
  LocalAnalysisCache,
  LocalContentCache,
} from "./analysis-cache.js";
import { LocalCheckpointStore } from "./checkpoint-store.js";
import { DEFAULT_EMBEDDING_CACHE_MAX_BYTES, LocalEmbeddingCache } from "./embedding-cache.js";
import { buildStateDirLayout, ensureStateDirLayout, type StateDirLayout } from "./layout.js";
import { LocalFileSystem } from "./local-file-system.js";
import { FileLockProvider } from "./lock-provider.js";
import { LocalSearchJourneyStore } from "./search-journey-store.js";

export interface LocalStorageOptions {
  clock: Clock;
  random: Random;
  /** Overrides the persistent embedding cache's size limit (bytes). */
  embeddingCacheMaxBytes?: number;
  /** Overrides the size limit (bytes) of EACH of the three analysis caches (WP-100). */
  analysisCacheMaxBytes?: number;
  /** Overrides `os.hostname()` for lock records — mainly for tests. */
  host?: string;
}

export interface LocalStorage {
  layout: StateDirLayout;
  fs: FileSystemPort;
  embeddingCache: LocalEmbeddingCache;
  /** Parse-, Chunk- und Metrik-Cache, inhaltsadressiert (WP-100). */
  analysisCache: LocalAnalysisCache;
  checkpoints: LocalCheckpointStore;
  locks: LockProvider;
  searchJourneys: LocalSearchJourneyStore;
}

/**
 * Builds the `.untangle/` layout under `stateRoot` (creating every directory
 * if needed) and returns the wired-up local storage adapters. `stateRoot`
 * becomes the ONLY root the returned `FileSystemPort` will resolve paths
 * within (rule 3: "kein Schreiben ausserhalb des Zustandsverzeichnisses").
 */
export async function openLocalStorage(
  stateRoot: string,
  options: LocalStorageOptions,
  callOptions?: PortCallOptions,
): Promise<LocalStorage> {
  const fs = new LocalFileSystem([stateRoot]);
  const layout = buildStateDirLayout(stateRoot);
  await ensureStateDirLayout(fs, layout, callOptions);

  const embeddingCache = new LocalEmbeddingCache(
    fs,
    layout.cache.embeddings,
    options.clock,
    options.random,
    {
      maxBytes: options.embeddingCacheMaxBytes ?? DEFAULT_EMBEDDING_CACHE_MAX_BYTES,
    },
  );
  const analysisMaxBytes = options.analysisCacheMaxBytes ?? DEFAULT_ANALYSIS_CACHE_MAX_BYTES;
  const analysisCache = new LocalAnalysisCache(
    new LocalContentCache(fs, layout.cache.analysis.parse, options.clock, options.random, {
      maxBytes: analysisMaxBytes,
    }),
    new LocalContentCache(fs, layout.cache.analysis.chunk, options.clock, options.random, {
      maxBytes: analysisMaxBytes,
    }),
    new LocalContentCache(fs, layout.cache.analysis.metrics, options.clock, options.random, {
      maxBytes: analysisMaxBytes,
    }),
  );
  const checkpoints = new LocalCheckpointStore(fs, layout.jobs, options.random);
  const locks = new FileLockProvider(fs, layout.locks, options.clock, options.random, options.host);
  const searchJourneys = new LocalSearchJourneyStore(
    fs,
    layout.productComplexity.sessions,
    options.random,
    locks,
    options.clock,
  );

  return { layout, fs, embeddingCache, analysisCache, checkpoints, locks, searchJourneys };
}
