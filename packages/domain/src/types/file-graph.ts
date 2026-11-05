/**
 * Dateigraph — Knoten und Kanten (spec.md §14; architecture.md §16).
 *
 * Leitsatz dieses Moduls ist E4 („kein stillschweigendes Ueberspringen"):
 * ein Import, der sich nicht aufloesen laesst, wird NICHT weggelassen. Er wird
 * als Kante mit `kind: "unresolved"` gefuehrt, behaelt seinen Rohstring
 * (`rawSpecifier`) und traegt einen benannten Grund. Nur so bleibt die
 * Import-Resolution-Rate (spec.md §14.4) eine ehrliche Zahl.
 *
 * Monorepo-Faehigkeit: eine Kante kann ueber Paket-, Repository- und
 * Containergrenzen zeigen. Welcher Aufloesungsschritt sie gefunden hat, steht
 * in `mechanism` (Reihenfolge der Resolver: architecture.md §16.2), was sie
 * ueberquert, in `boundary`.
 */
import type { FILE_GRAPH_VERSION } from "../versions.js";

import type { SourceRange } from "./common.js";

/**
 * Kantenarten des Dateigraphen.
 *
 * Verhaeltnis zu spec.md §14.2: `import`, `re-export` und `dynamic-import`
 * sind die dort genannten Arten (in der hier durchgaengigen kebab-case-Form).
 * `asset-reference` und `config-reference` ergaenzen die in spec.md §19/§20
 * beschriebenen Nicht-Code-Bezuege (Bilder, Schemas, Konfigurationsdateien),
 * `unresolved` macht den nicht aufloesbaren Fall zu einem eigenen, sichtbaren
 * Zustand statt zu einer fehlenden Kante.
 *
 * Die Cross-Repo-Eigenschaft ist ABSICHTLICH keine eigene Kantenart (anders
 * als `package_dependency`/`cross_repo_package` in spec.md §14.2): sie ist
 * orthogonal zur Art und steht in `boundary.crossRepo` bzw. in
 * `resolution.mechanism`. Eine Kante ist damit gleichzeitig „ein Import" UND
 * „ueberquert eine Paketgrenze", ohne dass zwei Arten dasselbe beschreiben.
 */
export const FILE_EDGE_KINDS = [
  "import",
  "re-export",
  "dynamic-import",
  "asset-reference",
  "config-reference",
  "unresolved",
] as const;

export type FileEdgeKind = (typeof FILE_EDGE_KINDS)[number];

/**
 * Aufloesungsmechanismus in der Reihenfolge der Resolver-Pipeline
 * (architecture.md §16.2). `workspace-package` deckt das
 * Workspace-Protokoll eines Monorepos ab, `project-alias` die
 * Pfad-Aliase einer Projektkonfiguration (z. B. `paths`/`baseUrl`),
 * `container-composition` die Dienstgrenzen aus einer
 * Container-Kompositionsdatei.
 */
export const FILE_EDGE_MECHANISMS = [
  "relative-path",
  "language-alias",
  "project-alias",
  "workspace-package",
  "installed-package",
  "package-exports",
  "container-composition",
  "asset-path",
  "configured-alias",
] as const;

export type FileEdgeMechanism = (typeof FILE_EDGE_MECHANISMS)[number];

/** Benannte Gruende, warum eine Kante nicht aufgeloest werden konnte (E4). */
export const FILE_EDGE_UNRESOLVED_REASONS = [
  "no_resolver_supports_specifier",
  "target_file_not_found",
  "package_not_in_workspace_catalog",
  "package_not_installed",
  "alias_configured_but_target_missing",
  "dynamic_specifier_not_statically_analyzable",
  "ambiguous_candidates",
  "excluded_by_configuration",
  "parser_provided_no_specifier",
] as const;

export type FileEdgeUnresolvedReason = (typeof FILE_EDGE_UNRESOLVED_REASONS)[number];

/**
 * Aufloesungsergebnis einer Kante. Drei Zustaende, keine Rateoption:
 * `resolved` (Zieldatei bekannt), `external` (Ziel liegt ausserhalb des
 * Workspace, Paketname bekannt) und `unresolved` (mit Grund).
 */
export type FileEdgeResolutionV1 =
  | {
      status: "resolved";
      mechanism: FileEdgeMechanism;
      /** file_id der Zieldatei (spec.md §5.4). */
      targetFileId: string;
      targetRepoId: string;
      targetRefId: string;
      /** "/"-normalisierter, repo-relativer Pfad der Zieldatei. */
      targetPath: string;
      /** Paketname, ueber den aufgeloest wurde (Workspace-Katalog, arch §16.3). */
      viaPackageName?: string;
    }
  | {
      status: "external";
      mechanism: FileEdgeMechanism;
      /** Paketname ausserhalb des Workspace, z. B. aus dem Manifest. */
      packageName: string;
      /** Version laut Manifest/Lockfile, sofern ermittelbar. */
      declaredVersion?: string;
    }
  | {
      status: "unresolved";
      reason: FileEdgeUnresolvedReason;
      /** Menschenlesbare Ergaenzung zum Grund; MUSS gefuellt sein (E4). */
      detail: string;
      /** Geprueft und verworfen — macht Mehrdeutigkeit sichtbar. */
      rejectedCandidates?: string[];
    };

/**
 * Welche Grenzen die Kante ueberquert. Alle drei Flags sind unabhaengig: eine
 * Kante kann innerhalb eines Repositories eine Paketgrenze ueberqueren
 * (Monorepo) und eine Kante zwischen Repositories kann im selben Container
 * laufen.
 */
export interface FileEdgeBoundaryV1 {
  crossRepo: boolean;
  crossPackage: boolean;
  /** Quelle und Ziel gehoeren zu verschiedenen Diensten einer Container-Komposition. */
  crossContainer: boolean;
  /** Paketname der Quelle, sofern die Datei einem Paket zugeordnet ist. */
  fromPackageName?: string;
  toPackageName?: string;
  /** Dienstname aus der Container-Kompositionsdatei, sofern zugeordnet. */
  fromContainerService?: string;
  toContainerService?: string;
}

/** Eine verursachende Importstelle im Quelltext (spec.md §14.2). */
export interface FileEdgeSiteV1 {
  range: SourceRange;
  /** Importierte Namen dieser Stelle, sofern der Parser sie liefert. */
  importedNames?: string[];
  /** `import type` und Aequivalente: die Kante existiert nur zur Uebersetzungszeit. */
  typeOnly?: boolean;
}

/**
 * Kante des Dateigraphen (spec.md §14.2).
 *
 * `rawSpecifier` ist IMMER gesetzt — auch bei aufgeloesten Kanten. Der
 * Rohstring ist die einzige Angabe, die unabhaengig vom Resolver stimmt; er
 * ist die Grundlage jeder spaeteren Fehlersuche an der Aufloesung.
 */
export interface FileEdgeV1 {
  schemaVersion: 1;
  /** Deterministische Kanten-ID (`buildFileEdgeId`). */
  edgeId: string;
  workspaceId: string;
  /** Repository der QUELLdatei. */
  repoId: string;
  refId: string;
  fromFileId: string;
  /** "/"-normalisierter, repo-relativer Pfad der Quelldatei. */
  fromPath: string;
  kind: FileEdgeKind;
  /** Spezifizierer wie im Quelltext geschrieben; nie leer, nie normalisiert. */
  rawSpecifier: string;
  resolution: FileEdgeResolutionV1;
  boundary: FileEdgeBoundaryV1;
  /**
   * Quellpositionen der verursachenden Importstellen. Leer NUR, wenn der
   * Parser keine liefert — dann MUSS `sitesMissingReason` gesetzt sein (E4).
   */
  sites: FileEdgeSiteV1[];
  sitesMissingReason?: string;
  /**
   * Laufende Nummer identischer (Quelle, Art, Spezifizierer)-Kanten. Teil der
   * Kanten-ID, damit zwei Importe desselben Moduls nicht kollidieren. Bewusst
   * NICHT die Zeilennummer: eine verschobene Importzeile darf die Identitaet
   * der Kante nicht aendern (gleiche Logik wie spec.md §5.5).
   */
  occurrenceOrdinal: number;
  graphGeneration: string;
  graphVersion: typeof FILE_GRAPH_VERSION;
}

/**
 * Knoten des Dateigraphen (spec.md §14.1).
 *
 * `imports` sind die ROHSTRINGS aller Importe der Datei — auch der nicht
 * aufgeloesten. `dependencies`/`dependents` enthalten nur aufgeloeste
 * Zieldateien; die Differenz zwischen `imports.length` und
 * `dependencies.length` ist damit sichtbar und nicht wegdefiniert.
 * Alle Listen sind nach Codepoints sortiert (siehe `ordering.ts`).
 */
export interface FileNodeV1 {
  schemaVersion: 1;
  workspaceId: string;
  repoId: string;
  refId: string;
  fileId: string;
  /** "/"-normalisierter, repo-relativer Pfad. */
  filePath: string;
  language: string;
  contentHash: string;
  /** Rohstrings aller Importe dieser Datei, sortiert und dedupliziert. */
  imports: string[];
  /** file_ids aufgeloester Importziele (ausgehend). */
  dependencies: string[];
  /** file_ids der Dateien, die diese Datei importieren (eingehend). */
  dependents: string[];
  graphGeneration: string;
  /** Paketname, dem die Datei zugeordnet ist (Monorepo, arch §16.3). */
  packageName?: string;
  /** Dienstname aus einer Container-Kompositionsdatei, sofern zugeordnet. */
  containerService?: string;
  /** Anzahl der Kanten dieser Datei mit `kind: "unresolved"` (spec.md §14.3). */
  unresolvedImportCount: number;
}

/** Ein zentraler Knoten der Graphstatistik (spec.md §14.4 „Top Central Files"). */
export interface FileGraphCentralityEntryV1 {
  fileId: string;
  filePath: string;
  inDegree: number;
  outDegree: number;
  /**
   * Zentralitaetsmass im Bereich [0, 1]. Welche Formel gilt, steht in
   * `FileGraphMetricsV1.centralityFormula` — eine Zahl ohne benannte Formel
   * ist keine Aussage.
   */
  centrality: number;
}

/** Graphmetriken des Dateigraphen (spec.md §14.4). */
export interface FileGraphMetricsV1 {
  schemaVersion: 1;
  workspaceId: string;
  graphGeneration: string;
  graphVersion: typeof FILE_GRAPH_VERSION;
  nodeCount: number;
  edgeCount: number;
  /** Dateien ohne eingehende UND ohne ausgehende Kante. */
  orphanFileIds: string[];
  /** Jede SCC als geordnete Liste ihrer file_ids (nur Groesse > 1). */
  stronglyConnectedComponents: string[][];
  /** Jeder gefundene Zyklus als geordnete Liste seiner file_ids. */
  cycles: string[][];
  importResolution: {
    resolvedCount: number;
    externalCount: number;
    unresolvedCount: number;
    /** `resolved / (resolved + external + unresolved)`, 0 bei keiner Kante. */
    rate: number;
  };
  /** repo_id → Knotenzahl. */
  repositoryDistribution: Record<string, number>;
  /** language → Knotenzahl. */
  languageDistribution: Record<string, number>;
  topCentralFiles: FileGraphCentralityEntryV1[];
  /** Benannte Formel hinter `FileGraphCentralityEntryV1.centrality`. */
  centralityFormula: string;
  /**
   * Wurde die Berechnung durch ein Limit gestoppt (Knoten-, Kanten- oder
   * Zeitbudget), steht hier der Grund. Eine abgeschnittene Statistik darf nie
   * wie eine vollstaendige aussehen.
   */
  truncationReason?: string;
}

// ---------------------------------------------------------------------------
// Pruefung
// ---------------------------------------------------------------------------

/** Ein Befund der Kantenpruefung. */
export interface FileEdgeIssue {
  kind:
    | "empty_specifier"
    | "kind_resolution_mismatch"
    | "incomplete_target"
    | "missing_detail"
    | "boundary_mismatch"
    | "missing_sites"
    | "invalid_ordinal";
  message: string;
}

/**
 * Prueft die Invarianten einer Dateikante.
 *
 * VERHAELTNIS VON `kind` UND `resolution.status` (normativ fuer alle Erzeuger):
 * Die Art beschreibt die BEZIEHUNG, die Aufloesung den ERFOLG. Ein Import, der
 * sich nicht aufloesen liess, bleibt `kind: "import"` mit
 * `resolution.status: "unresolved"` — wir wissen ja, dass es ein Import ist.
 * `kind: "unresolved"` ist nur fuer den Fall vorgesehen, in dem selbst die
 * Beziehungsart unklar bleibt; dann MUSS auch die Aufloesung `unresolved` sein.
 */
export function validateFileEdge(edge: FileEdgeV1): FileEdgeIssue[] {
  const issues: FileEdgeIssue[] = [];
  if (edge.rawSpecifier.trim() === "") {
    issues.push({
      kind: "empty_specifier",
      message:
        "rawSpecifier must never be empty — the raw string is the only resolver-independent fact (E4)",
    });
  }
  if (edge.kind === "unresolved" && edge.resolution.status !== "unresolved") {
    issues.push({
      kind: "kind_resolution_mismatch",
      message: `edge kind "unresolved" requires resolution.status "unresolved", got "${edge.resolution.status}"`,
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
      message: "an edge without source sites must name the reason (spec.md §14.2, E4)",
    });
  }

  switch (edge.resolution.status) {
    case "resolved": {
      if (edge.resolution.targetFileId.trim() === "" || edge.resolution.targetPath.trim() === "") {
        issues.push({
          kind: "incomplete_target",
          message: "a resolved edge requires targetFileId and targetPath",
        });
      }
      const expectedCrossRepo = edge.resolution.targetRepoId !== edge.repoId;
      if (edge.boundary.crossRepo !== expectedCrossRepo) {
        issues.push({
          kind: "boundary_mismatch",
          message: `boundary.crossRepo is ${String(edge.boundary.crossRepo)} but source repo "${edge.repoId}" and target repo "${edge.resolution.targetRepoId}" say otherwise`,
        });
      }
      break;
    }
    case "external": {
      if (edge.resolution.packageName.trim() === "") {
        issues.push({
          kind: "incomplete_target",
          message: "an external edge requires a packageName",
        });
      }
      if (edge.boundary.crossRepo) {
        issues.push({
          kind: "boundary_mismatch",
          message:
            "an external target lies outside the workspace and can never be a cross-repo edge",
        });
      }
      break;
    }
    case "unresolved": {
      if (edge.resolution.detail.trim() === "") {
        issues.push({
          kind: "missing_detail",
          message: `unresolved edge (${edge.resolution.reason}) must carry a non-empty detail (E4)`,
        });
      }
      break;
    }
  }

  if (edge.boundary.crossContainer) {
    const from = edge.boundary.fromContainerService ?? "";
    const to = edge.boundary.toContainerService ?? "";
    if (from === "" || to === "" || from === to) {
      issues.push({
        kind: "boundary_mismatch",
        message: "crossContainer requires two different, named container services",
      });
    }
  }

  return issues;
}
