import { describe, expect, it } from "vitest";

import {
  containsRange,
  rangeKey,
  selectSymbolFacts,
  sliceByRange,
  splitLines,
  strictlyContainsRange,
} from "./scope.js";
import { decision, emptyFacts, range, symbolScope } from "./test-support/builders.js";

describe("containsRange / strictlyContainsRange", () => {
  it("treats an identical range as contained but not strictly contained", () => {
    const a = range(1, 5);
    const b = { ...a };
    expect(containsRange(a, b)).toBe(true);
    expect(strictlyContainsRange(a, b)).toBe(false);
  });

  it("detects genuine nesting", () => {
    const outer = range(1, 10);
    const inner = range(3, 4);
    expect(containsRange(outer, inner)).toBe(true);
    expect(strictlyContainsRange(outer, inner)).toBe(true);
    expect(strictlyContainsRange(inner, outer)).toBe(false);
  });
});

describe("rangeKey", () => {
  it("is stable for identical byte spans and distinct otherwise", () => {
    expect(rangeKey(range(1, 2))).toBe(rangeKey(range(1, 2)));
    expect(rangeKey(range(1, 2))).not.toBe(rangeKey(range(2, 3)));
  });
});

describe("sliceByRange", () => {
  it("slices UTF-8 byte offsets back to the original substring", () => {
    const text = "héllo wörld";
    const buf = Buffer.from(text, "utf8");
    const r = { startLine: 1, endLine: 1, startByte: 0, endByte: buf.length };
    expect(sliceByRange(text, r)).toBe(text);
  });
});

describe("splitLines", () => {
  it("normalizes CRLF and CR to LF before splitting", () => {
    expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("selectSymbolFacts", () => {
  it("narrows decisions/comments/diagnostics to one symbol scope", () => {
    const facts = emptyFacts();
    const scopeA = "a";
    const scopeB = "b";
    const rangeA = range(1, 5);
    const rangeB = range(6, 10);
    facts.symbolScopes = [
      symbolScope({ symbolScopeId: scopeA, range: rangeA }),
      symbolScope({ symbolScopeId: scopeB, range: rangeB }),
    ];
    facts.decisions = [
      decision({ kind: "if", range: range(2, 2), symbolScopeId: scopeA }),
      decision({ kind: "if", range: range(7, 7), symbolScopeId: scopeB }),
    ];
    facts.comments = [range(1, 1), range(6, 6)];
    facts.parseDiagnostics = [
      { severity: "warning", kind: "error_node", message: "", range: range(2, 2) },
      { severity: "warning", kind: "error_node", message: "", range: range(7, 7) },
    ];

    const scopedA = selectSymbolFacts(facts, scopeA);

    expect(scopedA.decisions).toHaveLength(1);
    expect(scopedA.decisions[0]?.symbolScopeId).toBe(scopeA);
    expect(scopedA.comments).toHaveLength(1);
    expect(scopedA.parseDiagnostics).toHaveLength(1);
    expect(scopedA.symbolScopes).toHaveLength(1);
  });

  it("returns empty facts for an unknown symbolScopeId instead of throwing", () => {
    const scoped = selectSymbolFacts(emptyFacts(), "does-not-exist");
    expect(scoped.decisions).toEqual([]);
    expect(scoped.comments).toEqual([]);
  });
});
