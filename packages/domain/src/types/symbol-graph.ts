/**
 * Symbolgraph — Kanten, Confidence und Traversierung (spec.md §15;
 * architecture.md §17).
 *
 * `SymbolNodeV1` ist bereits in `types/symbol.ts` definiert (exakte Form aus
 * spec.md §15.1) und wird hier ABSICHTLICH nicht wiederholt — ein zweiter
 * Knotentyp waere genau die Vertragsspaltung, die dieses Modul verhindern
 * soll. Neu ist `SymbolEdgeV1`: die Verallgemeinerung von `CallEdgeV1`
 * (spec.md §15.2) auf alle Beziehungsarten zwischen Symbolen.
 *
 * Zwei Regeln gelten fuer jede Kante:
 * 1. Sie traegt eine Aufloesungsart — wir behaupten nie mehr Genauigkeit, als
 *    wir haben (`ambiguous` ist nie eine sichere Kante, architecture.md §17.2).
 * 2. Sie traegt eine Confidence mit Basis und Signalen — eine Zahl ohne
 *    Herkunft ist keine Aussage.
 */
import type { SYMBOL_GRAPH_VERSION } from "../versions.js";

import type { CallConfidence, SourceRange } from "./common.js";

/**
 * Beziehungsarten zwischen Symbolen. `calls` entspricht `CallEdgeV1`;
 * `unresolved` haelt die Beziehung fest, deren Ziel unbekannt blieb (E4).
 */
export const SYMBOL_EDGE_KINDS = [
  "calls",
  "references",
  "extends",
  "implements",
  "overrides",
  "unresolved",
] as const;

export type SymbolEdgeKind = (typeof SYMBOL_EDGE_KINDS)[number];

/**
 * Aufloesungsart einer Kante.
 *
 * - `exact`: das Ziel ist eindeutig bestimmt (Deklaration im selben Scope,
 *   eindeutiger Export, aufgeloester Import).
 * - `heuristic`: das Ziel ist plausibel, aber nicht bewiesen (Namensgleichheit
 *   ueber Dateigrenzen, dynamische Aufrufe, Duck Typing).
 * - `ambiguous`: mehrere Kandidaten passen; die Kante DARF nie wie eine
 *   sichere behandelt werden (architecture.md §17.2).
 * - `unresolved`: kein Kandidat gefunden. Diese vierte Auspraegung ergaenzt die
 *   drei Aufloesungsarten, weil E4 verlangt, dass der Fehlschlag darstellbar
 *   bleibt statt zu verschwinden.
 */
export const SYMBOL_EDGE_RESOLUTIONS = ["exact", "heuristic", "ambiguous", "unresolved"] as const;

export type SymbolEdgeResolution = (typeof SYMBOL_EDGE_RESOLUTIONS)[number];

/** Benannte Gruende, warum eine Symbolkante kein Ziel bekam (E4). */
export const SYMBOL_EDGE_UNRESOLVED_REASONS = [
  "no_candidate_found",
  "target_outside_index",
  "target_in_unparsed_file",
  "dynamic_dispatch_not_statically_analyzable",
  "import_unresolved",
  "budget_exceeded",
] as const;

export type SymbolEdgeUnresolvedReason = (typeof SYMBOL_EDGE_UNRESOLVED_REASONS)[number];

/**
 * Confidence einer Graphaussage. Gleiche Form wie `PortfolioConfidenceV1`
 * (portfolio.md §7), damit im Repository nur EIN Confidence-Begriff existiert.
 *
 * `basis: "deterministic"` ist nur zulaessig, wenn die Aussage aus einer
 * eindeutigen Aufloesung folgt; jede Namens- oder Formheuristik ist
 * `"heuristic"`.
 */
export interface GraphConfidenceV1 {
  /** [0, 1]. */
  value: number;
  basis: "deterministic" | "heuristic";
  /** Beteiligte Signale, z. B. ["unique_export", "import_resolved"]. Nie leer. */
  signals: string[];
}

/** Ein Aufloesungskandidat bei mehrdeutigen Kanten. */
export interface SymbolEdgeCandidateV1 {
  symbolId: string;
  qualifiedName: string;
  repoId: string;
  refId: string;
  /** "/"-normalisierter, repo-relativer Pfad des Kandidaten. */
  filePath: string;
  /** Relatives Gewicht des Kandidaten in [0, 1]; Summe ueber alle Kandidaten <= 1. */
  weight: number;
}

/** Zielangabe einer aufgeloesten Kante. */
export interface SymbolEdgeTargetV1 {
  symbolId: string;
  qualifiedName: string;
  repoId: string;
  refId: string;
  /** "/"-normalisierter, repo-relativer Pfad des Ziels. */
  filePath: string;
}

/** Eine verursachende Stelle im Quelltext (spec.md §15.2 `callSite`). */
export interface SymbolEdgeSiteV1 {
  repoId: string;
  refId: string;
  /** "/"-normalisierter, repo-relativer Pfad. */
  filePath: string;
  range: SourceRange;
  column?: number;
}

/**
 * Kante des Symbolgraphen (Verallgemeinerung von spec.md §15.2).
 *
 * `toName` ist der Name wie im Quelltext geschrieben und bleibt IMMER
 * erhalten — auch wenn die Aufloesung gelingt. Er ist die einzige Angabe, die
 * unabhaengig vom Resolver stimmt.
 */
export interface SymbolEdgeV1 {
  schemaVersion: 1;
  /** Deterministische Kanten-ID (`buildSymbolEdgeId`). */
  edgeId: string;
  workspaceId: string;
  /** Repository des QUELLsymbols. */
  repoId: string;
  refId: string;
  fromSymbolId: string;
  kind: SymbolEdgeKind;
  /** Zielname wie geschrieben, unqualifiziert. */
  toName: string;
  /** Qualifizierer bei Memberzugriff, z. B. "service" in "service.run()". */
  toQualifier?: string;
  resolution: SymbolEdgeResolution;
  /** Gesetzt bei `exact` und `heuristic`, sonst nicht. */
  target?: SymbolEdgeTargetV1;
  /** Gesetzt bei `ambiguous` (mindestens zwei Eintraege), sonst nicht. */
  candidates?: SymbolEdgeCandidateV1[];
  /** Gesetzt bei `unresolved`, sonst nicht. */
  unresolvedReason?: SymbolEdgeUnresolvedReason;
  /** Menschenlesbare Ergaenzung zum Grund; Pflicht bei `unresolved` (E4). */
  unresolvedDetail?: string;
  confidence: GraphConfidenceV1;
  /**
   * True, wenn die Kante eine Repo-Grenze ueberschreitet: bei `exact` und
   * `heuristic`, wenn das Ziel in einem anderen Repository liegt, bei
   * `ambiguous`, wenn MINDESTENS EIN Kandidat das tut. Eine mehrdeutige Kante,
   * deren Kandidaten allesamt fremd sind, ist genauso repo-uebergreifend wie
   * eine eindeutige — sonst zaehlt `crossRepoEdgeCount` sie nicht mit.
   */
  crossRepo: boolean;
  /**
   * Stellen im Quelltext, die diese Kante verursachen. Leer NUR, wenn der
   * Parser keine liefert — dann MUSS `sitesMissingReason` gesetzt sein (E4).
   */
  sites: SymbolEdgeSiteV1[];
  sitesMissingReason?: string;
  /**
   * Laufende Nummer identischer (Quelle, Art, Zielname, Qualifizierer)-Kanten.
   * Teil der Kanten-ID; bewusst NICHT die Zeilennummer (spec.md §5.5).
   */
  occurrenceOrdinal: number;
  graphGeneration: string;
  graphVersion: typeof SYMBOL_GRAPH_VERSION;
}

/**
 * Bildet die Confidence-Stufen von `CallEdgeV1` (spec.md §15.2) auf die
 * Aufloesungsart einer `SymbolEdgeV1` ab. Existiert, damit Symbolgraph,
 * Change-Engine und Suche dieselbe Zuordnung benutzen statt drei eigene:
 *
 * ```text
 * local     → exact       (Deklaration im selben Scope)
 * unique    → exact       (genau ein passender Export)
 * ambiguous → ambiguous
 * external  → heuristic   (Ziel ausserhalb des Index; Bindung nicht bewiesen)
 * unresolved→ unresolved
 * ```
 */
export function symbolEdgeResolutionFromCallConfidence(
  confidence: CallConfidence,
): SymbolEdgeResolution {
  switch (confidence) {
    case "local":
    case "unique":
      return "exact";
    case "ambiguous":
      return "ambiguous";
    case "external":
      return "heuristic";
    case "unresolved":
      return "unresolved";
  }
}

// ---------------------------------------------------------------------------
// Traversierung (spec.md §15.3; architecture.md §17.4)
// ---------------------------------------------------------------------------

/** Richtung einer Graphtraversierung. */
export type TraversalDirection = "forward" | "reverse";

/**
 * Limits jeder Traversierung. Alle vier sind Pflicht: eine Traversierung ohne
 * Budget kann in einem grossen Monorepo nicht terminieren wollen.
 */
export interface TraversalLimitsV1 {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxWallTimeMs: number;
}

/** Warum eine Traversierung vorzeitig endete. */
export const TRAVERSAL_TRUNCATION_REASONS = [
  "max_depth",
  "max_nodes",
  "max_edges",
  "max_wall_time",
  "cancelled",
] as const;

export type TraversalTruncationReason = (typeof TRAVERSAL_TRUNCATION_REASONS)[number];

/**
 * Ergebnis einer Traversierung. `truncated` und `truncationReason` gehoeren
 * zusammen: ein abgeschnittenes Ergebnis darf nie wie ein vollstaendiges
 * aussehen (architecture.md §17.4).
 */
export interface TraversalResultV1 {
  schemaVersion: 1;
  direction: TraversalDirection;
  /** Startknoten der Traversierung. */
  rootSymbolIds: string[];
  /** Erreichte Symbole in Besuchsreihenfolge. */
  visitedSymbolIds: string[];
  /** Besuchte Kanten in Besuchsreihenfolge. */
  edgeIds: string[];
  depthReached: number;
  truncated: boolean;
  /** Pflicht, wenn `truncated` true ist. */
  truncationReason?: TraversalTruncationReason;
  /**
   * Knoten, die wegen Zyklenschutz nicht erneut besucht wurden. Sichtbar,
   * damit ein Zyklus nicht als „fertig traversiert" durchgeht.
   */
  revisitSkippedSymbolIds: string[];
  limits: TraversalLimitsV1;
}

// ---------------------------------------------------------------------------
// Pruefung
// ---------------------------------------------------------------------------

/** Ein Befund der Kantenpruefung. */
export interface SymbolEdgeIssue {
  kind:
    | "empty_name"
    | "kind_resolution_mismatch"
    | "missing_target"
    | "unexpected_target"
    | "insufficient_candidates"
    | "candidate_weight_invalid"
    | "missing_reason"
    | "confidence_out_of_range"
    | "overclaimed_confidence"
    | "missing_signals"
    | "missing_sites"
    | "cross_repo_mismatch"
    | "invalid_ordinal";
  message: string;
}

/**
 * Prueft die Invarianten einer Symbolkante.
 *
 * VERHAELTNIS VON `kind` UND `resolution` (normativ fuer alle Erzeuger):
 * `kind` beschreibt die BEZIEHUNG, `resolution` den ERFOLG. Ein Aufruf ohne
 * gefundenes Ziel bleibt `kind: "calls"` mit `resolution: "unresolved"`.
 * `kind: "unresolved"` ist nur fuer den Fall gedacht, in dem selbst die
 * Beziehungsart unklar ist; dann MUSS auch `resolution` `unresolved` sein.
 *
 * Kernregel gegen ueberzogene Genauigkeit: `heuristic` und `ambiguous` duerfen
 * NIE `basis: "deterministic"` tragen, und eine mehrdeutige Kante darf nie
 * Confidence 1 behaupten.
 */
export function validateSymbolEdge(edge: SymbolEdgeV1): SymbolEdgeIssue[] {
  const issues: SymbolEdgeIssue[] = [];

  if (edge.toName.trim() === "") {
    issues.push({
      kind: "empty_name",
      message:
        "toName must never be empty — the written name is the only resolver-independent fact (E4)",
    });
  }
  if (edge.kind === "unresolved" && edge.resolution !== "unresolved") {
    issues.push({
      kind: "kind_resolution_mismatch",
      message: `edge kind "unresolved" requires resolution "unresolved", got "${edge.resolution}"`,
    });
  }
  if (!Number.isInteger(edge.occurrenceOrdinal) || edge.occurrenceOrdinal < 0) {
    issues.push({
      kind: "invalid_ordinal",
      message: `occurrenceOrdinal must be a non-negative integer, got ${String(edge.occurrenceOrdinal)}`,
    });
  }
  if (edge.sites.length === 0 && (edge.sitesMissingReason ?? "") === "") {
    issues.push({
      kind: "missing_sites",
      message: "an edge without source sites must name the reason (spec.md §15.2, E4)",
    });
  }

  switch (edge.resolution) {
    case "exact":
    case "heuristic": {
      if (edge.target === undefined) {
        issues.push({
          kind: "missing_target",
          message: `resolution "${edge.resolution}" requires a target`,
        });
      }
      if (edge.candidates !== undefined) {
        issues.push({
          kind: "unexpected_target",
          message: `resolution "${edge.resolution}" must not carry ambiguous candidates`,
        });
      }
      break;
    }
    case "ambiguous": {
      if (edge.target !== undefined) {
        issues.push({
          kind: "unexpected_target",
          message: 'resolution "ambiguous" must not name a single target',
        });
      }
      if ((edge.candidates ?? []).length < 2) {
        issues.push({
          kind: "insufficient_candidates",
          message: 'resolution "ambiguous" requires at least two candidates',
        });
      }
      let weightSum = 0;
      for (const candidate of edge.candidates ?? []) {
        if (!(candidate.weight >= 0 && candidate.weight <= 1)) {
          issues.push({
            kind: "candidate_weight_invalid",
            message: `candidate "${candidate.qualifiedName}" weight must be within [0, 1], got ${String(candidate.weight)}`,
          });
        }
        weightSum += candidate.weight;
      }
      if (weightSum > 1 + 1e-9) {
        issues.push({
          kind: "candidate_weight_invalid",
          message: `candidate weights sum to ${String(weightSum)}, which exceeds 1`,
        });
      }
      if (edge.confidence.value >= 1) {
        issues.push({
          kind: "overclaimed_confidence",
          message: "an ambiguous edge must never claim full confidence (architecture.md §17.2)",
        });
      }
      break;
    }
    case "unresolved": {
      if (edge.target !== undefined || edge.candidates !== undefined) {
        issues.push({
          kind: "unexpected_target",
          message: 'resolution "unresolved" must carry neither target nor candidates',
        });
      }
      if (edge.unresolvedReason === undefined || (edge.unresolvedDetail ?? "").trim() === "") {
        issues.push({
          kind: "missing_reason",
          message: "an unresolved edge must carry a named reason and a non-empty detail (E4)",
        });
      }
      break;
    }
  }

  if (!(edge.confidence.value >= 0 && edge.confidence.value <= 1)) {
    issues.push({
      kind: "confidence_out_of_range",
      message: `confidence must be within [0, 1], got ${String(edge.confidence.value)}`,
    });
  }
  if (edge.confidence.signals.length === 0) {
    issues.push({
      kind: "missing_signals",
      message: "confidence without signals is a number without provenance",
    });
  }
  if (edge.resolution !== "exact" && edge.confidence.basis === "deterministic") {
    issues.push({
      kind: "overclaimed_confidence",
      message: `resolution "${edge.resolution}" must not claim a deterministic basis`,
    });
  }
  if (edge.target !== undefined && edge.crossRepo !== (edge.target.repoId !== edge.repoId)) {
    issues.push({
      kind: "cross_repo_mismatch",
      message: `crossRepo is ${String(edge.crossRepo)} but source repo "${edge.repoId}" and target repo "${edge.target.repoId}" say otherwise`,
    });
  }
  // Mehrdeutige Kanten haben kein `target`. Ohne diese zweite Pruefung ist
  // `crossRepo` fuer sie unbeaufsichtigt — und `crossRepoEdgeCount` meldet
  // "keine Repo-Grenze ueberschritten", obwohl jeder Kandidat eine ueberschreitet.
  if (edge.resolution === "ambiguous" && edge.candidates !== undefined) {
    const foreign = edge.candidates.filter((candidate) => candidate.repoId !== edge.repoId);
    if (edge.crossRepo !== foreign.length > 0) {
      issues.push({
        kind: "cross_repo_mismatch",
        message: `crossRepo is ${String(edge.crossRepo)} but ${String(foreign.length)} of ${String(edge.candidates.length)} candidates live outside source repo "${edge.repoId}"`,
      });
    }
  }

  return issues;
}
