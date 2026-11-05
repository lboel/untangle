# @untangle-code/embeddings-ollama

The Ollama `EmbeddingProvider` adapter (WP-10). An internal private package, not published to npm.
It implements domain's `EmbeddingProvider` port against real or managed Ollama: automatic endpoint
detection, seven-step readiness, connection-limited batching with exponential backoff/jitter,
a truncation guard and embedding cache.

Normative sources: [`spec.md`](../../spec.md) §9 (takes precedence; all of 9.1 readiness,
9.2 batching, 9.3 truncation, 9.4 cache), §5.7 (embedding profile ID), §4.5 (configuration),
§3.1–3.2 (modes/endpoints), and [`architecture.md`](../../architecture.md) §6.8.

<a id="was-dieses-package-tut"></a>

## Responsibilities

`OllamaEmbeddingProvider` (`src/provider.ts`) is the only exported class implementing
`EmbeddingProvider`. Its first `ensureReady()`/`embedDocuments()`/`embedQuery()` performs exactly
one readiness sequence from spec.md §9.1 and caches its result for the instance's lifetime:

```text
1. Determine effective endpoint — "auto": native (127.0.0.1:11434) first, otherwise managed (11435)
2. Check reachability           — GET /api/tags
3. Check model availability     — tag match (":latest" suffix tolerated)
4. Pull in managed mode         — POST /api/pull, ONLY for Untangle-managed endpoints
5. Generate probe embedding     — POST /api/embed with fixed probe text
6. Validate vector dimensions   — EMBEDDING_DIMENSION_MISMATCH on mismatch
7. Cache profile/probe time     — EmbeddingReadinessV1, valid for the instance lifetime
```

A dimension mismatch is therefore detected no later than the first
`embedDocuments()`/`embedQuery()` call: both invoke `ensureReady()` before any batch is processed
(spec.md §4.8, before the first index upsert).

<a id="modulübersicht"></a>

## Modules

| Module | Contents |
|---|---|
| `provider.ts` | `OllamaEmbeddingProvider`, the sole `EmbeddingProvider` implementation; readiness cache, batching, cache/retry/truncation orchestration |
| `readiness.ts` | `runReadinessSequence()`, the seven steps in spec.md §9.1 in exactly that order |
| `http.ts` | `OllamaHttpClient`, a `fetch` wrapper with timeout, `AbortSignal`, bounded connection semaphore; `OllamaHttpError` (transient/permanent), `OllamaRequestCancelledError` |
| `ollama-api.ts` | Typed subset of Ollama HTTP API: `/api/tags`, `/api/pull`, `/api/embed` |
| `backoff.ts` | `withRetry()`, exponential backoff with full jitter through injected `Random` |
| `concurrency.ts` | `mapWithConcurrency()`, a small counting semaphore for bounded parallelism and preserved output order |
| `truncation.ts` | `estimateTokenCount()`/`wouldProviderTruncate()`, conservative offline truncation-guard estimates (spec.md §9.3) |
| `cache.ts` | `InMemoryEmbeddingCache`, default `EmbeddingCachePort` implementation |
| `endpoint.ts` | `redactEndpointUrl()`/`joinUrl()` |
| `validation.ts` | `assertVectorDimension()`, shared by readiness probes and regular batches |
| `sleep.ts` | `realSleep`, the only production `SleepFn` implementation |
| `types.ts` | `OllamaEmbeddingProviderConfig`, `EmbeddingCachePort`/`EmbeddingCacheKey`/`EmbeddingCacheEntry`, `SleepFn`, `EmbeddingBatchProgressV1` |

`src/index.ts` is the only public export (rule 10). `http.ts`, `ollama-api.ts`, `readiness.ts`,
`backoff.ts`, `concurrency.ts`, `truncation.ts`, `endpoint.ts` and `validation.ts` are internal
implementation details imported directly only by co-located tests.

<a id="verwendung"></a>

## Usage

```ts
import { OllamaEmbeddingProvider } from "@untangle-code/embeddings-ollama";

const provider = new OllamaEmbeddingProvider(
  {
    profile: { provider: "ollama", model: "nomic-embed-text", dimensions: 768, /* … */ },
    mode: "auto",
    contextLength: 2048,
    batchSize: 32,
    maxConnections: 4,
    requestTimeoutMs: 120000,
  },
  { clock, random }, // from @untangle-code/domain; cache/sleep/fetchImpl optional
);

await provider.ensureReady();
const { vectors, truncated } = await provider.embedDocuments(preparedDocumentTexts);
```

`profile` contains exactly domain's eight `EmbeddingProfile` fields contributing to
`embedding_profile_id` (spec.md §5.7); other fields are operational and deliberately NOT part of
profile identity. The caller, typically config's `deriveEmbeddingProfile`, builds it from user
configuration. This package has no runtime dependency on `config` (rule 3: no dependency on a
package being developed in parallel in the same wave).

<a id="entscheidungen"></a>

## Decisions

Choices left open by spec.md/architecture.md:

- **HTTP API:** `/api/embed` (batch-capable, `input: string[]`) rather than old `/api/embeddings`
  (one text per request), for both `embedDocuments()` and `embedQuery()` (a one-entry array),
  keeping exactly one code path.
- **`/api/pull` with `stream: false`:** Ollama waits for the completed pull and returns one JSON
  response rather than NDJSON, symmetrical with every other client request and requiring no
  streaming parser.
- **Truncation detection is an offline estimate, not a server signal.** `/api/embed` does not
  report actual truncation per input. The adapter compares a conservative token estimate—more
  likely high than low—to `contextLength`, the same trade-off `@untangle-code/chunker` uses for
  budgeting. It is deliberately duplicated rather than imported: chunker estimates beforehand
  to respect budgets; this package estimates afterward to detect overruns. A runtime dependency
  between them would not be justified.
- **Endpoint selection in `"auto"`:** native (`http://127.0.0.1:11434` by default) first, then
  managed (`http://127.0.0.1:11435`) as fallback (spec.md §3.1). Only the latter is treated as
  Untangle-managed; model pull (step 4) happens exclusively there, never at native or
  `"external"` endpoints (spec.md §3.2 forbids modifying other processes).
- **Readiness is cached exactly once per instance** (spec.md §9.1 step 7), without TTL expiration.
  A failed attempt is NOT cached; the next call restarts the sequence. A hard reset, for example
  after an endpoint change, requires a new instance; deliberately simple for the MVP.
- **Bounded connection pool:** a counting semaphore around each `fetch` (`http.ts`), not an
  implementation setting of `fetch` itself. Node 22's `fetch`/`undici` exposes no directly
  injectable connection limit here.
- **Batching versus connection pool:** `batchSize` controls prepared texts in ONE `/api/embed`
  request; `maxConnections` controls simultaneous requests (`concurrency.ts`). Progress is
  reported per completed network batch through `onBatchProgress`, an extension of
  `PortCallOptions` because the port itself has no progress callback.
- **Error classification** (spec.md §9.2): HTTP 429/5xx and network errors are transient/retryable;
  other 4xx responses are permanent and NOT retried. Permanent errors stop the batch explicitly
  with `EMBEDDING_UNAVAILABLE`, `retryable: false`, rather than continuing silently or indefinitely.
- **Cache is NOT persistent by default.** `InMemoryEmbeddingCache` loses state with the process.
  The narrow `EmbeddingCachePort` (`get`/`set` over `{ embeddingProfileId, preparedTextHash }`)
  allows `storage-local` or another adapter to inject persistence without changing this package.
- **Cache is read a second time BEFORE requesting** (WP-117). `embedSlice` makes its miss/join
  decision once, from one `Promise.all` over `cache.get()`. A cache whose `get()` observes state at
  invocation but resolves later—any network/disk cache, precisely the extension point above—would
  otherwise open a race: caller A can finish, write the entry and release its in-flight slot
  between B's read invocation and resolution; B would find neither cache hit nor in-flight entry
  and embed the same text again. `fetchAndSettle` therefore rereads cache immediately before
  requesting, strictly AFTER claiming the in-flight slot, which is released only after
  `cache.set()` resolves. Exactly ONE additional read per claimed key: no waiting on another
  caller's deferred work, so no deadlock, and no retry loop. **Cost:** a second `get()` on a real
  miss, far cheaper than duplicate GPU-bound embedding. Read failures propagate rather than being
  swallowed (E4), with the same visible behavior as failure of the first read.
- **Second-read boundary:** it protects against duplicate work WITHIN one provider instance.
  Caches without read-your-writes guarantees, such as replicated distributed caches, or separate
  process instances can still embed twice; preventing that requires locking in the cache backend,
  not this adapter.

<a id="offene-punkte-openissues"></a>

## Open issues (`openIssues`)

- **`EmbeddingCachePort` conceptually belongs beside `EmbeddingProvider` in domain's `ports.ts`.**
  It is local here because the original task required a local interface plus an open issue,
  allowing immediate adapter testing without parallel edits to domain in the same wave. A
  follow-up work package should move `EmbeddingCacheKey`/`EmbeddingCacheEntry`/`EmbeddingCachePort`
  to domain and switch this adapter—and `storage-local` once it supplies persistence—to that import.
- **`SleepFn` is also not a domain port.** Domain has `Clock` to read time, but no scheduling port
  for an abortable wait of N milliseconds. A local type meets this package's determinism needs;
  moving it to domain would be natural if another adapter needs it.
- **Truncation detection is heuristic, not exact** (see Decisions). Without the model's real
  tokenizer, which Ollama does not expose, exact prediction of server truncation is impossible.
  The estimate is intentionally conservative, preferring excess `embedding_truncated=true` flags
  over missing them, consistent with vision.md §8.4 (no silent data loss).

## Tests

- `src/*.test.ts`: network-free tests against injected fake `fetch`
  (`test-helpers.ts`: `createFakeOllamaFetch`). Core coverage runs
  `runEmbeddingProviderContract()` from `@untangle-code/testkit` against `OllamaEmbeddingProvider`
  (`provider.test.ts`), plus dimension mismatch, backoff schedule (`backoff.test.ts`, deterministic
  `Random` and recording `SleepFn`), cache hits without a second request, mid-batch `AbortSignal`
  cancellation and truncation guards.
- `src/provider.inflight.test.ts`: cache concurrency, in-flight deduplication (WP-78) and the
  late-resolving-cache duplicate-embedding window (WP-117). `GatedLateEmbeddingCache` in
  `test-helpers.ts` can hold a read beyond another call's completion without timing delays.
- `src/ollama.integration.test.ts`: real Ollama at `127.0.0.1:11434` with `qwen3-embedding:0.6b`
  (1024 dimensions). It self-skips (`describe.skipIf`) when the service/model is unavailable.
  Run separately with `pnpm --filter @untangle-code/embeddings-ollama run test:integration`, never
  as part of `pnpm test`/`vitest run` (see `vitest.config.ts` excludes and `vitest.integration.config.ts`).

<a id="lizenz"></a>

## License


**AGPL-3.0-only.** This package includes the complete license in [`LICENSE`](./LICENSE), the
license-choice rationale in [`NOTICE`](./NOTICE), and licenses for all third-party production
dependencies in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). All three ship in the npm
tarball: AGPL-3.0-only §4 and §5 require recipients to receive the license; a README alone is not
a copy of the license.

Local use alone does not trigger an obligation. Copyleft obligations apply to redistribution and
providing a network service (AGPL §13).

Corresponding TypeScript source ships under `src/` in the same tarball; the complete repository
is available at <https://github.com/lboel/untangle>.
