/**
 * Workspace, repository and ref records (architecture.md §10.1–§10.2;
 * spec.md §4.3, §5.1–§5.3).
 */

/**
 * Package identity of a repository/module inside the cross-repo package
 * catalog (architecture.md §16.3), e.g. an npm package name or Go module path.
 */
export interface PackageIdentity {
  /** Package ecosystem, e.g. "npm", "pypi", "go", "crates", "maven", "nuget", "composer". */
  ecosystem: string;
  /** Canonical package name inside that ecosystem. */
  name: string;
  /** Declared version, when the manifest states one. */
  version?: string;
  /** Module root relative to the repository root, "/"-normalized. */
  moduleRoot?: string;
}

/** Persisted workspace record (architecture.md §10.1). */
export interface WorkspaceRecord {
  schemaVersion: 1;
  workspaceId: string;
  /** Hash of the canonical effective workspace configuration (spec.md §5.1). */
  configHash: string;
  repositories: RepositoryRecord[];
  /** ISO-8601; obtained via the Clock port, never Date.now(). */
  createdAt: string;
  updatedAt: string;
}

/** Persisted repository record (architecture.md §10.2). */
export interface RepositoryRecord {
  repoId: string;
  label: string;
  /** Canonically resolved absolute path of the repository root. */
  canonicalPath: string;
  remoteUrls: string[];
  packageIdentity?: PackageIdentity;
}

/**
 * Repository configuration as declared in `.untangle.json` (spec.md §4.3).
 *
 * NOTE: BUILD_PLAN §3 places config schemata in `packages/config`; this single
 * config type lives in domain by explicit WP-01 order because `RefRecord`,
 * scanner and portfolio contracts reference it. `packages/config` should
 * re-export it instead of redefining it (see README, "Entscheidungen").
 */
export interface RepositoryConfig {
  /** Unique within a workspace (spec.md §4.3). */
  id: string;
  /** Absolute, or relative to the configuration file. */
  path: string;
  label?: string;
  /** Default ref to index, e.g. a branch name. */
  ref?: string;
  include?: string[];
  exclude?: string[];
  packageAliases?: Record<string, string>;
  metadata?: Record<string, string>;
}

/** Index status of a ref (architecture.md §10.2). */
export type RefIndexStatus = "empty" | "in_progress" | "completed" | "failed";

/** Persisted ref record (architecture.md §10.2). */
export interface RefRecord {
  /** `repo_id + ":" + normalized_ref` (spec.md §5.3) — not a UUID. */
  refId: string;
  repoId: string;
  refName: string;
  commitSha?: string;
  /** Latest committed generation for this ref (spec.md §10.6). */
  generationId: string;
  indexStatus: RefIndexStatus;
}
