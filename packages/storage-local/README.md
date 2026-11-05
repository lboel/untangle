# @untangle-code/storage-local

Untangle local state (WP-12/WP-250): the `.untangle/` layout, a persistent size-bounded embedding
cache, an atomic checkpoint mirror, a file-based `LockProvider`, and local Search Journey
persistence. Public package (`private: false`).

Normative sources: [`architecture.md`](../../architecture.md) §12 (layout), §21.1–§21.2 (lock
architecture), [`spec.md`](../../spec.md) §11.2, §12.3, §13.7, §24 (takes precedence in a conflict),
[`docs/BUILD_PLAN.md`](../../docs/BUILD_PLAN.md) (WP-12/WP-250).

Dependencies: **only** `@untangle-code/domain` (`workspace:*`) at runtime;
`@untangle-code/testkit` (`workspace:*`) as a development-only dependency for port contract suites
and deterministic Clock/Random test doubles. No other Untangle packages or external runtime
dependencies.

<a id="modulübersicht"></a>

## Module overview

| Module | Contents | Source |
|---|---|---|
| `layout.ts` | `StateDirLayout`, `buildStateDirLayout()`, `ensureStateDirLayout()`: architecture.md §12 `.untangle/` directory tree | arch §12 |
| `local-file-system.ts` | `LocalFileSystem`: `FileSystemPort` adapter over `node:fs/promises`, path sandbox through domain `assertWithinWorkspace` plus symlink recheck | arch §2.1, §23.1 |
| `lock-provider.ts` | `FileLockProvider`: file-based `LockProvider`, one directory per lock key as an atomic exclusivity primitive, `record.json` written through temp+rename | arch §21.1–§21.2 |
| `checkpoint-store.ts` | `LocalCheckpointStore`: `CheckpointStorePort`, atomic writes through temp+rename | arch §12, §13.3 |
| `embedding-cache.ts` | `LocalEmbeddingCache`, `buildEmbeddingCacheKey()`: persistent size-bounded embedding cache with LRU eviction | spec §9.4 |
| `search-journey-store.ts` | `LocalSearchJourneyStore`: deeply validated, atomic, revision-protected persistence under `.untangle/product-complexity/sessions/`, plus separate HMAC key `.untangle/product-complexity/fingerprint.key` | spec §13.7, §24; WP-250 |
| `storage.ts` | `openLocalStorage()`: wires all the above adapters to a shared `FileSystemPort` | WP-12 decision |
| `abort.ts`, `fs-errors.ts`, `real-time.ts` | internal helpers (AbortSignal handling, Node error-code checks, the one isolated real-time source) | internal |

<a id="verwendung"></a>

## Usage

```ts
import { openLocalStorage } from "@untangle-code/storage-local";

const storage = await openLocalStorage("/abs/path/to/workspace/.untangle", {
  clock, // Clock (domain port) — real SystemClock in production
  random, // Random (domain port) — real SystemRandom in production
});

await storage.embeddingCache.set(profileId, preparedText, vector);
await storage.checkpoints.save(checkpoint);
const journey = await storage.searchJourneys.get(sessionId);
const handle = await storage.locks.acquire(`repo:${repoId}:${refId}:index`, { waitMs: 5_000 });
```

<a id="entscheidungen"></a>

## Decisions

1. **Lock exclusivity through `FileSystemPort.mkdir` without `recursive`, not a separate locking
   library.** Node's `mkdir` atomically fails with `EEXIST` if the target directory exists: a real,
   operating-system-guaranteed exclusivity check directly underlying `FileLockProvider.tryAcquire()`
   (one directory per `sha256(key)`, containing `record.json`). No extra lock-on-lock mechanism is
   needed. The test “two provider instances racing for the same fresh lock” proves this with two
   genuinely concurrent `FileLockProvider` instances in one process. The “lock is free” case is
   entirely race-free because no takeover step is involved.

2. **Stale-lease takeover is deliberately NOT entirely race-free across processes.** A documented,
   accepted MVP limit (architecture.md §21.2 itself explicitly calls file locks “MVP”, with a real
   distributed lease only in “Remote Team Mode”). The takeover window: between “lease recognized
   as expired” and “orphaned directory removed + recreated” is a TOCTOU window where a holder
   renewing its lease *at that exact moment* could theoretically be overwritten. The following
   cases are **not** affected and are therefore tested strictly: (a) contention for a **free** lock
   (decision 1, fully atomic); (b) distinguishing “directory exists, `record.json` not yet present”
   (= *busy*, never treated as *stale*, or a competitor still creating its valid lock would lose
   it to another contender's takeover race); and (c), since the WP-80 fix, “expired” vs. “corrupt”,
   now two distinct cases that must never be confused (see decision 2a).

2a. **`record.json` is written atomically through a temporary file plus `rename`, both on initial
    `tryAcquire()` and every `renew()`.** The exact technique already used by this package's
    `checkpoint-store.ts` (“every write is temporary-file-then-`rename`”). Before this fix (WP-80),
    initial acquire and renew wrote directly to the live path using `fs.writeFile`. A reader could
    theoretically see a torn, partially written record; `JSON.parse` failed, and `readRecordState()`
    treated EVERY parse error as immediately eligible for takeover, regardless of the actual
    holder's lease (“expired OR corrupt = stale”). Process A writing via `renew()` could be
    overtaken by B, interpreting the torn intermediate state as “corrupt, therefore free”; both
    then held the same lock, and A still reported success on its next `renew()`. After the fix,
    only a single atomic `rename` reaches the live path: readers always see either the old complete
    record or the new complete record, never a mixture. This guarantee also applies alongside the
    separate documented TOCTOU gap of stale takeover itself (decision 2). That gap concerns
    *removing* someone else's apparently stale lock directory, not *writing* one's own record; it
    remains a separate, previously documented MVP risk.

    **Since the fix, “expired” and “corrupt” are deliberately separate, no longer one “stale”
    category:**
    - An **expired lease** (`leaseExpiresAt` in the past) remains immediately eligible for
      takeover: the lease itself authorizes when the holder is considered to have given up.
    - An **unreadable (`corrupt`) record** is an ERROR STATE, not a normal lifecycle state. Because
      every write is now atomic, readers fundamentally cannot see torn records. An actually
      unparsable `record.json` means external influence (manual editing, disk fault, a record
      written by an incompatible future format), no longer “caught a write in progress”. A corrupt
      record also lacks its own trustworthy `leaseExpiresAt`, so unlike an expired lease there is
      no information on how long it has been invalid. Immediately freeing it would repeat WP-80
      with a different cause (“I cannot explain it” ≠ “safe to take over”). Selected rule: a
      **grace period** (`DEFAULT_CORRUPT_GRACE_MS`, `lock-provider.ts`, 5 minutes, substantially
      longer than any expected lease/write duration), measured from `record.json` file `mtime`.
      Until that period expires, `tryAcquire()` treats a corrupt record exactly like a validly
      held lock (`null`, no throw, no takeover attempt). Afterwards it automatically becomes
      eligible for takeover like an expired lease. This self-heals without operator action while
      giving a possibly unusually slow legitimate write, or a person investigating the finding,
      ample time before anybody treats it as abandoned. A `FileLockProvider` constructor parameter
      can override the grace period, mainly for tests that check the boundary without waiting
      several real minutes.

3. **Stale detection uses lease expiry only, never PID existence**, exactly as required by
   architecture.md §21.2. Besides mandatory domain `LockRecordV1` fields, `record.json` contains
   internal `processStartedAtEpochMs` (the “start time” required by architecture.md §21.2). It never
   contributes to stale decisions: it is diagnostic information for manually inspecting
   `record.json`, and is therefore absent from `LockHandle.record` (whose shape is exactly
   `LockRecordV1`; the domain contract register allows no extension). The test “PID reuse does not
   cause false takeover” proves this directly: a manually written expired record with
   `pid: process.pid` (the current test environment apparently “is” the holder) is still correctly
   taken over because only `leaseExpiresAt` matters.

4. **`renew()` deliberately creates a new `processInstanceId`** rather than retaining the old one.
   A consistency decision mirroring `InMemoryLockProvider` from `@untangle-code/testkit`. From the
   record's perspective, renewal is a new “term” of the same holder, identified by the handle
   itself (which updates its local `current` reference after every `renew()`), not an ID stable
   throughout the entire holding period.

5. **`LocalFileSystem` symlink checks also cover target paths that do not yet exist**, e.g. a
   `writeFile()` destination. They start at the nearest *existing* ancestor and resolve it against
   `assertWithinWorkspace`, rather than checking only existing final paths as a minimal approach
   would. This catches a *directory* segment symlinking outside the root even when the target file
   does not yet exist (“rejects writing into a new file under a symlinked directory that escapes
   the root”). Known limit: a TOCTOU gap remains between the check and actual `node:fs` call. An
   attacker with filesystem write access could replace a symlink between check and operation.
   Acceptable for the local single-user MVP described in architecture.md §1, not a sufficient
   guarantee for multi-user/sandbox isolation.

6. **Checkpoint corruption is reported loudly (`INDEX_INCOMPLETE`), embedding-cache corruption
   silently degrades to a miss.** Both follow spec.md §25.2 for opposite reasons. A checkpoint is
   the *only* resume record for an ongoing indexing job. Ignoring corruption would invisibly
   disguise a real storage error as “no checkpoint exists” (write-path safety reasoning applied to
   a read path because the underlying issue is consistency, not existence). The embedding cache,
   by contrast, is explicitly “deletable and reconstructable” under architecture.md §12: a missing
   or corrupt entry only means “embed this text again”, never data loss. The checkpoint mirror's
   pointer index (`jobs/latest/<hash>.json`, “which job is latest for this repo+ref”) sits between
   these and is treated like the cache. It is merely an accelerator over the actual separately
   integrity-checked checkpoint files; losing it means “no known latest state”, never actual data
   loss.

7. **The embedding-cache manifest is rewritten completely on every mutation** (`O(number of
   entries)` per `set()`/`get()` hit), rather than incrementally updating a genuine index. Sufficient
   at MVP scale (a local workspace cache) and substantially easier to keep correct than a
   concurrency-safe append log. For very large caches (millions of entries), a real embedded index
   would be the appropriate next step; deliberately not brought forward because it is outside
   this assignment.

8. **Two tsconfigs**, as in domain/scanner: `tsconfig.json` (composite, emit to `dist/`, no tests)
   for the build; `tsconfig.typecheck.json` (`noEmit`, includes tests) for `pnpm run typecheck`.
   Composite projects do not permit `noEmit`.

9. **Comparable journeys are durable learning artifacts, not telemetry.** Search Journeys exist
   only after an explicit `start` in the calling service and remain in the workspace-local state
   directory. The adapter serializes mutations per session, checks a compare-and-swap revision,
   writes through a temporary file plus atomic `rename`, and deeply validates every record on write
   and read. The fingerprint-key lock and both the outer creation lock and inner per-session lock
   use a 30-second lease with non-overlapping renewal attempts every 10 seconds. Immediately before
   an atomic publish, every held lock is owner-checked and a bounded verification loop requires a
   shared window with at least 10 seconds remaining on all of them. Losing ownership or failing to
   converge within eight rounds aborts before `rename` with `LOCK_HELD`. A separate creation lock
   enforces the 10,000-record ceiling across processes; one record is limited to 32 MiB. Before a list/report parses any
   record, it builds a file-and-size manifest for the complete snapshot against a 128 MiB
   cumulative byte budget. Every read rechecks its actual UTF-8 byte count and post-read file size
   before parsing; disappearance or a size/type change fails the whole report visibly—Untangle
   never emits a partial cohort as if it were complete. A same-size atomic replacement cannot be
   distinguished without a versioned file-read primitive and remains a documented local-filesystem
   snapshot boundary. Corrupt or oversized records likewise fail closed instead of entering a
   Product-Complexity cohort. Each exact per-write temporary path is removed best-effort after
   success, cancellation, or I/O failure without reusing the aborted caller signal or masking the
   primary error.

   The persisted contract is privacy-minimized, not anonymous or encrypted. With the default
   `retainText: false`, goal/query text and an optional feature ID declared stable by the caller are represented by
   workspace-local, domain-separated HMAC-SHA-256 fingerprints and no chunk or source content is
   stored. Untagged legacy journeys are never assigned a feature by the adapter. The random key lives outside
   session records at `.untangle/product-complexity/fingerprint.key`; anyone with the complete local
   state and key can test guesses. On POSIX systems, both the key and newly written journey records
   are created with mode `0600`. Result locators, ranks, scores, explicit tool metadata, a controlled
   abandonment reason code, and other lifecycle metadata remain. Callers that opt into
   `retainText: true` additionally persist goal, query, failed-search, and free abandonment text.

   New observations persist measurement context v2. Successful observations do not flatten their
   profile provenance: embedding profile, generation set, and immutable
   `corpusRevisionFingerprint` stay bound to the profile that produced them. The revision originates
   from the completed index's full scanned File-ID/content-hash manifest, including successful
   zero-change incremental runs. The adapter keeps additive legacy records readable and does not
   fabricate a revision for them; report derivation leaves them visible but never
   `sufficientEvidence: true`. Reports are derived rather than stored:
   `sessionCounts.featureTaggedCompleted` counts completed records with an explicit feature
   fingerprint, and feature mappings preserve separate Search Journey and accepted-target
   code-complexity axes.

<a id="bekannte-grenzen-siehe-openissues-im-task-report"></a>

## Known limits (see `openIssues` in the task report)

- No cross-process lock on the embedding cache itself: two processes writing the same key
  simultaneously overwrite each other without error (last writer wins). Unproblematic for the
  intended case: one indexing job per ref, already serialized by `LockProvider`.
- Stale-lock takeover (decision 2) is not covered by real multi-process fuzz testing, only the
  documented race window and same-process tests. A separate multi-process stress test would be a
  useful addition but is outside this assignment.
- **Search Journey records currently have no TTL or delete operation in the port.** `abandon` ends
  measurement but does not remove its record. Files remain local until workspace state is
  deliberately cleaned up.

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
