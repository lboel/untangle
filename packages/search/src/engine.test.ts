import { DEFAULT_SEARCH_CONFIG } from "@untangle-code/config";
import type {
  HybridQueryV1,
  PayloadFilter,
  PortCallOptions,
  ScoredPointV1,
  SearchGraphRelationV1,
  SearchHitV1,
  VectorStore,
} from "@untangle-code/domain";
import {
  INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  UntangleError,
  validateScoreBreakdown,
} from "@untangle-code/domain";
import {
  DeterministicEmbedder,
  InMemoryVectorStore,
  textToSparseVector,
} from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import {
  HybridSearchEngine,
  SEARCH_GRAPH_DIAGNOSTIC_LIMIT,
  SEARCH_GRAPH_PROVIDER_WARNING_LIMIT,
  exactSymbolIntentBranchWeights,
  normalizeExtensions,
  shouldOmitUncorroboratedGermanLexicalBranch,
} from "./engine.js";
import { SEARCH_GRAPH_OMISSION_DETAIL_LIMIT, SEARCH_GRAPH_RELATION_LIMIT } from "./enrichment.js";
import type { SearchGraphEnrichmentPort } from "./port.js";
import { QWEN3_EMBEDDING_06B_RELEVANCE_POLICY } from "./relevance.js";
import type { ChunkFixture } from "./testing/in-memory-index.js";
import {
  TEST_COLLECTION,
  TEST_EMBEDDING_PROFILE_ID,
  TEST_WORKSPACE_ID,
  buildInMemorySearchEngine,
  fixtureToPayload,
  preparedDocumentText,
} from "./testing/in-memory-index.js";
import type { UntangleSearchRequestV1 } from "./types.js";

const FIXTURES: ChunkFixture[] = [
  {
    chunkId: "c-charge",
    filePath: "src/payment/payment-service.ts",
    symbolId: "sym-charge",
    symbolName: "charge",
    symbolFqn: "PaymentService.charge",
    symbolKind: "method",
    signature: "charge(amount: number): Promise<Receipt>",
    cognitive: 22,
    changedAtEpochMs: Date.parse("2025-12-25T00:00:00.000Z"),
    content: "async charge(amount: number) {\n  return this.gateway.send(amount);\n}",
  },
  {
    chunkId: "c-refund",
    filePath: "src/payment/refund-service.ts",
    symbolId: "sym-refund",
    symbolName: "refund",
    symbolFqn: "RefundService.refund",
    symbolKind: "method",
    cognitive: 3,
    content: "async refund(receiptId: string) {\n  return this.gateway.refund(receiptId);\n}",
  },
  {
    chunkId: "c-charge-doc",
    filePath: "docs/charging.md",
    language: "markdown",
    chunkKind: "module",
    content: "# Charging\n\nHow a charge is processed by the payment gateway.",
  },
];

describe("normalizeExtensions", () => {
  it("defaults to hybrid, no content, no complexity bias, relevance sorting", () => {
    expect(normalizeExtensions({ query: "x" })).toEqual({
      mode: "hybrid",
      // Vorgabe ist `strict` — das Verhalten vor Welle 14.
      abstention: "strict",
      pathExcludes: [],
      includeContent: false,
      complexityBias: "none",
      sort: "relevance",
    });
  });

  it("trims, deduplicates and sorts the exclusion patterns", () => {
    expect(
      normalizeExtensions({ query: "x", pathExclude: [" b ", "a", "a", ""] }).pathExcludes,
    ).toEqual(["a", "b"]);
  });
});

describe("exactSymbolIntentBranchWeights", () => {
  it("gives exact-symbol basis enough margin for both boost-clamp extremes", () => {
    const weights = exactSymbolIntentBranchWeights(
      { dense: 1, lexical: 1, symbol: 0.5 },
      { dense: true, lexical: true, symbol: true },
    );
    expect(weights.symbol).toBeGreaterThan(3 * (weights.dense + weights.lexical));
  });
});

describe("shouldOmitUncorroboratedGermanLexicalBranch", () => {
  it("keeps a German lexical top candidate corroborated by dense top 10", () => {
    expect(
      shouldOmitUncorroboratedGermanLexicalBranch(
        "Wo ist die gemessene Ausgangslage dokumentiert?",
        ["d1", "d2", "lexical-top"],
        ["lexical-top", "other"],
      ),
    ).toBe(false);
  });

  it("omits an uncorroborated German lexical top but never an English query", () => {
    const dense = Array.from({ length: 10 }, (_, index) => `dense-${index}`);
    expect(
      shouldOmitUncorroboratedGermanLexicalBranch(
        "Wo wird die kognitive Komplexitaet berechnet?",
        dense,
        ["lexical-noise"],
      ),
    ).toBe(true);
    expect(
      shouldOmitUncorroboratedGermanLexicalBranch(
        "Where is cognitive complexity calculated?",
        dense,
        ["lexical-noise"],
      ),
    ).toBe(false);
  });
});

describe("HybridSearchEngine.search", () => {
  it("finds the symbol by its exact name and explains why it ranks first", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge", limit: 5 });
    const hits = result.groups.flatMap((group) => group.hits);
    expect(hits[0]?.symbolName).toBe("charge");
    const kinds = hits[0]?.score.components.map((component) => component.kind) ?? [];
    expect(kinds).toContain("base_hybrid");
    expect(kinds).toContain("exact_symbol_boost");
  });

  it("uses exact intent in symbol mode even under a competing complexity boost", async () => {
    const { engine } = await buildInMemorySearchEngine([
      {
        chunkId: "exact",
        filePath: "src/exact.ts",
        symbolId: "sym-exact",
        symbolName: "getUser",
        cognitive: 100,
        content: "function getUser() { return database.user; }",
      },
      {
        chunkId: "partial",
        filePath: "src/partial.ts",
        symbolId: "sym-partial",
        symbolName: "getUserById",
        cognitive: 0,
        content: "function getUserById() { return user; }",
      },
    ]);
    const result = await engine.search({
      query: "getUser",
      mode: "symbol",
      complexityBias: "prefer-simple",
      limit: 5,
    });
    expect(result.groups[0]?.hits.map((hit) => hit.chunkId)).toEqual(["exact"]);
    expect(result.groups[0]?.caveats.join(" ")).toContain("exact symbol-name intent");
    const score = result.groups[0]?.hits[0]?.score;
    expect(score).toBeDefined();
    if (score !== undefined) {
      expect(validateScoreBreakdown(score).issues).toEqual([]);
    }
  });

  it("does not let a residual-invalid exact match suppress an eligible near match", async () => {
    const { engine } = await buildInMemorySearchEngine([
      {
        chunkId: "excluded-exact",
        filePath: "excluded/exact.ts",
        symbolId: "sym-exact",
        symbolName: "getUser",
        content: "function getUser() { return user; }",
      },
      {
        chunkId: "allowed-near",
        filePath: "allowed/near.ts",
        symbolId: "sym-near",
        symbolName: "getUserById",
        content: "function getUserById() { return user; }",
      },
    ]);
    const result = await engine.search({
      query: "getUser",
      mode: "hybrid",
      pathExclude: ["excluded/**"],
      minScore: 0.5,
      limit: 5,
    });
    expect(result.groups[0]?.hits.map((hit) => hit.chunkId)).toEqual(["allowed-near"]);
    expect(result.groups[0]?.caveats.join(" ")).not.toContain("exact symbol-name intent");
    expect(result.skipped.filter((entry) => entry.subjectId === "excluded-exact")).toHaveLength(1);
  });

  it("rebuilds dense ranks after residual filtering", async () => {
    const { engine } = await buildInMemorySearchEngine([
      {
        chunkId: "excluded-dense-first",
        filePath: "excluded/first.ts",
        content: "needle needle needle needle",
      },
      {
        chunkId: "allowed-dense-second",
        filePath: "allowed/second.ts",
        content: "needle haystack context",
      },
    ]);
    const result = await engine.search({
      query: "needle",
      mode: "semantic",
      pathExclude: ["excluded/**"],
      limit: 5,
    });
    const hit = result.groups[0]?.hits[0];
    expect(hit?.chunkId).toBe("allowed-dense-second");
    expect(hit?.score.components.find((entry) => entry.kind === "base_hybrid")?.evidence).toContain(
      "dense#1",
    );
    expect(
      result.skipped.filter((entry) => entry.subjectId === "excluded-dense-first"),
    ).toHaveLength(1);
  });

  it("orders equally exact definitions by repo, ref, path and line before opaque ids", async () => {
    const { engine } = await buildInMemorySearchEngine([
      {
        chunkId: "id-6",
        repoId: "repo-b",
        refId: "ref-a",
        filePath: "a.ts",
        symbolId: "sym-6",
        symbolName: "sameName",
        content: "function sameName() { return 6; }",
      },
      {
        chunkId: "id-5",
        repoId: "repo-a",
        refId: "ref-b",
        filePath: "a.ts",
        symbolId: "sym-5",
        symbolName: "sameName",
        content: "function sameName() { return 5; }",
      },
      {
        chunkId: "id-4",
        repoId: "repo-a",
        refId: "ref-a",
        filePath: "z.ts",
        symbolId: "sym-4",
        symbolName: "sameName",
        content: "function sameName() { return 4; }",
      },
      {
        chunkId: "id-3",
        repoId: "repo-a",
        refId: "ref-a",
        filePath: "a.ts",
        startLine: 2,
        symbolId: "sym-3",
        symbolName: "sameName",
        content: "function sameName() { return 3; }",
      },
      {
        chunkId: "zzz-opaque-first",
        repoId: "repo-a",
        refId: "ref-a",
        filePath: "a.ts",
        startLine: 1,
        symbolId: "sym-2",
        symbolName: "sameName",
        content: "function sameName() { return 2; }",
      },
      {
        chunkId: "aaa-opaque-second",
        repoId: "repo-a",
        refId: "ref-a",
        filePath: "a.ts",
        startLine: 1,
        symbolId: "sym-1",
        symbolName: "sameName",
        content: "function sameName() { return 1; }",
      },
    ]);
    const result = await engine.search({ query: "sameName", mode: "symbol", limit: 10 });
    const hits = result.groups.flatMap((group) => group.hits);
    expect(hits.map((hit) => hit.chunkId)).toEqual([
      "aaa-opaque-second",
      "zzz-opaque-first",
      "id-3",
      "id-4",
      "id-5",
      "id-6",
    ]);
    for (const hit of hits) {
      expect(validateScoreBreakdown(hit.score).issues).toEqual([]);
    }
  });

  it("keeps the normalized query and its fingerprint on the result", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge", limit: 2 });
    expect(result.query.workspaceId).toBe(TEST_WORKSPACE_ID);
    expect(result.query.rankerVersion).toBe("untangle-ranker-v2");
    expect(result.queryFingerprint).toHaveLength(64);
  });

  it("publishes the retrieval funnel without changing ranking or the query fingerprint", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const full = await engine.search({ query: "charge", limit: 5, candidateLimit: 20 });
    const limited = await engine.search({ query: "charge", limit: 1, candidateLimit: 20 });
    const diagnostics = limited.groups[0]?.retrieval;

    expect(limited.queryFingerprint).toBe(full.queryFingerprint);
    expect(diagnostics).toMatchObject({
      uniqueRetrievedCandidateCount: 3,
      eligibleCandidateCount: 3,
      rankedCandidateCount: 3,
      deduplicatedCandidateCount: 3,
      qualifiedHitCount: 3,
      returnedHitCount: 1,
      uniqueEligibleFileCount: 3,
      eligibleFileDispersion: 1,
      candidateLimitReached: false,
    });
    expect(diagnostics?.branchCandidateCounts.dense).toBeGreaterThan(0);
    expect(diagnostics?.branchCandidateCounts.sparse).toBeGreaterThan(0);
    expect(diagnostics?.topScoreGap).toBe(full.groups[0]?.retrieval?.topScoreGap);
    expect(diagnostics?.topScoreGap).not.toBeNull();
    expect(limited.rankingContextFingerprint).toHaveLength(64);
    expect(limited.rankingContextFingerprint).toBe(full.rankingContextFingerprint);
    const lexical = await engine.search({
      query: "charge",
      mode: "lexical",
      limit: 1,
      candidateLimit: 20,
    });
    expect(lexical.rankingContextFingerprint).not.toBe(limited.rankingContextFingerprint);
    expect(limited.groups[0]?.hits[0]?.chunkId).toBe(full.groups[0]?.hits[0]?.chunkId);
  });

  it("counts the same file path in different repositories as distinct eligible files", async () => {
    const { engine } = await buildInMemorySearchEngine([
      {
        chunkId: "shared-a",
        repoId: "repo-a",
        refId: "ref-a",
        filePath: "src/shared.ts",
        symbolId: "symbol-a",
        symbolName: "sharedTarget",
        content: "function sharedTarget() { return 'a'; }",
      },
      {
        chunkId: "shared-b",
        repoId: "repo-b",
        refId: "ref-b",
        filePath: "src/shared.ts",
        symbolId: "symbol-b",
        symbolName: "sharedTarget",
        content: "function sharedTarget() { return 'b'; }",
      },
    ]);

    const result = await engine.search({
      query: "sharedTarget",
      mode: "symbol",
      limit: 10,
      candidateLimit: 20,
    });

    expect(result.groups[0]?.retrieval).toMatchObject({
      eligibleCandidateCount: 2,
      uniqueEligibleFileCount: 2,
      uniqueEligibleSymbolCount: 2,
      eligibleFileDispersion: 1,
    });
  });

  it("produces one group per embedding profile and warns about the separation", async () => {
    const { engine: first, store, embedder, clock } = await buildInMemorySearchEngine(FIXTURES);
    void first;
    const second = "untangle_code_other_v1";
    await store.ensureCollection({
      name: second,
      denseDimensions: embedder.profile.dimensions,
      denseDistance: "Cosine",
      sparseBm25: true,
      onDiskPayload: false,
    });
    const otherEmbedder = new DeterministicEmbedder(clock, {
      ...embedder.profile,
      model: "hashed-token-bag-other-profile-v1",
    });
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
        {
          embeddingProfileId: otherEmbedder.profileId,
          collection: second,
          repoIds: ["repo-b"],
          embedder: otherEmbedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
      clock,
      sparseVectorizer: textToSparseVector,
    });
    const result = await engine.search({ query: "charge" });
    expect(result.groups).toHaveLength(2);
    expect(result.profileSeparation).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("PROFILE_SEPARATION");
  });

  it("warns when no sparse vectorizer is wired, instead of quietly losing recall", async () => {
    const { store, embedder } = await buildInMemorySearchEngine(FIXTURES);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
    });
    const result = await engine.search({ query: "charge" });
    expect(result.warnings.map((warning) => warning.code)).toContain("SPARSE_RECALL_UNAVAILABLE");
    expect(result.totalHits).toBeGreaterThan(0);
  });

  it("keeps searching the remaining profiles when one collection fails, and says which", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine(FIXTURES);
    const brokenCollection = "broken_v1";
    const failing: VectorStore = {
      ...store,
      collectionExists: (name, options) => store.collectionExists(name, options),
      ensureCollection: (spec, options) => store.ensureCollection(spec, options),
      ensurePayloadIndexes: (name, indexes, options) =>
        store.ensurePayloadIndexes(name, indexes, options),
      upsert: (name, points, options) => store.upsert(name, points, options),
      deleteByFilter: (name, filter, options) => store.deleteByFilter(name, filter, options),
      retrieve: (name, ids, options) => store.retrieve(name, ids, options),
      scroll: (name, request, options) =>
        name === brokenCollection
          ? Promise.reject(
              new UntangleError("QDRANT_UNAVAILABLE", "collection is offline", { retryable: true }),
            )
          : store.scroll(name, request, options),
      countByFilter: (name, filter, options) => store.countByFilter(name, filter, options),
      hybridQuery: (name, query, options): Promise<ScoredPointV1[]> => {
        if (name === brokenCollection) {
          return Promise.reject(
            new UntangleError("QDRANT_UNAVAILABLE", "collection is offline", { retryable: true }),
          );
        }
        return store.hybridQuery(name, query, options);
      },
    };
    const brokenEmbedder = new DeterministicEmbedder(clock, {
      ...embedder.profile,
      model: "hashed-token-bag-broken-profile-v1",
    });
    const engine = new HybridSearchEngine({
      vectorStore: failing,
      targets: [
        {
          embeddingProfileId: brokenEmbedder.profileId,
          collection: brokenCollection,
          repoIds: ["repo-x"],
          embedder: brokenEmbedder,
        },
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
      clock,
      sparseVectorizer: textToSparseVector,
    });
    const result = await engine.search({ query: "charge" });
    const healthyOnly = new HybridSearchEngine({
      vectorStore: failing,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
      clock,
      sparseVectorizer: textToSparseVector,
    });
    const healthyOnlyResult = await healthyOnly.search({ query: "charge" });
    expect(result.groups).toHaveLength(1);
    expect(result.warnings.map((warning) => warning.code)).toContain("QDRANT_UNAVAILABLE");
    expect(result.skipped.some((entry) => entry.reason === "provider_unavailable")).toBe(true);
    expect(result.rankingContextFingerprint).not.toBe(healthyOnlyResult.rankingContextFingerprint);
  });

  it("records a ledger entry for a point whose payload cannot be read (E4)", async () => {
    const { engine, store } = await buildInMemorySearchEngine(FIXTURES);
    await store.upsert(TEST_COLLECTION, [
      {
        id: "broken-point",
        dense: new Array<number>(64).fill(0.1),
        sparse: textToSparseVector("charge charge charge"),
        // repo_id gehoert dazu, weil der Speicherfilter jetzt auf den
        // Geltungsbereich einschraenkt: ein Punkt ohne repo_id kaeme gar nicht
        // erst zurueck, und dieser Test will den UNLESBAREN Payload pruefen.
        payload: {
          point_type: "code_chunk",
          workspace_id: TEST_WORKSPACE_ID,
          repo_id: "repo-a",
          symbol_name: "charge",
        },
      },
    ]);
    const result = await engine.search({ query: "charge", limit: 5 });
    const entries = result.skipped.filter((skip) => skip.subjectId === "broken-point");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe("missing_index_entry");
    expect(entries[0]?.detail).toContain("missing required field");
  });

  it("ledgers candidates dropped by minScore", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    // Der Maximalscore ist Basis 1.0 plus hoechstens MAX_BOOST_SHARE — 1.6
    // liegt also sicher darueber und filtert garantiert alles weg.
    const result = await engine.search({ query: "charge", limit: 10, minScore: 1.6 });
    expect(result.totalHits).toBe(0);
    expect(
      // WP-188: Der Ledger nennt seit der Verdrahtung der Konfigurationsvorgabe
      // AUSDRUECKLICH, woher der wirksame minScore stammt — sonst suchte man
      // eine Zahl, die man nie angefragt hat, in der eigenen Anfrage.
      result.skipped.some((entry) =>
        entry.detail.includes("below the effective minScore 1.6 (requested)"),
      ),
    ).toBe(true);
  });

  it("ledgers candidates dropped by the limit", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge", limit: 1 });
    expect(result.totalHits).toBe(1);
    expect(result.skipped.some((entry) => entry.detail.includes("below the requested limit"))).toBe(
      true,
    );
  });

  it("ledgers candidates dropped by a path exclusion", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge", pathExclude: ["docs/**"], limit: 10 });
    const hits = result.groups.flatMap((group) => group.hits);
    expect(hits.every((hit) => !hit.filePath.startsWith("docs/"))).toBe(true);
    expect(result.skipped.some((entry) => entry.detail.includes("include/exclude globs"))).toBe(
      true,
    );
  });

  it("returns content only on request, and names the reason when it cannot", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const without = await engine.search({ query: "charge", limit: 1 });
    expect(without.groups[0]?.hits[0]?.content).toBeUndefined();
    const withContent = await engine.search({ query: "charge", limit: 1, includeContent: true });
    expect(withContent.groups[0]?.hits[0]?.content).toContain("charge");

    const { engine: emptyEngine } = await buildInMemorySearchEngine([
      { ...(FIXTURES[0] as ChunkFixture), content: "" },
    ]);
    const omitted = await emptyEngine.search({ query: "charge", limit: 1, includeContent: true });
    expect(omitted.groups[0]?.hits[0]?.contentOmittedReason).toContain("no content");
  });

  it("selects the requested retrieval and ranking branches by mode", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const symbolOnly = await engine.search({ query: "charge", mode: "symbol", limit: 5 });
    const hits = symbolOnly.groups.flatMap((group) => group.hits);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.symbolName !== undefined)).toBe(true);
    for (const hit of hits) {
      expect(hit.score.inputs.symbolRank).toBeDefined();
    }
    const lexical = await engine.search({ query: "gateway", mode: "lexical", limit: 5 });
    expect(lexical.totalHits).toBeGreaterThan(0);
  });

  it("ledgers candidates that no active branch ranked", async () => {
    const { store } = await buildInMemorySearchEngine(FIXTURES);
    // A store that ignores the symbol-name filter can return unrelated
    // candidates. They still need an honest exclusion, even though ordinary
    // symbol-only recall no longer retrieves dense/lexical distractors.
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      vectorStore: {
        ...spyStore(store, {}),
        scroll: async () => ({
          points: await store.retrieve(TEST_COLLECTION, ["c-charge", "c-refund"]),
        }),
      },
    });
    const result = await engine.search({ query: "charge", mode: "symbol", limit: 5 });
    expect(result.skipped.some((entry) => entry.detail.includes("no active ranking branch"))).toBe(
      true,
    );
  });

  it("filters by cognitive complexity — search and complexity are one query layer", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const complex = await engine.search({
      query: "service",
      complexity: { cognitiveMin: 20 },
      limit: 10,
    });
    const hits = complex.groups.flatMap((group) => group.hits);
    expect(hits.map((hit) => hit.symbolName)).toEqual(["charge"]);

    const simple = await engine.search({
      query: "service",
      complexity: { cognitiveMax: 10 },
      limit: 10,
    });
    expect(simple.groups.flatMap((group) => group.hits).map((hit) => hit.symbolName)).toEqual([
      "refund",
    ]);
  });

  it("shows the complexity bias as a visible component instead of moving the rank silently", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const biased = await engine.search({
      query: "service",
      complexityBias: "prefer-simple",
      limit: 10,
    });
    const hit = biased.groups
      .flatMap((group) => group.hits)
      .find((entry) => entry.symbolName === "charge");
    const modifier = hit?.score.components.find(
      (component) => component.kind === "complexity_modifier",
    );
    expect(modifier).toBeDefined();
    expect(modifier?.contribution).toBeLessThan(0);
  });

  it("warns when a findability filter cannot be honoured", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge", findabilityMaxScore: 0.3 });
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "FINDABILITY_FILTER_UNAVAILABLE",
    );
  });

  it("applies the findability filter when a lookup is wired, and attaches the summary", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      findability: (symbolId) =>
        symbolId === "sym-charge"
          ? { score: 0.2, isHeuristic: true, algorithm: "untangle-findability-v1" }
          : { score: 0.9, isHeuristic: true, algorithm: "untangle-findability-v1" },
    });
    const result = await engine.search({ query: "service", findabilityMaxScore: 0.5, limit: 10 });
    const hits = result.groups.flatMap((group) => group.hits);
    expect(hits.map((hit) => hit.symbolName)).toEqual(["charge"]);
    expect(hits[0]?.findability?.score).toBe(0.2);
  });

  it("rejects a contradictory findability range", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    await expect(
      engine.search({ query: "charge", findabilityMinScore: 0.8, findabilityMaxScore: 0.2 }),
    ).rejects.toThrow(/min > max/u);
  });

  it("boosts a prioritized repository visibly", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      repoPriorities: { "repo-a": 1 },
    });
    const result = await engine.search({ query: "charge", limit: 1 });
    const component = result.groups[0]?.hits[0]?.score.components.find(
      (entry) => entry.kind === "repo_priority_boost",
    );
    expect(component?.evidence).toContain("repo-a");
  });

  it("adds a recency component from the stored change timestamp", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge", limit: 1 });
    const component = result.groups[0]?.hits[0]?.score.components.find(
      (entry) => entry.kind === "recency_boost",
    );
    expect(component?.rawValue).toBeGreaterThan(0);
    expect(component?.rawValue).toBeLessThan(1);
  });

  it("warns when one repository contributes hits from several refs", async () => {
    const { engine } = await buildInMemorySearchEngine([
      { ...(FIXTURES[0] as ChunkFixture), chunkId: "c-main", refId: "ref-main", refName: "main" },
      {
        ...(FIXTURES[0] as ChunkFixture),
        chunkId: "c-feature",
        refId: "ref-feature",
        refName: "feature/x",
        symbolId: "sym-charge-feature",
      },
    ]);
    const result = await engine.search({ query: "charge", limit: 10 });
    expect(result.warnings.map((warning) => warning.code)).toContain("MULTIPLE_REFS");
    const refs = result.groups.flatMap((group) => group.hits).map((hit) => hit.refName);
    expect(new Set(refs).size).toBe(2);
  });

  it("keeps cross-repo provenance on every hit", async () => {
    const { engine } = await buildInMemorySearchEngine([
      { ...(FIXTURES[0] as ChunkFixture), chunkId: "a", repoId: "repo-a", repoLabel: "billing" },
      {
        ...(FIXTURES[0] as ChunkFixture),
        chunkId: "b",
        repoId: "repo-b",
        repoLabel: "checkout",
        symbolId: "sym-charge-b",
      },
    ]);
    const result = await engine.search({ query: "charge", limit: 10 });
    const labels = result.groups
      .flatMap((group) => group.hits)
      .map((hit) => hit.repoLabel)
      .sort();
    expect(labels).toEqual(["billing", "checkout"]);
  });

  it("applies the diversification penalty only when the request asks for it", async () => {
    const many: ChunkFixture[] = [0, 1, 2].map((index) => ({
      chunkId: `c-${index}`,
      filePath: "src/payment/payment-service.ts",
      symbolId: `sym-${index}`,
      symbolName: `charge${index}`,
      symbolFqn: `PaymentService.charge${index}`,
      content: `async charge${index}(amount: number) { return this.gateway.send(amount); }`,
    }));
    const { engine } = await buildInMemorySearchEngine(many);
    const plain = await engine.search({ query: "charge", limit: 10 });
    expect(
      plain.groups
        .flatMap((group) => group.hits)
        .some((hit) => hit.score.components.some((c) => c.kind === "duplicate_penalty")),
    ).toBe(false);
    const diversified = await engine.search({ query: "charge", limit: 10, diversify: true });
    expect(
      diversified.groups
        .flatMap((group) => group.hits)
        .some((hit) => hit.score.components.some((c) => c.kind === "duplicate_penalty")),
    ).toBe(true);
  });

  it("carries the caveat when a filter had to be applied in-process", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge", pathGlob: ["src/**"], limit: 5 });
    expect(result.groups[0]?.caveats.join(" ")).toContain("pathGlobs");
  });

  it("reads the generation from the payload", async () => {
    const { engine } = await buildInMemorySearchEngine([
      { ...(FIXTURES[0] as ChunkFixture), generationId: "gen-42" },
    ]);
    const result = await engine.search({ query: "charge", limit: 1 });
    expect(result.groups[0]?.hits[0]?.indexGeneration).toBe("gen-42");
  });

  it("does not project a completed local generation onto a legacy hit without provenance", async () => {
    const fixture = FIXTURES[0] as ChunkFixture;
    const { store, embedder, clock } = await buildInMemorySearchEngine([]);
    const payload = fixtureToPayload(fixture);
    delete payload["generation_id"];
    const prepared = preparedDocumentText(fixture);
    const embedded = await embedder.embedDocuments([prepared]);
    await store.upsert(TEST_COLLECTION, [
      {
        id: fixture.chunkId,
        dense: embedded.vectors[0] as number[],
        sparse: textToSparseVector(prepared),
        payload,
      },
    ]);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
          indexContexts: [
            {
              repoId: "repo-a",
              refId: "ref-main",
              generationId: "completed-generation",
              outcome: "completed",
            },
          ],
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      clock,
      sparseVectorizer: textToSparseVector,
    });

    const result = await engine.search({ query: "charge" });
    expect(result.groups[0]?.hits[0]?.indexGeneration).toBe("unknown");
    expect(result.groups[0]?.indexGenerations).toEqual(["unknown"]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE }),
    );
  });

  it("never treats a display generation fallback as persisted candidate provenance", async () => {
    const fixture = FIXTURES[0] as ChunkFixture;
    const { store, embedder, clock } = await buildInMemorySearchEngine([]);
    const payload = fixtureToPayload(fixture);
    delete payload["generation_id"];
    const prepared = preparedDocumentText(fixture);
    const embedded = await embedder.embedDocuments([prepared]);
    await store.upsert(TEST_COLLECTION, [
      {
        id: fixture.chunkId,
        dense: embedded.vectors[0] as number[],
        sparse: textToSparseVector(prepared),
        payload,
      },
    ]);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
          indexContexts: [
            {
              repoId: "repo-a",
              refId: "ref-main",
              generationId: "completed-generation",
              corpusRevisionFingerprint: "a".repeat(64),
              outcome: "completed",
            },
          ],
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      clock,
      sparseVectorizer: textToSparseVector,
      indexGeneration: "completed-generation",
    });

    const result = await engine.search({ query: "charge" });
    // The legacy fallback stays visible for display compatibility, but it is
    // not evidence that this stored candidate came from that generation.
    expect(result.groups[0]?.hits[0]?.indexGeneration).toBe("completed-generation");
    expect(result.groups[0]?.indexGenerations).toEqual(["completed-generation"]);
    expect(result.groups[0]?.corpusRevisionFingerprint).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE }),
    );
  });

  it("honours an abort signal", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const controller = new AbortController();
    controller.abort();
    const options: PortCallOptions = { signal: controller.signal };
    await expect(engine.search({ query: "charge" }, options)).rejects.toThrow();
  });

  it("keeps every produced breakdown valid under the domain rules", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      repoPriorities: { "repo-a": 1 },
    });
    const result = await engine.search({
      query: "charge",
      limit: 10,
      diversify: true,
      complexityBias: "prefer-simple",
    });
    for (const hit of result.groups.flatMap((group) => group.hits)) {
      expect(validateScoreBreakdown(hit.score).issues).toEqual([]);
    }
  });

  it("searches an empty index without pretending anything was found", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine([]);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
          indexContexts: [
            {
              repoId: "repo-a",
              refId: "ref-main",
              generationId: "known-empty-generation",
              corpusRevisionFingerprint: "a".repeat(64),
              outcome: "completed",
            },
          ],
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      clock,
      sparseVectorizer: textToSparseVector,
    });
    const result = await engine.search({ query: "charge" });
    expect(result.totalHits).toBe(0);
    expect(result.groups[0]?.hits).toEqual([]);
    expect(result.groups[0]?.indexGenerations).toEqual(["known-empty-generation"]);
    expect(result.groups[0]?.corpusRevisionFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE }),
    );
  });

  it("constrains an omitted ref scope to locally recorded refs before querying the store", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine([
      {
        chunkId: "current-target",
        repoId: "repo-a",
        refId: "repo-a:main",
        generationId: "generation-main",
        filePath: "src/current.ts",
        symbolId: "symbol-current",
        symbolName: "currentTarget",
        content: "function currentTarget() { return 'current'; }",
      },
      {
        chunkId: "unrecorded-old-target",
        repoId: "repo-a",
        refId: "repo-a:old",
        generationId: "generation-old",
        filePath: "src/old.ts",
        symbolId: "symbol-old",
        symbolName: "oldTarget",
        content: "function oldTarget() { return 'old'; }",
      },
    ]);
    const observedFilters: Array<PayloadFilter | undefined> = [];
    const engine = new HybridSearchEngine({
      vectorStore: spyStore(store, {
        onQuery: (filter) => observedFilters.push(filter),
        stripFilter: true,
      }),
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
          indexContexts: [
            {
              repoId: "repo-a",
              refId: "repo-a:main",
              generationId: "generation-main",
              corpusRevisionFingerprint: "a".repeat(64),
              outcome: "completed",
            },
          ],
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      clock,
      sparseVectorizer: textToSparseVector,
    });

    const result = await engine.search({ query: "oldTarget", mode: "symbol" });

    expect(observedFilters.length).toBeGreaterThan(0);
    for (const filter of observedFilters) {
      expect(filter?.must).toContainEqual({
        field: "ref_id",
        match: { eq: "repo-a:main" },
      });
    }
    expect(result.groups.flatMap((group) => group.hits.map((hit) => hit.refId))).not.toContain(
      "repo-a:old",
    );
    expect(
      result.skipped.some(
        (entry) =>
          entry.subjectId === "unrecorded-old-target" &&
          entry.detail.includes("not one of the effective refs"),
      ),
    ).toBe(true);
    expect(result.groups[0]?.caveats.join(" ")).toContain("locally recorded refs");
    expect(result.groups[0]?.corpusRevisionFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE }),
    );
  });

  it("validates explicit multi-repo refs as real pairs instead of a Cartesian product", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine([
      {
        chunkId: "target-a",
        repoId: "repo-a",
        refId: "repo-a:main",
        generationId: "generation-a",
        filePath: "src/a.ts",
        symbolId: "symbol-a",
        symbolName: "sharedProbe",
        content: "function sharedProbe() { return 'a'; }",
      },
      {
        chunkId: "target-b",
        repoId: "repo-b",
        refId: "repo-b:release",
        generationId: "generation-b",
        filePath: "src/b.ts",
        symbolId: "symbol-b",
        symbolName: "sharedProbe",
        content: "function sharedProbe() { return 'b'; }",
      },
    ]);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a", "repo-b"],
          embedder,
          indexContexts: [
            {
              repoId: "repo-a",
              refId: "repo-a:main",
              generationId: "generation-a",
              corpusRevisionFingerprint: "a".repeat(64),
              outcome: "completed",
            },
            {
              repoId: "repo-b",
              refId: "repo-b:release",
              generationId: "generation-b",
              corpusRevisionFingerprint: "b".repeat(64),
              outcome: "completed",
            },
          ],
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      clock,
      sparseVectorizer: textToSparseVector,
    });

    const result = await engine.search({
      query: "sharedProbe",
      mode: "symbol",
      repositories: ["repo-a", "repo-b"],
      refs: ["repo-a:main", "repo-b:release"],
    });

    expect(result.groups[0]?.hits.map((hit) => `${hit.repoId}/${hit.refId}`)).toEqual([
      "repo-a/repo-a:main",
      "repo-b/repo-b:release",
    ]);
    expect(result.groups[0]?.corpusRevisionFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE }),
    );
  });

  it("separates corpus revisions even when an incremental generation id is reused", async () => {
    const searchRevision = async (corpusRevisionFingerprint: string): Promise<string> => {
      const { store, embedder, clock } = await buildInMemorySearchEngine([]);
      const engine = new HybridSearchEngine({
        vectorStore: store,
        targets: [
          {
            embeddingProfileId: embedder.profileId,
            collection: TEST_COLLECTION,
            repoIds: ["repo-a"],
            embedder,
            indexContexts: [
              {
                repoId: "repo-a",
                refId: "ref-main",
                generationId: "resumed-generation",
                corpusRevisionFingerprint,
                outcome: "completed",
              },
            ],
          },
        ],
        defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
        clock,
        sparseVectorizer: textToSparseVector,
      });
      const result = await engine.search({ query: "same request" });
      const fingerprint = result.groups[0]?.corpusRevisionFingerprint;
      if (fingerprint === undefined) throw new Error("expected comparable corpus revision");
      return fingerprint;
    };

    await expect(searchRevision("a".repeat(64))).resolves.not.toBe(
      await searchRevision("b".repeat(64)),
    );
  });

  it("keeps hits from a cancelled generation usable but marks their index context incomplete", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine([
      { ...(FIXTURES[0] as ChunkFixture), generationId: "cancelled-generation" },
    ]);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
          indexContexts: [
            {
              repoId: "repo-a",
              refId: "ref-main",
              generationId: "cancelled-generation",
              outcome: "cancelled",
            },
          ],
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      clock,
      sparseVectorizer: textToSparseVector,
    });

    const result = await engine.search({ query: "charge" });
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.groups[0]?.hits[0]?.indexGeneration).toBe("cancelled-generation");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE }),
    );
  });

  it.each(["failed", "running"] as const)(
    "marks a no-hit search against a %s generation as incomplete",
    async (outcome) => {
      const { store, embedder, clock } = await buildInMemorySearchEngine([]);
      const generationId = `generation-${outcome}`;
      const engine = new HybridSearchEngine({
        vectorStore: store,
        targets: [
          {
            embeddingProfileId: embedder.profileId,
            collection: TEST_COLLECTION,
            repoIds: ["repo-a"],
            embedder,
            indexContexts: [
              {
                repoId: "repo-a",
                refId: "ref-main",
                generationId,
                outcome,
              },
            ],
          },
        ],
        defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
        clock,
        sparseVectorizer: textToSparseVector,
      });

      const result = await engine.search({ query: "target absent from partial generation" });
      expect(result.totalHits).toBe(0);
      expect(result.groups[0]?.indexGenerations).toEqual([generationId]);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE }),
      );
    },
  );

  it("suppresses an insufficient result set and explains the absence decision", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: {
        [TEST_EMBEDDING_PROFILE_ID]: {
          workspaceId: TEST_WORKSPACE_ID,
          collection: TEST_COLLECTION,
          policy: {
            ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
            calibrationId: "test/force-abstention",
            minimumDenseScore: 1,
            minimumDenseSpread: 2,
            denseReferenceRank: 2,
            minimumCandidateIdfCoverage: 1,
          },
        },
      },
    });
    const result = await engine.search({
      query: "blockchain transaction signature verification",
      limit: 10,
    });
    expect(result.totalHits).toBe(0);
    expect(result.groups[0]?.indexGenerations).toEqual(["gen-1"]);
    const warning = result.warnings.find((entry) => entry.code === "NO_SUFFICIENT_MATCH");
    expect(warning?.message).toContain("No sufficiently relevant result");
    expect(warning?.details).toMatchObject({ basis: "insufficient_evidence" });
    // Der Grund ist eigenstaendig: eine Enthaltung ist kein Ausschluss durch
    // Konfiguration, und nur getrennte Gruende lassen sie von einem
    // Score-Schwellwert unterscheiden (E4).
    expect(result.skipped.some((entry) => entry.reason === "relevance_policy_rejected")).toBe(true);
    expect(
      result.skipped.some(
        (entry) =>
          entry.reason === "excluded_by_configuration" && entry.detail.includes("relevance policy"),
      ),
    ).toBe(false);
  });

  it("keeps calibrated relevance evidence fixed for default, 50, 80 and 200 candidates", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine(FIXTURES);
    const makePoint = (branch: "dense" | "sparse", index: number): ScoredPointV1 => {
      const suffix = index.toString().padStart(3, "0");
      const id = `${branch}-${suffix}`;
      const content = index < 50 ? "configuration settings" : "blockchain configuration validation";
      const score = 0.8 - index * 0.002;
      return {
        id,
        score,
        ...(branch === "dense" ? { denseScore: score } : {}),
        payload: fixtureToPayload({
          chunkId: id,
          filePath: `src/${id}.ts`,
          content,
        }),
      };
    };
    const densePoints = Array.from({ length: 200 }, (_, index) => makePoint("dense", index));
    const sparsePoints = Array.from({ length: 200 }, (_, index) => makePoint("sparse", index));
    const scriptedStore = spyStore(store, {
      queryResult: (query) => {
        const source = query.dense === undefined ? sparsePoints : densePoints;
        return source.slice(0, query.limit);
      },
    });
    const engine = new HybridSearchEngine({
      vectorStore: scriptedStore,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
      searchConfig: DEFAULT_SEARCH_CONFIG,
      clock,
      sparseVectorizer: textToSparseVector,
      relevancePolicies: {
        [embedder.profileId]: {
          workspaceId: TEST_WORKSPACE_ID,
          collection: TEST_COLLECTION,
          policy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        },
      },
    });

    const evidence = [];
    for (const candidateLimit of [undefined, 50, 80, 200] as const) {
      const result = await engine.search({
        query: "blockchain configuration validation",
        ...(candidateLimit === undefined ? {} : { candidateLimit }),
      });
      expect(result.query.candidateLimit).toBe(candidateLimit ?? 50);
      expect(result.totalHits).toBe(0);
      const warning = result.warnings.find((entry) => entry.code === "NO_SUFFICIENT_MATCH");
      expect(warning?.details).toMatchObject({
        status: "rejected",
        denseScoresObserved: 50,
        denseReferenceRankObserved: 50,
        candidateEvidenceCount: 100,
      });
      evidence.push({
        topDenseScore: warning?.details?.["topDenseScore"],
        denseReferenceScore: warning?.details?.["denseReferenceScore"],
        denseSpread: warning?.details?.["denseSpread"],
        candidateIdfCoverage: warning?.details?.["candidateIdfCoverage"],
        queryTerms: warning?.details?.["queryTerms"],
      });
    }
    expect(evidence.slice(1)).toEqual([evidence[0], evidence[0], evidence[0]]);

    const repeated = await engine.search({
      query: "blockchain configuration validation",
      candidateLimit: 200,
    });
    const repeatedWarning = repeated.warnings.find((entry) => entry.code === "NO_SUFFICIENT_MATCH");
    expect({
      topDenseScore: repeatedWarning?.details?.["topDenseScore"],
      denseReferenceScore: repeatedWarning?.details?.["denseReferenceScore"],
      denseSpread: repeatedWarning?.details?.["denseSpread"],
      candidateIdfCoverage: repeatedWarning?.details?.["candidateIdfCoverage"],
      queryTerms: repeatedWarning?.details?.["queryTerms"],
    }).toEqual(evidence[0]);

    const tooShallow = await engine.search({
      query: "blockchain configuration validation",
      candidateLimit: 49,
    });
    expect(tooShallow.totalHits).toBeGreaterThan(0);
    expect(
      tooShallow.warnings.find((entry) => entry.code === "RELEVANCE_POLICY_NOT_EVALUATED")?.details,
    ).toMatchObject({
      status: "not_evaluated",
      basis: "dense_reference_unavailable",
      denseScoresObserved: 49,
      deepestDenseRankObserved: 49,
    });

    const residualPrefixHole = await engine.search({
      query: "blockchain configuration validation",
      candidateLimit: 200,
      pathExclude: ["src/dense-010.ts"],
    });
    expect(residualPrefixHole.totalHits).toBeGreaterThan(0);
    expect(
      residualPrefixHole.warnings.find((entry) => entry.code === "RELEVANCE_POLICY_NOT_EVALUATED")
        ?.details,
    ).toMatchObject({
      status: "not_evaluated",
      basis: "dense_reference_unavailable",
      denseScoresObserved: 49,
      deepestDenseRankObserved: 49,
    });
  });

  it("honours relevance policies supplied only through SearchConfig", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      searchConfig: {
        ...DEFAULT_SEARCH_CONFIG,
        relevancePolicies: {
          [TEST_EMBEDDING_PROFILE_ID]: {
            workspaceId: TEST_WORKSPACE_ID,
            collection: TEST_COLLECTION,
            policy: {
              ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
              calibrationId: "test/search-config-source",
              minimumDenseScore: 1,
              minimumDenseSpread: 2,
              denseReferenceRank: 2,
              minimumCandidateIdfCoverage: 1,
            },
          },
        },
      },
    });
    const result = await engine.search({
      query: "blockchain transaction signature verification",
      limit: 10,
    });
    expect(result.totalHits).toBe(0);
    expect(result.warnings.map((entry) => entry.code)).toContain("NO_SUFFICIENT_MATCH");
  });

  it("preserves results but warns when configured policies omit the active profile", async () => {
    const strict = {
      workspaceId: TEST_WORKSPACE_ID,
      collection: TEST_COLLECTION,
      policy: {
        ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        calibrationId: "test/wrong-profile",
        minimumDenseScore: 1,
        minimumDenseSpread: 2,
        denseReferenceRank: 2,
        minimumCandidateIdfCoverage: 1,
      },
    };
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: {
        "z-other-embedding-profile": strict,
        "a-other-embedding-profile": strict,
      },
    });
    const result = await engine.search({
      query: "blockchain transaction signature verification",
      limit: 10,
    });
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.warnings.map((entry) => entry.code)).not.toContain("NO_SUFFICIENT_MATCH");
    const warning = result.warnings.find(
      (entry) => entry.code === "RELEVANCE_POLICY_NOT_EVALUATED",
    );
    expect(warning?.details).toEqual({
      status: "not_evaluated",
      basis: "policy_profile_mismatch",
      actualEmbeddingProfileId: TEST_EMBEDDING_PROFILE_ID,
      configuredEmbeddingProfileIds: ["a-other-embedding-profile", "z-other-embedding-profile"],
    });
  });

  it("preserves silent legacy behavior when the relevance-policy map is empty", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: {},
    });
    const result = await engine.search({ query: "charge", limit: 3 });
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.warnings.map((entry) => entry.code)).not.toContain(
      "RELEVANCE_POLICY_NOT_EVALUATED",
    );
  });

  it("fails fast when a target claims a profile other than its embedder actually uses", async () => {
    const { store, embedder } = await buildInMemorySearchEngine(FIXTURES);
    expect(
      () =>
        new HybridSearchEngine({
          vectorStore: store,
          targets: [
            {
              embeddingProfileId: "claimed-profile-p1",
              collection: TEST_COLLECTION,
              repoIds: ["repo-a"],
              embedder,
            },
          ],
          defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
          relevancePolicies: {
            "claimed-profile-p1": {
              workspaceId: TEST_WORKSPACE_ID,
              collection: TEST_COLLECTION,
              policy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
            },
          },
        }),
    ).toThrow(
      `search target embeddingProfileId "claimed-profile-p1" does not match its embedder.profileId "${embedder.profileId}"`,
    );
  });

  it("fails fast when one embedding profile is configured as more than one target", async () => {
    const { store, embedder } = await buildInMemorySearchEngine(FIXTURES);
    expect(
      () =>
        new HybridSearchEngine({
          vectorStore: store,
          targets: [
            {
              embeddingProfileId: embedder.profileId,
              collection: TEST_COLLECTION,
              repoIds: ["repo-a"],
              embedder,
            },
            {
              embeddingProfileId: embedder.profileId,
              collection: "another-collection",
              repoIds: ["repo-b"],
              embedder,
            },
          ],
          defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
        }),
    ).toThrow(
      `search target embeddingProfileId "${embedder.profileId}" is configured more than once`,
    );
  });

  it("reports a missing policy binding only for the unmatched target in a multi-profile search", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine(FIXTURES);
    const secondCollection = "untangle_code_unmatched_policy_v1";
    await store.ensureCollection({
      name: secondCollection,
      denseDimensions: embedder.profile.dimensions,
      denseDistance: "Cosine",
      sparseBm25: true,
      onDiskPayload: false,
    });
    const otherEmbedder = new DeterministicEmbedder(clock, {
      ...embedder.profile,
      model: "hashed-token-bag-unmatched-policy-v1",
    });
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
        {
          embeddingProfileId: otherEmbedder.profileId,
          collection: secondCollection,
          repoIds: ["repo-b"],
          embedder: otherEmbedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
      clock,
      sparseVectorizer: textToSparseVector,
      relevancePolicies: {
        [embedder.profileId]: {
          workspaceId: TEST_WORKSPACE_ID,
          collection: TEST_COLLECTION,
          policy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        },
      },
    });

    const result = await engine.search({ query: "charge" });
    const warnings = result.warnings.filter(
      (entry) => entry.code === "RELEVANCE_POLICY_NOT_EVALUATED",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.details).toMatchObject({
      status: "not_evaluated",
      basis: "policy_profile_mismatch",
      actualEmbeddingProfileId: otherEmbedder.profileId,
      configuredEmbeddingProfileIds: [embedder.profileId],
    });
  });

  it("does not abstain when the fixed dense reference rank was not observed", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: {
        [TEST_EMBEDDING_PROFILE_ID]: {
          workspaceId: TEST_WORKSPACE_ID,
          collection: TEST_COLLECTION,
          policy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        },
      },
    });
    const result = await engine.search({
      query: "blockchain transaction signature verification",
      candidateLimit: 2,
      limit: 2,
    });
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.warnings.map((entry) => entry.code)).toContain("RELEVANCE_POLICY_NOT_EVALUATED");
    expect(result.warnings.map((entry) => entry.code)).not.toContain("NO_SUFFICIENT_MATCH");
    const warning = result.warnings.find(
      (entry) => entry.code === "RELEVANCE_POLICY_NOT_EVALUATED",
    );
    expect(warning?.details).toMatchObject({
      status: "not_evaluated",
      basis: "dense_reference_unavailable",
      deepestDenseRankObserved: 2,
    });
    expect(warning?.details?.["denseReferenceRankObserved"]).toBeUndefined();
  });

  it("leaves results unchanged and warns when workspace or collection binding mismatches", async () => {
    for (const binding of [
      { workspaceId: "other-workspace", collection: TEST_COLLECTION },
      { workspaceId: TEST_WORKSPACE_ID, collection: "other-collection" },
    ]) {
      const { engine } = await buildInMemorySearchEngine(FIXTURES, {
        relevancePolicies: {
          [TEST_EMBEDDING_PROFILE_ID]: {
            ...binding,
            policy: {
              ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
              calibrationId: "test/scope-mismatch",
              denseReferenceRank: 2,
              minimumDenseScore: 1,
              minimumDenseSpread: 2,
              minimumCandidateIdfCoverage: 1,
            },
          },
        },
      });
      const result = await engine.search({
        query: "blockchain transaction signature verification",
        limit: 3,
      });
      expect(result.totalHits).toBeGreaterThan(0);
      expect(result.warnings.map((entry) => entry.code)).toContain(
        "RELEVANCE_POLICY_NOT_EVALUATED",
      );
      expect(result.warnings.map((entry) => entry.code)).not.toContain("NO_SUFFICIENT_MATCH");
      expect(
        result.warnings.find((entry) => entry.code === "RELEVANCE_POLICY_NOT_EVALUATED")?.details,
      ).toMatchObject({ status: "not_evaluated", basis: "policy_scope_mismatch" });
    }
  });

  it("lets an exact symbol through even under deliberately impossible dense thresholds", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: {
        [TEST_EMBEDDING_PROFILE_ID]: {
          workspaceId: TEST_WORKSPACE_ID,
          collection: TEST_COLLECTION,
          policy: {
            ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
            calibrationId: "test/exact-symbol-bypass",
            minimumDenseScore: 1,
            minimumDenseSpread: 2,
            minimumCandidateIdfCoverage: 1,
          },
        },
      },
    });
    const result = await engine.search({ query: "charge", limit: 5 });
    expect(result.groups.flatMap((group) => group.hits)[0]?.symbolName).toBe("charge");
    expect(result.warnings.map((entry) => entry.code)).not.toContain("NO_SUFFICIENT_MATCH");
  });

  it("does not apply dense-plus-sparse calibration to a dense-only engine, except for exact symbols", async () => {
    const { store, embedder, clock } = await buildInMemorySearchEngine(FIXTURES);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 5, candidateLimit: 20 },
      clock,
      relevancePolicies: {
        [embedder.profileId]: {
          workspaceId: TEST_WORKSPACE_ID,
          collection: TEST_COLLECTION,
          policy: {
            ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
            calibrationId: "test/dense-plus-sparse-required",
            denseReferenceRank: 2,
            minimumDenseScore: 1,
            minimumDenseSpread: 2,
            minimumCandidateIdfCoverage: 1,
          },
        },
      },
    });

    const prose = await engine.search({
      query: "blockchain transaction signature verification",
      limit: 3,
    });
    expect(prose.totalHits).toBeGreaterThan(0);
    expect(prose.warnings.map((entry) => entry.code)).not.toContain("NO_SUFFICIENT_MATCH");
    expect(
      prose.warnings.find((entry) => entry.code === "RELEVANCE_POLICY_NOT_EVALUATED")?.details,
    ).toMatchObject({
      status: "not_evaluated",
      basis: "calibrated_evidence_branch_unavailable",
      requiredEvidenceBranches: ["dense", "sparse"],
      unavailableEvidenceBranches: ["sparse"],
    });

    const exact = await engine.search({ query: "charge", mode: "symbol", limit: 3 });
    expect(exact.groups.flatMap((group) => group.hits)[0]?.symbolName).toBe("charge");
    expect(exact.warnings.map((entry) => entry.code)).not.toContain("NO_SUFFICIENT_MATCH");
    expect(exact.warnings.map((entry) => entry.code)).not.toContain(
      "RELEVANCE_POLICY_NOT_EVALUATED",
    );
  });

  it("retains a German lexical branch when dense top 10 corroborates its top candidate", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const hybrid = await engine.search({ query: "Wie wird eine charge ausgefuehrt?", limit: 5 });
    expect(hybrid.groups[0]?.caveats.join(" ")).not.toContain(
      "lexical ranking branch did not participate",
    );
    const hybridEvidence =
      hybrid.groups[0]?.hits[0]?.score.components.find((entry) => entry.kind === "base_hybrid")
        ?.evidence ?? "";
    expect(hybridEvidence).toContain("lexical#");

    const lexical = await engine.search({
      query: "Wie wird eine charge ausgefuehrt?",
      mode: "lexical",
      limit: 5,
    });
    expect(lexical.groups[0]?.caveats.join(" ")).not.toContain(
      "lexical ranking branch did not participate",
    );
    const lexicalEvidence =
      lexical.groups[0]?.hits[0]?.score.components.find((entry) => entry.kind === "base_hybrid")
        ?.evidence ?? "";
    expect(lexicalEvidence).toContain("lexical#");
  });
});

describe("HybridSearchEngine.grep", () => {
  it("searches every configured collection", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.grep({ pattern: "gateway" });
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it("passes an in-memory store through the same port", async () => {
    const store = new InMemoryVectorStore();
    expect(await store.collectionExists(TEST_COLLECTION)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regressionen aus der adversarialen Pruefung (Welle 3)
// ---------------------------------------------------------------------------

/**
 * Ein Speicher, der jeden Aufruf durchreicht und dabei beobachtet werden kann.
 * Explizit getippt statt per Spread: ein `as unknown as VectorStore` wuerde
 * genau die Fehler verstecken, die dieser Test finden soll.
 */
function spyStore(
  inner: VectorStore,
  hooks: {
    onQuery?: (filter: PayloadFilter | undefined, limit: number | undefined) => void;
    queryResult?: (query: HybridQueryV1) => ScoredPointV1[];
    stripFilter?: boolean;
  },
): VectorStore {
  const strip = hooks.stripFilter === true;
  return {
    collectionExists: (name, options) => inner.collectionExists(name, options),
    ensureCollection: (spec, options) => inner.ensureCollection(spec, options),
    ensurePayloadIndexes: (collection, indexes, options) =>
      inner.ensurePayloadIndexes(collection, indexes, options),
    upsert: (collection, points, options) => inner.upsert(collection, points, options),
    deleteByFilter: (collection, filter, options) =>
      inner.deleteByFilter(collection, filter, options),
    retrieve: (collection, ids, options) => inner.retrieve(collection, ids, options),
    countByFilter: (collection, filter, options) =>
      inner.countByFilter(collection, filter, options),
    hybridQuery: (collection, query, options) => {
      hooks.onQuery?.(query.filter, query.limit);
      if (hooks.queryResult !== undefined) {
        return Promise.resolve(hooks.queryResult(query));
      }
      const forwarded: typeof query = strip ? { ...query } : query;
      if (strip) {
        delete forwarded.filter;
      }
      return inner.hybridQuery(collection, forwarded, options);
    },
    scroll: (collection, request, options) => {
      hooks.onQuery?.(request.filter, request.limit);
      const forwarded: typeof request = strip ? { ...request } : request;
      if (strip) {
        delete forwarded.filter;
      }
      return inner.scroll(collection, forwarded, options);
    },
  };
}

describe("HybridSearchEngine: Geltungsbereich (workspace, repositories)", () => {
  const SCOPE_FIXTURES: ChunkFixture[] = [
    {
      chunkId: "c-own",
      repoId: "repo-a",
      filePath: "src/pay.ts",
      symbolId: "sym-own",
      symbolName: "charge",
      generationId: "own-generation",
      content: "async charge(amount: number) {\n  return this.gateway.send(amount);\n}",
    },
    {
      chunkId: "c-foreign",
      repoId: "repo-secret",
      workspaceId: "ws-someone-else",
      filePath: "secret/pay.ts",
      symbolId: "sym-foreign",
      symbolName: "charge",
      generationId: "foreign-generation",
      content: "async charge(amount: number) {\n  return this.gateway.send(amount);\n}",
    },
  ];

  it("liefert NIE einen Treffer aus einem fremden Workspace (Datenisolation)", async () => {
    const { engine } = await buildInMemorySearchEngine(SCOPE_FIXTURES);
    const result = await engine.search({ query: "charge", workspaceId: TEST_WORKSPACE_ID });
    const chunkIds = result.groups.flatMap((group) => group.hits.map((hit) => hit.chunkId));
    expect(chunkIds).toEqual(["c-own"]);
    expect(chunkIds).not.toContain("c-foreign");
    expect(result.groups[0]?.indexGenerations).toEqual(["own-generation"]);
  });

  it("schiebt den Workspace als Bedingung in den Speicherfilter", async () => {
    const seen: (PayloadFilter | undefined)[] = [];
    const { store } = await buildInMemorySearchEngine(SCOPE_FIXTURES);
    const spy = spyStore(store, {
      onQuery: (filter) => {
        seen.push(filter);
      },
    });
    const { engine } = await buildInMemorySearchEngine(SCOPE_FIXTURES, { vectorStore: spy });
    await engine.search({ query: "charge", workspaceId: TEST_WORKSPACE_ID });
    expect(seen.length).toBeGreaterThan(0);
    for (const filter of seen) {
      expect(filter?.must).toContainEqual({
        field: "workspace_id",
        match: { eq: TEST_WORKSPACE_ID },
      });
    }
  });

  it("faengt einen Speicher ab, der den Filter ignoriert, und verbucht den Fremdtreffer", async () => {
    const { store } = await buildInMemorySearchEngine(SCOPE_FIXTURES);
    // Ein Speicher, der den Payloadfilter schlicht nicht auswertet.
    const unfiltered = spyStore(store, { stripFilter: true });
    const { engine } = await buildInMemorySearchEngine(SCOPE_FIXTURES, {
      vectorStore: unfiltered,
    });
    const result = await engine.search({ query: "charge", workspaceId: TEST_WORKSPACE_ID });
    expect(result.groups.flatMap((group) => group.hits.map((hit) => hit.chunkId))).toEqual([
      "c-own",
    ]);
    expect(result.groups[0]?.indexGenerations).toEqual(["own-generation"]);
    expect(
      result.skipped.some(
        (entry) => entry.subjectId === "c-foreign" && entry.detail.includes("ws-someone-else"),
      ),
    ).toBe(true);
  });

  it("haelt sich an die Repositories des Ziels und meldet keine falsche Herkunft", async () => {
    const fixtures: ChunkFixture[] = [
      {
        chunkId: "c-in-target",
        repoId: "repo-a",
        filePath: "src/pay.ts",
        symbolName: "charge",
        content: "async charge() {}",
      },
      {
        chunkId: "c-outside-target",
        repoId: "repo-not-in-target",
        filePath: "other/pay.ts",
        symbolName: "charge",
        content: "async charge() {}",
      },
    ];
    const { store, embedder } = await buildInMemorySearchEngine(fixtures);
    const engine = new HybridSearchEngine({
      vectorStore: store,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
    });
    const result = await engine.search({ query: "charge" });
    const group = result.groups[0];
    expect(group?.hits.map((hit) => hit.repoId)).toEqual(["repo-a"]);
    expect(group?.repoIds).toEqual(["repo-a"]);
  });

  it("fragt den Speicher gar nicht, wenn die angefragten Repos ausserhalb des Ziels liegen", async () => {
    const { store, embedder } = await buildInMemorySearchEngine(FIXTURES);
    let queries = 0;
    const counting = spyStore(store, {
      onQuery: () => {
        queries += 1;
      },
    });
    const engine = new HybridSearchEngine({
      vectorStore: counting,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
    });
    const result = await engine.search({ query: "charge", repositories: ["repo-elsewhere"] });
    expect(queries).toBe(0);
    expect(result.totalHits).toBe(0);
    expect(result.groups[0]?.repoIds).toEqual([]);
    expect(result.skipped.some((entry) => entry.detail.includes("repo-elsewhere"))).toBe(true);
  });
});

describe("HybridSearchEngine: E4-Luecken werden benannt", () => {
  it("warnt, wenn includeContext/includeLinked angenommen, aber nicht ausgefuehrt werden", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({
      query: "charge",
      includeContext: true,
      includeLinked: true,
    });
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain("GRAPH_CONTEXT_UNAVAILABLE");
    expect(codes).toContain("LINKED_ARTIFACTS_UNAVAILABLE");
  });

  it("schweigt darueber, wenn nichts angefordert wurde", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "charge" });
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).not.toContain("GRAPH_CONTEXT_UNAVAILABLE");
    expect(codes).not.toContain("LINKED_ARTIFACTS_UNAVAILABLE");
  });

  it("ruft Anreicherung erst fuer final begrenzte Treffer und veraendert kein Rankingfeld", async () => {
    const calls: Array<{ targetIds: string[]; chunkIds: string[] }> = [];
    const enrichment: SearchGraphEnrichmentPort = {
      async enrich(request) {
        calls.push({
          targetIds: request.targets.map((target) => target.targetId),
          chunkIds: request.targets.map((target) => target.fileId),
        });
        return {
          entries: request.targets.map((target) => ({
            targetId: target.targetId,
            graphContext: {
              schemaVersion: 1,
              relations: [],
              relationLimit: request.relationLimit,
              truncated: false,
              omittedCount: 0,
              omissions: [],
            },
            linkedSymbols: {
              schemaVersion: 1,
              relations: [],
              relationLimit: request.relationLimit,
              truncated: false,
              omittedCount: 0,
              omissions: [],
            },
          })),
          warnings: [],
        };
      },
    };
    const baselineHarness = await buildInMemorySearchEngine(FIXTURES);
    const enrichedHarness = await buildInMemorySearchEngine(FIXTURES, {
      graphEnrichment: enrichment,
    });
    const request = { query: "charge", limit: 1, includeContext: true, includeLinked: true };
    const baseline = await baselineHarness.engine.search(request);
    const enriched = await enrichedHarness.engine.search(request);

    expect(calls).toEqual([
      {
        targetIds: ["group:0:hit:0"],
        chunkIds: [enriched.groups[0]?.hits[0]?.fileId as string],
      },
    ]);
    expect(enriched.totalHits).toBe(baseline.totalHits);
    expect(enriched.queryFingerprint).toBe(baseline.queryFingerprint);
    expect(enriched.groups.flatMap((group) => group.hits).map(rankingProjection)).toEqual(
      baseline.groups.flatMap((group) => group.hits).map(rankingProjection),
    );
  });

  it("sortiert Graphrelationen nach Codepoints und deckelt sie sichtbar", async () => {
    const relations: SearchGraphRelationV1[] = Array.from(
      { length: SEARCH_GRAPH_RELATION_LIMIT + 3 },
      (_, index) => ({
        schemaVersion: 1,
        source: "file_graph",
        edgeId: `edge-${String(SEARCH_GRAPH_RELATION_LIMIT + 3 - index).padStart(3, "0")}`,
        direction: index % 2 === 0 ? "outgoing" : "incoming",
        edgeKind: "import",
        repoId: "repo-a",
        refId: "ref-main",
        fileId: `file-${String(index).padStart(3, "0")}`,
        path: `src/${String(SEARCH_GRAPH_RELATION_LIMIT + 3 - index).padStart(3, "0")}.ts`,
        crossRepository: false,
      }),
    );
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      graphEnrichment: {
        enrich(request) {
          return Promise.resolve({
            entries: request.targets.map((target) => ({
              targetId: target.targetId,
              graphContext: {
                schemaVersion: 1,
                relations,
                relationLimit: 999,
                truncated: false,
                omittedCount: 0,
                omissions: [],
              },
            })),
            warnings: [],
          });
        },
      },
    });
    const result = await engine.search({ query: "charge", limit: 1, includeContext: true });
    const context = result.groups[0]?.hits[0]?.graphContext;
    expect(context?.relations).toHaveLength(SEARCH_GRAPH_RELATION_LIMIT);
    expect(context?.relationLimit).toBe(SEARCH_GRAPH_RELATION_LIMIT);
    expect(context?.truncated).toBe(true);
    expect(context?.omissions).toContainEqual(
      expect.objectContaining({ reason: "relation_limit", count: 3 }),
    );
    expect(context?.relations.map((relation) => `${relation.direction}:${relation.path}`)).toEqual(
      [...(context?.relations ?? [])]
        .map((relation) => `${relation.direction}:${relation.path}`)
        .sort(),
    );
  });

  it("aggregiert adversarial viele kantenbezogene Auslassungen auf eine begrenzte Reason-Zeile", async () => {
    const omissionCount = 500;
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      graphEnrichment: {
        enrich(request) {
          return Promise.resolve({
            entries: request.targets.map((target) => ({
              targetId: target.targetId,
              linkedSymbols: {
                schemaVersion: 1,
                relations: [],
                relationLimit: request.relationLimit,
                truncated: false,
                omittedCount: omissionCount,
                omissions: Array.from({ length: omissionCount }, (_, index) => ({
                  reason: "unresolved_endpoint" as const,
                  count: 1,
                  detail: `edge-${String(index).padStart(4, "0")} is unresolved`,
                })),
              },
            })),
            warnings: [],
          });
        },
      },
    });
    const result = await engine.search({ query: "charge", limit: 1, includeLinked: true });
    const linked = result.groups[0]?.hits[0]?.linkedSymbols;
    expect(linked?.omissions).toHaveLength(1);
    expect(linked?.omissions[0]).toMatchObject({
      reason: "unresolved_endpoint",
      count: omissionCount,
    });
    expect(linked?.omissions[0]?.detail).toContain("aggregated deterministically");
    expect(linked?.omittedCount).toBe(omissionCount);
  });

  it("begrenzt adversarial viele Providerwarnungen, IDs und freie Diagnosetexte", async () => {
    const diagnosticCount = 100;
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      graphEnrichment: {
        enrich(request) {
          return Promise.resolve({
            entries: [
              ...request.targets.map((target) => ({
                targetId: target.targetId,
                graphContext: {
                  schemaVersion: 1 as const,
                  relations: [],
                  relationLimit: request.relationLimit,
                  truncated: false,
                  omittedCount: 0,
                  omissions: [],
                },
              })),
              ...Array.from({ length: diagnosticCount }, (_, index) => ({
                targetId: `unexpected-${String(index).padStart(3, "0")}-${"x".repeat(1_000)}`,
              })),
            ],
            warnings: Array.from({ length: diagnosticCount }, (_, index) => ({
              code: `PROVIDER_${String(index).padStart(3, "0")}`,
              message: `warning-${String(index)}-${"m".repeat(1_000)}`,
              details: {
                workspaceId: TEST_WORKSPACE_ID,
                generationId: "generation-a",
                issues: Array.from(
                  { length: diagnosticCount },
                  (_, issueIndex) => `issue-${String(issueIndex)}-${"i".repeat(1_000)}`,
                ),
                arbitraryUnboundedPayload: "p".repeat(10_000),
              },
            })),
          });
        },
      },
    });
    const result = await engine.search({ query: "charge", limit: 1, includeContext: true });

    const providerWarnings = result.warnings.filter((warning) =>
      warning.code.startsWith("PROVIDER_"),
    );
    expect(providerWarnings).toHaveLength(SEARCH_GRAPH_PROVIDER_WARNING_LIMIT);
    expect(
      providerWarnings.every(
        (warning) => warning.message.length <= SEARCH_GRAPH_OMISSION_DETAIL_LIMIT,
      ),
    ).toBe(true);
    expect(providerWarnings[0]?.details?.["issues"]).toHaveLength(
      SEARCH_GRAPH_PROVIDER_WARNING_LIMIT,
    );
    expect(providerWarnings[0]?.details?.["omittedIssueCount"]).toBe(
      diagnosticCount - SEARCH_GRAPH_PROVIDER_WARNING_LIMIT,
    );
    expect(providerWarnings[0]?.details?.["omittedDetailFieldCount"]).toBe(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "GRAPH_ENRICHMENT_WARNINGS_TRUNCATED" }),
    );

    const incomplete = result.warnings.find(
      (warning) => warning.code === "GRAPH_ENRICHMENT_INCOMPLETE",
    );
    expect(incomplete?.details?.["unexpectedTargetIds"]).toHaveLength(
      SEARCH_GRAPH_DIAGNOSTIC_LIMIT,
    );
    expect(incomplete?.details?.["omittedUnexpectedTargetIdCount"]).toBe(
      diagnosticCount - SEARCH_GRAPH_DIAGNOSTIC_LIMIT,
    );
    expect(
      (incomplete?.details?.["unexpectedTargetIds"] as string[]).every(
        (targetId) => targetId.length <= SEARCH_GRAPH_OMISSION_DETAIL_LIMIT,
      ),
    ).toBe(true);
  });

  it("degradiert bei Graphfehlern sichtbar, ohne Treffer oder Scores zu verlieren", async () => {
    const baselineHarness = await buildInMemorySearchEngine(FIXTURES);
    const failingHarness = await buildInMemorySearchEngine(FIXTURES, {
      graphEnrichment: {
        enrich() {
          return Promise.reject(new Error("graph store unavailable"));
        },
      },
    });
    const request = { query: "charge", limit: 2, includeContext: true, includeLinked: true };
    const baseline = await baselineHarness.engine.search(request);
    const failed = await failingHarness.engine.search(request);
    expect(failed.groups.flatMap((group) => group.hits).map(rankingProjection)).toEqual(
      baseline.groups.flatMap((group) => group.hits).map(rankingProjection),
    );
    expect(failed.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["GRAPH_CONTEXT_UNAVAILABLE", "LINKED_ARTIFACTS_UNAVAILABLE"]),
    );
    for (const hit of failed.groups.flatMap((group) => group.hits)) {
      expect(hit.graphContext?.omissions[0]?.reason).toBe("graph_unavailable");
      expect(hit.linkedSymbols?.omissions[0]?.reason).toBe("graph_unavailable");
    }
  });

  it("deckelt candidateLimit auf das Konfigurationsmaximum und sagt es", async () => {
    const { store, embedder } = await buildInMemorySearchEngine(FIXTURES);
    const limits: number[] = [];
    const spy = spyStore(store, {
      onQuery: (_filter, limit) => {
        limits.push(limit ?? -1);
      },
    });
    const engine = new HybridSearchEngine({
      vectorStore: spy,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
    });
    const result = await engine.search({ query: "charge", candidateLimit: 100_000 });
    expect(result.query.candidateLimit).toBe(DEFAULT_SEARCH_CONFIG.maxCandidateLimit);
    expect(limits.every((limit) => limit <= DEFAULT_SEARCH_CONFIG.maxCandidateLimit)).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("CANDIDATE_LIMIT_CLAMPED");
  });

  // -------------------------------------------------------------------------
  // Nachpruefung Welle 3b, Befund A3 und B5: die erste Reparatur deckelte nur
  // `candidateLimit` und hob den Wert danach mit `Math.max(max, limit)` wieder
  // an. Damit war die Grenze fuer JEDE Anfrage mit grossem `limit`
  // ausgeschaltet — und die Warnung „geklemmt" wurde trotzdem geschrieben,
  // obwohl nichts geklemmt worden war.
  // -------------------------------------------------------------------------
  it("deckelt auch dann, wenn nicht candidateLimit, sondern limit gross ist", async () => {
    const { store, embedder } = await buildInMemorySearchEngine(FIXTURES);
    const limits: number[] = [];
    const spy = spyStore(store, {
      onQuery: (_filter, limit) => {
        limits.push(limit ?? -1);
      },
    });
    const engine = new HybridSearchEngine({
      vectorStore: spy,
      targets: [
        {
          embeddingProfileId: embedder.profileId,
          collection: TEST_COLLECTION,
          repoIds: ["repo-a"],
          embedder,
        },
      ],
      defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
    });
    const result = await engine.search({ query: "charge", limit: 100_000 });
    expect(result.query.candidateLimit).toBe(DEFAULT_SEARCH_CONFIG.maxCandidateLimit);
    expect(result.query.limit).toBe(DEFAULT_SEARCH_CONFIG.maxCandidateLimit);
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((limit) => limit <= DEFAULT_SEARCH_CONFIG.maxCandidateLimit)).toBe(true);
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain("CANDIDATE_LIMIT_CLAMPED");
    expect(codes).toContain("RESULT_LIMIT_CLAMPED");
  });

  it("meldet eine Deckelung nur, wenn sie stattgefunden hat", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const clamped = await engine.search({ query: "charge", candidateLimit: 100_000 });
    const warning = clamped.warnings.find((entry) => entry.code === "CANDIDATE_LIMIT_CLAMPED");
    // Die Warnung darf nicht behaupten, mit 100000 Kandidaten gelaufen zu sein.
    expect(warning?.details?.["effective"]).toBe(DEFAULT_SEARCH_CONFIG.maxCandidateLimit);
    expect(warning?.details?.["effective"]).not.toBe(warning?.details?.["requested"]);
    expect(warning?.message).toContain(
      `with ${DEFAULT_SEARCH_CONFIG.maxCandidateLimit} candidates`,
    );

    const untouched = await engine.search({ query: "charge", limit: 5, candidateLimit: 50 });
    expect(untouched.warnings.map((entry) => entry.code)).not.toContain("CANDIDATE_LIMIT_CLAMPED");
    expect(untouched.warnings.map((entry) => entry.code)).not.toContain("RESULT_LIMIT_CLAMPED");
  });

  it("lehnt ein fehlerhaftes Glob-Muster als Eingabefehler ab, statt es als Speicherausfall zu verbuchen", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    await expect(engine.search({ query: "charge", pathGlob: ["[z-a]"] })).rejects.toThrow(
      /pathGlob/u,
    );
    await expect(engine.search({ query: "charge", pathExclude: ["[z-a]"] })).rejects.toThrow(
      /pathExclude/u,
    );
  });

  it("nennt ersetzte Payload-Felder am Treffer und in einer Warnung", async () => {
    const { engine, store } = await buildInMemorySearchEngine(FIXTURES);
    await store.upsert(TEST_COLLECTION, [
      {
        id: "c-thin",
        dense: new Array<number>(64).fill(0.1),
        sparse: textToSparseVector("charge charge charge"),
        payload: {
          point_type: "code_chunk",
          workspace_id: TEST_WORKSPACE_ID,
          repo_id: "repo-a",
          ref_id: "ref-main",
          file_id: "f-thin",
          file_path: "src/thin.ts",
          chunk_id: "c-thin",
          metrics_scope_id: "c-thin",
          start_line: 42,
          start_byte: 1000,
          content: "charge",
        },
      },
    ]);
    const result = await engine.search({ query: "charge", limit: 10 });
    const hit = result.groups.flatMap((group) => group.hits).find((h) => h.chunkId === "c-thin");
    expect(hit).toBeDefined();
    expect(hit?.incompletePayloadFields).toContain("end_line");
    expect(hit?.incompletePayloadFields).toContain("file_hash");
    // Der ausgelieferte Bereich bleibt gueltig: Ende NIE vor dem Anfang.
    expect(hit?.range.endByte).toBeGreaterThanOrEqual(hit?.range.startByte as number);
    expect(hit?.range.endLine).toBeGreaterThanOrEqual(hit?.range.startLine as number);
    expect(result.warnings.map((warning) => warning.code)).toContain("INCOMPLETE_PAYLOAD");
  });
});

function rankingProjection(hit: SearchHitV1): unknown {
  return {
    rank: hit.rank,
    chunkId: hit.chunkId,
    dedupeKey: hit.dedupeKey,
    score: hit.score,
    relatedFragments: hit.relatedFragments,
  };
}

describe("HybridSearchEngine: Fingerabdruck und Rangfolge", () => {
  it("unterscheidet Anfragen, die materiell verschiedene Ergebnisse liefern", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const cases: UntangleSearchRequestV1[] = [
      { query: "charge" },
      { query: "charge", mode: "lexical" },
      { query: "charge", mode: "symbol" },
      { query: "charge", pathExclude: ["docs/**"] },
      { query: "charge", sort: "path" },
      { query: "charge", complexityBias: "prefer-simple" },
      // Nachpruefung Welle 3b, Befund A1: diese drei standen laengst in
      // `SearchQueryV1`, veraendern Treffermenge bzw. Rangfolge und trugen
      // trotzdem denselben Fingerabdruck wie die Basisanfrage.
      { query: "charge", minScore: 0.9 },
      { query: "charge", diversify: true },
      { query: "charge", workspaceId: "workspace-elsewhere" },
    ];
    const fingerprints = new Set<string>();
    for (const request of cases) {
      fingerprints.add((await engine.search(request)).queryFingerprint);
    }
    expect(fingerprints.size).toBe(cases.length);
  });

  it("laesst reine Darstellungsangaben (limit, content, context, linked) den Fingerabdruck NICHT veraendern", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const base = await engine.search({ query: "charge" });
    const paged = await engine.search({ query: "charge", limit: 1 });
    const withContent = await engine.search({ query: "charge", includeContent: true });
    const withContext = await engine.search({ query: "charge", includeContext: true });
    const withLinked = await engine.search({ query: "charge", includeLinked: true });
    expect(paged.queryFingerprint).toBe(base.queryFingerprint);
    expect(withContent.queryFingerprint).toBe(base.queryFingerprint);
    expect(withContext.queryFingerprint).toBe(base.queryFingerprint);
    expect(withLinked.queryFingerprint).toBe(base.queryFingerprint);
  });

  it("meldet denselben dichten Rang in inputs.denseRank und in der evidence", async () => {
    const { engine, store, embedder } = await buildInMemorySearchEngine(FIXTURES);
    // Ein unlesbarer Punkt, der im dichten Ergebnis GANZ OBEN steht.
    const queryVector = await embedder.embedQuery("search_query: charge");
    await store.upsert(TEST_COLLECTION, [
      {
        id: "aaa-broken",
        dense: queryVector,
        payload: {
          point_type: "code_chunk",
          workspace_id: TEST_WORKSPACE_ID,
          repo_id: "repo-a",
          ref_id: "ref-main",
          file_path: "src/broken.ts",
          chunk_id: "aaa-broken",
          metrics_scope_id: "aaa-broken",
        },
      },
    ]);
    const result = await engine.search({ query: "charge", limit: 10 });
    expect(result.skipped.some((entry) => entry.subjectId === "aaa-broken")).toBe(true);
    const hits = result.groups.flatMap((group) => group.hits);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const denseRank = hit.score.inputs.denseRank;
      const evidence =
        hit.score.components.find((component) => component.kind === "base_hybrid")?.evidence ?? "";
      if (denseRank !== undefined) {
        expect(evidence).toContain(`dense#${denseRank}`);
      }
    }
  });
});

describe("relevanceDecision an der Gruppe (Verdikt statt Listenlaenge)", () => {
  const REJECTING = {
    [TEST_EMBEDDING_PROFILE_ID]: {
      workspaceId: TEST_WORKSPACE_ID,
      collection: TEST_COLLECTION,
      policy: {
        ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        calibrationId: "test/force-abstention",
        minimumDenseScore: 1,
        minimumDenseSpread: 2,
        denseReferenceRank: 2,
        minimumCandidateIdfCoverage: 1,
      },
    },
  };
  const ACCEPTING = {
    [TEST_EMBEDDING_PROFILE_ID]: {
      workspaceId: TEST_WORKSPACE_ID,
      collection: TEST_COLLECTION,
      policy: {
        ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        calibrationId: "test/force-acceptance",
        minimumDenseScore: 0,
        minimumDenseSpread: 0,
        denseReferenceRank: 2,
        minimumCandidateIdfCoverage: 0,
      },
    },
  };

  it("traegt bei einer Ablehnung Verdikt und Kalibrierung", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: REJECTING,
    });
    const result = await engine.search({ query: "webhook handler", limit: 10 });
    expect(result.groups[0]?.relevanceDecision).toEqual({
      abstention: "strict",
      status: "rejected",
      basis: "insufficient_evidence",
      calibrationId: "test/force-abstention",
    });
  });

  it("traegt bei einer Annahme dasselbe Feld", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: ACCEPTING,
    });
    const result = await engine.search({ query: "webhook handler", limit: 10 });
    expect(result.groups[0]?.relevanceDecision?.status).toBe("accepted");
    expect(result.groups[0]?.relevanceDecision?.calibrationId).toBe("test/force-acceptance");
  });

  it("meldet eine Policy fuer ein anderes Profil als nicht ausgewertet", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, {
      relevancePolicies: {
        "some-other-profile": {
          workspaceId: TEST_WORKSPACE_ID,
          collection: TEST_COLLECTION,
          policy: { ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY, calibrationId: "test/other" },
        },
      },
    });
    const result = await engine.search({ query: "webhook handler", limit: 10 });
    expect(result.groups[0]?.relevanceDecision).toEqual({
      abstention: "strict",
      status: "not_evaluated",
      basis: "policy_profile_mismatch",
    });
  });

  it("laesst das Feld weg, wenn gar keine Policy gebunden ist", async () => {
    // Abwesenheit heisst „keine Policy gebunden", nicht „akzeptiert". Ohne
    // gebundene Policy muss die Antwort byte-identisch zu vorher bleiben.
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const result = await engine.search({ query: "webhook handler", limit: 10 });
    expect(result.groups[0]?.relevanceDecision).toBeUndefined();
  });
});

describe("abstention: strict gegen evidence", () => {
  const REJECTING = {
    [TEST_EMBEDDING_PROFILE_ID]: {
      workspaceId: TEST_WORKSPACE_ID,
      collection: TEST_COLLECTION,
      policy: {
        ...QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
        calibrationId: "test/force-abstention",
        minimumDenseScore: 1,
        minimumDenseSpread: 2,
        denseReferenceRank: 2,
        minimumCandidateIdfCoverage: 1,
      },
    },
  };

  it("strict verwirft die Treffer wie bisher", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, { relevancePolicies: REJECTING });
    const result = await engine.search({ query: "webhook handler", limit: 10 });
    expect(result.totalHits).toBe(0);
    expect(result.skipped.some((e) => e.reason === "relevance_policy_rejected")).toBe(true);
    expect(result.groups[0]?.relevanceDecision?.abstention).toBe("strict");
  });

  it("evidence behaelt die Treffer UND das Verdikt", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, { relevancePolicies: REJECTING });
    const result = await engine.search({
      query: "webhook handler",
      limit: 10,
      abstention: "evidence",
    });
    expect(result.totalHits).toBeGreaterThan(0);
    expect(result.groups[0]?.relevanceDecision).toMatchObject({
      abstention: "evidence",
      status: "rejected",
      calibrationId: "test/force-abstention",
    });
  });

  it("schreibt unter evidence KEINEN Skip-Eintrag fuer zurueckgegebene Treffer", async () => {
    // Ein Ledger-Eintrag ueber einen Gegenstand, der im Ergebnis steht, ist in
    // diesem Repository ein dokumentierter E4-Defekt (WP-142).
    const { engine } = await buildInMemorySearchEngine(FIXTURES, { relevancePolicies: REJECTING });
    const result = await engine.search({
      query: "webhook handler",
      limit: 10,
      abstention: "evidence",
    });
    expect(result.skipped.some((e) => e.reason === "relevance_policy_rejected")).toBe(false);
  });

  it("meldet die Enthaltung in beiden Verhalten identisch", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES, { relevancePolicies: REJECTING });
    const strict = await engine.search({ query: "webhook handler", limit: 10 });
    const evidence = await engine.search({
      query: "webhook handler",
      limit: 10,
      abstention: "evidence",
    });
    const codeOf = (r: typeof strict) =>
      r.warnings.find((w) => w.code === "NO_SUFFICIENT_MATCH")?.message;
    expect(codeOf(evidence)).toBe(codeOf(strict));
    expect(evidence.groups[0]?.caveats).toEqual(strict.groups[0]?.caveats);
  });

  it("laesst den queryFingerprint unter strict unveraendert", async () => {
    // Der Kern der Rueckwaertskompatibilitaet: `strict` darf nichts zum
    // Fingerabdruck beitragen, sonst sind alle persistierten Datensaetze
    // entwertet.
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const implicit = await engine.search({ query: "webhook handler", limit: 10 });
    const explicit = await engine.search({
      query: "webhook handler",
      limit: 10,
      abstention: "strict",
    });
    expect(explicit.queryFingerprint).toBe(implicit.queryFingerprint);
    expect(explicit.rankingContextFingerprint).toBe(implicit.rankingContextFingerprint);
  });

  it("aendert den Fingerabdruck, sobald evidence gewaehlt ist", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const strict = await engine.search({ query: "webhook handler", limit: 10 });
    const evidence = await engine.search({
      query: "webhook handler",
      limit: 10,
      abstention: "evidence",
    });
    expect(evidence.queryFingerprint).not.toBe(strict.queryFingerprint);
  });
});
