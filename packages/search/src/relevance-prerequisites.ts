import type {
  SearchAbstention,
  SearchRelevanceVerdictV1,
  ToolWarningV1,
} from "@untangle-code/domain";

import {
  RELEVANCE_POLICY_NOT_EVALUATED_WARNING_CODE,
  type RelevancePolicyBindingV1,
} from "./relevance.js";
import type { RetrievalBranch } from "./retrieval.js";

interface RelevancePrerequisiteInput {
  binding: RelevancePolicyBindingV1;
  embeddingProfileId: string;
  workspaceId: string;
  collection: string;
  completedBranches: ReadonlySet<RetrievalBranch>;
  exactSymbolEvidenceAvailable: boolean;
  abstention: SearchAbstention;
}

interface RelevancePrerequisiteFailure {
  detail: string;
  warning: ToolWarningV1;
  verdict: SearchRelevanceVerdictV1;
}

function notEvaluated(
  input: RelevancePrerequisiteInput,
  basis: string,
  detail: string,
  details: Record<string, unknown>,
): RelevancePrerequisiteFailure {
  return {
    detail,
    warning: {
      code: RELEVANCE_POLICY_NOT_EVALUATED_WARNING_CODE,
      message: detail,
      details: {
        status: "not_evaluated",
        basis,
        embeddingProfileId: input.embeddingProfileId,
        ...details,
      },
    },
    verdict: {
      abstention: input.abstention,
      status: "not_evaluated",
      basis,
      calibrationId: input.binding.policy.calibrationId,
    },
  };
}

/** A policy may judge only its calibrated scope and evidence; exact symbols are direct evidence. */
export function relevancePrerequisiteFailure(
  input: RelevancePrerequisiteInput,
): RelevancePrerequisiteFailure | undefined {
  const { binding } = input;
  if (binding.workspaceId !== input.workspaceId || binding.collection !== input.collection) {
    const detail = `relevance policy "${binding.policy.calibrationId}" was not evaluated because its calibrated scope workspace="${binding.workspaceId}", collection="${binding.collection}" does not match the active scope workspace="${input.workspaceId}", collection="${input.collection}"; results were left unchanged`;
    return notEvaluated(input, "policy_scope_mismatch", detail, {
      expectedWorkspaceId: binding.workspaceId,
      actualWorkspaceId: input.workspaceId,
      expectedCollection: binding.collection,
      actualCollection: input.collection,
      policy: binding.policy,
    });
  }
  const unavailableEvidenceBranches = (["dense", "sparse"] as const).filter(
    (branch) => !input.completedBranches.has(branch),
  );
  if (unavailableEvidenceBranches.length === 0 || input.exactSymbolEvidenceAvailable)
    return undefined;
  const detail = `relevance policy "${binding.policy.calibrationId}" was not evaluated because its calibrated evidence requires both dense and sparse retrieval, but the following branches did not run successfully: ${unavailableEvidenceBranches.join(", ")}; results were left unchanged`;
  return notEvaluated(input, "calibrated_evidence_branch_unavailable", detail, {
    collection: input.collection,
    requiredEvidenceBranches: ["dense", "sparse"],
    unavailableEvidenceBranches,
    policy: binding.policy,
  });
}
