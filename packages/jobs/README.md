# @untangle-code/jobs

The Untangle indexer's job core (WP-13): state machine, typed job events, checkpoints, resume
planning, generation commit, bounded queues with backpressure and cancellation through `AbortSignal`.

Normative sources: `spec.md` §10.5, §11, §12.2, §22; `architecture.md` §2.2, §6.14, §13.1–§13.4,
§21.3–§21.4, §27.5.

<a id="inhalt"></a>

## Contents

- **`JobStateMachine`** (`state-machine.ts`): exactly the state machine from spec.md §11.1,
  including `failed`, `cancel_requested`, `cancelled`. Illegal transitions are rejected with typed
  errors, never silently ignored.
- **`AsyncEventChannel`** (`events.ts`): exposes the typed job events from architecture.md §2.2
  (types in `@untangle-code/domain`) as `AsyncIterable<JobEvent>` (spec.md §22).
- **`BoundedQueue`** (`bounded-queue.ts`): bounded queues from architecture.md §13.2. A full queue
  blocks `push()`, pausing the previous stage. Limits apply to count AND bytes; high-water marks
  are visible through `stats()`.
- **`FileCheckpointStore`** (`checkpoint-store.ts`): `CheckpointStorePort` using `FileSystemPort`,
  atomic through temp+rename, with the exact `IndexCheckpointV1` shape (§13.3).
- **`planResume`** (`resume.ts`): reconstructs remaining work from the last acknowledged checkpoint
  (spec.md §11.2).
- **Stage interfaces** (`stages.ts`): narrow injectable contracts for discovery, analysis,
  embedding, storage, graphs, context and generation commit. This package builds pipeline
  MECHANICS, not domain stages.
- **`IndexJobRunner`** (`runner.ts`): orchestrates events, queues, checkpoints only after
  acknowledged upserts (spec.md §10.5), cancellation only at safe batch boundaries
  (architecture.md §21.3), and `completed` only after complete generation commit (§13.4, enforced
  by domain's `assertGenerationComplete`). On success its terminal observer also publishes the
  immutable `corpusRevisionFingerprint` of the fully scanned corpus manifest.

<a id="entscheidungen"></a>

## Decisions

Deliberate choices left open by source documents:

1. **State-machine transition relation.** spec.md §11.1 lists the pipeline chain and error states,
   but not every edge. Only the immediately next stage is reachable along the chain; `failed` and
   `cancel_requested` are reachable from every nonterminal pipeline stage; `cancel_requested`
   leads only to `cancelled` (or `failed` if cancellation cleanup itself fails); `completed`,
   `failed`, `cancelled` are terminal; self-transitions are not transitions.
2. **Stage as a high-water mark.** The pipeline overlaps work, using backpressure rather than
   phase barriers. The state machine therefore advances as a high-water mark (`advanceTo`) when
   the first work unit reaches a phase. Every individual movement is a legal chain transition;
   it never moves backward. A run without remaining work also crosses intermediate stages legally
   with no work.
3. **Error code for illegal transitions and untyped stage errors.** The closed catalog
   (spec.md §25.1) has no "internal state error" code. Illegal transitions or untyped stage errors
   leave the index incomplete, so they use `INDEX_INCOMPLETE` (`retryable: false`), never a guessed
   infrastructure code (spec.md §25.2). A dedicated code would be clearer and is recorded as an
   additive proposal for the domain owner.
4. **Corrupt checkpoint is not missing checkpoint.** `load`/`loadLatest` return `null` only for
   absence. A corrupt checkpoint throws `INDEX_INCOMPLETE`; silently ignoring it would discard
   acknowledged work and silently restart, prohibited by spec.md §25.2 and E4.
5. **Resume validity.** A checkpoint is accepted only when workspace, repository, ref AND
   `effectiveProfileId` agree (incompatible profiles require a new generation, spec.md §11.2).
   An acknowledged file is skipped only when its content hash also remains unchanged (hash is
   the source of truth, spec.md §12.1). Changed or no-longer-planned files leave the adopted state
   and require fresh acknowledgement; they are never counted twice.
6. **Event-stream cancellation semantics.** `run()` does NOT throw for job failure or
   cancellation; it ends the stream with exactly one terminal event
   (`job_completed` | `job_failed` | `job_cancelled`), the consumable form of returning `cancelled`
   (architecture.md §21.3). Inside the package, long-running methods abort with
   `UntangleError("JOB_CANCELLED")` (spec.md §22). A consumer stopping iteration stops the job
   through internal abort; without external abort, this counts as failure rather than user cancellation.
7. **Memory budget.** One budget (`memoryBudgetBytes`, default 64 MiB) is split equally between
   analysis and upsert queues and appears alongside queue depths in `status()`
   (architecture.md §13.2). `queueCapacities`, `embedBatchSize` and `memoryBudgetBytes` are validated
   when constructing the runner (`CONFIG_INVALID`), not halfway through a run.

   The **only** exception is an item that **alone** exceeds the entire byte budget. Rejecting it
   would silently drop data; waiting would hang rather than apply backpressure because no pull
   could ever create enough room. The exception is narrow:
   - It applies to the ITEM (`size > maxBytes`), not queue occupancy;
   - It applies only to an empty queue so the violation never accumulates with other items;
   - It has a quota (`maxOverBudgetAdmissions`, default 1); once exhausted, `push()` fails with
     `INDEX_INCOMPLETE` rather than permanently exceeding the budget;
   - Every admission is counted (`stats().overBudgetAdmissions`), reported
     (`onOverBudgetAdmission`, logged by the runner as `queue_over_budget_admission`) and reflected
     in high-water marks. Budget violations are never silent (E4).

   Before WP-116, the byte branch depended on `slots.length > 0`. With `capacity: 1`, the queue is
   empty before every push, so the exception applied to EVERY push: 20 × 50 MB crossed a 100-byte
   budget without a single blocked push, despite fully valid configuration.
8. **Checkpoint batch equals embedding batch.** `embedBatchSize` defines the configured file
   batch in spec.md §11.2: exactly one checkpoint is written after each acknowledged batch
   upsert, never before (spec.md §10.5).
9. **Commit order.** Before generation commit, the runner prechecks through
   `validateGenerationCompleteness` with assumed metadata status; AFTER commit,
   `assertGenerationComplete` also enforces the actually reached final metadata state. An
   incomplete generation is never submitted for commit.
10. **Optional injected locks.** When optional `lockProvider` is set, the job holds
    `repo:<repoId>:<refId>:index` (architecture.md §21.1). Validated `lockLeaseMs` defaults to
    30 seconds; the runner renews without overlap no later than one third of its duration.
    Renewal failure aborts the internal pipeline as `LOCK_HELD`. A final renewal proves ownership
    again before the terminal observer; a runner detecting ownership loss does not invoke it.
    Adapter-owned current pointers additionally need serialization per repository/ref, ownership
    checks immediately before publication and generation-CAS replacement. Stale detection and the
    owner-checked renewal operation itself belong to the provider.
11. **Unbounded event channel.** Job events are small and finite per batch; bounded WORK queues,
    rather than the event stream, limit pipeline memory pressure. Slow event consumption therefore
    does not delay the job.
12. **Corpus revision from the complete scan, not the changed subset.** Discovery returns the
    complete mapping of file IDs to content hashes. Only after successful generation commit does
    the runner hash this canonical manifest and pass its immutable `corpusRevisionFingerprint`
    to `onGenerationFinished`. This also applies to incremental runs with zero changed files.
    Failed or cancelled runs publish no corpus revision; reused generations therefore cannot merge
    different corpus snapshots in downstream Search Journeys.

## Tests

Co-located `src/**/*.test.ts`, using only `@untangle-code/testkit` (FakeClock, DeterministicRandom,
MemoryFileSystem, InMemoryLockProvider), with no network or Docker. Coverage includes the complete
transition relation (all 15×15 pairs), demonstrated backpressure (a blocked storage stage limits
analysis to queue capacity plus in-flight work), cancellation producing valid checkpoints and
`cancelled`, exact checkpoint resume without repeating acknowledged work, incomplete generations
never reaching `completed`, successful zero-change runs producing corpus revisions from complete
manifests, and fault injection from architecture.md §27.5 at points 1 (after embedding/before
upsert), 3 (after upsert/before checkpoint) and 5 (after checkpoint/before generation commit), with
post-restart consistency evidence.

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
