/**
 * Local types for the Ollama `EmbeddingProvider` adapter (spec.md §9, §4.5;
 * architecture.md §6.8).
 */
import type { EmbeddingProfile } from "@untangle-code/domain";

/** Endpoint resolution mode (spec.md §4.5 `EmbeddingConfig.mode`). */
export type OllamaEndpointMode = "auto" | "managed" | "external";

/**
 * Operational settings for one {@link OllamaEmbeddingProvider} instance.
 *
 * `profile` carries exactly the eight `EmbeddingProfile` fields that feed
 * `embedding_profile_id` (spec.md §5.7) — everything else here is
 * operational (endpoints, batching, timeouts) and deliberately NOT part of
 * the profile, matching domain's `EmbeddingProfile` doc comment. Callers
 * (typically `@untangle-code/config`'s `deriveEmbeddingProfile`) are
 * responsible for assembling `profile` from the user's `EmbeddingConfig`;
 * this package only consumes the result, keeping it decoupled from the
 * config package (rule 3: no dependency on a package built in the same
 * wave).
 */
export interface OllamaEmbeddingProviderConfig {
  profile: EmbeddingProfile;
  mode: OllamaEndpointMode;
  /**
   * Explicit endpoint override. Required when `mode` is `"external"`.
   * When `mode` is `"managed"`, overrides {@link managedUrl}. Ignored in
   * `"auto"` mode's native-probe step, but used as the managed fallback
   * there too when set.
   */
  // Optional fields below spell out `| undefined` explicitly (rather than
  // just `?:`) so callers under `exactOptionalPropertyTypes` — including
  // this package's own test helper, which builds a config by spreading
  // caller overrides over defaults — can assign `undefined` to force a
  // field genuinely absent instead of merely "not overridden".
  url?: string | undefined;
  /** Name of the env var holding a bearer token; the token itself is never logged (spec.md §24). */
  apiKeyEnv?: string | undefined;
  /** Model context window in tokens, used only for the truncation guard (spec.md §9.3). */
  contextLength: number;
  /** Number of prepared texts sent per Ollama `/api/embed` request. */
  batchSize: number;
  /** Upper bound on concurrently in-flight HTTP requests to Ollama. */
  maxConnections: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Native Ollama probe URL for `"auto"` mode (spec.md §3.1 default). */
  nativeProbeUrl?: string | undefined;
  /** Managed-container endpoint default (spec.md §3.1 default port 11435). */
  managedUrl?: string | undefined;
  /** Maximum retry attempts per request before a transient error is treated as permanent. */
  maxRetries?: number | undefined;
  /** Base delay for exponential backoff (spec.md §9.2). */
  baseBackoffMs?: number | undefined;
  /** Backoff delay cap. */
  maxBackoffMs?: number | undefined;
}

/** spec.md §3.1 defaults. */
export const DEFAULT_NATIVE_PROBE_URL = "http://127.0.0.1:11434";
export const DEFAULT_MANAGED_URL = "http://127.0.0.1:11435";

export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_BASE_BACKOFF_MS = 250;
export const DEFAULT_MAX_BACKOFF_MS = 8000;

// ---------------------------------------------------------------------------
// Embedding cache (spec.md §9.4)
// ---------------------------------------------------------------------------

/**
 * Cache key per spec.md §9.4: `embedding_profile_id + SHA256(prepared_text)`.
 * Kept as a structured object (rather than a pre-joined string) so a
 * persistent implementation is free to choose its own storage shape.
 */
export interface EmbeddingCacheKey {
  embeddingProfileId: string;
  /** `SHA256(prepared_text)`, hex-encoded. */
  preparedTextHash: string;
}

export interface EmbeddingCacheEntry {
  vector: number[];
  /** Whether provider-side truncation applied when this vector was produced (spec.md §9.3). */
  truncated: boolean;
}

/**
 * Narrow, storage-agnostic embedding cache port.
 *
 * NOT a `@untangle-code/domain` port — the task that produced this adapter
 * defines it here deliberately so it can be exercised immediately, but this
 * interface conceptually belongs in domain's `ports.ts` next to
 * `EmbeddingProvider` so that `storage-local` (or any other persistent
 * implementation) can implement a shared, versioned contract instead of a
 * package-local one. Flagged in the WP-10 report's `openIssues` for a
 * follow-up move.
 */
export interface EmbeddingCachePort {
  get(
    key: EmbeddingCacheKey,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<EmbeddingCacheEntry | null>;
  set(
    key: EmbeddingCacheKey,
    entry: EmbeddingCacheEntry,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sleep (backoff delay)
// ---------------------------------------------------------------------------

/**
 * Injectable delay primitive for backoff waits (spec.md §9.2). Not a
 * `@untangle-code/domain` port (domain has no scheduling port, only `Clock`
 * for reading "now") — tests inject a fake that resolves instantly while
 * still recording the requested delays, so the exponential-backoff schedule
 * is asserted without the test suite actually waiting.
 */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Progress reported once per network batch (spec.md §9.2 "Fortschritt MUSS pro Batch aktualisiert werden"). */
export interface EmbeddingBatchProgressV1 {
  batchIndex: number;
  batchCount: number;
  /** Texts embedded so far across all batches of this call, including cache hits. */
  embeddedCount: number;
  totalCount: number;
}
