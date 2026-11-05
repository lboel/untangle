import type { CodeChunkPayloadV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { dedupeCandidates } from "./dedupe.js";
import type { ScoredCandidate } from "./dedupe.js";
import { candidateFixture } from "./testing/candidates.js";

function scored(
  id: string,
  baseScore: number,
  overrides: Partial<CodeChunkPayloadV1> = {},
): ScoredCandidate {
  return { candidate: candidateFixture({ chunk_id: id, ...overrides }), baseScore };
}

function freezeEntry(entry: ScoredCandidate): ScoredCandidate {
  Object.freeze(entry.candidate.payload);
  Object.freeze(entry.candidate.raw);
  Object.freeze(entry.candidate.substitutedFields);
  Object.freeze(entry.candidate);
  return Object.freeze(entry);
}

const keyFields = ["workspace_id", "repo_id", "ref_id", "metrics_scope_id"] as const;

function groupingTrace(id: string): string[] {
  return [`${id}.candidate`, `${id}.payload`, ...keyFields.map((key) => `${id}.${key}`)];
}

function traced(
  id: string,
  baseScore: number,
  trace: string[],
  overrides: Partial<CodeChunkPayloadV1> = {},
) {
  const entry = scored(id, baseScore, overrides);
  const candidate = entry.candidate;
  const payload = candidate.payload;
  for (const key of [
    ...keyFields,
    "chunk_id",
    "chunk_kind",
    "fragment_index",
    "start_line",
    "end_line",
  ] as const) {
    const value = payload[key];
    Object.defineProperty(payload, key, {
      configurable: true,
      enumerable: true,
      get() {
        trace.push(`${id}.${key}`);
        return value;
      },
    });
  }
  Object.defineProperty(candidate, "payload", {
    configurable: true,
    enumerable: true,
    get() {
      trace.push(`${id}.payload`);
      return payload;
    },
  });
  Object.defineProperty(entry, "candidate", {
    configurable: true,
    enumerable: true,
    get() {
      trace.push(`${id}.candidate`);
      return candidate;
    },
  });
  Object.defineProperty(entry, "baseScore", {
    configurable: true,
    enumerable: true,
    get() {
      trace.push(`${id}.baseScore`);
      return baseScore;
    },
  });
  return { entry, candidate, payload };
}

function throwingGetter(
  target: object,
  key: string,
  label: string,
  trace: string[],
  failure: Error,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      trace.push(label);
      throw failure;
    },
  });
}

describe("dedupe first-occurrence order and reference characterization", () => {
  it("accepts a frozen empty input and returns independent empty arrays", () => {
    const input = Object.freeze([] as ScoredCandidate[]);
    const first = dedupeCandidates(input);
    expect(first).toEqual([]);
    expect(dedupeCandidates(input)).toEqual([]);
    expect(dedupeCandidates(input)).not.toBe(first);
    expect(input).toEqual([]);
  });

  it("preserves deeply frozen inputs and produces deterministic, independent result metadata", () => {
    const lower = freezeEntry(scored("lower", 0.2, { start_line: 7, end_line: 12 }));
    const higher = freezeEntry(scored("higher", 0.8));
    const input = Object.freeze([lower, higher]);
    const before = JSON.stringify(input);
    const first = dedupeCandidates(input);
    const second = dedupeCandidates(input);
    expect(first).toEqual([
      {
        primary: higher,
        dedupeKey: "ws-1\u001frepo-a\u001fref-main\u001fsym-1",
        absorbed: [lower],
        relatedFragments: [
          { chunkId: "lower", chunkKind: "function", startLine: 7, endLine: 12, score: 0.2 },
        ],
      },
    ]);
    expect(second).toEqual(first);
    expect(first[0]?.primary).toBe(higher);
    expect(first[0]?.absorbed[0]).toBe(lower);
    expect(first[0]?.absorbed).not.toBe(second[0]?.absorbed);
    expect(first[0]?.relatedFragments[0]).not.toBe(second[0]?.relatedFragments[0]);
    first[0]?.absorbed.push(higher);
    expect(second[0]?.absorbed).toEqual([lower]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps three interleaved groups in first-occurrence order when later members become primary", () => {
    const a = scored("a-first", 0.1, { metrics_scope_id: "a" });
    const b = scored("b-first", 0.3, { metrics_scope_id: "b" });
    const aBest = scored("a-best", 0.9, { metrics_scope_id: "a" });
    const c = scored("c-first", 0.2, { metrics_scope_id: "c" });
    const bBest = scored("b-best", 1, { metrics_scope_id: "b" });
    const cBest = scored("c-best", 0.8, { metrics_scope_id: "c" });
    const aMiddle = scored("a-middle", 0.5, { metrics_scope_id: "a" });
    const result = dedupeCandidates([a, b, aBest, c, bBest, cBest, aMiddle]);
    expect(result.map((group) => group.primary)).toEqual([aBest, bBest, cBest]);
    expect(result.map((group) => group.dedupeKey)).toEqual(
      ["a", "b", "c"].map((scope) => `ws-1\u001frepo-a\u001fref-main\u001f${scope}`),
    );
    expect(result[0]?.primary).toBe(aBest);
    expect(result[1]?.primary).toBe(bBest);
    expect(result[2]?.primary).toBe(cBest);
    expect(result.map((group) => group.absorbed)).toEqual([[aMiddle, a], [b], [c]]);
    expect(
      result.map((group) => group.relatedFragments.map((fragment) => fragment.chunkId)),
    ).toEqual([["a-middle", "a-first"], ["b-first"], ["c-first"]]);
  });

  it("keeps equal-score equal-ID members stable, including repeated references", () => {
    const first = scored("same", 0.5, { start_line: 1 });
    const second = scored("same", 0.5, { start_line: 20 });
    const third = scored("same", 0.5, { start_line: 30 });
    const [group] = dedupeCandidates([first, second, first, third]);
    expect(group?.primary).toBe(first);
    expect(group?.absorbed).toHaveLength(3);
    expect(group?.absorbed[0]).toBe(second);
    expect(group?.absorbed[1]).toBe(first);
    expect(group?.absorbed[2]).toBe(third);
    expect(
      group?.relatedFragments.map((fragment) => [fragment.chunkId, fragment.startLine]),
    ).toEqual([
      ["same", 20],
      ["same", 1],
      ["same", 30],
    ]);
    expect(group?.relatedFragments[0]).not.toBe(group?.relatedFragments[1]);
  });

  it("retains the current relational Unicode ID ordering without locale or normalization", () => {
    const input = ["é", "😀", "\uE000", "a", "e\u0301", "Z"].map((id) => scored(id, 0.5));
    const [group] = dedupeCandidates(input);
    expect(group?.primary).toBe(input[5]);
    expect([
      group?.primary.candidate.payload.chunk_id,
      ...group!.relatedFragments.map((fragment) => fragment.chunkId),
    ]).toEqual(["Z", "a", "e\u0301", "é", "😀", "\uE000"]);
  });

  it.each(keyFields)("keeps %s independently significant in group identity", (field) => {
    const first = scored("first", 0.1);
    const distinct = scored("distinct", 1, { [field]: "other" });
    const replacement = scored("replacement", 0.8);
    const result = dedupeCandidates([first, distinct, replacement]);
    expect(result).toHaveLength(2);
    expect(result[0]?.primary).toBe(replacement);
    expect(result[0]?.absorbed[0]).toBe(first);
    expect(result[1]?.primary).toBe(distinct);
    expect(result[1]?.absorbed).toEqual([]);
    expect(result[1]?.relatedFragments).toEqual([]);
    expect(result[0]?.dedupeKey).toBe("ws-1\u001frepo-a\u001fref-main\u001fsym-1");
    expect(result[1]?.dedupeKey.split("\u001f")).toEqual(
      keyFields.map((key) => (key === field ? "other" : first.candidate.payload[key])),
    );
  });

  it("groups different files, paths and symbol IDs when the four key components agree", () => {
    const first = scored("first", 0.9, {
      file_id: "file-a",
      file_path: "a.ts",
      symbol_id: "symbol-a",
    });
    const second = scored("second", 0.4, {
      file_id: "file-b",
      file_path: "b.ts",
      symbol_id: "symbol-b",
      symbol_name: "other",
      chunk_kind: "fragment",
      fragment_index: 4,
    });
    const [group] = dedupeCandidates([first, second]);
    expect(group?.primary).toBe(first);
    expect(group?.absorbed[0]).toBe(second);
    expect(group?.relatedFragments).toEqual([
      {
        chunkId: "second",
        chunkKind: "fragment",
        fragmentIndex: 4,
        startLine: 1,
        endLine: 5,
        score: 0.4,
      },
    ]);
  });

  it.each([undefined, 0, 7])(
    "carries complete absorbed metadata and optional fragment index %s",
    (fragmentIndex) => {
      const primary = scored("primary", 0.9);
      const absorbed = scored("fragment", 0.25, {
        chunk_kind: "class_fragment",
        start_line: 31,
        end_line: 47,
        ...(fragmentIndex === undefined ? {} : { fragment_index: fragmentIndex }),
      });
      const [group] = dedupeCandidates([absorbed, primary]);
      expect(group?.primary).toBe(primary);
      expect(group?.absorbed[0]).toBe(absorbed);
      expect(group?.relatedFragments).toEqual([
        {
          chunkId: "fragment",
          chunkKind: "class_fragment",
          ...(fragmentIndex === undefined ? {} : { fragmentIndex }),
          startLine: 31,
          endLine: 47,
          score: 0.25,
        },
      ]);
      expect(Object.hasOwn(group!.relatedFragments[0]!, "fragmentIndex")).toBe(
        fragmentIndex !== undefined,
      );
    },
  );
});

describe("dedupe observable property and error order", () => {
  it.each([undefined, 0])(
    "groups every input before sorting and reads optional fragment index %s lazily",
    (fragmentIndex) => {
      const trace: string[] = [];
      const early = traced(
        "early",
        0.2,
        trace,
        fragmentIndex === undefined ? {} : { fragment_index: fragmentIndex },
      );
      const late = traced("late", 0.9, trace);
      const separate = traced("separate", 1, trace, { metrics_scope_id: "other" });
      const result = dedupeCandidates([early.entry, late.entry, separate.entry]);
      expect(trace).toEqual([
        ...groupingTrace("early"),
        ...groupingTrace("late"),
        ...groupingTrace("separate"),
        "late.baseScore",
        "early.baseScore",
        "early.baseScore",
        "late.baseScore",
        "early.candidate",
        "early.payload",
        "early.chunk_id",
        "early.chunk_kind",
        "early.fragment_index",
        ...(fragmentIndex === undefined ? [] : ["early.fragment_index"]),
        "early.start_line",
        "early.end_line",
        "early.baseScore",
      ]);
      expect(result[0]?.primary).toBe(late.entry);
      expect(result[0]?.absorbed[0]).toBe(early.entry);
      expect(result[1]?.primary).toBe(separate.entry);
    },
  );

  it("propagates a grouping getter's exact error before reading later input", () => {
    const trace: string[] = [];
    const first = traced("first", 0.1, trace);
    const later = traced("later", 1, trace);
    const failure = new Error("scope unavailable");
    throwingGetter(first.payload, "metrics_scope_id", "first.metrics_scope_id", trace, failure);
    let caught: unknown;
    try {
      dedupeCandidates([first.entry, later.entry]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(trace).toEqual(groupingTrace("first"));
  });

  it("propagates a score getter's exact error after all grouping and before metadata", () => {
    const trace: string[] = [];
    const first = traced("first", 0.1, trace);
    const later = traced("later", 1, trace);
    const other = traced("other", 0.5, trace, { metrics_scope_id: "other" });
    const failure = new Error("score unavailable");
    throwingGetter(later.entry, "baseScore", "later.baseScore", trace, failure);
    let caught: unknown;
    try {
      dedupeCandidates([first.entry, later.entry, other.entry]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(trace).toEqual([
      ...groupingTrace("first"),
      ...groupingTrace("later"),
      ...groupingTrace("other"),
      "later.baseScore",
    ]);
  });

  it("propagates a related-fragment getter's exact error before remaining metadata", () => {
    const trace: string[] = [];
    const first = traced("first", 0.1, trace);
    const later = traced("later", 1, trace);
    const failure = new Error("fragment unavailable");
    throwingGetter(first.payload, "chunk_kind", "first.chunk_kind", trace, failure);
    let caught: unknown;
    try {
      dedupeCandidates([first.entry, later.entry]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(trace).toEqual([
      ...groupingTrace("first"),
      ...groupingTrace("later"),
      "later.baseScore",
      "first.baseScore",
      "first.baseScore",
      "later.baseScore",
      "first.candidate",
      "first.payload",
      "first.chunk_id",
      "first.chunk_kind",
    ]);
  });

  it("lets a later grouping error win over an earlier group's unvisited score error", () => {
    const trace: string[] = [];
    const first = traced("first", 0.1, trace);
    const second = traced("second", 0.9, trace);
    const third = traced("third", 1, trace);
    const expected = new Error("later key failed");
    throwingGetter(
      second.entry,
      "baseScore",
      "second.baseScore",
      trace,
      new Error("must remain unvisited"),
    );
    throwingGetter(third.payload, "repo_id", "third.repo_id", trace, expected);
    let caught: unknown;
    try {
      dedupeCandidates([first.entry, second.entry, third.entry]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(expected);
    expect(trace).toEqual([
      ...groupingTrace("first"),
      ...groupingTrace("second"),
      "third.candidate",
      "third.payload",
      "third.workspace_id",
      "third.repo_id",
    ]);
  });
});

describe("dedupe current numeric edge behavior", () => {
  it.each([true, false])("keeps NaN comparator pairs stable with NaN first=%s", (nanFirst) => {
    const nan = scored("a", Number.NaN);
    const finite = scored("z", 0.9);
    const input = nanFirst ? [nan, finite] : [finite, nan];
    const [group] = dedupeCandidates(input);
    expect(group?.primary).toBe(input[0]);
    expect(group?.absorbed[0]).toBe(input[1]);
    expect(group?.relatedFragments[0]?.score).toBe(input[1]?.baseScore);
  });

  it("orders unequal infinities around finite scores without normalizing them", () => {
    const low = scored("low", Number.NEGATIVE_INFINITY);
    const finite = scored("finite", 0.5);
    const high = scored("high", Number.POSITIVE_INFINITY);
    const [group] = dedupeCandidates([low, finite, high]);
    expect(group?.primary).toBe(high);
    expect(group?.absorbed).toEqual([finite, low]);
    expect(group?.relatedFragments.map((fragment) => fragment.score)).toEqual([
      0.5,
      Number.NEGATIVE_INFINITY,
    ]);
  });

  it("breaks equal positive-infinity ties by ID", () => {
    const z = scored("z", Number.POSITIVE_INFINITY);
    const a = scored("a", Number.POSITIVE_INFINITY);
    const [group] = dedupeCandidates([z, a]);
    expect(group?.primary).toBe(a);
    expect(group?.absorbed[0]).toBe(z);
  });

  it("treats signed zeros as a score tie while preserving the absorbed score's sign", () => {
    const negative = scored("z", -0);
    const positive = scored("a", 0);
    const [group] = dedupeCandidates([negative, positive]);
    expect(group?.primary).toBe(positive);
    expect(group?.relatedFragments[0]?.score).toBe(-0);
    expect(negative.baseScore).toBe(-0);
  });
});
