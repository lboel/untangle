/**
 * Der lange Schwanz aus BUILD_PLAN §25 — die Befunde, die eine FALSCHE
 * AUSSAGE erzeugen (WP-176, WP-177, WP-178, WP-188, WP-189, WP-190, WP-191).
 *
 * Sie haben eine gemeinsame Form: das Werkzeug tut etwas anderes, als es
 * sagt, und sagt es so, dass niemand nachfragt. Ein teilweise weggefallenes
 * Repository sieht wie eine vollstaendige Suche aus; eine Ergebnisgruppe
 * nennt Herkuenfte, die nichts beigetragen haben; eine Einstellung wirkt
 * nicht; eine Begruendung widerspricht der Zahl, die sie nennt. Jeder dieser
 * Tests reproduziert genau das und verlangt das Gegenteil.
 */
import { DEFAULT_SEARCH_CONFIG } from "@untangle-code/config";
import type { PayloadFilter, VectorStore } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { HybridSearchEngine } from "./engine.js";
import { grepIndexedChunks } from "./grep.js";
import { readCodeChunkPayload } from "./payload.js";
import type { ChunkFixture } from "./testing/in-memory-index.js";
import {
  TEST_COLLECTION,
  TEST_WORKSPACE_ID,
  buildInMemorySearchEngine,
  fixtureToPayload,
} from "./testing/in-memory-index.js";

/** Ein Speicher, der den Payloadfilter schlicht nicht auswertet. */
function unfilteredStore(inner: VectorStore): VectorStore {
  const strip = <T extends { filter?: PayloadFilter }>(request: T): T => {
    const forwarded = { ...request };
    delete forwarded.filter;
    return forwarded;
  };
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
    hybridQuery: (collection, query, options) =>
      inner.hybridQuery(collection, strip(query), options),
    scroll: (collection, request, options) => inner.scroll(collection, strip(request), options),
  };
}

const TWO_REPOS: ChunkFixture[] = [
  {
    chunkId: "c-a",
    repoId: "repo-a",
    filePath: "src/pay.ts",
    symbolId: "sym-a",
    symbolName: "charge",
    content: "async charge(amount: number) {\n  return this.gateway.send(amount);\n}",
  },
  {
    chunkId: "c-b",
    repoId: "repo-b",
    filePath: "lib/pay.ts",
    symbolId: "sym-b",
    symbolName: "charge",
    content: "async charge(amount: number) {\n  return this.gateway.send(amount);\n}",
  },
];

function engineOver(
  harness: Awaited<ReturnType<typeof buildInMemorySearchEngine>>,
  repoIds: readonly string[],
  overrides: Partial<ConstructorParameters<typeof HybridSearchEngine>[0]> = {},
): HybridSearchEngine {
  return new HybridSearchEngine({
    vectorStore: harness.store,
    targets: [
      {
        embeddingProfileId: harness.embedder.profileId,
        collection: TEST_COLLECTION,
        repoIds: [...repoIds],
        embedder: harness.embedder,
      },
    ],
    defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
    ...overrides,
  });
}

describe("WP-176 — ein teilweise weggefallenes Repository ist kein Erfolg", () => {
  it("search: nennt das angefragte Repository, das dieses Ziel gar nicht fuehrt", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const engine = engineOver(harness, ["repo-a"]);
    const result = await engine.search({
      query: "charge",
      repositories: ["repo-a", "repo-ghost"],
    });

    // Es GIBT Treffer — genau das macht den Befund gefaehrlich: ohne den
    // Hinweis sieht der Lauf aus wie eine Suche ueber beide Repositories.
    expect(result.totalHits).toBeGreaterThan(0);
    expect(
      result.skipped.some((entry) => entry.detail.includes("repo-ghost")),
      "repo-ghost fehlt im Skip-Ledger",
    ).toBe(true);
    expect(result.groups[0]?.caveats.some((caveat) => caveat.includes("repo-ghost"))).toBe(true);
  });

  it("search: schweigt, wenn alles Angefragte im Ziel lag", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const engine = engineOver(harness, ["repo-a", "repo-b"]);
    const result = await engine.search({ query: "charge", repositories: ["repo-a"] });
    expect(result.skipped.some((entry) => entry.detail.includes("NOT searched here"))).toBe(false);
  });

  it("grep: meldet dasselbe, statt nur den vollstaendig leeren Fall zu melden", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const result = await grepIndexedChunks(
      harness.store,
      [TEST_COLLECTION],
      { pattern: "charge", workspaceId: TEST_WORKSPACE_ID, repositories: ["repo-a", "repo-ghost"] },
      undefined,
      { workspaceId: TEST_WORKSPACE_ID, repoIds: ["repo-a", "repo-b"] },
    );
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.code === "REPOSITORY_OUT_OF_SCOPE")).toBe(
      true,
    );
    expect(result.skipped.some((entry) => entry.detail.includes("repo-ghost"))).toBe(true);
  });
});

describe("WP-177 — grep braucht dieselbe zweite Verteidigungslinie wie search", () => {
  const MIXED: ChunkFixture[] = [
    { chunkId: "c-own", repoId: "repo-a", filePath: "src/a.ts", content: "const gateway = 1;" },
    {
      chunkId: "c-foreign",
      repoId: "repo-secret",
      workspaceId: "ws-someone-else",
      filePath: "secret/a.ts",
      content: "const gateway = 2;",
    },
  ];

  it("gibt bei einem Speicher, der den Filter ignoriert, KEINEN fremden Workspace aus", async () => {
    const harness = await buildInMemorySearchEngine(MIXED);
    const result = await grepIndexedChunks(
      unfilteredStore(harness.store),
      [TEST_COLLECTION],
      { pattern: "gateway", workspaceId: TEST_WORKSPACE_ID },
      undefined,
      { workspaceId: TEST_WORKSPACE_ID },
    );
    expect(result.matches.map((match) => match.filePath)).toEqual(["src/a.ts"]);
    expect(
      result.skipped.some((entry) => entry.detail.includes("ws-someone-else")),
      "der abgewiesene Fremdtreffer fehlt im Ledger",
    ).toBe(true);
  });

  it("weist auch ein nicht durchsuchtes Repository ab, das der Speicher trotzdem liefert", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const result = await grepIndexedChunks(
      unfilteredStore(harness.store),
      [TEST_COLLECTION],
      { pattern: "charge", workspaceId: TEST_WORKSPACE_ID, repositories: ["repo-a"] },
      undefined,
      { workspaceId: TEST_WORKSPACE_ID, repoIds: ["repo-a", "repo-b"] },
    );
    expect([...new Set(result.matches.map((match) => match.repoId))]).toEqual(["repo-a"]);
    expect(result.skipped.some((entry) => entry.repoId === "repo-b")).toBe(true);
  });
});

describe("WP-178 — die zweite Verteidigungslinie deckt auch den Filter der ANFRAGE", () => {
  it("verwirft einen Treffer aus einem nicht angefragten Repository des eigenen Ziels", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const engine = engineOver(harness, ["repo-a", "repo-b"], {
      vectorStore: unfilteredStore(harness.store),
    });
    const result = await engine.search({ query: "charge", repositories: ["repo-a"] });

    const hitRepos = result.groups.flatMap((group) => group.hits.map((hit) => hit.repoId));
    expect(hitRepos).not.toContain("repo-b");
    expect(
      result.skipped.some((entry) => entry.subjectId === "c-b" && entry.detail.includes("repo-b")),
      "der Fremdtreffer aus repo-b fehlt im Ledger",
    ).toBe(true);
  });
});

describe("WP-189 — group.repoIds nennt die BEITRAGENDEN Repositories", () => {
  it("nennt nur das Repository, aus dem ein Treffer kam, nicht den erlaubten Bereich", async () => {
    const fixtures: ChunkFixture[] = [
      {
        chunkId: "c-a",
        repoId: "repo-a",
        filePath: "src/pay.ts",
        symbolName: "charge",
        content: "async charge() { return 1; }",
      },
      {
        chunkId: "c-b",
        repoId: "repo-b",
        filePath: "lib/other.ts",
        symbolName: "unrelated",
        content: "const zzz = 1;",
      },
    ];
    const harness = await buildInMemorySearchEngine(fixtures);
    const engine = engineOver(harness, ["repo-a", "repo-b"]);
    const result = await engine.search({ query: "charge", limit: 1 });
    const group = result.groups[0];
    expect(group?.hits.map((hit) => hit.repoId)).toEqual(["repo-a"]);
    expect(group?.repoIds).toEqual(["repo-a"]);
  });
});

describe("WP-188 — searchConfig.minScoreDefault und diversifyByDefault haben einen Leser", () => {
  it("wendet minScoreDefault an, wenn die Anfrage nichts sagt, und nennt die Herkunft", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const engine = engineOver(harness, ["repo-a", "repo-b"], {
      searchConfig: { ...DEFAULT_SEARCH_CONFIG, minScoreDefault: 1.6 },
    });
    const result = await engine.search({ query: "charge" });
    expect(result.totalHits).toBe(0);
    expect(result.query.minScore).toBe(1.6);
    expect(
      result.skipped.some((entry) => entry.detail.includes("from searchConfig.minScoreDefault")),
    ).toBe(true);
  });

  it("laesst die ausdrueckliche Angabe der Anfrage gewinnen", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const engine = engineOver(harness, ["repo-a", "repo-b"], {
      searchConfig: { ...DEFAULT_SEARCH_CONFIG, minScoreDefault: 1.6 },
    });
    const result = await engine.search({ query: "charge", minScore: 0 });
    expect(result.query.minScore).toBe(0);
    expect(result.totalHits).toBeGreaterThan(0);
  });

  it("wendet diversifyByDefault an", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const engine = engineOver(harness, ["repo-a", "repo-b"], {
      searchConfig: { ...DEFAULT_SEARCH_CONFIG, diversifyByDefault: true },
    });
    const result = await engine.search({ query: "charge" });
    expect(result.query.diversify).toBe(true);

    const plain = engineOver(harness, ["repo-a", "repo-b"]);
    expect((await plain.search({ query: "charge" })).query.diversify).toBe(false);
  });
});

describe("WP-190 — ein workspaceId mit Rand-Leerzeichen liefert nicht null Treffer", () => {
  it("findet dieselben Treffer wie ohne die Leerzeichen", async () => {
    const harness = await buildInMemorySearchEngine(TWO_REPOS);
    const engine = engineOver(harness, ["repo-a", "repo-b"]);
    const padded = await engine.search({ query: "charge", workspaceId: `  ${TEST_WORKSPACE_ID} ` });
    const clean = await engine.search({ query: "charge", workspaceId: TEST_WORKSPACE_ID });

    expect(padded.totalHits).toBe(clean.totalHits);
    expect(padded.totalHits).toBeGreaterThan(0);
    expect(padded.query.workspaceId).toBe(TEST_WORKSPACE_ID);
    // Und kein Ledger voller „gehoert zu einem fremden Workspace" ueber den eigenen.
    expect(padded.skipped.some((entry) => entry.detail.includes("belongs to workspace"))).toBe(
      false,
    );
  });
});

describe("WP-191 — die Begruendung im Ledger widerspricht der Zahl nicht", () => {
  it("nennt ein nicht ganzzahliges end_line beim Namen, statt es 'vor start_line' zu nennen", () => {
    const raw = fixtureToPayload({
      chunkId: "c-broken",
      filePath: "src/a.ts",
      startLine: 3,
      content: "const a = 1;",
    });
    raw["end_line"] = 12.5;
    const read = readCodeChunkPayload(raw);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain("non-integer end_line");
    expect(read.reason).not.toContain("is before start_line");
  });

  it("behaelt die richtige Begruendung fuer ein echtes Ende VOR dem Anfang", () => {
    const raw = fixtureToPayload({
      chunkId: "c-broken",
      filePath: "src/a.ts",
      startLine: 9,
      content: "const a = 1;",
    });
    raw["end_line"] = 2;
    const read = readCodeChunkPayload(raw);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain("is before start_line");
  });
});
