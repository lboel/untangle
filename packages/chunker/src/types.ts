/**
 * Chunker-local configuration and input/output contracts.
 *
 * These types are additive to `@untangle-code/domain` — they configure how
 * this package turns `AstRegion`/`ExtractedSymbol`/`ParseResult` into
 * `CodeChunkDraft`s, but never redefine a domain contract.
 */
import type {
  AstRegion,
  CodeChunkDraft,
  CoverageEntry,
  ExtractedSymbol,
  ParseQuality,
  ParseResult,
} from "@untangle-code/domain";

import type { MinifiedDetectionConfig } from "./minified-detection.js";
import type { PreparedTextContext } from "./prepared-text.js";
import type { TokenEstimatorConfig } from "./token-estimator.js";

/** Line-window fallback config for parse failures (spec.md §8.3 step 9). */
export interface LineFallbackConfig {
  /** Target number of source lines per fallback chunk before overlap. */
  linesPerChunk: number;
  /** Number of trailing lines repeated at the start of the next chunk. */
  overlapLines: number;
}

/** Configurable overlap for the minified strategy (spec.md §8.3 step 10). */
export interface MinifiedStrategyConfig {
  /** Bytes of trailing context repeated at the start of the next fragment. */
  overlapBytes: number;
}

/** Full chunker configuration; every field has a documented default. */
export interface ChunkerConfig {
  /** Chunk identity version input (spec.md §5.6). Defaults to `CHUNKER_VERSION`. */
  chunkerVersion: string;
  /** Stamped onto every draft as provenance (architecture.md §2.3). */
  parserVersion: string;
  /** Conservative token budget per chunk, header included (architecture.md §14.4). */
  maxTokensPerChunk: number;
  tokenEstimator: TokenEstimatorConfig;
  preparedText: PreparedTextContext;
  minifiedDetection: MinifiedDetectionConfig;
  lineFallback: LineFallbackConfig;
  minifiedStrategy: MinifiedStrategyConfig;
}

/** User-supplied overrides; every field optional except the prepared-text header. */
export type ChunkerConfigInput = Partial<Omit<ChunkerConfig, "preparedText">> & {
  preparedText: PreparedTextContext;
};

/** Minimal identity of the file being chunked (a slice of domain `SourceFile`). */
export interface ChunkFileIdentity {
  workspaceId: string;
  repoId: string;
  refId: string;
  fileId: string;
  /** "/"-normalized path relative to the repository root. */
  filePath: string;
  languageId: string;
}

/** Input to {@link chunkFile} (see `src/chunker.ts`). */
export interface ChunkFileParams {
  identity: ChunkFileIdentity;
  /** Full UTF-8 decoded file content (spec.md §7). */
  content: string;
  parseResult: ParseResult;
  /** `adapter.extractChunks(ast)` output; empty when `parseResult.ast` is null. */
  regions: AstRegion[];
  /** `adapter.extractSymbols(ast)` output; empty when `parseResult.ast` is null. */
  symbols: ExtractedSymbol[];
  /**
   * Overrides minified auto-detection when the caller already knows (e.g. a
   * `.min.js` scanner classification). Leave unset to auto-detect.
   */
  isMinified?: boolean;
  config: ChunkerConfigInput;
}

/**
 * Warum der Chunker unterhalb der AST-Strategie geblieben ist (E4, WP-165).
 *
 * Geschlossene Menge, damit die Gruende zaehlbar bleiben; die freie
 * Erlaeuterung steht in `detail`, nicht im Grund. Bewusst PAKETLOKAL und nicht
 * als `SkipReason` aus `@untangle-code/domain`: dessen geschlossener Katalog
 * kennt keinen Grund fuer "der Parser war erfolgreich, lieferte aber keine
 * Regionen", und `parse_failed` waere dafuer schlicht falsch. Dieselbe
 * Entscheidung hat `@untangle-code/context-artifacts` fuer seinen
 * `ArtifactSkipReason` getroffen.
 */
export const CHUNK_DEGRADATION_REASONS = [
  /** Der Parser ist gescheitert; es gab keinen Baum, an dem entlang zu schneiden waere. */
  "parse_failed",
  /** Der Parser meldete Erfolg, der Sprachadapter lieferte aber keine Regionen. */
  "ast_regions_missing",
  /** Der Inhalt ist minifiziert; Byte-Fenster statt Symbolstruktur (spec.md §8.3 Schritt 10). */
  "minified_content",
] as const;

export type ChunkDegradationReason = (typeof CHUNK_DEGRADATION_REASONS)[number];

/**
 * Eine Abstufung: der Chunker hat die Datei zwar lueckenlos erfasst, aber OHNE
 * die Symbolstruktur, die die AST-Strategie geliefert haette.
 *
 * Ohne diesen Eintrag ist genau das unsichtbar. Die Byte-Abdeckung ist
 * vollstaendig (`assertLosslessCoverage` ist zufrieden), `parseQuality` kann
 * `"complete"` lauten -- und trotzdem hat kein einziger Chunk eine
 * Symbolzuordnung. Ein Aufrufer, der `parseQuality` liest, haelt das Ergebnis
 * fuer strukturell analysiert. Das ist die Fehlerklasse "Vollstaendigkeit
 * behauptet, Teilbaum verworfen" in ihrer unauffaelligsten Form, deshalb steht
 * sie hier als eigener, benannter Befund im Ergebnis.
 */
export interface ChunkDegradation {
  reason: ChunkDegradationReason;
  /** Welche Strategie stattdessen lief. */
  strategy: "line_fallback" | "minified";
  /** Menschenlesbare Begruendung; MUSS nicht leer sein (E4). */
  detail: string;
}

/** Output of {@link chunkFile}. */
export interface ChunkFileResult {
  drafts: CodeChunkDraft[];
  coverage: CoverageEntry[];
  /** Which of the three strategies (spec.md §8.3) produced `drafts`. */
  strategy: "ast" | "line_fallback" | "minified";
  parseQuality: ParseQuality;
  /**
   * Leer, wenn die AST-Strategie lief. Sonst genau ein Eintrag mit dem Grund
   * (E4: keine stillschweigende Abstufung) -- siehe {@link ChunkDegradation}.
   */
  degradations: ChunkDegradation[];
}
