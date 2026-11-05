/**
 * Die Vertraege des Indexlaufs: was hineingeht, was dabei gesammelt wird und
 * was am Ende berichtet wird.
 *
 * ABGRENZUNG: Die STUFEN-Schnittstellen (`DiscoveryStage`, `AnalysisStage`,
 * `EmbeddingStage`, `StorageStage`, `GraphStage`, `GenerationCommitStage`)
 * stehen in `@untangle-code/jobs` und werden hier NICHT neu definiert — dieses
 * Paket implementiert sie. Was hier steht, ist ausschliesslich die Verdrahtung
 * (welche Ports, welches Repository, welches Profil) und der Bericht.
 */
import type {
  AnalysisCacheKind,
  Clock,
  EmbeddingProvider,
  FileSystemPort,
  GraphStore,
  LoggerPort,
  MetadataStore,
  ParserRegistry,
  PortCallOptions,
  Random,
  SkipLedgerEntryV1,
  SkipReason,
  SkipStage,
  VectorStore,
} from "@untangle-code/domain";

/**
 * Der inhaltsadressierte Einbettungs-Zwischenspeicher (spec.md §9.4).
 *
 * BEWUSST STRUKTURELL statt als Import von `@untangle-code/storage-local`:
 * dieses Paket soll ohne Abhaengigkeit auf einen bestimmten Speicheradapter
 * verwendbar sein (Tests reichen eine Karte im Speicher herein). Die Form ist
 * die von `LocalEmbeddingCache` — wer den hat, kann ihn direkt uebergeben.
 */
export interface EmbeddingCacheLike {
  get(
    embeddingProfileId: string,
    preparedText: string,
    options?: PortCallOptions,
  ): Promise<number[] | null>;
  set(
    embeddingProfileId: string,
    preparedText: string,
    vector: readonly number[],
    options?: PortCallOptions,
  ): Promise<void>;
}

/**
 * Die drei inhaltsadressierten Analyse-Caches (WP-100, docs/INDEX-SHARING.md
 * §5): Parse, Chunk und Komplexitaet.
 *
 * BEWUSST STRUKTURELL, aus demselben Grund wie {@link EmbeddingCacheLike}:
 * dieses Paket haengt an keinem bestimmten Speicheradapter. `LocalAnalysisCache`
 * aus `@untangle-code/storage-local` hat genau diese Form.
 *
 * `get` liefert `null` fuer "nicht im Cache" und wirft NICHT fuer beschaedigte
 * Eintraege — ein Cache-Fehler darf nie ein Indexlauf-Fehler werden.
 *
 * Die SCHLUESSEL baut nicht dieses Paket allein: `buildParseCacheKey`,
 * `buildChunkCacheKey` und `buildMetricsCacheKey` stehen in
 * `@untangle-code/domain`, damit Ableger und Ablage nie auseinanderlaufen.
 */
/**
 * `AnalysisCacheKind` gehoert zur oeffentlichen Flaeche dieses Moduls: der Typ
 * steht in der Signatur von `AnalysisCacheLike`, also braucht jeder, der einen
 * eigenen Cache baut, ihn auch. Er wird hier bewusst weitergereicht statt
 * doppelt definiert — eine zweite Definition koennte auseinanderlaufen.
 */
export type { AnalysisCacheKind };

export interface AnalysisCacheLike {
  get(kind: AnalysisCacheKind, key: string, options?: PortCallOptions): Promise<unknown | null>;
  set(
    kind: AnalysisCacheKind,
    key: string,
    value: unknown,
    options?: PortCallOptions,
  ): Promise<void>;
  /** Optional: schreibt ausstehende Manifest-Aenderungen. */
  flush?(options?: PortCallOptions): Promise<void>;
}

/** Das eine Repository und der eine Ref, den ein Lauf indiziert. */
export interface IndexTargetV1 {
  workspaceId: string;
  repoId: string;
  /** `repo_id + ":" + normalized_ref` (spec.md §5.3). */
  refId: string;
  /** Menschenlesbarer Refname, z. B. "main" — geht in den Kopf des Dense-Textes. */
  refName: string;
  /** Menschenlesbares Repository-Etikett, z. B. "untangle". */
  repoLabel: string;
  /** Absoluter, kanonischer Pfad der Repositorywurzel. */
  rootPath: string;
  /** Commit-SHA, wenn bekannt; steht dann in jedem Punkt-Payload. */
  commitSha?: string | undefined;
}

/** Alle Ports, die der Indexlauf braucht. */
export interface IndexPortsV1 {
  fs: FileSystemPort;
  parsers: ParserRegistry;
  embedder: EmbeddingProvider;
  vectorStore: VectorStore;
  metadataStore: MetadataStore;
  graphStore: GraphStore;
  clock: Clock;
  random: Random;
  /** Ohne ihn rechnet jeder Lauf jede Einbettung neu (spec.md §9.4). */
  embeddingCache?: EmbeddingCacheLike | undefined;
  /** Ohne ihn parst, chunkt und misst jeder Lauf jede Datei neu (WP-100). */
  analysisCache?: AnalysisCacheLike | undefined;
  logger?: LoggerPort | undefined;
}

/** Stellschrauben des Laufs; jede hat eine dokumentierte Vorgabe. */
export interface IndexTuningV1 {
  /** Harte Obergrenze der Token je Chunk (spec.md §4.6 `maxChunkTokens`). */
  maxChunkTokens?: number | undefined;
  /** Dateien groesser als das werden gar nicht erst gelesen (spec.md §6.1). */
  maxFileSizeBytes?: number | undefined;
  /** Nebenlaeufigkeit der Datei-Verarbeitung im Scanner. */
  scanConcurrency?: number | undefined;
  /** Zusaetzliche Ausschlussmuster aus der Konfiguration (spec.md §4.3). */
  excludePatterns?: readonly string[] | undefined;
  includePatterns?: readonly string[] | undefined;
  /** Dokumentprefix des Profils; kommt aus `EmbeddingProfile.documentPrefix`. */
  documentPrefix?: string | undefined;
}

/** Was der Lauf gezaehlt hat. Reine Ergebnisdaten — keine Uhrzeit, kein Zufall. */
export interface IndexCountsV1 {
  filesSeen: number;
  filesPlanned: number;
  filesUnchanged: number;
  filesIgnored: number;
  filesAnalyzed: number;
  filesRemoved: number;
  chunks: number;
  symbols: number;
  points: number;
  embeddingCacheHits: number;
  embeddingsComputed: number;
  /** Dateien, deren Parseergebnis aus dem Cache kam (WP-100). */
  parseCacheHits: number;
  parseCacheMisses: number;
  /** Dateien, deren Chunks aus dem Cache kamen. */
  chunkCacheHits: number;
  chunkCacheMisses: number;
  /** Dateien, deren Komplexitaetswerte aus dem Cache kamen. */
  metricsCacheHits: number;
  metricsCacheMisses: number;
  truncated: number;
  fileGraphNodes: number;
  fileGraphEdges: number;
  symbolGraphNodes: number;
  symbolGraphEdges: number;
}

/** Der Bericht eines Laufs — das, was `untangle index` ausgibt. */
export interface IndexReportV1 {
  schemaVersion: 1;
  jobId: string;
  generationId: string | null;
  workspaceId: string;
  repoId: string;
  refId: string;
  embeddingProfileId: string;
  collection: string;
  /** "completed" | "failed" | "cancelled" — nie etwas anderes. */
  outcome: "completed" | "failed" | "cancelled";
  counts: IndexCountsV1;
  /** Gesetzt, wenn `outcome === "failed"`. */
  failure?: { code: string; message: string; retryable: boolean } | undefined;
  /** Behaltene Ledger-Eintraege, kanonisch geordnet. */
  skipped: SkipLedgerEntryV1[];
  /** Grund → Anzahl ueber ALLE Meldungen, auch die nicht behaltenen. */
  skippedByReason: Partial<Record<SkipReason, number>>;
  /** Stufe → Anzahl ueber ALLE Meldungen; trennt Dateien von Graphkanten. */
  skippedByStage: Partial<Record<SkipStage, number>>;
  /** Wie viele Ledger-Eintraege die Obergrenze nicht in die Liste liess. */
  skippedTruncated: number;
}
