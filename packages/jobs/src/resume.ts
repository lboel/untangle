/**
 * Resume planning (architecture.md §6.14): reconstruct the remaining work
 * plan from the last CONFIRMED checkpoint, so a restarted job continues
 * exactly where confirmed work ended (spec.md §11.2) and never repeats an
 * already-confirmed file.
 */
import type { IndexCheckpointV1 } from "@untangle-code/domain";

import type { PlannedFileV1 } from "./stages.js";

/** The identity a checkpoint must match to be resumable for this job. */
export interface ResumeIdentityV1 {
  workspaceId: string;
  repoId: string;
  refId: string;
  effectiveProfileId: string;
}

/**
 * True when `checkpoint` belongs to exactly this workspace/repo/ref/profile.
 * A profile mismatch means an incompatible embedding profile — such a
 * checkpoint MUST NOT be resumed; the job needs its own new generation
 * (spec.md §11.2).
 */
export function checkpointMatches(
  checkpoint: IndexCheckpointV1,
  identity: ResumeIdentityV1,
): boolean {
  return (
    checkpoint.workspaceId === identity.workspaceId &&
    checkpoint.repoId === identity.repoId &&
    checkpoint.refId === identity.refId &&
    checkpoint.effectiveProfileId === identity.effectiveProfileId
  );
}

export interface ResumePlanV1 {
  /** True when a matching checkpoint was adopted. */
  resumed: boolean;
  /** Generation to continue (from the checkpoint), or null for a fresh run. */
  generationId: string | null;
  /** Files that still need the full pipeline. */
  remaining: PlannedFileV1[];
  /** Confirmed state carried over from the checkpoint (planned ∩ unchanged). */
  completedFiles: string[];
  storedPointIdsByFile: Record<string, string[]>;
  manifestHashes: Record<string, string>;
  /** How many planned files were skipped because they are already confirmed. */
  skippedCompleted: number;
}

/**
 * Builds the remaining work plan. A planned file is skipped only when the
 * checkpoint confirms it AND its content hash is unchanged — the content
 * hash is the source of truth (spec.md §12.1). Confirmed files whose hash
 * changed (or that are no longer planned) are dropped from the carried
 * state so they are re-confirmed by this run, never counted twice.
 */
export function planResume(
  planned: readonly PlannedFileV1[],
  checkpoint: IndexCheckpointV1 | null,
  identity: ResumeIdentityV1,
): ResumePlanV1 {
  if (checkpoint === null || !checkpointMatches(checkpoint, identity)) {
    return {
      resumed: false,
      generationId: null,
      remaining: [...planned],
      completedFiles: [],
      storedPointIdsByFile: {},
      manifestHashes: {},
      skippedCompleted: 0,
    };
  }

  const confirmed = new Set(checkpoint.completedFiles);
  const remaining: PlannedFileV1[] = [];
  const completedFiles: string[] = [];
  const storedPointIdsByFile: Record<string, string[]> = {};
  const manifestHashes: Record<string, string> = {};

  for (const file of planned) {
    const isConfirmedUnchanged =
      confirmed.has(file.fileId) && checkpoint.manifestHashes[file.fileId] === file.contentHash;
    if (!isConfirmedUnchanged) {
      remaining.push(file);
      continue;
    }
    completedFiles.push(file.fileId);
    manifestHashes[file.fileId] = file.contentHash;
    const pointIds = checkpoint.storedPointIdsByFile[file.fileId];
    if (pointIds !== undefined) {
      storedPointIdsByFile[file.fileId] = [...pointIds];
    }
  }

  return {
    resumed: true,
    generationId: checkpoint.generationId,
    remaining,
    completedFiles,
    storedPointIdsByFile,
    manifestHashes,
    skippedCompleted: completedFiles.length,
  };
}
