/**
 * Paketeigene Vertraege des Dateigraphen.
 *
 * ABGRENZUNG ZU `@untangle-code/domain` (bewusste Entscheidung, siehe
 * README „Entscheidungen"): Alles, was ein anderes Paket LESEN muss —
 * `FileNodeV1`, `FileEdgeV1`, `FileGraphMetricsV1`, `SkipLedgerV1`,
 * `TraversalLimitsV1` — kommt aus `domain` und wird hier NICHT
 * neu definiert. Was hier steht, sind ausschliesslich die EINGABEN des
 * Graphbaus und die Zwischenergebnisse der Aufloesung; die kennt
 * niemand ausser diesem Paket.
 *
 * Einzige Ausnahme ist `FileTraversalResultV1`: `TraversalResultV1` aus
 * `domain` traegt Feldnamen auf `*SymbolIds`, die fuer Dateien schlicht
 * falsch waeren. Die verbindlichen Teile (`TraversalLimitsV1`,
 * `TraversalDirection`, `TraversalTruncationReason`) werden uebernommen,
 * nur die Feldnamen sind dateibezogen — und `cycles` kommt hinzu, weil
 * ein Zyklus gemeldet und nicht stillschweigend aufgebrochen wird.
 */
import type {
  FileEdgeMechanism,
  FileEdgeUnresolvedReason,
  FileEdgeV1,
  FileGraphMetricsV1,
  FileNodeV1,
  RawImport,
  SkipLedgerV1,
  TraversalDirection,
  TraversalLimitsV1,
  TraversalTruncationReason,
} from "@untangle-code/domain";

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

/**
 * Eine Datei mit ihren Rohimporten — die Eingabe des Graphbaus.
 *
 * Der Dateigraph parst NICHT selbst. Er bekommt, was
 * `LanguageAdapter.extractImports` geliefert hat, und ist damit gegen jeden
 * Parser austauschbar (architecture.md §16.1 Schritt 2).
 */
export interface FileImportsV1 {
  fileId: string;
  repoId: string;
  refId: string;
  /** `"/"`-normalisierter, repo-relativer Pfad. */
  path: string;
  languageId: string;
  contentHash: string;
  imports: readonly RawImport[];
  /**
   * Grund, warum `imports` leer ist, obwohl die Datei Importe haben koennte
   * (Parse fehlgeschlagen, Sprache ohne Adapter, Budget erschoepft). Ohne
   * diesen Grund gilt eine leere Liste als „diese Datei hat keine Importe";
   * MIT ihm entsteht ein Ledger-Eintrag (E4).
   */
  importsMissingReason?: string;
}

/** Ein Repository des Workspace. */
export interface RepositoryInputV1 {
  repoId: string;
  refId: string;
  /**
   * Wurzel des Repositories relativ zur Workspace-Wurzel; `""` fuer ein
   * Einzelrepo-Workspace. Nur fuer die Zuordnung von Manifesten noetig.
   */
  rootPath: string;
}

// ---------------------------------------------------------------------------
// Monorepo-Topologie (Nutzerwunsch A3)
// ---------------------------------------------------------------------------

/** Ein Paket des Workspace, aus einem Manifest gelesen. */
export interface WorkspacePackageV1 {
  /** Paketname laut Manifest. */
  name: string;
  version?: string;
  repoId: string;
  /** repo-relatives Verzeichnis des Pakets; `""` fuer die Repositorywurzel. */
  packageDir: string;
  /** repo-relativer Pfad des Manifests. */
  manifestPath: string;
  /** `exports`-Feld des Manifests, unveraendert. */
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
  /** Subpath-Imports (`imports`-Feld, `#`-Spezifizierer). */
  imports?: unknown;
  /**
   * Namen anderer Workspace-Pakete, auf die dieses Paket per
   * `workspace:`-Protokoll oder per Namensgleichheit zeigt.
   */
  workspaceDependencies: string[];
  /** Name → Versionsangabe, fuer Abhaengigkeiten ausserhalb des Workspace. */
  externalDependencies: Record<string, string>;
  /**
   * `outDir`/`rootDir` aus der Projektkonfiguration des Pakets, sofern
   * vorhanden. Grundlage der Rueckabbildung Build-Ausgabe → Quelldatei
   * (siehe `resolve/candidates.ts`).
   */
  outDir?: string;
  rootDir?: string;
}

/**
 * Nachschlagbarer Paketkatalog des Workspace.
 *
 * BEWUSST KEINE `Map<name, package>`: Paketnamen sind ueber Repositorygrenzen
 * hinweg NICHT eindeutig. Eine namensgeschluesselte Karte laesst gleichnamige
 * Pakete einander ersatzlos verdecken — mit falschen Abhaengigkeitsdaten und
 * Importen, die als „aufgeloest" ins falsche Repository zeigen. Jede Abfrage
 * geht deshalb von einem fragenden Repository aus (`WorkspacePackageCatalog`
 * in `package-catalog.ts` setzt das um).
 */
export interface WorkspacePackageCatalogV1 {
  /** Alle Pakete in kanonischer Ordnung (Name, Repository, Verzeichnis). */
  all(): readonly WorkspacePackageV1[];
  /** Alle Pakete dieses Namens, ueber alle Repositories. */
  byPackageName(name: string): readonly WorkspacePackageV1[];
  /**
   * Das Paket dieses Namens im angegebenen Repository — nur wenn es dort
   * GENAU EINES gibt. Zwei gleichnamige Manifeste desselben Repositories
   * liefern `null`, nicht das erste davon.
   */
  inRepo(repoId: string, name: string): WorkspacePackageV1 | null;
  /** Alle Pakete dieses Namens in diesem Repository, kanonisch geordnet. */
  inRepoAll(repoId: string, name: string): readonly WorkspacePackageV1[];
  /** True, wenn IRGENDEIN Repository ein Paket dieses Namens fuehrt. */
  has(name: string): boolean;
  /**
   * Sucht `name` aus der Sicht von `fromRepoId`: eigenes Repository zuerst,
   * dann ein eindeutiges fremdes. Mehrdeutig — und damit `ambiguous` statt
   * geraten — ist sowohl der Fall mehrerer FREMDER Repositories als auch der
   * mehrerer gleichnamiger Manifeste im EIGENEN.
   */
  lookup(fromRepoId: string, name: string): PackageLookupV1;
  /** Namen, die von mehr als einem Manifest deklariert werden. */
  ambiguousNames(): readonly string[];
}

/** Ergebnis einer Katalogabfrage aus der Sicht eines Repositories. */
export type PackageLookupV1 =
  | { status: "found"; entry: WorkspacePackageV1; crossRepo: boolean }
  | { status: "absent" }
  | { status: "ambiguous"; candidates: readonly WorkspacePackageV1[] };

/** Eine Kante der Paketebene (groebere Ebene als der Dateigraph). */
export interface WorkspacePackageEdgeV1 {
  fromPackage: string;
  toPackage: string;
  /** `workspace-dependency`: per `workspace:`-Protokoll oder Katalogtreffer. */
  kind: "workspace-dependency";
  /** In welchem Abhaengigkeitsblock des Manifests die Kante stand. */
  dependencyField: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
  /** Versionsangabe wie im Manifest, z. B. `"workspace:*"`. */
  rawRange: string;
}

/** Ein Dienst aus einer Container-Kompositionsdatei. */
export interface ContainerServiceV1 {
  name: string;
  repoId: string;
  /** repo-relativer Pfad der Kompositionsdatei. */
  composeFile: string;
  /** repo-relativer Build-Kontext, sofern angegeben. */
  buildContext?: string;
  image?: string;
  dependsOn: string[];
  networks: string[];
}

/** Eine Kante der Dienstebene. */
export interface ContainerServiceEdgeV1 {
  fromService: string;
  toService: string;
  /**
   * `depends_on` ist eine gerichtete Startreihenfolge, `shared-network` eine
   * ungerichtete Erreichbarkeit — beide werden getrennt gefuehrt, weil sie
   * verschiedene Fragen beantworten („wer braucht wen zuerst" gegen „wer
   * kann wen ueberhaupt erreichen").
   */
  kind: "depends_on" | "shared-network";
  /** Gesetzt bei `shared-network`. */
  network?: string;
  condition?: string;
}

/** Die grobkoernige Sicht auf ein Monorepo: Pakete und Dienste samt Kanten. */
export interface WorkspaceTopologyV1 {
  schemaVersion: 1;
  workspaceId: string;
  /** Globmuster der Workspace-Definition (z. B. `packages/*`). */
  workspaceGlobs: string[];
  packages: WorkspacePackageV1[];
  packageEdges: WorkspacePackageEdgeV1[];
  services: ContainerServiceV1[];
  serviceEdges: ContainerServiceEdgeV1[];
  /** Alles, was beim Laden uebersprungen wurde, mit Grund (E4). */
  skipped: SkipLedgerV1;
}

// ---------------------------------------------------------------------------
// Aufloesung
// ---------------------------------------------------------------------------

/** Ein Treffer der Aufloesung: Ziel INNERHALB des Workspace. */
export interface ResolvedInternalV1 {
  status: "resolved";
  mechanism: FileEdgeMechanism;
  targetRepoId: string;
  targetPath: string;
  viaPackageName?: string;
}

/** Ein Treffer der Aufloesung: Ziel AUSSERHALB des Workspace. */
export interface ResolvedExternalV1 {
  status: "external";
  mechanism: FileEdgeMechanism;
  packageName: string;
  declaredVersion?: string;
}

/** Ein benannter Fehlschlag der Aufloesung (E4). */
export interface ResolvedUnresolvedV1 {
  status: "unresolved";
  reason: FileEdgeUnresolvedReason;
  detail: string;
  rejectedCandidates?: string[];
}

export type ResolveResultV1 = ResolvedInternalV1 | ResolvedExternalV1 | ResolvedUnresolvedV1;

/**
 * Ein Schritt der Resolver-Pipeline (architecture.md §16.2).
 *
 * `supports` entscheidet allein anhand des Spezifizierers und des Kontexts,
 * ob dieser Resolver ueberhaupt zustaendig ist. `resolve` ist synchron und
 * rein: die gesamte Ein-/Ausgabe steckt im vorher aufgebauten
 * `FileIndex` und in der Topologie — dadurch ist die Aufloesung
 * reproduzierbar und ohne Dateisystem testbar.
 */
export interface ImportResolverV1 {
  /** Name des Resolvers, taucht in Diagnosetexten auf. */
  readonly name: string;
  supports(specifier: string, context: ResolveContextV1): boolean;
  resolve(specifier: string, context: ResolveContextV1): ResolveResultV1 | null;
}

/** Nachschlagbares Verzeichnis aller bekannten Dateien des Workspace. */
export interface FileLookupV1 {
  /** True, wenn (repoId, path) eine bekannte Datei ist. */
  hasFile(repoId: string, path: string): boolean;
  /** `file_id` der Datei; `null`, wenn unbekannt. */
  fileIdOf(repoId: string, path: string): string | null;
  /** Alle Repository-IDs, nach Codepoints sortiert. */
  repoIds(): readonly string[];
}

/** Der Kontext einer einzelnen Aufloesung. */
export interface ResolveContextV1 {
  workspaceId: string;
  fromRepoId: string;
  fromRefId: string;
  /** repo-relativer Pfad der Quelldatei. */
  fromPath: string;
  fromLanguageId: string;
  /** Paket, dem die Quelldatei zugeordnet ist. */
  fromPackage?: WorkspacePackageV1;
  files: FileLookupV1;
  /**
   * Paketkatalog der Topologie. Repository-bewusst, weil gleichnamige Pakete
   * in verschiedenen Repositories verschiedene Pakete sind.
   */
  packageCatalog: WorkspacePackageCatalogV1;
  /** Aliasmuster aus Projektkonfigurationen, in Anwendungsreihenfolge. */
  projectAliases: readonly AliasRuleV1[];
  /** Aliasmuster aus der Nutzerkonfiguration. */
  configuredAliases: readonly AliasRuleV1[];
  /** Erweiterungen in Probierreihenfolge, z. B. `[".ts", ".tsx", ...]`. */
  extensionOrder: readonly string[];
}

/**
 * Eine Aliasregel, wie sie `paths` einer Projektkonfiguration beschreibt.
 * `pattern` darf genau einen `*`-Platzhalter enthalten; `targets` sind die
 * Ersetzungen in Reihenfolge, jeweils repo-relativ.
 */
export interface AliasRuleV1 {
  pattern: string;
  targets: string[];
  /** Repository, in dem die Regel gilt. */
  repoId: string;
  /** Woher die Regel stammt, fuer Diagnosetexte. */
  source: string;
}

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

/** Budgets des Graphbaus. Ohne Budget kann ein grosses Monorepo nicht enden. */
export interface FileGraphLimitsV1 {
  /** Obergrenze der aufgezaehlten Elementarzyklen. */
  maxCycles: number;
  /** Laenge der `topCentralFiles`-Liste. */
  topCentralCount: number;
  /** Obergrenze der Knoten je stark zusammenhaengender Komponente bei der Zyklensuche. */
  maxCycleSearchNodes: number;
}

/** Das vollstaendige, serialisierbare Ergebnis eines Graphbaus. */
export interface FileGraphSnapshotV1 {
  schemaVersion: 1;
  workspaceId: string;
  graphGeneration: string;
  /** Nach `fileId` codepoint-sortiert. */
  nodes: FileNodeV1[];
  /** Nach (`fromFileId`, `kind`, `rawSpecifier`, `occurrenceOrdinal`) sortiert. */
  edges: FileEdgeV1[];
  metrics: FileGraphMetricsV1;
  topology: WorkspaceTopologyV1;
  skipped: SkipLedgerV1;
}

/** Ergebnis einer Traversierung des Dateigraphen. */
export interface FileTraversalResultV1 {
  schemaVersion: 1;
  direction: TraversalDirection;
  rootFileIds: string[];
  /** Erreichte Dateien in Besuchsreihenfolge, ohne die Wurzeln. */
  visitedFileIds: string[];
  /** Besuchte Kanten in Besuchsreihenfolge. */
  edgeIds: string[];
  depthReached: number;
  truncated: boolean;
  /** Pflicht, wenn `truncated` true ist. */
  truncationReason?: TraversalTruncationReason;
  /** Dateien, die wegen Zyklenschutz nicht erneut besucht wurden. */
  revisitSkippedFileIds: string[];
  /**
   * Waehrend der Traversierung beobachtete Zyklen, jeweils als Pfad vom
   * wiedergetroffenen Knoten zurueck zu sich selbst. GEMELDET, nicht
   * aufgebrochen: der Zyklenschutz verhindert nur die Endlosschleife, er
   * verschweigt den Zyklus nicht.
   */
  cycles: string[][];
  /**
   * Wurzeln, die wegen eines erschoepften GLOBALEN Budgets (Knoten-, Kanten-
   * oder Zeitgrenze) gar nicht erst betreten wurden.
   *
   * Ohne dieses Feld nennt das Ergebnis beide Wurzeln in `rootFileIds` und
   * behauptet damit, beide seien bearbeitet worden — waehrend eine davon nie
   * angefasst wurde. Gesetzt nur, wenn es solche Wurzeln gibt.
   */
  unvisitedRootFileIds?: string[];
  /**
   * WP-194: Wurzeln, die dieser Graph GAR NICHT ENTHAELT.
   *
   * Zu unterscheiden von {@link unvisitedRootFileIds} (bekannt, aber wegen
   * Budget nicht betreten) und von einer bekannten Wurzel ohne Nachbarn
   * (bearbeitet, Ergebnis leer). Ohne dieses Feld sind alle drei Faelle im
   * Ergebnis nicht auseinanderzuhalten: eine falsch geschriebene `file_id`
   * liefert dann ein leeres, unauffaelliges Resultat, das wie „diese Datei hat
   * keine Abhaengigkeiten" aussieht. Gesetzt nur, wenn es solche Wurzeln gibt.
   */
  unknownRootFileIds?: string[];
  limits: TraversalLimitsV1;
}
