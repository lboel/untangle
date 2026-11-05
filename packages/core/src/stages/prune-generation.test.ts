import { InMemoryVectorStore } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { pruneObsoleteCodePoints } from "./prune-generation.js";

const target = { workspaceId: "workspace", repoId: "repo", refId: "repo:main" };
const input = { collection: "code", target, generationId: "current" };

describe("obsolete code generation pruning", () => {
  it("removes missing and old generations while retaining current and foreign scope points", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection({
      name: "code",
      denseDimensions: 2,
      denseDistance: "Cosine",
      sparseBm25: true,
      onDiskPayload: false,
    });
    const payload = { workspace_id: "workspace", repo_id: "repo", ref_id: "repo:main" };
    const fixtures = [
      { id: "missing", payload },
      { id: "obsolete", payload: { ...payload, generation_id: "previous" } },
      { id: "current", payload: { ...payload, generation_id: "current" } },
      { id: "other-workspace", payload: { ...payload, workspace_id: "other" } },
      { id: "other-repo", payload: { ...payload, repo_id: "other" } },
      { id: "other-ref", payload: { ...payload, ref_id: "repo:feature" } },
    ];
    await store.upsert(
      "code",
      fixtures.map((point) => ({ ...point, dense: [1, 0] })),
    );
    await pruneObsoleteCodePoints({ ...input, vectorStore: store });
    const remaining = await store.scroll("code", { limit: 100 });
    expect(remaining.points.map((point) => point.id).sort()).toEqual([
      "current",
      "other-ref",
      "other-repo",
      "other-workspace",
    ]);
  });

  it("sends the exact scope, current generation exclusion and job signal to storage", async () => {
    const deleteByFilter = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;
    await pruneObsoleteCodePoints({ ...input, vectorStore: { deleteByFilter } }, { signal });
    expect(deleteByFilter).toHaveBeenCalledExactlyOnceWith(
      "code",
      {
        must: [
          { field: "workspace_id", match: { eq: "workspace" } },
          { field: "repo_id", match: { eq: "repo" } },
          { field: "ref_id", match: { eq: "repo:main" } },
        ],
        mustNot: [{ field: "generation_id", match: { eq: "current" } }],
      },
      { signal },
    );
  });

  it.each(["workspaceId", "repoId", "refId"] as const)(
    "rejects an empty %s instead of broadening a deletion scope",
    async (key) => {
      const deleteByFilter = vi.fn();
      await expect(
        pruneObsoleteCodePoints({
          ...input,
          target: { ...target, [key]: "" },
          vectorStore: { deleteByFilter },
        }),
      ).rejects.toThrow(RangeError);
      expect(deleteByFilter).not.toHaveBeenCalled();
    },
  );

  it.each(["collection", "generationId"] as const)("rejects an empty %s", async (key) => {
    const deleteByFilter = vi.fn();
    await expect(
      pruneObsoleteCodePoints({ ...input, [key]: " ", vectorStore: { deleteByFilter } }),
    ).rejects.toThrow(RangeError);
    expect(deleteByFilter).not.toHaveBeenCalled();
  });

  it("does not delete when already cancelled", async () => {
    const deleteByFilter = vi.fn();
    await expect(
      pruneObsoleteCodePoints(
        { ...input, vectorStore: { deleteByFilter } },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(deleteByFilter).not.toHaveBeenCalled();
  });

  it("rejects cancellation during deletion even if an adapter returns success", async () => {
    const controller = new AbortController();
    const deleteByFilter = vi.fn().mockImplementation(async () => controller.abort());
    await expect(
      pruneObsoleteCodePoints(
        { ...input, vectorStore: { deleteByFilter } },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it("propagates deletion failure before the caller can publish completion", async () => {
    const error = new Error("delete unavailable");
    const deleteByFilter = vi.fn().mockRejectedValue(error);
    await expect(
      pruneObsoleteCodePoints({ ...input, vectorStore: { deleteByFilter } }),
    ).rejects.toBe(error);
  });
});
