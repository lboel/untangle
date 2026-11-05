# @untangle-code/chunker

Lossless token-budgeted AST chunking for Untangle (work following spec.md §8, architecture.md §6.6
and §14). Internal private package, not published to npm.

Normative sources: [`spec.md`](../../spec.md) §8 (takes precedence),
[`architecture.md`](../../architecture.md) §6.6, §14, and [`vision.md`](../../vision.md) principles
8.4 ("no silent data loss") and 8.5 ("stable identity over source position").

Its only runtime dependency is `@untangle-code/domain` (`workspace:*`). Production imports neither
`parser-registry` nor other Untangle packages; it consumes only language-neutral `LanguageAdapter`
output (`ParseResult`, `AstRegion[]`, `ExtractedSymbol[]`). The seam's region contract is documented
normatively on `AstRegion` in `packages/domain/src/analysis.ts`. The sole exception is
`@untangle-code/parser-registry` as a **devDependency** for a real seam integration test
(`src/integration.test.ts`) that parses actual TypeScript through the adapter rather than using
hand-built region trees.

<a id="was-dieses-package-tut"></a>

## Responsibilities

`chunkFile()` (the main entry point in `src/index.ts`) receives file identity, raw content and
language-adapter output, returning `CodeChunkDraft[]` and a complete coverage ledger.
Three strategies follow architecture.md §6.6:

```text
AstChunkStrategy      — spec.md §8.3 steps 1–8 (normal case, successfully parsed file)
LineFallbackStrategy  — spec.md §8.3 step 9 (parse error / no usable regions)
MinifiedStrategy      — spec.md §8.3 step 10 (minified content)
```

All use the same `BuildContext`/`emitChunk` core (`src/context.ts`), producing every `CodeChunkDraft`
with identical `chunkId` derivation (`domain.buildChunkId`), prepared-text construction and token
estimation. After each strategy, the orchestrator (`src/chunker.ts`) fills remaining byte gaps
with `fallback_lines` and checks the lossless invariant again through `domain.validateCoverage`.
This is defense in depth; a correct strategy must never leave a gap.

<a id="modulübersicht"></a>

## Modules

| Module | Contents |
|---|---|
| `chunker.ts` | `chunkFile()`: strategy selection, gap filling, final coverage check |
| `config.ts` | Defaults and `resolveChunkerConfig()` |
| `context.ts` | `BuildContext`, sole `CodeChunkDraft` factory `emitChunk()`, `estimateTokensWithHeader()` |
| `byte-text.ts` | Byte-exact slicing and line indexes: `LineIndex`, `sliceBytes`, `safeUtf8Boundary` |
| `split.ts` | `flattenToAtoms()` (AST block splitting and statement grouping, steps 6–7), `splitByTokenBoundary()` (safe boundaries, step 8) |
| `token-estimator.ts` | Conservative offline `estimateTokens()` (architecture.md §14.4) |
| `minified-detection.ts` | Step-10 heuristic `detectMinifiedContent()` |
| `prepared-text.ts` | `buildPreparedDenseText()`/`buildBm25Text()` (spec.md §8.6) |
| `coverage.ts` | `chunkedEntry()`/`excludedEntry()`/`assertLosslessCoverage()`; the validator itself is `domain.validateCoverage()` |
| `strategies/ast-chunk-strategy.ts` | Classes, symbols and fragments (spec.md §8.3 steps 1–8) |
| `strategies/line-fallback-strategy.ts` | Overlapping line windows for parse failures |
| `strategies/minified-strategy.ts` | Token/byte-safe splitting without AST structure |
| `types.ts` | `ChunkerConfig`, `ChunkFileParams`, `ChunkFileResult` and related types |

`src/index.ts` is the only public export (rule 10). Internal modules (`context.ts`, `split.ts`,
`test-helpers.ts`, …) are not public API and are imported directly only by co-located tests.

<a id="nutzung"></a>

## Usage

```ts
import { chunkFile } from "@untangle-code/chunker";

const result = chunkFile({
  identity: { workspaceId, repoId, refId, fileId, filePath, languageId },
  content: sourceText,
  parseResult,          // from LanguageAdapter.parse()
  regions,               // from LanguageAdapter.extractChunks(ast)
  symbols,               // from LanguageAdapter.extractSymbols(ast)
  config: {
    preparedText: { documentPrefix, repoLabel, refName }, // Required; other settings have defaults
  },
});
// result.drafts: CodeChunkDraft[] (including preparedDenseText/bm25Text/tokenEstimate)
// result.coverage: CoverageEntry[] (Lossless evidence, spec.md §8.4)
// result.strategy: "ast" | "line_fallback" | "minified"
```

<a id="entscheidungen"></a>

## Decisions

Choices left open by spec.md/architecture.md (rule 9); downstream packages should extend additively
rather than redefine contracts locally:

1. **`AstRegion.scopeId` is ignored; the chunker calculates `symbolId`.** During
   `LanguageAdapter.extractChunks`, an adapter knows only `SourceFile` (fileId/repoId/refId), not
   `workspaceId`, and therefore cannot derive a spec-conformant `symbol_id` (spec.md §5.5 requires
   four components including `workspace_id`). The chunker receives `workspaceId` through
   `ChunkFileIdentity` and uses `domain.buildSymbolId` with the region's `ExtractedSymbol`, linked
   by `AstRegion.symbolFqn === ExtractedSymbol.qualifiedName`. Here `AstRegion.scopeId` is a
   required adapter-populated field with no local semantic meaning.

2. **Minified versus parse-error order.** spec.md §8.3 lists step 9 (parse failure) before step
   10 (minified), without defining priority when either is used as fallback only if the other is
   absent. `chunkFile()` checks minification FIRST from content, independently of parse success.
   Minified files can parse successfully yet yield unusable structure, such as one huge top-level
   statement; AST chunking would be pointless even without parser errors.

3. **`class_overview` content is synthesized (`synthesized: true`) and proves NO range coverage
   beyond the header.** To expose member names without method bodies,
   `buildClassOverviewContent()` builds documentation comment, class signature and member
   names/signatures, never bodies. Draft `range` retains the entire class for navigation;
   `content_hash` describes synthesized text. Coverage declares ONLY the header (class start to
   first member) as "chunked", because the overview actually carries that documentation/signature.
   Remaining class bytes not covered by member chunks—inter-method comments, unmodeled constructs,
   delimiters—are explicit: meaningful gaps become real class `symbol_fragment` chunks with
   `symbolId`, `fragmentIndex`/`fragmentCount` and signature headers (spec.md §8.5); pure
   delimiter/whitespace gaps are logged as "excluded" with reasons (spec.md §8.4). Synthesized
   chunks must never hide gaps: the wave-0 defect (finding 2) is now protected by
   `src/integration.test.ts`. If the member list itself exceeds the token budget, it is capped
   with "... and N more members", never silently emitted over budget. A class without member
   regions becomes a REAL byte chunk rather than synthesized content.

4. **Small properties are grouped only across consecutive `property_group` child regions.**
   Adapters mark each field/property individually with `chunkKind: "property_group"`. The chunker
   greedily merges consecutive runs under the token budget (spec.md §8.3 step 5). Properties
   interrupted by other members stay in separate groups; source is not reordered across the file.

5. **`metricsScope`/`metricsScopeId` per chunk kind**, not prescribed normatively:
   `class_overview`, `function`/`method`/`constructor`/`interface`/`type`/`enum`/`symbol_fragment`
   use `"symbol"` (the single associated symbol ID); `module`/`file_preamble`/`comment`/
   `configuration` without associated symbols use `"file"`; `property_group`/`fallback_lines`/
   `minified_fragment` use `"chunk"` because no single symbol owns the chunk.

6. **`chunk_ordinal`** uses one counter per `(scopeId, chunkKind)` pair (`nextOrdinal` in
   `context.ts`). For `symbol_fragment`, it equals `fragmentIndex` because a symbol's fragments
   are emitted consecutively in source order under one `scopeId`. This also explains stable
   `chunk_id` under line-only shifts (spec.md §5.6): `symbolId` does not change (lines are not
   identity inputs, §5.5), and fragment structure depends on symbol *content*, not absolute position.

7. **Token estimate:** 3 characters/token (rather than the more realistic code range ~3.5–4.5),
   plus small per-line overhead. Deliberate overestimation (architecture.md §14.4), documented in
   `token-estimator.ts`; no network tokenizer, entirely offline and deterministic.

8. **Minification detection** is a pure content heuristic using file size and mean/maximum line
   length, all configurable. It does not rely on conventions such as `.min.js`, which generated
   code does not always follow.

9. **`LineFallbackStrategy` overlap** uses line windows with `linesPerChunk`/`overlapLines`, default
   60/8, as explicitly requested. `MinifiedStrategy` also supports configurable `overlapBytes`,
   default 0, because the spec does not explicitly require overlap there; it adds retrieval context.

10. **Safe split boundaries** prefer a newline within a 120-byte lookback, never shrinking a
    fragment by more than half to do so, then fall back to UTF-8-safe byte boundaries—never
    continuation bytes. A dedicated multibyte-character test verifies this.

11. **`module` regions are ALWAYS unpacked**, never emitted wholesale as single-file chunks.
    Adapters provide one `module` root region (the `AstRegion` contract in domain's `analysis.ts`);
    `dispatchRegion` handles `chunkKind` at every depth. Symbol chunks (spec.md §8.3 steps 3–5)
    therefore exist even below the token budget. Module bytes between symbol regions, including
    top-level statements and free comments, become real `module` chunks; pure whitespace gaps
    are excluded with reasons. Only a `module` without children—a statement-only file—is emitted
    as a complete content chunk or split into fragments.

<a id="bekannte-grenzen--offene-punkte"></a>

## Known limits / open issues

See `openIssues` in the work unit's completion report.

<a id="e4-ehrlichkeitspruefung-wp-165"></a>

## E4 honesty check (WP-165)

`src/honesty.test.ts` runs `assertHonestUnderDamage` from testkit against the real
parser-registry → `chunkFile` seam. Six damage kinds—truncation, broken structure, removed required
fields, size beyond every limit, concurrency and abort signals—must each produce either a visible
finding or a demonstrably unchanged result.

**Found and fixed: new `ChunkFileResult.degradations`.** When an adapter returned NO regions after
`parseQuality: "complete"`, `chunkFile` silently used line fallback. Byte coverage stayed complete
(`assertLosslessCoverage` passed), and quality stayed `"complete"`, yet no chunk had a symbol
assignment. Callers inferred structural analysis that never happened: "completeness claimed,
subtree discarded". Every deviation from the AST strategy now produces a `ChunkDegradation` with
`ast_regions_missing`, `parse_failed` or `minified_content`. Regression tests are in `src/honesty.test.ts`.

<a id="bekannte-grenzen-e4"></a>

### Known limits (E4)

- **`chunkFile()` accepts no `AbortSignal`.** It is synchronous and pure; spec.md §22 requires
  cancellation support for public APIs. Damage kind `abort_signal` is therefore explicitly
  waived for this reason in the honesty check and recorded in its skip ledger, never silently
  omitted. Cancellation would be meaningful only between strategy steps and would change the
  signature, remaining a separate task.

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
