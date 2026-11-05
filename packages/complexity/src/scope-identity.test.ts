/**
 * Tests fuer `withUniqueScopeIds` (WP-82).
 *
 * Der interessante Fall ist kein konstruierter: der ECHTE TypeScript-Adapter
 * erzeugt fuer zwei anonyme Callbacks unter zwei verschiedenen anonymen Eltern
 * dieselbe `symbolScopeId`. Genau dieser Quelltext steht unten.
 */
import type { ComplexityFacts, RawCall } from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import { createTypeScriptAdapter } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { computeCognitive } from "./cognitive.js";
import { buildSymbolIR } from "./ir/build-ir.js";
import { checkScopeTreeInvariants, type ScopeMetricNodeV1 } from "./scope-aggregate.js";
import { withUniqueScopeIds } from "./scope-identity.js";
import { selectSymbolFacts } from "./scope.js";

const ALGORITHM = "untangle-cognitive-v1";

/**
 * Zwei anonyme Callbacks (`() => { ... }`) unter zwei verschiedenen anonymen
 * Eltern-Callbacks. Beide Kinder haben den qualifizierten Namen
 * `<anonymous>.<anonymous>` und, weil das Ordinal je Elternscope zaehlt, beide
 * das Ordinal 0.
 */
const COLLIDING_SOURCE = `run(() => {
  register(() => {
    if (a) {
      if (b) {
        return 1;
      }
    }
    return 0;
  });
});

run(() => {
  register(() => {
    for (const x of xs) {
      if (x) {
        return x;
      }
    }
    return null;
  });
});
`;

function analyze(content: string): { facts: ComplexityFacts; calls: RawCall[] } {
  const adapter = createTypeScriptAdapter();
  const parseResult = adapter.parse({
    fileId: "src/colliding.ts",
    repoId: "repo-identity",
    refId: "repo-identity:main",
    path: "src/colliding.ts",
    languageId: "typescript",
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  });
  expect(parseResult.parseQuality).toBe("complete");
  const ast = parseResult.ast;
  if (ast === null) throw new Error("unexpected null AST");
  return { facts: adapter.computeComplexity(ast), calls: adapter.extractCalls(ast) };
}

const FUNCTION_LIKE = new Set(["function", "method", "constructor"]);

function toNodes(facts: ComplexityFacts, calls: readonly RawCall[]): ScopeMetricNodeV1[] {
  return facts.symbolScopes.map((scope) => {
    const inclusiveIr = buildSymbolIR(facts, scope.symbolScopeId, { calls });
    const ownIr = buildSymbolIR(
      selectSymbolFacts(facts, scope.symbolScopeId),
      scope.symbolScopeId,
      {
        calls,
      },
    );
    const base: ScopeMetricNodeV1 = {
      metricsScopeId: scope.symbolScopeId,
      inclusiveValue:
        inclusiveIr === undefined ? 0 : computeCognitive(inclusiveIr, ALGORITHM).value,
      selfValue: ownIr === undefined ? 0 : computeCognitive(ownIr, ALGORITHM).value,
      executionUnit: FUNCTION_LIKE.has(scope.kind),
    };
    return scope.parentScopeId === undefined
      ? base
      : { ...base, parentScopeId: scope.parentScopeId };
  });
}

describe("withUniqueScopeIds", () => {
  const analyzed = analyze(COLLIDING_SOURCE);

  it("belegt, dass der echte Adapter kollidierende symbolScopeIds erzeugt", () => {
    const ids = analyzed.facts.symbolScopes.map((s) => s.symbolScopeId);
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it("meldet die Kollision, statt sie stillschweigend zu heilen", () => {
    const result = withUniqueScopeIds(analyzed.facts, analyzed.calls, "src/colliding.ts");
    expect(result.collisions.length).toBeGreaterThan(0);
    for (const collision of result.collisions) {
      expect(collision.scopeCount).toBeGreaterThanOrEqual(2);
      expect(collision.startLines).toHaveLength(collision.scopeCount);
    }
  });

  it("macht alle Scope-Ids eindeutig", () => {
    const result = withUniqueScopeIds(analyzed.facts, analyzed.calls, "src/colliding.ts");
    const ids = result.facts.symbolScopes.map((s) => s.symbolScopeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(analyzed.facts.symbolScopes.length);
  });

  it("verliert keinen einzigen Fact und keinen Scope", () => {
    const before = analyzed.facts;
    const after = withUniqueScopeIds(before, analyzed.calls, "src/colliding.ts").facts;
    expect(after.symbolScopes).toHaveLength(before.symbolScopes.length);
    expect(after.decisions).toHaveLength(before.decisions.length);
    expect(after.nestingEvents).toHaveLength(before.nestingEvents.length);
    expect(after.operators).toHaveLength(before.operators.length);
    expect(after.operands).toHaveLength(before.operands.length);
    expect(after.identifiers).toHaveLength(before.identifiers.length);
    expect(after.literals).toHaveLength(before.literals.length);
    expect(after.nodeKinds).toHaveLength(before.nodeKinds.length);
  });

  it("haengt jeden Scope wieder an genau seinen umschliessenden Elternscope", () => {
    const result = withUniqueScopeIds(analyzed.facts, analyzed.calls, "src/colliding.ts");
    const byId = new Map(result.facts.symbolScopes.map((s) => [s.symbolScopeId, s]));
    for (const scope of result.facts.symbolScopes) {
      if (scope.parentScopeId === undefined) continue;
      const parent = byId.get(scope.parentScopeId);
      expect(parent).toBeDefined();
      if (parent === undefined) continue;
      expect(parent.range.startByte).toBeLessThanOrEqual(scope.range.startByte);
      expect(parent.range.endByte).toBeGreaterThanOrEqual(scope.range.endByte);
    }
  });

  it("ist die Identitaet (bis auf die Id-Form), wenn nichts kollidiert", () => {
    const clean = analyze(`export function only(a: number): number {
  return a > 0 ? 1 : 0;
}
`);
    const result = withUniqueScopeIds(clean.facts, clean.calls, "src/clean.ts");
    expect(result.collisions).toEqual([]);
    expect(result.nodeKindsAttributedByFallback).toBe(0);
  });

  it("ist deterministisch: zwei Laeufe liefern identische Ids", () => {
    const a = withUniqueScopeIds(analyzed.facts, analyzed.calls, "src/colliding.ts");
    const b = withUniqueScopeIds(analyzed.facts, analyzed.calls, "src/colliding.ts");
    expect(a.facts.symbolScopes.map((s) => s.symbolScopeId)).toEqual(
      b.facts.symbolScopes.map((s) => s.symbolScopeId),
    );
  });

  it("REGRESSION: ohne Reparatur meldet die Invariantenpruefung Verstoesse, mit Reparatur nicht", () => {
    const rawViolations = checkScopeTreeInvariants(toNodes(analyzed.facts, analyzed.calls));
    expect(rawViolations.length).toBeGreaterThan(0);
    expect(rawViolations.some((v) => v.code === "duplicate_scope_id")).toBe(true);

    const repaired = withUniqueScopeIds(analyzed.facts, analyzed.calls, "src/colliding.ts");
    expect(checkScopeTreeInvariants(toNodes(repaired.facts, repaired.calls))).toEqual([]);
  });
});
