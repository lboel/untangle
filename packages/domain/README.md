# @untangle-code/domain

Untangle's contract core (WP-01). Every other package is built **in parallel against these types**:
pure types, ports, deterministic IDs, error classes and executable invariants. No I/O; only
`node:crypto` and `node:path` are allowed, never `node:fs` or networking. No dependencies on other
Untangle packages or external runtime libraries.

Normative sources: [`spec.md`](../../spec.md) (takes precedence),
[`architecture.md`](../../architecture.md), [`portfolio.md`](../../portfolio.md),
[`docs/BUILD_PLAN.md`](../../docs/BUILD_PLAN.md) §3 contract register.

> **Product complexity is the distance between intent and implementation.** The domain contracts
> keep that idea honest: a Search Journey is caller-closed only after an explicit target is
> confirmed, every derived result is marked as heuristic, and product value remains feedback-open.
> The types carry evidence and comparability boundaries; they do not manufacture a universal score.

An optional Feature Probe adds a pseudonymized feature-to-code key and two separate evidence axes:
the observed search path and the indexed static complexity of an unambiguous accepted target.
Embeddings remain retrieval representations. Missing code evidence is a discriminated state, not a
zero, and the contracts provide no combined score.

**Change rule (BUILD_PLAN §3, R7):** after wave 0, contracts may change only **additively**—new
optional fields or newly versioned types—never incompatibly. Duplicating these names locally
instead of importing domain violates the plan.

<a id="modulübersicht-alles-re-exportiert-aus-srcindexts"></a>

## Modules (all re-exported from `src/index.ts`)

| Module | Contents | Normative source |
|---|---|---|
| `versions.ts` | `SCHEMA_VERSION`, `ANALYZER_VERSION`, `PARSER_VERSION`, `CHUNKER_VERSION`, `METRICS_VERSION`, `COGNITIVE_ALGORITHM_ID`, `RISK_ALGORITHM_ID`, `DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID`, Portfolio versions (`untangle-archetype-v1`, `untangle-radar-v1`, `untangle-blueprint-v1`, `portfolio-detect-v1`, `portfolio-alias-v1`, `portfolio-domain-map-v1`, `untangle-portfolio-v1`), `TOOL_SCHEMA_VERSION`, `RESULT_SCHEMA_VERSION` — all with literal types | arch §2.3, §26.2; BUILD_PLAN §3; spec §13.7 |
| `canonical-json.ts` | `canonicalJson()` — canonical JSON serializer (sorted keys, `undefined` properties omitted, `NaN`/`Infinity`/`bigint`/cycles/non-plain objects rejected, `-0` → `0`); `CanonicalJsonError` | spec §5.7; portfolio §8.3 |
| `identity.ts` | `UNTANGLE_UUID_NAMESPACE`, `uuidv5()`, `sha256Hex()`, `hmacSha256Hex()`, `buildCorpusRevisionFingerprint()` from the complete file-ID/content-hash manifest, `normalizeRelativePath()`, `normalizeRef()`, `buildWorkspaceId`, `buildRepoId`, `buildRefId`, `buildFileId`, `buildSymbolId`, `buildChunkId`, `buildEmbeddingProfileId`, `embeddingProfileShortId` and all portfolio ID builders (`buildTechnologyId`, `buildTechRecordId`, `buildRepoProfileId`, `buildStackMatrixId`, `buildConventionId`, `buildArchetypeId`, `buildBlueprintId`, `buildRecommendationId`, `buildRadarEntryId`, `buildRuleFingerprint`) | spec §5; portfolio §5, §8.3 |
| `errors.ts` | `ERROR_CODES` (19 from spec §25.1 + 12 from portfolio §15 + 5 from extensions §6.8, one shared enum), `ErrorCode`, `UntangleError` (code/retryable/operation/context/cause, `toEnvelopeError()`), `isErrorCode`, `isUntangleError` | spec §25.1; portfolio §15; extensions §6.8; arch §22.1 |
| `types/common.ts` | `SourceRange` (lines 1-based inclusive; bytes 0-based, `endByte` exclusive), `ParseQuality`, `SupportLevel`, `ChunkKind`/`CHUNK_KINDS`, `CallConfidence`, `MetricsScope`, `ComplexityScope` | spec §7.1, §7.3, §8.2, §15.2, §16.1 |
| `types/embedding.ts` | `EmbeddingProfile` — exactly the eight required profile-ID fields | spec §5.7 |
| `types/workspace.ts` | `WorkspaceRecord`, `RepositoryRecord`, `PackageIdentity`, `RepositoryConfig`, `RefRecord`, `RefIndexStatus` | arch §10.1–10.2; spec §4.3 |
| `types/file.ts` | `FileManifestV1` | arch §10.3 |
| `types/symbol.ts` | `SymbolRecordV1`, `SymbolNodeV1`, `CallEdgeV1` | arch §10.4; spec §15.1–15.2 |
| `types/chunk.ts` | `CodeChunkPayloadV1` (snake_case, exactly as stored in Qdrant), `CodeChunkDraft` (chunker output before embedding) | spec §10.3, §8; arch §6.6 |
| `types/complexity.ts` | `ComplexitySnapshotV1`, `ComplexitySummaryV1`, `CognitiveContributionV1`, `MetricContribution` | spec §16; arch §10.5 |
| `types/search.ts` | `SearchRequestV1`, `SearchResultV1`, `RelatedFragmentV1`, `SearchResultGroupV1`, `SearchResponseV1` (profile-separated groups); **Retrieval core:** `SearchQueryV1` + `SearchFiltersV1`/`SearchComplexityFilterV1`/`SearchFindabilityFilterV1`/`SearchTimeRangeV1`, `normalizeSearchQuery()`, `ScoreBreakdownV1`/`ScoreComponentV1`/`SCORE_COMPONENT_KINDS`, `validateScoreBreakdown()`, `SearchHitV1`, `SearchHitGroupV1` with optional corpus revision, `SearchResultSetV1` | spec §13; vision §1d |
| `types/search-journey.ts` | `SearchJourneyV1` with goal, optional pseudonymized feature, attempts, Measurement Context v2 with profile-bound embedding/generation/corpus provenance, lightweight locators and navigation; `DynamicSearchComplexityV1`, target-code evidence, `DynamicProductComplexityReportV1`/cohorts/feature mappings including `featureTaggedCompleted` and `SearchJourneyStorePort` | spec §13.7; vision §1e; WP-247/WP-253 |
| `search-journey-validation.ts` | Deep closed runtime validation of persisted journey contracts through `searchJourneyValidationIssue()` and `isSearchJourneyV1()` | spec §13.7, §24; WP-247/WP-250 |
| `types/change.ts` | `ChangeEventV1`, `ChangeKind`, `DiffSummaryV1`, `AstDiffSummaryV1`, `ComplexityDeltaV1`, `MetricDeltaEntryV1`, `GraphDeltaV1`, `GraphEdgeRefV1`, `FanChangeV1`, `ImpactSummaryV1`, `RiskScoreV1`, `RiskLevel` | spec §17; arch §19 |
| `types/quality.ts` | `QualityGateResultV1`, `QualityViolationV1`, `QualityImprovementV1`, `QualityGateStatus` | spec §18 |
| `types/job.ts` | `JobEvent` union (11 events: `JobQueued` … `JobCancelled`), `JobEventBase`, `INDEX_JOB_STAGES`/`IndexJobStage`, `IndexCheckpointV1` | arch §2.2, §13.3; spec §11.1 |
| `types/envelope.ts` | `ToolResponseEnvelopeV1<T>`, `ToolWarningV1` | spec §21.2 |
| `types/artifact.ts` | `ContextArtifactConfig`, `ContextArtifactType`, `ArtifactDocument`, `ArtifactChunk`, `ArtifactLink` | spec §19; arch §20 |
| `types/portfolio.ts` | All portfolio contracts: `PortfolioProvenanceV1`, `PortfolioConfidenceV1`, `TechnologyRecordV1`, `RepositoryProfileV1`, `RepositoryHealthV1`, `LanguageShareV1`, `StackMatrixV1`/`StackMatrixEntryV1`, `ConventionV1`/`ConventionRuleV1`/`ConventionCounterexampleV1`, `ArchetypeV1`/`ArchetypeSignalV1`, `BlueprintV1` + subtypes, `BlueprintRecommendationV1`/`RecommendationComponentV1`/`BlueprintAlternativeV1`/`BlueprintRiskV1`, `TechRadarEntryV1`/`RadarTrendPointV1`, `PortfolioPointPayloadV1` (snake_case) and all tool input/result types from portfolio §14.2 | portfolio §7, §12.2, §14.2 |
| `ordering.ts` | `compareCodepoints()`, `sortByCodepoints()`, `uniqueSortedByCodepoints()`, `isSortedByCodepoints()`, `compareByKeys()` — deterministic sorting; replacement for prohibited `String#localeCompare` | BUILD_PLAN §3 (determinism) |
| `types/file-graph.ts` | `FileNodeV1`, `FileEdgeV1`, `FILE_EDGE_KINDS`, `FILE_EDGE_MECHANISMS`, `FILE_EDGE_UNRESOLVED_REASONS`, `FileEdgeResolutionV1`, `FileEdgeBoundaryV1`, `FileEdgeSiteV1`, `FileGraphMetricsV1`, `FileGraphCentralityEntryV1`, `validateFileEdge()` | spec §14; arch §16 |
| `types/symbol-graph.ts` | `SymbolEdgeV1`, `SYMBOL_EDGE_KINDS`, `SYMBOL_EDGE_RESOLUTIONS`, `SYMBOL_EDGE_UNRESOLVED_REASONS`, `GraphConfidenceV1`, `SymbolEdgeTargetV1`/`SymbolEdgeCandidateV1`/`SymbolEdgeSiteV1`, `symbolEdgeResolutionFromCallConfidence()`, `validateSymbolEdge()`, `TraversalLimitsV1`/`TraversalResultV1`/`TraversalDirection`/`TRAVERSAL_TRUNCATION_REASONS` | spec §15; arch §17 |
| `types/findability.ts` | `FindabilityV1`, `FindabilitySummaryV1`, `FindabilityDiagnosisV1`, `FINDABILITY_CAUSES`, `FindabilityProbeV1`, `FindabilityDispersionV1`, `FindabilityHopsV1`, `FindabilityEvidenceV1`, `HeuristicConfidenceV1`, `validateFindability()`, `toFindabilitySummary()`, `FindabilityUnavailableV1`, `FindabilityOutcomeV1`, `FindabilityDiagnosisBasisV1`, `makeFindabilityUnavailable()`, `assertFindabilityMeasured()`, `openFindabilityDiagnosisBasis()` | vision §1d; WP-120/121 |
| `types/skip-ledger.ts` | `SkipLedgerV1`, `SkipLedgerEntryV1`, `SKIP_REASONS`, `SKIP_STAGES`, `SKIP_SUBJECT_KINDS`, `buildSkipLedgerEntry()`, `summarizeSkipReasons()`, `validateSkipLedger()` | vision §8.4; E4 |
| `types/extensions.ts` | `ExternalNumberV1` + `makeExternalNumber()`/`isExternalNumber()`/`formatExternalNumber()`/`assertUntangleMetricNumber()`, `ExternalFindingV1`, `ExternalMeasurementV1`, `ExtensionManifestV1` + subtypes, `EXTENSION_OUTPUT_FORMATS`, `SeverityMappingV1`, `resolveNormalizedSeverity()`, `NormalizedSeverity`, `ExtensionProvenanceV1`, `validateExtensionManifest()` | extensions §3 (X3, X9), §5 |
| `analysis.ts` | `LanguageAdapter` (see decision 1), `SourceFile`, `ParseResult`, `ParsedAst` (opaque `root`), `AstRegion`, `ExtractedSymbol`, `RawImport`, `RawCall`, `ComplexityFacts` with `SymbolScopeFact`/`DecisionFact`/`NestingFact`/`TokenFact`/`NodeKindFact`/`IdentifierFact`/`LiteralFact`, `ParseDiagnostic`, `HalsteadTokens`, `ComplexityIRNode`/`IRKind`, `CoverageEntry` | arch §6.5, §6.7, §14.1, §15.1 |
| `ports.ts` | `VectorStore`, `MetadataStore`, `GraphStore`, `EmbeddingProvider`, `ParserRegistry`, `FileSystemPort`, `GitPort`, `RevisionProvider`, `LockProvider`, `Clock`, `Random`, `LoggerPort`, `CheckpointStorePort`, `ImportResolver`, `ArtifactAdapter` + all request/result types (`PayloadFilter`, `HybridQueryV1`, `GraphShardV1`, `Revision`, `LockRecordV1`, `LogEvent`, `ResolveContext`, …). All long-running methods accept `{ signal?: AbortSignal }` | arch §2.1, §7.1, §16.2, §19.1, §20, §21; spec §22 |
| `invariants.ts` | `assertWithinWorkspace()` (path sandbox), `validateCoverage()` (lossless invariant spec §8.4), `validateGenerationCompleteness()`/`assertGenerationComplete()` (Generation-Commit arch §13.4), `buildDedupeKey()` (arch §18.4) | arch §13.4, §14.1, §18.4, §23.1; spec §8.4 |

<a id="identitätsmodell--kurzreferenz"></a>

## Identity model — quick reference

```text
workspace_id          explicit OR UUIDv5("workspace" ⊕ config_hash)
repo_id               explicit OR UUIDv5("repository" ⊕ canonical_path)
ref_id                repo_id + ":" + normalized_ref          ← NOT a UUID (spec §5.3)
file_id               UUIDv5("file" ⊕ ws ⊕ repo ⊕ ref ⊕ normalized_path)
symbol_id             UUIDv5("symbol" ⊕ ws ⊕ repo ⊕ ref ⊕ path ⊕ kind ⊕ fqn ⊕ signature)
chunk_id              UUIDv5("chunk" ⊕ scope_id ⊕ chunk_kind ⊕ ordinal ⊕ chunker_version)
embedding_profile_id  SHA256(canonical_json(8 profile fields))   ← hex string, not UUID
file_edge_id          UUIDv5("file_edge" ⊕ ws ⊕ from_file ⊕ kind ⊕ raw_specifier ⊕ ordinal)
symbol_edge_id        UUIDv5("symbol_edge" ⊕ ws ⊕ from_symbol ⊕ kind ⊕ to_name ⊕ qualifier ⊕ ordinal)
findability_id        UUIDv5("findability" ⊕ ws ⊕ symbol ⊕ algorithm ⊕ ranker_version)
finding_id            UUIDv5("external_finding" ⊕ run ⊕ tool ⊕ rule ⊕ path ⊕ start_byte ⊕ ordinal)
query_fingerprint     SHA256(canonical_json({text, filters, rankerVersion}))  ← without paging
finding_match_key     "finding_match" ⊕ tool ⊕ rule ⊕ (symbol_id | path) ⊕ SHA256(message)
```

Edge identity depends **only on the source side**: improved resolution changes the outcome, not
edge identity. Neither line numbers nor resolved targets contribute.

`⊕` joins with U+001F (unit separator) and a leading kind tag; see decision 3. Line numbers are
**never** part of primary IDs (spec §5.5).

<a id="verwendung-durch-andere-packages"></a>

## Use by other packages

- **parser-registry (WP-06/WP-09)** implements `LanguageAdapter` and `ParserRegistry`.
- **chunker (WP-07)** consumes `AstRegion`, produces `CodeChunkDraft`, proves coverage through
  `validateCoverage`.
- **complexity (WP-08)** consumes `ComplexityFacts`/`ComplexityIRNode`, produces
  `ComplexitySnapshotV1` with `COGNITIVE_ALGORITHM_ID`.
- **storage-qdrant (WP-11)** implements `VectorStore`, `MetadataStore`, `GraphStore`.
- **embeddings-ollama (WP-10)** implements `EmbeddingProvider`.
- **storage-local (WP-12/WP-250)** implements `LockProvider`, `CheckpointStorePort`,
  `FileSystemPort` and `SearchJourneyStorePort`.
- **jobs (WP-13)** emits the `JobEvent` union and persists `IndexCheckpointV1`.
- **search (WP-19/WP-248/WP-249)** produces `SearchResponseV1`/`SearchResultSetV1`, normalizes with
  `normalizeSearchQuery`, deduplicates with `buildDedupeKey`, and derives task-based cohortable
  product complexity indicators and feature→code mappings from explicit Search Journeys, on
  separate search/code axes.
- **file-graph (WP-17)** produces `FileNodeV1`/`FileEdgeV1`/`FileGraphMetricsV1` through
  `buildFileEdgeId` and validates edge invariants with `validateFileEdge`.
- **symbol-graph (WP-18)** produces `SymbolNodeV1`/`SymbolEdgeV1` through `buildSymbolEdgeId`,
  traversing against `TraversalLimitsV1`/`TraversalResultV1`.
- **findability (WP-120/121)** produces `FindabilityV1` through `buildFindabilityId`.
- **extensions (WP-66 onward)** reads `ExtensionManifestV1`, produces `ExternalFindingV1` through
  `buildExternalFindingId`/`buildFindingMatchKey`.
- **change-engine (WP-21)** implements `RevisionProvider`, produces `ChangeEventV1`,
  `QualityGateResultV1`.
- **portfolio (WP-22)** produces every `types/portfolio.ts` contract through ID builders.
- **testkit (WP-04)** supplies in-memory implementations of ALL ports against exactly these interfaces.

<a id="entscheidungen"></a>

## Decisions

1. **`LanguageAdapter` belongs in domain, not parser-registry.** Architecture.md §6.5 places it
   in parser-registry. The tasked deviation allows chunker (WP-07), complexity (WP-08) and
   parser-registry (WP-06) to build concurrently without implementation-package coupling or drift.
   Parser registry **implements** the interface, not defines it. The same applies to all analysis
   data (`ComplexityFacts`, `ComplexityIRNode`, `CoverageEntry`, …).

2. **Fixed UUIDv5 namespace.** `UNTANGLE_UUID_NAMESPACE = f37509b3-6f7a-5b63-a570-f7fcc532468d`,
   derived once as `uuidv5("dev.untangle.identity", NS_DNS)` and frozen as a tested literal. It
   must never change, or every stored ID becomes invalid.

3. **U+001F joins instead of concatenation.** Spec §5 writes inputs as `a + b + c`, but naive
   concatenation is ambiguous (`"ab"+"c" == "a"+"bc"`). UUIDv5 names use
   `kind_tag ⊕ component…` with ASCII unit separator U+001F. Leading kind tags (file, symbol,
   technology, …) prevent cross-kind collisions for identical components. Components containing
   U+001F are rejected and tested.

4. **Canonical JSON is strict.** Undefined object properties are omitted, as with
   `JSON.stringify`; array `undefined`, `NaN`/`Infinity`, `bigint`, functions, symbols, non-plain
   objects such as `Date`, and cycles throw `CanonicalJsonError` rather than silently becoming
   `null`. `-0` becomes `0`: hash input must have no silent ambiguities.

5. **`RepositoryConfig` belongs in domain.** BUILD_PLAN §3 places configuration types in
   `packages/config`, but WP-01 explicitly requires this type here for scanner/workspace/portfolio
   contracts. The one definition lives here; config should **re-export**, not duplicate it. Other
   configuration types (`UntangleConfigV1`, `QdrantConfig`, …) remain in config.

6. **`SearchResponseV1` is designed here.** Spec §22 references but does not define it. Its
   profile-separated `groups`, one per `embedding_profile_id`, structurally enforce §13.4:
   cross-collection RRF scores never share one ranking. `profileSeparation` provides the required
   notice, and `timings` separates query embedding from Qdrant latency (spec §26.2).

7. **Shapes lacking normative field definitions are fixed here.** `DiffSummaryV1`,
   `AstDiffSummaryV1`, `ComplexityDeltaV1`, `GraphDeltaV1`, `ImpactSummaryV1`, `QualityViolationV1`,
   `QualityImprovementV1`, `ToolWarningV1`, fields of the 11 job event variants, `ComplexityFacts`
   fact types, `IRKind`, `AstRegion`, `ArtifactDocument`/`ArtifactChunk`/`ArtifactLink` and every
   port signature were named but unspecified. These concrete WP-01 choices are now contracts,
   changeable only additively. In particular, `MetricDeltaEntryV1` uses `null` for added/deleted
   sides rather than infinite relative deltas (spec §17.4); `ComplexityDeltaV1.epsilon` makes the
   denominator explicit.

8. **`ref_id` deliberately is not a UUID** because spec §5.3 explicitly defines string
   composition; `embedding_profile_id` and `rule_fingerprint` are SHA-256 hex strings
   (spec §5.7, portfolio §8.3).

9. **Byte-interval coverage semantics.** `SourceRange.endByte` is exclusive. Coverage checks
   complete byte intervals with overlaps allowed. Gaps use pseudo-ranges with
   `startLine/endLine = -1`, because the validator has no content to locate lines.

10. **Path sandboxing is lexical.** `assertWithinWorkspace` resolves `.`/`..` and checks
    containment, case-insensitively on Windows, case-sensitively on POSIX, with sibling-prefix
    protection. Symlink checks (arch §23.1 step 3) require `realpath` and filesystem access, an
    adapter responsibility through `FileSystemPort.realPath` plus another `assertWithinWorkspace`.

11. **`ParsedAst.root` is `unknown`.** Domain depends on neither tree-sitter nor ast-grep node
    APIs (arch §6.5); only the creating adapter interprets its root.

12. **Two tsconfigs.** `tsconfig.json` builds composite output to `dist/` without tests;
    `tsconfig.typecheck.json` uses noEmit including tests and `vitest.config.ts` for
    `pnpm run typecheck`. Composite projects disallow `noEmit` (see CONTRIBUTING.md).

13. **Complete portfolio contracts.** WP-01 does not list them individually, but BUILD_PLAN
    §3.2/§3.4 requires them here for concurrent WP-22 development. `PortfolioScanResultV1.status`
    follows portfolio §14.2 job status, not spec §11.1's index-stage machine.

14. **Result sets are `SearchResultSetV1`, not `SearchResultV1`.** The retrieval-core task used
    the latter container name, already assigned to individual hits by spec §13.6 and exported
    since wave 0. Reinterpreting it would break R7. `SearchHitV1` is the retrieval-core hit with
    full score breakdown; `SearchResultSetV1` is its container; `SearchResultV1` remains unchanged.

15. **`kind` describes relationships, resolution describes success.** An unresolved import
    remains `kind: "import"` with `resolution.status: "unresolved"` because its kind is known.
    `kind: "unresolved"` is reserved for unknown relationship kinds, which must also have
    unresolved resolution—a tested one-way implication. Raw `rawSpecifier`/`toName` survive in
    **every** state (E4).

16. **`SymbolEdgeV1` complements rather than replaces `CallEdgeV1`.** The latter (spec §15.2)
    stays unchanged; the former generalizes to `calls`/`references`/`extends`/`implements`/
    `overrides`/`unresolved`, adding resolution and confidence. `symbolEdgeResolutionFromCallConfidence()`
    is the **only** binding mapping of five `CallConfidence` levels to resolution kinds.
    `SymbolNodeV1` remains in `types/symbol.ts` without duplication.

17. **Findability is structurally heuristic, never a measurement.** `isHeuristic` is literal
    `true`, confidence has `basis: "heuristic"` (`HeuristicConfidenceV1`), so findability cannot
    occupy a measured complexity slot. Each diagnosis requires a closed-set cause, at least one
    evidence item and confidence (WP-121). No hit is a reasoned finding, not a missing value.

18. **X3 is enforced by types, not comments.** External values are `ExternalNumberV1` **objects**,
    unusable in numeric metric slots (`ComplexitySnapshotV1`, `ComplexitySummaryV1`,
    `MetricContribution`, `RiskScoreV1`). There is deliberately **no** number-unwrapping function,
    only display `formatExternalNumber()`; `assertUntangleMetricNumber()` also protects runtime
    aggregation. `ExternalFindingV1`/`ExternalMeasurementV1` require `evidenceOnly: true`.
    `@ts-expect-error` negative tests prove both directions.

19. **X9 manifests describe formats, not tools.** `ExtensionManifestV1` follows extensions §5.2
    with two X9 (§17) deviations: `outputFormat` is closed to
    `sarif | junit-xml | generic-findings | generic-metrics`, and per-tool `adapterVersion` gives
    way to `ExtensionProvenanceV1.formatParserVersion`. Additions are declarative `severityMapping`
    and `preprocess`. No tool name appears in source (E2); names belong only to user data.
    Structural JSON Schema validation belongs to `packages/config` + `schemas/` by ownership;
    domain contains only semantic couplings a schema cannot express.

20. **Shared skip ledger for E4.** `SkipLedgerEntryV1` is stage-neutral: scanner, parser,
    chunker, graphs, search and extensions write one format, letting `status`/`query` expose one
    list. `buildSkipLedgerEntry()` rejects empty reasons. WP-49 extends rather than redefines it.

21. **Search Journeys encode evidence, not a product grade.** `SearchJourneyV1` separates observed
    attempts and navigation from the derived assessment. Completion requires at least one attempt
    and an explicit target; otherwise the contract cannot claim that the destination was found.
    `DynamicSearchComplexityV1` and its cohort report carry `isHeuristic: true`. Goal and query
    fingerprints use a caller-supplied, workspace-local, domain-separated HMAC-SHA-256 key rather
    than an unkeyed content hash. Cohorts are keyed by the effective ranker, ranking context,
    result limit and candidate limit plus each profile's embedding profile, generation set and
    immutable corpus revision. `sufficientEvidence` remains false below three completed journeys.
    This makes comparable
    journeys reusable learning artifacts without confusing a retrieval sensor with product truth or
    the timeless v1 cohort report with a temporal trend view. Controlled abandonment reason codes
    are text-free lifecycle metadata; free abandonment details follow the same `retainText` gate as
    goal, query, and failed-search text. Measurement context v2 preserves those three profile-bound
    index coordinates; legacy journeys remain valid readable records but are report-incomplete and
    can never make a cohort sufficient. `sessionCounts.featureTaggedCompleted` counts only completed
    journeys with an explicit feature tag, keeping the report's feature mappings auditable. An
    explicitly selected attempt is retained additively in the completed outcome so validation can
    reconstruct its evidence exactly; legacy outcomes without that field keep last-match semantics. Search
    effort and accepted-target code complexity remain separate axes without a combined score.

22. **Corpus revision is immutable snapshot identity, not a mutable generation label.**
    `buildCorpusRevisionFingerprint()` hashes the canonical, codepoint-sorted, complete mapping from
    scanned File IDs to content hashes. Index orchestration publishes it only for a completed run,
    including a successful incremental run with zero changed files. Reusing a generation therefore
    cannot silently merge measurements from different corpus contents.


<a id="verifikation"></a>

## Verification

```bash
pnpm --filter @untangle-code/domain run typecheck   # tsc, 0 errors
pnpm --filter @untangle-code/domain run test        # vitest
pnpm --filter @untangle-code/domain run build       # emit to dist/
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
