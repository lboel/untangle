# @untangle-code/parser-registry

WP-06: the `ParserRegistry` implementation (a port from `@untangle-code/domain`), plus
`LanguageAdapter` implementations for TypeScript, JavaScript, TSX, JSX and Vue SFCs,
Python, additional native languages, prose and structured text. This package is part
of Untangle's public package surface.

**Two backends (WP-220).** Since WP-220, two parser backends operate behind the same
`LanguageAdapter` contract: **tree-sitter** for TypeScript/JavaScript/TSX/JSX (measured
3.74× faster traversal, lower memory use, complete `nodeIsMissing` support) and
**ast-grep** for Go and Rust — languages that would not be available without existing
third-party grammars. `src/languages/astgrep-backend/README.md` documents which backend
serves each language, **why**, and the differences (size limit, heuristic
`missingNodeCount`, separate `parser_version`). The unified traversal in
`src/languages/shared/` serves both backends; native tree-sitter shapes satisfy the
tree contract structurally, so the faster backend pays no abstraction cost.

Normative sources: spec.md §7.1–§7.3, §8.2–§8.3, §14.2, §16.2–§16.7, §17.3;
architecture.md §6.5, §15.1. All types (`LanguageAdapter`, `ParsedAst`, `ExtractedSymbol`,
`RawImport`, `RawCall`, `ComplexityFacts`, `HalsteadTokens`, `AstRegion`, `ParserRegistry`
and others) come unchanged from `@untangle-code/domain`; this package defines no
competing types.

<a id="grammatik-wahl"></a>

## Grammar selection

Tested under Node 22/26, ESM, `verbatimModuleSyntax`:

- **web-tree-sitter (WASM)**: `Parser.init()`/`Language.load()` must be `async`.
  The domain's `LanguageAdapter.parse()` is **synchronous**. A WASM load cannot be
  hidden cleanly before the first `parse()` call without loading all languages at
  startup (prohibited by the task) or requiring an async registry factory (outside
  the port contract). Rejected.
- **typescript (`ts.createSourceFile`) as a fallback**: allowed by the task, but only
  for the TS/JS family. It provides no AST for actual JSX in JS without a TS compiler
  mode, no uniform byte-range API, and a completely different compatibility path
  for later languages such as Python. Unnecessary because the next option works.
- **`tree-sitter` (native N-API bindings) + `tree-sitter-typescript` + `tree-sitter-javascript`**:
  selected. Empirically verified (see this package's test history): on Node 22/26
  arm64/Darwin, `npm install` supplies working precompiled binaries immediately
  (`node-gyp-build` finds them in the package; no compilation required).
  `parser.parse(text)` is fully **synchronous**. `tree-sitter-javascript` also parses
  JSX natively, which is why `jsx` uses the same grammar loader as `javascript` below.
  Version constraint: `tree-sitter@0.21.1` + `tree-sitter-typescript@0.23.2` +
  `tree-sitter-javascript@0.23.1` (newer `tree-sitter-javascript`/`-typescript` versions
  require `tree-sitter@^0.25`, conflicting with `tree-sitter-typescript`'s `^0.21.0`
  peer dependency; this combination is the only one jointly resolvable at that point).

**Language → grammar mapping** (`languages/shared/dialect.ts`):

| languageId | Extensions | Grammar module | Export |
|---|---|---|---|
| `typescript` | `.ts .mts .cts` | `tree-sitter-typescript` | `.typescript` |
| `tsx` | `.tsx` | `tree-sitter-typescript` | `.tsx` |
| `javascript` | `.js .mjs .cjs` | `tree-sitter-javascript` | (default) |
| `jsx` | `.jsx` | `tree-sitter-javascript` | (default) |
| `vue` | `.vue` | `@vue/compiler-sfc` for block boundaries; existing JS/TS grammars for inline scripts | See below |

`javascript` and `jsx` are two **separate** `LanguageAdapter` instances (their own
`languageId`/extensions, as required by the task's “four LanguageAdapters”). Internally
they share a grammar because `tree-sitter-javascript` parses JSX without extra configuration.

<a id="vue-ausführbaren-quelltext-messen-sfc-grenzen-sichtbar-halten"></a>

### Vue: measure executable source and expose SFC boundaries

`createVueAdapter()` registers `.vue` at support level `structural`. The official
[`@vue/compiler-sfc` parser](https://github.com/vuejs/core/tree/main/packages/compiler-sfc)
identifies SFC block boundaries and loads only on `parse()`. The adapter passes the
unchanged contents of `<script>` and `<script setup>` to the existing JS, TS, JSX or
TSX adapters. It neither generates nor measures compiled render or setup code; existing
rules for decisions, Halstead and symbol detection stay the same.

All ranges are then shifted to the original UTF-8 bytes and lines of the `.vue` file,
including imports, calls, comments and diagnostics. A single script block retains its
qualified symbol names. With two blocks, `script.<Name>` and `setup.<Name>` distinguish
the execution contexts. File facts share one file scope; child script scopes and logical
decision groups remain distinct. This does not model Vue runtime bindings between blocks.

The single chunk root covers the entire original file. Template, style and custom blocks
therefore remain searchable as text. Their complexity, directives, template calls,
component use and CSS dependencies are **not** captured as code facts. Each such block
receives a warning with `kind: "other"`, `code: "analysis_scope_limited"`, the prefix
`Vue analysis scope:` and its original range. `parseQuality: "complete"` means the SFC
structure and analyzed inline scripts are syntactically valid; it claims neither complete
Vue semantics nor successful Vue compilation.

Template-only files, external `script src`, unsupported script languages, different
`lang` attributes on the two scripts and syntax damage produce `partial` with specific
diagnostics. External scripts must be analyzed as separate source files. Without an
analyzed inline script, no executable scopes or artificial complexity values are created.
The SFC input has the same 8 MiB byte limit as the existing tree-sitter adapters. The
separate parser version `untangle-parser-vue-sfc-v1` distinguishes this analysis from
earlier text fallbacks.

`src/languages/vue/adapter.test.ts` checks real SFCs with all four script dialects,
Options API, both scripts, Unicode/CRLF offsets, imports/calls, nested symbol regions,
unchanged TS facts, invalid and external scripts, and visible analysis limits.

**Implication for later languages** (documented as the task requires): Python (WP-09)
can also use native `tree-sitter` bindings (recommended, following the same pattern)
or another approach. The registry itself is grammar-independent (`register(adapter)`);
nothing in `registry.ts` or `languages/index.ts` needs to change.

## Lazy Loading

`createParserRegistry()` registers four `LanguageAdapter` objects without loading **any**
native module. `languages/shared/grammar-loader.ts` loads `tree-sitter` itself and each
grammar only on the first `parse()` call for that language, through
`node:module#createRequire` (synchronous CJS `require` from ESM, needed because `parse()`
must be synchronous), with a module-level cache. A CLI reading only TypeScript files
never loads `tree-sitter-javascript`.

<a id="eine-einzige-analyse-pro-datei"></a>

## One analysis per file

Every `LanguageAdapter` method (`extractSymbols`, `extractImports`, `extractCalls`,
`computeComplexity`, `tokenizeForHalstead`, `extractChunks`) is a thin projection over
**one** `AnalysisResult`. `languages/shared/engine.ts#analyzeTree` computes it in a single
AST traversal, and `create-adapter.ts` memoizes it per `ParsedAst` through a `WeakMap`.
This also guarantees consistency: a `SymbolScopeFact`'s `symbolScopeId`
(`computeComplexity`) is exactly the same string as a `RawCall`'s `callerScopeId`
(`extractCalls`) for a call inside that scope. Both come from the same live scope stack
frame in the same traversal, rather than independently reconstructed scope ID algorithms
that could diverge.

<a id="traversierung-cursor-nicht-children-wp-95"></a>

## Traversal: cursors instead of `.children` (WP-95)

Traversal navigates through the **cursor API** (`tree.walk()`, `gotoFirstChild`,
`gotoNextSibling`, `gotoParent`), never `node.children`. There are two reasons, and the
second matters more than the first.

**Speed.** Each `.children` access creates a JS array of node wrappers and crosses the
native library boundary once per node. Measured against this repository (738 files,
134,782 lines, `pnpm walk:messung`):

| Stage | Through `.children` | Through cursors | Factor |
|---|---:|---:|---:|
| `parse` (including parse diagnostics) | 2,803 ms | 853 ms | 3.29× |
| Traversal (`computeComplexity`) | 16,596 ms | 4,662 ms | 3.56× |
| **Total** | **19,440 ms** (6.93 kLOC/s) | **5,541 ms** (24.32 kLOC/s) | **3.51×** |

**Correctness.** `tree-sitter@0.21.1` reports a node's type reliably only when the cursor
**descended from the root**. Neither `node.children` nor a cursor reset to a subtree
(`node.walk()`) knows the parent node's alias context. In this repository both reported
**1,411 comment nodes in 207 files** as `interface_body`. The previous traversal therefore
failed to recognize them as comments: they were absent from `ComplexityFacts.comments`,
counted as Halstead **operators**, and included in `astHash` and `tokenFingerprint`,
contrary to `fingerprint.ts`'s promise that both fingerprints exclude comments. A comment-only
edit therefore appeared to change the symbol's structure (`spec.md` §17.3).

Measured across this repository: **1,411** comments counted as Halstead operators
(out of 133,282) and were missing from `comments` (6,821 instead of 8,232);
**531 of 10,328** symbols (5.1%) now have corrected fingerprints. Cyclomatic and cognitive
complexity do **not** change: neither calculation includes comments.

Three rules follow for this package:

1. `engine.ts#analyzeTree` creates **one** cursor at the root and passes it through.
   Every helper that moves it returns it to its original position.
2. `computeAstHash`/`computeTokenFingerprint` accept **this** cursor, not a node.
   Switching them back to `node.walk()` would reintroduce the defect.
3. A `SyntaxNode` wrapper is created only where a detector actually needs it
   (`engine.ts#visitInnerNode`, prefilter `decisions.ts#mayCarryDecisionOrNesting`).

Verified by `languages/shared/cursor-walk.test.ts` (regression: all four assertions fail
before WP-95) and `scripts/walk-gegenprobe.mjs`, which runs both approaches over every
source file and checks that **every** difference has precisely this cause.

<a id="byte-offsets--kritische-falle"></a>

## Byte offsets — a critical pitfall

The domain contract defines `SourceRange.startByte`/`endByte` as **UTF-8 bytes**. Native
`tree-sitter` Node bindings return `startIndex`/`endIndex` in **UTF-16 code units**
(empirically verified: a 4-byte astral character increases `endIndex` by 2, not 4).
`text/byte-offset-table.ts#buildByteOffsetTable` builds one prefix-sum table per file
(O(n) construction, O(1) lookup). **Every** `SourceRange` construction in this package
goes through `node-utils.ts#rangeOf`, which uses that table. Never copy
`node.startIndex`/`endIndex` directly into a `SourceRange`.

<a id="signaturnormalisierung-specmd-55"></a>

## Signature normalization (spec.md §5.5)

See the detailed documentation in the header comment of `languages/shared/signature.ts`.
The rules are:

1. **Whitespace**: arbitrary runs collapse to one space; spacing around `,`/`:`/`(`/`)`/
   `<`/`>`/`?:` is canonicalized instead of copied literally.
2. **Default values** (`= <expr>`) are removed from parameters AND generic type parameters
   (a depth scanner over `(`/`[`/`{`/`<`, splitting top-level commas first; see
   `splitTopLevel`/`stripDefaultValue`).
3. **Optional markers** (`?`) are retained and canonicalized immediately before `:`
   (`a ?: string` and `a?:string` → `a?: string`); they change the call contract
   independently of defaults.
4. **Type annotations** are preserved literally, subject to the whitespace rules.

Known documented limit: the depth scanner treats `<`/`>` as generic brackets. A comparison
operator `<`/`>` **inside a default value** (`(a = b < c ? 1 : 2)`) can confuse depth
counting for that parameter. This is accepted as a rare case outside the chosen scope.

<a id="entscheidungen"></a>

## Decisions

1. **One AST traversal instead of six independent method implementations.** See “One
   analysis per file” above. `create-adapter.ts` caches per `ParsedAst`.
2. **`RawImportKind` has no `require` value.** `require("x")` maps to `importKind: "import"`
   (functionally a synchronous import); `"package_dependency"` is reserved for an edge
   **resolved** by the import resolver/file graph, rather than a source syntax form.
3. **The `namespace` scope kind maps to chunk kind `"module"`.** `ChunkKind` (domain) has
   no `"namespace"` member; a TS `namespace`/`module` block is itself a module-like
   grouping of symbols.
4. **`exportedNames` recognizes only direct wrapping.** `export function f() {}` and
   `export default class {}` are recognized. A later `export { f }` elsewhere in the file,
   or `export default f;` as a separate statement referencing an already declared name,
   is NOT traced back (see `scope-naming.ts#resolveExportedNames`). This can be added
   when a consumer needs it.
5. **The `parse()` return value has no `parserVersion` field.** The WP-06 task mentions it,
   but `ParseResult` (domain `analysis.ts`) defines exactly `{parseQuality, ast, diagnostics,
   errorNodeCount, missingNodeCount}`, without `parserVersion`. Because the domain defines
   the contracts exactly and this package may not add competing fields, the field is NOT
   appended (see openIssues: “belongs in domain”).
6. **`failed` at ≥50% damaged nodes.** tree-sitter's error recovery almost always produces
   a usable tree; a small absolute number of `ERROR`/missing nodes means `partial`,
   while a mostly damaged file means `failed` (`ast: null`). Neither spec.md nor
   architecture.md specifies a normative value; this is the package's documented
   threshold (`parse-diagnostics.ts`).
7. **Guard clause heuristic**: an `if` without `else` whose only consequence is a
   `return`/`throw`/`break`/`continue` is classified as `DecisionKind: "guard"` instead of
   `"if"` (spec.md §16.2: “guards when they create independent paths”).
8. **Property fields are separate scopes**, unless their initializer is itself a
   function/class (`class C { handler = () => {} }`). The function then receives the
   scope (borrowing the field's name), avoiding duplicated `C.handler.handler`
   (`scope-naming.ts#fieldDelegatesToFunctionValue`).
9. **Halstead classification**: brackets/commas/semicolons/periods (`( ) { } [ ] , ; .`)
   do **not** count as operators. All other symbol/keyword terminals count as operators;
   identifiers/`this`/`super` and literals (including template text fragments) count as
   operands. TS type keywords such as `number`/`string`/`void` (kind `predefined_type`)
   do **not** count: they are pure type syntax, not values. Grammar pitfall: the `string`
   type keyword node has the same `node.type` as a string literal container; see the
   comment in `engine.ts`.
10. **`property_group` chunks combine consecutive class fields**; a method/constructor
    chunk interrupts the group. A class can have multiple groups.
11. **The file region is always exactly one `AstRegion` of `ChunkKind: "module"`**, with
    `children` for top-level symbols (and recursively for class members). The region
    contract is documented normatively in exactly ONE place: the `AstRegion` type in
    `packages/domain/src/analysis.ts`. The chunker unpacks the root region and handles
    each `chunkKind` according to its kind at every depth. Symbol chunks
    (function/method/constructor/class_overview) therefore exist even when the entire
    file fits within the token budget (spec.md §8.3 steps 3–5).
12. **Symbol regions include the `export` wrapper.** The tree-sitter scope node is only
    the declaration (`function_declaration`, etc.); the enclosing `export_statement`
    belongs to the symbol's chunk, rather than a module-level gap. `chunks.ts#ownRange`
    expands the region accordingly, in addition to the already associated documentation/
    decorator range (spec.md §8.3 step 2).
13. **`static { ... }` blocks are modeled as separate child regions of the class**
    (`chunkKind: "property_group"`, not splittable). They open no symbol scope (no name
    or stable symbol ID), but contain executable content that would otherwise escape
    the chunker's member traversal (spec.md §8.4, no silent data loss). Comparable
    unmodeled constructs in a class body (comments between methods, delimiters) are
    covered by the chunker's gap handling; see region contract item 4 in
    `domain/src/analysis.ts`.

## Tests

`npx vitest run` (55 tests, co-located `*.test.ts`):

- `text/byte-offset-table.test.ts` — UTF-8/UTF-16 conversion, including astral characters.
- `languages/shared/signature.test.ts` — whitespace/default/optional-marker normalization.
- `languages/shared/grammar-loader.test.ts` — caching, end-to-end parse sanity.
- `registry.test.ts` — extension/language resolution, override semantics.
- `languages/golden.test.ts` — golden fixtures (`__golden__/*.json`) for TS/JS/TSX: symbols,
  imports, calls, decision kinds, scope ID consistency, AST depth.
- `languages/adapters.test.ts` — syntax errors → `partial`/`failed` without crashing;
  classes with multiple methods → separate, non-overlapping regions; dynamic imports
  and re-exports; signature normalization stable under whitespace changes (including
  the cross-check “same result with different formatting, different result for actual
  semantic changes such as optional instead of default”); astHash stable under whitespace
  reformatting and literal-only edits; tokenFingerprint changes under literal edits;
  guard clause detection.
- `index.test.ts` — `createParserRegistry()` correctly registers all four MVP languages.

<a id="verifikation"></a>

## Verification

```
npx tsc -p tsconfig.typecheck.json   # 0 errors
npx tsc -p tsconfig.json             # Build, 0 errors
npx vitest run                       # 55/55 passing
npx eslint packages/parser-registry  # 0 errors, 0 warnings
```

<a id="e4-ehrlichkeitspruefung-wp-165"></a>

## E4 honesty check (WP-165)

`src/honesty.test.ts` runs `assertHonestUnderDamage` from `@untangle-code/testkit` against
both adapter families — TypeScript (tree-sitter) and Python (this package's handwritten
tokenizer/parser) — using ONE shared adapter instance per family, so concurrency damage
can affect shared state (grammar cache, offset tables).

It does not check symbol counts (shorter input may correctly reduce them). It checks that
the returned region tree still spans the entire input, all reported ranges lie within the
input, and the single `"module"` root required by the adapter contract is present.

**Result: both adapters pass every damage case.** For damaged structure, the Python
adapter reports seven diagnostics and lowers quality; the TypeScript adapter keeps its
promises unchanged. Also checked and correct: byte offsets for characters outside the
BMP (emoji) and umlauts. The classic UTF-16-instead-of-byte error is absent here.

<a id="bekannte-grenzen-e4"></a>

### Known limits (E4)

- **Not every `.children` use in this package has been converted.** The three traversals
  covering the entire tree have been converted: `engine.ts`, `fingerprint.ts` and
  `parse-diagnostics.ts`. Targeted accesses in `import-detection.ts`, `scope-signature.ts`,
  `scope-naming.ts`, `chunks.ts` and `node-utils.ts` still use `.children`. They are not
  measurably expensive (each sees only a handful of children), but share the type defect
  described above: a comment node could appear under the wrong type. This currently
  causes no damage because each location checks specific type names (`import_clause`,
  `get`, `set`, `*`, `default`, `class_static_block`, …), none of which is the observed
  incorrect type `interface_body`. `scripts/walk-gegenprobe.mjs` verifies that imports,
  regions, chunk IDs and call edges remain unchanged. A different incorrect type with
  another grammar could change this; those accesses would then need conversion too.
- **`LanguageAdapter.parse/extractChunks/extractSymbols` accept no `AbortSignal`.** The
  signature belongs to `@untangle-code/domain` (`analysis.ts`) and cannot be changed
  here; spec.md §22 requires cancellation support for public APIs. The `abort_signal`
  damage case is therefore waived for precisely this reason and appears in the test
  report's skip ledger.

<a id="lizenz"></a>

## License

**AGPL-3.0-only.** This package includes the full license text in [`LICENSE`](./LICENSE),
the rationale for the license choice in [`NOTICE`](./NOTICE), and the licenses of all
third-party production dependencies in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).
All three files are part of the npm tarball — AGPL-3.0-only §4 and §5 require every recipient
to receive the license, and a README alone is not a copy of the license.

Local use creates no obligation. Copyleft obligations apply to redistribution and provision
as a network service (AGPL §13).

The corresponding TypeScript source is included under `src/` in the same tarball; the full
repository is available at <https://github.com/lboel/untangle>.
