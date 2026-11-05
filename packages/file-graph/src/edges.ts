/**
 * Rohimporte → Kanten des Dateigraphen (spec.md §14.2).
 *
 * Diese Datei ist die Stelle, an der E4 konkret wird. Drei Faelle, die hier
 * NICHT stillschweigend verschwinden:
 *
 * 1. Ein Import, der sich nicht aufloesen laesst, bleibt eine Kante. Er
 *    behaelt seine Art (`import` bleibt `import`) und bekommt
 *    `resolution.status: "unresolved"` mit benanntem Grund. So bleibt die
 *    Import-Resolution-Rate (spec.md §14.4) eine ehrliche Zahl.
 * 2. Ein Import OHNE Spezifizierer kann keine Kante werden — `rawSpecifier`
 *    darf nie leer sein (`validateFileEdge`). Er wird deshalb zum
 *    Ledger-Eintrag, nicht zu einer weggelassenen Zeile.
 * 3. Eine Datei, deren Importe gar nicht erst extrahiert werden konnten
 *    (`importsMissingReason`), erzeugt ebenfalls einen Ledger-Eintrag.
 *    Ohne ihn saehe eine nicht geparste Datei wie eine importfreie aus.
 */
import type {
  FileEdgeKind,
  FileEdgeSiteV1,
  FileEdgeV1,
  RawImport,
  RawImportKind,
  SkipLedgerEntryV1,
} from "@untangle-code/domain";
import {
  FILE_GRAPH_VERSION,
  buildFileEdgeId,
  buildSkipLedgerEntry,
  compareCodepoints,
} from "@untangle-code/domain";

import { assignContainerService, assignPackage } from "./assignment.js";
import { isAssetSpecifier } from "./resolve/candidates.js";
import { resolveImport } from "./resolve/pipeline.js";
import type {
  ContainerServiceV1,
  FileImportsV1,
  ImportResolverV1,
  ResolveContextV1,
  WorkspacePackageCatalogV1,
  WorkspacePackageV1,
} from "./types.js";

/** Abbildung der Parser-Importart auf die Kantenart des Graphen. */
export const RAW_IMPORT_KIND_TO_EDGE_KIND: Readonly<Record<RawImportKind, FileEdgeKind>> = {
  import: "import",
  re_export: "re-export",
  dynamic_import: "dynamic-import",
  // `package_dependency` entsteht nicht im Quelltext, sondern aus einem
  // Manifest. Als Bezug auf eine Konfigurationsdatei ist es genau das, was
  // `config-reference` beschreibt — und NICHT `import`, weil kein Modul
  // geladen wird.
  package_dependency: "config-reference",
};

/**
 * Zeichen, die einen dynamischen Spezifizierer als nicht statisch auswertbar
 * ausweisen. Der Parser liefert bei `import(variable)` den Ausdruckstext; der
 * ist ein ehrlicher Rohstring, aber kein Modulpfad.
 */
const NON_LITERAL_SPECIFIER = /[`$+(){}[\]\s]|\.\.\.|\?\?|&&|\|\|/;

/** Alles, was der Kantenbau je Datei braucht. */
export interface EdgeBuildContextV1 {
  workspaceId: string;
  graphGeneration: string;
  packages: readonly WorkspacePackageV1[];
  /** Repository-bewusster Paketkatalog; siehe `package-catalog.ts`. */
  packageCatalog: WorkspacePackageCatalogV1;
  services: readonly ContainerServiceV1[];
  projectAliases: ResolveContextV1["projectAliases"];
  configuredAliases: ResolveContextV1["configuredAliases"];
  extensionOrder: readonly string[];
  files: ResolveContextV1["files"];
  /** repoId → refId, fuer die Zielangabe aufgeloester Kanten. */
  refIdByRepoId: ReadonlyMap<string, string>;
  /** repoId + Pfad → fileId. */
  resolveFileId: (repoId: string, path: string) => string | null;
  pipeline?: readonly ImportResolverV1[];
}

/** Ergebnis des Kantenbaus fuer EINE Datei. */
export interface FileEdgesV1 {
  edges: FileEdgeV1[];
  skipped: SkipLedgerEntryV1[];
}

/** Baut alle Kanten einer einzelnen Datei. */
export function buildEdgesForFile(file: FileImportsV1, context: EdgeBuildContextV1): FileEdgesV1 {
  const edges: FileEdgeV1[] = [];
  const skipped: SkipLedgerEntryV1[] = [];

  if (file.importsMissingReason !== undefined) {
    skipped.push(
      buildSkipLedgerEntry({
        stage: "file_graph",
        subjectKind: "file",
        subjectId: file.fileId,
        path: file.path,
        repoId: file.repoId,
        refId: file.refId,
        reason: "parse_failed",
        detail: `imports of "${file.path}" were not extracted: ${file.importsMissingReason}`,
        recoverable: true,
      }),
    );
  }

  const fromPackage = assignPackage(context.packages, file.repoId, file.path);
  const fromService = assignContainerService(context.services, file.repoId, file.path);

  const resolveContext: ResolveContextV1 = {
    workspaceId: context.workspaceId,
    fromRepoId: file.repoId,
    fromRefId: file.refId,
    fromPath: file.path,
    fromLanguageId: file.languageId,
    ...(fromPackage === null ? {} : { fromPackage }),
    files: context.files,
    packageCatalog: context.packageCatalog,
    projectAliases: context.projectAliases,
    configuredAliases: context.configuredAliases,
    extensionOrder: context.extensionOrder,
  };

  const ordinals = new Map<string, number>();

  for (const rawImport of file.imports) {
    const specifier = rawImport.specifier;
    if (specifier.trim() === "") {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "file_graph",
          subjectKind: "file_edge",
          path: file.path,
          repoId: file.repoId,
          refId: file.refId,
          range: rawImport.range,
          reason: "resolution_failed",
          detail: `parser reported an import of kind "${rawImport.importKind}" without a specifier at line ${String(rawImport.range.startLine)}; an edge without a raw specifier would violate the file-edge invariant`,
          recoverable: false,
        }),
      );
      continue;
    }

    const kind = edgeKindOf(rawImport, specifier);
    const ordinalKey = `${kind}\u001f${specifier}`;
    const occurrenceOrdinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, occurrenceOrdinal + 1);

    const resolution = resolveSpecifier(rawImport, specifier, resolveContext, context);

    const site: FileEdgeSiteV1 = {
      range: rawImport.range,
      ...(rawImport.importedNames !== undefined && rawImport.importedNames.length > 0
        ? { importedNames: [...rawImport.importedNames] }
        : {}),
      ...(rawImport.typeOnly === undefined ? {} : { typeOnly: rawImport.typeOnly }),
    };

    // Die Grenzen werden aus der ENDGUELTIGEN Aufloesung abgeleitet, nicht aus
    // der des Resolvers: `toDomainResolution` kann einen Treffer noch zu einem
    // Fehlschlag herabstufen (wenn der Index keine `file_id` zum Pfad hat), und
    // eine Kante mit `crossRepo: true` bei `status: "unresolved"` waere eine
    // Behauptung ohne Grundlage.
    const domainResolution = toDomainResolution(resolution, context);

    let targetPackage: WorkspacePackageV1 | null = null;
    let targetService: ContainerServiceV1 | null = null;
    let externalPackageName: string | undefined;

    if (domainResolution.status === "resolved") {
      targetPackage = assignPackage(
        context.packages,
        domainResolution.targetRepoId,
        domainResolution.targetPath,
      );
      targetService = assignContainerService(
        context.services,
        domainResolution.targetRepoId,
        domainResolution.targetPath,
      );
    } else if (domainResolution.status === "external") {
      externalPackageName = domainResolution.packageName;
    }

    const crossRepo =
      domainResolution.status === "resolved" && domainResolution.targetRepoId !== file.repoId;
    const toPackageName = targetPackage?.name ?? externalPackageName;
    // Paketgleichheit ist NICHT Namensgleichheit: zwei Repositories eines
    // Workspace duerfen ein gleichnamiges Paket fuehren, und eine Kante von
    // einem ins andere ueberquert sehr wohl eine Paketgrenze. Verglichen wird
    // deshalb die Identitaet (Repository + Verzeichnis), nicht der Name.
    const crossPackage =
      toPackageName !== undefined &&
      (fromPackage === null ||
        (targetPackage === null
          ? fromPackage.name !== toPackageName
          : packageKeyOf(fromPackage) !== packageKeyOf(targetPackage)));
    const crossContainer =
      fromService !== null && targetService !== null && fromService.name !== targetService.name;

    const edge: FileEdgeV1 = {
      schemaVersion: 1,
      edgeId: buildFileEdgeId({
        workspaceId: context.workspaceId,
        fromFileId: file.fileId,
        edgeKind: kind,
        rawSpecifier: specifier,
        occurrenceOrdinal,
      }),
      workspaceId: context.workspaceId,
      repoId: file.repoId,
      refId: file.refId,
      fromFileId: file.fileId,
      fromPath: file.path,
      kind,
      rawSpecifier: specifier,
      resolution: domainResolution,
      boundary: {
        crossRepo,
        crossPackage,
        crossContainer,
        ...(fromPackage === null ? {} : { fromPackageName: fromPackage.name }),
        ...(toPackageName === undefined ? {} : { toPackageName }),
        ...(fromService === null ? {} : { fromContainerService: fromService.name }),
        ...(targetService === null ? {} : { toContainerService: targetService.name }),
      },
      sites: [site],
      occurrenceOrdinal,
      graphGeneration: context.graphGeneration,
      graphVersion: FILE_GRAPH_VERSION,
    };
    edges.push(edge);
  }

  edges.sort(compareEdges);
  return { edges, skipped };
}

/** Identitaet eines Pakets: Repository plus Verzeichnis, nicht der Name. */
function packageKeyOf(entry: WorkspacePackageV1): string {
  return `${entry.repoId}\u001f${entry.packageDir}`;
}

/** Stabile Kantenordnung: Quelle, Art, Rohstring, laufende Nummer. */
export function compareEdges(left: FileEdgeV1, right: FileEdgeV1): number {
  return (
    compareCodepoints(left.fromFileId, right.fromFileId) ||
    compareCodepoints(left.kind, right.kind) ||
    compareCodepoints(left.rawSpecifier, right.rawSpecifier) ||
    left.occurrenceOrdinal - right.occurrenceOrdinal ||
    compareCodepoints(left.edgeId, right.edgeId)
  );
}

function edgeKindOf(rawImport: RawImport, specifier: string): FileEdgeKind {
  const base = RAW_IMPORT_KIND_TO_EDGE_KIND[rawImport.importKind];
  // Ein Import einer Nicht-Code-Ressource bleibt eine echte Abhaengigkeit,
  // ist aber keine Modulbeziehung — `asset-reference` macht sichtbar, dass
  // die Zieldatei nie Symbole beitragen wird (spec.md §19/§20).
  if ((base === "import" || base === "dynamic-import") && isAssetSpecifier(specifier)) {
    return "asset-reference";
  }
  return base;
}

type LocalResolution = ReturnType<typeof resolveImport>["result"];

function resolveSpecifier(
  rawImport: RawImport,
  specifier: string,
  resolveContext: ResolveContextV1,
  context: EdgeBuildContextV1,
): LocalResolution {
  if (rawImport.importKind === "dynamic_import" && NON_LITERAL_SPECIFIER.test(specifier)) {
    return {
      status: "unresolved",
      reason: "dynamic_specifier_not_statically_analyzable",
      detail: `dynamic import argument "${specifier}" is an expression, not a literal module specifier; the raw text is kept so the call site stays findable`,
    };
  }
  return resolveImport(specifier, resolveContext, context.pipeline).result;
}

function toDomainResolution(
  resolution: LocalResolution,
  context: EdgeBuildContextV1,
): FileEdgeV1["resolution"] {
  if (resolution.status === "external") {
    return {
      status: "external",
      mechanism: resolution.mechanism,
      packageName: resolution.packageName,
      ...(resolution.declaredVersion === undefined
        ? {}
        : { declaredVersion: resolution.declaredVersion }),
    };
  }
  if (resolution.status === "unresolved") {
    return {
      status: "unresolved",
      reason: resolution.reason,
      detail: resolution.detail,
      ...(resolution.rejectedCandidates === undefined
        ? {}
        : { rejectedCandidates: resolution.rejectedCandidates }),
    };
  }
  const targetFileId = context.resolveFileId(resolution.targetRepoId, resolution.targetPath);
  if (targetFileId === null) {
    // Kann nur passieren, wenn der Index zwischen Probe und Kantenbau
    // veraendert wurde. Der Fall wird zum benannten Fehlschlag, nicht zu
    // einer Kante mit leerer Ziel-ID.
    return {
      status: "unresolved",
      reason: "target_file_not_found",
      detail: `resolver found "${resolution.targetPath}" in repository "${resolution.targetRepoId}", but the file index has no id for it`,
    };
  }
  return {
    status: "resolved",
    mechanism: resolution.mechanism,
    targetFileId,
    targetRepoId: resolution.targetRepoId,
    targetRefId: context.refIdByRepoId.get(resolution.targetRepoId) ?? "",
    targetPath: resolution.targetPath,
    ...(resolution.viaPackageName === undefined
      ? {}
      : { viaPackageName: resolution.viaPackageName }),
  };
}
