<a id="die-eingebetteten-grammatiken--herkunft-und-lizenz"></a>

# Embedded grammars — provenance and licensing

**Why this file is maintained manually** while `THIRD_PARTY_LICENSES.md` is generated:
`pnpm third-party-licenses` reads the **production dependency tree**. Grammars are absent there:
they are `devDependencies` **inside** `@ast-grep/lang-*` packages, used to generate `src/parser.c`
and `prebuilds/*/parser.so`. Neither the generator nor `scripts/check-licenses.mjs` can see them.

**The language packages themselves do not identify them.** An `@ast-grep/lang-*` LICENSE lists
only *ast-grep* as copyright holder despite shipping another tree-sitter grammar. Relying on it
would omit the actual authors. This mapping was checked in each installed language package's
`devDependencies` block in `node_modules`, not guessed.

<a id="sprachpakete-optionale-peer-abhängigkeiten-von-untangle-codeparser-registry"></a>

## Language packages (optional peers of `@untangle-code/parser-registry`)

| Language package | Version | `package.json` license | `LICENSE` file license |
|---|---|---|---|
| `@ast-grep/lang-go` | 0.0.6 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-rust` | 0.0.7 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-java` | 0.0.7 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-csharp` | 0.0.6 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-ruby` | 0.0.7 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-php` | 0.0.7 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-kotlin` | 0.0.7 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-c` | 0.0.6 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-cpp` | 0.0.6 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-swift` | 0.0.8 | ISC | MIT (ast-grep) |
| `@ast-grep/lang-bash` | 0.0.8 | ISC | MIT (ast-grep) |

ISC and MIT are both allowed by `scripts/check-licenses.mjs` and compatible with AGPL-3.0-only.
The disagreement between `package.json` and LICENSE is a package characteristic, recorded rather
than smoothed over.

<a id="die-tatsächlich-eingebetteten-grammatiken"></a>

## Grammars actually embedded

From each language package's `devDependencies`. Every grammar is a separate work with its own
authors; its license continues to apply to shipped `parser.c` and derived `parser.so` files.

| Language package | Embedded grammar | Version | License |
|---|---|---|---|
| `@ast-grep/lang-go` | `tree-sitter-go` | 0.25.0 | MIT |
| `@ast-grep/lang-rust` | `tree-sitter-rust` | — | MIT |
| `@ast-grep/lang-java` | `tree-sitter-java` | 0.23.5 | MIT |
| `@ast-grep/lang-csharp` | `tree-sitter-c-sharp` | 0.23.1 | MIT |
| `@ast-grep/lang-ruby` | `tree-sitter-ruby` | 0.23.1 | MIT |
| `@ast-grep/lang-php` | `tree-sitter-php` | 0.24.2 | MIT |
| `@ast-grep/lang-kotlin` | `tree-sitter-kotlin` | 0.3.8 | MIT |
| `@ast-grep/lang-c` | `tree-sitter-c` | 0.24.1 | MIT |
| `@ast-grep/lang-cpp` | `tree-sitter-cpp` | 0.23.4 | MIT |
| `@ast-grep/lang-swift` | `tree-sitter-swift` | 0.7.1 | MIT |
| `@ast-grep/lang-bash` | `tree-sitter-bash` | 0.25.1 | MIT |

All eleven use **MIT**, compatible with AGPL. Checked on 2026-09-05 against the registry
(`npm view <package> license`) and installed language packages' `devDependencies`.

<a id="warum-die-sprachpakete-optionale-peer-abhängigkeiten-sind"></a>

## Why language packages are OPTIONAL peers

Together the eleven packages occupy **294 MB** (measured through
`du -sh node_modules/.pnpm/@ast-grep+lang-*`; Swift alone is 69 MB, C# 62 MB, Kotlin 42 MB).
Every package ships C source AND prebuilds for five platforms.

Normal `dependencies` would force every Untangle installation to download all eleven, even for
TypeScript-only use. As **optional peers**, users install only what they need. An absent grammar
produces `grammar_unavailable` with a named reason on first parse; callers turn that into a
skip-ledger entry (E4). No adapter pretends to have parsed.

<a id="plattformen-ohne-prebuild"></a>

## Platforms without prebuilds

Core `@ast-grep/napi` covers nine targets. **Language packages** cover only five: macOS x64,
macOS arm64, Linux x64 glibc, Linux arm64 glibc and Windows x64.

**Missing: Linux musl (Alpine), Windows arm64, Windows ia32, FreeBSD.** There, installing a
language package **silently** fails: `postinstall` catches the build error and exits 0, so npm
and pnpm report success. It becomes visible only when `napi.ts` reads `libraryPath` on first parse.

This claim is **derived from package contents**—the existing `prebuilds/` directories—not executed
on those platforms. Every measurement here ran on darwin/arm64.
