# @untangle-code/testkit

Deterministic network-free test infrastructure: in-memory domain ports needed by fast unit tests
(`Clock`, `Random`, `LoggerPort`, `VectorStore`, `MetadataStore`, `GraphStore`, `LockProvider`,
`FileSystemPort`, `GitPort`), a deterministic `EmbeddingProvider`, one contract suite per port
written against `domain/src/ports.ts` and runnable unchanged against real adapters, a
`FixtureBuilder` for spec.md §27.2 fixtures, retrieval evaluation (`RetrievalCase`, `evaluate()`,
§27.3), and a golden-JSON assertion helper.

No network, Docker or Ollama is required. `src/index.ts` is the only public export.

<a id="module"></a>

## Modules

| File | Purpose |
|---|---|
| `math.ts` | Dot product, L2 norm/normalization, cosine similarity for dense ranking |
| `bm25.ts` | Tokenization, deterministic FNV-1a hashing, Okapi BM25 (`Bm25Index`) |
| `rrf.ts` | Reciprocal rank fusion: RRF only, and only within a collection (spec.md §13.4) |
| `payload-filter.ts` | Qdrant-style `must`/`mustNot`/`should` payload matching |
| `embedder.ts` | `DeterministicEmbedder`, hashed-token-bag embeddings (architecture.md §27.2) |
| `golden.ts` | `assertGoldenJson(name, value, { metaUrl })`, update mode `UNTANGLE_UPDATE_GOLDEN=1` |
| `in-memory/clock.ts` | Manually advanced `FakeClock`, real-time `SystemClock` (sole `Date.now()` call site) |
| `in-memory/random.ts` | `DeterministicRandom`, mulberry32, never `Math.random()` |
| `in-memory/logger.ts` | `CollectingLogger` collects rather than writes `LogEvent` |
| `in-memory/abort.ts` | Internal `AbortSignal`→Promise rejection (`JOB_CANCELLED`), never synchronous throw |
| `in-memory/lock-provider.ts` | `InMemoryLockProvider`, lease-based stale detection (architecture.md §21) |
| `in-memory/vector-store.ts` | `InMemoryVectorStore`, dense/sparse hybrid search, scroll, payload filters |
| `in-memory/metadata-store.ts` | Workspace/ref/manifest/checkpoint/generic records |
| `in-memory/graph-store.ts` | `InMemoryGraphStore`, generation-versioned shards per collection |
| `in-memory/file-system.ts` | `MemoryFileSystem`, `FileSystemPort` with Node `fs`-style error codes |
| `in-memory/git-provider.ts` | `FakeGitProvider`, `GitPort`, content-addressed commits, multiple repositories |
| `contracts/*.contract.ts` | `runVectorStoreContract`/`runMetadataStoreContract`/`runGraphStoreContract`/`runLockProviderContract`/`runFileSystemContract`/`runEmbeddingProviderContract`, one suite per port |
| `fixtures/fixture-builder.ts` | `FixtureBuilder` materializes multi-repository workspaces on real disk |
| `fixtures/generators/*.ts` | Required fixtures: real TS/Python, cycles, minification, parser errors, rename, large functions, `monorepo-multi-service` |
| `retrieval/evaluate.ts` | `evaluate()`: Recall@5, Recall@10, MRR, repository diversity (spec.md §27.3) |

<a id="entscheidungen"></a>

## Decisions

1. **The package was incomplete at integration start.** `src/index.ts` and `README.md` were
   missing despite functional module implementations. Integration added only re-exports of
   existing real code, no placeholder domain logic.

2. **Two actual bugs were found and fixed while adding tests**, rather than adapting tests to
   pass (integration task rule 4). `InMemoryVectorStore.upsert`/`.ensurePayloadIndexes` and
   `LockHandle.renew()` were non-async functions that threw synchronously on missing collections
   or lost locks despite Promise return types, unlike every other port failure here. Uniform
   Promise rejection handling could miss synchronous throws. Making them `async` converts
   internal throws to Promise rejections, with other behavior unchanged.

3. **Port suites, deterministic embedder, fixture builder and retrieval evaluation are built**,
   fully implemented in this round (decisions 7–16). The previous decision not to build them was
   conditional on downstream need; this task explicitly made `src/contracts/` the package's core.

4. **`InMemoryLockProvider.acquire()` deadline handling was an actual bug**, not intentional
   behavior as the previous documentation claimed. It measured deadlines with injected `Clock`
   but waited with real `setTimeout`. Under a stationary `FakeClock`, positive `waitMs` against
   an unexpired held lock hung forever in real time. Deadlines now use fixed internal
   `SystemClock` (`REALTIME` in `lock-provider.ts`); lease expiry in `tryAcquire`/`isExpired`
   remains injected-clock-controlled and deterministic. `lock-provider.test.ts` and
   `lock-provider.contract.ts` protect bounded waiting, with Vitest timeout as fallback.

5. **`InMemoryGraphStore` retains generation history.** `listShardIds(collection,
   { generationId })` asks which shards have an entry in that generation, not which are currently
   at it. Older generations remain readable through `readShard(..., { generationId })` until
   `deleteShards` removes them, matching architecture.md §11.7 and a dedicated regression test.

6. **Missing vector collections fail writes but return empty reads.**
   `upsert`/`ensurePayloadIndexes` require prior `ensureCollection`, rejecting with
   `QDRANT_UNAVAILABLE` otherwise. `hybridQuery`/`retrieve`/`scroll`/`countByFilter`/`deleteByFilter`
   defensively return empty results for unknown collections. Domain has no dedicated
   unprovisioned-collection read code, and reads must never unexpectedly provision collections
   (architecture.md §11.5).

7. **`Bm25Index.addDocument` removed the WRONG vector on repeated IDs**, a critical fixed bug.
   It called `removeDocument(id, vector)` with the NEW vector rather than the stored one, so
   old-only terms never decremented `documentFrequency`, causing permanent drift after changed
   re-adds. `documentVectors` now retains and removes the previous `SparseVector`. `bm25.test.ts`
   compares updated indexes with freshly built final-vector indexes, requiring identical scores.

8. **Two `InMemoryVectorStore.scroll()` bugs were fixed and tested.** (a) A deleted/nonexistent
   cursor made `findIndex` return `-1`, silently restarting at zero and repeating points.
   `resumeIndexAfter` now binary-searches the first ID strictly greater than `offset`, whether
   that ID still exists; beyond-end cursors produce exhausted empty pages. (b) `limit: 0` falsely
   returned `hasMore = false` despite remaining data by comparing the request limit, not actual
   page length. It now compares `page.length` and returns unchanged `offset` as `nextOffset`
   when nothing was consumed. The remaining ambiguous case—zero limit, no previous offset,
   nonempty collection—has no honest unchanged cursor and deliberately throws rather than
   pretending exhaustion. Both cases and this boundary are tested in `vector-store.test.ts`.

9. **Every method of every in-memory port checks `AbortSignal`.** Contract development (decision 13) found
   ignored signals in vector/metadata/graph stores and lock `tryAcquire`/`inspect`, a real
   spec.md §22 defect. `in-memory/abort.ts` now returns `abortedRejection` with
   `UntangleError("JOB_CANCELLED", …)` as the first operation, never a synchronous throw,
   preserving the package's Promise rejection convention.

10. **`DeterministicEmbedder` uses hashed token bags, not a model** (architecture.md §27.2).
    `bm25.ts` tokenization plus two independently salted FNV-1a hashes give every token a fixed
    dimension in `[0, dimensions)` and sign `±1`. Occurrence contributions sum, then L2-normalize.
    Pure arithmetic, no `Math.random()`, stable across processes/platforms. Similar texts share
    signed dimensions and high cosine similarity (tested). `truncated` is always `false` because
    token-bag vectors have no context window.

11. **`MemoryFileSystem` mirrors Node error codes**, not invented ones: `ENOENT`, `EISDIR`,
    `ENOTDIR`, `EEXIST`, `ENOTEMPTY`, `ELOOP`. Domain's fixed error-code catalog (spec.md §25.1) has only sandbox-specific
    `PATH_OUTSIDE_WORKSPACE`, not a generic missing-file code; real adapters wrap native fs errors.
    Mirroring them lets identical `error.code === "ENOENT"` assertions run against both.
    `writeFile` requires an existing parent; missing-path `remove()` is a no-op like
    `fs.rm(..., { force: true })` already used by scanner `NodeFileSystem`. Symlink resolution
    supports only the requested path itself, not intermediary components, the same documented
    simplification as `packages/scanner/src/testing/memory-file-system.ts`.

12. **`FakeGitProvider` commit SHAs are content-addressed**, SHA-256 over parents, sorted files
    and message, never random. `resolveCommit({ kind: "working_tree" | "index" })` returns branch
    HEAD because a fake has no real working tree; `{ kind: "generation" }` requires explicit
    `registerGeneration()` because index generations are not inferable Git concepts.
    `listChangedFiles` detects renames only through byte-identical deletion/addition pairs, not
    similarity. `rename-across-files.ts` deliberately changes content slightly to expose that
    boundary; a later real change-engine detector must tolerate it, but this fake does not.

13. **Deliberately uncovered port behavior** is documented, not silently omitted: VectorStore
    `POINT_TOO_LARGE`, byte budgets and dimension/distance validation are adapter-specific;
    GraphStore `GRAPH_INCOMPLETE` depends on real multipart storage; symlink-aware filesystem
    sandboxing (`realPath`+`assertWithinWorkspace`) is explicitly adapter rather than port
    responsibility; generic filesystem contracts only loosely check adapter-specific string codes.
    Every suite self-tests its in-memory implementation through six
    `*.contract.self-test.test.ts` files. Lock factories can supply a fresh injected `FakeClock`
    alongside the provider: lease assertions then advance exact logical time and check both sides
    of renewal/expiry boundaries, while real filesystem I/O continues normally. Polling, `waitMs`
    budgets and cancellation still use real time. Legacy bare-provider factories remain supported
    with real-clock leases. No global fake timers, enlarged leases or test retries are required.

14. **`FixtureBuilder` materializes real disk**, through `node:fs/promises`/`mkdtemp`, so real
    parser/filesystem adapters can read mandatory fixtures. Generators emit genuine valid source,
    verified in `generators.test.ts` through real `ts.transpileModule` diagnostics and
    `python3 -m py_compile` on written files. Agent reports do not replace these tests. Built:
    TypeScript monorepo, Python multi-package, dependency cycle, minified file, parse errors
    (`complete`/`partial`/`failed`), cross-file rename, large function and WP-44's
    `monorepo-multi-service`. Not requested/built in this round: spec.md §27.2 items 3 (mixed
    frontend/backend/shared, partially covered by multi-service), 9 (context artifacts) and
    10 (different embedding profiles), remaining later tasks.

15. **`evaluate()` formulas are Untangle decisions.** Spec.md §27.3 defines `RetrievalCase`, not
    formulas. Per-case Recall@k is the fraction of `expectedFiles` among first k hits, macro-averaged;
    cases with none count as `1`, vacuously satisfied. MRR averages reciprocal FIRST expected-file
    rank across the FULL unbounded list, `0` if absent. Repository diversity counts distinct
    `repoId` among first 10 hits and averages across cases; meaningful only with repository labels
    in cross-repository benchmarks. `forbiddenFiles` violations are separate, not folded into
    recall: false positives differ from missing positives. `evaluate.test.ts` checks hand calculations.

16. **`assertGoldenJson` uses recursive sorted pretty-printing (`stableStringify`)**, not
    domain's compact single-line hashing `canonicalJson`, which strictly rejects top-level
    undefined. Goldens should be reviewable Git diffs (architecture.md §27.3), so they reside in
    `__golden__` beside the caller (`import.meta.url` passed as `metaUrl`).
    `UNTANGLE_UPDATE_GOLDEN=1` writes rather than compares.

17. **The package remains importable only inside a running Vitest process**, a deliberate known
    limitation, not a concealed regression. Importing Vitest's `expect`, `describe`, `it`,
    `beforeEach`, etc. initializes against a CURRENT worker, so
    `node -e "import('@untangle-code/testkit')"` outside `vitest run` fails with
    `"Vitest failed to access its internal state"` once any such module enters the import chain.
    Reusable contracts require the CALLER's `describe`/`it` to register suites, with no independent
    substitute. The required single barrel forbids another entry such as
    `@untangle-code/testkit/contracts`, propagating the coupling package-wide. This matches wave
    0's normal `vitest` dependency, not devDependency: every intended consumer is a Vitest-run
    test file ("Untangle test infrastructure"). `golden.ts` nevertheless avoids an unnecessary
    Vitest import, using custom string/diff comparisons instead of `expect(...).toEqual(...)`;
    the package-level limitation remains while contracts share the barrel.

<a id="verifikation"></a>

## Verification

```bash
pnpm --filter @untangle-code/testkit run typecheck   # tsc, 0 errors
pnpm --filter @untangle-code/testkit run test        # vitest, 282 passing tests (24 files)
pnpm --filter @untangle-code/testkit run build       # emit to dist/
```

Six contract self-tests (`src/contracts/*.contract.self-test.test.ts`) run port suites against
in-memory implementations, the task's mandatory self-test. `eslint .` and `prettier --check` are
clean for `packages/testkit/src/**/*.ts`, with zero errors/warnings.

<a id="e4-strukturell-absichern-wp-165"></a>

## Structural E4 protection (WP-165)

Across three successive waves, the most frequent defect was not missing bytes but **unsupported
completeness claims**. Coverage (`covered` ∪ `excluded` = full file) cannot detect a gap in the
claim when data itself has no gap. This package provides three related tools against it.

| File | Purpose |
|---|---|
| `src/honesty/finding.ts` | `VisibleFinding`, common shape for skip-ledger entries, diagnostics, warnings, errors and quality downgrades; multiset difference `newFindings` |
| `src/honesty/completeness.ts` | `CompletenessClaimV1`, completeness accompanied by evidence |
| `src/honesty/damage.ts` | Six damage kinds and ready-made building blocks |
| `src/honesty/assert-honest.ts` | `assertHonestUnderDamage` / `runHonestyProbe`, applying damage and judging each case |
| `eslint/no-forged-completeness.js` | Lint rule against the bypass types cannot prevent |

### 1. `assertHonestUnderDamage`

Each damage case must either **report a visible finding** or remain **demonstrably unchanged**.
Changed output without a finding is the failing third case.

Damage kinds: `truncate_content`, `break_structure`, `remove_required_field`, `exceed_limit`,
`force_concurrency`, `abort_signal`.

**E4 also applies to the check itself.** Every kind must execute or be waived WITH a reason in
`waivedDamageKinds`; lacking both fails even if no applied damage found dishonesty. Inapplicable
cases enter report `skipLedger` with reasons. The undamaged baseline also runs twice; nondeterminism
makes change judgments meaningless and is reported as a defect rather than ignored.

**What `claim` must project.** Comparison uses what results claim ABOUT THEIR INPUT, not raw
results. Two actual false-alarm sources motivated this:

1. *Absolute counts do not belong in projection.* Halving a file halves bytes; a smaller chunk
   budget doubles fragments. Both are honest. `completenessClaimProjection` therefore projects
   level, unit, full-accounting yes/no and omission REASONS, never `expected`/`accountedFor`.
2. *Project UNREPORTED loss, not loss itself.* A reasoned skip-ledger gap satisfies E4; its size
   correctly shrinks with input. The question is how much is NEITHER covered NOR explained:
   zero when healthy, remaining zero under honest damage.

<a id="2-completenessclaimv1--vollstaendigkeit-nur-mit-ihrem-beleg"></a>

### 2. `CompletenessClaimV1` — completeness with evidence only

Domain's `ExternalNumberV1` (X3) prevents external values from occupying Untangle metric slots.
This counterpart is stricter: **producers cannot assign `"complete"`.** The only entry,
`claimCompleteness({ subject, evidence })`, accepts evidence: expected coverage, actual coverage,
reasoned omissions and findings. The level is DERIVED. Invalid arithmetic
(`accountedFor + Σ omissions ≠ expected`) and reasonless omissions are rejected.

**What TypeScript can enforce:** half of the desired guarantee; the other half is unenforceable.

- **Enforced:** `CompletenessClaimV1` requires a property keyed by an unexported `unique symbol`.
  Object literals, spreads and `Object.assign` cannot name it; supplying
  `{ level: "complete", … }` as `CompletenessClaimV1` is a compilation error. This structural
  non-forgeability exceeds optional `ExternalNumberV1` branding. `@ts-expect-error` tests in
  `src/honesty/completeness.test.ts` make typecheck fail if enforcement disappears.
- **Not enforced:** `as CompletenessClaimV1`, `as unknown as …`, `any` and `JSON.parse` bypass
  nominal brands. TypeScript cannot forbid assertions.

Two further layers address that boundary:

- **Runtime:** `verifyCompletenessClaim` recalculates level from evidence and compares it.
  Intended reader `completenessLevelOf` verifies first, detecting `as` forgeries on first read.
  `parseCompletenessClaim` also derives levels for external data and discards supplied claims;
  serialized `"complete"` cannot cross the boundary. `requireComplete` guards consumers requiring
  true completeness.
- **Lint:** root `eslint.config.js` enables `untangle/no-forged-completeness` for `packages/**`
  and `apps/**`, prohibiting assertions to `CompletenessClaimV1` and hand-built
  `level: "complete"` literals. Exactly the construction line in `completeness.ts` is exempt by
  path: its symbol key exists only in type space and cannot exist on runtime objects.
  `eslint/no-forged-completeness.test.js` self-tests through `RuleTester`.

Types prevent accidents, runtime checks prevent effects, lint exposes intent. TypeScript offers
no stronger answer.

<a id="3-angewendet-auf-drei-pakete"></a>

### 3. Applied to three packages

`chunker`, `parser-registry` and `context-artifacts` each have `honesty.test.ts` against their REAL
seam, not handwritten intermediates. See their README E4 honesty sections. One discovered defect
is fixed (`ChunkFileResult.degradations`); two boundaries remain explicitly documented.

<a id="bekannte-grenzen-dieser-hilfe"></a>

### Known limits of this helper

- **Concurrency is interleaving at best, not true parallelism.** `concurrencyDamage` starts calls
  with `Promise.all`, inserting another input. It catches wrongly keyed shared caches/singletons
  and cross-input contamination, NOT real worker-thread data races.
- **Cancellation uses a PRE-aborted signal**, never mid-run abort. Timing-based abort after n
  milliseconds would violate repository determinism. This cannot catch consumers that handle
  pre-abort correctly but lose content during mid-run cancellation.
- **Quality depends on caller-written `claim` projection.** Too-coarse projections admit real
  dishonesty; the helper cannot detect that, only enforce that no damage kind silently disappears.

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
