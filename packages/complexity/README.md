# @untangle-code/complexity

Untangle's complexity engine (spec.md §16, architecture.md §6.7, §15): pure deterministic
calculators over domain `ComplexityFacts`/`ComplexityIRNode`. No I/O, parser-registry, embeddings,
`Date.now()` or `Math.random()`. Every calculator is a pure function of facts/IR and algorithm/
metric versions, returning snapshots and explainable contributions.

Normative sources: [`spec.md`](../../spec.md) §16 (takes precedence),
[`architecture.md`](../../architecture.md) §6.7, §15.

<a id="modulübersicht"></a>

## Modules

| Module | Contents | Normative source |
|---|---|---|
| `scope.ts` | `selectSymbolFacts()` narrows file facts to a symbol; `containsRange`/`strictlyContainsRange`, `rangeKey`, `sliceByRange`, `splitLines` | arch §15.1 |
| `cyclomatic.ts` | `computeCyclomatic()`: classic/extended, independent `logicalGroupId` groups counted once | spec §16.2–§16.3 |
| `cognitive.ts` | `computeCognitive()`: explicit-depth-stack IR traversal, `untangle-cognitive-v1`; `assertCognitiveInvariant()` | spec §16.4; arch §15.3 |
| `ir/build-ir.ts` | `buildSymbolIR()`: facts→IR, flat else-if siblings, logical-condition hoisting, lambda nesting, optional recursion marking from `RawCall` | arch §6.7; spec §16.4 |
| `structural.ts` | `computeStructural()`: all §16.5 metrics; coupling/API metrics only with explicit `StructuralExternalInput` | spec §16.5 |
| `textual.ts` | `computeTextual()`: all §16.6 metrics including `identifier_entropy`, `magic_literal_count`, TODO/FIXME/HACK | spec §16.6 |
| `syntactic.ts` | `computeSyntactic()`: all §16.8 metrics; exact branching factors from `nodeKinds` preorder depths, IR root only as fallback | spec §16.8 |
| `halstead.ts` | `computeHalstead()`: exact formulas including `max(n,1)`/`max(n2,1)` guards; time/bugs labeled estimates | spec §16.7 |
| `maintainability.ts` | `computeMaintainability()`: exact default formula, clamped [0,100], formula returned as text | spec §16.9 |
| `aggregator.ts` | `aggregate()`: count/sum/mean/median/max/p90/p95/SLOC-weighted mean/thresholds, deduplication by `metricsScopeId` | spec §16.10 |
| `scope-aggregate.ts` | `aggregateScopeTree()`, `checkScopeTreeInvariants()`, `checkScopeCoverage()`/`checkSelectionCoverage()`, `assertScopeTreeInvariants()`, `selectScopeEntries()`: scope-TREE aggregation **without double counting**, three readings, value-bound/count checks (WP-82) | spec §16.10 |
| `scope-identity.ts` | `withUniqueScopeIds()`: converts per-file **nonunique** adapter `symbolScopeId` values to byte-range IDs and reports every collision (WP-82) | spec §16.10; E4 |
| `explain.ts` | `explainSymbol()`: ordered human-readable explanations of largest contributions | Task |
| `assemble.ts` | `assembleComplexitySnapshot()`: folds calculator results into domain `ComplexitySnapshotV1` | spec §16; arch §10.5 |
| `entropy.ts` | Shared `shannonEntropy()`, `frequenciesOf()` | spec §16.6, §16.8 |
| `node-kind-heuristics.ts` | Best-effort `classifyNodeKind()`, `isAsyncNodeKind()`, `isExceptionNodeKind()` for raw kind strings | Decision 5 |
| `text-lines.ts` | Shared `classifyLines()`, `scopeLines()` for structural/textual metrics | Decision 3 |
| `types.ts` | Local calculator result types (`CyclomaticResult`, `CognitiveResult`, `MetricsResult`, `AggregationResult`, `ExplainEntry`, …), **not** domain types | Decision 2 |

Public symbols are re-exported only through `src/index.ts`.

<a id="architekturentscheidung-scope-filterung-liegt-beim-aufrufer"></a>

## Architecture decision: callers own scope filtering

No calculator knows `symbolScopeId`. `selectSymbolFacts(facts, symbolScopeId)` narrows file-wide
`ComplexityFacts` to one symbol; for `scope: "file"`, callers pass unfiltered facts. Every
calculator stays easily testable and scope-agnostic; the same code calculates symbol/file metrics.

<a id="entscheidungen"></a>

## Decisions

Reasoned choices left open by spec.md/architecture.md (task rule 9); downstream consumers should
extend additively rather than redefine contracts locally.

1. **Fact attribution is flat, not recursive.** `SymbolScopeFact.symbolScopeId` denotes exact
   membership: facts belong to that symbol, not its nested named children, which receive their
   own `SymbolScopeFact` and metrics. File aggregation instead sums across every file scope.

2. **IR branching chains use flat siblings.** Architecture.md §15.3 does not fix their shape.
   Every IR producer maps `if`/`else if`/`else` to sibling nodes under one parent, **not** raw AST
   nested `alternate` structure. Else-if then receives **no** extra nesting penalty relative to
   its if because both share ambient depth, satisfying spec.md §16.4 without special cases.
   `ir/build-ir.ts` now implements this itself: `buildSymbolIR()` derives flat siblings from fact
   byte ranges, reparenting continuation events to their enclosing if's final parent. Language
   adapters therefore need not know IR shape.

   Since the §16.4 correction, `ComplexitySnapshotV1.cognitive.contributors` uses full
   `CognitiveContributionV1[]`: every persisted contribution requires structured position, kind,
   base AND nesting. Former conversion to `MetricContribution` with free-form `note`
   `base`/`nestingPenalty` violated this and was removed. Snapshots also carry
   `maintainabilityFormula` because §16.9 requires the actual formula explicitly.

3. **Documentation-comment heuristic.** Facts do not distinguish ordinary/documentation
   comments. After byte-range slicing, `text-lines.ts` treats prefixes `/**`, `///`, `"""`, `'''`,
   `##!`, `//!` as documentation.

4. **`instability` uses explicit values only.** Supplied values pass through unchanged. Otherwise
   it is calculated only with BOTH `afferentCoupling` and `efferentCoupling` as
   `efferent / (afferent + efferent)`, Martin's instability metric. It is never guessed from one
   value or defaulted.

5. **Node-kind-dependent counts are best effort:** `parameter_count`/`return_count`/
   `exit_point_count`/`statement_count`/`expression_count`/`declaration_count`/
   `async_construct_count`/`exception_construct_count`. `NodeKindFact.kind` is an opaque adapter
   string, not a domain-normalized taxonomy. `node-kind-heuristics.ts` matches common grammar
   conventions (`"return_statement"`, `"required_parameter"`, `"throw_statement"`,
   `"async_function"`, …), a documented versionable heuristic and **candidate for additive domain
   extension** (see `openIssues`).

6. **`identifier_entropy` is character entropy, not token entropy.** Shannon entropy uses
   concatenated characters from all identifier occurrences, not frequencies of distinct names.
   It responds to naming style, such as abbreviations versus descriptive camelCase, rather than
   being dominated by repeated short frequent names (`i`, `x`).

7. **`ast_branching_factor_avg`/`_max` reconstruct exactly from preorder `nodeKinds` depths.**
   Adapters emit DFS preorder (the input contract in `syntactic.ts`). Each node's parent is the
   nearest preceding entry with smaller depth, determining child counts and branching exactly
   without pointers or guesses. This is real AST branching, not sparse control-flow IR branching;
   optional IR roots are fallback only for empty `nodeKinds`, such as handwritten IR fixtures.

8. **Percentiles use linear interpolation**, following NumPy `linear`/Excel `PERCENTILE.INC`:
   `index = p * (n - 1)`, interpolating `sorted[floor(index)]` and `sorted[ceil(index)]`. Median
   uses the same formula at `p = 0.5`, without a separate even/odd branch.

9. **`magic_literal_count` exclusions:** numbers `{0, 1, -1}`, strings `{"", ''}` using trimmed
   raw text. Only `number`/`string` literals can be magic, never
   `boolean`/`null`/`regex`/`template`/`other`.

10. **`comment_lines` counts every touched line fully**, including `code(); // comment` lines.
    `SourceRange` supplies byte rather than column boundaries; reliably separating code/comment
    line portions would require extra raw-text heuristics.

11. **Calculators return `{ metrics: Record<string, number>; algorithmVersion: string }`**, except
    cyclomatic/cognitive, which have dedicated domain-compatible results. This provides a shared
    API across all seven calculators, even where `ComplexitySnapshotV1` has no per-family version slot.

<a id="öffentliche-api-auszug-siehe-srcindexts"></a>

## Public API (excerpt; see `src/index.ts`)

```ts
buildSymbolIR(facts: ComplexityFacts, symbolScopeId: string, options?: BuildSymbolIROptions): ComplexityIRNode | undefined
computeCyclomatic(facts: ComplexityFacts, baseLine: number, algorithmVersion: string): CyclomaticResult
computeCognitive(symbolRoot: ComplexityIRNode, algorithm: string): CognitiveResult
computeStructural(facts, sourceText, scopeRange, external?, algorithmVersion?): MetricsResult
computeTextual(facts, sourceText, scopeRange, algorithmVersion?): MetricsResult
computeSyntactic(facts, sloc, irRoot?, algorithmVersion?): MetricsResult
computeHalstead(tokens: HalsteadTokens, options?, algorithmVersion?): HalsteadResult
computeMaintainability(input: MaintainabilityInput, algorithmVersion?): MaintainabilityResult
aggregate(entries: AggregationEntry[], thresholds?: number[]): AggregationResult
aggregateScopeTree(nodes: ScopeMetricNodeV1[], options?: ScopeTreeOptions): ScopeTreeAggregateV1
checkScopeTreeInvariants(nodes: ScopeMetricNodeV1[], options?: ScopeTreeOptions): ScopeInvariantViolationV1[]
assertScopeTreeInvariants(nodes: ScopeMetricNodeV1[], options?: ScopeTreeOptions): void
selectScopeEntries(nodes: ScopeMetricNodeV1[], reading: ScopeSumReading): AggregationEntry[]
withUniqueScopeIds(facts: ComplexityFacts, calls: readonly RawCall[], idPrefix: string): UniqueScopeIdsResultV1
explainSymbol(snapshot: ComplexitySnapshotV1, top?: number): ExplainEntry[]
assembleComplexitySnapshot(context: SnapshotContext, parts: SnapshotParts): ComplexitySnapshotV1
selectSymbolFacts(facts: ComplexityFacts, symbolScopeId: string): ComplexityFacts
```

<a id="aggregation-ohne-doppelzählung-wp-82"></a>

## Aggregation without double counting (WP-82)

`aggregate()` deduplicates `metricsScopeId`, handling duplicate input fragments, **not** nested
scopes. `buildSymbolIR()` deliberately includes every descendant in target IR (spec.md §16.4's
documented nesting context): a `file` scope carries all class, method and closure control flow.
Each has its own ID, so naive summation counts source once per enclosing scope. Measured on this
repository, the naive sum is approximately three times larger.

`scope-aggregate.ts` defines **three readings**, each counting every scope once while differing
in included nesting context:

| Reading | Counted values | Question answered |
|---|---|---|
| `top_level` | Root `inclusiveValue` | Difficulty of reading a file **as one whole**; every enclosing function contributes nesting |
| `execution_unit` (**default**) | Outermost execution-unit `inclusiveValue` plus ancestors' `selfValue` (file/class/interface) | Difficulty of each **function by itself**; nesting resets at each outermost function, keeping nested closures inside it. The only reading that withstands comparison with an established tool (X8) |
| `self` | Every scope's `selfValue` | Complexity in each scope's **own body**; lower bound, with differences exactly the nesting penalty |

There is deliberately no **leaf-only reading**: direct control flow in a parent with children
belongs to no leaf and would disappear, the silent loss E4 forbids. `leafOnlySum` still appears as
a diagnostic alongside `leafOnlyDroppedAmount`, the omitted amount. The same applies to
`naiveSum` and `doubleCountedAmount`.

**Invariant checks are mandatory.** `aggregateScopeTree()` **throws** `UntangleError` with
`ANALYSIS_INCOMPLETE` on any scope violation. Its two stages serve different purposes:

1. **Value bound** (`checkScopeTreeInvariants`):
   `selfValue(S) + Σ inclusiveValue(direct children) <= inclusiveValue(S)`, plus leaf equality,
   non-negativity, known parents and no cycles. This **one-sided** bound catches too-small parent
   values, hence **missing** content. Too-large parents—including double counting—also satisfy
   it and remain undetected. Values alone cannot distinguish inflation from a scope with much
   own control flow. This stage therefore does **not** guarantee no double counting; earlier
   documentation incorrectly claimed that.
2. **Counting check** (`checkScopeCoverage` per reading, `checkAllScopeCoverage` for all three):
   every scope contributes to **exactly one** selected summand, not two (`scope_counted_twice`)
   and not zero (`scope_uncounted`). **This** guarantees the three selection sums. It checks
   selection structure; internal double counting within a value remains the calculator's concern.
   `checkSelectionCoverage(nodes, selection, label)` runs the same check on arbitrary selections,
   making alarm cases demonstrable rather than merely asserted.

Metrics with a per-scope base, such as cyclomatic `M = 1 + decision_points`, use `perScopeBase`
normalization for checks. Their three sums reverse order because `self` counts the base per scope
and `top_level` per file.

`duplicatesDropped` is **not** merely operational: repeated `metricsScopeId` with equal values
is deduplicated without violation, as §16.10 requires for repeated retrieval fragments. In real
scope trees where each ID must denote one scope, any positive `duplicatesDropped` means lost
content. `scripts/complexity-report.mjs` aborts on it.

All this requires IDs to identify scopes uniquely. Adapter `symbolScopeId` currently does
**not**: per-parent ordinals plus qualified names collide for anonymous callbacks under anonymous
parents, affecting roughly one fifth of scopes here. `withUniqueScopeIds()` rewrites IDs to byte
ranges and **reports** every collision rather than hiding it. The adapter owns the actual fix.

Run through `scripts/complexity-report.mjs` (`pnpm complexity:report`).

## Tests

105 co-located Vitest cases under `src/**/*.test.ts`. Notable coverage:

- `golden-real-source.test.ts` exercises real TypeScript/JavaScript through real adapters, not
  handwritten facts/IR. Hand-calculated cognitive values are **17** for TS triple nesting,
  else-if, `&&`, lambda, and **13** for JS switch/case, `||`, loop, catch and direct recursion.
  Complete contribution lists, hand-calculated cyclomatic values,
  `sum(contributions.total) === total`, real-file branching factors and formula/structure
  assertions verify persisted snapshots.
- `cognitive.test.ts` has a handwritten golden case (triple nesting, else-if, logical sequence,
  lambda), total **17**, full contributions, and a corrupted-list test requiring
  `assertCognitiveInvariant` to throw. `ir/build-ir.test.ts` isolates chain flattening, condition
  hoisting, lambda context, recursion marking and switch/case modeling.
- Every calculator has a hand-calculated case: the spec §16.2 eight-point cyclomatic example
  plus extended grouping; Halstead n1/n2/N1/N2/volume/difficulty/effort; full MI formula;
  percentiles against reference set 1..10.
- `sum(contributions) === total` is explicitly tested for cyclomatic and cognitive.

```bash
pnpm --filter @untangle-code/complexity run typecheck   # tsc --noEmit, including tests
pnpm --filter @untangle-code/complexity run test         # vitest run
pnpm --filter @untangle-code/complexity run build         # tsc -p tsconfig.json -> dist/
```

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
