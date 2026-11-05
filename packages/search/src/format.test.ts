import { describe, expect, it } from "vitest";

import { formatGrepResultSet, formatHitAsText, formatSearchResultSet } from "./format.js";
import { grepIndexedChunks } from "./grep.js";
import type { ChunkFixture } from "./testing/in-memory-index.js";
import { TEST_COLLECTION, buildInMemorySearchEngine } from "./testing/in-memory-index.js";

const FIXTURES: ChunkFixture[] = [
  {
    chunkId: "c-charge",
    filePath: "src/payment/payment-service.ts",
    symbolId: "sym-charge",
    symbolName: "charge",
    symbolFqn: "PaymentService.charge",
    symbolKind: "method",
    cognitive: 22,
    content: "async charge(amount: number) {\n  return this.gateway.send(amount);\n}",
  },
  {
    chunkId: "c-refund",
    filePath: "src/payment/refund-service.ts",
    symbolId: "sym-refund",
    symbolName: "refund",
    content: "async refund(id: string) { return this.gateway.refund(id); }",
  },
];

async function searchResult() {
  const { engine } = await buildInMemorySearchEngine(FIXTURES);
  return engine.search({ query: "charge", limit: 5 });
}

describe("formatSearchResultSet", () => {
  it("json round-trips into the identical object", async () => {
    const set = await searchResult();
    expect(JSON.parse(formatSearchResultSet(set, "json"))).toEqual(JSON.parse(JSON.stringify(set)));
  });

  it("jsonl starts with a header line carrying warnings and ledger", async () => {
    const set = await searchResult();
    const lines = formatSearchResultSet(set, "jsonl").split("\n");
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(header["kind"]).toBe("header");
    expect(header).toHaveProperty("skipped");
    expect(header).toHaveProperty("warnings");
    expect(lines).toHaveLength(1 + set.totalHits);
  });

  it("jsonl emits one parseable object per hit", async () => {
    const set = await searchResult();
    for (const line of formatSearchResultSet(set, "jsonl").split("\n").slice(1)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed["kind"]).toBe("hit");
      expect(parsed).toHaveProperty("hit");
    }
  });

  it("text shows the query, the ranking and WHY each hit ranks", async () => {
    const set = await searchResult();
    const text = formatSearchResultSet(set, "text");
    expect(text).toContain("query: charge");
    expect(text).toContain("why:");
    expect(text).toContain("base_hybrid");
  });

  it("text names the skipped candidates instead of hiding them", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const set = await engine.search({ query: "charge", limit: 1 });
    const text = formatSearchResultSet(set, "text");
    expect(text).toContain("nothing is dropped silently");
  });

  it("text says so when a group has no hits", async () => {
    const { engine } = await buildInMemorySearchEngine([]);
    const set = await engine.search({ query: "charge" });
    expect(formatSearchResultSet(set, "text")).toContain("(no hits)");
  });

  it("is deterministic", async () => {
    const set = await searchResult();
    expect(formatSearchResultSet(set, "text")).toBe(formatSearchResultSet(set, "text"));
  });
});

describe("formatHitAsText", () => {
  it("prints complexity and the content when it is present", async () => {
    const { engine } = await buildInMemorySearchEngine(FIXTURES);
    const set = await engine.search({ query: "charge", limit: 1, includeContent: true });
    const hit = set.groups[0]?.hits[0];
    expect(hit).toBeDefined();
    if (hit === undefined) {
      return;
    }
    const text = formatHitAsText(hit);
    expect(text).toContain("cognitive 22");
    expect(text).toContain("| async charge");
  });

  it("zeigt Graphprovenienz und Auslassungsgruende auch im Textformat", async () => {
    const set = await searchResult();
    const hit = set.groups[0]?.hits[0];
    expect(hit).toBeDefined();
    if (hit === undefined) return;
    hit.graphContext = {
      schemaVersion: 1,
      relationLimit: 32,
      truncated: false,
      omittedCount: 1,
      relations: [
        {
          schemaVersion: 1,
          source: "file_graph",
          edgeId: "edge-1",
          direction: "outgoing",
          edgeKind: "import",
          repoId: "repo-b",
          refId: "ref-b",
          fileId: "file-b",
          path: "src/b.ts",
          crossRepository: true,
        },
      ],
      omissions: [{ reason: "unresolved_endpoint", count: 1, detail: "edge target unresolved" }],
    };
    const text = formatHitAsText(hit);
    expect(text).toContain("context -> repo-b@ref-b src/b.ts file=file-b");
    expect(text).toContain("kind=import crossRepository=true");
    expect(text).toContain("context omitted unresolved_endpoint x1");
  });
});

describe("formatGrepResultSet", () => {
  it("uses grep's own line format with context markers", async () => {
    const { store } = await buildInMemorySearchEngine(FIXTURES);
    const set = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "gateway",
      contextLinesBefore: 1,
    });
    const text = formatGrepResultSet(set, "text");
    expect(text).toContain("src/payment/payment-service.ts:2:");
    expect(text).toContain("match(es) in");
  });

  it("jsonl emits a header and one line per match", async () => {
    const { store } = await buildInMemorySearchEngine(FIXTURES);
    const set = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "gateway" });
    const lines = formatGrepResultSet(set, "jsonl").split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ kind: "header" });
    expect(lines).toHaveLength(1 + set.totalMatches);
  });

  it("json round-trips", async () => {
    const { store } = await buildInMemorySearchEngine(FIXTURES);
    const set = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "gateway" });
    expect(JSON.parse(formatGrepResultSet(set, "json"))).toEqual(JSON.parse(JSON.stringify(set)));
  });

  it("reports truncation in the text summary", async () => {
    const { store } = await buildInMemorySearchEngine(FIXTURES);
    const set = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "e",
      maxMatches: 1,
    });
    expect(formatGrepResultSet(set, "text")).toContain("TRUNCATED");
  });
});

describe("Textausgabe unterscheidet Enthaltung von Leere", () => {
  const rejectedGroup = {
    embeddingProfileId: "p1",
    repoIds: ["repo-1"],
    hits: [],
    rankNormalized: false,
    caveats: [],
    relevanceDecision: {
      abstention: "strict" as const,
      status: "rejected" as const,
      basis: "insufficient_evidence",
      calibrationId: "test/force-abstention",
    },
  };

  function setWith(group: unknown) {
    return {
      schemaVersion: 1,
      queryFingerprint: "f",
      rankingContextFingerprint: "r",
      query: { text: "x" },
      groups: [group],
      totalHits: 0,
      profileSeparation: false,
      skipped: [],
      warnings: [],
    } as never;
  }

  it("nennt bei einer Ablehnung das Verdikt und die Kalibrierung", () => {
    // „(no hits)" allein waere hier eine Tatsachenbehauptung ueber den Code.
    // Die Wahrheit ist: es gab Kandidaten, und die Policy hat sie verworfen.
    const text = formatSearchResultSet(setWith(rejectedGroup), "text");
    expect(text).toContain("test/force-abstention");
    expect(text).toContain("insufficient_evidence");
  });

  it("laesst das schlichte (no hits) fuer eine Gruppe ohne Verdikt stehen", () => {
    const text = formatSearchResultSet(
      setWith({ ...rejectedGroup, relevanceDecision: undefined }),
      "text",
    );
    expect(text).toContain("(no hits)");
  });
});
