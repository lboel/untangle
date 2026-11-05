/**
 * @untangle-code/context-artifacts — the ONLY public export of this
 * package.
 *
 * `createArtifactAdapterRegistry()` returns an `ArtifactAdapter`
 * (`@untangle-code/domain` `ports.ts`, architecture.md §20) that dispatches
 * to one of the built-in format adapters — Markdown/ADR, SQL schema,
 * OpenAPI, AsyncAPI, Protobuf, Terraform/HCL, Kubernetes YAML, Docker/
 * Compose — or the safe generic text fallback. Individual `create*Adapter()`
 * factories are exported too, both for direct golden-testing (one per
 * adapter, see each `src/adapters/*.test.ts`) and so a caller who only
 * needs one format can skip the registry entirely.
 *
 * Also exported: cross-artifact config validation (`validateArtifactConfigs`,
 * spec.md §19.2's project-wide unique name requirement), staleness
 * snapshotting (`computeArtifactStalenessSnapshot`/`isArtifactStale`,
 * spec.md §19.2's "config hash + content hash"), and the skip ledger
 * (`buildArtifactSkipLedger`, BUILD_PLAN §12 E4) — see README.md
 * "Entscheidungen" for why these last two exist as this package's own
 * derived utilities rather than domain port additions.
 */
export type { ArtifactAdapterRegistry, ArtifactAdapterRegistryOptions } from "./registry.js";
export { createArtifactAdapterRegistry } from "./registry.js";

export type { MarkdownAdapterOptions } from "./adapters/markdown.js";
export { createMarkdownAdapter } from "./adapters/markdown.js";
export type { SqlAdapterOptions, SqlDialect } from "./adapters/sql.js";
export { createSqlAdapter, DEFAULT_SQL_DIALECT } from "./adapters/sql.js";
export type { OpenApiAdapterOptions } from "./adapters/openapi.js";
export { createOpenApiAdapter } from "./adapters/openapi.js";
export type { AsyncApiAdapterOptions } from "./adapters/asyncapi.js";
export { createAsyncApiAdapter } from "./adapters/asyncapi.js";
export type { ProtobufAdapterOptions } from "./adapters/protobuf.js";
export { createProtobufAdapter } from "./adapters/protobuf.js";
export type { TerraformAdapterOptions } from "./adapters/terraform.js";
export { createTerraformAdapter } from "./adapters/terraform.js";
export type { KubernetesAdapterOptions } from "./adapters/kubernetes.js";
export { createKubernetesAdapter } from "./adapters/kubernetes.js";
export type { DockerAdapterOptions } from "./adapters/docker.js";
export { createDockerAdapter } from "./adapters/docker.js";
export type { TextFallbackAdapterOptions } from "./adapters/text.js";
export { createTextFallbackAdapter, TEXT_WINDOW_LINES } from "./adapters/text.js";

export { validateArtifactConfigs } from "./config-validation.js";

export type { ArtifactStalenessSnapshot } from "./staleness.js";
export {
  computeArtifactConfigHash,
  computeArtifactContentHash,
  computeArtifactStalenessSnapshot,
  isArtifactStale,
} from "./staleness.js";

export type {
  ArtifactSkipLedgerEntry,
  ArtifactSkipLedgerOptions,
  ArtifactSkipReason,
  ChunkPlausibilityCheck,
  SkipLedgerReporter,
} from "./coverage.js";
export { buildArtifactSkipLedger, defaultSkipLedgerReporter } from "./coverage.js";

export { buildArtifactChunkId } from "./ids.js";
export type { ArtifactChunkIdInput } from "./ids.js";

// Line-indexing primitives, exposed for a custom adapter registered via
// `createArtifactAdapterRegistry([...])` that wants the same byte-accurate
// SourceRange conventions this package's own adapters use.
export type { LineIndex } from "./text/line-index.js";
export {
  buildLineIndex,
  rangeForLines,
  sliceBytes,
  sliceLines,
  splitLines,
} from "./text/line-index.js";

// Plausibilitätsprüfung geschnittener Fragmente (WP-118), damit ein eigener
// Adapter dieselbe E4-Absicherung bekommt wie die eingebauten.
export type {
  BlockCommentRule,
  BracketRule,
  DelimiterImbalance,
  DelimiterImbalanceKind,
  DelimiterScanOptions,
  HeredocStyle,
  QuoteRule,
} from "./text/delimiter-balance.js";
export { describeDelimiterImbalances, findDelimiterImbalances } from "./text/delimiter-balance.js";

// The YAML subset parser, exposed for the same reason (e.g. a custom
// Kubernetes CRD-aware adapter built on top of this package's parser).
export type {
  YamlDocumentSpan,
  YamlMapEntry,
  YamlNode,
  YamlScalarValue,
} from "./text/yaml-lite.js";
export {
  YamlParseError,
  mapGet,
  parseYamlNode,
  scalarString,
  splitYamlDocuments,
} from "./text/yaml-lite.js";
