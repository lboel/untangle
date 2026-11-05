<a id="ast-grep-backend-wp-220"></a>

# ast-grep backend (WP-220)

This directory is the parser registry's SECOND backend. It uses the same `LanguageAdapter`
contract as tree-sitter: `chunker`, `complexity`, `file-graph` and `symbol-graph` cannot tell which
backend ran.

<a id="die-regel-welche-sprache-laeuft-wo"></a>

## Rule: which language uses which backend

| Language | Backend | Reason |
|---|---|---|
| TypeScript, JavaScript, TSX, JSX | **tree-sitter** | Measured 3.74× faster traversal, lower memory use, complete `nodeIsMissing`, unchanged golden tests |
| Python | Custom parser | Unchanged; replacement is prepared, not performed (see Open work) |
| Markdown/prose, structured data | Custom adapters | `text` support, no syntax tree needed |
| **Go, Rust** | **ast-grep** | Ready-made MIT-licensed grammars; these languages would not exist here without this backend |

The split follows measurement rather than preference. ast-grep has **no cursor API**: descent
uses `children()`, creating a fresh JS array of node wrappers every time. Repository-wide
measurement (721 files, 1,143,212 nodes, both versions in one process):

```
tree-sitter Cursor : parse 256 ms   walk  671 ms  =>  1,703,642 nodes/s
ast-grep children(): parse 347 ms   walk 2511 ms  =>    455,329 nodes/s
                                    Factor 3.74; overhead 1.61 us per node
```

This matches the `.children` approach removed by WP-95. Switching the JS/TS family would regress
the exact area repaired in wave 6, while each current dialect costs only nine lines. For Go and
Rust the overhead is not a regression: those languages would not otherwise exist here.

<a id="was-dieses-backend-anders-macht--und-wo-es-steht"></a>

## Backend differences and their locations

| Aspect | tree-sitter | ast-grep | Location |
|---|---|---|---|
| Traversal | Native cursor API | Iterative stack-based cursor | `syntax.ts` |
| 32-KiB buffer limit | Exists; needs `bufferSize` (WP-215) | Absent, tested to 4 MB without an option | `shared/parse-limits.ts`, `adapter.ts` |
| Size limit | 8 MiB | **5 MiB**, traversal uses more memory | `adapter.ts` |
| `missingNodeCount` | Measured through `nodeIsMissing` | **Heuristic**, zero-width leaf | `syntax.ts`, `shared/parse-diagnostics.ts` |
| Node field name | `cursor.currentFieldName` | Lookup through parent fields | `syntax.ts` |
| `parser_version` | `untangle-parser-v1` | `untangle-parser-astgrep-v1` | Domain `versions.ts` |

EVERY diagnostic derived from heuristic `missingNodeCount` describes its source: heuristically
detected zero-width nodes; ast-grep has no nodeIsMissing. Anyone reading the count sees its origin,
the difference between an estimate and a silent assertion (E4).

<a id="der-vereinheitlichte-walk-bedient-beide-wege"></a>

## One traversal serves BOTH backends

`languages/shared/` has been backend-neutral since WP-220:

- `syntax.ts`: `SyntaxNode`/`SyntaxCursor` tree contracts. Native tree-sitter types satisfy them
  STRUCTURALLY, without wrappers; the faster backend pays no abstraction cost, pinned in
  `tree-sitter-types.ts`.
- `profile.ts`: language profile describing node-kind meaning.
- `js-family-profile.ts`: handwritten TS/JS/TSX/JSX profile, with unchanged behavior (golden tests).
- `table-profile.ts`: table-driven profiles; a new language costs a table rather than another engine.

Wave 6's comment-node defect (`cursor-walk.test.ts`) stays fixed: traversal descends from the ROOT
and both fingerprints omit comments. The defect does not arise with ast-grep.

<a id="eine-sprache-hinzufuegen"></a>

## Adding a language

1. Add its `@ast-grep/lang-<x>` package INDIVIDUALLY to `package.json`, never a bundle: 22 language
   packages occupy 450 MB together.
2. Write its table in `languages.ts`, following `GO_TABLE`/`RUST_TABLE`.
3. Register the adapter in `languages/index.ts`.
4. Extend `adapter.test.ts` with real source, not a ten-line snippet.

<a id="bekannte-grenzen-e4"></a>

## Known limits (E4)

- **No prebuild on Alpine (Linux musl), Windows ARM64 or Windows ia32.** Language packages ship
  prebuilds only for macOS x64/arm64, Linux x64/arm64 glibc and Windows x64. Missing-prebuild build
  failures are caught and merely logged by `postinstall`, which exits 0, so installation REPORTS
  SUCCESS. `napi.ts` therefore checks each language at registration and reports
  `grammar_unavailable`, producing reasoned skip-ledger entries rather than silent zeros.
- **One registration only.** `registerDynamicLanguage` runs once; a second call silently
  registers nothing. Every enrolled language is therefore registered TOGETHER on first parse.
  Subsequent enrollment throws rather than doing nothing.
- **`SgNode#id()` is address-derived** and differs across processes. It serves only field-name
  comparison within a traversal and appears in no result data. `adapter.test.ts` checks
  determinism across two runs.
- **`Pos.index` is a UTF-16 offset**, despite ast-grep's "byte offset" type documentation.
  All byte ranges use `ByteOffsetTable`.
- **Table-driven profiles are weaker than handwritten profiles.** Import bindings, call
  qualifiers, signature normalization and Rust `fn` inside `impl` being `function` rather than
  `method` are documented in `shared/table-profile.ts` and the tables themselves.
- **`LanguageAdapter.parse` is synchronous.** Exploration recommended yielding the event loop per
  file for napi finalizers, but that conflicts with domain `analysis.ts` and was NOT done. A lower
  size limit is used instead; callers parsing many large files in one turn should account for this.

<a id="offen-bewusst-nicht-getan"></a>

## Open work (deliberately not performed)

- **Python retains its custom parser.** Exploration recommends replacing it first, explicitly
  conditional on running the 1,432 lines of Python tests—including WP-76's 20,000-clause `elif`—
  against ast-grep BEFOREHAND. That did not happen, so nothing was deleted. Machinery is ready;
  replacement is a separate work item with its own evidence.
- **`doctor` does not yet report ast-grep availability.** `napi.ts` exposes per-language
  `astGrepLanguageStates`; the command lacks its display.
- **THIRD_PARTY_LICENSES.** Language packages ship external tree-sitter grammars while naming only
  ast-grep in LICENSE. The license of EACH grammar needs to be added.
