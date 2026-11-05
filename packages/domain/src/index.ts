/**
 * @untangle-code/domain — the contract-defining core of Untangle.
 *
 * Pure types, ports, deterministic IDs, error codes and executable
 * invariants. No I/O: node:crypto and node:path only, never node:fs or
 * network access. This module is the ONLY public export of the package.
 */

// Version constants (architecture.md §2.3)
export * from "./versions.js";
export type {
  ProductAgentHintV1,
  ProductAlignmentReportV1,
  ProductCodeMetricsV1,
  ProductEvidenceStatusV1,
  ProductFeatureAlignmentV1,
  ProductFeatureManifestV1,
  ProductFeatureV1,
  ProductFileEvidenceV1,
  ProductFileSelectionV1,
  ProductHotspotV1,
  ProductMetricReadingsV1,
  ProductOwnerV1,
  ProductSourceEvidenceV1,
  ProductSourceReferenceV1,
  ProductTestEvidenceV1,
} from "./types/product-alignment.js";

// Canonical JSON (spec.md §5.7)
export * from "./canonical-json.js";

// Identity model (spec.md §5, portfolio.md §5)
export * from "./identity.js";

// Schluessel der inhaltsadressierten Analyse-Caches (WP-100)
export * from "./analysis-cache-key.js";

// Deterministische Ordnung (nie localeCompare)
export * from "./ordering.js";

// Shared lexical token space for indexing, queries and local reranking.
export * from "./identifier-tokenizer.js";

// Errors (spec.md §25.1, portfolio.md §15, architecture.md §22.1)
export * from "./errors.js";

// Core entity contracts
export * from "./types/common.js";
export * from "./types/embedding.js";
export * from "./types/workspace.js";
export * from "./types/file.js";
export * from "./types/symbol.js";
export * from "./types/chunk.js";
export * from "./types/complexity.js";
export * from "./types/search.js";
export * from "./types/change.js";
export * from "./types/quality.js";
export * from "./types/job.js";
export * from "./types/envelope.js";
export * from "./types/artifact.js";
export * from "./types/portfolio.js";

// Abrufkern (Welle 3): Graphen, Suche, Findability, externe Befunde
export * from "./types/file-graph.js";
export * from "./types/symbol-graph.js";
export * from "./types/findability.js";
export * from "./types/search-journey.js";
export * from "./search-journey-validation.js";
export * from "./types/skip-ledger.js";
export * from "./types/extensions.js";

// Prosa als erstklassiger Inhalt (vision.md §1c, WP-110/WP-217)
export * from "./types/prose.js";
export * from "./prose/markdown-outline.js";
export * from "./prose/markdown-links.js";
export * from "./prose/minified-rule.js";
export * from "./prose/text-formats.js";

// Analysis contracts (LanguageAdapter, facts, IR, coverage)
export * from "./analysis.js";

// Benannte Gruende fuer geworfene Adapterausnahmen (WP-216, E4)
export * from "./adapter-failure.js";

// Hexagonal ports (architecture.md §2.1)
export * from "./ports.js";

// Executable invariants and guards
export * from "./invariants.js";
export * from "./types/http-boundary.js";
