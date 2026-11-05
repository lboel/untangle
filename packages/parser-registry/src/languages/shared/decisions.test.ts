/**
 * `logicalGroupId` determinism (vision.md §8.5: `ComplexityFacts` MUST be
 * reproducible across runs). Uses a real tree-sitter parse (not a hand-built
 * node stub) so the id is derived from an actual `SyntaxNode`, exactly as
 * `engine.ts` calls `detectDecisionAndNesting` in production.
 */
import { describe, expect, it } from "vitest";

import { detectDecisionAndNesting, mayCarryDecisionOrNesting } from "./decisions.js";
import { loadGrammar, loadParserCtor } from "./grammar-loader.js";
import { BINARY_EXPRESSION } from "./node-kinds.js";
import { parseWithBuffer } from "./parse-limits.js";
import type { TsSyntaxNode } from "./tree-sitter-types.js";

function parse(source: string) {
  const ParserCtor = loadParserCtor();
  const parser = new ParserCtor();
  parser.setLanguage(loadGrammar({ moduleName: "tree-sitter-javascript" }));
  // Ueber `parseWithBuffer`, nicht `parser.parse` — sonst haette dieser Helfer
  // die 32-KiB-Grenze aus WP-215 wieder eingebaut.
  return parseWithBuffer(parser, source);
}

/** First `&&`/`||`/`??` binary_expression descendant, in any position within its chain. */
function findLogicalBinaryNode(root: TsSyntaxNode, operator: "&&" | "||" | "??"): TsSyntaxNode {
  const candidates = root.descendantsOfType(BINARY_EXPRESSION) as TsSyntaxNode[];
  const found = candidates.find((node) => node.childForFieldName("operator")?.text === operator);
  if (found === undefined) {
    throw new Error(`no "${operator}" binary_expression found in parsed source`);
  }
  return found;
}

describe("logicalGroupId — positional determinism (vision.md §8.5)", () => {
  it("is identical across two independent parses of the same source", () => {
    const source = "function f() { return a && b && c; }";
    const nodeA = findLogicalBinaryNode(parse(source).rootNode, "&&");
    const nodeB = findLogicalBinaryNode(parse(source).rootNode, "&&");

    const resultA = detectDecisionAndNesting(nodeA);
    const resultB = detectDecisionAndNesting(nodeB);

    expect(resultA.decision?.logicalGroupId).toBeDefined();
    expect(resultA.decision?.logicalGroupId).toBe(resultB.decision?.logicalGroupId);
  });

  it("is identical regardless of WHICH node in the chain is passed in", () => {
    const source = "function f() { return a && b && c; }";
    const root = parse(source).rootNode;
    const chainNodes = (root.descendantsOfType(BINARY_EXPRESSION) as TsSyntaxNode[]).filter(
      (node) => node.childForFieldName("operator")?.text === "&&",
    );
    // "a && b && c" parses to two nested binary_expression nodes for the
    // same "&&" chain (left-associative): ((a && b) && c). Both must report
    // the same group id — the chain's own topmost node.
    expect(chainNodes.length).toBe(2);

    const groupIds = chainNodes.map(
      (node) => detectDecisionAndNesting(node).decision?.logicalGroupId,
    );
    expect(groupIds[0]).toBeDefined();
    expect(groupIds[0]).toBe(groupIds[1]);
  });

  it("derives the id from the chain's own source position (startIndex), not a runtime node id", () => {
    const source = "function f() { return a && b && c; }";
    const root = parse(source).rootNode;
    const node = findLogicalBinaryNode(root, "&&");
    const result = detectDecisionAndNesting(node);

    const expectedStartIndex = source.indexOf("a && b && c");
    expect(result.decision?.logicalGroupId).toBe(`logical-${expectedStartIndex}`);
  });

  it("differs between two distinct logical chains at different source positions", () => {
    const source = "function f() { const x = a && b; const y = c && d; }";
    const root = parse(source).rootNode;
    const nodes = (root.descendantsOfType(BINARY_EXPRESSION) as TsSyntaxNode[]).filter(
      (n) => n.childForFieldName("operator")?.text === "&&",
    );
    expect(nodes.length).toBe(2);

    const ids = nodes.map((n) => detectDecisionAndNesting(n).decision?.logicalGroupId);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("stays stable across repeated parses for || and ?? chains too", () => {
    const orSource = "function f() { return a || b || c; }";
    const orA = detectDecisionAndNesting(findLogicalBinaryNode(parse(orSource).rootNode, "||"));
    const orB = detectDecisionAndNesting(findLogicalBinaryNode(parse(orSource).rootNode, "||"));
    expect(orA.decision?.logicalGroupId).toBeDefined();
    expect(orA.decision?.logicalGroupId).toBe(orB.decision?.logicalGroupId);

    const nullishSource = "function f() { return a ?? b ?? c; }";
    const nullishA = detectDecisionAndNesting(
      findLogicalBinaryNode(parse(nullishSource).rootNode, "??"),
    );
    const nullishB = detectDecisionAndNesting(
      findLogicalBinaryNode(parse(nullishSource).rootNode, "??"),
    );
    expect(nullishA.decision?.logicalGroupId).toBeDefined();
    expect(nullishA.decision?.logicalGroupId).toBe(nullishB.decision?.logicalGroupId);
  });
});

/**
 * `mayCarryDecisionOrNesting` ist das Vorsieb, mit dem der Cursor-Walk
 * entscheidet, ob er fuer einen Knoten ueberhaupt einen `SyntaxNode`-Wrapper
 * baut (WP-95). Ist es zu eng, verschwinden Entscheidungen lautlos aus jeder
 * Komplexitaetszahl — genau die Art Verlust, die E4 verbietet. Dieser Test
 * bindet es an die Detektorfunktion selbst.
 */
describe("mayCarryDecisionOrNesting — Vorsieb des Cursor-Walks", () => {
  const cases: { source: string; type: string }[] = [
    { source: "function f(a) { if (a) return 1; return 2; }", type: "if_statement" },
    { source: "function f(a) { for (;;) { g(a); } }", type: "for_statement" },
    { source: "function f(a) { for (const x of a) { g(x); } }", type: "for_in_statement" },
    { source: "function f(a) { while (a) { g(a); } }", type: "while_statement" },
    { source: "function f(a) { do { g(a); } while (a); }", type: "do_statement" },
    { source: "function f() { try { g(); } catch (e) { h(e); } }", type: "catch_clause" },
    { source: "function f(a) { return a ? 1 : 2; }", type: "ternary_expression" },
    { source: "function f(a) { switch (a) { case 1: g(); } }", type: "switch_statement" },
    { source: "function f(a) { switch (a) { case 1: g(); } }", type: "switch_case" },
    { source: "function f(a, b) { return a && b; }", type: "binary_expression" },
  ];

  for (const { source, type } of cases) {
    it(`laesst "${type}" durch, und der Detektor liefert dort auch etwas`, () => {
      const nodes = parse(source).rootNode.descendantsOfType(type) as TsSyntaxNode[];
      expect(nodes.length).toBeGreaterThan(0);
      expect(mayCarryDecisionOrNesting(type)).toBe(true);
      const detected = detectDecisionAndNesting(nodes[0] as TsSyntaxNode);
      expect(detected.decision !== undefined || detected.nesting !== undefined).toBe(true);
    });
  }

  it("siebt aus, was der Detektor ohnehin nicht beantwortet", () => {
    for (const type of ["statement_block", "call_expression", "identifier", "program"]) {
      expect(mayCarryDecisionOrNesting(type)).toBe(false);
    }
  });

  it("kein durchgelassener Typ ohne Befund, kein ausgesiebter Typ mit Befund", () => {
    // Gegenprobe ueber einen Baum mit ALLEN Konstrukten: fuer jeden
    // vorkommenden Knotentyp muss Vorsieb und Detektor dasselbe sagen.
    const source = [
      "function f(a, b) {",
      "  if (a) return 1;",
      "  for (const x of a) { while (b) { do { g(x); } while (b); } }",
      "  try { g(); } catch (e) { h(e); }",
      "  switch (a) { case 1: g(); break; }",
      "  return a && b ? (a || b) : (a ?? b);",
      "}",
    ].join("\n");
    const root = parse(source).rootNode;
    const visit = (node: TsSyntaxNode): void => {
      const detected = detectDecisionAndNesting(node);
      const hasFinding = detected.decision !== undefined || detected.nesting !== undefined;
      if (hasFinding) expect(mayCarryDecisionOrNesting(node.type)).toBe(true);
      for (const child of node.children) visit(child);
    };
    visit(root);
  });
});
