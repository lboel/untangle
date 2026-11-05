import type { SourceRange } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { emptyFacts, identifier, literal, token } from "./test-support/builders.js";
import { computeTextual } from "./textual.js";

// ASCII-only fixture (byte offset == character index).
const LINES = ["function add(a, b) {", "  // TODO: check overflow", "  return a + b + 42;", "}"];
const SOURCE = LINES.join("\n");
const FILE_RANGE: SourceRange = { startLine: 1, endLine: 4, startByte: 0, endByte: SOURCE.length };
const COMMENT_RANGE: SourceRange = {
  startLine: 2,
  endLine: 2,
  startByte: SOURCE.indexOf("// TODO"),
  endByte: SOURCE.indexOf("// TODO") + "// TODO: check overflow".length,
};
const SCOPE = "sym1";

describe("computeTextual", () => {
  it("hand-computed: character/byte/line-length metrics for an ASCII scope", () => {
    const result = computeTextual(emptyFacts(), SOURCE, FILE_RANGE);

    expect(result.metrics["character_count"]).toBe(SOURCE.length);
    expect(result.metrics["byte_count"]).toBe(SOURCE.length);
    const lengths = LINES.map((l) => l.length);
    const expectedAvg = lengths.reduce((s, v) => s + v, 0) / lengths.length;
    expect(result.metrics["avg_line_length"]).toBeCloseTo(expectedAvg, 10);
    expect(result.metrics["max_line_length"]).toBe(Math.max(...lengths));
  });

  it("hand-computed: identifier count/uniqueness/avg length and entropy", () => {
    const facts = emptyFacts();
    // "add" (decl), "a" (decl), "b" (decl), "a" (ref), "b" (ref)
    facts.identifiers = [
      identifier({ name: "add", range: FILE_RANGE, symbolScopeId: SCOPE, role: "declaration" }),
      identifier({ name: "a", range: FILE_RANGE, symbolScopeId: SCOPE, role: "declaration" }),
      identifier({ name: "b", range: FILE_RANGE, symbolScopeId: SCOPE, role: "declaration" }),
      identifier({ name: "a", range: FILE_RANGE, symbolScopeId: SCOPE, role: "reference" }),
      identifier({ name: "b", range: FILE_RANGE, symbolScopeId: SCOPE, role: "reference" }),
    ];

    const result = computeTextual(facts, SOURCE, FILE_RANGE);

    expect(result.metrics["identifier_count"]).toBe(5);
    expect(result.metrics["unique_identifier_count"]).toBe(3);
    // avg length = (3+1+1+1+1)/5 = 1.4
    expect(result.metrics["avg_identifier_length"]).toBeCloseTo(1.4, 10);
    // characters across "add"+"a"+"b"+"a"+"b" = a:3, d:2, b:2 (total 7)
    // H = -(3/7*log2(3/7) + 2*(2/7*log2(2/7))) ≈ 1.5567 bits
    expect(result.metrics["identifier_entropy"]).toBeCloseTo(1.5567, 3);
  });

  it("hand-computed: magic_literal_count excludes the documented allowlist", () => {
    const facts = emptyFacts();
    facts.literals = [
      literal({ raw: "42", literalKind: "number", range: FILE_RANGE, symbolScopeId: SCOPE }),
      literal({ raw: "0", literalKind: "number", range: FILE_RANGE, symbolScopeId: SCOPE }),
      literal({ raw: "1", literalKind: "number", range: FILE_RANGE, symbolScopeId: SCOPE }),
      literal({ raw: "-1", literalKind: "number", range: FILE_RANGE, symbolScopeId: SCOPE }),
      literal({ raw: '""', literalKind: "string", range: FILE_RANGE, symbolScopeId: SCOPE }),
      literal({
        raw: '"unexpected"',
        literalKind: "string",
        range: FILE_RANGE,
        symbolScopeId: SCOPE,
      }),
      literal({ raw: "true", literalKind: "boolean", range: FILE_RANGE, symbolScopeId: SCOPE }),
    ];

    const result = computeTextual(facts, SOURCE, FILE_RANGE);

    // only "42" and "unexpected" are magic: 0/1/-1/""/true are excluded by definition
    expect(result.metrics["magic_literal_count"]).toBe(2);
  });

  it("counts TODO/FIXME/HACK occurrences in comment text, case-insensitively", () => {
    const facts = emptyFacts();
    facts.comments = [COMMENT_RANGE];

    const result = computeTextual(facts, SOURCE, FILE_RANGE);

    expect(result.metrics["todo_count"]).toBe(1);
    expect(result.metrics["fixme_count"]).toBe(0);
    expect(result.metrics["hack_count"]).toBe(0);
  });

  it("hand-computed: operator/operand counts and uniqueness", () => {
    const facts = emptyFacts();
    facts.operators = [token("+", FILE_RANGE, SCOPE), token("+", FILE_RANGE, SCOPE)];
    facts.operands = [
      token("a", FILE_RANGE, SCOPE),
      token("b", FILE_RANGE, SCOPE),
      token("42", FILE_RANGE, SCOPE),
    ];

    const result = computeTextual(facts, SOURCE, FILE_RANGE);

    expect(result.metrics["operator_count"]).toBe(2);
    expect(result.metrics["unique_operator_count"]).toBe(1);
    expect(result.metrics["operand_count"]).toBe(3);
    expect(result.metrics["unique_operand_count"]).toBe(3);
    expect(result.metrics["token_count"]).toBe(5);
  });

  it("computes comment_ratio/doc_ratio against physical_loc", () => {
    const facts = emptyFacts();
    facts.comments = [COMMENT_RANGE];

    const result = computeTextual(facts, SOURCE, FILE_RANGE);

    // 1 comment line out of 4 physical lines
    expect(result.metrics["comment_ratio"]).toBeCloseTo(0.25, 10);
    expect(result.metrics["doc_ratio"]).toBe(0); // "// TODO..." is not a doc-comment marker
  });

  it("handles UTF-8 multi-byte content: byte_count differs from character_count", () => {
    const text = "café"; // 4 codepoints, 5 UTF-8 bytes ("é" = 2 bytes)
    const byteLength = Buffer.byteLength(text, "utf8");
    const scopeRange: SourceRange = { startLine: 1, endLine: 1, startByte: 0, endByte: byteLength };

    const result = computeTextual(emptyFacts(), text, scopeRange);

    expect(result.metrics["character_count"]).toBe(4);
    expect(result.metrics["byte_count"]).toBe(5);
  });
});
