/**
 * Aufbau der Monorepo-Topologie aus echten Dateien (architecture.md §16.1
 * Schritt 1 und §16.3, Nutzerwunsch A3).
 *
 * Dies ist die EINZIGE Stelle des Pakets, die ueberhaupt liest — und auch
 * hier nur ueber `FileSystemPort`, nie ueber `node:fs`. Alles danach
 * (Aufloesung, Graphbau, Traversierung, Fortschreibung) ist rein und
 * arbeitet auf dem Ergebnis.
 *
 * Gelesen werden genau vier Arten von Dateien:
 * - `pnpm-workspace.yaml` — die Liste der Teilprojekte;
 * - `package.json` — Paketname, `exports`, Abhaengigkeiten, `workspaces`;
 * - `tsconfig*.json` — Pfad-Aliase und die Abbildung Quelle ↔ Build-Ausgabe;
 * - Container-Kompositionsdateien — die Dienstebene.
 *
 * Jede Datei, die zwar gefunden, aber nicht gelesen werden konnte, landet mit
 * Grund im Skip-Ledger (E4). Ein unlesbares Manifest darf nie dazu fuehren,
 * dass ein ganzes Teilprojekt lautlos aus der Topologie verschwindet.
 */
import type { FileSystemPort, SkipLedgerEntryV1, SkipReason } from "@untangle-code/domain";
import {
  buildSkipLedgerEntry,
  compareCodepoints,
  summarizeSkipReasons,
} from "@untangle-code/domain";

import { WorkspacePackageCatalog, comparePackages } from "../package-catalog.js";
import { dirnameOf, normalizePath, normalizeSeparators, relativeToRoot } from "../paths.js";
import type {
  AliasRuleV1,
  ContainerServiceEdgeV1,
  ContainerServiceV1,
  RepositoryInputV1,
  WorkspacePackageEdgeV1,
  WorkspacePackageV1,
  WorkspaceTopologyV1,
} from "../types.js";

import { COMPOSE_FILE_NAMES, parseComposeFile } from "./compose.js";
import type { ManifestV1 } from "./manifest.js";
import { DEPENDENCY_FIELDS, isWorkspaceProtocol, parseManifest } from "./manifest.js";
import type { ProjectConfigV1 } from "./project-config.js";
import { resolveProjectConfig } from "./project-config.js";
import { matchesGlobSelection, parsePnpmWorkspace, splitGlobs } from "./workspace-definition.js";

/** Verzeichnisnamen, die der Topologielauf nie betritt. */
export const DEFAULT_IGNORED_DIRECTORIES = [
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
] as const;

export interface LoadTopologyOptionsV1 {
  workspaceId: string;
  /** Generation, unter der das Skip-Ledger gefuehrt wird. */
  generationId: string;
  repositories: readonly RepositoryInputV1[];
  /** Ueberschreibt `DEFAULT_IGNORED_DIRECTORIES`, wenn gesetzt. */
  ignoredDirectories?: readonly string[];
  /** Obergrenze der Verzeichnistiefe je Repository. */
  maxDepth?: number;
  /** Obergrenze besuchter Verzeichnisse je Repository (Budget, kein Ratschlag). */
  maxDirectories?: number;
}

/** Eine gelesene Projektkonfiguration samt ihrem Repository. */
export interface ProjectConfigEntryV1 {
  repoId: string;
  config: ProjectConfigV1;
}

/** Ergebnis inklusive der gelesenen Projektkonfigurationen. */
export interface LoadedTopologyV1 {
  topology: WorkspaceTopologyV1;
  /** `configKey(repoId, pfad)` → ausgewertete Konfiguration. */
  projectConfigs: Map<string, ProjectConfigEntryV1>;
}

interface FoundFile {
  repoId: string;
  /** repo-relativer Pfad. */
  path: string;
  absolutePath: string;
}

/** Baut die Topologie eines Workspace aus den Dateien seiner Repositories. */
export async function loadWorkspaceTopology(
  fs: FileSystemPort,
  options: LoadTopologyOptionsV1,
): Promise<LoadedTopologyV1> {
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
  const maxDepth = options.maxDepth ?? 12;
  const maxDirectories = options.maxDirectories ?? 20_000;
  const skipped: SkipLedgerEntryV1[] = [];

  const manifestFiles: FoundFile[] = [];
  const configFiles: FoundFile[] = [];
  const composeFiles: FoundFile[] = [];
  const workspaceFiles: FoundFile[] = [];

  for (const repository of options.repositories) {
    const root = normalizeSeparators(repository.rootPath);
    let visited = 0;
    let budgetReported = false;
    const queue: { absolutePath: string; depth: number }[] = [{ absolutePath: root, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift() as { absolutePath: string; depth: number };
      if (visited >= maxDirectories) {
        if (!budgetReported) {
          budgetReported = true;
          skipped.push(
            buildSkipLedgerEntry({
              stage: "file_graph",
              subjectKind: "file",
              path: relativeToRoot(root, current.absolutePath) ?? current.absolutePath,
              repoId: repository.repoId,
              refId: repository.refId,
              reason: "time_budget_exceeded",
              detail: `topology walk stopped after ${String(maxDirectories)} directories in repository ${repository.repoId}; raise maxDirectories to see the rest`,
              recoverable: true,
            }),
          );
        }
        break;
      }
      visited += 1;

      let entries;
      try {
        entries = await fs.readDir(current.absolutePath);
      } catch (error) {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "file_graph",
            subjectKind: "file",
            path: relativeToRoot(root, current.absolutePath) ?? current.absolutePath,
            repoId: repository.repoId,
            refId: repository.refId,
            reason: "resolution_failed",
            detail: `directory could not be read: ${messageOf(error)}`,
            recoverable: true,
          }),
        );
        continue;
      }

      for (const entry of [...entries].sort((left, right) =>
        compareCodepoints(left.name, right.name),
      )) {
        const absolutePath = normalizeSeparators(entry.path);
        const relative = relativeToRoot(root, absolutePath);
        if (relative === null) {
          // Ein Eintrag ausserhalb der Repositorywurzel kann nur ueber einen
          // Symlink entstehen; er wird gemeldet, nicht verfolgt.
          skipped.push(
            buildSkipLedgerEntry({
              stage: "file_graph",
              subjectKind: "file",
              path: absolutePath,
              repoId: repository.repoId,
              refId: repository.refId,
              reason: "excluded_by_configuration",
              detail: `entry lies outside the repository root ${root} and was not followed`,
              recoverable: false,
            }),
          );
          continue;
        }
        if (entry.kind === "directory") {
          if (ignored.has(entry.name)) continue;
          if (current.depth + 1 > maxDepth) {
            skipped.push(
              buildSkipLedgerEntry({
                stage: "file_graph",
                subjectKind: "file",
                path: relative,
                repoId: repository.repoId,
                refId: repository.refId,
                reason: "excluded_by_configuration",
                detail: `directory depth ${String(current.depth + 1)} exceeds maxDepth ${String(maxDepth)}`,
                recoverable: true,
              }),
            );
            continue;
          }
          queue.push({ absolutePath, depth: current.depth + 1 });
          continue;
        }
        if (entry.kind !== "file") continue;

        const found: FoundFile = { repoId: repository.repoId, path: relative, absolutePath };
        const name = entry.name;
        if (name === "package.json") {
          manifestFiles.push(found);
        } else if (/^tsconfig(\..+)?\.json$/i.test(name) || /^jsconfig(\..+)?\.json$/i.test(name)) {
          configFiles.push(found);
        } else if ((COMPOSE_FILE_NAMES as readonly string[]).includes(name)) {
          composeFiles.push(found);
        } else if (name === "pnpm-workspace.yaml" || name === "pnpm-workspace.yml") {
          workspaceFiles.push(found);
        }
      }
    }
  }

  const repositoriesById = new Map(
    options.repositories.map((repository) => [repository.repoId, repository]),
  );

  // ---- Projektkonfigurationen ------------------------------------------
  const configTexts = new Map<string, string>();
  for (const file of configFiles) {
    try {
      configTexts.set(configKey(file.repoId, file.path), await fs.readTextFile(file.absolutePath));
    } catch (error) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          `project configuration unreadable: ${messageOf(error)}`,
          true,
        ),
      );
    }
  }
  const projectConfigs = new Map<string, ProjectConfigEntryV1>();
  for (const file of configFiles) {
    const result = resolveProjectConfig(file.path, (path) => {
      const text = configTexts.get(configKey(file.repoId, path));
      if (text !== undefined) return text;
      // `extends`-Ziele koennen ausserhalb des Suchbereichs liegen (z. B. in
      // node_modules). Sie werden nicht nachgeladen — das meldet
      // `resolveProjectConfig` als Warnung, die hier ins Ledger geht.
      return null;
    });
    if (!result.ok) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          `project configuration could not be evaluated: ${result.error}`,
          false,
        ),
      );
      continue;
    }
    for (const warning of result.warnings) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          `project configuration partially evaluated: ${warning}`,
          false,
        ),
      );
    }
    projectConfigs.set(configKey(file.repoId, file.path), {
      repoId: file.repoId,
      config: result.config,
    });
  }

  // ---- Workspace-Globs --------------------------------------------------
  const globsByRepo = new Map<string, string[]>();
  for (const file of workspaceFiles) {
    try {
      const text = await fs.readTextFile(file.absolutePath);
      const parsed = parsePnpmWorkspace(text);
      if (!parsed.ok) {
        skipped.push(
          ledgerEntry(
            repositoriesById,
            file,
            "resolution_failed",
            `workspace definition unreadable: ${parsed.error}`,
            false,
          ),
        );
        continue;
      }
      const existing = globsByRepo.get(file.repoId) ?? [];
      globsByRepo.set(file.repoId, [...existing, ...parsed.globs]);
    } catch (error) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          `workspace definition unreadable: ${messageOf(error)}`,
          true,
        ),
      );
    }
  }

  // ---- Manifeste --------------------------------------------------------
  const manifests: { file: FoundFile; manifest: ManifestV1 }[] = [];
  for (const file of manifestFiles) {
    let text: string;
    try {
      text = await fs.readTextFile(file.absolutePath);
    } catch (error) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          `manifest unreadable: ${messageOf(error)}`,
          true,
        ),
      );
      continue;
    }
    const parsed = parseManifest(text);
    if (!parsed.ok) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "parse_failed",
          `manifest could not be parsed: ${parsed.error}`,
          false,
        ),
      );
      continue;
    }
    manifests.push({ file, manifest: parsed.manifest });
    if (parsed.manifest.workspaceGlobs.length > 0 && dirnameOf(file.path) === "") {
      const existing = globsByRepo.get(file.repoId) ?? [];
      globsByRepo.set(file.repoId, [...existing, ...parsed.manifest.workspaceGlobs]);
    }
  }

  // ---- Pakete -----------------------------------------------------------
  const packages: WorkspacePackageV1[] = [];
  const manifestByPackage = new Map<string, ManifestV1>();
  for (const { file, manifest } of manifests) {
    const packageDir = dirnameOf(file.path);
    const globs = globsByRepo.get(file.repoId) ?? [];
    const selection = splitGlobs(globs);
    const isRoot = packageDir === "";
    if (!isRoot && globs.length > 0 && !matchesGlobSelection(selection, packageDir)) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "excluded_by_configuration",
          `manifest directory "${packageDir}" matches no workspace glob (${globs.join(", ")})`,
          false,
        ),
      );
      continue;
    }
    if (manifest.name === undefined) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          'manifest has no "name" and can therefore not enter the package catalog',
          false,
        ),
      );
      continue;
    }
    const entry: WorkspacePackageV1 = {
      name: manifest.name,
      repoId: file.repoId,
      packageDir,
      manifestPath: file.path,
      workspaceDependencies: [],
      externalDependencies: {},
    };
    if (manifest.version !== undefined) entry.version = manifest.version;
    if (manifest.main !== undefined) entry.main = manifest.main;
    if (manifest.module !== undefined) entry.module = manifest.module;
    if (manifest.types !== undefined) entry.types = manifest.types;
    if (manifest.exports !== undefined) entry.exports = manifest.exports;
    if (manifest.imports !== undefined) entry.imports = manifest.imports;

    const configPath = packageDir === "" ? "tsconfig.json" : `${packageDir}/tsconfig.json`;
    const config = projectConfigs.get(configKey(file.repoId, configPath))?.config;
    if (config?.outDir !== undefined) entry.outDir = config.outDir;
    if (config?.rootDir !== undefined) entry.rootDir = config.rootDir;

    packages.push(entry);
    // Das Manifest wird ueber die IDENTITAET des Pakets zurueckgehalten
    // (Repository plus Manifestpfad), nicht ueber seinen Namen: gleichnamige
    // Pakete zweier Repositories wuerden sonst einander verdecken, und ein
    // Paket bekaeme die Abhaengigkeiten eines fremden.
    manifestByPackage.set(packageKey(entry), manifest);
  }
  // Kanonische Ordnung: der Name allein ist bei gleichnamigen Paketen keine
  // eindeutige Sortierung und damit kein Determinismus.
  packages.sort(comparePackages);

  const catalog = new WorkspacePackageCatalog(packages);
  for (const name of catalog.ambiguousNames()) {
    const owners = catalog.byPackageName(name);
    // Der Massstab ist die Zahl der MANIFESTE, nicht die der Repositories:
    // zwei gleichnamige Manifeste EINES Repositories machen jeden Import auf
    // den Namen genauso unentscheidbar wie zwei Repositories — und dieser
    // Fall blieb frueher ungemeldet, weil nur `repos.size > 1` gefragt wurde.
    const repos = new Set(owners.map((owner) => owner.repoId));
    const scope =
      repos.size === 1
        ? `within the single repository "${[...repos][0] as string}"`
        : owners.length > repos.size
          ? "in different repositories, and more than once within at least one of them"
          : "in different repositories";
    skipped.push(
      buildSkipLedgerEntry({
        stage: "file_graph",
        subjectKind: "file",
        reason: "ambiguous_resolution",
        detail: `package name "${name}" is declared by ${String(owners.length)} manifests ${scope} (${owners
          .map((owner) => `${owner.repoId}:${owner.manifestPath}`)
          .join(
            ", ",
          )}); a reference to it is attributed to the declaring repository first and reported as ambiguous whenever it cannot be attributed to exactly one manifest`,
        recoverable: false,
      }),
    );
  }

  // ---- Paketkanten ------------------------------------------------------
  const packageEdges: WorkspacePackageEdgeV1[] = [];
  for (const entry of packages) {
    const manifest = manifestByPackage.get(packageKey(entry));
    if (manifest === undefined) continue;
    const workspaceDependencies = new Set<string>();
    const externalDependencies: Record<string, string> = {};
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(manifest.dependencies[field])) {
        // Aus der Sicht des DEKLARIERENDEN Repositories nachschlagen: das
        // eigene `shared-lib` ist gemeint, nicht das gleichnamige nebenan.
        const lookup = catalog.lookup(entry.repoId, name);
        const target = lookup.status === "found" ? lookup.entry : null;
        // Ein Paketname, der im Katalog steht, IST eine Workspace-Kante —
        // auch ohne `workspace:`-Praefix. pnpm loest `"^1.0.0"` auf ein
        // lokales Paket auf, wenn dessen Version passt; wer nur auf das
        // Protokoll schaut, verliert genau diese Kanten.
        if (target !== null && packageKey(target) !== packageKey(entry)) {
          workspaceDependencies.add(name);
          packageEdges.push({
            fromPackage: entry.name,
            toPackage: name,
            kind: "workspace-dependency",
            dependencyField: field,
            rawRange: range,
          });
          continue;
        }
        if (lookup.status === "ambiguous") {
          // Der Name steht im Workspace, aber nicht auf genau einem Manifest:
          // entweder in mehreren fremden Repositories oder mehrfach im
          // eigenen. Weder Workspace-Kante noch externe Abhaengigkeit waere
          // belegbar — also wird der Fall benannt, nicht geraten.
          skipped.push(
            buildSkipLedgerEntry({
              stage: "file_graph",
              subjectKind: "file",
              path: entry.manifestPath,
              repoId: entry.repoId,
              ...(repositoriesById.get(entry.repoId) === undefined
                ? {}
                : { refId: (repositoriesById.get(entry.repoId) as RepositoryInputV1).refId }),
              reason: "ambiguous_resolution",
              detail: `package "${entry.name}" declares "${name}" in ${field}, but "${name}" is declared by ${String(lookup.candidates.length)} manifests [${lookup.candidates
                .map((candidate) => `${candidate.repoId}:${candidate.manifestPath}`)
                .join(
                  ", ",
                )}] and none of them is the single candidate for repository "${entry.repoId}"; no package edge is recorded`,
              recoverable: false,
            }),
          );
          continue;
        }
        if (!isWorkspaceProtocol(range)) {
          externalDependencies[name] = range;
        }
      }
    }
    entry.workspaceDependencies = [...workspaceDependencies].sort(compareCodepoints);
    entry.externalDependencies = externalDependencies;
  }
  packageEdges.sort(
    (left, right) =>
      compareCodepoints(left.fromPackage, right.fromPackage) ||
      compareCodepoints(left.toPackage, right.toPackage) ||
      compareCodepoints(left.dependencyField, right.dependencyField),
  );

  // ---- Dienste ----------------------------------------------------------
  const services: ContainerServiceV1[] = [];
  const serviceEdges: ContainerServiceEdgeV1[] = [];
  for (const file of composeFiles) {
    let text: string;
    try {
      text = await fs.readTextFile(file.absolutePath);
    } catch (error) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          `compose file unreadable: ${messageOf(error)}`,
          true,
        ),
      );
      continue;
    }
    const parsed = parseComposeFile(file.repoId, file.path, text);
    if (!parsed.ok) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "parse_failed",
          `compose file could not be parsed: ${parsed.error}`,
          false,
        ),
      );
      continue;
    }
    for (const warning of parsed.result.warnings) {
      skipped.push(
        ledgerEntry(
          repositoriesById,
          file,
          "resolution_failed",
          `compose file partially read: ${warning}`,
          false,
        ),
      );
    }
    services.push(...parsed.result.services);
    serviceEdges.push(...parsed.result.edges);
  }
  services.sort(
    (left, right) =>
      compareCodepoints(left.composeFile, right.composeFile) ||
      compareCodepoints(left.name, right.name),
  );

  const workspaceGlobs = [...new Set([...globsByRepo.values()].flat())].sort(compareCodepoints);

  const topology: WorkspaceTopologyV1 = {
    schemaVersion: 1,
    workspaceId: options.workspaceId,
    workspaceGlobs,
    packages,
    packageEdges,
    services,
    serviceEdges,
    skipped: {
      schemaVersion: 1,
      generationId: options.generationId,
      entries: skipped,
      countsByReason: summarizeSkipReasons(skipped),
    },
  };

  return { topology, projectConfigs };
}

/** Schluessel eines Konfigurationsfundes: Repository plus repo-relativer Pfad. */
export function configKey(repoId: string, path: string): string {
  return `${repoId}\u001f${normalizePath(path)}`;
}

/**
 * Aliasregeln aller gelesenen Projektkonfigurationen, in stabiler Reihenfolge.
 *
 * Die Reihenfolge ist „spezifischstes Muster zuerst": ein Muster ohne `*`
 * schlaegt eines mit `*`, und laengere Praefixe schlagen kuerzere. Genau so
 * loest TypeScript `paths` auf; ohne diese Ordnung wuerde `@app/*` ein
 * konkretes `@app/core` verdecken.
 */
export function aliasRulesFromConfigs(
  configs: ReadonlyMap<string, ProjectConfigEntryV1>,
): AliasRuleV1[] {
  const rules: AliasRuleV1[] = [];
  for (const { repoId, config } of configs.values()) {
    for (const [pattern, targets] of Object.entries(config.paths)) {
      rules.push({ pattern, targets: [...targets], repoId, source: config.configPath });
    }
  }
  rules.sort((left, right) => {
    const leftStar = left.pattern.includes("*") ? 1 : 0;
    const rightStar = right.pattern.includes("*") ? 1 : 0;
    if (leftStar !== rightStar) return leftStar - rightStar;
    const leftPrefix = left.pattern.split("*")[0]?.length ?? 0;
    const rightPrefix = right.pattern.split("*")[0]?.length ?? 0;
    if (leftPrefix !== rightPrefix) return rightPrefix - leftPrefix;
    return (
      compareCodepoints(left.pattern, right.pattern) ||
      compareCodepoints(left.source, right.source) ||
      compareCodepoints(left.repoId, right.repoId)
    );
  });
  return rules;
}

function ledgerEntry(
  repositories: ReadonlyMap<string, RepositoryInputV1>,
  file: FoundFile,
  reason: SkipReason,
  detail: string,
  recoverable: boolean,
): SkipLedgerEntryV1 {
  const repository = repositories.get(file.repoId);
  return buildSkipLedgerEntry({
    stage: "file_graph",
    subjectKind: "file",
    path: file.path,
    repoId: file.repoId,
    ...(repository === undefined ? {} : { refId: repository.refId }),
    reason,
    detail,
    recoverable,
  });
}

/** Identitaet eines Pakets: Repository plus Manifestpfad, nicht der Name. */
function packageKey(entry: WorkspacePackageV1): string {
  return `${entry.repoId}\u001f${entry.manifestPath}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
