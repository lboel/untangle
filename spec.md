# Untangle — Product and Technical Specification

**Status:** Draft 0.1  
**Normative revision:** `spec-v1`  
**Product:** Untangle  
**Purpose:** Binding functional and non-functional requirements.  
**Related documents:** [`vision.md`](./vision.md) · [`product.md`](./product.md) · [`architecture.md`](./architecture.md)

---

<a id="1-normative-sprache"></a>

## 1. Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are normative:

- **MUST / MUST NOT:** mandatory for conformance;
- **SHOULD / SHOULD NOT:** the recommended default; deviations require a documented reason;
- **MAY:** an optional capability.

An implementation conforms to `spec-v1` only when all requirements marked MUST are met and the contract tests pass.

---

<a id="2-produktidentität-und-distribution"></a>

## 2. Product identity and distribution

<a id="21-namen"></a>

### 2.1 Names

| Element | Value |
|---|---|
| Product brand | `Untangle` |
| CLI binary | `untangle` |
| MCP server name | `untangle` |
| Main configuration | `.untangle.json` |
| Ignore file | `.untangleignore` |
| Local state directory | `.untangle/` or an OS-specific data directory |
| Provisional npm scope | `@untangle-code` |

The unscoped `untangle` package is not a prerequisite. Official npm packages MUST be published under a scope until the unscoped name is legally and technically available.

<a id="22-npm-pakete"></a>

### 2.2 npm packages

The following public packages are planned for version 1:

```text
@untangle-code/cli
@untangle-code/core
@untangle-code/config
@untangle-code/plugin-sdk
@untangle-code/testkit
@untangle-code/storage-lancedb
```

`@untangle-code/cli` MUST export the `untangle` binary and contain the MCP runtime.

### 2.3 Runtime

- CLI and MCP MUST run on Node.js `^22.13.0 || >=24.0.0`. Development and CI use the current patched Node 22 line; Node 23 is unsupported because of the engine contract of the locked ESLint dependencies.
- Packages MUST support ESM.
- Public library packages SHOULD ship TypeScript declaration files.
- The CLI MUST support Linux, macOS and Windows.
- Docker MUST be optional. The default local storage backend is embedded LanceDB; external Qdrant and Ollama endpoints remain supported.

<a id="24-plugin-distribution"></a>

### 2.4 Plugin distribution

Official plugins MUST use the same engine as the npm CLI. A plugin MUST NOT contain a divergent copy of the indexer, search, graph or complexity engine.

Every plugin MUST declare:

```json
{
  "enginePackage": "@untangle-code/cli",
  "engineRange": ">=0.1.0 <0.2.0",
  "toolSchemaVersion": 1,
  "resultSchemaVersion": 1
}
```

---

<a id="3-systemmodi"></a>

## 3. System modes

Untangle MUST support the following operating modes.

### 3.1 Managed Local

New projects MUST default to embedded LanceDB under `.untangle/index/lancedb`. This mode
MUST need no database service or Docker. Embedding services are independent of storage;
`--embedder=offline` supports indexing for lexical/symbol retrieval without model semantics.
The following service mode is an explicit Qdrant option:

- Qdrant runs in a container managed by Untangle.
- Native Ollama is probed first; otherwise it is started in a managed container.
- Persistent volumes MUST be used.
- Containers MUST NOT be deleted without an explicit remove/reset command.

Recommended defaults:

```text
Qdrant REST host port: 16333
Qdrant gRPC host port: 16334
Managed Ollama host port: 11435
Native Ollama probe: http://127.0.0.1:11434
```

### 3.2 External Infrastructure

- Qdrant MAY be provided locally, remotely or as a cloud instance.
- Ollama MAY be provided locally, remotely or through a compatible proxy.
- Untangle MUST NOT modify other processes or containers in this mode.
- Health output MUST show the endpoints actually in use, with secrets redacted.

### 3.3 Library Mode

`@untangle-code/core` MUST be usable without CLI parsing. Infrastructure, storage and embedding adapters MUST be injectable.

---

<a id="4-konfiguration"></a>

## 4. Configuration

<a id="41-priorität"></a>

### 4.1 Precedence

Configuration values are resolved in this order, highest priority first:

1. Explicit API/CLI arguments;
2. Environment variables;
3. `.untangle.local.json`;
4. `.untangle.json`;
5. User configuration in the OS configuration directory;
6. Product defaults.

Ignoring `.untangle.local.json` in `.gitignore` MUST be recommended by default.

<a id="42-hauptschema"></a>

### 4.2 Main schema

```ts
interface UntangleConfigV1 {
  schemaVersion: 1;
  workspaceId?: string;
  projectId?: string;
  repositories?: RepositoryConfig[];
  storage?: { backend?: "lancedb" | "qdrant"; path?: string };
  qdrant?: QdrantConfig;
  embeddings?: EmbeddingConfig;
  index?: IndexConfig;
  search?: SearchConfig;
  graph?: GraphConfig;
  complexity?: ComplexityConfig;
  changes?: ChangeConfig;
  qualityGate?: QualityGateConfig;
  contextArtifacts?: ContextArtifactConfig[];
  telemetry?: TelemetryConfig;
}
```

<a id="43-repository-konfiguration"></a>

### 4.3 Repository configuration

```ts
interface RepositoryConfig {
  id: string;
  path: string;
  label?: string;
  ref?: string;
  include?: string[];
  exclude?: string[];
  packageAliases?: Record<string, string>;
  metadata?: Record<string, string>;
}
```

Requirements:

- `id` MUST be unique within a workspace.
- Paths MUST resolve relative to the configuration file or as absolute paths.
- A workspace MUST contain at least one repository.
- The current project path MAY implicitly serve as a single repository.
- Missing repositories MUST appear as errors in status; other repositories SHOULD remain usable.

<a id="44-qdrant-konfiguration"></a>

### 4.4 Qdrant configuration

```ts
interface QdrantConfig {
  mode: "managed" | "external";
  url?: string;
  apiKeyEnv?: string;
  collectionPrefix?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  upsertMaxPoints?: number;
  upsertBudgetBytes?: number;
}
```

<a id="45-embedding-konfiguration"></a>

### 4.5 Embedding configuration

```ts
interface EmbeddingConfig {
  provider: "ollama";
  mode: "auto" | "managed" | "external";
  url?: string;
  apiKeyEnv?: string;
  model: string;
  dimensions: number;
  contextLength: number;
  queryPrefix: string;
  documentPrefix: string;
  includePath: boolean;
  batchSize: number;
  maxConnections: number;
  requestTimeoutMs: number;
}
```

MVP default profile:

```json
{
  "provider": "ollama",
  "mode": "auto",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "contextLength": 2048,
  "queryPrefix": "search_query: ",
  "documentPrefix": "search_document: ",
  "includePath": true,
  "batchSize": 32,
  "maxConnections": 4,
  "requestTimeoutMs": 120000
}
```

<a id="46-index-konfiguration"></a>

### 4.6 Index configuration

```ts
interface IndexConfig {
  watch: boolean;
  reconcileIntervalMinutes: number;
  maxFileSizeMb: number;
  maxGraphFileSizeMb: number;
  scanConcurrency: number;
  embeddingConcurrency: number;
  filesPerCheckpoint: number;
  targetChunkTokens: number;
  maxChunkTokens: number;
  fallbackOverlapTokens: number;
  includeDotFiles: boolean;
  indexExtensionless: boolean;
  extraExtensions: string[];
  extensionLanguageMap: Record<string, string>;
}
```

<a id="47-quality-gate-konfiguration"></a>

### 4.7 Quality gate configuration

```ts
interface QualityGateConfig {
  mode: "off" | "warn" | "fail";
  newCyclesAllowed: number;
  cognitivePerSymbolMax?: number;
  cognitiveDeltaPerSymbolMax?: number;
  cyclomaticPerSymbolMax?: number;
  cyclomaticDeltaPerSymbolMax?: number;
  maxNestingPerSymbolMax?: number;
  maintainabilityIndexMin?: number;
  riskScoreMax?: number;
  minimumParseQuality: "failed" | "partial" | "complete";
  ignoreExistingViolations: boolean;
  include?: string[];
  exclude?: string[];
}
```

<a id="48-konfigurationsvalidierung"></a>

### 4.8 Configuration validation

- Unknown top-level fields SHOULD produce warnings rather than being silently ignored.
- Invalid enum values or unresolvable core values MUST abort startup.
- Incorrectly configured dimensions MUST be detected before the first index upsert.
- The validated effective profile MUST be stored in the index.

---

<a id="5-identitätsmodell"></a>

## 5. Identity model

<a id="51-workspace-id"></a>

### 5.1 Workspace ID

`workspace_id` MUST either be explicitly configured or derived stably from workspace configuration.

<a id="52-repository-id"></a>

### 5.2 Repository ID

`repo_id` MUST be configurable and stable within a workspace. A path hash MAY serve as a fallback, but SHOULD NOT be the sole identity shared across teams.

<a id="53-ref-id"></a>

### 5.3 Ref ID

```text
ref_id = repo_id + ":" + normalized_ref
```

The ref can be a branch, tag, commit or logical snapshot name.

<a id="54-datei-id"></a>

### 5.4 File ID

```text
file_id = UUIDv5(workspace_id + repo_id + ref_id + normalized_relative_path)
```

Path separators MUST be normalized internally to `/`.

<a id="55-symbol-id"></a>

### 5.5 Symbol ID

```text
symbol_id = UUIDv5(
  workspace_id + repo_id + ref_id + normalized_path +
  symbol_kind + qualified_name + normalized_signature
)
```

Line numbers MUST NOT form part of the primary symbol ID.

<a id="56-chunk-id"></a>

### 5.6 Chunk ID

```text
chunk_id = UUIDv5(symbol_or_file_scope_id + chunk_kind + stable_ordinal + chunker_version)
```

The chunk ID MUST remain stable when the symbol and chunk structure are unchanged.

<a id="57-embedding-profil-id"></a>

### 5.7 Embedding profile ID

```text
embedding_profile_id = SHA256(canonical_json(profile_fields))
```

At least the following fields MUST contribute:

- Provider;
- Model;
- Dimensions;
- Query prefix;
- Document prefix;
- Include path;
- Normalization option;
- Prepared text version.

---

<a id="6-dateierkennung-und-ignore-regeln"></a>

## 6. File discovery and ignore rules

### 6.1 Discovery

The scanner MUST:

- Recursively discover regular files;
- Avoid symlink cycles;
- Ignore standard build and VCS directories;
- Respect `.gitignore`, `.untangleignore` and configuration patterns;
- Detect and skip binary files;
- Check file sizes before reading complete files;
- Optionally classify extensionless files through content sampling.

<a id="62-ignore-priorität"></a>

### 6.2 Ignore precedence

1. Security and system exclusions;
2. Explicit configuration excludes;
3. `.untangleignore`;
4. `.gitignore`;
5. Default exclusions;
6. Includes may override default exclusions, but never security boundaries.

<a id="63-standardausschlüsse"></a>

### 6.3 Default exclusions

At least:

```text
.git, .svn, .hg, node_modules, vendor, dist, build, out,
coverage, .cache, .next, .nuxt, target, .gradle,
.venv, venv, __pycache__, generated assets
```

---

<a id="7-parser-und-sprachunterstützung"></a>

## 7. Parsers and language support

<a id="71-support-level"></a>

### 7.1 Support levels

Languages carry a support level:

- `deep`: full chunking, symbol, call, import and complexity support;
- `structural`: AST chunking, symbols and imports, with limited calls/metrics;
- `text`: safe text chunks and search, with no dependable graph/metric claims.

> **Correction (vision.md §1c, WP-110/WP-217):** The phrase "no dependable
> graph/metric claims" can sound like a lower tier. It defines a boundary,
> not reduced service: **`text` is not degraded `deep`; it is the complete
> service for content without graphs**, including full-quality search,
> change intelligence, history and provenance. What is absent is absent for a reason.
>
> Specifically, since WP-110/WP-217:
>
> - Prose (`.md`, `.markdown`, `.mdx`, `.rst`, `.txt`) uses **heading-aware**
>   chunking (`prose_section` with breadcrumbs), rather than line windows;
> - Prose carries **its own metrics** (structural and reference load; §16 applies
>   to code) as a separate family that is never combined with code metrics;
> - Structured data (JSON/YAML/TOML/XML) uses `text` with safe text chunks;
> - Omitted content receives an accurate reason (`no_metric_defined`,
>   `generated_content`) rather than `unsupported_language`.

<a id="72-mvp-sprachen"></a>

### 7.2 MVP languages

The MVP MUST support at least:

| Language | Level |
|---|---|
| TypeScript | deep |
| JavaScript | deep |
| TSX/JSX | deep |
| Python | deep |
| JSON/YAML/TOML/Markdown | text/format-specific |

Public Beta SHOULD add Go, Java, Kotlin, C#, Rust, PHP, Ruby, C and C++.

### 7.3 Parse Quality

Every analyzed file MUST receive a quality classification:

```text
complete  — parser without relevant error/missing nodes
partial   — usable AST with error nodes or fallback portions
failed    — no usable AST; text fallback
```

Parse quality MUST be available in search, complexity and change results.

---

<a id="8-ast-chunking"></a>

## 8. AST chunking

<a id="81-ziele"></a>

### 8.1 Goals

Chunks MUST:

- Be as semantically self-contained as possible;
- Retain source positions;
- Respect a token budget;
- Allow fully reconstructable coverage evidence;
- Use stable scope IDs;
- Allow separate preparation for dense search and BM25.

<a id="82-chunk-typen"></a>

### 8.2 Chunk types

```text
file_preamble
module
class_overview
function
method
constructor
interface
type
enum
property_group
symbol_fragment
comment
configuration
fallback_lines
minified_fragment
prose_section
```

`prose_section` was added in WP-110 (vision.md §1c): a Markdown section is a
semantic unit, like a function, and therefore must not appear as `fallback_lines`.
See the README's "Decisions" section.

<a id="83-chunking-reihenfolge"></a>

### 8.3 Chunking order

1. Classify and parse the file.
2. Attach doc comments, annotations and decorators to the following symbol.
3. Identify top-level symbols.
4. Generate a class overview.
5. Generate methods and other members separately.
6. Recursively split large symbols at AST sub-blocks.
7. If still too large, form statement groups.
8. If still too large, split by tokens at safe boundaries.
9. On parse errors, use line fallback with overlap.
10. For minified content, use safe token/character boundaries.

<a id="84-lossless-anforderung"></a>

### 8.4 Lossless requirement

Every indexable file MUST satisfy:

```text
covered_source_ranges ∪ intentionally_excluded_ranges = complete_file_range
```

Intentionally excluded ranges MUST be logged with a reason. Hard truncation without a following chunk is prohibited.

<a id="85-symbolfragmente"></a>

### 8.5 Symbol fragments

Every fragment of a large symbol MUST contain:

- `symbol_id`;
- `fragment_index` and `fragment_count`;
- The signature or a short symbol header;
- The original source range;
- Complete symbol-scope complexity metrics as a reference;
- Its own chunk-level token/text metrics.

### 8.6 Prepared Text

Dense document text SHOULD use this format:

```text
{documentPrefix}
repository: {repo_label}
ref: {ref_name}
path: {file_path}
language: {language}
symbol: {symbol_fqn}
signature: {signature}

{content}
```

BM25 text SHOULD contain raw code, paths, symbol names and identifiers without natural-language embellishment.

---

<a id="9-embeddings-mit-ollama"></a>

## 9. Embeddings with Ollama

### 9.1 Readiness

Before the first embedding, Untangle MUST:

1. Determine the effective Ollama endpoint;
2. Check reachability;
3. Check model availability;
4. Download the model in managed mode if necessary;
5. Generate a probe embedding;
6. Validate vector dimensions;
7. Cache the profile and probe time.

### 9.2 Batching

- Batch size MUST be configurable.
- Requests MUST respect the connection limit.
- Errors MUST be retried with exponential backoff and jitter.
- Repeated permanent failures MUST stop the job in a controlled manner.
- Progress MUST update after each batch.

### 9.3 Truncation

Provider-side truncation MAY remain enabled as a final safeguard. The chunker MUST normally ensure that prepared text fits within the context window. If provider truncation actually occurs, the point MUST carry `embedding_truncated=true`.

### 9.4 Cache

Embedding cache key:

```text
embedding_profile_id + SHA256(prepared_text)
```

Unchanged prepared text MUST NOT be embedded again while the cache remains valid.

---

<a id="10-qdrant-speicher"></a>

## 10. Persistent storage

LanceDB is the default for new setups. An explicit storage backend takes precedence; legacy
configuration with an explicit Qdrant section or Qdrant environment override retains Qdrant.
`storage.path` is a local, repository-root-relative path (or an absolute local path), never a
remote database URI. Environment overrides are `UNTANGLE_STORAGE_BACKEND` and
`UNTANGLE_LANCEDB_PATH`. Read/status methods MUST NOT create directories or tables.

Both adapters implement the same vector, metadata and graph ports. Identifier tokenization,
payload filters, generation publication, cancellation and index freshness remain shared.
LanceDB stores vectors, payloads, metadata and graph parts in real persistent Lance tables.
Its initial implementation uses bounded exact ranking rather than promising native ANN
performance or score equality with Qdrant. A local SQLite transaction is solely a mutation
mutex; SQLite is not an alternative index or metadata store.

Index records and current pointers MUST bind the storage backend and canonical location.
Old Qdrant record identities and configuration hashes MUST remain compatible. Switching
backends MUST select an independent index; it MUST NOT delete or silently copy existing data.
Index the selected backend before querying it; switching back may reuse its fresh generation.
Storage-specific failures MUST identify the actual backend, never masquerade as empty results.

The collection strategy and Qdrant-specific transport requirements below continue to apply
to Qdrant. LanceDB preserves their logical collection/profile and payload contracts.

<a id="101-collection-strategie"></a>

### 10.1 Collection strategy

Untangle SHOULD use a shared code collection for each compatible embedding profile and schema:

```text
{prefix}code_{profile_short_id}_v1
{prefix}context_{profile_short_id}_v1
{prefix}changes_{profile_short_id}_v1
{prefix}metadata_v1
{prefix}graph_files_v1
{prefix}graph_indices_v1
{prefix}graph_meta_v1
{prefix}complexity_history_v1
```

An alternative collection per project MAY exist as a compatibility mode. RRF scores from different collections MUST NOT be compared directly in this mode.

<a id="102-code-vektoren"></a>

### 10.2 Code vectors

```json
{
  "vectors": {
    "dense": {
      "size": 768,
      "distance": "Cosine"
    }
  },
  "sparse_vectors": {
    "bm25": {
      "modifier": "idf"
    }
  },
  "on_disk_payload": true
}
```

Dimensions MUST come from the profile.

<a id="103-code-chunk-payload"></a>

### 10.3 Code chunk payload

```ts
interface CodeChunkPayloadV1 {
  schema_version: 1;
  point_type: "code_chunk";
  workspace_id: string;
  repo_id: string;
  repo_label: string;
  ref_id: string;
  ref_name: string;
  commit_sha?: string;

  file_id: string;
  file_path: string;
  file_hash: string;
  language: string;
  parse_quality: "complete" | "partial" | "failed";

  symbol_id?: string;
  symbol_name?: string;
  symbol_fqn?: string;
  symbol_kind?: string;
  signature?: string;

  chunk_id: string;
  chunk_kind: string;
  chunk_ordinal: number;
  fragment_index?: number;
  fragment_count?: number;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  content: string;

  content_hash: string;
  ast_hash?: string;
  parser_version: string;
  chunker_version: string;
  metrics_version: string;
  embedding_profile_id: string;
  /** Complete index generation that produced this point. */
  generation_id: string;
  embedding_truncated: boolean;

  metrics_scope: "symbol" | "file" | "chunk";
  metrics_scope_id: string;
  cyclomatic_classic?: number;
  cyclomatic_extended?: number;
  cognitive?: number;
  max_nesting?: number;
  sloc?: number;
  halstead_volume?: number;
  maintainability_index?: number;
  risk_score?: number;
}
```

<a id="104-payload-indizes"></a>

### 10.4 Payload indexes

Keyword indexes MUST exist for at least:

```text
point_type, workspace_id, repo_id, ref_id, file_id, file_path,
language, parse_quality, symbol_id, symbol_name, symbol_fqn,
symbol_kind, chunk_kind, content_hash, embedding_profile_id
```

Numeric indexes SHOULD exist for:

```text
cyclomatic_classic, cyclomatic_extended, cognitive, max_nesting,
sloc, halstead_volume, maintainability_index, risk_score,
changed_at_epoch_ms
```

### 10.5 Upserts

- Upserts MUST be idempotent.
- Batches MUST be bounded by both point count and serialized byte size.
- An individual oversized point MUST be rejected with an identifiable error or split into multipart points.
- Partial failures MUST be isolated without silently losing an entire batch.
- A checkpoint may be persisted only after an acknowledged upsert.
- Persisting a changed file's points MUST replace the complete per-file set: all existing points
  with the same `file_id` MUST be deleted before upserting the complete new set. This also applies
  when the new set is empty. An incremental run MUST NOT report `completed` until this replacement
  is acknowledged; no retired chunk or symbol points for that file may remain afterward.

<a id="106-generationen"></a>

### 10.6 Generations

Every full index run MUST use a `generation_id`. Points and metadata from an incomplete generation MUST NOT be reported as complete.

---

<a id="11-vollindex"></a>

## 11. Full index

<a id="111-zustandsmaschine"></a>

### 11.1 State machine

```text
queued
→ preparing_infrastructure
→ discovering_files
→ parsing_and_chunking
→ computing_metrics
→ embedding
→ storing
→ checkpointing
→ building_graphs
→ indexing_context
→ finalizing
→ completed
```

Error states:

```text
failed
cancel_requested
cancelled
```

<a id="112-anforderungen"></a>

### 11.2 Requirements

- The MCP start call MAY return immediately with a job ID.
- The CLI SHOULD stream progress without `--background`.
- A checkpoint MUST be saved after every configured file batch.
- After a restart, the job MUST be resumable from the last acknowledged checkpoint.
- A full index MUST NOT automatically delete an existing collection.
- Incompatible profiles MUST require a new collection/generation or an explicit reindex.

---

<a id="12-inkrementelle-aktualisierung-und-watcher"></a>

## 12. Incremental updates and watchers

### 12.1 Change Detection

Files are compared using at least:

```text
relative path
size
mtime as fast hint
content hash as source of truth
```

Only the content hash may determine the final unchanged status.

Every subsequent analysis read MUST hash the exact bytes read and compare that value with both
the discovery result and planned content hash. Reparsing a file planned as unchanged for graph
construction MUST perform the same byte/hash check against discovery. A read error or mismatch
MUST end the run with `ANALYSIS_INCOMPLETE`; the run MUST NOT publish a `completed` index state
or a `corpusRevisionFingerprint`.

<a id="122-update-ablauf"></a>

### 12.2 Update sequence

For changed files, Untangle MUST:

1. Load previous manifests;
2. Reparse and rechunk the file;
3. Match symbol identities;
4. Calculate new metrics;
5. Embed only new/changed prepared text;
6. Delete obsolete points;
7. Upsert new points;
8. Patch file and symbol graphs;
9. Generate a change event;
10. Advance the checkpoint atomically.

<a id="123-watcher"></a>

### 12.3 Watchers

- A native recursive watcher SHOULD be used.
- Events MUST be debounced; default `2000 ms`.
- Multiple events for the same file MUST be coalesced.
- Watcher errors must not terminate the MCP process uncontrollably.
- Periodic reconciliation MUST correct lost events.
- Cross-process locks MUST prevent concurrent updates to the same ref.

---

<a id="13-suche"></a>

## 13. Search

### 13.1 Query Input

```ts
interface SearchRequestV1 {
  query: string;
  workspaceId?: string;
  repositories?: string[];
  refs?: string[];
  commitSha?: string;
  limit?: number;
  candidateLimit?: number;
  pathGlob?: string[];
  languages?: string[];
  symbolNames?: string[];
  symbolKinds?: string[];
  chunkKinds?: string[];
  complexity?: {
    cyclomaticMin?: number;
    cyclomaticMax?: number;
    cognitiveMin?: number;
    cognitiveMax?: number;
    riskMin?: number;
    riskMax?: number;
  };
  changedSince?: string;
  includeContext?: boolean;
  includeLinked?: boolean;
  diversify?: boolean;
  minScore?: number;
}
```

### 13.2 Query Pipeline

1. Validate the request.
2. Resolve the workspace and profiles.
3. Normalize the query without destroying identifier characters.
4. Generate one query embedding per compatible profile.
5. Prefetch dense and BM25 candidates in Qdrant.
6. Perform RRF within the same collection.
7. Apply payload filters directly in Qdrant.
8. Deduplicate results.
9. Apply optional boosts.
10. Optionally diversify.
11. Optionally add structural context.
12. Return score components and provenance.

When the ref filter is absent and local index contexts are known, the search engine MUST use the
recorded, repository-qualified canonical ref IDs within the effective repository scope as the
ref filter before querying the store. After retrieval, it MUST recheck each candidate's workspace,
repository and effective ref membership; a store that ignores payload filtering MUST NOT expand
scope.

For explicit multi-repository/multi-ref requests, the completeness check MUST find every requested
canonical ref in at least one completed index context within the effective repository scope. It
MUST NOT require the Cartesian product of all requested repositories and refs. Complete corpus
evidence also requires every returned candidate to have an exactly matching completed context
for `repo_id`, `ref_id` and `generation_id`.

### 13.3 Reranking

The final score MAY contain these normalized components:

```text
base_hybrid_score
+ exact_symbol_boost
+ exact_path_boost
+ repo_priority_boost
+ graph_proximity_boost
+ recency_boost
- duplicate_penalty
```

Every component MUST be visible in debug/JSON mode. Heuristic boosts MUST NOT completely override dense/BM25 retrieval.

<a id="134-cross-collection-regel"></a>

### 13.4 Cross-collection rule

When querying multiple collections:

- Cosine scores may be compared only with the same verified embedding profile.
- RRF scores from separate collections MUST NOT be sorted directly as absolute relevance values.
- Incompatible profiles MUST produce separate result groups or use an explicit normalization strategy.
- The response MUST disclose profile separation.

<a id="135-deduplizierung"></a>

### 13.5 Deduplication

- Multiple fragments of one symbol SHOULD NOT occupy all top positions.
- Default deduplication uses `repo_id + ref_id + metrics_scope_id`.
- The highest-ranked fragment remains primary; additional fragments MAY be attached as `relatedFragments`.

### 13.6 Search Result

```ts
interface SearchResultV1 {
  schemaVersion: 1;
  repo: { id: string; label: string };
  ref: { id: string; name: string; commitSha?: string };
  file: {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
  };
  symbol?: {
    id: string;
    name: string;
    fqn: string;
    kind: string;
    signature?: string;
  };
  chunk: { id: string; kind: string; content: string };
  scores: {
    final: number;
    hybrid?: number;
    dense?: number;
    sparseRank?: number;
    boosts?: Record<string, number>;
  };
  complexity?: ComplexitySummaryV1;
  parseQuality: "complete" | "partial" | "failed";
  indexGeneration: string;
}
```

<a id="137-search-journeys-und-dynamic-product-complexity"></a>

### 13.7 Search Journeys and Dynamic Product Complexity

<a id="abgrenzung-und-einwilligung"></a>

#### Boundaries and consent

A Search Journey connects several real search attempts and explicitly reported navigation steps
for a task to a confirmed target. It is separate from two existing measurement families:

- Cognitive Complexity measures control flow in known code;
- Findability measures synthetic self-search for a known symbol;
- Dynamic Search Complexity measures the observed path of a real task to an explicitly confirmed target.

A journey MUST be explicitly activated through `start` and carry `recordingConsent: "explicit"`.
Without session coupling, the journey lifecycle MUST NOT affect a search and the search MUST NOT
be persisted as a journey attempt. `retainText` MUST default to `false`. In that case, the goal and
queries MUST be stored exclusively as workspace-local, domain-separated HMAC-SHA-256 fingerprints.
The random local HMAC key MUST be stored separately from session records at
`.untangle/product-complexity/fingerprint.key`. Hit references MAY contain locators, rank, score,
profile and generation, but neither chunk content nor source text.

`start` MAY additionally accept a trimmed, non-empty `featureId` of at most 256 UTF-16 code units.
The caller declares it as a stable identifier for repeatable feature probes; Untangle verifies
neither its semantics nor its stability. The persisted contract MUST use an HMAC-SHA-256
fingerprint under `feature.fingerprint`, domain-separated from the goal and query. Like
`goal.text`, `feature.text` MAY be retained only with `retainText: true`. Journeys without a
`feature` remain valid; Untangle MUST NOT infer a feature from goals, queries or targets.
Goal/query text, free-form failure/abandonment details, explicit tool names and each individual
component of a target/candidate locator MUST each contain at most 4,096 UTF-16 code units. This
limit MUST apply at MCP input, in the service and when validating persisted records; direct
adapter calls MUST NOT bypass it.

<a id="retrieval-funnel"></a>

#### Retrieval funnel

Every profile group actually searched SHOULD return the following diagnostics; these values MUST
NOT change ranking or the query fingerprint:

```ts
interface SearchRetrievalDiagnosticsV1 {
  branchCandidateCounts: { dense: number; sparse: number; symbol: number };
  uniqueRetrievedCandidateCount: number;
  eligibleCandidateCount: number;
  rankedCandidateCount: number;
  deduplicatedCandidateCount: number;
  qualifiedHitCount: number;
  returnedHitCount: number;
  uniqueEligibleFileCount: number;
  uniqueEligibleSymbolCount: number;
  eligibleFileDispersion: number; // [0,1]
  topScoreGap: number | null;
  candidateLimitReached: boolean;
}
```

`eligibleFileDispersion` MUST be `0` for at most one eligible candidate, and otherwise be calculated
as `(uniqueEligibleFileCount - 1) / (eligibleCandidateCount - 1)`. These counters observe the funnel;
they do not estimate relevant documents and are specifically not precision measurements.
A searched profile group SHOULD carry known `indexGenerations` independently of final hits. When
ranking or relevance policy discards every candidate, a known generation MUST NOT be lost as a
result; if it is nevertheless absent for a healthy no-hit search, that search's measurement context
remains incomplete. Once candidates are present, their own raw stored generation MUST govern
provenance. A search surface MAY expose a locally known generation as a backward-compatible
display fallback, but a local `completed` state MUST NOT lend measurement provenance to a legacy
candidate lacking a raw `generation_id`. Such a candidate remains `unknown` for integrity and
cohort decisions, and the index context remains incomplete.
A search surface aware of local index state MUST pass each repository/ref generation and run
outcome to the search engine. Only `completed` MAY count as a complete index context. A newly
published `completed` state MUST additionally carry an immutable SHA-256
`corpusRevisionFingerprint`, deterministically derived from the full acknowledged file/content
manifest. `running`, `cancelled` and `failed` MUST NOT claim this fingerprint. Hits from these
states, from completed states without a verifiable fingerprint, or from unverifiable generations
MAY remain usable; the result set MUST then warn `INDEX_CONTEXT_INCOMPLETE` and MUST NOT count as
healthy retrieval for a Search Journey. A successful journey observation with this warning MUST
produce `retrievalHealthy: false` and therefore `measurementContextComplete: false`.
A measurement-healthy searched `SearchHitGroupV1` MUST itself carry a
`corpusRevisionFingerprint` that deterministically binds the embedding profile to its associated
completed repository/ref/generation/corpus fingerprints. If any selected index context lacks this
completed evidence, the profile group MUST NOT pretend to have a complete corpus fingerprint and
the result set MUST report `INDEX_CONTEXT_INCOMPLETE`.
The same applies when a candidate observation was discarded because of `missing_index_entry` or
the result set reports `INCOMPLETE_PAYLOAD`: missing index or payload evidence MUST NOT enter a
cohort as healthy retrieval.
The indexer MUST durably publish `running` after assigning the generation and before its first
mutation. During the job, a finite repository/ref lock lease MUST be renewed without overlap no
later than one third of its duration. Renewal failure MUST abort the job as `LOCK_HELD`, and the
job MUST NOT publish another terminal generation state. Immediately before terminal publication,
an additional owner-checked renewal MUST confirm ownership.
Local index state MUST be maintained as a bounded registry per physical repository root. A record
key MUST canonically bind workspace, repository, ref and embedding profile; a separate,
generation-bound current pointer MUST identify exactly the profile automatically selected for each
workspace/repository/ref. Multiple refs, profiles and logical repository IDs at one physical root
MUST NOT overwrite each other. The older `.untangle/index-state.json` singleton MAY remain as a
read fallback, but MUST yield to a logical identity already present in the registry.

Start and terminal publication MUST additionally be serialized through a renewed state-publish
lock per repository/ref. Immediately before every record/pointer rename, an owner-checked renewal
MUST confirm ownership; completion MUST replace only its own `running` record for the same
generation and MUST NOT reset a newer current pointer. An older or displaced run must not
overwrite a newer marker. If terminal persistence fails, only a writer that still holds ownership
MAY remove a potentially stale hint; otherwise the remaining state MUST be loudly classified as
unverifiable. Registry reads MUST limit count and file size and fail closed on non-regular,
symlinked, manipulated or corrupt entries. The remaining boundary of a local filesystem rename
already in progress, which cannot be hard-fenced, MUST remain visible as a limitation of local
lease mode; silently trusting an old `completed` state is prohibited.
Profiles not searched MUST carry `retrievalPerformed: false` and a reason; provider failure MUST
NOT be reported as an empty successful search.
A successful result set SHOULD additionally carry a `rankingContextFingerprint` that, without
search text or domain filters, binds at least search mode, sort order, diversification, `minScore`,
branch/boost weights, active relevance policies and the availability of ranking-affecting
providers. It is a comparison ID, not a quality score.

<a id="persistierter-journey-vertrag"></a>

#### Persisted journey contract

```ts
interface SearchJourneyV1 {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  workspaceId: string;
  status: "active" | "completed" | "abandoned";
  recordingConsent: "explicit";
  retainText: boolean;
  goal: { fingerprint: string; text?: string };
  feature?: { fingerprint: string; text?: string };
  createdAt: string;
  updatedAt: string;
  attempts: SearchJourneyAttemptV1[];
  navigation: SearchJourneyNavigationEventV1[];
  outcome?: SearchJourneyOutcomeV1;
}

interface SearchJourneyAttemptV1 {
  attemptId: string;
  sequence: number;
  clientStep?: number;
  measurementContextVersion?: 2;
  observationFingerprint: string;
  queryFingerprint: string;
  queryText?: string;
  rankerVersion: string;
  rankingContextFingerprint?: string;
  resultLimit?: number;
  candidateLimit?: number;
  observedAt: string;
  status: "succeeded" | "failed";
  failureCode?: string;
  failureReason?: string;
  warningCodes: string[];
  retrievalHealthy: boolean;
  profiles: SearchJourneyProfileObservationV1[];
}

interface SearchJourneyCompletedOutcomeV1 {
  kind: "completed";
  completedAt: string;
  target: SearchJourneyTargetV1;
  acceptedAttemptId?: string;
  assessment: DynamicSearchComplexityV1;
}
```

`measurementContextVersion` versions only the comparison evidence within the still-additive
journey/report v1 contract. Its absence identifies a readable legacy context; it must not be
silently interpreted as version 2.

Every profile observation MUST contain the embedding profile, observed index generations,
retrieval state, optional funnel diagnostics and a bounded list of lightweight candidates with
profile-local ranks. New v2 observations MUST additionally carry a `corpusRevisionFingerprint`
for exactly the completed, verified corpus revisions searched by that profile. If multiple
repository/ref contexts are searched, the fingerprint MUST deterministically bind their complete
association; it is not a content or quality metric. New candidate observations MUST also preserve
the real search hit's optional `ComplexitySummaryV1` and its sorted `incompletePayloadFields`
unchanged; when no such payload field is missing, the array MUST be empty. Both fields MUST
contribute to the observation fingerprint so that a repeated `clientStep` with changed metric
evidence does not incorrectly appear idempotent. Legacy candidates without these fields remain
readable. The optional positive `clientStep` provides idempotency: the same step with the same
observation MUST return the same attempt without changing revision; the same step with a different
observation MUST be rejected with `SEARCH_SESSION_CONFLICT`. Numbered and unnumbered attempts
MUST NOT be mixed within a session. A session is limited to 128 search attempts and 512 navigation
events. `revision` MUST detect competing local writers as a compare-and-swap counter.
A local session record MUST NOT exceed 32 MiB; the store MUST NOT hold more than 10,000 records.
Before parsing any record, `list`/`report` MUST check the complete snapshot as a file/size manifest
against a cumulative 128 MiB budget. After each read, actual UTF-8 bytes MUST be rechecked against
both per-file and total budgets, and file type and size against the manifest, before parsing.
Disappearance, type/size changes and budget overruns MUST fail visibly; a subset MUST NOT be
reported as a complete cohort. An atomic replacement of equal size remains a documented local
snapshot limitation without a versioned read primitive.
Local atomic writes for sessions and the fingerprint key MUST best-effort remove their exact
temporary file on success, error and cancellation without hiding the primary error; cleanup MUST
NOT fail because the caller's signal is already aborted.
Fingerprint, create and session locks MUST retain valid 30-second leases throughout the critical
section. Non-overlapping renewals MUST start no later than one third of the lease duration.
Immediately before each commit-relevant rename, every lock held for it MUST be owner-checked and
simultaneously have at least one renewal interval remaining. Session creation requires this
jointly for the outer create lock and inner session lock; if the common freshness window is not
reached within eight renewal rounds, or a renewal fails with `LOCK_HELD`, a rename MUST NOT occur.

Navigation events MAY be counted only after explicit reporting. Valid kinds are `open-file`,
`open-symbol`, `graph-query` and `other-tool`. Untangle MUST NOT infer file opening or tool usage
from search hits alone.

An abandoned run MAY store a controlled `reasonCode` from `target-not-found`, `task-changed`,
`retrieval-unavailable`, `cancelled` or `other`. A free-form `reason` detail MAY be retained only if
the journey started with `retainText: true`; otherwise it MUST be omitted.

<a id="bestätigter-abschluss-und-task-basierte-indikatoren"></a>

#### Confirmed completion and task-based indicators

Completion MUST contain a target locator with at least `filePath`, `chunkId` or `symbolId`.
Additional locator fields—repository, ref, profile or generation—MUST also agree during matching.
A journey MUST NOT be completed before at least one search attempt. When `acceptedAttemptId` is
set, that attempt MUST contain the confirmed target and its ID MUST additionally be persisted as
`outcome.acceptedAttemptId`. Runtime validation MUST then reconstruct assessment values against
exactly that attempt. Existing records without this outcome field MUST remain readable and retain
the previous last-match semantics. An externally found and confirmed target MAY complete a
journey; target rank, reciprocal rank and score gap MUST then remain `null`.
Without `acceptedAttemptId`, all search attempts up to completion MUST count as effort; rank and
score gap MAY then be attributed to the last matching attempt if a caveat makes this inference
visible. With `acceptedAttemptId`, later or out-of-order search observations MAY be excluded from
search effort.
When an insufficiently precise locator matches multiple embedding-profile/generation contexts,
`targetWasReturned` MUST remain true, but target rank, reciprocal rank and score gap MUST also
remain `null` until the locator is refined; scores from different profiles are not comparable.

The `untangle-dynamic-search-complexity-v1` algorithm MUST supply at least these explainable indicators:

```text
searchesToTarget, successfulSearchesToTarget, failedSearchesToTarget,
distinctQueryCount, queryReformulations, acceptedTargetRank, reciprocalRank,
targetWasReturned, targetFirstReturnedAtSearch, targetAcceptedAtSearch,
selectionLagSearches, directHit, eligibleCandidatesExamined,
uniqueCandidatesExposed, uniqueFilesExposed, navigationEventsToTarget,
observedToolAndFileHops, meanCandidateFileDispersion, meanCandidateChurn,
candidateLimitHitRate, healthyRetrievalRate, acceptedTargetScoreMargin,
acceptedTargetCodeComplexity, measurementContextId, measurementContextComplete, caveats
```

For new completions, `acceptedTargetCodeComplexity` MUST supply discriminated evidence. For a
uniquely attributable accepted search hit with static metrics, it is
`{ status: "observed", source: "indexed-search-hit", candidate, complexity, payloadComplete,
incompletePayloadFields }`. `candidate` MUST bind the repository, ref, file, chunk, profile and
generation of the metric evidence; symbol references are optional. If the evidence cannot be
safely attributed, the result MUST instead be `{ status: "unavailable", reason }`, with
`target-not-returned`, `target-context-ambiguous`, `complexity-not-indexed` or `legacy-observation`.
A broad locator matching multiple distinct hit identities MUST NOT produce observed code
complexity by arbitrarily choosing the first hit. Legacy assessments without this additive field
remain readable.

The result MUST include `isHeuristic: true`, the algorithm ID and caveats. It MUST NOT be called
Cognitive Complexity or a static property of a file, and MUST NOT be compressed into an opaque
overall score. A confirmed target supplies exactly one positive label; the contract therefore MUST
NOT claim precision for the other candidates from a journey.

<a id="product-complexity-kohorten"></a>

#### Product complexity cohorts

A workspace report MUST count active, completed and abandoned sessions separately.
`sessionCounts.featureTaggedCompleted` MUST count exactly the completed journeys with an explicit
`feature.fingerprint`, and MUST NOT exceed `sessionCounts.completed`. Active and abandoned
sessions MUST NOT contribute to completed-to-target indicator aggregation. Completed journeys
MUST be separated by a `measurementContextId` derived from ranker version, a text-free fingerprint
of effective search-mode/ranking/relevance configuration, effective result/candidate limits and
the v2 profile records. Every profile record MUST preserve `embeddingProfileId`, its associated
`indexGenerations` and its associated `corpusRevisionFingerprint` as one association; three
independently aggregated sets are not an equivalent measurement context. Incompatible contexts
MUST NOT be combined. Failed attempts remain effort and retrieval health for the same journey,
but alone do not change its measurement context derived from successful attempts. A successful
attempt with partial provider/profile failure is not `retrievalHealthy`; while any counted attempt
is unhealthy, `measurementContextComplete: false` MUST hold.

For every counted successful attempt, the measurement context MUST retain the full tuple of
`measurementContextVersion: 2`, ranker version, `rankingContextFingerprint`, effective result and
candidate limits, and profile records associating embedding profile, index generations and corpus
revision. `measurementContextComplete` MAY be `true` only if this tuple is identical across every
counted successful attempt and every profile observation has retrieval diagnostics, only known
generations and a valid `corpusRevisionFingerprint`. Every tuple change or missing field MUST
produce `measurementContextComplete: false`; the journey remains diagnostically visible but MUST
NOT supply sufficient cohort evidence. Unversioned legacy attempts and profiles without corpus
revisions MUST remain readable and visible in reports. During report preparation, however, these
contexts MUST be treated as incomplete and MUST never support `sufficientEvidence: true`, even
when a historically stored individual assessment described them differently.

A cohort MUST contain a complete measurement context and at least three completed journeys before
`sufficientEvidence: true` may be set. It MUST return median and p90 searches-to-target, median
reformulations, target rank, candidate/file load, and target-returned, direct-hit,
healthy-retrieval and candidate-limit-hit rates. Fewer than three journeys remain diagnostically
visible in their cohort, but do not constitute sufficient evidence and must carry a visible
caveat. The report is an atemporal cohort aggregation and MUST NOT be described as a product trend
or before/after view over time.
New starts MAY carry an `executionContext` explicitly declared by the caller: `agentModel`,
`harness`, `searchStrategy`, `taskClass`, plus optional `taskMix` and `priorContext`. All four
required labels MUST be supplied; every trimmed label MUST contain 1 to 256 UTF-16 code units.
Unknown fields and invalid values MUST be rejected. No dimension MAY be inferred automatically
from the agent, repository or search behavior. Every dimension MUST be separately pseudonymized
using the workspace key and its own HMAC domain name; plaintext MAY remain only with
`retainText: true`.
The declared context MUST segment report cohorts in addition to retrieval context; historical
assessment/retrieval fingerprints and IDs of context-free cohorts remain unchanged. Missing
dimensions MUST appear as `uncontrolledDimensions`; `callerConditionsControlled` MAY be true only
with all six dimensions explicitly declared. This authenticates neither their correctness nor
causal comparability. Task mix and sampling are not normalized.

New reports MUST return separate `outcomeCohorts` for all active, completed and abandoned sessions.
Every session MUST belong to exactly one retrieval/execution-context/feature group. Groups MUST
retain status denominators, unique goals, effort per status, failed searches and abandonment
reasons. `terminalCompletionRate` MUST be `completed / (completed + abandoned)`; without terminal
sessions it MUST be `null`. Active sessions are separate. This raw effort MUST also count zero-search cases
and later observations after an early accepted target, and MUST NOT replace
completed-to-target metrics. Old v1 reports without the additive fields remain readable. The
analysis proves no temporal improvement, benchmark accuracy, productivity or sole causal
attribution to the product.

The report MUST additionally return `featureMappings`. Only completed journeys with an explicit
`feature.fingerprint` MAY contribute; each group MUST be uniquely identified by the pair of feature
fingerprint and `measurementContextId`. The search axis MUST use the same explainable cohort
contract. The code axis MUST return confirmed target locators, counts of observed/unavailable
complexity, and deduplicated evidence variants with their respective session counts. Variants with
different target locators, `metricsScopeId`, `metricsVersion` or `indexGeneration` MUST NOT be
averaged. Missing metric evidence MUST NOT be treated as zero. The sum of
`featureMappings[*].search.completedSessionCount` MUST equal
`sessionCounts.featureTaggedCompleted`; no explicitly tagged completion may disappear silently or
be counted repeatedly across mappings.

Search and code axes MUST NOT be condensed into a shared score, a correlation or a causal quality
claim. In particular, an embedding MUST NOT be called a complexity metric. Multiple targets can
reflect necessary feature breadth or unclear ownership; different locator precision can make the
same physical code area appear repeatedly. The report MUST preserve these limitations as caveats.
A caller-declared feature ID and confirmed locator are not independent verification of feature
semantics, domain correctness, stability or code ownership; none of these properties MAY be
claimed from `featureMappings`.

---

<a id="14-dateiabhängigkeitsgraph"></a>

## 14. File dependency graph

<a id="141-knoten"></a>

### 14.1 Nodes

A file node MUST contain:

```text
workspace_id, repo_id, ref_id, file_id, file_path, language,
content_hash, imports, dependencies, dependents, graph_generation
```

<a id="142-kanten"></a>

### 14.2 Edges

At least:

```text
import
re_export
dynamic_import
package_dependency
cross_repo_package
```

An edge MUST reference source positions of its originating import sites when the parser supplies them.

<a id="143-auflösung"></a>

### 14.3 Resolution

Resolvers SHOULD support:

- Relative and absolute imports;
- TypeScript `paths` and `baseUrl`;
- Node package exports;
- npm/pnpm/Yarn workspaces;
- Python packages and relative imports;
- Go modules and `go.work`;
- Cargo workspaces;
- Maven/Gradle modules;
- .NET solutions/projects;
- Composer PSR-4;
- Configurable aliases.

Unresolved imports MUST be counted and made visible.

<a id="144-graphmetriken"></a>

### 14.4 Graph metrics

At least:

- Node and edge counts;
- In-/out-degree;
- Orphans;
- Strongly connected components;
- Circular dependencies;
- Import resolution rate;
- Repository and language distribution;
- Top central files.

---

<a id="15-symbolgraph"></a>

## 15. Symbol graph

<a id="151-symbolknoten"></a>

### 15.1 Symbol nodes

```ts
interface SymbolNodeV1 {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  signature?: string;
  repoId: string;
  refId: string;
  fileId: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  exportedAs?: string[];
  visibility?: string;
  contentHash: string;
}
```

### 15.2 Call Edge

```ts
interface CallEdgeV1 {
  callerId: string;
  calleeName: string;
  calleeCandidates: string[];
  confidence: "local" | "unique" | "ambiguous" | "external" | "unresolved";
  callSite: {
    repoId: string;
    refId: string;
    filePath: string;
    line: number;
    column?: number;
  };
}
```

<a id="153-symbolfunktionen"></a>

### 15.3 Symbol operations

Untangle MUST support:

- Listing symbols in a file;
- Searching workspace symbols by name/FQN;
- Returning definitions, callers and callees;
- Traversing call flow forward;
- Traversing impact backward;
- Showing ambiguities and confidence;
- Applying depth limits and cycle protection.

---

## 16. Complexity Engine

### 16.1 Scope

Metrics are stored at these scopes:

```text
symbol
file
repository
workspace
change
```

Retrieval chunks may mirror symbol metrics, but must carry `metrics_scope_id` so aggregations do not double-count them.

### 16.2 Cyclomatic Classic

Base value per executable symbol:

```text
M = 1 + decision_points
```

`decision_points` includes at least:

- `if`;
- `else if` as a separate decision;
- `for`, `while`, `do while`, `for each`;
- `catch`;
- Conditional/ternary expressions;
- Additional `case`/`match` arms according to the language adapter;
- Guards when they produce independent paths.

### 16.3 Cyclomatic Extended

`cyclomatic_extended` equals classic plus:

- Independent `&&`/`||` decision groups;
- Pattern alternatives;
- Language-specific short-circuit branches.

Adapter rules MUST be versioned and protected by golden tests.

### 16.4 Cognitive Complexity

Algorithm ID: `untangle-cognitive-v1`.

Basic rules:

- A break in control flow produces a base contribution.
- Nesting produces an additional contribution.
- `else if` is treated as a continuation and does not receive a full new nesting increment.
- Logical operator sequences are grouped.
- Recursion is marked and MAY produce a contribution.
- Local functions/lambdas use a documented nesting context.
- Every contribution MUST contain source position, kind, base and nesting contribution.

```ts
interface CognitiveContributionV1 {
  line: number;
  column?: number;
  kind: string;
  base: number;
  nestingPenalty: number;
  total: number;
  note?: string;
}
```

<a id="165-strukturelle-metriken"></a>

### 16.5 Structural metrics

At least:

```text
physical_loc
sloc
blank_lines
comment_lines
doc_lines
function_count
method_count
class_count
interface_count
parameter_count
return_count
exit_point_count
max_nesting
avg_nesting
fan_in
fan_out
import_in_degree
import_out_degree
afferent_coupling
efferent_coupling
instability
inheritance_depth
public_api_count
```

<a id="166-textuelle-und-lexikalische-metriken"></a>

### 16.6 Textual and lexical metrics

At least:

```text
character_count
byte_count
token_count
avg_line_length
max_line_length
comment_ratio
doc_ratio
identifier_count
unique_identifier_count
avg_identifier_length
identifier_entropy
magic_literal_count
todo_count
fixme_count
hack_count
operator_count
operand_count
unique_operator_count
unique_operand_count
```

### 16.7 Halstead

Using:

```text
n1 = unique operators
n2 = unique operands
N1 = total operators
N2 = total operands
n = n1 + n2
N = N1 + N2
volume = N * log2(max(n, 1))
difficulty = (n1 / 2) * (N2 / max(n2, 1))
effort = difficulty * volume
```

Time and estimated bugs MAY additionally be returned, but must be labeled as estimates.

<a id="168-syntaktische-metriken"></a>

### 16.8 Syntactic metrics

At least:

```text
ast_node_count
ast_max_depth
ast_avg_depth
ast_branching_factor_avg
ast_branching_factor_max
statement_count
expression_count
declaration_count
control_flow_node_count
control_flow_density
lambda_count
async_construct_count
exception_construct_count
pattern_match_count
node_kind_entropy
ast_nodes_per_sloc
parse_error_node_count
missing_node_count
```

### 16.9 Maintainability Index

Untangle MUST explicitly return the formula used. Default:

```text
MI_raw = 171
         - 5.2 * ln(max(HalsteadVolume, 1))
         - 0.23 * CyclomaticClassic
         - 16.2 * ln(max(SLOC, 1))

MI = clamp(MI_raw * 100 / 171, 0, 100)
```

Version 1 uses no comment bonus, keeping results more stable across languages.

### 16.10 Aggregation

File/repository/workspace aggregations MUST return at least:

- Count;
- Sum;
- Mean;
- Median;
- Maximum;
- p90 and p95;
- SLOC-weighted mean;
- Count above configured thresholds.

Duplicate retrieval fragments MUST be deduplicated through `metrics_scope_id`.

---

## 17. Change Intelligence

<a id="171-vergleichsmodi"></a>

### 17.1 Comparison modes

Untangle MUST support:

```text
working tree vs HEAD
index/staged vs HEAD
base ref vs head ref
base commit vs head commit
stored generation vs current filesystem
```

### 17.2 Change Entity

```ts
interface ChangeEventV1 {
  schemaVersion: 1;
  changeId: string;
  workspaceId: string;
  repoId: string;
  baseRef: string;
  headRef: string;
  baseCommit?: string;
  headCommit?: string;
  changedAt: string;
  changeKind: "added" | "modified" | "deleted" | "renamed" | "moved" | "moved_and_renamed";
  oldSymbolId?: string;
  newSymbolId?: string;
  oldFilePath?: string;
  newFilePath?: string;
  textDiffSummary: DiffSummaryV1;
  astDiffSummary?: AstDiffSummaryV1;
  complexityDelta?: ComplexityDeltaV1;
  graphDelta?: GraphDeltaV1;
  blastRadius?: ImpactSummaryV1;
  risk?: RiskScoreV1;
}
```

<a id="173-symbol-matching"></a>

### 17.3 Symbol matching

Order:

1. Identical stable symbol ID;
2. Identical FQN and normalized signature;
3. Identical AST fingerprint;
4. Token/MinHash similarity;
5. Structural similarity plus path proximity;
6. Optional embedding cosine with the same profile;
7. Otherwise add/delete.

Every rename/move association MUST return confidence and the signals used.

### 17.4 Complexity Delta

For each matched entity:

```text
delta = head_value - base_value
relative_delta = delta / max(abs(base_value), epsilon)
```

New and deleted symbols are reported separately, not as infinite relative deltas.

### 17.5 Graph Delta

At least:

- Added/removed file imports;
- Added/removed symbol calls;
- Added/removed cross-repository edges;
- Added/removed cycles;
- Changed fan-in/fan-out;
- Changed impact size.

### 17.6 Risk Score

Default components, each normalized to `[0,1]`:

```text
0.25 * churn
0.20 * positive_cognitive_delta
0.15 * positive_cyclomatic_delta
0.15 * blast_radius
0.10 * graph_centrality
0.10 * semantic_change
0.05 * test_distance
```

```ts
interface RiskScoreV1 {
  value: number;
  level: "low" | "medium" | "high" | "critical";
  algorithm: "untangle-risk-v1";
  components: Record<string, { value: number; weight: number; contribution: number }>;
  caveats: string[];
}
```

A risk score MUST NOT be returned without components and caveats.

### 17.7 Change Search

Change events SHOULD receive their own dense and BM25 text, for example:

```text
Modified AuthService.validateUser in backend.
Cognitive complexity increased from 14 to 24.
Added calls to IdentityClient.rotateToken.
Introduced cross-repository dependency backend → identity.
```

This MUST enable requests such as:

> "Which changes made authentication more complex last month?"

---

## 18. Quality Gates

### 18.1 Delta-first

With `ignoreExistingViolations=true`, existing violations MUST NOT worsen the gate status. Only new or aggravated violations are evaluated.

<a id="182-gate-ergebnis"></a>

### 18.2 Gate result

```ts
interface QualityGateResultV1 {
  status: "passed" | "warning" | "failed" | "incomplete";
  base: string;
  head: string;
  violations: QualityViolationV1[];
  improvements: QualityImprovementV1[];
  analysisCoverage: {
    filesChanged: number;
    filesAnalyzed: number;
    symbolsChanged: number;
    parseFailures: number;
  };
}
```

### 18.3 Exit Codes

```text
0 = passed
1 = gate failed
2 = configuration or infrastructure error
3 = incomplete analysis when policy requires completeness
4 = cancelled
```

---

## 19. Context Artifacts

<a id="191-konfiguration"></a>

### 19.1 Configuration

```ts
interface ContextArtifactConfig {
  name: string;
  path: string;
  description: string;
  type?: "auto" | "sql" | "openapi" | "asyncapi" | "protobuf" | "markdown" | "terraform" | "kubernetes" | "text";
  include?: string[];
  exclude?: string[];
}
```

<a id="192-anforderungen"></a>

### 19.2 Requirements

- Names MUST be unique within a project.
- Files and directories MUST be supported.
- Artifact configuration and content hash MUST determine staleness.
- Search MUST be filterable by artifact name and type.
- Format parsers SHOULD use semantic sections rather than only fixed line windows.
- Raw content and source ranges MUST be preserved.

---

<a id="20-cli-spezifikation"></a>

## 20. CLI specification

<a id="201-globale-optionen"></a>

### 20.1 Global options

```text
--config <path>
--workspace <id|path>
--repo <id[,id...]>
--ref <name[,name...]>
--format text|json|jsonl|markdown
--log-level error|warn|info|debug|trace
--quiet
--no-color
--profile
```

<a id="202-befehle"></a>

### 20.2 Commands

```text
untangle init [path] [--interactive|--no-interactive] [--vision=path] [--spec=path] [--feature-map=path]
untangle doctor
untangle index [path] [--background] [--full]
untangle update [path]
untangle stop [--job <id>]
untangle watch [start|stop|status]
untangle status [--job <id>]
untangle search <query>
untangle context list|index|search|remove
untangle graph build|status|query|stats|cycles|visualize|remove
untangle symbols list|get
untangle impact <file-or-symbol>
untangle flow [entrypoint]
untangle complexity get|explain|hotspots|diff
untangle product [--root=path] [--manifest=path] [--feature=id] [--path=literal-path] [--test-evidence=path] [--max-cognitive=15] [--require-complete] [--format=text|json] [--run-tests -- <Vitest-compatible argv>]
untangle changes analyze|show|search
untangle gate
untangle projects list|remove
untangle config show|validate|schema
untangle mcp --stdio
untangle version
```

<a id="2021-lokaler-produktkontext-beim-init-v1"></a>

### 20.2.1 Local product context in `init` V1

This sub-contract is integrated into `untangle init`. It describes local document findings and a
review draft; the remaining command list in §20.2 remains the target portfolio.

- `init` MUST use the specified project directory; it does not infer another project root from
  Git metadata. Without a path, the current directory applies.
- The existing file inventory MUST be reused for product documents. Ignore rules, security
  omissions and size/scan limits remain unchanged. V1 defaults to at most 50,000 inventoried files
  and 32 assessed document sources; reached limits MUST appear as limitations. Before Markdown
  assessment, V1 MUST check linearly that no line exceeds 16,384 UTF-16 code units and no document
  contains more than 4,096 opening square brackets (`[`) or 2,048 heading candidates. The heading
  precheck conservatively counts every line starting with `#` after `trimStart`, including code
  blocks. Exceeding a limit MUST leave the source `not_assessed`, retaining its content hash, and
  make the overall finding `incomplete`; headings and references in that content are not interpreted.
- Candidate roles are `vision`, `specification` and `product`. Vision and specification are
  required; the product description is optional. Filenames provide only a provisional selection
  (`filename_candidate`), not semantic classification.
- `--vision=PATH` and `--spec=PATH` explicitly select the respective source (`explicit`). Paths
  refer to the project directory and MUST NOT bypass the scanner to read excluded or external sources.
- `findings.productContext` MUST contain `schemaVersion: 1`, sources, selection status,
  missing/ambiguous roles, document references, limitations, a review draft and
  `referencesTruncated: boolean`. Its statuses are `needs_context`, `needs_selection`,
  `ready_for_review` and `incomplete`. None confirms domain alignment.
- Every source MUST expose role, path, selection, selection reason and an assessment status:
  `readable`, `empty`, `unreadable`, `changed`, `not_in_scan` or `not_assessed`. Available content
  evidence is `contentHash` and `scannedContentHash`; sections contain titles and
  `startLine`/`endLine`. Changed or unassessed content MUST NOT appear as a successfully checked source.
- Local document references MUST expose source path/line, target path and a status: `present`,
  `missing`, `not_in_scan` or `outside_workspace`. `present` with `targetContentHash` confirms only
  target path and hash from the accepted inventory. It does not check anchor resolution, code
  conformance, feature assignment or ownership. V1 assesses at most 256 local references. Only an
  actual additional local reference MUST trigger `referencesTruncated: true`, a limitation and
  `incomplete`; exactly 256 references alone do not count as truncation.
- `alignment` MUST always remain `{ status: "unverified", reason:
  "feature_and_ownership_not_confirmed" }`. `reviewDraft.features` and `reviewDraft.ownership` MUST
  start empty; `reviewDraft.questions` contains questions to complete. Features, owners and Search
  Journey feature IDs MUST NOT be invented from filenames, headings, text similarity or embeddings.
- Product context findings require neither an LLM, embeddings nor network access. Existing service
  probes remain separate; `--offline` suppresses them.
- Only selected readable sources MAY enter the TOML proposal as Markdown `contextArtifacts`.
  These are configuration references; this does not claim the separate artifact search from §19
  is wired into CLI/MCP. Regular Markdown indexing and search remain available.
- Noninteractive `init` MUST write only configuration, not product documents, feature/ownership
  maps or journey data. `--dry-run` writes nothing. Differing existing configuration is retained
  without `--force`; missing product documents alone do not make an otherwise valid init run fail.
- Findings and rendering MUST be deterministic for unchanged inputs. The complete finding MUST be
  available through `--format=json`. V1 thereby extends CLI output; it introduces no new MCP init tool.

<a id="geführte-terminal-einrichtung"></a>

#### Guided terminal setup

- With real stdin/stderr TTYs, text output without `CI`, `--offline` or `--dry-run` may use the
  guided flow. `--interactive` selects it explicitly; `--no-interactive` preserves the previous
  configuration-focused flow. Pipes, JSON and dry-run must never prompt implicitly. Explicit
  `--interactive` combined with JSON/dry-run, or missing TTYs, are usage errors before any write.
- The flow first shows local findings, selected sources, optional integrations, destination files,
  downloads and commands to execute. Only the final selection may write. Preparation and execution
  are separate options. Offline may only prepare. Escape, Ctrl-C, EOF and process interruption must
  release input listeners and terminal mode; external processes never run under raw mode belonging
  to a still-open input prompt.
- Only deliberately selected setup recipes may be stored under the project root in
  `.untangle/setup/` and `.untangle/tools/`. Other files, credentials and containers are not
  overwritten, deleted or taken over. Existing configuration remains unless explicitly selected
  for overwrite. Partial failures and incomplete setup remain visible states.
- Tool offers are CLI setup data. External analyzers are not bundled as runtime dependencies.
  User-generated format manifests pass through the existing digest, project-trust, license and
  credential gates. Tokens are referenced only through named environment variables or private
  credential storage. An installed server, binary or MCP template does not prove a scan.
- `graph features` and the corresponding confirmed TUI selection may generate local HTML/JSON
  views under `.untangle/feature-map/`. They use complete declared feature metrics, code/test
  scopes, intent references and ownership. Display budgets never shrink the underlying measurement
  scope; omissions and missing maps remain visible. No index, embedding service or test process is
  required. A browser opens only after explicit TUI selection. The view is a snapshot; declared
  feature dependencies are not independently measured runtime calls.
- The feature view MUST offer actual three-dimensional positions, perspective projection and
  interactive rotation/zoom. Spatial proximity and curved threads are layout choices, not evidence
  of semantic similarity, causal ownership or runtime coupling. Animation MUST be optional and
  bounded, respect reduced-motion/visibility, and retain keyboard/list access to the same data.
- English is Untangle's product language for controls, help, diagnostics, generated comments,
  repository-owned feature labels and documentation. Inspected project content, stable machine
  identifiers and third-party notices retain their original values; translation must not silently
  change an API field, error code or a user declaration.

#### Native spec-driven development connectors

- `untangle product connect [auto|spec-kit|openspec]` MUST inspect local framework artifacts without
  running framework scripts, installing tools, contacting a provider or executing tests. `--dry-run`
  writes nothing. Explicit connection MAY save versioned, source-bound report/manifest artifacts
  only under the selected physical project's `.untangle/sdd/` directory.
- Spec Kit support reads its `.specify` marker/constitution, `specs/<feature>/` specifications,
  plans and tasks, including safe in-project `feature.json` feature-directory selections. OpenSpec
  support reads current capability specs and active change proposals, designs, tasks and delta specs.
  Archives and arbitrary custom schema generators MUST remain outside the supported scope unless
  explicitly implemented and tested.
- Reports MUST retain requirement/task identities, source paths/lines/hashes, checked-task state,
  explicit file references and unresolved/unsafe inputs. A checkbox, scenario, filename or document
  title MUST NOT confirm implementation, passing tests, ownership or semantic conformance.
- Generated feature manifests MUST remain `planned`/`proposed`, with no invented owners or dependency
  edges. Code/test selections may contain only actual resolved literal in-root references; they
  remain proposed boundaries requiring review. Removed delta requirements MUST stay visible as
  evidence without becoming proposed passing criteria.
- The writer MUST revalidate the inspected source snapshot, reject stale previews and preserve
  existing differing files and symlink boundaries. A selected SDD connection in spec-driven TUI
  setup is read-only until final confirmation, and its confirmed draft path is passed explicitly
  to the final feature inspection/map. Existing user declarations MUST NOT be replaced implicitly.
- Connector evidence and product alignment retain separate coverage/freshness contracts. Reading
  a supported framework does not make an ignored source accepted by the product scanner, nor does
  an imported review draft make an incomplete feature consistent.

<a id="2022-deklarierter-featureabgleich-v1"></a>

### 20.2.2 Declared feature alignment V1

- `untangle product` and MCP `untangle_product` MUST evaluate an explicitly declared
  `ProductFeatureManifestV1`. The default path is `untangle.features.json` in the selected project
  root. Feature IDs, owners and acceptance criteria MUST NOT be generated as confirmed from search
  queries, filenames or embeddings. Without a manifest, the result is `needs_manifest` with an empty
  draft; the command writes no files.
- CLI `--draft --feature=ID --path=PATH` MAY return a caller-named single-feature draft in
  `report.draft` when the map is absent. The path MUST be fresh in the accepted inventory.
  `planned`/`proposed` status and empty intent/owner/test/criteria fields MUST preserve open
  decisions. The proposal does not replace an existing map and MUST point out that the complete
  responsibility, including helpers, must be added.
- `--path` or MCP `path` MAY select exactly one root-relative literal path from a search hit.
  Absolute paths, traversal and globs MUST be rejected. `selection` MUST identify matching
  features with `code`, `test`, `intent`, `ownership` roles; missing, ignored or unassigned paths
  remain visible. Selected features MUST retain their complete measurement scope; global coverage
  and the shared-code union remain intact.
- A feature MUST carry its stable ID, `implemented` or `planned`, review status `proposed` or
  `confirmed`, vision/spec references with path and heading, owner references, code/test selections,
  criteria and declared `dependsOn` edges. Sources resolve exactly by normalized heading; missing
  or ambiguous sources remain visible evidence gaps.
- Ownership MUST appear as a sourced manifest declaration. `declared` does not mean independently
  confirmed human responsibility. A `confirmed` entry MUST carry `confirmedBy`; that identity is
  not independently authenticated. Unknown ownership MUST NOT be invented.
- Analysis MUST use the current accepted local scan with content hashes, retain ignore rules and
  security boundaries, and identify unscanned, changed, unreadable or incompletely analyzed sources.
  Complete declared code scopes, including private helpers, MUST be measured; individual retrieval
  hits do not replace them.
- Code and test metrics MUST remain separate. Cognitive Complexity and cyclomatic classic/extended
  MUST report `top_level`, `execution_unit` and `self` separately, including scope/execution-unit
  counts and SLOC. `execution_unit` is the primary reading. Cyclomatic values include a base per
  contributing scope. Missing analysis MUST NOT count as zero complexity.
- Shared code paths MUST be visible. `mappedCodeUnion` MUST count the unique union; summing all
  feature values does not produce an overall metric. Unassigned analyzable code MUST remain visible
  in coverage. `dependencyCycles` refers to declared feature edges, not code-proven file/symbol cycles.
- `--test-evidence` MAY read a `ProductTestEvidenceV1` report: version, `sourceTreeBefore`,
  `sourceTreeAfter`, actual command, exit code and test identities `{path, name, status}`. Both
  digests MUST match the complete current `sourceTreeDigest`. Git HEAD does not replace this
  binding. Analysis alone runs no tests and labels the evidence `supplied_source_bound_report`.
- Only CLI `--run-tests -- <argv>` MAY execute an explicitly requested Vitest-compatible command
  without a shell; the MCP read tool still executes no processes. The option MUST NOT be combined
  with `--test-evidence`. Untangle MUST manage the JSON reporter and output path, retain timeout,
  output limits and child-process cancellation, and capture original reports, stdout/stderr, complete
  accepted before/after inventories, test identities and artifact hashes in an exclusive OS temporary
  directory. `testRun.receiptPath` MUST make the proof discoverable. A source change, invalid report
  or runner error MUST NOT produce passed source binding. Failed cases and skips MUST NOT disappear.
  The run does not authenticate runner-supplied data. Runner errors use exit 1; normally completed
  failed tests use exit 5; the report remains available.
- Existing tests MUST NOT count as executed. Criteria MUST explicitly declare either complete
  test-file contracts or specific `testNames`; skips do not count as success. Invalid, stale,
  failed or unexecuted evidence MUST remain identifiable. Source-bound tests are no formal proof
  of complete domain behavioral equivalence.
- `--max-cognitive` sets a default limit of 15 per execution unit; declared budgets and structural
  agent hints remain inspectable. File dispersion, shared responsibility, multiple owners and
  feature cycles are heuristics, not a universal product complexity score. Search suggestions MAY
  request fresh independent symbol/path checks.
- Report status MUST be `needs_manifest`, `invalid_manifest`, `needs_review`, `incomplete`,
  `violated` or `evidence_consistent`. Normal reports return exit 0; `--require-complete` returns
  exit 5 for any status except `evidence_consistent`. Semantic conformance remains
  `not_independently_proven`, and ownership authority remains `manifest_declarations`.
- `init --feature-map` MAY include the declared map alongside unverified document context from
  §20.2.1. Without an override, `untangle.features.json` is sought. The product-context alignment
  statement remains independent; no feature map is written or automatically confirmed.

Manifest examples, test reports and measurement limits are documented in
[`docs/FEATURE_ALIGNMENT.md`](./docs/FEATURE_ALIGNMENT.md). The self-map remains a declared
proposal; its feature count is not an objective richness score.

<a id="203-ausgabe"></a>

### 20.3 Output

- `--format json` MUST write only valid JSON to stdout.
- Logs MUST go to stderr in this mode.
- `--format jsonl` MUST support streaming progress.
- Text output MUST NOT contain automation-required information absent from JSON.

---

<a id="21-mcp-spezifikation"></a>

## 21. MCP specification

<a id="211-werkzeugnamen"></a>

### 21.1 Tool names

Version 1:

```text
untangle_index
untangle_update
untangle_stop
untangle_watch
untangle_status
untangle_health
untangle_projects

untangle_search
untangle_search_session
untangle_context_list
untangle_context_index
untangle_context_search
untangle_context_remove

untangle_graph_build
untangle_graph_status
untangle_graph_query
untangle_graph_stats
untangle_graph_cycles
untangle_graph_visualize
untangle_graph_remove

untangle_symbols
untangle_symbol
untangle_flow
untangle_impact
untangle_cross_repo_impact

untangle_complexity
untangle_product
untangle_complexity_explain
untangle_hotspots
untangle_complexity_diff

untangle_changes
untangle_change_search
untangle_quality_gate

untangle_about
```

Together with the seven normative portfolio tools from [`portfolio.md`](./portfolio.md),
including `untangle_product`, the list contains **41** tool names.

<a id="search-session-werkzeug"></a>

#### Search session tool

`untangle_search_session` MUST accept exactly these discriminated actions:

```ts
type SearchSessionInputV1 =
  | { action: "start"; goal: string; featureId?: string; retainText?: boolean }
  | { action: "get"; sessionId: string }
  | {
      action: "observe";
      sessionId: string;
      kind: "open-file" | "open-symbol" | "graph-query" | "other-tool";
      toolName?: string;
      target?: SearchJourneyTargetV1;
    }
  | {
      action: "complete";
      sessionId: string;
      target: SearchJourneyTargetV1;
      acceptedAttemptId?: string;
    }
  | {
      action: "abandon";
      sessionId: string;
      reasonCode?:
        | "target-not-found"
        | "task-changed"
        | "retrieval-unavailable"
        | "cancelled"
        | "other";
      reason?: string;
    }
  | { action: "report" };
```

`start`, `get`, `observe`, `complete` and `abandon` MUST return the action and `SearchJourneyV1`.
`report` MUST return the action and `DynamicProductComplexityReportV1`. Workspace scope follows
the same optional `root`/`workspaceId` rules as other read-only MCP tools.

`untangle_search` MAY additionally accept this purely observational coupling:

```ts
session?: { id: string; step?: number } // step: positive integer, max. 128
```

This coupling MUST NOT change the normalized query, query fingerprint, retrieval, ranking, hits
or search error semantics. After successful recording, the search response MUST carry:

```ts
searchObservation: {
  sessionId: string;
  attemptId: string;
  status: "recorded";
}
```

If only the journey observation cannot be saved, the domain-successful search MUST remain
successful and instead respond visibly with:

```ts
searchObservation: {
  sessionId: string;
  status: "not_recorded";
  warningCode: string;
}
```

A search error SHOULD be recorded as a failed attempt in a valid active journey. Even then, a
recorder error MUST NOT hide or reinterpret the original search error.

### 21.2 Tool Response Envelope

Every tool MUST supply a text segment and SHOULD supply a structured segment:

```ts
interface ToolResponseEnvelopeV1<T> {
  schemaVersion: 1;
  ok: boolean;
  operation: string;
  workspaceId?: string;
  data?: T;
  warnings: ToolWarningV1[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  indexState?: {
    generationId: string;
    status: string;
    stale: boolean;
  };
}
```

<a id="213-mcp-sicherheit"></a>

### 21.3 MCP security

- Tool path parameters MUST be validated against allowed workspace roots.
- The MCP server MUST NOT execute arbitrary external commands.
- Mutating tools MUST explicitly show scope and destination.
- Remove/reset operations MUST require an explicit destination.

---

## 22. Programmatic API

`@untangle-code/core` SHOULD export these stable facades:

```ts
createUntangle(options): UntangleEngine
createWorkspace(config): WorkspaceHandle
createQdrantStore(config): VectorStore
createOllamaEmbedder(config): Embedder
createParserRegistry(config): ParserRegistry
createComplexityEngine(config): ComplexityEngine
```

`UntangleEngine`:

```ts
interface UntangleEngine {
  index(request: IndexRequest): AsyncIterable<JobEvent>;
  update(request: UpdateRequest): AsyncIterable<JobEvent>;
  search(request: SearchRequestV1): Promise<SearchResponseV1>;
  getSymbol(request: SymbolRequest): Promise<SymbolResponse>;
  impact(request: ImpactRequest): Promise<ImpactResponse>;
  complexity(request: ComplexityRequest): Promise<ComplexityResponse>;
  analyzeChanges(request: ChangeRequest): Promise<ChangeReportV1>;
  qualityGate(request: QualityGateRequest): Promise<QualityGateResultV1>;
  close(): Promise<void>;
}
```

Public APIs MUST support abort signals.

---

<a id="23-health-und-observability"></a>

## 23. Health and observability

<a id="231-health-komponenten"></a>

### 23.1 Health components

```text
node_runtime
configuration
workspace_paths
qdrant_connectivity
qdrant_schema
ollama_connectivity
embedding_model
embedding_dimensions
index_metadata
watcher
locks
graph_generation
```

### 23.2 Logs

- Structured logs;
- A correlation ID per tool/CLI operation;
- A job ID per index run;
- Secrets and complete source text redacted by default;
- Configurable log levels;
- MCP logging notifications when the host supports them.

### 23.3 Metrics

The core engine SHOULD expose internal counters:

```text
files_scanned
files_changed
chunks_created
embeddings_requested
embedding_cache_hits
qdrant_upsert_bytes
search_latency_ms
parse_failures
resolved_import_ratio
resolved_call_ratio
watcher_reconciliations
```

Export to external monitoring systems is optional.

---

<a id="24-security-und-privacy"></a>

## 24. Security and privacy

- Local-first is the default.
- Telemetry MUST be off by default.
- Search Journeys MUST be local and opt-in. Starting one consents to exactly that session; it
  MUST NOT activate global or future recording.
- Goal and query text MAY be persisted only with `retainText: true`. Journey candidates MUST NOT
  persist chunk content or source text. Free-form failure reasons and abandonment details MUST NOT
  be persisted without `retainText`; a controlled abandonment reason code MAY remain as text-free
  lifecycle metadata.
- Goal and query fingerprints MUST use a random workspace-local, domain-separated HMAC-SHA-256
  key. The key MUST be stored outside session files at
  `.untangle/product-complexity/fingerprint.key`. This is pseudonymization, not anonymization or
  encryption: anyone holding the complete local state, including the key, can test guesses.
  Locator, rank, score, explicit tool and lifecycle metadata remain independently of `retainText`
  and MUST NOT contain secrets.
- On platforms with POSIX file modes, the local filesystem adapter MUST create the HMAC key and
  newly written journey records with mode `0600`.
- In version 1, local journey records have no automatic TTL or deletion action and remain until
  local product-complexity state is deliberately removed.
- Source code MUST NOT be sent to an Untangle service without being asked.
- Remote endpoints MUST be visible in effective configuration.
- API keys MUST NOT appear in status, logs or crash reports.
- Project configuration SHOULD contain no secrets.
- Path traversal outside configured roots MUST be prevented.
- Symlinks MUST be checked for workspace escape.
- Docker containers SHOULD run with the minimum necessary privileges.
- Release artifacts MUST include an SBOM and provenance.

---

<a id="25-zuverlässigkeit-und-fehlerverhalten"></a>

## 25. Reliability and error behavior

<a id="251-fehlerklassen"></a>

### 25.1 Error classes

```text
CONFIG_INVALID
WORKSPACE_NOT_FOUND
PATH_OUTSIDE_WORKSPACE
PARSER_UNAVAILABLE
EMBEDDING_UNAVAILABLE
EMBEDDING_DIMENSION_MISMATCH
QDRANT_UNAVAILABLE
QDRANT_SCHEMA_INCOMPATIBLE
INDEX_INCOMPLETE
INDEX_PROFILE_MISMATCH
LOCK_HELD
JOB_CANCELLED
GRAPH_INCOMPLETE
ANALYSIS_INCOMPLETE
POINT_TOO_LARGE
PLUGIN_ENGINE_INCOMPATIBLE
SEARCH_SESSION_NOT_FOUND
SEARCH_SESSION_CONFLICT
SEARCH_SESSION_INVALID_STATE
```

<a id="252-prinzipien"></a>

### 25.2 Principles

- "Not found" and "infrastructure failure" MUST NOT be treated as equivalent.
- Network failures must not trigger automatic destructive recreation.
- Read operations SHOULD degrade gracefully when optional data is absent.
- Write operations MUST fail closed when consistency is not guaranteed.
- Error responses MUST include retryability and actionable guidance.

---

<a id="26-performance-ziele"></a>

## 26. Performance targets

These targets are release gates, not guarantees for every hardware configuration.

### 26.1 Index

On a reference machine with local Qdrant and locally accelerated Ollama:

- 100,000 LOC: the first usable search index SHOULD be available within a few minutes;
- Unchanged update: SHOULD finish without an embedding call;
- Changing a single medium-sized file: the search index SHOULD typically be current within 10 seconds;
- Memory consumption MUST be bounded by configurable concurrency.

### 26.2 Search

- Warm single-profile search P95 SHOULD stay below 2 seconds.
- Qdrant querying and Ollama query embedding MUST be measured separately.
- Cross-repository search across ten repositories SHOULD NOT multiply query embeddings linearly.

### 26.3 Graph

- Queries on persisted graph indexes SHOULD work without loading the entire symbol graph.
- Traversals MUST have depth and result limits.

---

<a id="27-tests-und-konformität"></a>

## 27. Tests and conformance

<a id="271-testebenen"></a>

### 27.1 Test levels

- Unit tests for parser adapters, chunkers, metrics and ranking;
- Golden tests per language;
- Qdrant integration tests;
- Ollama contract tests with mocks and optionally live;
- Multi-repository fixtures;
- Watcher and crash/resume tests;
- MCP tool contract tests;
- CLI snapshot tests;
- Plugin/engine compatibility tests;
- Performance benchmarks.
- Search Journey state-machine, privacy, idempotency and cohort tests.

<a id="272-pflicht-fixtures"></a>

### 27.2 Required fixtures

At least:

1. A TypeScript monorepo with workspaces;
2. A Python multi-package workspace;
3. A mixed frontend/backend/shared setup;
4. Intentional dependency cycles;
5. A large function for chunking and Cognitive Complexity;
6. Rename and move across files;
7. Parser errors and partially valid code;
8. A minified file;
9. Context artifacts;
10. Different embedding profiles.

<a id="273-retrieval-benchmark"></a>

### 27.3 Retrieval benchmark

Every fixture includes questions with ground truth:

```ts
interface RetrievalCase {
  query: string;
  expectedFiles: string[];
  expectedSymbols?: string[];
  forbiddenFiles?: string[];
}
```

At least Recall@5, Recall@10, MRR and repository diversity are evaluated.

Fixture benchmarks and real Search Journeys MUST be reported separately. Only a completely labeled
fixture catalog may support general retrieval metrics such as recall or precision; a journey with
exactly one confirmed target may supply only target-related ranks and effort indicators.

---

<a id="28-definition-of-done-für-version-1"></a>

## 28. Definition of Done for version 1

Version 1 is functionally complete when:

1. npm CLI and MCP work from the same package;
2. Managed and external Qdrant/Ollama are supported;
3. Full index, stop, resume, update and watchers work consistently;
4. AST chunking loses no indexable source ranges;
5. Dense + BM25 + RRF search works;
6. Cross-repository search works with correct provenance and profile separation;
7. File and symbol graphs are persistent and queryable;
8. Impact, flow, cycles and symbol views are available;
9. Cyclomatic, cognitive, structural, textual, syntactic and Halstead metrics are captured;
10. Change reports supply before/after deltas and rename/move candidates;
11. Quality gates detect new regressions;
12. Context artifacts are indexable and searchable;
13. Structured JSON contracts are versioned;
14. VS Code plus at least Claude Code and Cursor are connected through thin plugins/adapters;
15. The release pipeline creates signed, traceable npm and plugin artifacts.
16. Explicit Search Journeys record search attempts through the confirmed target and aggregate
    compatible v2 journeys with immutably bound corpus revisions into product-complexity cohorts,
    by default without raw goal, query or failure-reason text; legacy contexts remain visible but
    never sufficient.

---

<a id="29-nicht-bestandteil-von-spec-v1"></a>

## 29. Outside `spec-v1`

- Automatic code changes by the Untangle engine itself;
- A mandatory cloud service;
- A general chat frontend;
- A complete runtime tracing platform;
- Automatic security fix generation;
- Unbounded historical indexing of every Git commit;
- Direct rank comparability across incompatible embedding models;
- Plugin-specific forks of the analysis engine.
