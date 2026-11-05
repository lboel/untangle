/**
 * Lokale Vertragstypen des Symbolgraphen.
 *
 * Alles, was Untangle DAUERHAFT speichert oder ueber eine Schnittstelle
 * herausgibt, ist ein Typ aus `@untangle-code/domain` (`SymbolNodeV1`,
 * `SymbolEdgeV1`, `TraversalResultV1`, `SkipLedgerV1`, …). Die Typen in dieser
 * Datei sind ausschliesslich die EIN- und AUSGABEHUELLEN dieses Pakets: sie
 * buendeln Domaintypen, erfinden aber keinen zweiten Kantenbegriff.
 *
 * Normative Quellen: spec.md §15 (Symbolgraph), architecture.md §17
 * (Aufbau, Confidence, Traversierungslimits), docs/BUILD_PLAN.md §12 E4
 * (nichts wird stillschweigend uebersprungen).
 */
import type {
  ExtractedSymbol,
  ParseQuality,
  RawCall,
  RawImport,
  SkipLedgerEntryV1,
  SkipLedgerV1,
  SymbolEdgeKind,
  SymbolEdgeResolution,
  SymbolEdgeV1,
  SYMBOL_GRAPH_VERSION,
  SymbolNodeV1,
  TraversalLimitsV1,
  TraversalResultV1,
  TraversalTruncationReason,
} from "@untangle-code/domain";

// ---------------------------------------------------------------------------
// Eingabe
// ---------------------------------------------------------------------------

/**
 * Eine geparste Datei als Eingabe des Symbolgraphen.
 *
 * SPRACHAGNOSTIK (vision.md §1c): `symbols` und `calls` DUERFEN leer sein.
 * Fuer Inhalte ohne Symbolbegriff (Markdown, Text, Konfiguration) ist der
 * leere Symbolgraph das korrekte Ergebnis — kein Fehler, kein Ledger-Eintrag.
 * Ein Ledger-Eintrag entsteht erst, wenn etwas VORHANDENES ausgelassen wird.
 */
export interface SymbolGraphFileInput {
  fileId: string;
  repoId: string;
  refId: string;
  /** "/"-normalisierter, repo-relativer Pfad. */
  path: string;
  languageId: string;
  /**
   * Vollstaendiger UTF-8-Inhalt der Datei. Grundlage des `contentHash` je
   * Symbol (`SymbolNodeV1.contentHash`) — ohne Inhalt gaebe es keinen
   * ehrlichen Hash, nur einen umbenannten AST-Fingerabdruck.
   */
  content: string;
  parseQuality: ParseQuality;
  symbols: readonly ExtractedSymbol[];
  calls: readonly RawCall[];
  imports: readonly RawImport[];
  /** Paketname im Monorepo, sofern bekannt (nur informativ). */
  packageName?: string;
}

/**
 * Ergebnis der Modulaufloesung des DATEIGRAPHEN, als optionale Zusatzeingabe.
 *
 * Der Symbolgraph loest ABSICHTLICH keine Modulspezifizierer selbst auf — das
 * ist Aufgabe des Dateigraphen. Wird diese Information geliefert, steigt die
 * Aufloesungsart von `heuristic` auf `exact`; fehlt sie, bleibt die Kante
 * ehrlich heuristisch statt falsch sicher.
 */
export interface ResolvedImportTargetV1 {
  fromFileId: string;
  /** Rohspezifizierer wie geschrieben, z. B. "./util". */
  specifier: string;
  /** Zieldatei im Index, oder null fuer extern/unaufloesbar. */
  toFileId: string | null;
  /** True, wenn das Ziel bewusst ausserhalb des Index liegt (Paketabhaengigkeit). */
  external?: boolean;
  /** Pflichtdetail, wenn `toFileId` null und `external` nicht true ist (E4). */
  unresolvedDetail?: string;
}

/**
 * Stellschrauben des Aufbaus. Alle Vorgaben sind dokumentiert und
 * deterministisch.
 *
 * JEDER Wert wird beim Eintritt geprueft (`withResolutionDefaults`); ein
 * unzulaessiger Wert fuehrt zu `UntangleError("CONFIG_INVALID")` und NICHT zu
 * einem stillschweigend beschnittenen Graphen.
 */
export interface SymbolGraphBuildOptions {
  /** Confidence einer namensbasierten, eindeutigen Kante (Vorgabe 0.6); 0 < Wert < 1. */
  uniqueNameConfidence?: number;
  /** Confidence einer Kante ueber einen Qualifizierer (Vorgabe 0.5); 0 < Wert < 1. */
  qualifiedNameConfidence?: number;
  /**
   * Hoechstzahl behaltener Kandidaten einer mehrdeutigen Kante (Vorgabe 16).
   * Verworfene Kandidaten erzeugen einen Ledger-Eintrag — E4 gilt auch fuer
   * Kandidaten, nicht nur fuer Dateien.
   *
   * MINDESTENS 2: eine mehrdeutige Kante traegt laut `validateSymbolEdge`
   * mindestens zwei Kandidaten. Ein kleinerer Wert wuerde die Kandidatenliste
   * nicht kuerzen, sondern die ganze Kante loeschen — deshalb wird er
   * zurueckgewiesen statt ausgefuehrt.
   */
  maxCandidates?: number;
}

/** Vollstaendige Eingabe von {@link buildSymbolGraph}. */
export interface SymbolGraphBuildInput {
  workspaceId: string;
  /** Generationskennung des Laufs; steht auf jeder Kante. */
  graphGeneration: string;
  files: readonly SymbolGraphFileInput[];
  resolvedImports?: readonly ResolvedImportTargetV1[];
  options?: SymbolGraphBuildOptions;
}

// ---------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------

/** Kennzahlen des gebauten Graphen. */
export interface SymbolGraphMetricsV1 {
  schemaVersion: 1;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  /** Dateien ohne jedes Symbol (Markdown, Text, leere Dateien). */
  symbolLessFileCount: number;
  edgesByResolution: Record<SymbolEdgeResolution, number>;
  edgesByKind: Record<SymbolEdgeKind, number>;
  /** Anteil `exact` an allen Kanten; 0, wenn es keine Kanten gibt. */
  exactEdgeRate: number;
  ambiguousEdgeRate: number;
  unresolvedEdgeRate: number;
  crossRepoEdgeCount: number;
  /** Symbole ohne eingehende aufgeloeste Kante. */
  orphanSymbolCount: number;
  maxInDegree: number;
  maxOutDegree: number;
  /** Meistgerufene Symbole, absteigend nach Grad, bei Gleichstand nach Codepoints. */
  topCalledSymbolIds: string[];
  skippedCount: number;
}

/**
 * Der gebaute Symbolgraph. Knoten und Kanten sind Domaintypen; die Huelle
 * traegt zusaetzlich das Pflichtfeld `skipped` (E4) und die Kennzahlen.
 */
export interface SymbolGraphV1 {
  schemaVersion: 1;
  workspaceId: string;
  graphGeneration: string;
  graphVersion: typeof SYMBOL_GRAPH_VERSION;
  /** Aufsteigend nach `id` (Codepoints). */
  nodes: SymbolNodeV1[];
  /** Aufsteigend nach `edgeId` (Codepoints). */
  edges: SymbolEdgeV1[];
  skipped: SkipLedgerV1;
  metrics: SymbolGraphMetricsV1;
}

// ---------------------------------------------------------------------------
// Nachbarschaft und Traversierung
// ---------------------------------------------------------------------------

/**
 * Eine gerichtete Bindung zwischen zwei Symbolen, wie die Traversierung sie
 * sieht.
 *
 * Eine MEHRDEUTIGE Kante erzeugt EINE Bindung JE KANDIDAT — wir waehlen keinen
 * heimlich aus. `weight` ist bei mehrdeutigen Kanten das Kandidatengewicht,
 * sonst die Kanten-Confidence.
 */
export interface SymbolBindingV1 {
  symbolId: string;
  edgeId: string;
  resolution: SymbolEdgeResolution;
  /** Confidence GENAU DIESER Bindung, in [0, 1]. */
  weight: number;
  /** True, wenn die Bindung aus einer mehrdeutigen Kante stammt. */
  ambiguous: boolean;
}

/**
 * Traversierungsergebnis dieses Pakets: das Domainergebnis plus das
 * Pflichtfeld `skipped`. `TraversalResultV1` kennt kein Ledger, und ein
 * unbekanntes Wurzelsymbol darf nicht einfach fehlen (E4) — deshalb die
 * Huelle statt einer Erweiterung des Domaintyps.
 */
export interface SymbolGraphTraversalV1 {
  schemaVersion: 1;
  result: TraversalResultV1;
  skipped: SkipLedgerEntryV1[];
}

/** Warum eine Pfadsuche kein Ergebnis lieferte (E4: kein stiller Leerlauf). */
export const CALL_PATH_MISS_REASONS = [
  "unknown_source_symbol",
  "unknown_target_symbol",
  "no_path_within_limits",
] as const;

export type CallPathMissReason = (typeof CALL_PATH_MISS_REASONS)[number];

/** Ein Aufrufpfad von einem Symbol zu einem anderen. */
export interface CallPathV1 {
  schemaVersion: 1;
  /** Knotenfolge inklusive Start und Ziel; Laenge = `depth` + 1. */
  symbolIds: string[];
  /** Kantenfolge; Laenge = `depth`. */
  edgeIds: string[];
  depth: number;
  /** Produkt der Bindungsgewichte entlang des Pfades. */
  confidence: number;
  /** Schwaechste Aufloesungsart auf dem Pfad — der Pfad ist nie besser als sie. */
  weakestResolution: SymbolEdgeResolution;
  containsAmbiguous: boolean;
}

/** Ergebnis der Suche nach dem kuerzesten Pfad. */
export interface ShortestCallPathResultV1 {
  schemaVersion: 1;
  path: CallPathV1 | null;
  /** Pflicht, wenn `path` null ist (E4). */
  missReason?: CallPathMissReason;
  missDetail?: string;
  truncated: boolean;
  truncationReason?: TraversalTruncationReason;
  limits: TraversalLimitsV1;
}

/**
 * `max_paths` is local to path enumeration: unlike a graph traversal, the
 * enumerator can exhaust its result budget before a node/edge budget.
 */
export type AllCallPathsTruncationReason = TraversalTruncationReason | "max_paths";

/** Ergebnis der Suche nach allen Pfaden bis Tiefe N. */
export interface AllCallPathsResultV1 {
  schemaVersion: 1;
  /** Deterministisch sortiert: erst nach Tiefe, dann nach Knotenfolge. */
  paths: CallPathV1[];
  /** Pflicht, wenn `paths` leer ist (E4). */
  missReason?: CallPathMissReason;
  missDetail?: string;
  truncated: boolean;
  truncationReason?: AllCallPathsTruncationReason;
  /**
   * Wegen `maxPaths` sicher verworfene Pfade; nie stillschweigend (E4).
   *
   * Der Enumerator beendet die Suche nach dem ersten sicher ausgelassenen
   * Pfad, statt den restlichen (potenziell exponentiellen) Suchraum nur fuer
   * eine exakte Statistik abzulaufen. Der Wert ist deshalb eine bestaetigte
   * Untergrenze, solange `droppedPathCountExact` false ist.
   */
  droppedPathCount: number;
  /** Ob `droppedPathCount` die vollstaendige Anzahl und keine Untergrenze ist. */
  droppedPathCountExact: boolean;
  pathLimitReached: boolean;
  skipped: SkipLedgerEntryV1[];
  maxDepth: number;
}

// ---------------------------------------------------------------------------
// Impact (spec.md §15.3 „Impact rueckwaerts traversieren")
// ---------------------------------------------------------------------------

/** Ein von einer Aenderung betroffenes Symbol. */
export interface ImpactedSymbolV1 {
  symbolId: string;
  qualifiedName: string;
  filePath: string;
  repoId: string;
  /**
   * Sprungzahl ENTLANG DES BERICHTETEN PFADES, also immer gleich
   * `viaEdgeIds.length`.
   *
   * Bewusst NICHT „Sprungzahl vom naechstgelegenen Wurzelsymbol": berichtet
   * wird der konfidenteste Pfad, und der ist oft nicht der kuerzeste. Beide
   * Groessen in einem Feld zu fuehren war ein Vertragsbruch — `depth` haette
   * dann nicht zu `viaEdgeIds` und `confidence` gepasst. Wer die Naehe zur
   * Wurzel braucht, liest {@link ImpactedSymbolV1.minDepth}.
   */
  depth: number;
  /**
   * Kleinste Sprungzahl zu irgendeinem Wurzelsymbol, ueber IRGENDEINEN
   * gefundenen Pfad — nie groesser als `depth`.
   */
  minDepth: number;
  /** Produkt der Bindungsgewichte auf dem BESTEN (nicht kuerzesten) Pfad. */
  confidence: number;
  /** Schwaechste Aufloesungsart auf diesem Pfad. */
  weakestResolution: SymbolEdgeResolution;
  /**
   * Kantenfolge des besten Pfades in AUFRUFRICHTUNG: die erste Kante geht vom
   * betroffenen Symbol aus, die letzte endet am geaenderten Symbol. Gleiche
   * Leserichtung wie `CallPathV1.edgeIds`, damit beide Ergebnisse zusammen
   * gelesen werden koennen.
   */
  viaEdgeIds: string[];
  /** True, wenn der beste Pfad ueber mindestens eine mehrdeutige Kante fuehrt. */
  throughAmbiguous: boolean;
}

/**
 * Ergebnis der Impact-Analyse.
 *
 * `containsAmbiguousEdges` ist Pflichtangabe: ein Ergebnis, das ueber
 * mehrdeutige Kanten zustande kam, darf nie wie ein sicheres aussehen
 * (architecture.md §17.2).
 */
export interface ImpactResultV1 {
  schemaVersion: 1;
  rootSymbolIds: string[];
  /** Aufsteigend nach `symbolId` (Codepoints). */
  affected: ImpactedSymbolV1[];
  containsAmbiguousEdges: boolean;
  /** Die beteiligten mehrdeutigen Kanten, aufsteigend nach `edgeId`. */
  ambiguousEdgeIds: string[];
  /** Untere Schranke, ab der ein Symbol aufgenommen wurde. */
  minConfidence: number;
  traversal: TraversalResultV1;
  /**
   * Alles, was erreichbar war und trotzdem fehlt (E4): unbekannte
   * Wurzelsymbole, Symbole unter der Confidence-Schranke, Symbole jenseits der
   * Tiefengrenze und Symbole, die ein erschoepftes Budget zurueckliess. Ein
   * Symbol, das im Ergebnis steht, steht NIE hier.
   */
  skipped: SkipLedgerEntryV1[];
}

// ---------------------------------------------------------------------------
// Einstiegspunkte (WP-88)
// ---------------------------------------------------------------------------

/**
 * Arten erkannter Einstiegspunkte. Geschlossene Menge, damit die Erkennung
 * zaehlbar und vergleichbar bleibt.
 */
export const ENTRY_POINT_KINDS = [
  "orphan",
  "conventional_name",
  "test_symbol",
  "framework_route",
] as const;

export type EntryPointKind = (typeof ENTRY_POINT_KINDS)[number];

/** Ein Beleg fuer genau eine erkannte Einstiegspunktart. */
export interface EntryPointSignalV1 {
  kind: EntryPointKind;
  /** Pflichtbegruendung — eine Heuristik ohne Begruendung ist eine Behauptung. */
  reason: string;
  /** Beitrag dieser Art zur Gesamt-Confidence, in [0, 1]. */
  weight: number;
}

/**
 * Ein erkannter Einstiegspunkt. `isHeuristic` ist strukturell auf `true`
 * festgenagelt (gleiche Bauart wie `FindabilityDiagnosisV1`): die Erkennung
 * kann sich nie als Messung ausgeben.
 */
export interface EntryPointV1 {
  schemaVersion: 1;
  symbolId: string;
  qualifiedName: string;
  filePath: string;
  repoId: string;
  /** Immer `true`. */
  isHeuristic: true;
  /** Aufsteigend nach Codepoints, mindestens ein Eintrag. */
  kinds: EntryPointKind[];
  /** Mindestens ein Beleg, in derselben Reihenfolge wie `kinds`. */
  signals: EntryPointSignalV1[];
  /** Basis ist strukturell `"heuristic"`. */
  confidence: { value: number; basis: "heuristic"; signals: string[] };
}

/** Konfiguration der Einstiegspunkterkennung; alle Vorgaben sind sprachneutral. */
export interface EntryPointDetectionOptions {
  /** Konventionelle Namen (Vorgabe siehe `DEFAULT_CONVENTIONAL_ENTRY_NAMES`). */
  conventionalNames?: readonly string[];
  /** Pfadmarker fuer Testdateien (Vorgabe siehe `DEFAULT_TEST_PATH_MARKERS`). */
  testPathMarkers?: readonly string[];
  /** Verzeichnissegmente, die auf Routen hindeuten (Vorgabe siehe `DEFAULT_ROUTE_DIRECTORY_SEGMENTS`). */
  routeDirectorySegments?: readonly string[];
  /**
   * Symbolarten, die ueberhaupt als Einstiegspunkt in Frage kommen.
   * Vorgabe: alle. Wer nur ausfuehrbare Symbole will, schraenkt hier ein.
   */
  eligibleSymbolKinds?: readonly string[];
}

/** Ergebnis der Einstiegspunkterkennung. */
export interface EntryPointSetV1 {
  schemaVersion: 1;
  /** Immer `true` — die gesamte Erkennung ist Heuristik (WP-88). */
  isHeuristic: true;
  /** Aufsteigend nach `symbolId` (Codepoints). */
  entryPoints: EntryPointV1[];
  countsByKind: Record<EntryPointKind, number>;
}
