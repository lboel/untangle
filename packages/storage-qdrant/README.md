# @untangle-code/storage-qdrant

Untangle's Qdrant storage adapters (WP-11), implementing three domain ports over Qdrant REST:

- **`QdrantVectorStore`** (`VectorStore`, spec.md §10): collection provisioning (§10.1/§10.2),
  payload indexes (§10.4), idempotent doubly budgeted upserts (§10.5), hybrid query with dense/BM25
  and within-collection RRF (§13.2).
- **`QdrantMetadataStore`** (`MetadataStore`, architecture.md §11.5): workspace, repository/ref,
  file-manifest, checkpoint and profile records as dummy-vector points in `{prefix}metadata_v1`.
- **`QdrantGraphStore`** (`GraphStore`, architecture.md §11.6–§11.7): multipart shards with
  `logical_shard_id`, `part_index`, `part_count`, `write_id` and checksum. Readers accept only
  complete consistent writes; otherwise `GRAPH_INCOMPLETE`.

`mergeAcrossCollections` / `hybridQueryAcrossCollections` enforce spec.md §13.4's cross-collection
rule; `provisionCodeCollection` combines naming, schema and indexes;
`resolveQdrantStorageConfig` resolves `QdrantConfig` from spec.md §4.4.

<a id="verwendung"></a>

## Usage

```ts
import {
  createQdrantStorage,
  provisionCodeCollection,
  resolveQdrantStorageConfig,
  textToBm25SparseVector,
} from "@untangle-code/storage-qdrant";

const config = resolveQdrantStorageConfig({ mode: "managed" }, process.env);
const { vectorStore, metadataStore, graphStore } = createQdrantStorage({
  config,
  clock, // Clock port, never Date.now()
});
const { collection } = await provisionCodeCollection(vectorStore, {
  prefix: config.collectionPrefix,
  profile: effectiveEmbeddingProfile,
});
```

<a id="bm25-serverseitig-oder-clientseitig"></a>

## BM25: server-side or client-side?

The initial check asked whether the available Qdrant offered server-side sparse **text** inference:
server tokenization through `Document` query objects with a BM25 inference model, for example.
This inference belongs to managed cloud or optional FastEmbed integrations and is **not guaranteed**
in standard OSS deployments (Docker images without extra components). The decision is:

- **Client-side tokenization and term frequencies:** `textToBm25SparseVector()` creates raw TF
  sparse vectors from FNV-1a-hashed tokens;
- **Server-side IDF weighting:** the collection declares sparse vector `bm25` with
  `modifier: "idf"` (spec.md §10.2); Qdrant uses corpus-wide statistics at query time.

This works identically against Qdrant versions supporting sparse vectors and testkit's in-memory
store. It was verified against local OSS Qdrant 1.18.0: a collection with `bm25`/`modifier: "idf"`
and client TF vectors produced the expected hybrid ranking.

## Tests

- `contract.test.ts` runs **unchanged** testkit port suites (`runVectorStoreContract`,
  `runMetadataStoreContract`, `runGraphStoreContract`) against adapters using `FakeQdrantServer`
  (`src/testing/fake-qdrant-server.ts`), an in-process Qdrant REST implementation for collections,
  indexes, upsert, retrieve, scroll, count, delete-by-filter and prefetch/RRF query.
- Additional tests cover byte budgets triggering before point count, `POINT_TOO_LARGE`, partial
  failure isolation, timeout versus missing collection, side-effect-free status reads, multipart
  roundtrip, incomplete shards producing `GRAPH_INCOMPLETE`, and profile separation (§13.4).
- `qdrant.integration.test.ts` uses real Qdrant (`UNTANGLE_QDRANT_URL`, default
  `http://127.0.0.1:6333`), **self-skips** when unreachable, creates only randomly test-prefixed
  collections (`untangle_it_<random>_`) and guarantees their deletion in `afterAll`.

<a id="entscheidungen"></a>

## Decisions

1. **Point IDs:** Qdrant requires UUID/integer IDs; the port accepts arbitrary strings. IDs map
   deterministically through `UUIDv5("qdrant_point" + US + id)` (idempotent upserts, §10.5), storing
   the original under reserved payload key `untangle_stored_point_id`. Every read path removes
   this key, so callers' payloads roundtrip unchanged. With `withPayload: false`, only that key
   is requested on the wire (`with_payload: {include: [...]}`), preserving original-ID recovery.
2. **404 interpretation:** only an HTTP 404 **response** means missing collection: reads return
   empty results; writes throw with the server reason. Transport timeouts/network errors are
   **thrown** as `QDRANT_UNAVAILABLE`, `retryable: true`, structurally preventing misinterpretation
   as absence (architecture.md §22.2). `AbortSignal` cancellation is always `JOB_CANCELLED`, never
   infrastructure failure.
3. **Partial upserts** (§10.5): oversized individual points are excluded beforehand; valid points
   are written, then `POINT_TOO_LARGE` is thrown with affected IDs and `upsertedCount` in context.
   A server-failed batch is retried point by point; final individual failures are collected and
   thrown with server reasons. Nothing disappears silently. Multipart splitting of oversized code
   points is deliberately reserved for GraphStore: an oversized code chunk is a chunker budget
   error that should fail visibly.
4. **Multipart layout** (architecture.md §11.7): shards are packed **by entry** (top-level payload
   entries). An individual over-budget entry splits into string fragments of its canonical JSON,
   concatenable without loss. Every part carries the checksum (SHA-256 of the full canonical
   payload) and monotonically increasing `written_at_epoch_ms` from injected `Clock`.
5. **Multipart reads:** the **newest complete** write group wins by `written_at_epoch_ms`, breaking
   ties deterministically with lexicographically greatest `write_id`. A newer incomplete write
   from a crash never hides the last complete one because it was never committed. Parts without
   any complete group throw `GRAPH_INCOMPLETE`, never empty data (§22.2/§10.6).
6. **Concurrent multipart writes (WP-77):** `writeShard()` has two non-atomic REST steps: upsert
   parts, then delete old writes. The former cleanup rule deleting ALL other writes for the same
   shard/generation allowed mutual deletion: if both upserts landed before both cleanups,
   cleanup C removed D and cleanup D removed C. Both writers reported success while the shard
   vanished. The solution is **time-ordered cleanup plus post-verification**, rather than commit
   markers or precheck/retry:
   - Cleanup deletes only writes with **strictly smaller** `written_at_epoch_ms`, using `lt` on
     its own timestamp. A deleting B requires `writtenAt(B) < writtenAt(A)`, an antisymmetric
     relation preventing mutual deletion. The greatest-timestamp write always survives fully,
     including clock skew and equal timestamps, where strict `lt` deletes neither.
   - After cleanup, writers **count** their own parts through `countByFilter` on their
     `write_id`. Missing parts mean a concurrent newer writer overtook them; they throw
     `LOCK_HELD` (`retryable: true`) rather than silently succeeding. At most one of two racing
     writers can be strictly older, so at most one fails, never both.
   - The invariant, tested through deterministic transport in `graph-store.test.ts`'s "WP-77
     regression", is: after concurrent writes, EITHER a complete checksum-verified shard is
     readable OR at least one writer received an error. Both never report success while the
     shard disappears.
   - Trade-off: a commit-marker point would add a third REST step and special read logic, still
     non-atomic with cleanup; precheck/retry remains check-then-act racing. Time ordering uses
     existing per-instance strictly monotone `written_at_epoch_ms` and makes safety combinatorially
     provable. Remaining cost: parts from a crashed NEWER write remain until an even newer write
     removes them; readers already ignore incomplete groups.
7. **Per-branch hybrid-query scores:** Qdrant's RRF response has no branch diagnostics, so
   `denseScore`/`sparseRank` are populated only for single-branch queries: dense-only
   `denseScore = score`, sparse-only `sparseRank = rank index`.
8. **Cross-collection** (§13.4): compatible collections merge with **rank** RRF, an explicit
   normalization strategy, never sorting raw RRF scores. Incompatible profiles produce separate
   groups, `profileSeparation: true` and explicit `notice` text.
9. **Metadata layout:** one point per record with dummy dense `[0]` (`Dot`, never vector-queried).
   `point_type`, `repo_id`, `ref_id`, `record_kind`, `generation_id`, `saved_at` are promoted to
   top level for server-side list filtering. Only generic `listRecords` field filters run
   client-side because record shapes are arbitrary. `getLatestCheckpoint` compares `savedAt`
   lexicographically as ISO timestamps, with `jobId` as a deterministic tiebreak.
10. **Lazy provisioning on writes only:** metadata/graph writes create collections on the first
    write, cached per instance; pure status reads never create collections (architecture.md §11.5).
    If a collection is externally deleted, the next write fails loudly rather than recreating it silently.
11. **Schema conflicts:** `ensureCollection` throws `QDRANT_SCHEMA_INCOMPATIBLE` for differing
    dense dimensions/distance or missing `bm25` sparse vectors (profile changes create new
    collections, architecture.md §11.3), and for payload indexes with differing types. It never
    silently ignores conflicts.
12. **BM25 reimplementation:** `bm25-text.ts` deliberately reproduces testkit's algorithm for
    production because test infrastructure is not a production dependency. `bm25-text.test.ts`
    protects parity against testkit.
13. **Retry policy:** only transport-thrown retryable errors and HTTP 429/5xx are retried up to
    `maxRetries`; every adapter operation is idempotent. `JOB_CANCELLED` and 4xx are never retried.
14. **`hybridQuery` without query vectors** returns `[]` without contacting the server: nothing
    can be ranked, and a read must not create collections.

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
