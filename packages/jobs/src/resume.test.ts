import type { IndexCheckpointV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { checkpointMatches, planResume, type ResumeIdentityV1 } from "./resume.js";
import { makePlannedFiles } from "./test-support.js";

const IDENTITY: ResumeIdentityV1 = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "ref-1",
  effectiveProfileId: "profile-1",
};

function makeCheckpoint(overrides: Partial<IndexCheckpointV1> = {}): IndexCheckpointV1 {
  return {
    jobId: "job-1",
    generationId: "gen-1",
    workspaceId: IDENTITY.workspaceId,
    repoId: IDENTITY.repoId,
    refId: IDENTITY.refId,
    effectiveProfileId: IDENTITY.effectiveProfileId,
    completedFiles: [],
    storedPointIdsByFile: {},
    manifestHashes: {},
    stage: "checkpointing",
    savedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkpointMatches", () => {
  it("requires workspace, repo, ref AND profile to match", () => {
    expect(checkpointMatches(makeCheckpoint(), IDENTITY)).toBe(true);
    expect(checkpointMatches(makeCheckpoint({ workspaceId: "other" }), IDENTITY)).toBe(false);
    expect(checkpointMatches(makeCheckpoint({ repoId: "other" }), IDENTITY)).toBe(false);
    expect(checkpointMatches(makeCheckpoint({ refId: "other" }), IDENTITY)).toBe(false);
    expect(checkpointMatches(makeCheckpoint({ effectiveProfileId: "other" }), IDENTITY)).toBe(
      false,
    );
  });
});

describe("planResume", () => {
  it("plans everything fresh without a checkpoint", () => {
    const planned = makePlannedFiles(3);
    const plan = planResume(planned, null, IDENTITY);
    expect(plan.resumed).toBe(false);
    expect(plan.generationId).toBeNull();
    expect(plan.remaining).toEqual(planned);
    expect(plan.completedFiles).toEqual([]);
    expect(plan.skippedCompleted).toBe(0);
  });

  it("ignores a checkpoint with an incompatible profile (spec.md §11.2)", () => {
    const planned = makePlannedFiles(3);
    const checkpoint = makeCheckpoint({
      effectiveProfileId: "other-profile",
      completedFiles: planned.map((file) => file.fileId),
      manifestHashes: Object.fromEntries(planned.map((file) => [file.fileId, file.contentHash])),
    });
    const plan = planResume(planned, checkpoint, IDENTITY);
    expect(plan.resumed).toBe(false);
    expect(plan.remaining).toHaveLength(3);
  });

  it("skips confirmed-and-unchanged files and carries their state", () => {
    const planned = makePlannedFiles(4);
    const done = planned.slice(0, 2);
    const checkpoint = makeCheckpoint({
      completedFiles: done.map((file) => file.fileId),
      manifestHashes: Object.fromEntries(done.map((file) => [file.fileId, file.contentHash])),
      storedPointIdsByFile: Object.fromEntries(
        done.map((file) => [file.fileId, [`${file.fileId}:p0`]]),
      ),
    });
    const plan = planResume(planned, checkpoint, IDENTITY);
    expect(plan.resumed).toBe(true);
    expect(plan.generationId).toBe("gen-1");
    expect(plan.remaining.map((file) => file.fileId)).toEqual(["file-002", "file-003"]);
    expect(plan.completedFiles).toEqual(["file-000", "file-001"]);
    expect(plan.storedPointIdsByFile).toEqual({
      "file-000": ["file-000:p0"],
      "file-001": ["file-001:p0"],
    });
    expect(plan.skippedCompleted).toBe(2);
  });

  it("re-plans a confirmed file whose content hash changed — hash is the source of truth", () => {
    const planned = makePlannedFiles(2, "v2");
    const checkpoint = makeCheckpoint({
      completedFiles: planned.map((file) => file.fileId),
      // Checkpoint knows the OLD hashes.
      manifestHashes: Object.fromEntries(
        planned.map((file) => [file.fileId, file.contentHash.replace("v2", "v1")]),
      ),
      storedPointIdsByFile: Object.fromEntries(
        planned.map((file) => [file.fileId, [`${file.fileId}:p0`]]),
      ),
    });
    const plan = planResume(planned, checkpoint, IDENTITY);
    expect(plan.resumed).toBe(true);
    expect(plan.remaining).toHaveLength(2);
    // Changed files are dropped from the carried state so they are
    // re-confirmed, never double-counted.
    expect(plan.completedFiles).toEqual([]);
    expect(plan.storedPointIdsByFile).toEqual({});
    expect(plan.manifestHashes).toEqual({});
  });

  it("drops confirmed files that are no longer planned", () => {
    const planned = makePlannedFiles(1);
    const checkpoint = makeCheckpoint({
      completedFiles: ["file-000", "file-gone"],
      manifestHashes: { "file-000": "hash-0-v1", "file-gone": "hash-gone" },
      storedPointIdsByFile: { "file-000": ["file-000:p0"], "file-gone": ["file-gone:p0"] },
    });
    const plan = planResume(planned, checkpoint, IDENTITY);
    expect(plan.completedFiles).toEqual(["file-000"]);
    expect(Object.keys(plan.storedPointIdsByFile)).toEqual(["file-000"]);
    expect(plan.remaining).toEqual([]);
  });
});
