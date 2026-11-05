import type { SearchHitV1 } from "@untangle-code/domain";
import { RANKER_VERSION } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { sortHits } from "./sort.js";

function hit(dedupeKey: string, overrides: Partial<SearchHitV1> = {}): SearchHitV1 {
  return {
    schemaVersion: 1,
    rank: 0,
    repoId: "repo-a",
    repoLabel: "repo-a",
    refId: "ref-main",
    refName: "main",
    fileId: "file-1",
    filePath: "src/a.ts",
    range: { startLine: 1, endLine: 2, startByte: 0, endByte: 10 },
    language: "typescript",
    parseQuality: "complete",
    chunkId: dedupeKey,
    chunkKind: "function",
    dedupeKey,
    score: {
      schemaVersion: 1,
      final: 0.5,
      components: [{ kind: "base_hybrid", rawValue: 0.5, weight: 1, contribution: 0.5 }],
      inputs: {},
      rankerVersion: RANKER_VERSION,
      clamped: false,
    },
    relatedFragments: [],
    embeddingProfileId: "profile-1",
    indexGeneration: "gen-1",
    ...overrides,
  };
}

function atLine(startLine: number): SearchHitV1["range"] {
  return { startLine, endLine: startLine, startByte: 0, endByte: 10 };
}

const REPO_READS = ["second.repoId", "first.repoId"];
const PATH_READS = [...REPO_READS, "second.filePath", "first.filePath"];
const LINE_READS = [
  "second.range",
  "second.range.startLine",
  "first.range",
  "first.range.startLine",
];

function observedHit(
  label: string,
  trace: string[],
  overrides: Partial<SearchHitV1> = {},
  options: {
    failureEvent?: string;
    failure?: Error;
    lineValues?: readonly number[];
    throwLineRead?: number;
  } = {},
): SearchHitV1 {
  const original = hit(label, overrides);
  let lineReads = 0;
  function record(event: string): void {
    trace.push(event);
    if (event === options.failureEvent) throw options.failure;
  }
  const range = new Proxy(original.range, {
    get(object, key, receiver) {
      record(`${label}.range.${String(key)}`);
      if (key === "startLine") {
        lineReads += 1;
        if (lineReads === options.throwLineRead) throw options.failure;
        if (options.lineValues !== undefined) return options.lineValues[lineReads - 1];
      }
      return Reflect.get(object, key, receiver);
    },
  });
  return new Proxy(original, {
    get(object, key, receiver) {
      record(`${label}.${String(key)}`);
      return key === "range" ? range : Reflect.get(object, key, receiver);
    },
  });
}

describe("path sort output and input preservation", () => {
  it("returns fresh arrays for empty and singleton frozen inputs without reading hit properties", () => {
    const empty = Object.freeze([] as SearchHitV1[]);
    expect(sortHits(empty, "path")).toEqual([]);
    expect(sortHits(empty, "path")).not.toBe(empty);
    const trace: string[] = [];
    const only = observedHit(
      "only",
      trace,
      {},
      { failureEvent: "only.repoId", failure: new Error("unvisited") },
    );
    const singleton = Object.freeze([only]);
    const result = sortHits(singleton, "path");
    expect(trace).toEqual([]);
    expect(result).not.toBe(singleton);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(only);
  });

  it("orders repository, file path, start line and dedupe key in that priority", () => {
    const repoB = hit("a", { repoId: "repo-b", filePath: "a", range: atLine(0) });
    const pathB = hit("a", { filePath: "b", range: atLine(0) });
    const line9 = hit("a", { filePath: "a", range: atLine(9) });
    const line1z = hit("z", { filePath: "a", range: atLine(1) });
    const line1a = hit("a", { filePath: "a", range: atLine(1) });
    const result = sortHits([repoB, line9, pathB, line1z, line1a], "path");
    const expected = [line1a, line1z, line9, pathB, repoB];
    expect(result).toHaveLength(expected.length);
    expected.forEach((entry, index) => expect(result[index]).toBe(entry));
  });

  it("preserves stable full ties, distinct hit identities and repeated references", () => {
    const first = hit("same", { chunkId: "first" });
    const second = hit("same", { chunkId: "second" });
    const third = hit("same", { chunkId: "third" });
    const input = [first, second, first, third];
    const result = sortHits(input, "path");
    expect(result).not.toBe(input);
    expect(result).toHaveLength(4);
    input.forEach((entry, index) => expect(result[index]).toBe(entry));
  });

  it("uses the current relational Unicode ordering for repository, path and dedupe ties", () => {
    const ids = ["é", "😀", "\uE000", "a", "e\u0301", "Z"];
    for (const field of ["repoId", "filePath", "dedupeKey"] as const) {
      const input = ids.map((value) => hit("same", { [field]: value }));
      expect(sortHits(input, "path").map((entry) => entry[field])).toEqual([
        "Z",
        "a",
        "e\u0301",
        "é",
        "😀",
        "\uE000",
      ]);
    }
  });

  it("sorts deeply frozen hits deterministically without mutating inputs or cloning hits", () => {
    const z = hit("z");
    const a = hit("a");
    for (const entry of [z, a]) {
      Object.freeze(entry.range);
      Object.freeze(entry.score.inputs);
      entry.score.components.forEach(Object.freeze);
      Object.freeze(entry.score.components);
      Object.freeze(entry.score);
      Object.freeze(entry.relatedFragments);
      Object.freeze(entry);
    }
    const input = Object.freeze([z, a]);
    const before = JSON.stringify(input);
    const first = sortHits(input, "path");
    const second = sortHits(input, "path");
    expect(first[0]).toBe(a);
    expect(first[1]).toBe(z);
    expect(second[0]).toBe(a);
    expect(second[1]).toBe(z);
    expect(first).not.toBe(second);
    expect(JSON.stringify(input)).toBe(before);
    expect(input[0]).toBe(z);
    expect(input[1]).toBe(a);
  });
});

describe("path comparator short-circuit and exception order", () => {
  it("stops after repository comparison before path, range or dedupe reads", () => {
    const trace: string[] = [];
    const first = observedHit("first", trace, { repoId: "z" });
    const second = observedHit("second", trace, { repoId: "a" });
    const result = sortHits([first, second], "path");
    expect(trace).toEqual(REPO_READS);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
  });

  it("stops after path comparison before range or dedupe reads", () => {
    const trace: string[] = [];
    const first = observedHit("first", trace, { filePath: "z" });
    const second = observedHit("second", trace, { filePath: "a" });
    const result = sortHits([first, second], "path");
    expect(trace).toEqual(PATH_READS);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
  });

  it("reads unequal start lines twice and returns their difference without dedupe reads", () => {
    const trace: string[] = [];
    const first = observedHit("first", trace, { range: atLine(9) });
    const second = observedHit("second", trace, { range: atLine(2) });
    const result = sortHits([first, second], "path");
    expect(trace).toEqual([...PATH_READS, ...LINE_READS, ...LINE_READS]);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
  });

  it("reads equal start lines once before reading dedupe keys in operand order", () => {
    const trace: string[] = [];
    const first = observedHit("first", trace, { dedupeKey: "z" });
    const second = observedHit("second", trace, { dedupeKey: "a" });
    const result = sortHits([first, second], "path");
    expect(trace).toEqual([...PATH_READS, ...LINE_READS, "second.dedupeKey", "first.dedupeKey"]);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
  });

  it.each(["repoId", "filePath", "range", "range.startLine", "dedupeKey"] as const)(
    "preserves the exact %s getter error and its access prefix",
    (level) => {
      const trace: string[] = [];
      const failure = new Error(`unavailable ${level}`);
      const first = observedHit("first", trace);
      const second = observedHit("second", trace, {}, { failureEvent: `second.${level}`, failure });
      let caught: unknown;
      try {
        sortHits([first, second], "path");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      const complete = [...PATH_READS, ...LINE_READS, "second.dedupeKey", "first.dedupeKey"];
      expect(trace).toEqual(complete.slice(0, complete.indexOf(`second.${level}`) + 1));
    },
  );

  it("uses the second dynamic line reads even when they reverse the initial inequality", () => {
    const trace: string[] = [];
    const first = observedHit("first", trace, {}, { lineValues: [1, 100] });
    const second = observedHit("second", trace, {}, { lineValues: [2, 0] });
    const result = sortHits([first, second], "path");
    expect(trace).toEqual([...PATH_READS, ...LINE_READS, ...LINE_READS]);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
  });

  it("keeps a dynamic zero difference stable without consulting dedupe keys", () => {
    const trace: string[] = [];
    const first = observedHit("first", trace, { dedupeKey: "z" }, { lineValues: [1, 7] });
    const second = observedHit("second", trace, { dedupeKey: "a" }, { lineValues: [2, 7] });
    const result = sortHits([first, second], "path");
    expect(trace).toEqual([...PATH_READS, ...LINE_READS, ...LINE_READS]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  it("propagates the exact error from a second start-line read before reading the other operand", () => {
    const trace: string[] = [];
    const failure = new Error("second line read failed");
    const first = observedHit("first", trace, {}, { lineValues: [1, 100] });
    const second = observedHit(
      "second",
      trace,
      {},
      { lineValues: [2, 0], throwLineRead: 2, failure },
    );
    let caught: unknown;
    try {
      sortHits([first, second], "path");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(trace).toEqual([...PATH_READS, ...LINE_READS, "second.range", "second.range.startLine"]);
  });
});

describe("path comparator current numeric and malformed runtime behavior", () => {
  it.each([true, false])(
    "keeps NaN line comparison stable with NaN first=%s without a dedupe fallback",
    (nanFirst) => {
      const first = hit("z", { range: atLine(nanFirst ? Number.NaN : 1) });
      const second = hit("a", { range: atLine(nanFirst ? 1 : Number.NaN) });
      const result = sortHits([first, second], "path");
      expect(result[0]).toBe(first);
      expect(result[1]).toBe(second);
    },
  );

  it("orders unequal infinite and finite start lines numerically", () => {
    const high = hit("high", { range: atLine(Number.POSITIVE_INFINITY) });
    const low = hit("low", { range: atLine(Number.NEGATIVE_INFINITY) });
    const finite = hit("finite", { range: atLine(0) });
    const result = sortHits([high, low, finite], "path");
    expect(result[0]).toBe(low);
    expect(result[1]).toBe(finite);
    expect(result[2]).toBe(high);
  });

  it("uses dedupe order for equal infinities rather than subtracting them", () => {
    const z = hit("z", { range: atLine(Number.POSITIVE_INFINITY) });
    const a = hit("a", { range: atLine(Number.POSITIVE_INFINITY) });
    const result = sortHits([z, a], "path");
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(z);
  });

  it("treats signed zeros as equal lines and preserves their original signs", () => {
    const z = hit("z", { range: atLine(-0) });
    const a = hit("a", { range: atLine(0) });
    const result = sortHits([z, a], "path");
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(z);
    expect(Object.is(z.range.startLine, -0)).toBe(true);
    expect(Object.is(a.range.startLine, 0)).toBe(true);
  });

  it.each([null, undefined])(
    "preserves the current TypeError for range=%s after repo and path ties",
    (invalid) => {
      const first = hit("z");
      const second = hit("a");
      Object.defineProperty(second, "range", { value: invalid });
      let caught: unknown;
      try {
        sortHits([first, second], "path");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as Error).message).toBe(
        `Cannot read properties of ${String(invalid)} (reading 'startLine')`,
      );
    },
  );

  it("keeps numerically equal string and number lines stable after strict inequality", () => {
    const first = hit("z", { range: atLine(7) });
    const second = hit("a", { range: atLine(7) });
    Object.defineProperty(first.range, "startLine", { value: "7" });
    const result = sortHits([first, second], "path");
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
    expect(first.range.startLine).toBe("7");
  });
});
