/**
 * `.untangle/` local state directory layout (architecture.md §12).
 *
 * ```text
 * .untangle/
 * ├─ cache/
 * │  ├─ embeddings/
 * │  ├─ analysis/        (WP-100: parse/, chunk/, metrics/)
 * │  ├─ parser/
 * │  └─ git-blobs/
 * ├─ jobs/
 * ├─ locks/
 * ├─ product-complexity/
 * │  └─ sessions/
 * ├─ artifacts/
 * │  ├─ diffs/
 * │  └─ visualizations/
 * └─ logs/
 * ```
 *
 * Pure path arithmetic only — no I/O. `ensureStateDirLayout` is the one
 * function that actually touches the filesystem, via an injected
 * `FileSystemPort` (never `node:fs` directly), so layout construction stays
 * testable without a real disk.
 */
import path from "node:path";

import type { FileSystemPort, PortCallOptions } from "@untangle-code/domain";

import { assertNotAborted } from "./abort.js";

/**
 * Die drei inhaltsadressierten Analyse-Caches (WP-100). Sie liegen unter
 * `cache/analysis/`, getrennt nach Art, damit jeder seine eigene
 * Groessengrenze und seine eigene Trefferquote hat.
 */
export interface StateAnalysisCacheLayout {
  root: string;
  parse: string;
  chunk: string;
  metrics: string;
}

export interface StateCacheLayout {
  root: string;
  embeddings: string;
  analysis: StateAnalysisCacheLayout;
  parser: string;
  gitBlobs: string;
}

export interface StateArtifactsLayout {
  root: string;
  diffs: string;
  visualizations: string;
}

/** The full `.untangle/` layout rooted at one absolute directory. */
export interface StateDirLayout {
  /** Absolute path to the state directory itself (e.g. `<workspace>/.untangle`). */
  root: string;
  cache: StateCacheLayout;
  jobs: string;
  locks: string;
  productComplexity: {
    root: string;
    sessions: string;
  };
  artifacts: StateArtifactsLayout;
  logs: string;
}

/** Builds the layout's paths under `root`. Pure; performs no I/O. */
export function buildStateDirLayout(root: string): StateDirLayout {
  const cacheRoot = path.join(root, "cache");
  const analysisRoot = path.join(cacheRoot, "analysis");
  const artifactsRoot = path.join(root, "artifacts");
  const productComplexityRoot = path.join(root, "product-complexity");
  return {
    root,
    cache: {
      root: cacheRoot,
      embeddings: path.join(cacheRoot, "embeddings"),
      analysis: {
        root: analysisRoot,
        parse: path.join(analysisRoot, "parse"),
        chunk: path.join(analysisRoot, "chunk"),
        metrics: path.join(analysisRoot, "metrics"),
      },
      parser: path.join(cacheRoot, "parser"),
      gitBlobs: path.join(cacheRoot, "git-blobs"),
    },
    jobs: path.join(root, "jobs"),
    locks: path.join(root, "locks"),
    productComplexity: {
      root: productComplexityRoot,
      sessions: path.join(productComplexityRoot, "sessions"),
    },
    artifacts: {
      root: artifactsRoot,
      diffs: path.join(artifactsRoot, "diffs"),
      visualizations: path.join(artifactsRoot, "visualizations"),
    },
    logs: path.join(root, "logs"),
  };
}

/** Every directory the layout declares, in an order safe for sequential `mkdir`. */
export function listStateDirLayoutPaths(layout: StateDirLayout): string[] {
  return [
    layout.root,
    layout.cache.root,
    layout.cache.embeddings,
    layout.cache.analysis.root,
    layout.cache.analysis.parse,
    layout.cache.analysis.chunk,
    layout.cache.analysis.metrics,
    layout.cache.parser,
    layout.cache.gitBlobs,
    layout.jobs,
    layout.locks,
    layout.productComplexity.root,
    layout.productComplexity.sessions,
    layout.artifacts.root,
    layout.artifacts.diffs,
    layout.artifacts.visualizations,
    layout.logs,
  ];
}

/**
 * Creates every directory of the layout (idempotent — safe to call on every
 * startup). Directories are created one at a time with `recursive: true` so
 * a partially-created layout from a previous aborted run is completed
 * without error.
 */
export async function ensureStateDirLayout(
  fs: FileSystemPort,
  layout: StateDirLayout,
  options?: PortCallOptions,
): Promise<void> {
  for (const dir of listStateDirLayoutPaths(layout)) {
    assertNotAborted(options, "ensure_state_dir_layout");
    await fs.mkdir(dir, {
      recursive: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }
}
