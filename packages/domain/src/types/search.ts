/**
 * Suchvertraege (spec.md §13) und Abrufkern-Erweiterung (vision.md §1d).
 */
import { uniqueSortedByCodepoints } from "../ordering.js";
import { RANKER_VERSION } from "../versions.js";

import type { ParseQuality, SourceRange } from "./common.js";
import type { ComplexitySummaryV1 } from "./complexity.js";
import type { ToolWarningV1 } from "./envelope.js";
import type { FindabilityCause, FindabilitySummaryV1 } from "./findability.js";
import type { SkipLedgerEntryV1 } from "./skip-ledger.js";

/** Search stayed usable, but its backing index generation is not measurement-safe. */
export const INDEX_CONTEXT_INCOMPLETE_WARNING_CODE = "INDEX_CONTEXT_INCOMPLETE";

/** Content-hash verification of the checked-out sources, separate from retrieval relevance. */
export interface IndexFreshnessV1 {
  status: "fresh" | "stale" | "unknown" | "incompatible";
  checkedAt: string;
  repositories: Array<{
    repoId: string;
    refId: string;
    status: IndexFreshnessV1["status"];
    reason: string;
    filesChecked: number;
    indexedAt?: string;
    indexedCorpusFingerprint?: string;
    currentCorpusFingerprint?: string;
  }>;
}

/** Search request (spec.md §13.1) — exact spec shape. */
export interface SearchRequestV1 {
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
  /** ISO-8601 timestamp lower bound for change recency filters. */
  changedSince?: string;
  includeContext?: boolean;
  includeLinked?: boolean;
  diversify?: boolean;
  minScore?: number;
}

/**
 * A deduplicated sibling fragment of a result's symbol (spec.md §13.5).
 * Slim reference by design — the primary fragment carries the full payload.
 */
export interface RelatedFragmentV1 {
  chunkId: string;
  chunkKind: string;
  fragmentIndex?: number;
  startLine: number;
  endLine: number;
  /** Final score the fragment achieved before dedupe. */
  score: number;
}

/** Search result (spec.md §13.6) — exact spec shape plus `relatedFragments`. */
export interface SearchResultV1 {
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
    /** Per-boost score components, visible in debug/JSON mode (spec.md §13.3). */
    boosts?: Record<string, number>;
  };
  complexity?: ComplexitySummaryV1;
  parseQuality: ParseQuality;
  indexGeneration: string;
  /** Deduplicated sibling fragments of the same symbol (spec.md §13.5). */
  relatedFragments?: RelatedFragmentV1[];
}

/**
 * One result group per embedding profile (spec.md §13.4). Scores are only
 * comparable INSIDE a group; groups from incompatible profiles must never be
 * merged into one absolute ranking.
 */
export interface SearchResultGroupV1 {
  embeddingProfileId: string;
  /** Repositories contributing to this group's collection. */
  repoIds: string[];
  results: SearchResultV1[];
  /**
   * True when the group's ordering was rank-normalized against other groups
   * (opt-in, architecture.md §18.3); always accompanied by a caveat.
   */
  rankNormalized: boolean;
  caveats: string[];
}

/**
 * Search response (referenced by spec.md §22; shape is an Untangle decision —
 * see README "Entscheidungen"). Profile separation is structural: one group
 * per embedding profile, per spec.md §13.4.
 */
export interface SearchResponseV1 {
  schemaVersion: 1;
  query: string;
  workspaceId: string;
  /** One group per embedding profile; a single-profile workspace has one group. */
  groups: SearchResultGroupV1[];
  /** True when more than one profile group is present (spec.md §13.4 notice duty). */
  profileSeparation: boolean;
  totalResults: number;
  warnings: string[];
  /** Latencies measured separately (spec.md §26.2). */
  timings?: {
    queryEmbeddingMs?: number;
    vectorSearchMs?: number;
    totalMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Abrufkern: normalisierte Query, Score-Zerlegung, Treffer (spec.md §13;
// vision.md §1d)
// ---------------------------------------------------------------------------

/**
 * ABGRENZUNG ZU `SearchRequestV1` (wichtig fuer alle Konsumenten):
 *
 * - `SearchRequestV1` ist die Form AN DER WERKZEUGGRENZE (spec.md §13.1):
 *   ungeprueft, alles optional, exakt wie die Spezifikation sie vorgibt.
 * - `SearchQueryV1` ist dieselbe Anfrage NACH Validierung und Normalisierung:
 *   Pflichtfelder gefuellt, Filterlisten dedupliziert und nach Codepoints
 *   sortiert, Widersprueche abgelehnt. Nur diese Form ist deterministisch
 *   serialisierbar und damit fingerabdruckfaehig.
 *
 * `normalizeSearchQuery()` ist der einzige Weg von der einen zur anderen Form.
 *
 * NAMENSENTSCHEIDUNG: Die Ergebnismenge heisst `SearchResultSetV1`, nicht
 * `SearchResultV1`. `SearchResultV1` ist in spec.md §13.6 als EINZELTREFFER
 * definiert und bereits oben in dieser Datei exportiert; den Namen fuer die
 * Menge zu uebernehmen waere eine brechende Umdeutung (BUILD_PLAN R7:
 * Aenderungen nur additiv). Der Einzeltreffer des Abrufkerns heisst
 * `SearchHitV1` und ergaenzt `SearchResultV1` um die vollstaendige
 * Score-Zerlegung.
 */

/** Zeitraum fuer Aenderungssuche (spec.md §13.1 `changedSince`, erweitert). */
export interface SearchTimeRangeV1 {
  /** ISO-8601-Zeitstempel, untere Grenze (inklusiv). */
  since: string;
  /** ISO-8601-Zeitstempel, obere Grenze (exklusiv); offen, wenn nicht gesetzt. */
  until?: string;
}

/** Komplexitaetsfilter (spec.md §13.1). Min/Max jeweils inklusiv. */
export interface SearchComplexityFilterV1 {
  cyclomaticMin?: number;
  cyclomaticMax?: number;
  cognitiveMin?: number;
  cognitiveMax?: number;
  riskMin?: number;
  riskMax?: number;
}

/**
 * Findability-Filter (vision.md §1d): schwer auffindbare Symbole sind
 * Hotspots und muessen wie Komplexitaetshotspots filterbar sein.
 */
export interface SearchFindabilityFilterV1 {
  /** Nur Treffer mit Findability-Score <= diesem Wert. */
  maxScore?: number;
  /** Nur Treffer mit Findability-Score >= diesem Wert. */
  minScore?: number;
  /** Nur Treffer, deren Diagnose eine dieser Ursachen nennt. */
  causes?: FindabilityCause[];
}

/**
 * Normalisierte Filter. Alle Listen sind vorhanden (ggf. leer), dedupliziert
 * und nach Codepoints sortiert — eine leere Liste heisst „kein Filter".
 */
export interface SearchFiltersV1 {
  repoIds: string[];
  refIds: string[];
  commitSha?: string;
  languages: string[];
  /** Glob-Muster auf "/"-normalisierte, repo-relative Pfade. */
  pathGlobs: string[];
  symbolNames: string[];
  symbolKinds: string[];
  chunkKinds: string[];
  complexity?: SearchComplexityFilterV1;
  findability?: SearchFindabilityFilterV1;
  changed?: SearchTimeRangeV1;
}

/** Validierte, normalisierte Suchanfrage. */
export interface SearchQueryV1 {
  schemaVersion: 1;
  /** Suchtext, getrimmt; Identifier-Zeichen bleiben unangetastet (spec.md §13.2). */
  text: string;
  workspaceId: string;
  filters: SearchFiltersV1;
  /** Anzahl zurueckgegebener Treffer je Profilgruppe. */
  limit: number;
  /** Kandidatenzahl vor Rerank/Dedupe; >= `limit`. */
  candidateLimit: number;
  minScore?: number;
  /** MMR-Diversifizierung (spec.md §13.2 Schritt 10). */
  diversify: boolean;
  /** Strukturellen Kontext ergaenzen (spec.md §13.2 Schritt 11). */
  includeGraphContext: boolean;
  /** Verknuepfte Artefakte/Symbole mitliefern (spec.md §13.1 `includeLinked`). */
  includeLinked: boolean;
  /** Chunk-Inhalt mitliefern; Default false (tokenarm fuer Agents). */
  includeContent: boolean;
  rankerVersion: typeof RANKER_VERSION;
}

/**
 * Score-Bestandteile (spec.md §13.3). Genau EIN `base_hybrid` je Zerlegung;
 * alles Weitere sind Boosts (positiv) oder Strafen (negativ).
 */
export const SCORE_COMPONENT_KINDS = [
  "base_hybrid",
  "exact_symbol_boost",
  "exact_path_boost",
  "repo_priority_boost",
  "graph_proximity_boost",
  "recency_boost",
  "duplicate_penalty",
  /**
   * ADDITIV ergaenzt (WP Abrufkern/Suche): Komplexitaets-Modifikator.
   *
   * vision.md §1b/§1d behandelt Suche und Komplexitaet als zwei Blickwinkel
   * auf dieselbe Frage; eine Anfrage darf deshalb ausdruecklich einfachen
   * (oder ausdruecklich komplexen) Code bevorzugen. Der Modifikator ist
   * vorzeichenbehaftet und steht NIE im Default-Ranking — er erscheint nur,
   * wenn die Anfrage ihn anfordert, und ist dann in der Zerlegung sichtbar.
   * Ohne eigene Kennung waere diese Verschiebung als anonymer Teil des
   * Basisscores unsichtbar, und genau das verbietet spec.md §13.3.
   */
  "complexity_modifier",
] as const;

export type ScoreComponentKind = (typeof SCORE_COMPONENT_KINDS)[number];

/**
 * Ein Bestandteil des Endscores. `contribution` ist der Betrag, der
 * tatsaechlich in `final` eingeht (vorzeichenbehaftet); `rawValue` und
 * `weight` zeigen, WORAUS er entstanden ist.
 */
export interface ScoreComponentV1 {
  kind: ScoreComponentKind;
  /** Normalisierter Rohwert des Signals. */
  rawValue: number;
  weight: number;
  /** `rawValue * weight`, vorzeichenbehaftet. */
  contribution: number;
  /** Beleg, warum der Bestandteil ausgeloest hat, z. B. "path == src/a.ts". */
  evidence?: string;
}

/**
 * Vollstaendige Score-Zerlegung eines Treffers.
 *
 * Sie ist der Kern dieses Vertrags: der Nutzer muss sehen, WARUM etwas rankt,
 * nicht nur DASS. Sie ist zugleich die Grundlage der Findability-Diagnose
 * (vision.md §1d) — ohne Zerlegung liesse sich „der richtige Treffer rankt
 * niedrig" nicht von „es gibt keinen Treffer" unterscheiden.
 */
export interface ScoreBreakdownV1 {
  schemaVersion: 1;
  /** Endscore = Summe aller `components[].contribution`. */
  final: number;
  components: ScoreComponentV1[];
  /** Rohsignale hinter `base_hybrid`, zur Nachvollziehbarkeit. */
  inputs: {
    /** Cosine-Score des dichten Vektors. */
    dense?: number;
    /** Rangposition im BM25-Zweig (1-basiert). */
    sparseRank?: number;
    /** RRF-Wert innerhalb DERSELBEN Collection (spec.md §13.4). */
    rrf?: number;
    // ADDITIV ergaenzt (WP Abrufkern/Suche), alle optional: die Fusion
    // dreier Ranglisten (dense, lexikalisch, exakter Symbolname) laesst sich
    // ohne die Rangposition JE ZWEIG nicht nachrechnen. `sparseRank` allein
    // beantwortet nicht, ob ein Treffer ueber Semantik, ueber Text oder ueber
    // den Namen nach oben kam.
    /** Rangposition im dichten Zweig (1-basiert); fehlt, wenn nicht enthalten. */
    denseRank?: number;
    /** Roher Score des lexikalischen Zweigs (BM25), im Abrufkern berechnet. */
    lexicalScore?: number;
    /** Rangposition im lexikalischen Zweig (1-basiert). */
    lexicalRank?: number;
    /** Rangposition im Zweig der exakten Symbolnamen-Treffer (1-basiert). */
    symbolRank?: number;
  };
  rankerVersion: typeof RANKER_VERSION;
  /**
   * True, wenn Boosts begrenzt wurden, damit sie Dense/BM25 nicht vollstaendig
   * ueberstimmen (spec.md §13.3). Dann MUSS `clampReason` gesetzt sein; die
   * Summenprobe gilt in diesem Fall fuer die begrenzten Beitraege.
   */
  clamped: boolean;
  clampReason?: string;
}

/** Persistierter Graph, aus dem eine Suchbeziehung stammt. */
export const SEARCH_GRAPH_RELATION_SOURCES = ["file_graph", "symbol_graph"] as const;
export type SearchGraphRelationSource = (typeof SEARCH_GRAPH_RELATION_SOURCES)[number];

/** Richtung der Beziehung relativ zum Suchtreffer. */
export const SEARCH_GRAPH_RELATION_DIRECTIONS = ["incoming", "outgoing"] as const;
export type SearchGraphRelationDirection = (typeof SEARCH_GRAPH_RELATION_DIRECTIONS)[number];

/**
 * Eine DIREKTE, persistierte Beziehung eines Suchtreffers.
 *
 * Die Zielseite steht absichtlich vollstaendig auf jeder Zeile. Insbesondere
 * ist `crossRepository` kein aus Repository-IDs zu erratendes Anzeige-Detail,
 * sondern die gespeicherte Graphaussage selbst.
 */
export interface SearchGraphRelationV1 {
  schemaVersion: 1;
  source: SearchGraphRelationSource;
  edgeId: string;
  direction: SearchGraphRelationDirection;
  edgeKind: string;
  repoId: string;
  refId: string;
  fileId: string;
  /** "/"-normalisierter, repo-relativer Pfad des anderen Endpunkts. */
  path: string;
  crossRepository: boolean;
  /** Nur bei einer Beziehung aus dem Symbolgraphen. */
  symbol?: {
    id: string;
    name: string;
    qualifiedName: string;
    kind: string;
  };
}

/** Benannte Gruende, warum angeforderte Graphbeziehungen fehlen. */
export const SEARCH_GRAPH_OMISSION_REASONS = [
  "graph_unavailable",
  "graph_partial",
  "source_not_in_graph",
  "symbol_id_missing",
  "unresolved_endpoint",
  "heuristic_endpoint",
  "ambiguous_endpoint",
  "endpoint_missing",
  "provider_result_missing",
  "relation_limit",
] as const;

export type SearchGraphOmissionReason = (typeof SEARCH_GRAPH_OMISSION_REASONS)[number];

/** Ein expliziter, gezaehlter Auslassungsgrund einer Anreicherung. */
export interface SearchGraphOmissionV1 {
  reason: SearchGraphOmissionReason;
  /** Anzahl betroffener Kanten/Faelle; bei unbekannter Graphgroesse genau 1. */
  count: number;
  detail: string;
}

/**
 * Begrenzte Nachbarschaft eines Treffers. Beziehungen und Auslassungen sind
 * codepoint-sortiert; `truncated` ist genau dann wahr, wenn `relation_limit`
 * in `omissions` vorkommt.
 */
export interface SearchGraphRelationsV1 {
  schemaVersion: 1;
  relations: SearchGraphRelationV1[];
  relationLimit: number;
  truncated: boolean;
  omittedCount: number;
  omissions: SearchGraphOmissionV1[];
}

/** Ein Suchtreffer mit vollstaendiger Score-Zerlegung. */
export interface SearchHitV1 {
  schemaVersion: 1;
  /** 1-basierter Rang INNERHALB der Profilgruppe. */
  rank: number;
  repoId: string;
  repoLabel: string;
  refId: string;
  refName: string;
  commitSha?: string;
  fileId: string;
  /** "/"-normalisierter, repo-relativer Pfad. */
  filePath: string;
  range: SourceRange;
  language: string;
  parseQuality: ParseQuality;
  chunkId: string;
  chunkKind: string;
  fragmentIndex?: number;
  fragmentCount?: number;
  symbolId?: string;
  symbolName?: string;
  symbolFqn?: string;
  symbolKind?: string;
  signature?: string;
  score: ScoreBreakdownV1;
  /** Dedupe-Schluessel (architecture.md §18.4, `buildDedupeKey`). */
  dedupeKey: string;
  /** Weitere Fragmente desselben Symbols (spec.md §13.5). */
  relatedFragments: RelatedFragmentV1[];
  embeddingProfileId: string;
  indexGeneration: string;
  complexity?: ComplexitySummaryV1;
  /** Findability des Treffersymbols, sofern berechnet (vision.md §1d). */
  findability?: FindabilitySummaryV1;
  /** Chunk-Inhalt; nur gesetzt, wenn die Anfrage ihn angefordert hat. */
  content?: string;
  /** Grund, warum `content` fehlt, obwohl er angefordert war (E4). */
  contentOmittedReason?: string;
  /** Direkte ein- und ausgehende Beziehungen des persistierten Dateigraphen. */
  graphContext?: SearchGraphRelationsV1;
  /** Direkte, eindeutig aufgeloeste Beziehungen des persistierten Symbolgraphen. */
  linkedSymbols?: SearchGraphRelationsV1;
  /**
   * ADDITIV ergaenzt (E4): Payload-Felder, die im Speicher FEHLTEN und beim
   * Lesen durch dokumentierte Ersatzwerte gefuellt wurden.
   *
   * Ohne dieses Feld sieht ein Treffer in jedem Feld vollstaendig aus, obwohl
   * etwa `end_line` nur geraten ist. Steht ein Feldname hier, ist der
   * zugehoerige Wert des Treffers ein ERSATZ, kein gespeicherter Wert.
   * Nach Codepoints sortiert; fehlt, wenn nichts ersetzt wurde.
   */
  incompletePayloadFields?: string[];
}

/**
 * Trefferguppe eines Embedding-Profils (spec.md §13.4). Scores sind NUR
 * innerhalb einer Gruppe vergleichbar.
 */
/**
 * Wie sich die Suche verhaelt, wenn die Relevanzpolicy die Evidenz fuer
 * unzureichend haelt.
 *
 * - `strict` — die Treffer werden verworfen und die Menge ist leer. Richtig
 *   fuer eine Behauptung wie „das gibt es hier nicht".
 * - `evidence` — die Treffer bleiben stehen und tragen das Verdikt mit. Ein
 *   Agent kann einen schwachen Treffer beurteilen und verwerfen; mit
 *   Schweigen kann er nichts anfangen.
 *
 * Das Verdikt selbst ist in BEIDEN Faellen dasselbe. Nur die Trefferliste
 * unterscheidet sich — und genau deshalb darf sie nie die Quelle des Verdikts
 * sein.
 */
export const SEARCH_ABSTENTIONS = ["strict", "evidence"] as const;

export type SearchAbstention = (typeof SEARCH_ABSTENTIONS)[number];

/**
 * Das Urteil der Relevanzpolicy ueber eine Trefferguppe.
 *
 * Dies ist die EINZIGE gueltige Quelle des Verdikts. `hits.length` sagt
 * darueber nichts: unter `evidence` stehen Treffer da und die Policy hat sie
 * trotzdem fuer unzureichend gehalten, unter `strict` ist die Liste leer und
 * die Policy hat womoeglich nie entschieden (`not_evaluated`).
 */
export interface SearchRelevanceVerdictV1 {
  /** Welches Verhalten fuer diesen Lauf galt. */
  abstention: SearchAbstention;
  status: "accepted" | "rejected" | "not_evaluated";
  /** Warum — die Basis aus `RelevanceDecisionV1`. */
  basis: string;
  /** Kalibrierung, unter der entschieden wurde; fehlt, wenn keine griff. */
  calibrationId?: string;
}

export interface SearchHitGroupV1 {
  embeddingProfileId: string;
  /**
   * Beobachtete Indexgenerationen des tatsächlich durchsuchten Profil-/Repo-/Ref-Kontexts.
   * Anders als Hit-Felder bleibt diese Beobachtung auch erhalten, wenn Ranking oder
   * Relevanzpolicy alle Kandidaten verwirft. Fehlt das Feld bei einem älteren Producer,
   * dürfen Consumer nur aus Treffern ableiten und müssen einen leeren Fall als unbekannt behandeln.
   * Der Sentinel `unknown` hält einen lesbaren Legacy-Treffer sichtbar, macht den Messkontext aber
   * ausdrücklich unvollständig.
   */
  indexGenerations?: string[];
  /**
   * Fingerprint of the exact completed corpus revisions covered by this
   * profile search. Missing means the corpus snapshot is not comparable.
   */
  corpusRevisionFingerprint?: string;
  /** Repositories, die zu dieser Gruppe beitragen. */
  repoIds: string[];
  hits: SearchHitV1[];
  /** True, wenn gegen andere Gruppen rangnormalisiert wurde (opt-in). */
  rankNormalized: boolean;
  caveats: string[];
  /**
   * ADDITIV ergaenzt (E4): Gesetzt, wenn dieses Profil GAR NICHT durchsucht
   * wurde — etwa weil die angefragten Repositories saemtlich ausserhalb seines
   * Geltungsbereichs liegen und eine leere `in`-Liste kein Filter waere.
   *
   * Ohne dieses Feld sieht eine solche Gruppe aus wie eine durchsuchte Gruppe
   * ohne Treffer, und ein Leser (die Findability-Sonde ist einer) macht daraus
   * „es gibt keinen Treffer" — eine Tatsachenbehauptung ueber den Code, die
   * auf keiner Beobachtung steht. `hits: []` MIT diesem Feld heisst „nicht
   * gesucht", `hits: []` OHNE dieses Feld heisst „gesucht, nichts gefunden".
   * Die Begruendung steht zusaetzlich im Skip-Ledger der Ergebnismenge.
   */
  notSearchedReason?: string;
  /**
   * ADDITIV ergaenzt (E4): das Urteil der Relevanzpolicy ueber diese Gruppe.
   *
   * Dieses Feld ist die EINZIGE gueltige Quelle des Verdikts. `hits.length`
   * ist es nicht und war es nie — unter `evidence` stehen Treffer da UND die
   * Policy hat sie fuer unzureichend gehalten. Zehn Stellen im Repository
   * haben die Enthaltung frueher aus einer leeren Liste erschlossen; jede
   * davon haette bei einem Verhaltenswechsel still ihre Bedeutung geaendert.
   *
   * ABWESENHEIT heisst: fuer diesen Workspace ist keine Relevanzpolicy
   * gebunden, es gibt also kein Verdikt — dasselbe Abwesenheitsmuster wie bei
   * `notSearchedReason`. Sie heisst NICHT „akzeptiert".
   */
  relevanceDecision?: SearchRelevanceVerdictV1;
  /**
   * Erklaerbare Beobachtungen ueber den Retrieval-Trichter. Sie beeinflussen
   * weder Ranking noch Fingerabdruck; sie machen nur sichtbar, wie breit und
   * mehrdeutig die Suche vor dem finalen Limit war.
   */
  retrieval?: SearchRetrievalDiagnosticsV1;
}

/** Kandidatenzahlen eines einzelnen Retrieval-Zweigs vor der Vereinigung. */
export interface SearchRetrievalBranchCountsV1 {
  dense: number;
  sparse: number;
  symbol: number;
}

/**
 * Deterministische Diagnose des Retrieval-Trichters fuer eine Profilgruppe.
 * Alle Zahlen sind Zaehler, keine geschaetzte Precision. Ob ein Kandidat
 * relevant war, ist erst nach expliziter Zielbestaetigung bekannt.
 */
export interface SearchRetrievalDiagnosticsV1 {
  /** Vom Speicher gelieferte Eintraege je Zweig, vor Deduplizierung. */
  branchCandidateCounts: SearchRetrievalBranchCountsV1;
  /** Eindeutige, lesbare Kandidaten nach Vereinigung der Zweige. */
  uniqueRetrievedCandidateCount: number;
  /** Kandidaten nach Scope-, Pfad- und Findability-Filtern. */
  eligibleCandidateCount: number;
  /** Kandidaten, die mindestens einen aktiven Ranking-Zweig erreichten. */
  rankedCandidateCount: number;
  /** Primaertreffer nach Symbol-/Fragment-Deduplizierung. */
  deduplicatedCandidateCount: number;
  /**
   * Treffer nach Score-Filtern und nach dem, was das WIRKSAME
   * Abstinenzverhalten entfernt hat — vor dem Ausgabelimit.
   *
   * Diese Zahl ist KEIN Unterscheidungsmerkmal dafuer, ob die Relevanzpolicy
   * enthalten hat. Unter `evidence` entfernt die Policy nichts, eine
   * abgelehnte Gruppe meldet hier also einen Wert groesser null. Wer wissen
   * will, wie die Policy entschieden hat, liest
   * {@link SearchHitGroupV1.relevanceDecision}.
   */
  qualifiedHitCount: number;
  /** Tatsaechlich ausgegebene Treffer. */
  returnedHitCount: number;
  /** Verschiedene Dateien unter den zulässigen Kandidaten. */
  uniqueEligibleFileCount: number;
  /** Verschiedene bekannte Symbole unter den zulässigen Kandidaten. */
  uniqueEligibleSymbolCount: number;
  /**
   * Normalisierte Dateistreuung in [0, 1]: 0 bei hoechstens einem Kandidaten,
   * sonst `(uniqueFiles - 1) / (eligibleCandidates - 1)`.
   */
  eligibleFileDispersion: number;
  /** Abstand zwischen Rang 1 und 2 im finalen Score; null bei < 2 Treffern. */
  topScoreGap: number | null;
  /** Mindestens ein Abrufzweig meldete genau das wirksame Kandidatenlimit. */
  candidateLimitReached: boolean;
}

/**
 * Ergebnismenge einer `SearchQueryV1` (siehe Namensentscheidung oben).
 *
 * `skipped` ist Pflicht und darf leer sein — aber nur, wenn wirklich nichts
 * uebersprungen wurde. Ausgefilterte, nicht indizierte oder wegen Budget
 * verworfene Kandidaten gehoeren hier hinein (E4).
 */
export interface SearchResultSetV1 {
  schemaVersion: 1;
  indexFreshness?: IndexFreshnessV1;
  /** Fingerabdruck der Anfrage (`buildSearchQueryFingerprint`). */
  queryFingerprint: string;
  /**
   * Fingerabdruck der wirksamen Ranking-/Retrieval-Konfiguration ohne
   * Suchtext oder fachliche Filter; dient ausschliesslich der Vergleichbarkeit.
   */
  rankingContextFingerprint?: string;
  query: SearchQueryV1;
  groups: SearchHitGroupV1[];
  /** True, wenn mehr als eine Profilgruppe vorliegt (spec.md §13.4). */
  profileSeparation: boolean;
  totalHits: number;
  skipped: SkipLedgerEntryV1[];
  warnings: ToolWarningV1[];
  timings?: {
    queryEmbeddingMs?: number;
    vectorSearchMs?: number;
    totalMs?: number;
  };
  /**
   * Optionale, ausschliesslich beobachtende Korrelation zu einer explizit
   * gestarteten Search Journey. Fehlt bei normaler Suche vollstaendig.
   */
  searchObservation?:
    | {
        sessionId: string;
        attemptId: string;
        status: "recorded";
      }
    | {
        sessionId: string;
        status: "not_recorded";
        warningCode: string;
      };
}

/** Vorgaben, die `normalizeSearchQuery` aus der Konfiguration bekommt. */
export interface SearchQueryDefaults {
  workspaceId: string;
  limit: number;
  candidateLimit: number;
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  const trimmed = values.map((value) => value.trim()).filter((value) => value !== "");
  return uniqueSortedByCodepoints(trimmed);
}

function assertIsoTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`search query field "${label}" is not a valid ISO-8601 timestamp: "${value}"`);
  }
}

function assertRange(min: number | undefined, max: number | undefined, label: string): void {
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`search query filter "${label}" has min > max (${min} > ${max})`);
  }
}

/**
 * Validiert und normalisiert eine `SearchRequestV1` zu einer `SearchQueryV1`.
 *
 * Deterministisch: gleiche Anfrage, gleiche Ausgabe — Listen dedupliziert und
 * nach Codepoints sortiert (nie `localeCompare`). Widersprueche werden
 * abgelehnt statt stillschweigend zurechtgebogen: leerer Suchtext,
 * `limit <= 0`, `candidateLimit < limit`, Min groesser als Max, ungueltige
 * Zeitstempel.
 */
export function normalizeSearchQuery(
  request: SearchRequestV1,
  defaults: SearchQueryDefaults,
): SearchQueryV1 {
  const text = request.query.trim();
  if (text === "") {
    throw new Error("search query text must not be empty");
  }
  // WP-190: GETRIMMT, nicht nur auf Leere geprueft. Jedes andere Textfeld
  // dieser Funktion wird getrimmt; `workspaceId` blieb als einziges roh
  // stehen. Die Folge war kein Fehler, sondern etwas Schlimmeres: der
  // Speicherfilter trimmt selbst (`buildPayloadFilter`), die prozessinterne
  // Gegenpruefung vergleicht den rohen Wert — eine Anfrage mit
  // Rand-Leerzeichen holte also Punkte aus dem Speicher und verwarf jeden
  // einzelnen davon wieder. Ergebnis: null Treffer und ein Ledger voller
  // „gehoert zu einem fremden Workspace" ueber den EIGENEN Workspace.
  const workspaceId = (request.workspaceId ?? defaults.workspaceId).trim();
  if (workspaceId === "") {
    throw new Error("search query requires a workspaceId (request or defaults)");
  }
  const limit = request.limit ?? defaults.limit;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`search query limit must be a positive integer, got ${String(limit)}`);
  }
  const candidateLimit = request.candidateLimit ?? Math.max(defaults.candidateLimit, limit);
  if (!Number.isInteger(candidateLimit) || candidateLimit < limit) {
    throw new Error(
      `search query candidateLimit must be an integer >= limit (${String(candidateLimit)} < ${String(limit)})`,
    );
  }
  if (request.minScore !== undefined && !Number.isFinite(request.minScore)) {
    throw new Error("search query minScore must be a finite number");
  }

  const complexity = request.complexity;
  if (complexity !== undefined) {
    assertRange(complexity.cyclomaticMin, complexity.cyclomaticMax, "cyclomatic");
    assertRange(complexity.cognitiveMin, complexity.cognitiveMax, "cognitive");
    assertRange(complexity.riskMin, complexity.riskMax, "risk");
  }
  if (request.changedSince !== undefined) {
    assertIsoTimestamp(request.changedSince, "changedSince");
  }

  const filters: SearchFiltersV1 = {
    repoIds: normalizeStringList(request.repositories),
    refIds: normalizeStringList(request.refs),
    languages: normalizeStringList(request.languages),
    pathGlobs: normalizeStringList(request.pathGlob),
    symbolNames: normalizeStringList(request.symbolNames),
    symbolKinds: normalizeStringList(request.symbolKinds),
    chunkKinds: normalizeStringList(request.chunkKinds),
    ...(request.commitSha === undefined ? {} : { commitSha: request.commitSha }),
    ...(complexity === undefined ? {} : { complexity }),
    ...(request.changedSince === undefined ? {} : { changed: { since: request.changedSince } }),
  };

  return {
    schemaVersion: 1,
    text,
    workspaceId,
    filters,
    limit,
    candidateLimit,
    ...(request.minScore === undefined ? {} : { minScore: request.minScore }),
    diversify: request.diversify ?? false,
    includeGraphContext: request.includeContext ?? false,
    includeLinked: request.includeLinked ?? false,
    includeContent: false,
    rankerVersion: RANKER_VERSION,
  };
}

/** Befund der Score-Pruefung. */
export interface ScoreBreakdownIssue {
  kind:
    | "missing_base"
    | "duplicate_base"
    | "sum_mismatch"
    | "contribution_mismatch"
    | "no_clamp_reason";
  message: string;
}

/** Ergebnis von {@link validateScoreBreakdown}. */
export interface ScoreBreakdownValidationResult {
  valid: boolean;
  /** Summe aller Beitraege. */
  computedFinal: number;
  /** Anteil des Basis-Hybridscores am Betrag aller Beitraege, in [0, 1]. */
  baseShare: number;
  issues: ScoreBreakdownIssue[];
}

/**
 * Prueft die Score-Zerlegung: genau ein `base_hybrid`, jeder Beitrag gleich
 * `rawValue * weight`, `final` gleich der Summe aller Beitraege — jeweils bis
 * auf `epsilon`. `baseShare` wird mitgeliefert, damit Aufrufer die Regel
 * „Boosts duerfen Dense/BM25 nicht vollstaendig ueberstimmen" (spec.md §13.3)
 * gegen ihre eigene Schwelle pruefen koennen; die Schwelle selbst ist Politik
 * und gehoert nicht in den Vertrag.
 */
export function validateScoreBreakdown(
  breakdown: ScoreBreakdownV1,
  epsilon = 1e-9,
): ScoreBreakdownValidationResult {
  const issues: ScoreBreakdownIssue[] = [];
  const baseComponents = breakdown.components.filter(
    (component) => component.kind === "base_hybrid",
  );
  if (baseComponents.length === 0) {
    issues.push({
      kind: "missing_base",
      message: "score breakdown has no base_hybrid component (spec.md §13.3)",
    });
  }
  if (baseComponents.length > 1) {
    issues.push({
      kind: "duplicate_base",
      message: `score breakdown has ${baseComponents.length} base_hybrid components, expected exactly one`,
    });
  }
  for (const component of breakdown.components) {
    if (Math.abs(component.rawValue * component.weight - component.contribution) > epsilon) {
      issues.push({
        kind: "contribution_mismatch",
        message: `component "${component.kind}": contribution ${component.contribution} != rawValue * weight (${component.rawValue} * ${component.weight})`,
      });
    }
  }
  const computedFinal = breakdown.components.reduce(
    (sum, component) => sum + component.contribution,
    0,
  );
  if (Math.abs(computedFinal - breakdown.final) > epsilon) {
    issues.push({
      kind: "sum_mismatch",
      message: `final ${breakdown.final} != sum of contributions ${computedFinal}`,
    });
  }
  if (breakdown.clamped && (breakdown.clampReason ?? "") === "") {
    issues.push({
      kind: "no_clamp_reason",
      message: "clamped scores must name the clamp reason (E4)",
    });
  }
  const absoluteTotal = breakdown.components.reduce(
    (sum, component) => sum + Math.abs(component.contribution),
    0,
  );
  const baseMagnitude = baseComponents.reduce(
    (sum, component) => sum + Math.abs(component.contribution),
    0,
  );
  const baseShare = absoluteTotal === 0 ? 0 : baseMagnitude / absoluteTotal;

  return { valid: issues.length === 0, computedFinal, baseShare, issues };
}
