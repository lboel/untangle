import { ID_COMPONENT_SEPARATOR } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildDedupeKey, dedupeCandidates } from "./dedupe.js";
import type { ScoredCandidate } from "./dedupe.js";
import { candidateFixture, payloadFixture } from "./testing/candidates.js";

function scored(
  overrides: Parameters<typeof candidateFixture>[0],
  baseScore: number,
): ScoredCandidate {
  return { candidate: candidateFixture(overrides), baseScore };
}

describe("buildDedupeKey", () => {
  it("is workspace + repo + ref + metrics scope, joined with U+001F", () => {
    const key = buildDedupeKey(payloadFixture());
    expect(key.split(ID_COMPONENT_SEPARATOR)).toEqual(["ws-1", "repo-a", "ref-main", "sym-1"]);
  });

  it("separates the same symbol on two refs", () => {
    expect(buildDedupeKey(payloadFixture({ ref_id: "ref-a" }))).not.toBe(
      buildDedupeKey(payloadFixture({ ref_id: "ref-b" })),
    );
  });
});

describe("dedupeCandidates", () => {
  it("keeps the best-scoring fragment as primary and attaches the rest", () => {
    const result = dedupeCandidates([
      scored({ chunk_id: "c1", metrics_scope_id: "sym-1" }, 0.4),
      scored({ chunk_id: "c2", metrics_scope_id: "sym-1", start_line: 40 }, 0.9),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.primary.candidate.payload.chunk_id).toBe("c2");
    expect(result[0]?.relatedFragments.map((fragment) => fragment.chunkId)).toEqual(["c1"]);
  });

  it("reports the absorbed candidates so the caller can ledger them", () => {
    const result = dedupeCandidates([
      scored({ chunk_id: "c1", metrics_scope_id: "sym-1" }, 0.9),
      scored({ chunk_id: "c2", metrics_scope_id: "sym-1" }, 0.4),
    ]);
    expect(result[0]?.absorbed.map((entry) => entry.candidate.payload.chunk_id)).toEqual(["c2"]);
  });

  it("breaks a score tie by chunk id codepoints, not by input order", () => {
    const result = dedupeCandidates([
      scored({ chunk_id: "zzz", metrics_scope_id: "sym-1" }, 0.5),
      scored({ chunk_id: "aaa", metrics_scope_id: "sym-1" }, 0.5),
    ]);
    expect(result[0]?.primary.candidate.payload.chunk_id).toBe("aaa");
  });

  it("keeps different scopes apart and preserves the fusion order of the groups", () => {
    const result = dedupeCandidates([
      scored({ chunk_id: "b", metrics_scope_id: "sym-b" }, 0.9),
      scored({ chunk_id: "a", metrics_scope_id: "sym-a" }, 0.8),
    ]);
    expect(result.map((entry) => entry.primary.candidate.payload.chunk_id)).toEqual(["b", "a"]);
  });

  it("carries the pre-dedupe score into the related fragment", () => {
    const result = dedupeCandidates([
      scored({ chunk_id: "c1", metrics_scope_id: "sym-1" }, 0.9),
      scored({ chunk_id: "c2", metrics_scope_id: "sym-1" }, 0.42),
    ]);
    expect(result[0]?.relatedFragments[0]?.score).toBe(0.42);
  });
});
