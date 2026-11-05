/**
 * @untangle-code/embeddings-ollama — `EmbeddingProvider` adapter for Ollama
 * (spec.md §9, architecture.md §6.8). This module is the only public export
 * of the package (rule 11); everything else (`http.ts`, `ollama-api.ts`,
 * `readiness.ts`, `backoff.ts`, `concurrency.ts`, `truncation.ts`,
 * `endpoint.ts`, `validation.ts`) is an internal implementation detail,
 * imported directly only by this package's own co-located tests.
 */

// The adapter itself.
export * from "./provider.js";

// Public configuration and port types.
export * from "./types.js";

// Default in-memory embedding cache (spec.md §9.4) — the port itself lives in types.ts.
export * from "./cache.js";

// Real (non-fake) sleep implementation, exported so callers assembling
// `OllamaEmbeddingProviderDeps` outside tests don't need to reimplement it.
export * from "./sleep.js";
