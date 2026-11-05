import { isUntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  assertConfigValid,
  assertEmbeddingDimensionsMatch,
  validateEffectiveConfig,
} from "./validate.js";

describe("validateEffectiveConfig", () => {
  it("warns, but does not error, on an unknown top-level field", () => {
    const { errors, warnings } = validateEffectiveConfig({
      schemaVersion: 1,
      totallyUnknownField: true,
    });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("totallyUnknownField");
  });

  it("does not warn about the $schema hint field", () => {
    const { warnings } = validateEffectiveConfig({
      $schema: "https://untangle.dev/schema/config-v1.json",
      schemaVersion: 1,
    });
    expect(warnings).toEqual([]);
  });

  it("errors on an invalid qdrant.mode enum value", () => {
    const { errors } = validateEffectiveConfig({ qdrant: { mode: "not-a-real-mode" } });
    expect(errors.some((e) => e.path === "qdrant.mode")).toBe(true);
  });

  it("errors on an invalid qualityGate.mode enum value", () => {
    const { errors } = validateEffectiveConfig({ qualityGate: { mode: "sometimes" } });
    expect(errors.some((e) => e.path === "qualityGate.mode")).toBe(true);
  });

  it("accepts a valid enum value without error", () => {
    const { errors } = validateEffectiveConfig({ qdrant: { mode: "managed" } });
    expect(errors).toEqual([]);
  });

  it("accepts a complete profile-bound relevance policy", () => {
    const { errors } = validateEffectiveConfig({
      search: {
        relevancePolicies: {
          "profile-sha256": {
            workspaceId: "workspace-fixture",
            collection: "untangle_fixture_code_profile_v1",
            policy: {
              calibrationId: "qwen/test-corpus/2026-09-05",
              minimumDenseScore: 0.45,
              minimumDenseSpread: 0.075,
              denseReferenceRank: 50,
              minimumCandidateIdfCoverage: 0.3,
            },
          },
        },
      },
    });
    expect(errors).toEqual([]);
  });

  it("rejects incomplete or out-of-range relevance policies", () => {
    const { errors } = validateEffectiveConfig({
      search: {
        relevancePolicies: {
          "profile-sha256": {
            workspaceId: "",
            collection: "",
            policy: {
              calibrationId: "",
              minimumDenseScore: 2,
              minimumDenseSpread: -0.1,
              denseReferenceRank: 1,
              minimumCandidateIdfCoverage: Number.NaN,
            },
          },
        },
      },
    });
    expect(errors.map((error) => error.path)).toEqual([
      "search.relevancePolicies.profile-sha256.workspaceId",
      "search.relevancePolicies.profile-sha256.collection",
      "search.relevancePolicies.profile-sha256.policy.calibrationId",
      "search.relevancePolicies.profile-sha256.policy.minimumDenseScore",
      "search.relevancePolicies.profile-sha256.policy.minimumDenseSpread",
      "search.relevancePolicies.profile-sha256.policy.denseReferenceRank",
      "search.relevancePolicies.profile-sha256.policy.minimumCandidateIdfCoverage",
    ]);
  });

  it("rejects a relevance-policy binding without a nested policy", () => {
    const { errors } = validateEffectiveConfig({
      search: {
        relevancePolicies: {
          "profile-sha256": {
            workspaceId: "workspace-fixture",
            collection: "untangle_fixture_code_profile_v1",
          },
        },
      },
    });

    expect(errors.map((error) => error.path)).toEqual([
      "search.relevancePolicies.profile-sha256.policy",
    ]);
  });

  it("requires qdrant.url when qdrant.mode is external", () => {
    const { errors } = validateEffectiveConfig({ qdrant: { mode: "external" } });
    expect(errors.some((e) => e.path === "qdrant.url")).toBe(true);
  });

  it("errors on non-integer embeddings.dimensions", () => {
    const { errors } = validateEffectiveConfig({ embeddings: { dimensions: 12.5 } });
    expect(errors.some((e) => e.path === "embeddings.dimensions")).toBe(true);
  });

  it("errors on duplicate repository ids", () => {
    const { errors } = validateEffectiveConfig({
      repositories: [
        { id: "backend", path: "." },
        { id: "backend", path: "../other" },
      ],
    });
    expect(errors.some((e) => e.message.includes("duplicate repository id"))).toBe(true);
  });

  it("errors when portfolio.blueprint.weights do not sum to 1.0", () => {
    const { errors } = validateEffectiveConfig({
      portfolio: {
        blueprint: {
          weights: { adoption: 0.5, recency: 0.5, health: 0.5, versionConsistency: 0.5 },
        },
      },
    });
    expect(errors.some((e) => e.path === "portfolio.blueprint.weights")).toBe(true);
  });

  it("accepts portfolio.blueprint.weights within the ±0.001 tolerance", () => {
    const { errors } = validateEffectiveConfig({
      portfolio: {
        blueprint: {
          weights: { adoption: 0.4005, recency: 0.2, health: 0.25, versionConsistency: 0.15 },
        },
      },
    });
    expect(errors.some((e) => e.path === "portfolio.blueprint.weights")).toBe(false);
  });
});

describe("assertConfigValid", () => {
  it("throws an UntangleError with code CONFIG_INVALID when errors are present", () => {
    expect(() =>
      assertConfigValid([{ code: "CONFIG_INVALID", message: "bad", path: "x" }]),
    ).toThrowError();
    try {
      assertConfigValid([{ code: "CONFIG_INVALID", message: "bad", path: "x" }]);
    } catch (error) {
      expect(isUntangleError(error)).toBe(true);
      expect(isUntangleError(error) && error.code).toBe("CONFIG_INVALID");
    }
  });

  it("does not throw when there are no errors", () => {
    expect(() => assertConfigValid([])).not.toThrow();
  });
});

describe("assertEmbeddingDimensionsMatch", () => {
  it("throws EMBEDDING_DIMENSION_MISMATCH when dimensions disagree", () => {
    let caught: unknown;
    try {
      assertEmbeddingDimensionsMatch(768, 1024);
    } catch (error) {
      caught = error;
    }
    expect(isUntangleError(caught) && caught.code).toBe("EMBEDDING_DIMENSION_MISMATCH");
  });

  it("does not throw when there is no existing collection yet", () => {
    expect(() => assertEmbeddingDimensionsMatch(768, undefined)).not.toThrow();
  });

  it("does not throw when dimensions match", () => {
    expect(() => assertEmbeddingDimensionsMatch(768, 768)).not.toThrow();
  });
});
