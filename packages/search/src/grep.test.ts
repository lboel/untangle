import { describe, expect, it } from "vitest";

import {
  GREP_DEFAULTS,
  buildGrepRegExp,
  escapeRegExpLiteral,
  grepIndexedChunks,
  sortGrepMatches,
} from "./grep.js";
import { assertSafeGrepPattern } from "./regex-safety.js";
import type { ChunkFixture } from "./testing/in-memory-index.js";
import {
  TEST_COLLECTION,
  TEST_WORKSPACE_ID,
  buildInMemorySearchEngine,
} from "./testing/in-memory-index.js";
import type { GrepMatchV1 } from "./types.js";

const FIXTURES: ChunkFixture[] = [
  {
    chunkId: "c-a",
    filePath: "src/a.ts",
    startLine: 10,
    symbolName: "charge",
    content: "const first = 1;\nconst gateway = createGateway();\nreturn gateway.send();",
  },
  {
    chunkId: "c-b",
    filePath: "src/b.ts",
    content: "export const GATEWAY = 'x';\nexport const other = 'y';",
  },
  {
    chunkId: "c-doc",
    filePath: "docs/readme.md",
    language: "markdown",
    content: "the gateway is documented here",
  },
  {
    chunkId: "c-empty",
    filePath: "src/empty.ts",
    content: "",
  },
];

async function harness(fixtures: readonly ChunkFixture[] = FIXTURES) {
  return buildInMemorySearchEngine(fixtures);
}

describe("escapeRegExpLiteral", () => {
  it("makes a literal mean itself", () => {
    expect(new RegExp(escapeRegExpLiteral("a.b")).test("axb")).toBe(false);
    expect(new RegExp(escapeRegExpLiteral("a.b")).test("a.b")).toBe(true);
  });
});

describe("buildGrepRegExp", () => {
  it("rejects an empty pattern", () => {
    expect(() => buildGrepRegExp({ pattern: "" })).toThrow(/must not be empty/u);
  });

  it("reports an invalid regular expression instead of matching nothing", () => {
    expect(() => buildGrepRegExp({ pattern: "([a-z", regex: true })).toThrow(
      /not a valid regular expression/u,
    );
  });

  it("is case sensitive by default and case insensitive on request", () => {
    expect(buildGrepRegExp({ pattern: "abc" }).flags).toBe("gu");
    expect(buildGrepRegExp({ pattern: "abc", caseSensitive: false }).flags).toContain("i");
  });

  it("wholeWord uses identifier boundaries, not ASCII \\b", () => {
    const expression = buildGrepRegExp({ pattern: "gate", wholeWord: true });
    expression.lastIndex = 0;
    expect(expression.test("gateway")).toBe(false);
    expression.lastIndex = 0;
    expect(expression.test("the gate is open")).toBe(true);
  });
});

describe("grepIndexedChunks", () => {
  it("finds a literal with the real file line number", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "createGateway" });
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]?.line).toBe(11);
    expect(result.matches[0]?.column).toBe(17);
  });

  it("returns context lines bounded by the chunk", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "createGateway",
      contextLinesBefore: 5,
      contextLinesAfter: 5,
    });
    expect(result.matches[0]?.before.map((line) => line.line)).toEqual([10]);
    expect(result.matches[0]?.after.map((line) => line.line)).toEqual([12]);
  });

  it("is case sensitive by default", async () => {
    const { store } = await harness();
    const sensitive = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "GATEWAY" });
    expect(sensitive.matches.map((match) => match.filePath)).toEqual(["src/b.ts"]);
    const insensitive = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "GATEWAY",
      caseSensitive: false,
    });
    expect(insensitive.totalMatches).toBeGreaterThan(1);
  });

  it("filters by language and by path", async () => {
    const { store } = await harness();
    const byLanguage = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "gateway",
      languages: ["markdown"],
    });
    expect(byLanguage.matches.map((match) => match.filePath)).toEqual(["docs/readme.md"]);
    const byPath = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "gateway",
      pathGlob: ["src/**"],
    });
    expect(byPath.matches.every((match) => match.filePath.startsWith("src/"))).toBe(true);
  });

  it("records a chunk without stored content instead of ignoring it", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "gateway" });
    expect(result.skipped.some((entry) => entry.detail.includes("no stored content"))).toBe(true);
  });

  it("names its truncation reason", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "e",
      maxMatches: 2,
    });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_matches");
  });

  it("caps matches per file and says so", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "e",
      maxMatchesPerFile: 1,
      maxMatches: 100,
    });
    const perFile = new Map<string, number>();
    for (const match of result.matches) {
      perFile.set(match.filePath, (perFile.get(match.filePath) ?? 0) + 1);
    }
    expect([...perFile.values()].every((count) => count <= 1)).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("stops at the scan budget with a named reason", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "gateway",
      maxScannedChunks: 1,
    });
    expect(result.scannedChunks).toBe(1);
    expect(result.truncationReason).toBe("max_scanned_chunks");
  });

  it("reports how much was scanned even without a single match", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "zzz" });
    expect(result.totalMatches).toBe(0);
    expect(result.scannedChunks).toBe(FIXTURES.length);
  });

  it("warns when it had no collection to search at all", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [], { pattern: "gateway" });
    expect(result.warnings.map((warning) => warning.code)).toContain("NO_COLLECTIONS");
  });

  it("does not loop forever on a zero-length match", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], {
      pattern: "x*",
      regex: true,
      maxMatches: 5,
    });
    expect(result.matches.length).toBeLessThanOrEqual(5);
  });

  it("finds every occurrence in one line", async () => {
    const { store } = await harness([{ chunkId: "c1", filePath: "src/x.ts", content: "aa aa aa" }]);
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "aa" });
    expect(result.totalMatches).toBe(3);
    expect(result.matches.map((match) => match.column)).toEqual([1, 4, 7]);
  });

  it("deduplicates the same match reported by two overlapping fragments", async () => {
    const { store } = await harness([
      { chunkId: "c1", filePath: "src/x.ts", fileId: "f1", content: "gateway", startLine: 3 },
      { chunkId: "c2", filePath: "src/x.ts", fileId: "f1", content: "gateway", startLine: 3 },
    ]);
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "gateway" });
    expect(result.totalMatches).toBe(1);
  });

  it("keeps provenance on every match", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "gateway" });
    for (const match of result.matches) {
      expect(match.repoId).not.toBe("");
      expect(match.refId).not.toBe("");
      expect(match.chunkId).not.toBe("");
    }
  });

  it("uses a page size that is documented, not accidental", () => {
    expect(GREP_DEFAULTS.scrollPageSize).toBeGreaterThan(0);
  });
});

describe("sortGrepMatches", () => {
  const base: GrepMatchV1 = {
    repoId: "r",
    repoLabel: "r",
    refId: "ref",
    refName: "main",
    fileId: "f1",
    filePath: "src/a.ts",
    language: "typescript",
    chunkId: "c",
    line: 1,
    column: 1,
    matchText: "x",
    lineText: "x",
    before: [],
    after: [],
  };

  it("sorts by path, line and column", () => {
    const sorted = sortGrepMatches(
      [
        { ...base, filePath: "src/b.ts" },
        { ...base, line: 5 },
        { ...base, line: 1, column: 9 },
        { ...base },
      ],
      "path",
    );
    expect(sorted.map((match) => `${match.filePath}:${match.line}:${match.column}`)).toEqual([
      "src/a.ts:1:1",
      "src/a.ts:1:9",
      "src/a.ts:5:1",
      "src/b.ts:1:1",
    ]);
  });

  it("sorts files with more matches first", () => {
    const sorted = sortGrepMatches(
      [
        { ...base, fileId: "f1", filePath: "src/a.ts" },
        { ...base, fileId: "f2", filePath: "src/b.ts" },
        { ...base, fileId: "f2", filePath: "src/b.ts", line: 2 },
      ],
      "matches-desc",
    );
    expect(sorted[0]?.filePath).toBe("src/b.ts");
  });
});

// ---------------------------------------------------------------------------
// Regressionen aus der adversarialen Pruefung (Welle 3)
// ---------------------------------------------------------------------------

describe("assertSafeGrepPattern", () => {
  it("lehnt eine Wiederholung ueber einer Wiederholung ab (katastrophales Backtracking)", () => {
    for (const pattern of ["(a+)+$", "(a*)*", "(a+)*", "((ab)+)+", "(\\w+\\s?)+$", "(a+){2,}"]) {
      expect(() => assertSafeGrepPattern(pattern)).toThrow(/rejected as unsafe/u);
    }
  });

  it("laesst gewoehnliche Muster durch", () => {
    for (const pattern of [
      "a+",
      "[a-z]*",
      "(foo|bar)",
      "(foo|bar)+",
      "\\d{2,4}",
      "^export function \\w+\\(",
      "gateway\\.send\\(.*\\)",
      "[a+]+",
      "a\\+\\+",
      "(?:abc)+",
    ]) {
      expect(() => assertSafeGrepPattern(pattern)).not.toThrow();
    }
  });

  it("greift auch ueber buildGrepRegExp, aber nur fuer echte Regex-Anfragen", () => {
    expect(() => buildGrepRegExp({ pattern: "(a+)+$", regex: true })).toThrow(
      /rejected as unsafe/u,
    );
    // Als Literal ist derselbe Text harmlos — er wird maskiert.
    expect(() => buildGrepRegExp({ pattern: "(a+)+$" })).not.toThrow();
  });

  it("kehrt bei genau dem gemeldeten Fall sofort zurueck statt Minuten zu blockieren", async () => {
    const { engine } = await harness([
      { chunkId: "c-dos", filePath: "src/dos.ts", content: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" },
    ]);
    const started = process.hrtime.bigint();
    await expect(
      engine.grep({ pattern: "(a+)+$", regex: true, maxScannedChunks: 1 }),
    ).rejects.toThrow(/rejected as unsafe/u);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
  });

  // -------------------------------------------------------------------------
  // Nachpruefung Welle 3b, Befund A2: der gezeigte Fall war zu, die naheliegende
  // Variante derselben Familie ging weiter durch. `(\s|\t)+$` ist die Suche
  // nach Zeilenendleerraum — ein alltaegliches Muster, das ueber die
  // Alternative (statt ueber einen verschachtelten Quantor) mehrdeutig wird.
  // Ohne die Reparatur kehrt dieser Aufruf NIE zurueck; der Test laeuft dann
  // in das Zeitlimit von vitest.
  // -------------------------------------------------------------------------
  it("kehrt auch bei der Alternativen-Variante sofort zurueck statt nie", async () => {
    const { engine } = await harness([
      { chunkId: "c-dos", filePath: "src/dos.ts", content: `${"\t".repeat(28)}x` },
    ]);
    const started = process.hrtime.bigint();
    await expect(
      engine.grep({ pattern: "(\\s|\\t)+$", regex: true, maxScannedChunks: 1 }),
    ).rejects.toThrow(/rejected as unsafe/u);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("laesst die frueher ueber-gesperrten, hoechstens polynomiellen Muster wieder laufen", async () => {
    const { engine } = await harness([
      { chunkId: "c-ok", filePath: "src/ok.ts", content: "aaab and file.name.ext" },
    ]);
    const found = await engine.grep({ pattern: "(a+b)+", regex: true });
    expect(found.matches.map((match) => match.matchText)).toEqual(["aaab"]);
    const dotted = await engine.grep({ pattern: "(\\w+\\.)+", regex: true });
    expect(dotted.matches.map((match) => match.matchText)).toEqual(["file.name."]);
  });
});

describe("grepIndexedChunks: E4 und Geltungsbereich", () => {
  it("schreibt glob-ausgeschlossene Chunks in den Skip-Ledger", async () => {
    const { engine } = await harness();
    const result = await engine.grep({ pattern: "gateway", pathExclude: ["docs/**"] });
    expect(result.matches.every((match) => !match.filePath.startsWith("docs/"))).toBe(true);
    const globEntries = result.skipped.filter((entry) =>
      entry.detail.includes("include/exclude globs"),
    );
    expect(globEntries.length).toBeGreaterThan(0);
    expect(globEntries[0]?.reason).toBe("excluded_by_configuration");
    expect(globEntries.some((entry) => entry.path === "docs/readme.md")).toBe(true);
  });

  it("sucht nur im Workspace der Vorgaben", async () => {
    const { engine } = await harness([
      { chunkId: "c-own", filePath: "src/own.ts", content: "gateway here" },
      {
        chunkId: "c-foreign",
        workspaceId: "ws-someone-else",
        filePath: "secret/foreign.ts",
        content: "gateway here",
      },
    ]);
    const result = await engine.grep({ pattern: "gateway" });
    expect(result.matches.map((match) => match.filePath)).toEqual(["src/own.ts"]);
  });

  it("lehnt ein fehlerhaftes Glob-Muster ab, statt mitten im Scan zu scheitern", async () => {
    const { engine } = await harness();
    await expect(engine.grep({ pattern: "gateway", pathExclude: ["[z-a]"] })).rejects.toThrow(
      /pathExclude/u,
    );
  });

  it("warnt, wenn ganz ohne Workspace gesucht wird", async () => {
    const { store } = await harness();
    const result = await grepIndexedChunks(store, [TEST_COLLECTION], { pattern: "gateway" });
    expect(result.warnings.map((warning) => warning.code)).toContain("WORKSPACE_UNSCOPED");
  });
});

describe("grepIndexedChunks: fehlendes start_line", () => {
  it("meldet, dass die Zeilennummern eines Chunks ohne start_line geraten sind", async () => {
    const { engine, store } = await harness();
    await store.upsert(TEST_COLLECTION, [
      {
        id: "c-no-start-line",
        dense: new Array<number>(64).fill(0.1),
        payload: {
          point_type: "code_chunk",
          workspace_id: TEST_WORKSPACE_ID,
          repo_id: "repo-a",
          ref_id: "ref-main",
          file_id: "f-no-start-line",
          file_path: "src/no-start-line.ts",
          chunk_id: "c-no-start-line",
          metrics_scope_id: "c-no-start-line",
          content: "the gateway lives here",
        },
      },
    ]);
    const result = await engine.grep({ pattern: "gateway" });
    expect(result.matches.some((match) => match.chunkId === "c-no-start-line")).toBe(true);
    expect(
      result.skipped.some(
        (entry) => entry.subjectId === "c-no-start-line" && entry.detail.includes("no start_line"),
      ),
    ).toBe(true);
  });
});
