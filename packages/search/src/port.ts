/**
 * Der Port des Abrufkerns.
 *
 * Er ist bewusst so geschnitten, dass er OHNE laufendes Qdrant vollstaendig
 * testbar ist: alles, was Infrastruktur braucht, steckt hinter zwei bereits
 * bestehenden Domain-Ports (`VectorStore`, `EmbeddingProvider`) plus einer
 * kleinen, injizierbaren Funktion fuer die spaerliche Vektorisierung. Die
 * Kontraktsuite in `testing/search-port.contract.ts` laeuft deshalb unveraendert
 * gegen den In-Memory-Speicher des testkits und spaeter gegen den echten
 * Qdrant-Adapter — dieselbe Bauart wie `runVectorStoreContract`.
 *
 * Ausdruecklich NICHT Teil des Ports: Collection-Namen. Welche Collection zu
 * welchem Embedding-Profil gehoert, entscheidet der Adapter (spec.md §10.1);
 * der Abrufkern bekommt die fertige Zuordnung als {@link ProfileTargetV1}
 * gereicht. Damit kennt dieses Paket kein Qdrant-Detail.
 */
import type {
  EmbeddingProvider,
  FindabilitySummaryV1,
  PortCallOptions,
  SearchGraphRelationsV1,
  SearchResultSetV1,
  SparseVectorV1,
  ToolWarningV1,
} from "@untangle-code/domain";

import type { GrepRequestV1, GrepResultSetV1, UntangleSearchRequestV1 } from "./types.js";

/**
 * Ein Suchziel: genau ein Embedding-Profil, genau eine Collection, die
 * Repositories, die darin liegen.
 *
 * Mehrere Ziele heissen mehrere Ergebnisgruppen (spec.md §13.4): Scores
 * verschiedener Profile werden NIE in eine gemeinsame absolute Rangfolge
 * gemischt.
 */
export interface ProfileTargetV1 {
  embeddingProfileId: string;
  /** Name der Collection im Vektorspeicher. */
  collection: string;
  /** Repositories, die zu dieser Collection beitragen. */
  repoIds: string[];
  /** Der Embedder dieses Profils; erzeugt das Query-Embedding. */
  embedder: EmbeddingProvider;
  /** Lokal bekannte Generationen je Repo/Ref samt Abschlussstatus als Provenienz. */
  indexContexts?: readonly {
    repoId: string;
    refId: string;
    generationId: string;
    /** Immutable manifest fingerprint for this completed corpus snapshot. */
    corpusRevisionFingerprint?: string;
    outcome: "running" | "completed" | "cancelled" | "failed";
  }[];
}

/**
 * Erzeugt den spaerlichen Vektor einer Anfrage fuer den Abruf im Speicher.
 *
 * Die Funktion MUSS dieselbe Tokenisierung und Hashbildung verwenden wie der
 * Indexlauf, sonst treffen Anfrage- und Dokumentvektor sich nicht. Genau
 * deshalb ist sie injiziert und nicht hier implementiert: sie gehoert zum
 * Speicheradapter, nicht zum Abrufkern.
 *
 * Fehlt sie, ist der lexikalische Abrufzweig nicht ausfuehrbar. Hybrid kann
 * ueber Dense und Symbolnamen sichtbar degradiert antworten; reine
 * lexikalische Suche meldet einen Fehler. Der BM25-Rang wird weiterhin in
 * diesem Paket berechnet (`bm25.ts`).
 */
export type SparseVectorizer = (text: string) => SparseVectorV1;

/** Liefert die Findability eines Symbols, sofern sie berechnet wurde. */
export type FindabilityLookup = (symbolId: string) => FindabilitySummaryV1 | undefined;

/** Liefert die Graph-Naehe eines Symbols zur Anfrage, in [0, 1]. */
export type GraphProximityLookup = (symbolId: string) => number | undefined;

/** Ein bereits final gerankter Treffer, den ein Graphadapter anreichern darf. */
export interface SearchGraphEnrichmentTargetV1 {
  /** Nur innerhalb eines Aufrufs eindeutig; wird unveraendert zurueckgegeben. */
  targetId: string;
  workspaceId: string;
  generationId: string;
  repoId: string;
  refId: string;
  fileId: string;
  filePath: string;
  symbolId?: string;
}

/** Batch-Anfrage an den optionalen, graph-agnostischen Anreicherungsport. */
export interface SearchGraphEnrichmentRequestV1 {
  includeContext: boolean;
  includeLinked: boolean;
  /** Harte Obergrenze je Treffer und Graphart. */
  relationLimit: number;
  /** Reihenfolge entspricht Gruppenreihenfolge und finalem Rang. */
  targets: readonly SearchGraphEnrichmentTargetV1[];
}

/** Anreicherung genau eines finalen Treffers. */
export interface SearchGraphEnrichmentEntryV1 {
  targetId: string;
  graphContext?: SearchGraphRelationsV1;
  linkedSymbols?: SearchGraphRelationsV1;
}

/** Batch-Ergebnis; Teilgraph-Ausfaelle bleiben als Warnungen und Facetten sichtbar. */
export interface SearchGraphEnrichmentResultV1 {
  entries: readonly SearchGraphEnrichmentEntryV1[];
  warnings: readonly ToolWarningV1[];
}

/**
 * Schmale Grenze zum persistierten File-/Symbolgraphen. Das Search-Paket
 * kennt weder deren Snapshottypen noch deren Speicherlayout.
 */
export interface SearchGraphEnrichmentPort {
  enrich(
    request: SearchGraphEnrichmentRequestV1,
    options?: PortCallOptions,
  ): Promise<SearchGraphEnrichmentResultV1>;
}

/**
 * Der Abrufkern als Port: semantische Suche und grep-artige Suche unter EINER
 * Oberflaeche (Nutzerwunsch A4).
 */
export interface SearchPort {
  /** Hybride Suche mit vollstaendiger Score-Zerlegung (spec.md §13). */
  search(request: UntangleSearchRequestV1, options?: PortCallOptions): Promise<SearchResultSetV1>;
  /** Regex-/Literalsuche ueber den indexierten Inhalt. */
  grep(request: GrepRequestV1, options?: PortCallOptions): Promise<GrepResultSetV1>;
}
