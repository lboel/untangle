<a id="suchvergleich-gegen-ein-referenzwerkzeug"></a>

# Search comparison against a reference tool

As of 2026-09-05. Untangle was compared with an established tool for local code
indexing, semantic search and dependency graphs, also licensed AGPL-3.0-only.
The tool is unnamed here under decision E2.

**Interpretation:** sections through “One question was incorrectly labeled”
record the historical 2026-09-05 comparison; their values are not retrospectively
reinterpreted. The subsequent Wave-7b run uses a reconstructed, fully versioned
catalog, so its absolute values are comparable only within that before/after
pair. Multilingual questions and identifiers below are original measured inputs.

<a id="lokale-suchzuverlässigkeit--abnahme-vom-2026-10-10"></a>

## Local search reliability: acceptance on 2026-10-10

`pnpm e2e:search` checks the built CLI against real Qdrant 1.12.1 and Ollama
`qwen3-embedding:0.6b`, with 1024 dimensions. It uses a temporary Git repository
and owned collections only, preserving existing services. All 58 checks,
including cleanup, passed, most recently under Node 22.23.3. This is targeted
reliability acceptance, not a new overall recall benchmark over the historical
question catalog below.

| Search case | Observation |
|---|---|
| `getUserById`, `user id` | Symbol/lexical: expected function at rank 1 |
| `calculate_order_total`, `order total` | Full identifier and constituent terms: rank 1 |
| `HTTPServer`, `http server`, `größenÄnderung`, `größen änderung` | Acronyms/Unicode: rank 1 |
| “Wo wird ein Benutzer anhand seiner Kennung gefunden?” | Real semantic search: target at rank 1 |
| `exponential retry backoff` | Expected Markdown section at rank 1 |
| Ollama unreachable | Lexical/symbol succeed; hybrid retains results and reports partial failure/exit 4 |
| MCP during Ollama failure | Lexical/symbol succeed at rank 1; hybrid remains an error with verified rank-1 hits under `error.details.data` |
| Ollama accepts TCP without responding | Hybrid returns the target after roughly 10.2 s with an explicit timeout warning |
| Content changed, size and mtime preserved | `stale`; `--require-fresh` refuses; `--refresh` returns the new symbol name |
| File added/deleted | `stale`; refresh finds new targets and removes old ones |
| Running `watch --index` | `fresh → stale → refresh_started → refreshed/fresh`; new function is then discoverable |
| Configured repository without an index | Workspace `unknown`, explicit missing-snapshot evidence; freshness gate refuses |
| Explicit repository/branch selection | Single repository stays fresh; refreshing both repositories and the branch works despite another configuration default |
| Old tokenizer version / lost registry with existing checkpoints | New generation and full rewrite, followed by `fresh` and rank 1 |
| Orphan search points with no/old generation | Verified as hits before indexing; a completed run removes both, while foreign workspaces/repositories/refs retain unchanged payloads and vectors |

Confirmed hits provide positive labels for individual cases. The run proves
neither every other candidate's relevance nor analyzer parity with Sentrux/Sonar.
Stale snapshots and degraded retrieval are incomplete product-complexity
evidence. Because services are real, this remains opt-in; CI also checks
controlled failure, freshness, tokenization and journey contracts.

The new implementation was additionally checked with `untangle complexity` on
actual ASTs. Responsibility-based decomposition reduced freshness orchestration
from Cognitive 129 to 1 and `refreshWorkspaceIndex` from 29 to 8. The largest
freshness helper is 22. Existing 28 freshness/refresh tests remained green.
These measurements describe individual code functions; the search run checks
the corresponding findability and operational cases. After extracting independent
retrieval paths, `searchTarget` is Cognitive 152 rather than its initial 166;
new retrieval/policy helpers are at most 8, with separate deadline control at 11.

<a id="aufbau"></a>

## Setup

Both systems ran under the same conditions:

| | |
|---|---|
| Corpus | This unchanged repository, with each system's default ignore rules |
| Embedding model | `qwen3-embedding:0.6b`, 1024 dimensions, same Ollama service |
| Vector store | Separate Qdrant instances; the reference tool requires ≥ 1.17 for server-side BM25 inference |
| Questions | 23: 21 with verified ground truth and 2 intentionally unanswered |
| Result window | Top 10 |

Each system produced:

| | Untangle | Reference tool |
|---|---|---|
| Files | 943 | 889 |
| Chunks | **7,983** | 4,368 |
| File graph | 943 nodes, 3,228 edges | 739 files, 1,882 edges |
| Symbol graph | 7,542 nodes, **32,093 edges** | 739 + 232 entries |

<a id="ergebnis"></a>

## Results

| | MRR | Rank 1 | Recall@5 | Mean response time |
|---|---|---|---|---|
| **Untangle** | **0.524** | **9/21** | **14/21** | 1,233 ms |
| Reference tool | 0.311 | 4/21 | 10/21 | **338 ms** |

Untangle ranks better, with **+69% MRR** and more than twice as many rank-1
results, while running **3.6× slower**. Both belong in the comparison.

<a id="nach-kategorie"></a>

### By category

| Category | Questions | Untangle MRR | Untangle Recall@5 | Reference MRR | Reference Recall@5 |
|---|---|---|---|---|---|
| Symbol name | 5 | 0.700 | 5/5 | 0.458 | 3/5 |
| German | 7 | 0.381 | 3/7 | 0.486 | 5/7 |
| English | 4 | 0.625 | 3/4 | 0.208 | 2/4 |
| Concept | 2 | 0.000 | 0/2 | 0.000 | 0/2 |
| Prose | 3 | 0.778 | 3/3 | 0.000 | 0/3 |

<a id="einzelne-fragen"></a>

### Individual questions

Question prefixes are preserved exactly as recorded, including truncation.

| ID | Kind | Question | Untangle | Reference |
|---|---|---|---|---|
| `s1` | Symbol name | assertHonestUnderDamage | #1 | #6 |
| `s2` | Symbol name | validateCoverage | #4 | #8 |
| `s3` | Symbol name | buildSymbolEdgeId | #1 | #2 |
| `s4` | Symbol name | normalizeSearchQuery | #1 | #2 |
| `s5` | Symbol name | compareCodepoints | #4 | #1 |
| `d1` | German | Wo wird die Puffergrenze von tree-sitter behandelt, damit  | #2 | #1 |
| `d2` | German | Wie wird verhindert, dass zwei gleichzeitige Schreiber sic | — | — |
| `d3` | German | Wo wird die kognitive Komplexitaet berechnet? | — | — |
| `d4` | German | Wie werden Markdown-Dokumente in Abschnitte zerlegt? | — | #5 |
| `d5` | German | Wo steht, dass ein externer Befund niemals als eigene Metr | #6 | #1 |
| `d6` | German | Wie erkennt das Werkzeug die Dienste aus einer docker-comp | #1 | #5 |
| `d7` | German | Wo wird entschieden, welcher Vektorspeicher benutzt werden | #1 | #1 |
| `e1` | English | how are chunk boundaries kept lossless so nothing is silen | — | — |
| `e2` | English | reciprocal rank fusion of dense and lexical results | #1 | #3 |
| `e3` | English | batching and caching of embedding requests | #2 | — |
| `e4` | English | detect entry points like main or framework routes | #1 | #2 |
| `k1` | Concept | Was passiert, wenn eine Datei nicht geparst werden kann? | — | — |
| `k2` | Concept | Wie wird ein Index ueber mehrere Branches oder Worktrees g | — | — |
| `p1` | Prose | Was ist die Kernthese des Projekts zur Komplexitaet? | #1 | — |
| `p2` | Prose | Warum ist schlechte Auffindbarkeit selbst ein Qualitaetspr | #1 | — |
| `p3` | Prose | Welche Entscheidungen sind unveraenderlich und duerfen nic | #3 | — |
| `n1` | Unanswered | Wo wird die Blockchain-Signatur der Transaktionen geprueft | — | — |
| `n2` | Unanswered | kubernetes horizontal pod autoscaler configuration | — | — |

<a id="was-die-zahlen-sagen"></a>

## What the measurements show

**Prose is the clearest advantage: 3 of 3 against 0 of 3.** The reference tool
found none of the three documentation answers. Treating prose as first-class
content, required by `vision.md` §1c, provided a measured advantage over code-only
indexing.

**German questions perform worse: 3 hits against 5.** This was the language used
to develop and document the project at that revision. The cause needs analysis:
with the same embeddings and model, differences arise from chunking, fusion or
weighting rather than the language model.

**Two exact symbol names rank only fourth:** `validateCoverage` and
`compareCodepoints`. Exact names should rank first; `exact_symbol_boost` of 0.15
is too weak.

**Both systems fail concept questions, 0 of 2.** Explaining what happens when a
file cannot be parsed requires information spread across files, where search
alone is insufficient and graph context is needed.

<a id="der-wichtigste-befund-betrifft-uns-selbst"></a>

## The most important finding concerns Untangle itself

Both systems fail the absence check. On the blockchain-signature question,
which has no counterpart in the repository, Untangle returns **10 hits** and
the reference tool 9. Neither reports absence.

If poor findability is a quality signal under §1d, absent content must be
distinguishable from difficult-to-find content. Returning ten hits to every
question cannot establish this distinction and can send an agent into unrelated
files looking for nonexistent functionality.

This is an E4 violation through an unsupported relevance claim rather than
hidden content.

<a id="eine-frage-war-schlecht-gestellt"></a>

### One question was incorrectly labeled

`n2`, “kubernetes horizontal pod autoscaler configuration”, was intended to be
unanswerable, but the repository contains
`packages/context-artifacts/src/adapters/kubernetes.ts`. Both systems correctly
found it. Only `n1` was a genuine negative case. This labeling error belongs to
the benchmark author, not the systems, and is retained so results are not
presented more favorably than warranted.

<a id="welle-7b--nachlauf-mit-rekonstruiertem-katalog"></a>

## Wave 7b: rerun with a reconstructed catalog

The original generator and full question texts were not committed; the table
above contains truncated prefixes. `packages/search/benchmark/questions.mjs`
reconstructs the 23 visible entries, correctly treats `n2` as answerable and
measures **22 answerable main questions**. Ground truth was checked again against
the repository. This is a new internally comparable Wave-7b baseline, not a
retrospective recalculation of historical MRR 0.524.

The run used the existing self-index with **7,983 points**,
`qwen3-embedding:0.6b` and `candidateLimit=50`. Its stored index generation is
`unknown`. The index may contain earlier self-references from this document and
the benchmark catalog; every known self-reference is reported, and future
dogfood indexes exclude both paths.

| Reconstructed main catalog | Before Wave 7b | After Wave 7b |
|---|---:|---:|
| MRR | 0.601190 | **0.693939** |
| Rank 1 | 11/22 | **13/22** |
| Recall@5 | 16/22 | **18/22** |
| German: MRR | 0.377551 | **0.466667** |
| German: rank 1 | 2/7 | 2/7 |
| German: Recall@5 | 3/7 | **5/7** |
| Symbol names: MRR | 0.850000 | **1.000000** |
| Symbol names: rank 1 | 4/5 | **5/5** |
| Symbol names: Recall@5 | 5/5 | 5/5 |

This closed the three concrete retrieval findings: the production policy
retained **22/22** main truths, all five exact symbol names ranked first, and
German ranking improved without losing a main truth. Separate case
`g-corroborated`, “Wo ist die Gemessene Ausgangslage dokumentiert?”, and six German
holdouts unused in initial calibration were accepted by the same policy and
ranked first.

<a id="abwesenheit-ist-eine-gebundene-dreifache-evidenzprüfung"></a>

### Absence requires three jointly satisfied evidence conditions

An exact symbol name is direct evidence. Every other query must satisfy all
three conditions:

| Signal | Policy | Narrow measured boundary |
|---|---:|---|
| Dense top score | ≥ 0.45 | Absolute floor |
| Dense spread, rank 1 to rank 50 | ≥ 0.061 | Weakest truth 0.06694, margin ≈ 0.00594; strongest clear negative below threshold 0.05555, gap ≈ 0.00545 |
| IDF-weighted term coverage in one candidate | ≥ 0.291 | Weakest truth 0.29827, margin ≈ 0.00727; strongest clear negative below threshold 0.28482, gap ≈ 0.00618 |

The conjunction matters; no single signal decides alone. IDF evidence comes
from the fixed deduplicated union of the first **50 dense and 50 sparse**
retrieval candidates. A larger ranking window does not alter that evidence.
Live reruns with `candidateLimit` 50, 80, 100, 150 and 200 each retained 22/22
truths and rejected 7/7 clear negatives. Ranking MRR stayed 0.693939 at 50 and 80,
and was 0.686364 from 100 through 200; rank 1 (13/22) and Recall@5 (18/22) stayed
unchanged. This is a ranking difference, not drift in the yes/no verdict.

All seven clear negatives form a hard gate and returned `NO_SUFFICIENT_MATCH`
with zero hits. Three additional compositional diagnostics deliberately do not
form a pass/fail gate: their terms exist individually, but not in the asserted
relationship. One caused abstention; two returned existing partial concepts.
Vector search alone cannot reliably decide this entailment. The limitation
remains visible rather than counting seven additional successes.

<a id="geltungsgrenze-und-fehlerverhalten"></a>

### Calibration scope and failure behavior

Calibration applies only to the measured combination of embedding model/profile,
workspace, physical collection and corpus revision. The engine checks profile
key, workspace and collection; the target's declared profile ID must exactly
match the actual `embedder.profileId`, otherwise construction fails immediately.
Without sparse retrieval or a matching policy binding, non-exact queries report
`RELEVANCE_POLICY_NOT_EVALUATED` and retain results rather than asserting
uncalibrated absence. The existing 7,983-point index's corpus revision is
`unknown` and is not yet runtime-bound; material corpus changes therefore
require new measurements and calibration. Retrieval failure inside the benchmark
aborts before writing a result artifact.

<a id="status-der-arbeitspakete-aus-diesem-vergleich"></a>

## Work packages from this comparison

| ID | Finding | Status |
|---|---|---|
| WP-231 | Profile/corpus-bound absence verdict with measurable evidence, `NO_SUFFICIENT_MATCH`, honest non-decision and benchmark negative gate | **Closed in Wave 7b** |
| WP-232 | German-corroborated hybrid ranking; reconstructed German Recall@5 3/7 → 5/7, plus `g-corroborated` and six holdouts | **Closed in Wave 7b** |
| WP-233 | Exact symbol names as a precision intent within the RRF base; 5/5 at rank 1 | **Closed in Wave 7b** |
| WP-234 | Cross-file concept questions still need search combined with graph context | **Open** |
| WP-235 | Runtime of 1,233 ms against historical 338 ms is not yet broken down by stage | **Open** |

<a id="welle-13--prosa-chunking-repariert-policy-fragilitaet-belegt-2026-09-08"></a>

## Wave 13: prose chunking fixed, fragile calibration exposed (2026-09-08)

The existing harness diagnosed two separate causes against the standing
self-index. Only the first was fixed in this wave.

<a id="befund-1--vier-kerndokumente-lagen-strukturlos-im-index-behoben"></a>

### Finding 1: four core documents lacked structure in the index (fixed)

Minification was decided in two places with different thresholds: the scanner
used a 500-character single-line rule on an 8-KB sample; the chunker used 1000
characters on the full content. Behavior depended on indexing versus watching.

More seriously, a single long line is normal in Markdown tables and should not
classify prose as minified. `README.md`, `docs/BUILD_PLAN.md`, `docs/PARITY.md` and
`packages/domain/README.md` consequently became 79 unstructured byte windows.
Sampling also mattered: the first long line had to fall inside the first 8 KB.
`PARITY.md` did so with a 314-byte margin; structurally similar `product.md` did
not.

Both paths now use `packages/domain/src/prose/minified-rule.ts`. The single-line
rule no longer applies to `prose`; the average-line rule remains active.

| Catalog | Before fix | After fix |
|---|---:|---:|
| `p3`, “Welche Entscheidungen sind unveraenderlich?” | **Abstains** | **Rank 1** |
| Prose: MRR | 0.667 | **0.833** |
| Prose: Recall@5 | 2/3 | **3/3** |
| Overall: MRR | 0.628 | **0.658** |
| Overall: Recall@5 | 16/22 | **17/22** |
| Overall: rank 1 | 12/22 | 12/22 |
| Clear negatives | 7/7 abstain | **7/7 abstain** |
| `minified_fragment` under `.md` | 79 | **0** |

`docs/BUILD_PLAN.md` changed from 47 unstructured windows to 124 heading-bound
chunks.

<a id="befund-2--die-kalibrierung-ist-nicht-robust-sondern-angepasst-offen"></a>

### Finding 2: calibration is fitted rather than robust (open)

`minimumDenseSpread: 0.061` requires a minimum spread between dense rank 1 and
rank 50. Before this wave, one of all 29 answerable questions was below it, and
another was at **0.0610**, a margin of 0.00003.

An ordinary reindex consumed that margin:

| Question | Before | After | |
|---|---:|---:|---|
| `g-corroborated` | 0.0523 | 0.0501 | Rejected before and after |
| `g-policy-reconciliation` | 0.0610 | **0.0609** | **Newly rejected** |

`g-corroborated` ranks first in both branches, with dense 0.5205 and BM25 10.808,
yet is rejected. The absence policy, rather than ranking, causes the failure.

Acceptance therefore still fails, for a different reason than before the fix.
Adjusting the threshold again would fit another snapshot. The open question is
whether a relative reference, such as rank 1 versus median rather than fixed
rank 50, stays stable across corpus sizes. Evaluation uses the same 22/22 truths
and 7/7 negatives.
