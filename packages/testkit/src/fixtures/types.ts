/**
 * Shared shapes for fixture generators (spec.md §27.2) and `FixtureBuilder`.
 */

/** One file to materialize, relative to its repository's root. */
export interface FixtureFile {
  /** "/"-normalized, relative to the repository root — never absolute. */
  path: string;
  content: string;
}

/** A named set of files, materialized as one repository/workspace member. */
export interface FixtureRepo {
  name: string;
  files: FixtureFile[];
}

/**
 * Ground truth accompanying a fixture — what a correct implementation
 * should find in it. Individual generators attach whatever subset applies
 * (a parser-error fixture has no dependency cycle, etc.); consumers read
 * only the fields their test cares about.
 */
export interface FixtureGroundTruth {
  /** Human-readable description of what this fixture is exercising. */
  description: string;
  /** Repo-relative paths expected to parse with the given quality. */
  expectedParseQuality?: Record<string, "complete" | "partial" | "failed">;
  /** Repo-relative paths participating in an intentional import cycle. */
  cycleParticipants?: string[];
  /** Fully-qualified symbol names expected to be found. */
  expectedSymbols?: string[];
}

/** A generator's full output: files plus the ground truth describing them. */
export interface GeneratedFixture {
  files: FixtureFile[];
  groundTruth: FixtureGroundTruth;
}
