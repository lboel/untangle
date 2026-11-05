<a id="sprachbreite-über-ast-grep-wp-86"></a>

# Language breadth through ast-grep (WP-86)

Nine languages, one table each, no new engine. This file is the **countercheck for the ratchet**
in `vision.md` §1b: if adding a language costs 800 lines, nothing has been gained.

<a id="was-eine-sprache-gekostet-hat--nachgezählt-nicht-geschätzt"></a>

## Cost per language — counted, not estimated

`wc -l` over tables. "Code only" excludes comments and blank lines; comments explain the
interpretation and are intentional, not incidental.

| Language | File | Total lines | Code only |
|---|---|---:|---:|
| C++ | `cpp.ts` | 65 | 39 |
| Bash | `bash.ts` | 78 | 42 |
| Ruby | `ruby.ts` | 105 | 70 |
| PHP | `php.ts` | 105 | 84 |
| Java | `java.ts` | 115 | 86 |
| Swift | `swift.ts` | 118 | 83 |
| C | `c.ts` | 119 | 85 |
| C# | `csharp.ts` | 125 | 96 |
| Kotlin | `kotlin.ts` | 133 | 81 |
| **Nine-language total** | | **963** | **666** |
| Registration of all nine | `index.ts` | 61 | 46 |

**Median per language: 115 lines, including 84 code lines.** Exploration estimated 200–400 lines
per language, more than twice the measured cost.

`cpp.ts` explains why: **C++ costs 39 code lines** because its grammar extends C and the table
specifies only the **difference**: classes, namespaces, `try`/`catch`, lambdas. Related languages
must not pay twice for the same thing; doing so means the table boundary is wrong.

<a id="was-einmalig-dazukam"></a>

## One-time additions

`shared/table-profile.ts` grew from **659 to 911 lines (+252)**. Those 252 lines support **all
eleven** ast-grep languages, not just WP-86's nine:

| Addition | Purpose |
|---|---|
| `caseExcludeChildKinds`, `caseExcludeFirstChildText` | Catch-all arms do not count; Java, C, C# and Bash use the SAME node kind for `case` and `default` |
| `elseIfKinds` | Ruby `elsif`, PHP `else_if_clause` and Bash `elif_clause` have separate node kinds |
| `guardKinds` | Swift `guard` is a dedicated early-return keyword |
| `patternAlternativeKinds`, `shortCircuitKinds` | Rust `Some(1) \| Some(2)` and `?` |
| `anonymousOperatorKinds` | Kotlin, Swift and Bash store `&&`/`\|\|` as anonymous children rather than fields |
| `nameKindPath`, `nameDescend` | C# fields (`variable_declaration > variable_declarator.name`), C declarator chains (`*ring_new`), PHP/Kotlin/Swift properties |
| `parentKinds` | `var i = 0` in function bodies is NOT a symbol (Kotlin, Swift) |
| `visibilityWords` | Java `modifiers` stores `private final static` in ONE node |
| `receiverField`, `acceptCall` | Separate Java/Ruby receivers; Swift `items["a"]` is indexing, not a call |

**Overall:** 963 table lines + 252 one-time extension lines = **1,215 lines for nine languages**,
or **135 lines per language**. For comparison, the package's handwritten Python adapter has
5,604 lines for **one** language.

<a id="was-gemessen-ist-und-was-nicht"></a>

## What was and was not measured

**Measured** (`golden.test.ts`, 21 tests, all passing): one real example file per language,
pinning parse quality (`complete`, zero error nodes), the full symbol list by qualified name and
kind, counts per decision kind, comments, imports and sampled calls. Eight languages additionally
verify that `switch`/`match`/`case` catch-all arms do **not** count; Rust `?` contributes to extended
but not classic complexity.

**Not measured:** none of these grammars ran against a real project in its language. Example
files are 53–93 lines, handwritten to expose language characteristics. They support the
interpretation, not robustness across 100,000 lines of external code. `@ast-grep/lang-swift` is
version 0.0.8 and carries the greatest risk here.

<a id="lizenzen-und-plattformen"></a>

## Licenses and platforms

Embedded tree-sitter grammars, their authors and platforms **without** prebuilds are documented in
`../GRAMMARS.md`, NOT `THIRD_PARTY_LICENSES.md`. That file is generated from production dependencies;
grammars are `devDependencies` *inside* language packages, invisible to the generator.

<a id="die-auslegung-der-entscheidungspunkte--wo-sie-nicht-gleich-ist"></a>

## Decision-point interpretation — where languages differ

Rules are **not** identical across languages. Each table's header explains deviations; overview:

| Construct | Interpretation | Rationale location |
|---|---|---|
| Catch-all arm (`default`, `_`, `else ->`, `*)`) | **Never** counts | Every table |
| Go `select` | Each `communication_case` counts, a real runtime branch | `../languages.ts` |
| Rust `match` | Each arm counts except catch-all `_` | `../languages.ts` |
| Rust `?` | `short_circuit`, **extended only**, never classic | `../languages.ts` |
| `finally`/`ensure` | Does **not** count; always runs, no branch | `java.ts`, `ruby.ts` |
| Ruby postfix forms (`x if y`) | Count like their long form | `ruby.ts` |
| C preprocessor (`#ifdef`) | Does **not** count; compilation, not runtime branching | `c.ts` |
| C#/Ruby `?.` and `&.` | Do **not** count; null safety, not case distinction | `csharp.ts`, `ruby.ts` |
| Bash pipes (`\|`) | Do **not** count; chaining, not branching | `bash.ts` |
| Kotlin `else if` | **Not** recognized as continuation; cognitive readings are higher | `kotlin.ts` |

<a id="bekannte-ungenauigkeiten-benannt-statt-verschwiegen"></a>

## Known inaccuracies, stated explicitly

- **Kotlin and Swift:** grammars provide no field names. `normalizedSignature` uses the first
  line rather than the header up to the body; `IdentifierFact.role` is always `reference` because
  a declaration classification would be guessed.
- **C++:** constructors have the same node kind as other methods and appear as `function`, not
  `constructor`.
- **Ruby:** no visibility (`private` is a call, not a symbol modifier) and no imports (`require`
  is an ordinary method call, appearing in `extractCalls`).
- **Bash:** no imports (`source` is a command); `set`, `return` and other built-ins appear as calls.
- **Kotlin:** `companion object` members appear flat on the class.
- **PHP:** with semicolon-form `namespace App\Billing;`, following classes are NOT nested under
  the namespace because the grammar does not nest them.
