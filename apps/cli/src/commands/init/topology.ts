/**
 * Monorepo topology: the level ABOVE the files.
 *
 * A project is rarely one thing. It is `packages/*` under a workspace
 * definition, and it is `frontend`/`backend`/`worker` under a container
 * composition — two different, equally real decompositions of the same
 * repository. `@untangle-code/file-graph` already reads both
 * (`loadWorkspaceTopology`: `pnpm-workspace.yaml`, `package.json#workspaces`,
 * `tsconfig*.json`, and every composition file), so this module CALLS it and
 * does not rebuild it.
 *
 * What is added here is exactly the part file-graph does not read: the marker
 * files of the other workspace managers (`lerna.json`, `nx.json`,
 * `turbo.json`). They are DETECTED, not interpreted into a second package
 * discovery. When such a marker declares a layout the topology pass did not
 * find, that is written down as a gap (E4) — a config that quietly claims a
 * single-package project because nobody read `lerna.json` is exactly the kind
 * of silent skip the project forbids.
 */

import type { FileSystemPort, SkipLedgerEntryV1 } from "@untangle-code/domain";
import { buildSkipLedgerEntry, compareCodepoints, sortByCodepoints } from "@untangle-code/domain";
import { loadWorkspaceTopology } from "@untangle-code/file-graph";

import type {
  DetectedPackageV1,
  DetectedServiceV1,
  InitLimitsV1,
  TopologyFindingsV1,
  WorkspaceManagerMarkersV1,
} from "./types.js";

/**
 * Transient ids for the topology pass. `loadWorkspaceTopology` needs a
 * workspace id and a generation id to key its skip ledger; `init` persists
 * neither, so both are fixed constants rather than a clock- or
 * random-derived value (determinism rule: no `Date.now()`/`Math.random()` in
 * result data).
 */
export const INIT_WORKSPACE_ID = "untangle-init";
export const INIT_GENERATION_ID = "untangle-init";
/** The single repository `init` looks at: the directory it was pointed at. */
export const INIT_REPO_ID = "root";
export const INIT_REF_ID = "root:HEAD";

/** Marker files of workspace managers, in probe order (codepoint-sorted). */
export const WORKSPACE_MANAGER_MARKERS = ["lerna.json", "nx.json", "turbo.json"] as const;

export interface TopologyInput {
  fs: FileSystemPort;
  /** Absolute, canonical repository root. */
  repoRoot: string;
  limits: InitLimitsV1;
  onSkipEntry: (entry: SkipLedgerEntryV1) => void;
}

export async function detectTopology(input: TopologyInput): Promise<TopologyFindingsV1> {
  const { fs, repoRoot, limits, onSkipEntry } = input;

  const loaded = await loadWorkspaceTopology(fs, {
    workspaceId: INIT_WORKSPACE_ID,
    generationId: INIT_GENERATION_ID,
    // `rootPath` is what the topology walk actually descends from, so it is
    // the ABSOLUTE repository root — the field's own doc calls it
    // workspace-root-relative, and for a single-repository workspace those
    // are the same thing. Everything the pass reports back is repo-relative.
    repositories: [{ repoId: INIT_REPO_ID, refId: INIT_REF_ID, rootPath: repoRoot }],
    maxDepth: limits.maxTopologyDepth,
    maxDirectories: limits.maxTopologyDirectories,
  });

  // The topology pass keeps its own ledger; folding it into ours is what
  // keeps a single `untangle init` run answerable for everything it skipped.
  for (const entry of loaded.topology.skipped.entries) {
    onSkipEntry(entry);
  }

  const packages: DetectedPackageV1[] = loaded.topology.packages
    .map((pkg) => ({
      name: pkg.name,
      directory: pkg.packageDir,
      workspaceDependencyCount: pkg.workspaceDependencies.length,
    }))
    .sort(
      (a, b) => compareCodepoints(a.name, b.name) || compareCodepoints(a.directory, b.directory),
    );

  const services: DetectedServiceV1[] = loaded.topology.services
    .map((service) => ({
      name: service.name,
      composeFile: service.composeFile,
      ...(service.buildContext === undefined ? {} : { buildContext: service.buildContext }),
      ...(service.image === undefined ? {} : { image: service.image }),
      dependsOn: sortByCodepoints(service.dependsOn),
    }))
    .sort(
      (a, b) =>
        compareCodepoints(a.composeFile, b.composeFile) || compareCodepoints(a.name, b.name),
    );

  const managers = await detectWorkspaceManagers(fs, repoRoot, packages.length, onSkipEntry);

  return {
    workspaceGlobs: sortByCodepoints(loaded.topology.workspaceGlobs),
    packages,
    services,
    packageEdgeCount: loaded.topology.packageEdges.length,
    serviceEdgeCount: loaded.topology.serviceEdges.length,
    managers,
    isMonorepo: packages.length > 1 || services.length > 1,
  };
}

/**
 * Reads the marker files of the workspace managers file-graph does not know.
 *
 * `lerna.json` is the only one of the three that declares a package layout in
 * its own right (`packages: [...]`); `nx.json` and `turbo.json` sit on top of
 * an existing npm/pnpm/yarn workspace and therefore add nothing to the
 * package list. So only lerna can produce a real gap, and only when the
 * topology pass found no packages at all.
 */
export async function detectWorkspaceManagers(
  fs: FileSystemPort,
  repoRoot: string,
  packagesFound: number,
  onSkipEntry: (entry: SkipLedgerEntryV1) => void,
): Promise<WorkspaceManagerMarkersV1> {
  const markerFiles: string[] = [];
  let lernaGlobs: string[] = [];

  for (const marker of WORKSPACE_MANAGER_MARKERS) {
    const absolute = joinPath(repoRoot, marker);
    const stat = await fs.stat(absolute);
    if (stat === null || stat.kind !== "file") {
      continue;
    }
    markerFiles.push(marker);
    if (marker !== "lerna.json") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(await fs.readTextFile(absolute));
      lernaGlobs = sortByCodepoints(readStringArray(parsed, "packages"));
    } catch {
      onSkipEntry(
        buildSkipLedgerEntry({
          stage: "file_graph",
          subjectKind: "file",
          path: marker,
          reason: "parse_failed",
          detail:
            "lerna.json exists but could not be read as JSON; its declared package globs are therefore absent from the topology.",
          recoverable: false,
        }),
      );
    }
  }

  const uncoveredByTopology: string[] = [];
  if (lernaGlobs.length > 0 && packagesFound === 0) {
    uncoveredByTopology.push("lerna.json");
    onSkipEntry(
      buildSkipLedgerEntry({
        stage: "file_graph",
        subjectKind: "file",
        path: "lerna.json",
        reason: "unsupported_language",
        detail: `lerna.json declares package globs (${lernaGlobs.join(", ")}), but topology discovered no packages: @untangle-code/file-graph reads pnpm-workspace.yaml and package.json#workspaces, not lerna.json. This repository's subprojects are therefore absent from the topology.`,
        recoverable: false,
      }),
    );
  }

  return { markerFiles: sortByCodepoints(markerFiles), lernaGlobs, uncoveredByTopology };
}

function readStringArray(value: unknown, key: string): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const raw = (value as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === "string");
}

/** `node:path`-free join: this module must stay usable against any `FileSystemPort`. */
function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}
