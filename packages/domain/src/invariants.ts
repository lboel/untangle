/**
 * Executable invariants and guards (architecture.md §14.1, §13.4, §18.4,
 * §23.1; spec.md §8.4).
 *
 * Everything here is pure: no file system, no network. The symlink-aware half
 * of the path sandbox (canonical `realPath` resolution) is an adapter duty —
 * adapters resolve, then call {@link assertWithinWorkspace} again on the
 * resolved path (architecture.md §23.1 steps 1–4).
 */
import path from "node:path";

import type { CoverageEntry } from "./analysis.js";
import { UntangleError } from "./errors.js";
import { ID_COMPONENT_SEPARATOR } from "./identity.js";
import type { SourceRange } from "./types/common.js";

// ---------------------------------------------------------------------------
// Path sandbox (architecture.md §23.1; spec.md §24)
// ---------------------------------------------------------------------------

function normalizeForComparison(p: string): string {
  // win32.resolve handles both "/" and "\" separators as well as drive
  // letters; posix.resolve would mangle "C:\x". Decide per input shape.
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
  const resolved = isWindowsPath ? path.win32.resolve(p) : path.posix.resolve(p);
  // Windows paths compare case-insensitively; posix paths do not.
  return isWindowsPath ? resolved.toLowerCase().replace(/\//g, "\\") : resolved;
}

function separatorFor(normalized: string): string {
  return normalized.includes("\\") ? "\\" : "/";
}

/**
 * Asserts that `candidatePath` lies inside at least one of the workspace
 * `roots` after lexical canonicalization ("." / ".." resolution). Throws
 * `UntangleError` with code `PATH_OUTSIDE_WORKSPACE` otherwise.
 *
 * A relative `candidatePath` is resolved against each root in turn. Returns
 * the resolved absolute path (in the platform style of the matching root).
 *
 * Purely lexical: symlinks are NOT resolved here (no fs access in domain) —
 * callers with symlink exposure must resolve via `FileSystemPort.realPath`
 * and re-assert (architecture.md §23.1 step 3).
 */
export function assertWithinWorkspace(candidatePath: string, roots: readonly string[]): string {
  if (roots.length === 0) {
    throw new UntangleError("PATH_OUTSIDE_WORKSPACE", "no workspace roots configured", {
      context: { candidatePath },
    });
  }
  const isAbsolute = path.posix.isAbsolute(candidatePath) || path.win32.isAbsolute(candidatePath);

  for (const root of roots) {
    const normalizedRoot = normalizeForComparison(root);
    const sep = separatorFor(normalizedRoot);
    const joined = isAbsolute ? candidatePath : `${root}${sep}${candidatePath}`;
    const normalizedCandidate = normalizeForComparison(joined);
    if (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(
        normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep,
      )
    ) {
      // Return the non-lowercased resolution for the matching root.
      const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(joined) || joined.includes("\\");
      return isWindowsPath ? path.win32.resolve(joined) : path.posix.resolve(joined);
    }
  }
  throw new UntangleError(
    "PATH_OUTSIDE_WORKSPACE",
    `path escapes all configured workspace roots: "${candidatePath}"`,
    { context: { candidatePath, roots: [...roots] } },
  );
}

// ---------------------------------------------------------------------------
// Coverage invariant (spec.md §8.4; architecture.md §14.1)
// ---------------------------------------------------------------------------

/** A problem found by the coverage validator. */
export interface CoverageIssue {
  kind:
    | "gap"
    | "out_of_range"
    | "empty_range"
    | "invalid_range"
    | "missing_exclusion_reason"
    | "missing_chunk_ids";
  message: string;
  range?: SourceRange;
}

export interface CoverageValidationResult {
  /** True iff chunked ∪ excluded ranges = complete file range, with valid entries. */
  complete: boolean;
  /** Uncovered byte intervals as pseudo-ranges (lines set to -1). */
  gaps: SourceRange[];
  issues: CoverageIssue[];
}

/**
 * Validates the lossless-chunking invariant (spec.md §8.4):
 *
 * `covered_source_ranges ∪ intentionally_excluded_ranges = complete_file_range`
 *
 * Coverage is computed over byte intervals (`startByte` inclusive, `endByte`
 * exclusive). Overlaps are allowed; gaps are not (architecture.md §14.1).
 * Additionally: "excluded" entries must carry an `exclusionReason`, "chunked"
 * entries a non-empty `chunkIds` list, and every entry must lie inside the
 * file range.
 */
export function validateCoverage(
  entries: readonly CoverageEntry[],
  fileRange: SourceRange,
): CoverageValidationResult {
  const issues: CoverageIssue[] = [];
  const intervals: { start: number; end: number }[] = [];

  for (const entry of entries) {
    const { range } = entry;
    if (range.endByte < range.startByte) {
      issues.push({
        kind: "invalid_range",
        message: `entry range has endByte < startByte (${range.startByte}..${range.endByte})`,
        range,
      });
      continue;
    }
    if (range.startByte < fileRange.startByte || range.endByte > fileRange.endByte) {
      issues.push({
        kind: "out_of_range",
        message: `entry range ${range.startByte}..${range.endByte} lies outside the file range ${fileRange.startByte}..${fileRange.endByte}`,
        range,
      });
    }
    if (entry.status === "excluded" && (entry.exclusionReason ?? "") === "") {
      issues.push({
        kind: "missing_exclusion_reason",
        message: "excluded range without documented exclusionReason (spec.md §8.4)",
        range,
      });
    }
    if (
      entry.status === "chunked" &&
      (entry.chunkIds === undefined || entry.chunkIds.length === 0)
    ) {
      issues.push({
        kind: "missing_chunk_ids",
        message: "chunked range without chunkIds",
        range,
      });
    }
    if (range.endByte > range.startByte) {
      intervals.push({ start: range.startByte, end: range.endByte });
    }
  }

  // Merge intervals and find gaps against the file range.
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps: SourceRange[] = [];
  let cursor = fileRange.startByte;
  for (const interval of intervals) {
    const start = Math.max(interval.start, fileRange.startByte);
    const end = Math.min(interval.end, fileRange.endByte);
    if (start > cursor) {
      gaps.push({ startLine: -1, endLine: -1, startByte: cursor, endByte: start });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < fileRange.endByte) {
    gaps.push({ startLine: -1, endLine: -1, startByte: cursor, endByte: fileRange.endByte });
  }

  for (const gap of gaps) {
    issues.push({
      kind: "gap",
      message: `uncovered byte range ${gap.startByte}..${gap.endByte} — hard truncation without follow-up chunk is forbidden (spec.md §8.4)`,
      range: gap,
    });
  }

  return { complete: issues.length === 0, gaps, issues };
}

// ---------------------------------------------------------------------------
// Generation completeness (architecture.md §13.4; spec.md §10.6)
// ---------------------------------------------------------------------------

export interface GenerationCompletenessInput {
  generationId: string;
  /** File ids planned for this generation. */
  plannedFileIds: readonly string[];
  /** File ids whose upserts were confirmed. */
  confirmedFileIds: readonly string[];
  /** All checkpoints for the generation persisted successfully. */
  checkpointsSaved: boolean;
  /** Graphs the generation is required to store, e.g. ["file", "symbol"]. */
  requiredGraphs: readonly string[];
  /** Graphs actually stored consistently. */
  storedGraphs: readonly string[];
  /** Final metadata status recorded for the generation. */
  metadataStatus: string;
}

export interface GenerationCompletenessResult {
  complete: boolean;
  missingFileIds: string[];
  missingGraphs: string[];
  reasons: string[];
}

/**
 * Checks the generation-commit conditions of architecture.md §13.4. A
 * generation may only be marked `completed` when this returns
 * `complete === true`; incomplete generations must never be served as
 * complete (spec.md §10.6).
 */
export function validateGenerationCompleteness(
  input: GenerationCompletenessInput,
): GenerationCompletenessResult {
  const confirmed = new Set(input.confirmedFileIds);
  const missingFileIds = input.plannedFileIds.filter((fileId) => !confirmed.has(fileId));
  const stored = new Set(input.storedGraphs);
  const missingGraphs = input.requiredGraphs.filter((graph) => !stored.has(graph));

  const reasons: string[] = [];
  if (missingFileIds.length > 0) {
    reasons.push(`${missingFileIds.length} planned file operation(s) not confirmed`);
  }
  if (!input.checkpointsSaved) {
    reasons.push("checkpoints not fully saved");
  }
  if (missingGraphs.length > 0) {
    reasons.push(`required graph(s) not stored: ${missingGraphs.join(", ")}`);
  }
  if (input.metadataStatus !== "completed") {
    reasons.push(`metadata status is "${input.metadataStatus}", expected "completed"`);
  }

  return {
    complete: reasons.length === 0,
    missingFileIds,
    missingGraphs,
    reasons,
  };
}

/**
 * Throwing variant of {@link validateGenerationCompleteness}: raises
 * `UntangleError` with code `INDEX_INCOMPLETE` when the generation must not
 * be committed.
 */
export function assertGenerationComplete(input: GenerationCompletenessInput): void {
  const result = validateGenerationCompleteness(input);
  if (!result.complete) {
    throw new UntangleError(
      "INDEX_INCOMPLETE",
      `generation "${input.generationId}" cannot be committed: ${result.reasons.join("; ")}`,
      {
        context: {
          generationId: input.generationId,
          missingFileIds: result.missingFileIds,
          missingGraphs: result.missingGraphs,
          reasons: result.reasons,
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Search dedupe key (architecture.md §18.4; spec.md §13.5)
// ---------------------------------------------------------------------------

export interface DedupeKeyInput {
  workspaceId: string;
  repoId: string;
  refId: string;
  metricsScopeId: string;
}

/**
 * Builds the cross-repo search dedupe key
 * `workspace_id + repo_id + ref_id + metrics_scope_id` (architecture.md §18.4).
 * Components are joined with U+001F to keep the key collision-free even when
 * ids contain "+" or ":".
 */
export function buildDedupeKey(input: DedupeKeyInput): string {
  for (const [label, value] of Object.entries(input)) {
    if (value === "") {
      throw new Error(`dedupe key component "${label}" must not be empty`);
    }
    if (value.includes(ID_COMPONENT_SEPARATOR)) {
      throw new Error(`dedupe key component "${label}" must not contain U+001F`);
    }
  }
  return [input.workspaceId, input.repoId, input.refId, input.metricsScopeId].join(
    ID_COMPONENT_SEPARATOR,
  );
}
