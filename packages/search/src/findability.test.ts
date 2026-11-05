import type { FindabilityV1 } from "@untangle-code/domain";
import {
  UntangleError,
  assertFindabilityMeasured,
  isFindabilityMeasured,
  isFindabilityUnavailable,
  validateFindability,
} from "@untangle-code/domain";
import { FakeClock } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import {
  DISPERSION_FORMULA,
  FINDABILITY_THRESHOLDS,
  computeDispersion,
  detectRetrievalFailure,
  findabilitySkipEntry,
  measureFindability,
  rankScore,
} from "./findability.js";
import type { FindabilitySubject } from "./findability.js";
import type { SearchPort } from "./port.js";
import type { ChunkFixture } from "./testing/in-memory-index.js";
import { TEST_WORKSPACE_ID, buildInMemorySearchEngine } from "./testing/in-memory-index.js";

const WELL_NAMED: ChunkFixture = {
  chunkId: "c-rotate",
  filePath: "src/auth/token-rotation.ts",
  symbolId: "sym-rotate",
  symbolName: "rotateToken",
  symbolFqn: "TokenService.rotateToken",
  symbolKind: "function",
  signature: "rotateToken(token: Token): Token",
  content: "export function rotateToken(token: Token) {\n  return sign(refresh(token));\n}",
};

const NOISE: ChunkFixture[] = [0, 1, 2, 3].map((index) => ({
  chunkId: `c-noise-${index}`,
  filePath: `src/misc/handler-${index}.ts`,
  symbolId: `sym-noise-${index}`,
  symbolName: `doStuff${index}`,
  symbolFqn: `Misc.doStuff${index}`,
  content: `export function doStuff${index}(token: Token) { return handle(token); }`,
}));

/**
 * Bequemlichkeit fuer die Faelle, in denen die Suche laeuft: entpackt das
 * Ergebnis auf die MESSUNG und wirft, falls doch ein Zustandsvermerk kommt.
 * Genau diese Unterscheidung erzwingt `FindabilityOutcomeV1` seit vision.md
 * §1d — deshalb steht sie hier sichtbar und nicht als Typzusicherung.
 */
async function measure(...args: Parameters<typeof measureFindability>): Promise<FindabilityV1> {
  return assertFindabilityMeasured(await measureFindability(...args), "test measurement");
}

function subject(overrides: Partial<FindabilitySubject> = {}): FindabilitySubject {
  return {
    workspaceId: TEST_WORKSPACE_ID,
    repoId: "repo-a",
    refId: "ref-main",
    symbolId: "sym-rotate",
    symbolName: "rotateToken",
    symbolFqn: "TokenService.rotateToken",
    filePath: "src/auth/token-rotation.ts",
    signature: "rotateToken(token: Token): Token",
    ...overrides,
  };
}

describe("rankScore", () => {
  it("is 0 without a rank, 1 at rank 1 and 0.5 at rank 2", () => {
    expect(rankScore(null)).toBe(0);
    expect(rankScore(1)).toBe(1);
    expect(rankScore(2)).toBe(0.5);
  });
});

describe("computeDispersion", () => {
  it("is 0 when every hit is in one file", () => {
    expect(computeDispersion(["a.ts", "a.ts", "a.ts"], 3).dispersion).toBe(0);
  });

  it("is 1 when every hit is in a different file", () => {
    expect(computeDispersion(["a.ts", "b.ts", "c.ts"], 0).dispersion).toBe(1);
  });

  it("stays within [0, 1] for a single hit", () => {
    const dispersion = computeDispersion(["a.ts"], 1).dispersion;
    expect(dispersion).toBeGreaterThanOrEqual(0);
    expect(dispersion).toBeLessThanOrEqual(1);
  });

  it("counts distinct files and total hits", () => {
    const dispersion = computeDispersion(["a.ts", "a.ts", "b.ts"], 2);
    expect(dispersion.matchedFileCount).toBe(2);
    expect(dispersion.matchedHitCount).toBe(3);
    expect(dispersion.ownFileHitCount).toBe(2);
  });
});

describe("measureFindability", () => {
  it("gives a well-named, isolated symbol a high score and no diagnosis", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const record = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(validateFindability(record)).toEqual([]);
    expect(record.nameProbe.rank).toBe(1);
    expect(record.score).toBeGreaterThan(0.6);
    expect(record.diagnoses).toEqual([]);
  });

  it("marks a symbol that its own name does not retrieve as undocumented", async () => {
    const { engine } = await buildInMemorySearchEngine(NOISE);
    const record = await measure(
      engine,
      subject({ symbolId: "sym-missing", symbolName: "zzzUnfindableSymbolZzz" }),
      new FakeClock(0),
      { generationId: "gen-1" },
    );
    expect(validateFindability(record)).toEqual([]);
    expect(record.nameProbe.rank).toBeNull();
    expect(record.nameProbe.rankMissingReason).toBeDefined();
    expect(record.diagnoses.map((diagnosis) => diagnosis.cause)).toContain("undocumented");
  });

  it("diagnoses weak naming when the symbol ranks below the threshold for its own name", async () => {
    // Vier gleichnamige Geschwister: der gesuchte rankt nicht mehr oben.
    const siblings: ChunkFixture[] = [0, 1, 2, 3, 4].map((index) => ({
      chunkId: `c-handler-${index}`,
      filePath: `src/misc/handler-${index}.ts`,
      symbolId: `sym-handler-${index}`,
      symbolName: "handle",
      symbolFqn: `Misc${index}.handle`,
      content: "export function handle(input: unknown) { return process(input); }",
    }));
    const { engine } = await buildInMemorySearchEngine(siblings);
    const record = await measure(
      engine,
      subject({
        symbolId: "sym-handler-4",
        symbolName: "handle",
        symbolFqn: "Misc4.handle",
        filePath: "src/misc/handler-4.ts",
        signature: "handle(input: unknown): unknown",
      }),
      new FakeClock(0),
      { generationId: "gen-1" },
    );
    expect(validateFindability(record)).toEqual([]);
    expect(record.nameProbe.rank).not.toBeNull();
    expect(record.nameProbe.rank ?? 0).toBeGreaterThan(FINDABILITY_THRESHOLDS.weakRank);
    expect(record.diagnoses.map((diagnosis) => diagnosis.cause)).toContain("weak-naming");
  });

  it("records a hop count of null WITH a named reason when no graph lookup is wired (E4)", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const record = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(record.hops.hops).toBeNull();
    expect(record.hops.hopsMissingReason).toBe("no_symbol_graph_lookup_wired");
  });

  it("diagnoses high entanglement from an injected hop lookup", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED, ...NOISE]);
    const record = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
      hops: () => ({
        hops: 5,
        path: ["a", "b", "c"],
        pathUsesUncertainEdges: false,
      }),
    });
    expect(validateFindability(record)).toEqual([]);
    expect(record.diagnoses.map((diagnosis) => diagnosis.cause)).toContain("high-entanglement");
  });

  it("lowers the confidence of an entanglement diagnosis built on uncertain edges", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const certain = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
      hops: () => ({ hops: 5, path: ["a"], pathUsesUncertainEdges: false }),
    });
    const uncertain = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
      hops: () => ({ hops: 5, path: ["a"], pathUsesUncertainEdges: true }),
    });
    const certainValue =
      certain.diagnoses.find((d) => d.cause === "high-entanglement")?.confidence.value ?? 0;
    const uncertainValue =
      uncertain.diagnoses.find((d) => d.cause === "high-entanglement")?.confidence.value ?? 0;
    expect(uncertainValue).toBeLessThan(certainValue);
  });

  it("is structurally a heuristic: every diagnosis says so and carries evidence", async () => {
    const { engine } = await buildInMemorySearchEngine(NOISE);
    const record = await measure(
      engine,
      subject({ symbolId: "sym-missing", symbolName: "zzzUnfindableSymbolZzz" }),
      new FakeClock(0),
      { generationId: "gen-1" },
    );
    expect(record.isHeuristic).toBe(true);
    expect(record.confidence.basis).toBe("heuristic");
    for (const diagnosis of record.diagnoses) {
      expect(diagnosis.isHeuristic).toBe(true);
      expect(diagnosis.confidence.basis).toBe("heuristic");
      expect(diagnosis.evidence.length).toBeGreaterThan(0);
    }
  });

  it("names the formula behind its dispersion value", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const record = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(record.dispersionFormula).toBe(DISPERSION_FORMULA);
  });

  it("stamps algorithm, ranker version and a deterministic id", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const first = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    const second = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-2",
    });
    expect(first.algorithm).toBe("untangle-findability-v1");
    expect(first.rankerVersion).toBe("untangle-ranker-v2");
    expect(second.findabilityId).toBe(first.findabilityId);
  });

  it("takes 'now' from the injected clock, never from the wall clock", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const record = await measure(
      engine,
      subject(),
      new FakeClock(Date.parse("2026-03-04T05:06:07.000Z")),
      { generationId: "gen-1" },
    );
    expect(record.measuredAt).toBe("2026-03-04T05:06:07.000Z");
  });

  it("uses the fingerprint of the probe query, so two runs are comparable", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const record = await measure(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(record.nameProbe.queryFingerprint).toHaveLength(64);
    expect(record.signatureProbe.queryFingerprint).not.toBe(record.nameProbe.queryFingerprint);
  });
});

/**
 * vision.md §1d gilt NUR bei nachweislich funktionierendem Abruf.
 *
 * Die Tests hier decken die drei Wege ab, auf denen der Abruf ausfallen kann,
 * und pruefen fuer jeden dasselbe: es entsteht ein ZUSTANDSVERMERK und keine
 * Messung — also auch keine Diagnose, kein Score und keine Ursache, die man
 * dem Code anhaengen koennte.
 */
describe("measureFindability when retrieval fails", () => {
  const boom = new UntangleError("QDRANT_UNAVAILABLE", "connection refused", {
    retryable: true,
  });

  /** Ein Port, dessen Suche wirft. */
  const throwingPort: SearchPort = {
    search: () => Promise.reject(boom),
    grep: () => Promise.reject(boom),
  };

  /**
   * Ein Port, der NICHT wirft, sondern nach spec.md §25.2 sichtbar degradiert:
   * das Ergebnis kommt ohne Gruppe und mit einer Warnung zurueck. Das ist der
   * heimtueckische Fall — er sieht von aussen aus wie „nichts gefunden".
   */
  async function degradedPort(code: string): Promise<SearchPort> {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    return {
      search: async (request, options) => {
        const set = await engine.search(request, options);
        return {
          ...set,
          groups: [],
          totalHits: 0,
          warnings: [
            ...set.warnings,
            { code, message: `profile "p" could not be searched: ${code}` },
          ],
        };
      },
      grep: (request, options) => engine.grep(request, options),
    };
  }

  it("returns a status note, not a measurement, when the store is unreachable", async () => {
    const outcome = await measureFindability(throwingPort, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(isFindabilityUnavailable(outcome)).toBe(true);
    expect(isFindabilityMeasured(outcome)).toBe(false);
    if (!isFindabilityUnavailable(outcome)) throw new Error("expected a status note");
    expect(outcome.reason).toBe("search_unavailable");
    expect(outcome.detail).toContain("QDRANT_UNAVAILABLE");
    expect(outcome.retrievalPerformed).toBe(false);
    expect(outcome.probeKinds).toEqual(["self-name", "self-signature"]);
  });

  it("returns a status note when the engine degrades a failed profile into a warning", async () => {
    const port = await degradedPort("PROFILE_UNAVAILABLE");
    const outcome = await measureFindability(port, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(isFindabilityUnavailable(outcome)).toBe(true);
  });

  it("returns a status note when the symbol is not indexed", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const outcome = await measureFindability(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
      isSymbolIndexed: () => false,
    });
    if (!isFindabilityUnavailable(outcome)) throw new Error("expected a status note");
    expect(outcome.reason).toBe("symbol_not_indexed");
  });

  it("NEVER produces a diagnosis from a failed search — for any failure mode", async () => {
    const ports: SearchPort[] = [
      throwingPort,
      await degradedPort("QDRANT_UNAVAILABLE"),
      await degradedPort("EMBEDDING_UNAVAILABLE"),
      await degradedPort("INDEX_PROFILE_MISMATCH"),
      await degradedPort("INDEX_INCOMPLETE"),
    ];
    for (const port of ports) {
      const outcome = await measureFindability(port, subject(), new FakeClock(0), {
        generationId: "gen-1",
      });
      // Der Zustandsvermerk KANN keine Diagnose tragen — er hat das Feld nicht.
      expect(isFindabilityMeasured(outcome)).toBe(false);
      expect(Object.keys(outcome)).not.toContain("diagnoses");
      expect(Object.keys(outcome)).not.toContain("score");
    }
    // Und die Vorpruefung ebenso.
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const notIndexed = await measureFindability(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
      isSymbolIndexed: () => false,
    });
    expect(isFindabilityMeasured(notIndexed)).toBe(false);
    expect(Object.keys(notIndexed)).not.toContain("diagnoses");
  });

  it("refuses to hand a status note to code that expects a measurement", async () => {
    const outcome = await measureFindability(throwingPort, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(() => assertFindabilityMeasured(outcome, "hotspot list")).toThrow(
      /statement about the tool, never about the code/,
    );
  });

  it("writes the failed probe into the skip ledger instead of swallowing it (E4)", async () => {
    const outcome = await measureFindability(throwingPort, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    if (!isFindabilityUnavailable(outcome)) throw new Error("expected a status note");
    const entry = findabilitySkipEntry(outcome);
    expect(entry.stage).toBe("findability");
    expect(entry.reason).toBe("provider_unavailable");
    expect(entry.detail).toContain("TokenService.rotateToken");
    expect(entry.recoverable).toBe(true);
  });

  it("takes 'now' for the status note from the injected clock", async () => {
    const outcome = await measureFindability(
      throwingPort,
      subject(),
      new FakeClock(Date.parse("2026-03-04T05:06:07.000Z")),
      { generationId: "gen-9" },
    );
    if (!isFindabilityUnavailable(outcome)) throw new Error("expected a status note");
    expect(outcome.observedAt).toBe("2026-03-04T05:06:07.000Z");
    expect(outcome.generationId).toBe("gen-9");
  });
});

describe("detectRetrievalFailure", () => {
  it("treats a result set without any profile group as a failed retrieval", async () => {
    const { engine } = await buildInMemorySearchEngine([WELL_NAMED]);
    const set = await engine.search({ workspaceId: TEST_WORKSPACE_ID, query: "rotateToken" });
    expect(detectRetrievalFailure(set)).toBeUndefined();
    expect(detectRetrievalFailure({ ...set, groups: [] })?.reason).toBe("search_profile_missing");
  });

  // -------------------------------------------------------------------------
  // Nachpruefung Welle 3b, Befund B1 (Fall B): der Abrufkern liefert bei einem
  // Ziel, dessen Repositories den Geltungsbereich der Sonde gar nicht
  // schneiden, eine LEERE GRUPPE mit Begruendung — keine fehlende Gruppe.
  // `groups.length === 0` sieht das nicht; die Sonde hielt sich fuer gelaufen
  // und veroeffentlichte „no_match" plus die Diagnose „undocumented" ueber ein
  // Symbol, nach dem nie gesucht wurde.
  // -------------------------------------------------------------------------
  it("treats a profile group that was never searched as a failed retrieval", async () => {
    const { engine } = await buildInMemorySearchEngine([{ ...WELL_NAMED, repoId: "repo-other" }]);
    const set = await engine.search({
      workspaceId: TEST_WORKSPACE_ID,
      query: "rotateToken",
      repositories: ["repo-a"],
    });
    expect(set.groups).toHaveLength(1);
    expect(set.groups[0]?.hits).toHaveLength(0);
    expect(set.groups[0]?.notSearchedReason).toContain("this target was not searched");
    const failure = detectRetrievalFailure(set);
    expect(failure?.reason).toBe("probe_not_executed");
    expect(failure?.detail).toContain("this target was not searched");
  });
});

describe("measureFindability when the probe's scope was never searched", () => {
  it("returns a status note instead of claiming the symbol is undocumented", async () => {
    // Das Symbol liegt in "repo-a"; das einzige verdrahtete Ziel deklariert
    // "repo-other". Die Sonde kann es also gar nicht erreichen.
    const { engine } = await buildInMemorySearchEngine([{ ...WELL_NAMED, repoId: "repo-other" }]);
    const outcome = await measureFindability(engine, subject(), new FakeClock(0), {
      generationId: "gen-1",
    });
    expect(isFindabilityMeasured(outcome)).toBe(false);
    if (!isFindabilityUnavailable(outcome)) throw new Error("expected a status note");
    expect(outcome.reason).toBe("probe_not_executed");
    expect(outcome.retrievalPerformed).toBe(false);
    // Weder Score noch Diagnose duerfen ueberhaupt existieren.
    expect(Object.keys(outcome)).not.toContain("score");
    expect(Object.keys(outcome)).not.toContain("diagnoses");
    // Und der Grund ist der WORTLAUT der Suche, nicht eine eigene Erfindung.
    expect(outcome.detail).toContain("are not part of this target's repositories");
  });
});
