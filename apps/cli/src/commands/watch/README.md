# `untangle watch` — complexity watcher (WP-128)

> Achieving the same functionality with less structural, semantic, cyclomatic and cognitive
> complexity is better code, subject to preserved behavior and interfaces. — `vision.md` §1b

This directory contains the standalone complexity watcher. Its entry can be built with
`pnpm --filter @untangle-code/cli run build:watch`; index-watch mode delegates to the complete
CLI build.

## 1. What it measures

The running stream combines:

| Package | Responsibility |
|---|---|
| `@untangle-code/scanner` | Baseline inclusion/exclusion and reasons. |
| `@untangle-code/watcher` | Native events, debounce, reconciliation and ref lock. |
| `@untangle-code/jobs` | BoundedQueue backpressure with visible byte budget. |
| `@untangle-code/parser-registry` | Language adapters, syntax trees and facts. |
| `@untangle-code/chunker` | Semantic load from `CodeChunkDraft.tokenEstimate`. |
| `@untangle-code/complexity` | Three scope metrics and aggregation without double counting. |

Each change reports metric deltas, direction and contributing scopes. Direction and
contribution sites matter together; a bare number hides where responsibility changed.
Human output is English. Legacy machine values `abgebaut`, `aufgebaut`, `unveraendert`
remain stable in JSON and mean decreased, increased and unchanged respectively.

## 2. Four measurements

Three are scope measurements aggregated through `metrics_scope_id` using
`execution_unit` from `packages/complexity/src/scope-aggregate.ts`: each outer execution
unit once, including nested closures without adding them again. Every output names its
reading.

| Metric | Source | Specification |
|---|---|---|
| `cognitive` | IR `computeCognitive`, `untangle-cognitive-v1` | §16.4 |
| `cyclomatic` | `computeCyclomatic(...).extended` | §16.3 |
| `structural` | `parameter_count + return_count + exit_point_count` | §16.5 |

Only structural counts can be summed/disjointly decomposed here. Parent SLOC includes child
lines, while max nesting is a maximum; summing either would double count or lose meaning.

The fourth deliberately is not a scope measurement:

| Metric | Source | Reading |
|---|---|---|
| `semantic` | Sum of file chunk `tokenEstimate` | `file_chunks` |

It estimates how much context must be loaded for the file. This Untangle-local reading is
not a `spec.md` §16 metric; its provenance remains explicit and it is never reported as one.

## 3. Evidence limits

The vision's improvement claim also requires preserved public symbols/tests and no new
dependency edges. Watch measures **complexity only**. A decrease is not proof that a change
improved the product.

The overall direction counts measurements, not magnitudes: tokens cannot be added to
cognitive points. Ties are unchanged rather than a fabricated common score.

## 4. E4 at the interface

Unanalyzed files appear in the same stream as measured files, with reason/stage and details
such as partial parse quality/error-node coverage. They contribute no unreliable complexity
or misleading deltas; later retries can recover. Silent omission would look like no change.

Ignore-rule exclusions are a deliberate exception: `.gitignore`/default-rule omissions are
reported in baseline `filesExcludedByRules`, not one event per path. Ordinary repositories
can have thousands; flooding the stream would hide actual E4 events. Non-rule exclusions
such as binary content, size and unreadable input get individual events.

Each measurement also reports limitations in `notes`: ambiguous adapter scope IDs, missing
`SourceRange` on NodeKind facts and chunker degradation.

## 5. Output

```text
--format text   Human-readable stream (default); color only on a TTY
--format json   One JSON object per event (JSONL)
--out PATH      Also retain the same stream without color
```

Text/JSON derive from identical `events.ts` values. Transcripts contain no terminal control
codes.

## 6. Shutdown

SIGINT/SIGTERM triggers exactly one teardown sequence:

1. Remove signal handlers so a second Ctrl-C can force termination.
2. Stop RepoWatcher timers/watch loop and release its ref lock.
3. Close/drain the queue.
4. Inspect lock state rather than assert it was released.
5. Write completion and close the transcript.

The final event includes elapsed time, processed/unanalyzed counts, net measurement change,
queue high-water count/bytes, budget exceptions and observed lock status.

## 7. Decisions

### Watch the search index

`watch --index` is a separate mode. At startup and each reconciliation interval, the same
scanner as query refresh checks hashes, index configuration and tokenizer contract. A stale,
incompatible or missing index triggers one serialized indexing run followed by a fresh check.

```bash
untangle watch --index --reconcile=30000
untangle watch --index --repo=backend --embedder=offline --format=json
untangle watch --index --baseline-only
```

Multiple repositories require `--repo`; `--ref` must identify a physically checked-out ref.
Auto uses the current index profile, or configured service if no index exists. Offline
explicitly selects the network-free profile.

JSONL events use `kind: index_watch`, repository/ref and freshness. Index reports/progress
stay on stderr; `--out` additionally saves the event stream. Baseline-only performs one
check and any necessary update. `--exit-after=N` ends after N updates; bounded execution
succeeds only if the final check confirms freshness. Errors retain their CLI exits.
SIGINT/SIGTERM propagates to indexing and exits 130 after cleanup. Direct standalone
`dist/commands/watch/cli.js --index` delegates to the full build; `build:watch` remains usable.

1. **BoundedQueue instead of IndexJobRunner.** Pure complexity watch needs neither embedding
   nor storage stages. It uses job backpressure/byte-budget machinery without requiring
   Ollama/Qdrant to reach completion (`architecture.md` §13.2).
2. **A second scope key.** Byte-range metrics IDs correctly identify a measurement scope but
   shift after inserted lines. Cross-state matching therefore uses `matchKey` from the
   original adapter ID plus ordinal. Aggregation still uses `metrics_scope_id`.
3. **Retain the last measurable value after a parse failure.** A partially saved file should
   compare its next successful parse to its last measurable state, not to nothing. The
   intermediate failure is explicit `unanalyzed` evidence.
4. **Check invariants before totaling.** `aggregateScopeTree` throws on violations. Watch
   checks tree invariants and all scope coverage per metric first, reporting an inconsistent
   tree as unanalyzed with its first violations rather than crashing or producing totals.
5. **Closed option parsing.** Unknown options are errors, never silently ignored; ignored
   flags could change what is measured without telling the user.

## 8. Known limits

- Only the root `.gitignore` is installed in the watcher predicate; baseline scanning supports
  nested layers. Reconciliation provides no file/directory distinction, so the predicate
  asks IgnoreEngine both ways and ignores if either applies.
- NodeKind facts have no SourceRange. With ambiguous adapter IDs, structural scope attribution
  is approximate; notes/baseline counts expose this limitation.
- Semantic load is file-wide, not scope-wide, so it has no scope contribution sites.
- Baseline is nonincremental and remeasures each file at startup. A historical measurement
  took approximately 36s for 648 files; this is an observation, not a performance guarantee.
  Persisted baseline resumption remains future work.
- Comparison is against startup measurement, not an arbitrary Git ref or HEAD.

## 9. Reproduce

```bash
pnpm --filter @untangle-code/cli run build:watch
node apps/cli/dist/commands/watch/cli.js --baseline-only
node apps/cli/dist/commands/watch/cli.js --out watch.jsonl
node apps/cli/dist/commands/watch/cli.js --format json | jq -c 'select(.kind=="change")'
```
