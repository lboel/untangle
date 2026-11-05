/**
 * Code chunk contracts (spec.md §8, §10.3).
 */
import type { ChunkKind, MetricsScope, ParseQuality, SourceRange } from "./common.js";

/**
 * Qdrant payload of a code chunk point (spec.md §10.3).
 *
 * Field names are snake_case by spec — this type mirrors the stored payload
 * verbatim so that filters and indexes (spec.md §10.4) match without mapping.
 */
export interface CodeChunkPayloadV1 {
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
  parse_quality: ParseQuality;

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
  /** Index generation that produced this stored point (architecture.md §2.3). */
  generation_id: string;
  embedding_truncated: boolean;

  metrics_scope: MetricsScope;
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

/**
 * Chunker output before embedding and storage (architecture.md §6.6).
 *
 * A draft carries everything needed to (a) build the prepared dense/BM25
 * texts, (b) become a `CodeChunkPayloadV1` after embedding, and (c) prove
 * lossless coverage via its source range.
 */
export interface CodeChunkDraft {
  /** Stable chunk id (spec.md §5.6). */
  chunkId: string;
  chunkKind: ChunkKind;
  /** Stable ordinal within the owning scope; part of the chunk id input. */
  chunkOrdinal: number;
  /**
   * Present on ALL `symbol_fragment` chunks and only on them (spec.md
   * §8.5); together with `symbolId` and `signature` they are mandatory on
   * that kind — the chunker's draft factory refuses to emit a
   * `symbol_fragment` missing any of them.
   */
  fragmentIndex?: number;
  fragmentCount?: number;

  workspaceId: string;
  repoId: string;
  refId: string;
  fileId: string;
  /** "/"-normalized path relative to the repository root. */
  filePath: string;
  language: string;
  parseQuality: ParseQuality;

  /**
   * Stable symbol id (spec.md §5.5) of the symbol this chunk belongs to;
   * mandatory on `symbol_fragment` (spec.md §8.5). `property_group` chunks
   * (and their over-budget fragments) are not symbols of their own — §5.5
   * has no (kind, qualified name, normalized signature) for a grouped
   * property run — so they carry the OWNING CLASS's symbol id: dedupe over
   * `metrics_scope_id` (architecture.md §18.4) then attaches them as
   * related fragments of the class symbol, and no synthetic scope id that
   * is absent from the symbol table can leak into payloads.
   */
  symbolId?: string;
  symbolName?: string;
  symbolFqn?: string;
  symbolKind?: string;
  /** Signature or short symbol header; mandatory on fragments (spec.md §8.5). */
  signature?: string;

  range: SourceRange;
  /**
   * Chunk content. Unless `synthesized` is true, this is EXACTLY the bytes
   * of `range` decoded as UTF-8 — byte-for-byte, no trimming, no rewriting.
   */
  content: string;
  /**
   * True for chunks whose `content` is generated rather than sliced from
   * the source (currently only `class_overview`: header + doc + member
   * summary, spec.md §8.3 step 4). A synthesized chunk keeps its full
   * source `range` for navigation, but it MUST NOT be used as coverage
   * proof for bytes its content does not actually represent: its coverage
   * ledger entry may claim at most the symbol's header span, and the
   * lossless invariant (spec.md §8.4) must be carried by real content
   * chunks or documented exclusions. Absent means false.
   */
  synthesized?: boolean;
  /** SHA-256 of `content`. */
  contentHash: string;
  astHash?: string;

  metricsScope: MetricsScope;
  metricsScopeId: string;

  /** Conservative token estimate incl. metadata header (architecture.md §14.4). */
  tokenEstimate: number;
  /** Prepared dense document text (spec.md §8.6); set by the preparation stage. */
  preparedDenseText?: string;
  /** BM25 text: raw code, path, symbol names, identifiers (spec.md §8.6). */
  bm25Text?: string;

  parserVersion: string;
  chunkerVersion: string;
}
