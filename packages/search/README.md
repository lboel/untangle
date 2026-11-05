# @untangle-code/search

Untangle's **retrieval core** (spec.md §13, architecture.md §18, vision.md §1b/§1d/§1e): hybrid
search, explainable score breakdowns, retrieval funnels, Search Journeys, complexity and
Findability filters, grep mode, and deterministic output formats. I/O goes exclusively through the
domain ports (`VectorStore`, `EmbeddingProvider`, `SearchJourneyStorePort`, `Clock`, `Random`,
`LoggerPort`); no Qdrant details, `Date.now()`, `Math.random()`, or `localeCompare`.

Normative sources: [`spec.md`](../../spec.md) §13 (takes precedence in a conflict),
[`architecture.md`](../../architecture.md) §18, [`vision.md`](../../vision.md) §1b/§1d/§1e.

<a id="wofür-das-paket-da-ist"></a>

## Purpose

> **Product complexity is the distance between intent and implementation.** Easy to find is
> evidence of a product that is well-defined, clear, and easy to understand. It is evidence, not
> proof: search effort is a sensor whose meaning depends on the retrieval context and an explicit
> target.

The user described the original goal as follows (translated):

> “When I search for ‘function X’, I should quickly reach the right place. If I do not, the code
> may be too complex or insufficiently documented.”

This currently produces three separate but connected capabilities:

- **Search**: dense + lexical + exact symbol name, fused with RRF.
- **Findability**: the same score breakdown used as a synthetic self-probe of a known symbol
  (`findability.ts`: a symbol searches for itself; if it cannot find itself, the cause is named).
- **Dynamic Search Complexity**: several real search attempts within a task, up to an explicitly
  confirmed target (`product-complexity.ts`), including retrieval funnels, reformulations,
  candidate dispersion, and explicitly reported navigation. **Dynamic Product Complexity** emerges
  only across several completed, comparable Journeys.
- **Feature Probes**: optionally tagged Journeys connecting a pseudonymized product capability to
  confirmed code targets and reporting Search Complexity and Target-Code Complexity as two
  separate evidence axes.

Static Code Complexity remains separate. It can be a filter (`--cognitive-min`), a visible score
component (`complexity_modifier`), or a query sort key. Dynamic Search Complexity instead assesses
the observed route from product intent to implementation location rather than a file's control
flow. Product Complexity aggregates these task-local vectors only within compatible cohorts.

<a id="modulübersicht"></a>

## Module overview

| Module | Contents | Normative source |
|---|---|---|
| `types.ts` | `UntangleSearchRequestV1` (= `SearchRequestV1` + mode/grep/format/bias), `GrepRequestV1`, `GrepResultSetV1` | spec §13.1; request A4 |
| `port.ts` | `SearchPort` (`search`, `grep`), `ProfileTargetV1`, `SparseVectorizer`, `FindabilityLookup`, `GraphProximityLookup` | arch §18.1 |
| `engine.ts` | `HybridSearchEngine`: reference port implementation; returns retrieval diagnostics, an effective ranking-context fingerprint, and a profile-bound corpus revision when index context is complete | spec §13.2, §13.7 |
| `tokenize.ts` | identifier-aware tokenization (`getUserById` → `getuserbyid`, `get`, `user`, `by`, `id`) | spec §13.2 step 3 |
| `bm25.ts` | `Bm25Ranker`: a deterministic local Okapi BM25 over the candidate pool | spec §10.2, §13.2 |
| `symbol-match.ts` | four-tier name comparison and storage filter candidates | vision §1d |
| `fusion.ts` | weighted Reciprocal Rank Fusion, `k = 60`, normalized against the theoretical maximum | spec §13.4 |
| `scoring.ts` | `ScoreBreakdownV1`, including boost cap (`MAX_BOOST_SHARE`) | spec §13.3 |
| `relevance.ts` | profile-calibrated absolute/relative relevance decisions and absence statements | vision §1d; WP-231 |
| `filter.ts` | `SearchFiltersV1` → `PayloadFilter` **plus** a list of filters that cannot be pushed down | spec §13.2 step 7, §10.4 |
| `glob.ts` | deterministic glob matching for path inclusion/exclusion | request A4 |
| `dedupe.ts` | dedupe key `workspace + repo + ref + metrics_scope_id`, Related Fragments | arch §18.4; spec §13.5 |
| `diversify.ts` | saturating duplicate penalty per file/repository | arch §18.5 |
| `sort.ts` | sorting with code-point tie-breaking, rank assignment | request A4 |
| `grep.ts` | regex/literal search over indexed content, with context lines and budgets | request A4 |
| `format.ts` | Text / JSON / JSONL | request A4 |
| `findability.ts` | self-probes, dispersion, hops, named causes | vision §1d |
| `product-complexity.ts` | `SearchJourneyService`, task-based assessments, compatible workspace cohorts, and Feature→Code mappings separated by feature fingerprint and measurement context; incomplete evidence remains visible but never sufficient | spec §13.7; vision §1e; WP-248/WP-249/WP-253 |
| `payload.ts` | stored payload → candidate, with a named reason when unusable | spec §10.3 |
| `ledger.ts` | Skip Ledger collector | BUILD_PLAN E4 |

All public symbols are re-exported exclusively through `src/index.ts`.

## Dynamic Product Complexity


A Search Journey is an opt-in observation of real work, not a synthetic benchmark. It starts with a
task goal, records successful and failed searches, accepts explicitly reported file/symbol/graph
navigation, and can end as `completed` or `abandoned`. A completed journey requires at least one
search attempt and an explicit file, chunk, or symbol target. Until then, Untangle does not infer
that the agent found the right place.

An optional stable `featureId` turns that task into a repeatable Feature Probe. The service stores
it as a separate workspace-local HMAC fingerprint unless text retention is enabled. New search
observations preserve the hit's versioned `ComplexitySummaryV1` and payload-completeness evidence;
completion exposes this as observed target-code evidence only when the accepted candidate is
unambiguous. Missing, broad, or legacy evidence stays explicitly unavailable.

The assessment exposes components rather than one opaque number: searches and reformulations to
target, accepted rank and reciprocal rank when the target was returned, retrieval health, eligible
and exposed candidates, file dispersion, candidate churn, limit pressure, and observed navigation
hops. An externally found or profile-ambiguous target remains valid evidence but receives no
invented rank.

Reports keep search effort and target-code complexity side by side. Embeddings are retrieval
representations, not complexity metrics, and no combined score or causal relationship is emitted.
`featureMappings` include only explicitly tagged journeys and group by both feature fingerprint and
measurement context. Target metric variants keep their exact scope, metrics version, and index
generation instead of being averaged across incompatible evidence. The report-level
`sessionCounts.featureTaggedCompleted` counts exactly the completed, explicitly tagged journeys;
untagged completed journeys can contribute to workspace cohorts but not to feature mappings.

One completed journey has a caller-closed discovery record for that task and target. The wider
question — whether the product is valuable or the target is the right product decision — remains
feedback-open. Reports
therefore aggregate only journeys with the same effective ranker, ranking-context fingerprint,
result limit and candidate limit, with the embedding profile, generation set, and immutable corpus
revision bound together separately for every searched profile. At least three completed journeys
with a complete context are required before `sufficientEvidence` becomes true. Even then, the
cohort is a heuristic, timeless learning artifact, not a precision claim, temporal trend view, or
universal product score.

Text retention is deliberately narrow. By default, task and query text become workspace-local,
domain-separated HMAC-SHA-256 fingerprints; successful candidates retain locators,
profile/generation, rank, and score, never chunk or source content. `retainText: true` additionally
retains goal/query text, failed-search reasons, and free abandonment details. The HMAC key is
supplied by the storage adapter and kept outside the session records. This is pseudonymization, not
anonymity or encryption: an operator with the full local state and key can test guesses. Explicit
tool metadata and a controlled abandonment `reasonCode` may remain without `retainText` and should
not contain secrets.

Every retained goal/query, free reason, tool name, and individual locator component is capped at
4,096 UTF-16 code units; `featureId` remains capped at 256. These limits apply in the service and
persisted-domain validator as well as MCP, so a direct adapter call cannot bypass them. Successful
results are first reduced to the exact bounded profile/candidate projection that is both
fingerprinted and retained; every service-created Journey state is then domain-validated before
any `SearchJourneyStorePort.put`, including with a permissive alternate adapter. Confirmed and
navigated targets are normalized into a new bounded locator object before persistence.

Without an explicit `acceptedAttemptId`, every search through `complete` remains part of the effort
vector; rank and score margin are attributed to the last matching attempt with a visible caveat.
Supplying an earlier accepted attempt deliberately closes the search portion at that attempt. New
explicit completions retain that ID in `outcome.acceptedAttemptId`, so persisted and MCP-returned
assessments can be checked against the exact attempt even when a target repeats or numbered results
arrive out of order. Legacy outcomes without the additive field retain last-match reconstruction.
Partially unhealthy retrieval never qualifies as a complete measurement context and therefore
cannot make a cohort `sufficientEvidence: true`.
Callers can provide the locally known generation, corpus revision, and run outcome for each
repository/ref. Only a `completed` index context with its `corpusRevisionFingerprint` is
measurement-healthy. The immutable revision is derived from the complete scanned
File-ID/content-hash manifest after every completed index, including a zero-change incremental run.
Hits from a running, cancelled, failed, legacy, or otherwise unverifiable context remain usable,
while the result warning `INDEX_CONTEXT_INCOMPLETE` makes a linked Search Journey's retrieval
unhealthy and its measurement context incomplete.
A rejected candidate with reason `missing_index_entry` or the result warning `INCOMPLETE_PAYLOAD`
has the same effect: useful partial results remain available, but incomplete index evidence never
counts as healthy retrieval.
Completeness also requires retrieval diagnostics and one identical full attempt tuple across every
counted successful search: ranker, ranking-context fingerprint, effective result/candidate limits,
and each profile's bound embedding-profile, index-generation set, and corpus revision. New
observations mark this as measurement context v2. Legacy sessions remain readable and visible in
reports, but the report deliberately downgrades them to incomplete so they can never make a cohort
sufficient. Missing diagnostics or any tuple change has the same result.

A journey accepts at most 128 search attempts and 512 navigation events. Optional client steps are
1-based and make retries idempotent: the same step with the same observation is reused, while the
same step with different evidence conflicts. Numbered and unnumbered attempts cannot be mixed, and
a numbered journey cannot complete with gaps in its step sequence. Active and abandoned journeys
remain visible in report counts but never enter cohort metrics.

<a id="die-zentrale-bauentscheidung-abruf--rangfolge"></a>

## The central design decision: retrieval ≠ ranking

```text
RETRIEVAL (from storage)              RANKING (in this process)
────────────────────────              ──────────────────────────────
hybridQuery(dense)      ─┐            dense rank     (storage cosine)
hybridQuery(sparse)     ─┼─► Pool ─►  lexical rank   (local BM25)       ─► RRF ─► base_hybrid
scroll(symbol_name in …)─┘            symbol rank    (name comparison)
```

The **search mode** selects retrieval and ranking: `semantic` queries dense only, `lexical` sparse
only, and `symbol` the exact-name filter only. Lexical and symbol search do not create a query
embedding. `hybrid` starts all three branches independently and fuses the branches retrieved
successfully. A branch failure leaves the other responses usable and is reported through
`SEARCH_BRANCH_UNAVAILABLE` (branch and original error code), a caveat, and the Skip Ledger. If every
requested branch of every profile fails, search throws a provider error; zero hits from a successful
search remain distinguishable. Cancellation signals are forwarded.
Hybrid branches have their own deadline, 10 seconds by default: a hanging branch is cancelled and
also reported through `SEARCH_BRANCH_TIMEOUT`, while successful branches respond. The deadline is
configurable through `branchTimeoutMs` in the engine port and belongs to the ranking context. Pure
semantic/lexical/symbol search uses the outer call deadline so a semantic model cold start gets its
regular time allowance.

A dense/sparse absence policy is explicitly not evaluated when calibrated branch evidence is
missing; an observed exact symbol name remains direct evidence. Partially failed hybrid retrieval
does not supply a complete Journey measurement context. The new retrieval strategy is versioned in
the ranking context, keeping older Journeys with the previous mode behavior separate.

<a id="die-score-zerlegung-ist-öffentliche-api"></a>

## The score breakdown is public API

```text
final = base_hybrid
      + exact_symbol_boost + exact_path_boost + repo_priority_boost
      + graph_proximity_boost + recency_boost
      + complexity_modifier
      - duplicate_penalty
```

Each component carries `rawValue`, `weight`, `contribution = rawValue * weight`, and evidence
(`evidence`). The domain's `validateScoreBreakdown()` checks the identity and sum; this package's
tests call it on **every** generated hit.

Text output for a hit:

```text
  1. 1.0743  billing@main src/payment/payment-service.ts:1-3 method charge
      complexity: cognitive 22
      why:
      + base_hybrid = 1.0000 (raw 1.0000 x weight 1.0000)  [RRF over dense#1, lexical#1, symbol#1]
      + exact_symbol_boost = 0.1500 (raw 1.0000 x weight 0.1500)  [symbol_name == "charge"]
```

<a id="entscheidungen"></a>

## Decisions

Where spec.md/architecture.md leave questions open, the following reasoned decisions apply.
Downstream packages that need something else should extend **additively**.

1. **Lexical ranking happens here, not in storage.** The `VectorStore` sparse branch supplies
   candidates (recall); `Bm25Ranker` computes their rank in this process. The score breakdown must be
   reproducible, and Qdrant's IDF statistics are not reproducible outside Qdrant. The trade-off: IDF
   applies to the candidate pool rather than the entire corpus (see “Known limits”).

2. **Sparse vectorization is injected (`SparseVectorizer`), not implemented here.** It must match
   index-run tokenization bit for bit, so it belongs to the storage adapter. Without it, hybrid
   loses sparse retrieval and reports `SPARSE_RECALL_UNAVAILABLE` and the failed branch evidence.
   Pure lexical search then cannot execute any branch and reports an error. Semantic and symbol
   search do not need a sparse vectorizer.

3. **`k = 60` in the RRF formula** comes from the original paper (Cormack/Clarke/Buettcher 2009) and
   is the default in Qdrant's own RRF implementation. Branch weights are dense 1.0, lexical 1.0,
   **symbol name 0.5**: half weight because an exact name match also receives `exact_symbol_boost`
   and would otherwise count twice.

4. **Normalization uses the theoretical maximum, not the best hit in the list.** Otherwise the
   best hit would always score 1.0, even when poor; Findability diagnosis needs that distinction.

5. **Boosts are capped at `MAX_BOOST_SHARE = 0.5` of the base amount** (spec §13.3: they “must not
   completely override Dense/BM25”). The cap applies to the **weight**, not the contribution, keeping
   `contribution = rawValue * weight` true and the raw signal visible. The cap is disclosed through
   `clamped`/`clampReason`.

6. **The complexity modifier is OFF by default.** Complexity must not silently shift ranking.
   Opting in (`complexityBias: "prefer-simple"`) adds a visible `complexity_modifier` to the
   breakdown. For this, `SCORE_COMPONENT_KINDS` in `packages/domain` was extended **additively** with
   `"complexity_modifier"`, as was `ScoreBreakdownV1.inputs` with optional fields `denseRank`,
   `lexicalScore`, `lexicalRank`, `symbolRank`: without them, three-branch fusion could not be
   reproduced. No existing signature changed.

7. **A component with raw value 0 is omitted rather than emitted as zero.** A breakdown should
   explain what happened, not everything that could have happened, keeping output economical in
   tokens (vision §1a, “For Agents”).

8. **`changedSince` is pushed into storage as a range condition on `changed_at_epoch_ms`.** Points
   without this field fail the condition and are excluded. “Changed since X” cannot be answered
   without a change date, and silently accepting such points would give a false answer.

9. **Scope is a REQUIRED PARAMETER, not a filter.** `buildPayloadFilter` requires a `SearchScopeV1`
   (workspace, target repositories) and ALWAYS pushes `workspace_id` into the storage filter; the
   target repositories are intersected with the request filter. If the request is entirely outside
   the target, storage is not queried: an empty `in` list would not be a filter at all. The engine
   also checks scope again on each hit. A store that ignores the filter then creates ledger entries
   rather than out-of-scope hits. The same rule applies to grep mode.

10. **Path globs and Findability are post-filters.** The payload filter supports only exact values
    and ranges. Any post-filtering is disclosed as a `caveat` on the result group; every rejected
    candidate appears in the Skip Ledger. The same holds for grep mode, where rejections beyond
    `GREP_GLOB_LEDGER_DETAIL_LIMIT` become an aggregate entry with the complete count.

11. **The dedupe key includes the ref.** The same code in two branches or worktrees represents two
    answers (vision §1a). A request returning hits from several refs of one repository additionally
    receives `MULTIPLE_REFS`.

12. **Diversification without content vectors.** `hybridQuery` returns payloads, not vectors;
    content MMR would require a second storage round trip. Instead, a saturating penalty
    `1 - 1/(1+n)` applies across file and repository, the dimension named first in arch §18.5.

13. **grep searches the index, not the disk.** Accordingly, `GrepResultSetV1` carries `scannedChunks`
    and the Skip Ledger: “no hits” and “nothing searched” must not look alike.

14. **The port lives in this package, not `domain`.** `SearchPort` composes two existing domain
    ports and the grep/format extensions; the domain does not need it yet. Its contract suite
    therefore lives here under `src/testing/` and is not included in the build.

15. **A pattern without `/` is also checked against the basename**, so `*.ts` behaves as expected
    without requiring `**/*.ts`.

16. **Absence is a profile- and corpus-bound conjunction, not a universal cosine value.** A policy
    is found by `embeddingProfileId` and applies only when its `workspaceId` and physical
    `collection` also match the search target. An empty policy map preserves the previous unfiltered
    behavior without an additional warning. If a nonempty map lacks the profile key of an active
    target, its hits stay unchanged, but `RELEVANCE_POLICY_NOT_EVALUATED` names
    `policy_profile_mismatch`, the actual profile, and all configured keys. The supplied
    `QWEN3_EMBEDDING_06B_RELEVANCE_POLICY` is calibrated exclusively against the existing Untangle
    self-index. It accepts an exact symbol name directly; otherwise **all three** signals must
    support the match: dense top value ≥ 0.45, gap between rank 1 and the actually observed rank 50
    ≥ 0.061, and IDF-weighted coverage of all normalized query terms within a single candidate
    ≥ 0.291. The calibrated evidence pool is the fixed union of the first 50 raw hits from each of
    the dense and sparse retrieval branches. Residually invalid candidates are removed but never
    replaced by deeper ranks. Symbol scrolling does not change IDF, and a higher `candidateLimit`
    only enlarges the ranking pool. Thus the absence decision stays identical at 50, 80, 100, 150,
    and 200 candidates. Both newly calibrated thresholds lie between measured counterexamples:
    the gap between the reconciliation truth (0.06686) and clearly absent blockchain configuration
    (0.05556); coverage between the configuration-array truth (0.29827) and clearly absent blockchain
    transaction question (0.28482). The conjunction matters: the latter negative question itself
    has a 0.06908 gap but fails coverage. In the measurement, this rule retained 22/22 main truths
    plus seven separate German-prose truths and rejected 11/14 adversarial negative questions.
    `NO_SUFFICIENT_MATCH` contains every measurement and threshold; each rejected hit appears in
    the Skip Ledger. If fewer than 50 dense ranks were observed, the sparse retrieval branch is
    missing, or the corpus binding mismatches, **no** absence decision is made:
    `RELEVANCE_POLICY_NOT_EVALUATED` visibly names actual and expected values and leaves hits
    unchanged. A search target whose declared `embeddingProfileId` differs from its embedder's
    actual profile ID is rejected during wiring. Significant revisions of the same corpus require
    new measurement and calibration.

17. **German natural-language questions retain only a densely corroborated local BM25 rank.**
    Diagnostics from `benchmark/diagnose.mjs` show the measured conflict: for d3/d4/d6 the gold hit
    ranks 3/10/3 in dense results, but is unranked or ranks 71/70 in local BM25. In hybrid mode, the
    lexical branch therefore contributes exactly when its top candidate also appears in the dense
    top 10. This retains the useful BM25 signal for d1 and the counterprobe asking where the
    measured baseline is documented, while excluding the conflicting d3/d4/d6 branches. Sparse
    **retrieval** always stays active; only an unconfirmed rank is excluded from fusion. An explicit
    `mode: "lexical"` is unchanged. Narrow question detection also covers German phrasings meaning
    “In which file”, “What is/happens”, “When”, “Who”, and “What for”; BM25 removes a small documented
    set of German and English question function words.

18. **An exact-character symbol query expresses precision intent within the RRF base.** In this
    case, the symbol branch contains only exact-character matches and receives enough computed
    weight to stay ahead of non-exact candidates even between the two permitted boost-clamp
    extremes. `exact_symbol_boost` and `MAX_BOOST_SHARE` are neither bypassed nor increased. This
    intent applies in `hybrid` and `symbol`. Residual filters run first, so an excluded exact
    candidate affects neither intent, weight, nor pool IDF, and each exclusion receives exactly one
    ledger entry. Equivalent definitions are ordered by visible provenance (repository, ref, path,
    line), and only finally by opaque point ID. Effective branch weights appear in score evidence.

<a id="testbarkeit-ohne-qdrant"></a>

## Testability without Qdrant

`src/testing/in-memory-index.ts` builds a complete `InMemoryVectorStore` (testkit) from simple fixture
rows, embeds it with the deterministic embedder, and returns a fully wired `HybridSearchEngine`.
`src/testing/search-port.contract.ts` contains the port contract suite (`runSearchPortContract`);
`search-port.contract.self-test.test.ts` runs it against the in-memory reference.

**No test in this package touches 127.0.0.1:6333.** An unrelated Qdrant instance runs there and must
remain untouched under spec.md §3.2.

<a id="bekannte-grenzen"></a>

## Known limits

Named rather than hidden, following the same rule as the Skip Ledger:

- **BM25 IDF applies to the candidate pool**, not the entire corpus. That suffices for ordering
  *within* the pool, and fusion uses only ordering; absolute `lexicalScore` values are not comparable
  between queries with different pools.
- **An absence statement requires a calibrated profile and corpus policy.** Without a matching
  `relevancePolicies` entry, hits are deliberately not suppressed automatically. This prevents raw
  values specific to Qwen and Untangle from being applied to another embedder or project. The three
  compositional negative diagnoses still accepted are also named: vector search demonstrates
  thematic similarity but does not reliably establish the absence of an asserted relationship
  between two genuinely present sub-concepts.
- **Without `SparseVectorizer`, sparse retrieval is missing.** A hit that only BM25 would have found
  never enters the hybrid pool. Warning: `SPARSE_RECALL_UNAVAILABLE`; pure lexical search reports an
  error. In this state, a configured absence policy explicitly is **not** evaluated for non-symbol
  questions (`RELEVANCE_POLICY_NOT_EVALUATED`), because its calibrated evidence pool is incomplete.
- **Context lines in grep mode stop at chunk boundaries.** Neighboring lines reside in another
  point and would have to be loaded separately.
- **No regex timeout; patterns are checked in advance instead.** A time limit would not help:
  evaluating a regex is ONE synchronous call; while it runs, no timer fires and no `AbortSignal` is
  checked. Measurement: a chunk containing a 31-character line and pattern `(a+)+$` blocked `grep()`
  for more than 88 seconds despite `maxScannedChunks` being 1 and cancellation after 200 ms.
  `assertSafeGrepPattern` (in `regex-safety.ts`) therefore rejects dangerous patterns BEFORE the
  first storage access, deterministically, without a clock or thread. It checks **ambiguity under
  an unbounded repetition**, no longer star height: `R+` is dangerous if `R` can match empty
  (`(a*)*`), two alternatives within `R` can match the same word (`(a|a)+`, `(\s|\t)+`), or `R` can
  consume unbounded characters at its boundary that could also begin or end `R` (`(a+)+`,
  `(\w+\s?)+`, `(\w+a)+`). The criterion is more precise in both directions than the old star-height
  check: `(\s|\t)+$`, a search for trailing whitespace, previously ran indefinitely and is now
  rejected, while `(a+b)+` and `(\w+\.)+` were previously rejected and now run (the final separator
  makes decomposition unambiguous).
  **Limit:** this remains a decidable approximation of an undecidable problem, deliberately biased
  toward rejection. Backreferences under repetition, `\p{…}` treated as “any character”, and
  alternatives of different fixed lengths sharing a prefix (`(a|ab)+`) are rejected even when
  harmless in a particular case. Only the EXPONENTIAL family is covered; an accepted pattern may
  still be polynomially expensive (`\w+\d+`). Full protection would need a dedicated matcher
  without backtracking or evaluation in a killable process. Neither is built, deliberately.
  Cancellation is now also checked per chunk (previously only per scroll page).
- **`includeContext` and `includeLinked` are accepted but NOT executed** (step 11 of the spec §13.2
  pipeline is missing). Results now disclose this through `GRAPH_CONTEXT_UNAVAILABLE` and
  `LINKED_ARTIFACTS_UNAVAILABLE`. `timings` remains undefined: measuring each phase would sacrifice
  byte-for-byte result repeatability, which takes priority here.
- **Missing payload fields are substituted and NAMED.** `readCodeChunkPayload` returns
  `substitutedFields`, hits carry them as `incompletePayloadFields`, and results warn once with
  `INCOMPLETE_PAYLOAD`. A stored range ending before its start is rejected rather than adjusted.
- **`candidateLimit` is capped at `searchConfig.maxCandidateLimit`** (warning
  `CANDIDATE_LIMIT_CLAMPED`); the returned `query` shows the value actually used.
- **No MMR based on content similarity** (see decision 12).
- **`graph_proximity_boost` and the Findability filter need injected lookups.** Without them, the
  component is omitted or the filter unapplied. The latter produces
  `FINDABILITY_FILTER_UNAVAILABLE`, never silent omission.
- **`measureFindability` cannot determine hops without a symbol graph.** In that case, `hops.hops`
  is `null` **with** `hopsMissingReason`: the missing value is visible, not omitted.
- **`measureFindability` returns TWO possible outcomes** (`FindabilityOutcomeV1`, vision §1d): a
  `FindabilityV1` measurement if search ran; otherwise a `FindabilityUnavailableV1` status record.
  The record carries neither score nor diagnosis: a failed search is a finding about us, not the
  code. Failure is also detected when the engine exposes it only as a warning rather than throwing,
  per spec §25.2 (`detectRetrievalFailure`); `findabilitySkipEntry` puts the record in the Skip Ledger
  (E4).
- **`diagnose` no longer accepts loose probes**, only a `FindabilityDiagnosisBasisV1` from
  `openFindabilityDiagnosisBasis`, which does not exist for a failed probe.
- **Rank normalization across profile groups is not implemented** (arch §18.3 describes it as
  opt-in). `rankNormalized` is always `false`; groups remain separate.

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
