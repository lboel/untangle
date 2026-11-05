import { describe, expect, it } from "vitest";

import { deepMergeConfig, mergeConfigLayers } from "./merge.js";

describe("deepMergeConfig", () => {
  it("merges nested plain objects key by key", () => {
    const base = { qdrant: { mode: "managed", collectionPrefix: "untangle_" } };
    const override = { qdrant: { mode: "external" } };
    expect(deepMergeConfig(base, override)).toEqual({
      qdrant: { mode: "external", collectionPrefix: "untangle_" },
    });
  });

  it("replaces arrays wholesale instead of concatenating them", () => {
    const base = { index: { extraExtensions: [".ts", ".tsx"] } };
    const override = { index: { extraExtensions: [".proto"] } };
    expect(deepMergeConfig(base, override)).toEqual({ index: { extraExtensions: [".proto"] } });
  });

  it("keeps the base array when override omits the field", () => {
    const base = { index: { extraExtensions: [".ts"] } };
    const override = { index: {} };
    expect(deepMergeConfig(base, override)).toEqual({ index: { extraExtensions: [".ts"] } });
  });

  it("does not let an explicit undefined in override erase a base value", () => {
    const base = { qdrant: { url: "http://base:6333" } };
    const override = { qdrant: { url: undefined } };
    expect(deepMergeConfig(base, override)).toEqual({ qdrant: { url: "http://base:6333" } });
  });

  it("replaces a primitive with another primitive", () => {
    expect(deepMergeConfig({ workspaceId: "a" }, { workspaceId: "b" })).toEqual({
      workspaceId: "b",
    });
  });

  it("replaces a relevance-policy binding atomically instead of inheriting foreign thresholds", () => {
    const lower = {
      search: {
        relevancePolicies: {
          "profile-a": {
            workspaceId: "workspace-a",
            collection: "collection-a",
            policy: {
              calibrationId: "corpus-a",
              minimumDenseScore: 0.45,
              minimumDenseSpread: 0.061,
              denseReferenceRank: 50,
              minimumCandidateIdfCoverage: 0.291,
            },
          },
        },
      },
    };
    const higher = {
      search: {
        relevancePolicies: {
          "profile-a": {
            workspaceId: "workspace-b",
            collection: "collection-b",
          },
        },
      },
    };

    expect(deepMergeConfig(lower, higher)).toEqual(higher);
  });

  it("keeps independent profile bindings while replacing an overridden profile atomically", () => {
    const result = mergeConfigLayers<Record<string, unknown>>([
      {
        search: {
          relevancePolicies: {
            "profile-a": { workspaceId: "a", collection: "a", policy: { calibrationId: "a" } },
            "profile-b": { workspaceId: "b", collection: "b", policy: { calibrationId: "b" } },
          },
        },
      },
      {
        search: {
          relevancePolicies: {
            "profile-a": { workspaceId: "new-a", collection: "new-a" },
          },
        },
      },
    ]);

    expect(result).toEqual({
      search: {
        relevancePolicies: {
          "profile-a": { workspaceId: "new-a", collection: "new-a" },
          "profile-b": { workspaceId: "b", collection: "b", policy: { calibrationId: "b" } },
        },
      },
    });
  });
});

describe("mergeConfigLayers", () => {
  it("applies layers left to right, later layers winning", () => {
    const result = mergeConfigLayers<Record<string, unknown>>([
      { a: 1, b: { x: 1, y: 1 } },
      { b: { x: 2 } },
      { b: { y: 3 }, c: "explicit" },
    ]);
    expect(result).toEqual({ a: 1, b: { x: 2, y: 3 }, c: "explicit" });
  });

  it("array semantics hold across three layers", () => {
    const result = mergeConfigLayers<Record<string, unknown>>([
      { exclude: ["a", "b"] },
      { exclude: ["c"] },
      {},
    ]);
    // Middle layer's array wins over the first; the third layer omits the field entirely.
    expect(result).toEqual({ exclude: ["c"] });
  });
});
