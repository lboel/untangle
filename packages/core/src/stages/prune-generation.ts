import type { PortCallOptions, VectorStore } from "@untangle-code/domain";

import type { IndexTargetV1 } from "../types.js";

interface PruneGenerationInput {
  vectorStore: Pick<VectorStore, "deleteByFilter">;
  collection: string;
  target: Pick<IndexTargetV1, "workspaceId" | "repoId" | "refId">;
  generationId: string;
}

/** Remove untracked legacy points only after the complete current generation is stored. */
export async function pruneObsoleteCodePoints(
  input: PruneGenerationInput,
  options?: PortCallOptions,
): Promise<void> {
  const { target, generationId, collection } = input;
  const scope = [collection, target.workspaceId, target.repoId, target.refId, generationId];
  if (scope.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new RangeError(
      "Generation pruning requires a nonempty collection, workspace, repo, ref and generation.",
    );
  }
  options?.signal?.throwIfAborted();
  await input.vectorStore.deleteByFilter(
    collection,
    {
      must: [
        { field: "workspace_id", match: { eq: target.workspaceId } },
        { field: "repo_id", match: { eq: target.repoId } },
        { field: "ref_id", match: { eq: target.refId } },
      ],
      mustNot: [{ field: "generation_id", match: { eq: generationId } }],
    },
    options,
  );
  options?.signal?.throwIfAborted();
}
