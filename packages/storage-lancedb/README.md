# @untangle-code/storage-lancedb

Persistent local storage for Untangle. It implements the `VectorStore` port with
real Lance tables and provides the existing metadata and graph contracts through
the `QdrantMetadataStore` and `QdrantGraphStore` serializers. Those serializers use
the vector port; this factory does not contact a Qdrant server.

```ts
import { createLanceDbStorage } from "@untangle-code/storage-lancedb";

const storage = createLanceDbStorage({
  path: ".untangle/index/lancedb",
  clock, // Untangle Clock port
});

await storage.vectorStore.ensureCollection({
  name: "example",
  denseDimensions: 3,
  denseDistance: "Cosine",
  sparseBm25: true,
  onDiskPayload: true,
});
await storage.vectorStore.upsert("example", [
  { id: "file:example.ts", dense: [1, 0, 0], payload: { language: "typescript" } },
]);
await storage.close();
```

Use an explicit local filesystem path. Untangle's CLI resolves its default to
`.untangle/index/lancedb` inside the workspace. Construction is synchronous and
lazy. LanceDB, Arrow and SQLite load only when needed. Reads of a missing directory
or missing catalog return absent results without creating a database, table or
lock file. Every operation closes its native tables and snapshots in `finally`.
One native connection/session is shared during an access burst to retain Lance's
index caches across graph-shard reads. Active calls hold references; an unref'ed
timer closes it after 100 ms idle. This caches no authoritative payload, catalog
or generation state. `close()` prevents new operations, waits for outstanding
ones and closes any retained connection immediately.

## Storage and consistency

The catalog is a versioned Lance table containing collection specifications and
declared payload indexes. Each collection is another Lance table with its logical
ID, JSON payload, nullable dense vector and sparse term/weight lists. Promoted
scalar-filter tokens, graph timestamps and an ID ordering key are derived from
those persisted values and stored as native columns. IDs are
losslessly encoded as JSON strings; quoting, NULs and UTF-16 surrogate values do
not change their identity. There is no authoritative in-memory mirror or separate
JSON vector database. Collection schemas, dimensions, distance, sparse support and
ownership markers are checked on access. Incompatible data produces
`LANCEDB_SCHEMA_INCOMPATIBLE`, never an empty-success fallback.

Connections use `readConsistencyInterval: 0`. Multi-page reads pin an immutable
table version, so one query does not mix concurrent writer versions. Point
retrieval uses bounded native ID predicates rather than reading the whole corpus.
Scroll applies its ID seek in Lance, projects the requested fields and stops at
one page plus lookahead. It uses an opaque collection-bound keyset cursor; deleting the previous page's
last point does not restart iteration. Separate scroll calls see fresh snapshots,
so a changing corpus is not a transaction spanning all pages.

All cooperating writer processes acquire a SQLite `BEGIN IMMEDIATE` lock before
opening the Lance writer connection. The `.untangle-writer.sqlite` file contains
only an empty guard table: no product, payload, catalog or vector data. SQLite's
OS-backed lock prevents two missing-key merge-inserts from creating duplicate
logical IDs. It has no expiring lease, PID guessing or lock-file takeover. Process
death releases the lock; acknowledged Lance commits survive. An interrupted
collection creation can reuse only an exactly matching, marked Lance table.

This guard is for processes on the **same host and a local filesystem supporting
SQLite locking**. Do not share this directory through network storage, replace or
delete the guard while a writer is running, or write these tables directly through
another Lance client. External writers do not participate in Untangle's mutex.
Back up or move the database with all writers stopped. A Lance batch is atomic;
a multi-batch upsert/delete and a metadata/graph workflow are not one transaction.
Existing generation and multipart graph validation remains in the shared graph
serializer.

## Search and limits

This first adapter uses **exact flat scoring**, not an ANN index. Dense scores are
cosine similarity, dot product or negative Euclidean distance (higher is better).
Sparse text uses Untangle's shared identifier tokenizer and hashed raw term
frequencies. Queries reconstruct collection-wide document frequencies from the
same snapshot and apply `log(1 + (N - df + 0.5) / (df + 0.5))` to the weighted term
dot product. IDF is computed before payload filtering; replacing or deleting a
point cannot leave stale term statistics. This is TF/IDF scoring, without document
length normalization or BM25 saturation, and is not a claim of numerically equal
scores to every Qdrant version. Dense and sparse candidate lists fuse with the
shared reciprocal-rank implementation (`k = 60`), with deterministic ID ties.

Payload filtering supports `must`, `should`, `mustNot`, scalar equality/membership,
numeric ranges, arrays and dotted paths. Scalar/array equality and membership use
promoted native token predicates. Promotion is capped at **4 KiB per encoded
field/value token**, measured with the same UTF-8 JSON encoding on write and
query. Oversized tokens (including mixed short/long membership lists) use the
whole-filter exact fallback; no value is silently dropped. This keeps large
opaque graph fragments out of the scalar index. The graph cleanup timestamp supports native
single-bound ranges; other ranges retain the bounded decoded fallback. Supported
counts and deletes run directly in Lance, so graph cleanup does not decode the
growing collection for every shard. The adapter creates real native BTree indexes
on point ID/order and a LabelList index on promoted tokens during explicit
collection provisioning. Existing compatible collections receive missing managed
indexes on `ensureCollection`, never during reads. Payload-index declarations
remain persisted and type-checked in the catalog; there is no separate native
index for every arbitrary payload path. `onDiskPayload` is preserved and validated
as part of the public collection specification; Lance persists all payloads on
disk and does not emulate Qdrant's in-memory/on-disk payload tuning.

| Option | Default | Effect |
| --- | ---: | --- |
| `upsertMaxPoints` | 256 | Maximum points per native merge batch |
| `upsertBudgetBytes` | 4 MiB | Serialized row budget per batch and point |
| `requestTimeoutMs` | 30,000 | Monotonic deadline for one port call |
| `lockTimeoutMs` | 30,000 | Maximum wait for the mutation guard |
| `scanMaxRows` | 100,000 | Maximum returned rows held by an exact scan/retrieve |
| `scanBudgetBytes` | 128 MiB | Maximum decoded row bytes held by a scan/retrieve |

Exact vector searches and unsupported filter fallbacks use one projected native
Arrow stream with bounded native read-ahead, a row cap and decoded byte checks.
They take time proportional to the collection and hold decoded rows for ranking.
Lexical-only scans omit dense vectors, and dense-only scans omit sparse vectors.
Native seek pages decode only their page and lookahead, not the full corpus on
every request. Broad pages plan ordered key windows once and retrieve payloads
in small indexed batches from the same pinned version. Small graph shards retain
a single direct payload query. There is no decoded snapshot cache between calls.
Native predicate counts/deletes do not materialize matching rows
in JavaScript.
These limits are initial safeguards, not a large-corpus performance guarantee.
Exceeding a scan limit returns a typed error instead of truncated results. Oversize
upserts retain fitting points and report `POINT_TOO_LARGE` with IDs, byte sizes and
the successful input count. Other failed batches report already committed counts;
retrying logical IDs is idempotent.

After a committed upsert batch, tables with at least 32 small fragments are
compacted and their scalar indexes backfilled under the same writer guard.
Normal indexed queries also inspect unindexed new rows; index freshness never
causes them to skip data. Maintenance explicitly uses an epoch cleanup cutoff
and `deleteUnverified: false`, retaining all historical Lance versions and pinned
readers. There is no automatic vacuum; retained versions still consume disk.
Maintenance failure is reported separately from an upsert failure, including the
count already committed, without falsely labeling committed IDs as failed.

Cancellation and deadlines are cooperative around native operations. Native point
lookups, seek pages and merge timeouts receive the remaining call budget. The
public Arrow async iterator in this SDK exposes no native timeout/batch-size
options; streaming checks the deadline and cancellation as each batch arrives and
before every decoded row. An in-flight native batch cannot be hard-preempted.
A running native operation
is awaited before the writer guard is released; cancellation is never treated as
proof that a commit did not happen. Cancellation errors expose
`mayHaveCommitted`. Native count, deletion and optimization have no hard-preemption API in the
pinned SDK. A supported predicate delete is one native operation; fallback deletion
is checked between bounded batches. A busy guard retries without blocking the
event loop and returns `LOCK_HELD` when its wait budget expires. Native failures
return `LANCEDB_UNAVAILABLE` with no silent empty result.

## Decisions and verification

Node 22.13+ or Node 24+ is required, matching Untangle's supported releases. The
mutation guard uses the built-in `node:sqlite` API; early Node 22 versions may emit
Node's experimental warning. The package pins LanceDB 0.30.0 and Arrow 18.1.0.
LanceDB 0.31+ adds optional model runtimes automatically installed by npm, although
this adapter does not use automatic embedding functions. The pin keeps the local
storage installation within the repository's existing dependency-license policy;
it is not an instruction to disable or weaken the license gate. The native SDK
ships platform-specific binaries: this pinned release provides macOS ARM64,
Linux ARM64/x64 (GNU and musl), and Windows ARM64/x64. It does **not** provide a
macOS x64 binding. On a system without a usable native binding, use Untangle's
Qdrant backend; direct complexity analysis and configuration-only workflows stay
usable because the Lance SDK loads lazily. An attempted Lance access reports an
actionable `LANCEDB_UNAVAILABLE` with platform and architecture. Acceptance on one
OS does not prove all platforms.

The tests run unchanged shared vector, metadata and graph port contracts against
native Lance tables. Additional cases cover reopened native tables and row counts,
schema incompatibilities, filters, exact dense/TF-IDF/RRF results, budgets, concurrent
initialization and overlapping writes from independent processes, cancellation
while blocked, failed-write cleanup and SIGKILL recovery. They do not replace the
CLI's installed-package or release-platform acceptance checks.

License: AGPL-3.0-only. See `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.md`.
