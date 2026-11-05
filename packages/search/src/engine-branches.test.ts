import {
  UntangleError,
  validateScoreBreakdown,
  type PortCallOptions,
  type VectorStore,
} from "@untangle-code/domain";
import { textToSparseVector } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { HybridSearchEngine } from "./engine.js";
import { detectRetrievalFailure } from "./findability.js";
import type { RelevancePolicyV1 } from "./relevance.js";
import {
  TEST_COLLECTION,
  TEST_WORKSPACE_ID,
  buildInMemorySearchEngine,
  type ChunkFixture,
} from "./testing/in-memory-index.js";
import type { SearchMode } from "./types.js";

type Branch = "dense" | "sparse" | "symbol";
const FIXTURES: ChunkFixture[] = [
  {
    chunkId: "charge",
    symbolId: "sym-charge",
    symbolName: "charge",
    filePath: "src/charge.ts",
    content: "function charge() { return gateway.send(); }",
  },
  {
    chunkId: "refund",
    symbolId: "sym-refund",
    symbolName: "refund",
    filePath: "src/refund.ts",
    content: "function refund() { return gateway.refund(); }",
  },
];

const IMPOSSIBLE_POLICY: RelevancePolicyV1 = {
  calibrationId: "test/no-ungrounded-abstention",
  minimumDenseScore: 1,
  minimumDenseSpread: 2,
  denseReferenceRank: 2,
  minimumCandidateIdfCoverage: 1,
};

function instrumentStore(
  inner: VectorStore,
  onBranch: (branch: Branch) => void,
  stripFilter = false,
): VectorStore {
  return {
    collectionExists: (name, options) => inner.collectionExists(name, options),
    ensureCollection: (spec, options) => inner.ensureCollection(spec, options),
    ensurePayloadIndexes: (name, indexes, options) =>
      inner.ensurePayloadIndexes(name, indexes, options),
    upsert: (name, points, options) => inner.upsert(name, points, options),
    deleteByFilter: (name, filter, options) => inner.deleteByFilter(name, filter, options),
    retrieve: (name, ids, options) => inner.retrieve(name, ids, options),
    countByFilter: (name, filter, options) => inner.countByFilter(name, filter, options),
    hybridQuery: async (name, query, options) => {
      onBranch(query.dense === undefined ? "sparse" : "dense");
      const forwarded = { ...query };
      if (stripFilter) delete forwarded.filter;
      return inner.hybridQuery(name, forwarded, options);
    },
    scroll: async (name, request, options) => {
      onBranch("symbol");
      const forwarded = { ...request };
      if (stripFilter) delete forwarded.filter;
      return inner.scroll(name, forwarded, options);
    },
  };
}

async function harness(
  options: {
    failures?: readonly Branch[];
    onBranch?: (branch: Branch) => void;
    policy?: RelevancePolicyV1;
    fixtures?: readonly ChunkFixture[];
    stripFilter?: boolean;
    sparse?: boolean;
    branchTimeoutMs?: number;
  } = {},
) {
  const { store, embedder, clock } = await buildInMemorySearchEngine(options.fixtures ?? FIXTURES);
  const calls: Branch[] = [];
  const wrapped = instrumentStore(
    store,
    (branch) => {
      calls.push(branch);
      options.onBranch?.(branch);
      if (options.failures?.includes(branch)) {
        throw new UntangleError("QDRANT_UNAVAILABLE", `${branch} store read failed`, {
          retryable: true,
        });
      }
    },
    options.stripFilter,
  );
  const engine = new HybridSearchEngine({
    vectorStore: wrapped,
    targets: [
      {
        embeddingProfileId: embedder.profileId,
        collection: TEST_COLLECTION,
        repoIds: ["repo-a", "repo-b"],
        embedder,
        indexContexts: [
          {
            repoId: "repo-a",
            refId: "ref-main",
            generationId: "gen-1",
            corpusRevisionFingerprint: "a".repeat(64),
            outcome: "completed",
          },
        ],
      },
    ],
    defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
    clock,
    ...(options.branchTimeoutMs === undefined ? {} : { branchTimeoutMs: options.branchTimeoutMs }),
    ...(options.sparse === false ? {} : { sparseVectorizer: textToSparseVector }),
    ...(options.policy === undefined
      ? {}
      : {
          relevancePolicies: {
            [embedder.profileId]: {
              workspaceId: TEST_WORKSPACE_ID,
              collection: TEST_COLLECTION,
              policy: options.policy,
            },
          },
        }),
  });
  return { engine, embedder, calls, clock };
}

describe("independent retrieval branches", () => {
  it.each([
    ["lexical", ["sparse"]],
    ["symbol", ["symbol"]],
  ] as const)("%s works without calling an unavailable embedder", async (mode, expected) => {
    const { engine, embedder, calls } = await harness();
    const queryEmbedding = vi
      .spyOn(embedder, "embedQuery")
      .mockRejectedValue(new UntangleError("EMBEDDING_UNAVAILABLE", "Ollama is offline"));
    const result = await engine.search({ query: "charge", mode });
    expect(queryEmbedding).not.toHaveBeenCalled();
    expect(calls).toEqual(expected);
    expect(result.groups[0]?.hits[0]?.symbolName).toBe("charge");
    expect(result.groups[0]?.retrieval?.branchCandidateCounts.dense).toBe(0);
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "SEARCH_BRANCH_UNAVAILABLE",
    );
  });

  it("semantic retrieval uses dense alone even if sparse and symbol stores fail", async () => {
    const { engine, calls } = await harness({ failures: ["sparse", "symbol"], sparse: false });
    const result = await engine.search({ query: "charge", mode: "semantic" });
    expect(calls).toEqual(["dense"]);
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.groups[0]?.retrieval?.branchCandidateCounts).toMatchObject({
      sparse: 0,
      symbol: 0,
    });
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "SPARSE_RECALL_UNAVAILABLE",
    );
  });

  it.each(["charge", "Wie wird gateway verwendet?"])(
    "hybrid retains successful lexical and symbol evidence when Ollama fails: %s",
    async (query) => {
      const { engine, embedder, calls } = await harness({ policy: IMPOSSIBLE_POLICY });
      vi.spyOn(embedder, "embedQuery").mockRejectedValue(
        new UntangleError("EMBEDDING_UNAVAILABLE", "Ollama is offline"),
      );
      const result = await engine.search({ query });
      expect(calls.sort()).toEqual(["sparse", "symbol"]);
      expect(result.totalHits).toBeGreaterThan(0);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "SEARCH_BRANCH_UNAVAILABLE",
          details: expect.objectContaining({ branch: "dense", causeCode: "EMBEDDING_UNAVAILABLE" }),
        }),
      );
      expect(result.groups[0]?.retrieval?.branchCandidateCounts.dense).toBe(0);
      expect(result.groups[0]?.caveats.join(" ")).not.toContain(
        "lexical ranking branch did not participate",
      );
      expect(detectRetrievalFailure(result)?.reason).toBe("search_unavailable");
      expect(result.skipped).toContainEqual(
        expect.objectContaining({
          reason: "provider_unavailable",
          subjectKind: "search_candidate",
        }),
      );
      if (query !== "charge") {
        expect(result.groups[0]?.relevanceDecision).toMatchObject({
          status: "not_evaluated",
          basis: "calibrated_evidence_branch_unavailable",
        });
        expect(result.warnings.map((warning) => warning.code)).not.toContain("NO_SUFFICIENT_MATCH");
      }
      for (const hit of result.groups[0]?.hits ?? []) {
        expect(validateScoreBreakdown(hit.score).issues).toEqual([]);
      }
    },
  );

  it.each(["dense", "sparse", "symbol"] as const)(
    "hybrid preserves other store branches when %s fails",
    async (branch) => {
      const { engine, calls } = await harness({ failures: [branch] });
      const result = await engine.search({ query: "charge" });
      expect(calls.sort()).toEqual(["dense", "sparse", "symbol"]);
      expect(result.groups[0]?.hits[0]?.symbolName).toBe("charge");
      expect(result.groups[0]?.retrieval?.branchCandidateCounts[branch]).toBe(0);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "SEARCH_BRANCH_UNAVAILABLE",
          details: expect.objectContaining({ branch, causeCode: "QDRANT_UNAVAILABLE" }),
        }),
      );
      const inputs = result.groups[0]?.hits[0]?.score.inputs;
      if (branch === "dense") expect(inputs?.denseRank).toBeUndefined();
      if (branch === "sparse") expect(inputs?.lexicalRank).toBeUndefined();
      if (branch === "symbol") expect(inputs?.symbolRank).toBeUndefined();
    },
  );

  it("starts sparse and symbol retrieval while the dense embedding is still pending", async () => {
    let releaseEmbedding: (() => void) | undefined;
    const pendingEmbedding = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const observed = new Set<Branch>();
    const { engine, embedder } = await harness({
      onBranch: (branch) => {
        observed.add(branch);
        if (observed.has("sparse") && observed.has("symbol")) releaseEmbedding?.();
      },
    });
    const original = embedder.embedQuery.bind(embedder);
    vi.spyOn(embedder, "embedQuery").mockImplementation(async (...args) => {
      await pendingEmbedding;
      return original(...args);
    });
    const result = await engine.search({ query: "charge" });
    expect(result.totalHits).toBeGreaterThan(0);
    expect(observed.size).toBe(3);
  });

  it.each([true, false])(
    "returns fallback on a dense deadline (adapter observes abort: %s)",
    async (observesAbort) => {
      const { engine, embedder, calls } = await harness({ branchTimeoutMs: 25 });
      let branchSignal: AbortSignal | undefined;
      vi.spyOn(embedder, "embedQuery").mockImplementation((_text, options) => {
        branchSignal = options?.signal;
        return new Promise<number[]>((_resolve, reject) => {
          if (observesAbort) {
            branchSignal?.addEventListener(
              "abort",
              () => reject(new UntangleError("JOB_CANCELLED", "adapter aborted after deadline")),
              { once: true },
            );
          }
        });
      });
      vi.useFakeTimers();
      try {
        const pending = engine.search({ query: "charge" });
        await vi.advanceTimersByTimeAsync(25);
        const result = await pending;
        expect(result.groups[0]?.hits[0]?.symbolName).toBe("charge");
        expect(calls).toEqual(["sparse", "symbol"]);
        expect(branchSignal?.aborted).toBe(true);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "SEARCH_BRANCH_UNAVAILABLE",
              details: expect.objectContaining({ branch: "dense", timedOut: true, timeoutMs: 25 }),
            }),
            expect.objectContaining({ code: "SEARCH_BRANCH_TIMEOUT" }),
          ]),
        );
        expect(detectRetrievalFailure(result)?.reason).toBe("search_unavailable");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["hybrid", "semantic"] as const)(
    "%s propagates outer cancellation even if an adapter hangs",
    async (mode) => {
      const { engine, embedder } = await harness({ branchTimeoutMs: 25 });
      let branchSignal: AbortSignal | undefined;
      vi.spyOn(embedder, "embedQuery").mockImplementation((_text, options) => {
        branchSignal = options?.signal;
        return new Promise<number[]>(() => undefined);
      });
      const controller = new AbortController();
      const reason = new Error("caller cancelled before the branch deadline");
      vi.useFakeTimers();
      try {
        const pending = engine.search({ query: "charge", mode }, { signal: controller.signal });
        const rejection = expect(pending).rejects.toBe(reason);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(reason);
        await rejection;
        expect(branchSignal?.aborted).toBe(true);
        expect(branchSignal?.reason).toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("lets semantic-only coldstart use caller cancellation rather than the hybrid deadline", async () => {
    const { engine, embedder } = await harness({ branchTimeoutMs: 5 });
    const original = embedder.embedQuery.bind(embedder);
    vi.spyOn(embedder, "embedQuery").mockImplementation(
      async (text: string, options?: PortCallOptions) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return original(text, options);
      },
    );
    vi.useFakeTimers();
    try {
      const pending = engine.search({ query: "charge", mode: "semantic" });
      await vi.advanceTimersByTimeAsync(20);
      const result = await pending;
      expect(result.totalHits).toBeGreaterThan(0);
      expect(result.warnings.map((warning) => warning.code)).not.toContain("SEARCH_BRANCH_TIMEOUT");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("separates hybrid budget contexts but leaves unused single-mode budgets comparable", async () => {
    const first = await harness({ branchTimeoutMs: 25 });
    const second = await harness({ branchTimeoutMs: 50 });
    const firstHybrid = await first.engine.search({ query: "charge" });
    const secondHybrid = await second.engine.search({ query: "charge" });
    expect(firstHybrid.rankingContextFingerprint).not.toBe(secondHybrid.rankingContextFingerprint);
    const firstLexical = await first.engine.search({ query: "charge", mode: "lexical" });
    const secondLexical = await second.engine.search({ query: "charge", mode: "lexical" });
    expect(firstLexical.rankingContextFingerprint).toBe(secondLexical.rankingContextFingerprint);
  });

  it("throws an honest provider failure when every hybrid branch fails", async () => {
    const { engine } = await harness({ failures: ["dense", "sparse", "symbol"] });
    await expect(engine.search({ query: "charge" })).rejects.toMatchObject({
      code: "QDRANT_UNAVAILABLE",
      operation: "search",
      retryable: true,
    });
  });

  it("distinguishes a successful empty degraded search from a total retrieval failure", async () => {
    const { engine, embedder } = await harness({ fixtures: [] });
    vi.spyOn(embedder, "embedQuery").mockRejectedValue(new Error("embedding unavailable"));
    const result = await engine.search({ query: "missing" });
    expect(result.groups).toHaveLength(1);
    expect(result.totalHits).toBe(0);
    expect(result.warnings.map((warning) => warning.code)).toContain("SEARCH_BRANCH_UNAVAILABLE");
    expect(result.warnings.map((warning) => warning.code)).not.toContain("NO_SUFFICIENT_MATCH");
  });

  it("lexical fails explicitly when no sparse vectorizer exists", async () => {
    const { engine, embedder, calls } = await harness({ sparse: false });
    const queryEmbedding = vi.spyOn(embedder, "embedQuery");
    await expect(engine.search({ query: "charge", mode: "lexical" })).rejects.toMatchObject({
      code: "INDEX_INCOMPLETE",
    });
    expect(queryEmbedding).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each(["semantic", "lexical"] as const)(
    "%s does not apply a dense-plus-sparse policy to a single-branch search",
    async (mode) => {
      const { engine } = await harness({ policy: IMPOSSIBLE_POLICY });
      const result = await engine.search({ query: "gateway", mode });
      expect(result.totalHits).toBeGreaterThan(0);
      expect(result.groups[0]?.relevanceDecision).toMatchObject({
        status: "not_evaluated",
        basis: "calibrated_evidence_branch_unavailable",
      });
      expect(result.warnings.map((warning) => warning.code)).not.toContain("NO_SUFFICIENT_MATCH");
    },
  );

  it.each(["dense", "sparse"] as const)(
    "hybrid does not abstain on incomplete calibrated evidence when %s failed",
    async (branch) => {
      const { engine } = await harness({ failures: [branch], policy: IMPOSSIBLE_POLICY });
      const result = await engine.search({ query: "gateway" });
      expect(result.totalHits).toBeGreaterThan(0);
      expect(result.groups[0]?.relevanceDecision?.status).toBe("not_evaluated");
      expect(result.warnings.map((warning) => warning.code)).not.toContain("NO_SUFFICIENT_MATCH");
    },
  );

  it("keeps workspace, repository and ref isolation when fallback stores ignore filters", async () => {
    const own = FIXTURES[0] as ChunkFixture;
    const { engine, embedder } = await harness({
      fixtures: [
        own,
        { ...own, chunkId: "foreign-workspace", workspaceId: "ws-foreign" },
        { ...own, chunkId: "foreign-repository", repoId: "repo-b" },
        { ...own, chunkId: "foreign-ref", refId: "ref-other" },
      ],
      stripFilter: true,
    });
    vi.spyOn(embedder, "embedQuery").mockRejectedValue(new Error("Ollama unavailable"));
    const result = await engine.search({
      query: "charge",
      repositories: ["repo-a"],
      refs: ["ref-main"],
    });
    expect(result.groups[0]?.hits.map((hit) => hit.chunkId)).toEqual(["charge"]);
    expect(
      result.skipped.filter((entry) => entry.reason === "excluded_by_configuration"),
    ).toHaveLength(3);
  });

  it.each(["hybrid", "semantic", "lexical", "symbol"] as SearchMode[])(
    "propagates mid-retrieval cancellation in %s mode",
    async (mode) => {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const { engine } = await harness({ onBranch: () => controller.abort(reason) });
      await expect(
        engine.search({ query: "charge", mode }, { signal: controller.signal }),
      ).rejects.toBe(reason);
    },
  );

  it.each([
    new UntangleError("JOB_CANCELLED", "adapter cancelled"),
    Object.assign(new Error("adapter aborted"), { name: "AbortError" }),
  ])("propagates adapter cancellation even without a caller signal: %s", async (error) => {
    const { engine, embedder } = await harness();
    vi.spyOn(embedder, "embedQuery").mockRejectedValue(error);
    await expect(engine.search({ query: "charge" })).rejects.toBe(error);
  });
});
