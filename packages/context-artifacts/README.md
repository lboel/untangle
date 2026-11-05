# @untangle-code/context-artifacts

Untangle context-artifact adapters: Markdown/ADR, SQL schema, OpenAPI, AsyncAPI, Protobuf,
Terraform/HCL, Kubernetes YAML, Docker/Compose, and a safe text fallback behind an
`ArtifactAdapter` registry (WP-15, spec.md §19, architecture.md §20). Internal, private package;
not published to npm.

Normative sources: [`spec.md`](../../spec.md) §19 (takes precedence in a conflict),
[`architecture.md`](../../architecture.md) §20, [`product.md`](../../product.md) §8.6.

Runtime dependencies: `@untangle-code/domain` (types/ports) and `@untangle-code/observability`
(typed errors). No network or filesystem access: files arrive already read through
`ArtifactInput.files`. spec.md §19 deliberately separates “how an artifact is read” from “how its
content is structured”; reading directories/files according to `ContextArtifactConfig.include`/
`exclude` is the indexer pipeline's responsibility, not this package's. No external YAML/JSON
library; see decision 1.

<a id="was-dieses-package-tut"></a>

## What this package does

`createArtifactAdapterRegistry()` (the sole main entry point alongside individual `create*Adapter()`
factories; see `src/index.ts`) returns an `ArtifactAdapter` (architecture.md §20:
`supports`/`read`/`chunk`/`links`) that dispatches to the appropriate format implementation:

```text
createOpenApiAdapter()     — openapi.ts     — one section per operation, preserves operationId
createAsyncApiAdapter()    — asyncapi.ts    — one section per channel operation
createDockerAdapter()      — docker.ts      — Dockerfile stages, Compose services
createKubernetesAdapter()  — kubernetes.ts  — one resource per YAML document
createMarkdownAdapter()    — markdown.ts    — sections by heading, with breadcrumb
createSqlAdapter()         — sql.ts         — tables/views/indexes/constraints
createProtobufAdapter()    — protobuf.ts    — messages/services/RPCs
createTerraformAdapter()   — terraform.ts   — resources/modules/variables/outputs
createTextFallbackAdapter()— text.ts        — fixed line-window fallback (catch-all)
```

Every adapter chunks by **semantic sections**, not fixed line windows (spec.md §19.2 SHOULD), except
the text fallback, whose purpose is precisely fixed line windows. Each chunk carries a byte-exact
`SourceRange` (`text/line-index.ts`) and exact raw content, never a summary or reformatting
(spec.md §19.2).

This package also exports (see “Decisions” below for the reasoning):

- `validateArtifactConfigs()`: project-wide name uniqueness (spec.md §19.2).
- `computeArtifactStalenessSnapshot()` / `isArtifactStale()`: configuration hash + content hash
  (spec.md §19.2).
- `buildArtifactSkipLedger()`: a Skip Ledger with reasons for byte ranges not included in a chunk
  AND for fragments cut through a construct (BUILD_PLAN §12 E4, see decision 10).
- `findDelimiterImbalances()` / `describeDelimiterImbalances()` (`text/delimiter-balance.ts`): the
  plausibility check itself, reusable for custom additional adapters.
- `parseYamlNode()`/`splitYamlDocuments()` (`text/yaml-lite.ts`): the internally used YAML-subset
  parser, reusable for custom additional adapters.

<a id="modulübersicht"></a>

## Module overview

| Module | Contents |
|---|---|
| `registry.ts` | `ArtifactAdapterRegistry`, `createArtifactAdapterRegistry()`: dispatch + text fallback |
| `adapters/*.ts` | one `ArtifactAdapter` per format, each with its own golden test |
| `adapters/shared.ts` | `buildDocuments()`, `buildChunks()`, `wholeDocumentDraft()`: shared building blocks |
| `text/line-index.ts` | `LineIndex`, `rangeForLines()`, `sliceLines()`: byte-exact `SourceRange`s from line spans |
| `text/yaml-lite.ts` | minimal YAML-subset parser (block mappings/sequences, single-line flow, `\|`/`>`, `---`) |
| `ids.ts` | `buildArtifactChunkId()`: deterministic `chunkId` derivation |
| `config-validation.ts` | `validateArtifactConfigs()` |
| `staleness.ts` | `computeArtifactStalenessSnapshot()`, `isArtifactStale()` |
| `text/delimiter-balance.ts` | `findDelimiterImbalances()`: plausibility checks for cut fragments (WP-118) |
| `coverage.ts` | `buildArtifactSkipLedger()`, `ChunkPlausibilityCheck` |

`src/index.ts` is the sole public export (rule 10).

<a id="entscheidungen"></a>

## Decisions

Where spec.md/architecture.md leave a question open, or where the `ArtifactAdapter` contract in
`@untangle-code/domain` (another package, not editable) is narrower than this assignment, the
following decisions apply:

1. **No external YAML/JSON library: `text/yaml-lite.ts` is a locally written subset parser.** This
   package may write only within `packages/context-artifacts/**`; any new npm dependency would
   require editing root `pnpm-lock.yaml`, potentially modified simultaneously by six agents in the
   same wave. The local parser covers precisely the constructs OpenAPI/AsyncAPI/Kubernetes/Compose
   documents use in practice: indentation-based block mappings/sequences, single-line flow
   collections (`{a: 1}`, `[a, b]`), scalars (plain/'/"), `\|`/`>` block scalars, `#` comments,
   `---`/`...` document separators. NOT supported: anchors/aliases, tags, multiline flow, complex
   non-scalar mapping keys. Documents requiring these degrade visibly (`YamlParseError` →
   `"*_parse_error"` chunk with full raw content, never a crash). This limit is deliberate; see
   `openIssues` for the recommendation to replace it with a full library if needed, once a package
   outside the current parallel wave may edit `pnpm-lock.yaml`.

2. **`ContextArtifactType` (spec.md §19.1, `@untangle-code/domain`, not editable) lacks
   `"docker"`/`"compose"` literals, although architecture.md §20 explicitly requires a
   Docker/Compose adapter.** Documents from `docker.ts` therefore carry `type: "text"` (the
   closest fit in the frozen contract); `language: "dockerfile"` or `"docker-compose"` (an existing
   general optional field) carries the actual subtype. `supports()` recognizes Dockerfile/Compose
   filenames for both `type === "auto"` and `type === "text"`. The latter matters because `"text"`
   is the only literal available for explicitly configuring such an artifact. `type: "text"` on
   a file named `Dockerfile` must still receive actual stage chunking rather than mere line-window
   degradation, while generic `type: "text"` on `notes.txt` still reaches the text fallback
   (neither filename regex matches). See `openIssues`: spec.md §19.1 should add
   `"docker"`/`"compose"`.

3. **Registry `chunk()`/`links()` dispatch reuses `adapter.supports(document.type, document.path)`
   rather than introducing another identity mechanism.** Every `ArtifactDocument.type` other than
   `"text"` already is the exact literal checked by its adapter (`"sql"`, `"openapi"`, …), so reuse
   works without extra machinery. An adapter identity field on `ArtifactDocument` would require
   extending the other package's frozen `domain` contract. A custom additional adapter
   (`registry.register(...)`) that also produces `type: "text"` therefore MUST handle `"text"`
   alongside `"auto"` in its own `supports()`, so it is rediscovered after reading. Documented in
   `registry.ts` and covered by a dedicated test (`registry.test.ts`).

4. **The Skip Ledger (`buildArtifactSkipLedger()`) is a derived utility in this package, not a
   field on `ArtifactChunk`/`ArtifactAdapter`.** BUILD_PLAN §12 E4 requires skipped content never to
   disappear silently, but the `ArtifactAdapter` contract (architecture.md §20, `domain`, not
   editable) has no ledger field. `chunk()` therefore keeps the exact contract (`ArtifactChunk[]`).
   `buildArtifactSkipLedger(document, chunks)` subsequently derives every uncovered byte range
   from returned chunk ranges and classifies it (`"whitespace_or_comment"` vs.
   `"unclassified_content"`), allowing callers (indexer/CLI) to log it. The text fallback always
   has an empty ledger (full coverage by construction); for Terraform, for example, gaps consisting
   of comments/blank lines between blocks are expected and marked accordingly, not as errors.

5. **`ArtifactChunk.chunkId` has no spec.md §5 derivation formula** (§5 defines `chunk_id` only for
   code chunks). `ids.ts::buildArtifactChunkId()` mirrors `domain.buildChunkId` (UUIDv5 under the
   Untangle namespace, kind-tagged components separated by U+001F: artifact name, document path,
   semantic kind string, ordinal). Deterministic for identical inputs, collision-free across
   artifacts/documents/kinds.

6. **Markdown sections form a FLAT partition, not a nested one.** A heading section ends at the
   next heading of ANY level, not only one `<=` its own level. Otherwise an H1 section would consume
   all content until the next H1 and overlap its own subsections. Hierarchy remains fully visible:
   `title` carries the breadcrumb (`"H1 › H2 › H3"`), while `content` remains exact raw section text.

7. **Protobuf `service`/`rpc` chunks overlap DELIBERATELY** (a `protobuf_rpc` chunk lies wholly
   inside its `protobuf_service` chunk's range), the package's sole deliberate exception to “flat,
   non-overlapping partition”. Searching for an exact RPC name should find the narrow RPC chunk;
   searching for service-wide options/comments should still find the full service context.
   `buildArtifactSkipLedger()` merges overlapping ranges before finding gaps, avoiding false gaps
   (see `coverage.test.ts`).

8. **SQL statement boundaries are byte-exact, not line-based.** Two statements on one physical
   line (`CREATE TABLE a (id int); CREATE TABLE b (id int);`) receive separate, non-overlapping
   byte ranges. Only when nothing substantive follows `;` on the same line does the closed
   statement take the rest of that line (whitespace, an appended `--` comment, newline).

9. **SQL dialect is selected, not guessed; default `"backslash-escapes"` (WP-118).** Dialects
   conflict: in standard SQL, `\` in a literal is ordinary; common extensions let `\'` escape a
   quote (alongside `` ` `` identifiers and `#` line comments). The dialect cannot be read from
   the file, so the caller selects it: `createSqlAdapter({ dialect })` with
   `SqlDialect = "backslash-escapes" | "doubled-quotes-only"`, default `DEFAULT_SQL_DIALECT`.

   Default rationale (asymmetric error costs for a SPLITTER): the expensive error is a cut THROUGH
   a statement, producing two syntactically broken chunks. The cheaper error is cutting too late:
   two statements in one chunk that still contains valid SQL. Reading `\'` as an escape can only
   affect a literal ending in `\` directly before its closing delimiter (rare, and the plausibility
   check reports it). NOT reading `\'` as an escape tears apart every literal containing `\'`
   followed by `;`: the reported defect, common in dumps. Across dialects, the splitter also
   recognizes `$tag$` literals, where `;` is equally common.

10. **Cut-boundary plausibility checks (`text/delimiter-balance.ts`, WP-118): E4 also applies when
    nothing is MISSING but something is CUT INCORRECTLY.** `buildArtifactSkipLedger()` calculated
    byte coverage and was therefore blind to a fragment cut through a string, comment, heredoc,
    or bracketed construct: coverage complete, no empty/overlapping chunks, ledger zero. The
    ledger now accepts a format-specific check
    (`buildArtifactSkipLedger(document, chunks, { checkPlausibility })`) and reports each flagged
    fragment with reason `"implausible_fragment"`. Adapters supply their check through
    `buildChunksReportingSkips`, so callers do not have to remember it.

    The checker may be **more suspicious** than the splitter: a false alarm costs one warning
    line; an undisclosed bad cut costs an unusable chunk. SQL checks therefore recognize backtick
    identifiers in both dialects, making an incorrect dialect selection visible rather than silent.

    Review of the remaining adapters for the same blind spot:

    | Adapter | Finding | Action |
    |---|---|---|
    | `sql.ts` | trigger: `\'` and `$tag$` tore statements apart | dialect + check |
    | `terraform.ts` | `{` inside a heredoc permanently shifted the bracket counter; an unclosed block “ran to end of file” and consumed later blocks, both without ledger entries | account for heredocs in counter; check |
    | `protobuf.ts` | `rpc … {` ended at the first `;` in its options body; an unclosed block “ran to end of file” | bracket depth in `findRpcEnd`; check |
    | `markdown.ts` | unaffected: `findHeadings` recognizes code fences; a heading within a fence does not split | none |
    | `docker.ts` | unaffected: `HEREDOC_OPEN_RE` already exists; `FROM` is recognized only on complete lines | none |
    | `openapi.ts`, `asyncapi.ts`, `kubernetes.ts` | unaffected: they delegate splitting to `text/yaml-lite.ts`, which degrades visibly with `YamlParseError` on unreadable input | none |
    | `text.ts` | unaffected: fixed line windows, full coverage by construction | none |

<a id="bekannte-grenzen--offene-punkte"></a>

## Known limits / open issues

- The plausibility check is a **delimiter checker, not a parser**. It detects “cut through a
  construct”, not “semantically incomplete”: a fragment such as `FROM orders WHERE` is balanced
  and passes. A bad cut also goes undetected if both halves happen to be balanced, e.g. a `#`
  comment containing `;` read under `dialect: "doubled-quotes-only"`.
- The SQL splitter recognizes `$tag$` literals but not dialect-specific forms such as `DELIMITER`
  switches in scripts.
- `terraform.ts` still recognizes two block openings on ONE physical line only once (see module
  comment). Nothing is lost; the second block simply receives neither its own chunk nor title.

For further points, see `openIssues` in this work unit's final report.

<a id="e4-ehrlichkeitspruefung-wp-165"></a>

## E4 honesty checks (WP-165)

`src/honesty.test.ts` runs `assertHonestUnderDamage` from `@untangle-code/testkit` against the full
`read()` → `chunk()` path through registry dispatch order, for four formats (Markdown, SQL,
Kubernetes YAML, OpenAPI). Because `read()` accepts `PortCallOptions`, cancellation damage really
applies here, unlike the chunker and language adapters. All six damage types run; none is exempted.

Two things are checked: (1) how much of the document appears NEITHER in a chunk NOR in a ledger
entry actually reported through `onSkipLedgerGap` (zero when healthy); (2) whether chunks themselves
are truthful (`content` byte-exact for their own `range`, matching `contentHash`, no empty/inverted
range).

**Result: all four formats pass.** Cancellation is reported loudly as `JOB_CANCELLED`, not swallowed.

**Lesson (also documented in testkit):** projection must target UNREPORTED loss, not loss itself.
A gap properly written to the ledger satisfies E4; its size legitimately shrinks with a shorter
document. Comparing that size creates a false alarm for every size damage.

<a id="bekannte-grenzen-e4"></a>

### Known limits (E4)

- **The OpenAPI adapter leaves the version line and structural keys unclaimed.** In a healthy
  OpenAPI document, `openapi: 3.0.3`, the `info:` line itself, and path/method lines (`paths:`,
  `/invoices:`, `get:`) stay outside every chunk and appear as `unclassified_content` in the Skip
  Ledger. E4-compliant (reported, not silent), but unsatisfactory in content: the API version is
  never searchable. Not fixed in WP-165, because this shifts chunk boundaries and golden files
  for several adapters; that requires a separate assignment with golden review.

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
