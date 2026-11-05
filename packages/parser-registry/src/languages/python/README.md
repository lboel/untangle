<a id="python-adapter-wp-09"></a>

# Python adapter (WP-09)

Python `LanguageAdapter` (`@untangle-code/domain`), support level `deep` (spec.md §7.1–§7.3).
Assigned write scope: `packages/parser-registry/src/languages/python/**`, plus the single
registration line reserved for WP-09 in `../index.ts` (`registry.register(createPythonAdapter());`).

Normative sources: spec.md §7.1–§7.3, §16.2–§16.8; architecture.md §6.5, §15.1. Every type
(`LanguageAdapter`, `ParsedAst`, `ExtractedSymbol`, `RawImport`, `RawCall`, `ComplexityFacts`,
`HalsteadTokens`, `AstRegion`, etc.) comes unchanged from domain; this module defines no competing types.

<a id="grammatik-wahl"></a>

## Grammar choice

**No `tree-sitter-python`.** WP-09's write scope is exclusively `languages/python/**`; adding a
native grammar requires editing `package.json`, outside that scope and prohibited by the task.
WP-06's package README explicitly allows either native tree-sitter bindings (recommended, same
pattern) or another approach; the registry is grammar-agnostic.

The chosen approach is a **handwritten indentation-based tokenizer and recursive-descent parser**
with its own explicit AST (`ast.ts`, discriminated unions, no generic tree-sitter-shaped node).
`languages/shared/*` (decisions, node kinds, calls/imports, signatures, fingerprints, chunks) is
bound to JS/TS grammar vocabulary (`if_statement`, `catch_clause`, `binary_expression`, `<`/`>` as
generic brackets, no `elif`/`except`/`match`/`with`/walrus). It is insufficiently generic for Python
without distortion. This module supplies small corresponding `engine.ts`, `signature.ts`,
`fingerprint.ts`, `chunks.ts`, `extract-symbols.ts` implementations satisfying the same domain contracts.

**File-to-module mapping:**

| File | Role |
|---|---|
| `tokenizer.ts` | INDENT/DEDENT/NEWLINE lexer, r/b/f and triple-quoted string prefixes, bracket depth for implicit line joining, backslash continuation |
| `ast.ts` | Own AST node types (`Stmt`/`Expr` unions) |
| `parser.ts` | Recursive-descent parser with panic-mode recovery |
| `engine.ts` | ONE unified traversal: scope tree, `ComplexityFacts`, imports, calls |
| `signature.ts` | Signature normalization (spec.md §5.5), Python-specific rules |
| `fingerprint.ts` | `astHash`/`tokenFingerprint` from the custom AST |
| `chunks.ts` | `AstRegion` tree from scope tree |
| `extract-symbols.ts` | Scope tree → `ExtractedSymbol[]` |
| `create-adapter.ts` | `LanguageAdapter` composition, parse-quality classification |
| `index.ts` | `createPythonAdapter()`, the subdirectory's only public export |

<a id="eine-einzige-analyse-pro-datei"></a>

## One analysis per file

As in WP-06, every adapter method is a thin projection over ONE `AnalysisResult`, calculated by
`engine.ts#analyzeModule` in one recursive traversal of the `Module` AST and cached per `ParsedAst`
through a `WeakMap` in `create-adapter.ts`. A `SymbolScopeFact.symbolScopeId` therefore equals a
`RawCall.callerScopeId` for calls within that scope.

<a id="python-besonderheiten--wie-sie-behandelt-werden"></a>

## Python-specific handling

- **Indentation as block structure:** `tokenizer.ts` measures columns, expanding tabs to multiples
  of 8 only for comparison without changing byte/character offsets, and emits INDENT/DEDENT;
  `parser.ts#parseSuite` consumes them.
- **`elif` is continuation, not new nesting** (spec.md §16.4, like `else if`). `parseIf` builds
  nested `If` chains (`orelse: [If]`), as CPython's `ast` does, marking nested nodes
  `isElifContinuation: true`. The engine emits `DecisionKind: "else_if"` PLUS `NestingFact` with
  `continuation: true` contained within the outer `if`, not a sibling span. This is precisely
  what `@untangle-code/complexity#buildSymbolIR` expects for avoiding a full nesting increment.
- **`with` / `async with`:** neither decisions nor nesting boundaries (absent from the spec's
  decision list); transparent blocks like plain `{}` in TS/JS.
- **Multiple-clause comprehensions:** every `for` is `DecisionKind: "loop"` plus
  `NestingFact("loop")` (spec.md §16.2 for-each), every filter `if` is `DecisionKind: "if"` plus
  `NestingFact("if")`. Each range spans its keyword through the comprehension's end, correctly
  containing later clauses and matching the containment stack. Two `for` and one `if` therefore
  produce `["loop", "loop", "if"]`.
- **`try`/`except`/`else`/`finally`:** only each `except` is a `DecisionKind: "catch"`, like JS/TS
  `catch_clause`; the other bodies are transparent.
- **`match`/`case`:** `match` itself is ONLY `NestingFact("switch")`, not a decision, like
  `switch_statement`. Every arm is `DecisionKind: "case"`. Patterns are NOT parsed fully
  structurally (decision 3); each `|` alternative beyond the first emits
  `DecisionKind: "pattern_alternative"` (spec.md §16.3, extended cyclomatic,
  `countsForClassic: false`).
- **Decorators:** no separate `ChunkKind` (`CHUNK_KINDS` has no `"decorator"`). A decorated
  `def`/`class` region starts at its FIRST decorator: `openScope` receives `node.pos` already
  expanded by the parser, preventing decorator lines from falling into gaps (spec.md §8.4), like
  WP-06's export-wrapper-inclusive symbol regions. Decorator EXPRESSIONS are traversed in the
  OUTER scope where definition-time evaluation occurs, attributing `@app.route("/x")`, for
  example, to the enclosing function.
- **Nested functions/lambdas:** as in TS/JS, `FunctionDef`/`Lambda` within an executable scope
  adds `NestingFact("lambda")` to the OUTER scope in addition to creating its own scope, following
  spec.md §16.4's documented local-function/lambda nesting context.
- **Walrus (`:=`):** `NamedExpr`; not a decision, but operator token `:=` plus a `declaration`
  identifier fact for its target.
- **`global`/`nonlocal`:** separate statement nodes with `reference` identifier facts for names.
  Scope resolution is for a later symbol resolver, not this adapter.
- **`async def`/`await`/`async for`/`async with`:** fully recognized: `isAsync` on
  `FunctionDef`/`For`/`With`, separate `Await` expression nodes and `"await"` operator tokens.

<a id="signaturnormalisierung-specmd-55--signaturets"></a>

## Signature normalization (spec.md §5.5) — `signature.ts`

1. **Whitespace** collapses to one space; spacing around `,`/`:` is canonicalized.
2. **Default values** (`= <expr>`) are removed from parameter lists, as in TS/JS: defaults are
   calling convenience, not another overload.
3. **Type annotations** (`: <type>`) remain literal apart from whitespace normalization.
4. **`*args`/`**kwargs`/bare `*`/`/` markers:** `*`/`**`/`/` characters remain exact.
5. **Return types** (`-> <type>`) remain literal, with exactly one space around `->`.

**Documented TS/JS asymmetry:** TypeScript retains optional `?` independently of defaults because
it has dedicated syntax. Python has NO equivalent; default presence is unrecoverable after
normalization, just like TS/JS parameters without `?`. No informational asymmetry is invented;
there is simply nothing to retain.

<a id="entscheidungen"></a>

## Decisions

1. **No `tree-sitter-python`** (see Grammar choice): handwritten tokenizer/parser/traversal and
   own AST. Support remains `deep`: spec.md §7.1 requires complete chunking/symbol/call/import/
   complexity support, not a particular parser technology.
2. **`PyScopeNode.kind` has NO `"property"` member**, unlike WP-06's `ScopeNode`. Python class
   attributes are ordinary `Assign`/`AnnAssign` statements, not a separate grammar category with
   signature/visibility like TS fields. They produce no `ExtractedSymbol` or dedicated chunk;
   their text remains in the class body, covered as gaps or by `class_overview`. Named field
   symbols can be added when needed by a consumer.
3. **Patterns are NOT fully structurally parsed** (`parser.ts#scanPatternAlternatives`). A
   bracket-depth-aware scan finds `|` alternatives and simple name captures rather than validated
   capture/literal/class/sequence/mapping AST nodes. This supports `pattern_alternative` decisions
   and capture identifier facts; full pattern grammar remains additively implementable if needed.
4. **`__init__.py` re-export convention:** Python lacks explicit JS-style `export { x } from "y"`.
   Module-level imports in `__init__.py`/`__init__.pyi` conventionally form public package APIs, so
   EVERY top-level import/from-import, such as `from .mod import X` or `import X`, receives
   `importKind: "re_export"` rather than `"import"`. Nested imports remain `"import"`.
   This is a documented heuristic, not a normative spec/architecture rule.
5. **Visibility by naming** (`engine.ts#visibilityOf`): leading `__` without trailing `__` means
   `"private"` (name mangling); one leading `_` means `"protected"`; dunder methods (`__init__`,
   `__repr__`, …) receive `undefined` because they are public protocol, NOT private despite `_`.
   No normative value was prescribed; this directly follows common PEP 8 convention.
6. **`exportedNames` from `__all__` or underscore convention:** module `__all__ = [...]` is the
   final list when present; otherwise top-level names not starting `_` count as exported (PEP 8).
   Only top-level functions/classes receive non-empty `exportedNames`; nested methods/functions
   always receive `[]`, following WP-06's module-export semantics.
7. **Guard heuristic matches WP-06:** an `if` without `elif`/`else`, whose sole body statement is
   `return`/`raise`/`break`/`continue`, becomes `DecisionKind: "guard"`, not `"if"` (spec.md §16.2).
8. **Halstead classification:** brackets, commas, colons and dots are structural, not operators.
   Control/expression keywords (`if`, `for`, `and`, `or`, `not`, `await`, `yield`, `:=`, augmented
   assignment, comparisons `in`/`is`/`is not`/`not in`, etc.) are operators; identifiers/literals,
   including f-string text as `"template"`, are operands, deliberately matching WP-06 decision 9.
9. **f-strings:** the tokenizer reads ONE `STRING` with `isFString` and raw body.
   `parseFStringExpressions` extracts brace-depth/string-aware `{…}` segments, strips
   `!conversion`/`:format_spec` and self-documenting `{x=}`, then parses each through a second
   position-adjusted tokenizer/parser pass into real `Expr` nodes (`JoinedStr.values`). Calls and
   conditions INSIDE f-strings (`f"{compute(a, b)}"`, `f"{x if y else z}"`) therefore remain visible.
   Replacement fields INSIDE format specifications (`f"{v:>{width}}"`) are also evaluated, through
   an explicit worklist rather than recursion. Results are sorted by source position so ordering
   depends only on source. For Halstead, the ENTIRE f-string still counts as one `"template"`
   operand, avoiding repeated tokenization of text outside `{}`: a documented simplification.

   **E4 (WP-115):** subparsing discards nothing silently. Unparseable expressions, depth aborts,
   unclosed `{`, lone `}`, expressionless fields, unconsumed field text and every subparse lexer/
   parser finding become diagnostics on the MAIN parser. `classifyParseQuality` can no longer
   call lost f-string content `"complete"`. Depth aborts use a separate
   `ParseDepthExceededError`, preventing speculative rollback (`tryParseMatch`) from treating
   them as an ordinary "not a `match` after all".
10. **Parameter defaults/annotations are traversed in the function's own scope**, not the outer
    scope where definition-time evaluation occurs. This documented simplification affects none
    of spec.md §16's required metrics because parameter lists contain no control flow.
11. **Parse-quality thresholds use lines, not nodes** (`create-adapter.ts#classifyParseQuality`).
    The parser has no ERROR/MISSING nodes; panic-mode diagnostics may skip arbitrarily large
    broken regions. Diagnostic/non-empty-line ratios are used instead: ≥30% means `failed`, as
    does an empty module with non-empty source; otherwise `partial`. This is an independently
    documented threshold, analogous to WP-06's 50% node threshold.
12. **Error fallback ALWAYS consumes a token**, including INDENT/DEDENT/NEWLINE/ENDMARKER in
    `parser.ts#parseAtom`. Not consuming structural tokens to improve broken-block recovery was
    empirically rejected after infinite loops/OOM in paths whose surrounding loops lacked
    progress guards. Never crashing/hanging (spec.md §7.3) takes priority over maximum syntax
    recovery. Severely broken files become `parseQuality: "failed"` with `ast: null` anyway, so
    the resulting partial AST is never consumed.
13. **`for`/comprehension/`with as` targets do NOT use full expression grammar**
    (`parser.ts#parseTargetList`/`parseTargetAtom`). Full grammar reaches `parseComparison`, which
    interprets `in` as comparison: in `for x in a:`, it greedily expands `x` into `x in a` before
    the loop can consume its expected `in`, discovered by `parser.test.ts`. Targets therefore use
    restricted `atom_trailer` grammar—name/attribute/subscript/star/tuple/list—matching valid
    Python target forms.
14. **Calls without nameable targets are not reported as calls** (`engine.ts#detectCall`). Only
    `name(...)` and `obj.attr(...)` provide `calleeName`; `f()()`, `d["k"]()`, `(lambda: g)()` and
    similar forms have no source name for a resolver. No placeholder is invented. This is a
    **known limit**, not silent E4 loss: the complete `Call` and arguments remain in AST and
    complexity facts; only the call EDGE is absent. Runtime visibility requires an adapter
    `SkipLedgerV1` channel alongside `RawCall[]`; until then the limit is documented here.

## Tests

`npx vitest run`, co-located `*.test.ts` in this directory:

- `tokenizer.test.ts`: INDENT/DEDENT, implicit bracket line joining, backslash continuation,
  prefixes/triple quoting, numeric forms and no throws for malformed strings/brackets.
- `parser.test.ts`: functions, `elif` containment/`isElifContinuation`, multiple `elif`, two-`for`/
  one-`if` comprehensions, filtered dict comprehensions, `async def`/`await`, `async for`/
  `async with`, walrus, `global`/`nonlocal`, decorators, `try`/`except`/`else`/`finally`,
  `match`/`case` (or patterns, guards, wildcard, class/sequence patterns), distinguishing `match`
  identifiers, relative/star imports, parameter markers, syntax recovery, docstrings, f-string
  extraction and a dedicated never-hang/throw stress test of garbage/unbalanced brackets and
  deeply nested garbage input.
- `parse-honesty.test.ts`: WP-76, parse aborts from stack depth or unexpected internal errors must
  never appear as `parseQuality: "complete"` with empty results.
- `fstring-honesty.test.ts`: WP-115, the same rule for f-string subparsing. Fourteen loss cases
  (expression/format depth aborts, broken expressions, open `{`, lone `}`, empty fields, leftover
  text, unknown characters) enforce never complete after discarded subparsing; twenty-eight
  valid forms control false positives. Tests prove nested-format calls and whitespace-padded
  fields reach the AST and `case`-guard depth aborts survive speculative `match` parsing.
- `adapters.test.ts`: partial/failed quality without crashes; nonoverlapping method chunk regions;
  decorators inside symbol regions; `function`/`class`/`method`/`constructor` classification;
  visibility, `exportedNames` with/without `__all__`, docstrings, regular/from/relative/star/
  `__init__.py` imports, calls, formatting-stable signatures, stable `astHash`/`tokenFingerprint`,
  guards, continuation `elif`, comprehension/catch/case/pattern-alternative decisions, grouped
  boolean chains, scope-ID consistency across decisions/calls, nested-function/lambda nesting.
- `golden.test.ts` and `__golden__/python-basic.json`: symbols, imports, calls, decision kinds,
  scope-ID consistency and AST depth, matching WP-06's golden format.

<a id="verifikation"></a>

## Verification

```
npx tsc --noEmit -p tsconfig.typecheck.json   # 0 errors (entire package, including TS/JS/TSX/JSX)
npx tsc -p tsconfig.json                     # Build, 0 errors
npx vitest run                              # Entire package passes except 2 documented,
                                           # pre-existing tests outside this directory
                                           # (see openIssues in the WP-09 completion report)
```

A standalone script in the WP-09 completion report additionally proves the real
parser-registry → chunker → complexity seam on realistic Python: a class with
`__init__`/methods/`async def`/`try`/`except`/`else`/`finally`, plus a module function with list
comprehension and `match`/`case`. Multiple symbols have cognitive values >0 and chunks have
non-empty `symbolId`, the same seam demonstrated for TypeScript by `scripts/e2e-smoke.mjs`.

<a id="bekannte-grenzen-openissues-siehe-abschlussbericht"></a>

## Known limits (openIssues in the completion report)

- `createPythonAdapter` is NOT re-exported by package-public `src/index.ts`, outside
  `languages/python/**`. Likewise `src/index.test.ts` (four registered languages/Python not yet
  supported) is now stale after authorized registration in `../index.ts`. Both edits lie outside
  the assigned scope and are documented rather than performed, following the task's open-issues rule.
- Pattern grammar deliberately lacks full structural parsing (decision 3).
- Class attributes produce no dedicated `ExtractedSymbol` (decision 2).
