# @untangle-code/scanner

Untangle's scanner (WP-05): recursive file discovery, ignore rules, safe symlink handling,
binary/minified/language classification, and the content-hash pipeline. An internal package
(`private: true`), consumed by the indexing pipeline (WP-13/WP-23), not directly by end users.

Normative sources: [`spec.md`](../../spec.md) §6.1–§6.3, §12.1 (takes precedence in a conflict),
[`architecture.md`](../../architecture.md) §6.4, §23.1,
[`docs/BUILD_PLAN.md`](../../docs/BUILD_PLAN.md) (WP-05).

Dependency: **only** `@untangle-code/domain` (`workspace:*`). No other Untangle packages or external
runtime dependencies (gitignore semantics are implemented locally; see decision 3).

<a id="architektur-zwei-entry-points"></a>

## Architecture: two entry points

```text
@untangle-code/scanner            pure core: reads exclusively through FileSystemPort (domain),
                                   never node:fs; testable against any port implementation
                                   (e.g. MemoryFileSystem in its own tests)

@untangle-code/scanner/node-fs    Node adapter: NodeFileSystem (FileSystemPort over node:fs/promises)
                                   and createNodeStreamingHasher (actual streaming hashing)
```

`src/index.ts` is the core's sole public export; `src/node-fs/index.ts` is a deliberately separate
second export (`package.json` `exports["./node-fs"]`). This is the exception allowed by the assignment
(“a NodeFileSystem adapter may live in this package and is exported separately”). The core therefore
remains testable without any `node:fs` dependency.

<a id="modulübersicht"></a>

## Module overview

| Module | Contents | Source |
|---|---|---|
| `types.ts` | `ScannedFileV1`, `ScanSkipV1`, `ExclusionReason`, `ScanOptions`, `IgnoreConfig`, `IgnoreDecision`, `ContentHasher`, `BinaryClassification`: scanner-local contracts, see decision 1 | WP-05 decision |
| `discovery.ts` | `discoverFiles()`: recursive discovery as `AsyncGenerator<ScannedFileV1>`, symlink sandbox, connects ignore engine + classification + hashing | spec §6.1; arch §6.4, §23.1 |
| `ignore-engine.ts` | `IgnoreEngine`/`createIgnoreEngine()`: spec §6.2 priority cascade | spec §6.2, §6.3 |
| `gitignore-pattern.ts` | locally implemented gitignore glob compiler (`compilePattern`, `compilePatterns`, `evaluateLayer`) | spec §6.2 |
| `binary-classifier.ts` | `classifyBinarySample()` (NUL bytes/control-byte ratio/BOM), `detectMinified()` (line length/line-to-byte ratio) | spec §6.1 |
| `language-classifier.ts` | `detectLanguage()`: extension map + shebang/marker content sample for extensionless files | spec §6.1, §7.2 |
| `hashing.ts` | `hashBytes()`, `createPortContentHasher()`: raw-content SHA-256 as the sole source of unchanged detection | spec §12.1 |
| `semaphore.ts` | `Semaphore`: simple locally implemented counting semaphore | WP-05 assignment |
| `concurrency.ts` | `mapConcurrent()`: bounded parallel mapping over an (Async-)Iterable, with AbortSignal support | arch §13.1–§13.2 |
| `port-options.ts` | `portOptions()`: helper for `exactOptionalPropertyTypes` when forwarding `AbortSignal` | internal |
| `node-fs/node-file-system.ts` | `NodeFileSystem`: `FileSystemPort` adapter over `node:fs/promises` | arch §2.1 |
| `node-fs/node-streaming-hasher.ts` | `createNodeStreamingHasher()`: SHA-256 directly from `fs.createReadStream`, without a full read | spec §12.1 |
| `testing/memory-file-system.ts` | `MemoryFileSystem`: in-memory `FileSystemPort` for tests (not publicly exported) | test infrastructure |

<a id="verwendung"></a>

## Usage

```ts
import { discoverFiles } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

const fs = new NodeFileSystem();
for await (const file of discoverFiles({
  fs,
  roots: ["/abs/path/to/workspace"],
  repoRoot: "/abs/path/to/workspace/repo",
  ignore: { configInclude: repoConfig.include, configExclude: repoConfig.exclude },
})) {
  // file: ScannedFileV1 { relativePath, absolutePath, sizeBytes, mtimeEpochMs,
  //                       contentHash, languageId, languageDetectedBy, isMinified,
  //                       encoding, hasBom }
}
```

<a id="entscheidungen"></a>

## Decisions

1. **`ScannedFileV1` (formerly `FileSnapshotV1`) is fixed here, not a domain contract; its name
   deliberately no longer says “FileSnapshot”.** Background: architecture.md §6.1 lists
   `FileSnapshot` among domain entities. The scanner's former `FileSnapshotV1` name therefore
   suggested that exact domain contract, while its own doc comment claimed otherwise: a
   contradiction between the name and comment on one type. Resolution, checked against the actual
   normative sources:
   - The **contract register** in `docs/BUILD_PLAN.md` §3, whose heading identifies it as the
     exhaustive list of what “MUST reside in `packages/domain`”, registers `FileManifestV1` for
     file state under §3.3 “Core data contracts”, but **no** raw pre-analysis scan output.
     `FileSnapshot`/`FileSnapshotV1` never appears there.
   - architecture.md §10 (“Data model”) likewise defines **no** `FileSnapshot` interface, only
     `FileManifestV1` (§10.3, identical to the existing `packages/domain/src/types/file.ts`,
     including architecture.md §2.3 version fields `parserVersion`, `chunkerVersion`,
     `generationId`). This suggests that §6.1 uses `FileSnapshot` as an informal/earlier name for
     that concept, not a second independent domain contract alongside `FileManifestV1`.
   - The type here is also semantically different from `FileManifestV1`: it is the **raw scan
     candidate before parsing/chunking** (including `absolutePath`, `mtimeEpochMs` as a pure change
     hint). It cannot meaningfully carry architecture.md §2.3 version fields:
     `parserVersion`/`chunkerVersion`/`generationId` exist only after parsing and chunking.
     Enforcing placeholder values here would be semantically wrong, not a genuine implementation
     of §2.3.
   - **Decision:** keep the type in `packages/scanner` (no move to domain: no missing domain
     contract needs adding), but rename `FileSnapshotV1` to `ScannedFileV1`. The name must no longer
     imply a domain contract that neither the register nor architecture.md §10 defines for this
     shape. The shape remains an additively extensible WP-05 decision (see BUILD_PLAN R7) in
     `src/types.ts`. Downstream packages (parser-registry, chunker) import it from
     `@untangle-code/scanner`, not domain.

2. **Split the spec §6.3 list across two priority levels.** spec §6.2 names “security and system
   exclusions” (level 1, never overridable) and “default exclusions” (level 5, overridable) as
   *separate* levels, while §6.3 supplies one shared list without assigning levels. Resolution:
   `.git`, `.svn`, `.hg` (VCS *system* directories: raw data, potentially secrets in history, never
   useful to index) form the non-overridable security/system level. The rest of §6.3 (`node_modules`,
   `vendor`, `dist`, `build`, caches, virtual environments, …) forms the overridable default level.
   §6.3 “generated assets” is concretized as `**/*.min.js`, `**/*.min.css`, `**/*.map` (the wording is
   otherwise unspecified).

3. **Gitignore semantics are implemented locally** (`gitignore-pattern.ts`), without the `ignore`
   library. The multi-source priority cascade in spec §6.2 (5 sources with a fixed order, plus the
   special rule that includes may override *only* default exclusions) needs more control over layer
   composition than a single `.gitignore` parser provides. Supported: negation (`!pattern`),
   directory patterns (`pattern/`), root anchors (`/pattern`), `**`, `*`, `?`, `[...]` character
   classes; “last match wins” per layer, as in git.

4. **Priority model: layers act only when they have an opinion.** Implemented as a cascade from
   lowest to highest priority (Default → special Config-Include rule → `.gitignore` →
   `.untangleignore` → Config-Exclude → Security). A level overrides the current decision only if
   *some* pattern in that level actually matches; otherwise the lower-level decision stands. This
   implements spec §6.2 exactly without reproducing git's tree-wide renegotiation. An important
   consequence, also true for real `.gitignore`: an individual file within an excluded directory
   cannot be re-included without reopening the directory itself through a directory pattern, e.g.
   `"dist/"`. The special Config-Include rule from spec §6.2 item 6 additionally overrides
   *exclusively* the default level, never `.gitignore`/`.untangleignore`/Config-Exclude, exactly as
   the specification states.

5. **Nested `.gitignore`/`.untangleignore` files are supported**, not just root files.
   `IgnoreEngine.pushGitignoreLayer`/`popGitignoreLayer` (and the `untangleignore` counterparts)
   form a stack maintained by `discovery.ts` while descending/ascending the directory tree.
   Deeper files are pushed later, winning pattern conflicts (git's “closer file wins”). The
   simplification relative to git: no separate tree-wide renegotiation when a parent directory is
   already excluded (see decision 4). This is sufficient for the specification's practical cases
   (ignore priority, negation, default exclusions) and covered by tests.

6. **Symlink cycle detection uses globally visited real paths**, not just the active ancestor
   chain, exactly as assigned (“cycle detection through visited real paths”). Every directory
   reached through a symlink *or* normal traversal is added permanently to `visitedRealDirs` on
   entry, never removed. A second symlink to the same already visited real path is skipped as
   `symlink-cycle`. This guarantees termination with a single global `Set` check, without extra
   `realpath` calls for ordinary non-symlink directories. Deliberate, documented, tested side
   effect: two *independent* symlinks to one shared target directory are scanned only the first
   time; the second is treated like a cycle (deduplication). This is acceptable for codebase
   discovery, where duplicate indexed content is undesirable anyway.

7. **`FileSystemPort.realPath` is also applied to `roots` themselves**, not only symlink targets
   encountered during the walk. A workspace root may itself contain an unresolved symlink segment
   (e.g. macOS `/var` → `/private/var`, `/tmp` → `/private/tmp`). Without resolution,
   `assertWithinWorkspace` would compare a realpath-resolved candidate against an *unresolved*
   root and falsely report an escape. An integration test on the real filesystem
   (`node-fs/discovery.integration.test.ts`) covers precisely this case.

8. **Streaming hashing is a Node adapter capability, not a core feature.** The domain
   `FileSystemPort.readFile` supplies only full reads (`Uint8Array`), no range/stream API; true
   streaming therefore cannot be built against the abstract port. The core hashes the buffer
   already read for the binary/minified/language sample (`createPortContentHasher`, one read per
   file, capped by the size limit). `createNodeStreamingHasher()` (from `./node-fs`) instead hashes
   directly from `fs.createReadStream`, never holding the entire file in memory. This is the
   assigned “streaming hashing for large files” capability, usable as an interchangeable
   `ContentHasher` through `ScanOptions.hasher`.

9. **The size limit applies strictly before a full read.** `processCandidate` calls `fs.stat()`
   and compares `sizeBytes` to `maxFileSizeBytes` before any `fs.readFile()`. A test
   (`discovery.test.ts`, “rejects an oversized file via stat, without ever calling readFile”)
   proves this through a `FileSystemPort` that logs every `readFile` call.

10. **Binary classification counts only actual control bytes as “non-printable”**, not the entire
    `0x80`–`0xFF` byte band. Otherwise every UTF-8 non-ASCII source file (umlauts, CJK, emoji in
    comments/strings) would falsely be classified as binary. Tab (`0x09`), LF (`0x0A`), and CR
    (`0x0D`) are excluded from the control-byte count.

11. **BOM-detected UTF-16 bodies are classified after decoding, not byte by byte.** Fixed defect:
    `classifyBinarySample` detected a UTF-16 BOM (LE/BE) and reported the encoding correctly, then
    still applied the raw “NUL byte ⇒ binary” rule to UTF-16 bytes. A `0x00` byte is normal for each
    ASCII/BMP character (e.g. `[0xff,0xfe,0x61,0x00, 0x62,0x00]`, text file “ab”, was rejected as
    binary, violating E4). Fix: `classifyUtf16Body` decodes with
    `TextDecoder("utf-16le"|"utf-16be", {fatal:false})` and checks actual characters (code point
    `=== 0` or actual control characters `< 0x100`) rather than raw bytes. A `0x00` half of an ASCII
    encoding no longer counts as NUL; actual concentrations of NUL/control characters still do.
    `binary-classifier.test.ts` covers both directions (legitimate UTF-16 text stays
    `isBinary:false`; real embedded NUL or a high control-character ratio stays `isBinary:true`).

    Correction (wave 2, see item 12): an adversarial reviewer disproved this item's original “no
    fix needed” assessment for BOM-less UTF-16 detection. Real BOM-less UTF-16LE/UTF-16BE prose
    triggered the same raw “NUL byte ⇒ binary” rule as the fixed BOM case above and silently
    disappeared from the index (E4 violation). This false negative outweighs a heuristic's false
    positive risk; see item 12 for the fix. CRLF and lone CR already worked before this fix
    (Tab/LF/CR are explicitly excluded from control-byte counting; see item 10 and
    `it("tolerates tabs, LF and CR …")`). UTF-32 deliberately remains outside this fix (see item 12
    and “Known limits”). A latent consequence of missing UTF-32 support is documented in the code
    (`BOM_SPECS` comment in `binary-classifier.ts`): a UTF-32LE BOM (`FF FE 00 00 …`) still matches
    the 2-byte UTF-16LE prefix and is misinterpreted as `"utf16le"` with a 2-byte BOM length. The
    resulting body reliably decodes to real NUL characters (each UTF-32 code unit contributes two
    extra `0x00` bytes), so the sample still becomes `isBinary:true` (existing behavior, not a
    regression from this fix).

12. **BOM-less UTF-16 detection uses alternating NUL bytes plus printability validation.** Fixed
    defect (wave 2): `classifyBinarySample` recognized UTF-16 text only with a BOM. Without one,
    `detectBom` returned `hasBom:false`; code fell back to the raw byte loop, saw every second byte
    as `0x00` (one half of every 16-bit Basic-Latin code unit), and falsely classified plain BOM-less
    UTF-16LE/UTF-16BE prose as binary. An E4 violation (real source silently disappears from the
    index), demonstrated by an adversarial reviewer with an independent reproduction against
    `dist/binary-classifier.js` (`"Hello, world! This is a normal UTF-16 text file..."` in BOM-less
    UTF-16LE and UTF-16BE, both `{ isBinary: true, encoding: "unknown" }` before the fix).

    Fix: `detectUtf16WithoutBom` (new in `binary-classifier.ts`) recognizes BOM-less UTF-16
    candidates through **two** gates, **both** required. It is deliberately conservative to avoid
    the false positive risk named in this item's earlier version:
    - **Gate 1 (pattern):** from a minimum sample size of **32 bytes** (`UTF16_HEURISTIC_MIN_
      SAMPLE_BYTES`, 16 code units), the NUL-byte rate is calculated across all byte pairs for
      each parity (even vs. odd positions). One side must regularly reach **≥ 60%**
      (`UTF16_HEURISTIC_DOMINANT_NULL_RATIO`), the typical Basic-Latin signature in 16-bit units,
      while the opposite parity must stay **≤ 10%** (`UTF16_HEURISTIC_OPPOSITE_NULL_RATIO`). Only
      then is a candidate encoding set (LE when NULs dominate odd positions, BE at even positions).
    - **Gate 2 (validation):** only after gate 1 supplies a candidate is the sample decoded using
      that encoding via `TextDecoder(..., {fatal:false})`. **≥ 90%**
      (`UTF16_HEURISTIC_MIN_PRINTABLE_RATIO`) of resulting code units must be printable (NUL,
      actual control characters `< 0x100`, and decoding-error marker `U+FFFD` are not printable).
      This gate rejects a genuine binary file whose bytes happen to satisfy gate 1's parity pattern.

    Only when **both** gates pass is the sample treated as UTF-16 text. `classifyBinarySample` then
    uses the same `classifyUtf16Body` classification as the BOM case (`hasBom:false`, `encoding`
    set to `"utf16le"`/`"utf16be"` rather than `"unknown"`, allowing downstream stages to decode
    correctly). An actual embedded NUL or high control-character ratio therefore still produces
    `isBinary:true`, exactly as in item 11's BOM case. Below the 32-byte minimum sample size,
    existing conservative behavior (binary when in doubt) remains unchanged: parity rates are not
    statistically reliable for very short samples.

    `binary-classifier.test.ts` covers the reviewer's exact case (BOM-less UTF-16LE and UTF-16BE,
    `isBinary:false`, correct `encoding`), an actual embedded NUL in the BOM-less case (still
    `isBinary:true`), three false-positive cases with realistic binary profiles (PNG header, ELF
    header, high-entropy/quasi-random data representing compressed/encrypted content; none
    misclassified as UTF-16), and a very short BOM-less UTF-16LE sample below the 32-byte threshold
    (still `isBinary:true`, documented existing behavior).

    Same error class, not fixed (see “Known limits”): **UTF-32** (LE/BE) has structurally the same
    problem, with *three* of each Basic-Latin code unit's four bytes being `0x00`. The raw loop
    would likewise falsely reject BOM-less UTF-32 text as binary. `TextEncodingGuess` has no
    `"utf32le"`/`"utf32be"` values at all (see item 11 and the `BOM_SPECS` comment in
    `binary-classifier.ts`). Supporting UTF-32 (with and without BOM) is a separate, unassigned
    extension of the `TextEncodingGuess` contract, not an extension of the heuristic built here.

13. **Two tsconfigs**, as in domain: `tsconfig.json` (composite, emit to `dist/`, no tests) for the
    build; `tsconfig.typecheck.json` (noEmit, includes tests) for `pnpm run typecheck`. Composite
    projects do not permit `noEmit`.

<a id="verifikation"></a>

## Verification

```bash
pnpm --filter @untangle-code/scanner run typecheck   # tsc, 0 errors (core + node-fs + tests)
pnpm --filter @untangle-code/scanner run test        # vitest, 109 passing tests
pnpm --filter @untangle-code/scanner run build       # emit to dist/, 0 errors
```

Actually executed (see `verification` in the task report): `npx tsc --noEmit -p
tsconfig.typecheck.json` (0 errors), `npx tsc -p tsconfig.json` (0 errors), `npx vitest run
--reporter=verbose` (109/109 passing, 11 test files, including 24 tests in
`binary-classifier.test.ts`), plus the reviewer's exact reproduction rerun against freshly built
`dist/binary-classifier.js`. Both formerly failing cases now return `isBinary:false` with correct
`encoding`.

<a id="bekannte-grenzen-siehe-openissues-im-task-report"></a>

## Known limits (see `openIssues` in the task report)

- No per-file configuration of `.gitignore`/`.untangleignore` filenames is wired beyond
  `RepositoryConfig`. `IgnoreConfig.gitIgnoreFileName`/`untangleIgnoreFileName` exist but are not yet
  populated from `RepositoryConfig` (caller/WP-13 responsibility).
- `MemoryFileSystem` (test infrastructure only) does not resolve symlinks in *non-terminal* path
  segments (e.g. `/repo/link/deep/file.ts`, where `link` is the symlink). This suffices for its tests,
  where symlinks are always resolved directly through their own path; documented in the file header.
- UTF-32 is not detected (no `TextEncodingGuess` value or `BOM_SPECS` entry). spec.md/architecture.md
  do not require it, so no new implementation without a concrete assignment. A UTF-32LE BOM still
  matches the shorter UTF-16LE prefix and is misinterpreted as `"utf16le"`, but the decoded body
  reliably contains actual NULs (two extra `0x00` bytes per UTF-32 code unit), so the sample still
  correctly reports `isBinary:true`. Existing behavior, documented rather than hidden (see the
  `BOM_SPECS` comment in `binary-classifier.ts` and decision 11). **The same error class as the
  BOM-less UTF-16 defect fixed in decision 12 also affects BOM-less UTF-32 text** (3 of 4 bytes per
  code unit would be `0x00`). Checked during decision 12 but deliberately not fixed alongside it:
  `TextEncodingGuess` does not know UTF-32 at all; UTF-32 support would be a separate contract
  extension, not an expansion of the existing heuristic.

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
