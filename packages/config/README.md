# @untangle-code/config

Untangle configuration (WP-02): types, discovery, six-layer resolution, handwritten JSON Schema,
secret redaction, canonical effective configuration with hashes and `embedding_profile_id`, and
migration infrastructure for future `schemaVersion` changes. A public package
(`@untangle-code/config`, product.md §6.2).

Normative sources: [`spec.md`](../../spec.md) §4.1–§4.8, §5.7 (takes precedence),
[`product.md`](../../product.md) §11, [`architecture.md`](../../architecture.md) §6.3, §23.2,
[`portfolio.md`](../../portfolio.md) §13, §14.4.

`src/index.ts` is the only public interface. Its sole runtime dependency is
`@untangle-code/domain` (`workspace:*`); no other Untangle or external runtime dependencies.

<a id="modulübersicht"></a>

## Modules

| Module | Contents | Normative source |
|---|---|---|
| `types.ts` | `UntangleConfigV1`, `QdrantConfig`, `EmbeddingConfig`, `IndexConfig`, `SearchConfig`, `GraphConfig`, `ComplexityConfig`, `ChangeConfig`, `QualityGateConfig`, `TelemetryConfig`, `PortfolioConfig`/`PortfolioEnrichmentConfig`, `EffectiveUntangleConfigV1`, `RawConfigLayer`/`DeepPartial`; re-exports domain's `RepositoryConfig`/`ContextArtifactConfig` | spec §4.2–§4.7; portfolio §13, §14.4 |
| `defaults.ts` | Defaults per section, `PRODUCT_DEFAULT_CONFIG` (layer 6), `CURRENT_SCHEMA_VERSION` | spec §4.5; product §11 |
| `schema.ts` | Parsed `CONFIG_SCHEMA` and `CONFIG_SCHEMA_PATH` | arch §6.3, §7.3 |
| `discovery.ts` | `discoverConfigFile`, `discoverConfigFiles`: upward discovery to repository/filesystem root | spec §4.1 |
| `user-config.ts` | `resolveUserConfigDir`/`resolveUserConfigPath`: OS configuration directory | spec §4.1 layer 5 |
| `env.ts` | `ENV_MAPPING`, `buildEnvConfigLayer`: `UNTANGLE_*` to config paths | spec §4.1 layer 2 |
| `merge.ts` | `deepMergeConfig`, `mergeConfigLayers`: replace arrays, never concatenate | spec §4.1 |
| `paths.ts` | Canonical `resolveConfigPath`, `resolveRepositoryPaths`, relative to configuration file | spec §4.3 |
| `secrets.ts` | `redactSecrets`, `toRedactedJson`, `resolveApiKey` | spec §4.4/§4.5, §24; arch §23.2 |
| `hash.ts` | `computeConfigHash`, `deriveEmbeddingProfile`/`deriveEmbeddingProfileId` | arch §6.3; spec §5.1, §5.7 |
| `validate.ts` | `validateEffectiveConfig`, `assertConfigValid`, `assertEmbeddingDimensionsMatch` | spec §4.8 |
| `migrations.ts` | `registerMigration`, `migrateConfig`, `clearMigrations` | arch §6.3 |
| `load.ts` | `loadConfig`: orchestrates these modules | spec §4.1–§4.8 |

## Layering (spec.md §4.1)

Highest priority first; `loadConfig` merges in the following order, lowest first and last wins:

```text
1. Explicit API/CLI arguments        (loadConfig({ explicit }))
2. Environment variables             (UNTANGLE_*, see env.ts ENV_MAPPING)
3. .untangle.local.json              (upward discovery from cwd)
4. .untangle.json                    (upward discovery from cwd)
5. User configuration (OS directory) (user-config.ts)
6. Product defaults                  (defaults.ts PRODUCT_DEFAULT_CONFIG)
```

Merge semantics: objects merge recursively; **arrays replace completely**, never concatenate.
Replacing a full list such as `exclude` is the only way a higher layer can shrink it; silently
combining array sources would be unpredictable.

`.untangle.local.json` and `.untangle.json` are discovered **independently**, each searching upward
from `cwd` to the repository root (a directory containing `.git`) or filesystem root, whichever
comes first.

<a id="untangle_-umgebungsvariablen-auszug-additiv-erweiterbar"></a>

## `UNTANGLE_*` environment variables (excerpt, additively extensible)

| Variable | Configuration path |
|---|---|
| `UNTANGLE_WORKSPACE_ID` | `workspaceId` |
| `UNTANGLE_PROJECT_ID` | `projectId` |
| `UNTANGLE_QDRANT_MODE` / `_URL` / `_API_KEY_ENV` / `_COLLECTION_PREFIX` / `_REQUEST_TIMEOUT_MS` / `_MAX_RETRIES` | `qdrant.*` |
| `UNTANGLE_EMBEDDINGS_MODE` / `_URL` / `_API_KEY_ENV` / `_MODEL` / `_DIMENSIONS` / `_REQUEST_TIMEOUT_MS` | `embeddings.*` |
| `UNTANGLE_INDEX_WATCH` / `_MAX_FILE_SIZE_MB` / `_EXTRA_EXTENSIONS` (CSV) | `index.*` |
| `UNTANGLE_QUALITY_GATE_MODE` / `_MINIMUM_PARSE_QUALITY` | `qualityGate.*` |
| `UNTANGLE_TELEMETRY_ENABLED` / `_LOG_LEVEL` | `telemetry.*` |
| `UNTANGLE_PORTFOLIO_ENABLED` | `portfolio.enabled` |

The complete machine-readable table is `ENV_MAPPING` in `src/env.ts`. `*_API_KEY_ENV` sets another
environment variable's **name**, never its secret value (see Secrets).

## Secrets (spec.md §4.4/§4.5, §24; architecture.md §23.2)

`QdrantConfig.apiKeyEnv` / `EmbeddingConfig.apiKeyEnv` store only environment variable **names**, so
effective configuration structurally never contains secret values. `resolveApiKey(envVarName, env)`
resolves values at runtime on demand; results must never be written back to configuration objects.
`redactSecrets`/`toRedactedJson` provide additional protection: every field resembling a resolved
secret (`apiKey`, `token`, `secret`, `password`, `credential`, but NOT `...Env`) is replaced with
`[REDACTED]` before serialization, even if accidentally attached to configuration. Verified in
`secrets.test.ts`.

<a id="validierung-specmd-48"></a>

## Validation (spec.md §4.8)

`loadConfig` **never** throws for warnings or errors; it returns
`{ effectiveConfig, warnings, errors }`. Unknown top-level fields warn with the field name as path.
Invalid enums, unresolved core values (such as missing `qdrant.url` with `mode: "external"`),
duplicate repository/artifact IDs and `portfolio.blueprint.weights` sums outside `1.0 ± 0.001`
produce `CONFIG_INVALID`. Aborting is deliberately the caller's choice:
`assertConfigValid(result.errors)` throws a domain `UntangleError`.
`assertEmbeddingDimensionsMatch(configured, existing)` checks conflicts before the first upsert
(`EMBEDDING_DIMENSION_MISMATCH`).

<a id="korpusgebundene-relevanz-policies-wp-231"></a>

### Corpus-bound relevance policies (WP-231)

`search.relevancePolicies` deliberately has **no product default**. Raw cosine values and their
separation depend jointly on embedding profile and indexed corpus. Each entry is therefore keyed
by complete `embeddingProfileId` and bound to exactly one `workspaceId` and physical `collection`:

```toml
workspaceId = "workspace-stable-id"

[search.relevancePolicies."complete-embedding-profile-id"]
workspaceId = "workspace-stable-id"
collection = "untangle_project_code_profile_v1"

[search.relevancePolicies."complete-embedding-profile-id".policy]
calibrationId = "model/corpus/revision"
minimumDenseScore = 0.45
minimumDenseSpread = 0.061
denseReferenceRank = 50
minimumCandidateIdfCoverage = 0.291
```

If any profile/workspace/collection scope fails to match, search discards no results and reports
`RELEVANCE_POLICY_NOT_EVALUATED`. The same applies when retrieval did not actually reach the
calibrated dense reference rank or the sparse branch is missing. IDF evidence uses fixed
dense/sparse prefixes through the reference rank, so raising `candidateLimit` cannot move the
calibrated yes/no decision. Significant corpus changes require remeasurement. An already-indexed
workspace should declare a top-level `workspaceId`, otherwise adding the policy changes the
configuration hash and thus the derived workspace ID itself.

<a id="kanonische-effective-config-hash-und-embedding_profile_id"></a>

## Canonical effective configuration, hash and `embedding_profile_id`

`computeConfigHash(effectiveConfig)` equals `SHA256(canonical_json(effectiveConfig))`, using
domain's `canonicalJson`/`sha256Hex`. Without explicit `workspaceId`, `loadConfig` uses that hash as
`configHash` input to `buildWorkspaceId` (spec §5.1). `deriveEmbeddingProfile`/
`deriveEmbeddingProfileId` construct domain's `EmbeddingProfile` from `EmbeddingConfig` plus fixed
`DEFAULT_EMBEDDING_NORMALIZATION` (`"none"`) and `PREPARED_TEXT_VERSION`
(`"untangle-prepared-text-v1"`), then call `buildEmbeddingProfileId` (spec §5.7).

## Migration (architecture.md §6.3)

`registerMigration({ fromVersion, toVersion, migrate })` registers one step;
`migrateConfig(raw, targetVersion)` chains registered steps from `raw.schemaVersion` (default `1`)
to `targetVersion` (default `CURRENT_SCHEMA_VERSION`). Configuration already at the target version
undergoes **identity migration** and returns unchanged without requiring registered steps (tested).
`loadConfig` migrates each raw file configuration separately before merging it.

<a id="entscheidungen"></a>

## Decisions

1. **`RepositoryConfig`/`ContextArtifactConfig` re-export domain types instead of duplicating
   them.** Domain README decision 5 explicitly requires this for `RepositoryConfig`; the same
   applies to `ContextArtifactConfig` (BUILD_PLAN §3.3 lists it among domain core contracts).

2. **`SearchConfig`, `GraphConfig`, `ComplexityConfig`, `ChangeConfig` are designed here.**
   Spec.md §4.2 names them without shapes, unlike §4.4–§4.7's four concrete infrastructure/index/
   quality schemas. `TelemetryConfig` is likewise unspecified beyond mandatory default-off
   behavior (spec §24). Each shape references its closest normative source in `types.ts`:
   `SearchConfig` uses `SearchRequestV1`/§13.3 boosts, `GraphConfig` architecture.md §17.4 traversal
   limits, `ComplexityConfig` product.md §11's example, and `ChangeConfig` spec §17.6 risk defaults.
   Downstream work may extend them additively, not redefine them locally.

3. **`PortfolioConfig` follows portfolio.md §14.4 verbatim**, including every default; its required
   ±0.001 sum validation for `blueprint.weights` is implemented in `validate.ts`.

4. **JSON Schema lives in `packages/config/schemas/config-v1.json`, not root `schemas/`.**
   BUILD_PLAN §4 also assigns `schemas/**` to WP-02, but this package's task explicitly limited
   writes to `packages/config/**`. As noted in `openIssues`, an authorized owner must mirror it
   to `schemas/config-v1.json`. `schema.ts` resolves `../schemas/config-v1.json` from
   `import.meta.url`, working from both `src/` tests and `dist/` builds because both are siblings
   of `schemas/`.

5. **`additionalProperties: false` in JSON Schema despite spec §4.8's warn-not-fail rule.** The
   handwritten schema is tooling for editor completion/external validators; this package does not
   run it through a runtime schema validator such as ajv. `validate.ts` implements exact warning/
   abort semantics from spec §4.8 directly in TypeScript without another runtime dependency. The schema documents
   this decision in `description`.

6. **`normalization` and `preparedTextVersion` are not `EmbeddingConfig` fields but are required
   for `embedding_profile_id`.** Spec §4.5 lists exactly ten fields excluding them, while §5.7
   requires them for profile identity. Fixed defaults in `defaults.ts` supply
   `DEFAULT_EMBEDDING_NORMALIZATION = "none"` and
   `PREPARED_TEXT_VERSION = "untangle-prepared-text-v1"`; `deriveEmbeddingProfile`'s second
   argument can override them for future configuration extensions.

7. **Deep-partial raw layers (`RawConfigLayer`/`DeepPartial<T>`).** An individual file/environment/
   argument layer rarely supplies complete `QdrantConfig`/`EmbeddingConfig`; a shallow
   `Partial<UntangleConfigV1>` would still require every field within any supplied child object.
   `DeepPartial` makes every field recursively optional; after merging product defaults,
   `validate.ts` enforces actual requirements. Its condition deliberately uses `T extends object`
   rather than `T extends Record<string, unknown>`: the latter is structurally false for
   interfaces lacking index signatures in TypeScript conditional types, a verified compiler trap.

8. **`loadConfig` never throws itself.** File read errors, invalid JSON and validation failures all
   enter `errors`/`warnings`; only explicitly invoked `assertConfigValid` throws
   `UntangleError("CONFIG_INVALID", …)`. This follows the requested result-object rather than
   exception behavior for warnings, consistently extended to errors so a CLI can collect and
   present every issue before aborting.

9. **Discovery stops at a `.git` directory entry OR filesystem root.** Spec §4.1 names repository/
   filesystem roots without defining repository detection. A directory containing `.git` as a file
   or directory, supporting Git worktrees, is a repository root: it is searched, its parent is not.
   No `GitPort` is needed; filesystem existence checks suffice, and discovery already needs filesystem access.

10. **JSON Schema uses `schemaVersion` `const: 1`, while `RawConfigLayer` uses `number`.** Raw
    unmigrated files may carry any historical version, read by `migrateConfig` before merge.
    JSON Schema describes the *current* v1 tooling contract.

<a id="verifikation"></a>

## Verification

```bash
pnpm --filter @untangle-code/config run typecheck   # tsc, 0 errors
pnpm --filter @untangle-code/config run test        # vitest, 73 tests passed, 1 skipped (Windows path test on POSIX)
pnpm --filter @untangle-code/config run build       # emit to dist/
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
