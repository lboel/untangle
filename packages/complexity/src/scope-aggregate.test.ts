/**
 * Tests fuer die Scope-Baum-Aggregation (WP-82).
 *
 * Zwei Ebenen: handgebaute Baeume fuer die Invarianten und die exakten
 * Summenformeln, und ein Lauf ueber ECHTEN, mit dem echten TypeScript-Adapter
 * geparsten Quelltext, der belegt, dass innerer Kontrollfluss genau einmal
 * zaehlt (Akzeptanzkriterium von WP-82).
 */
import type { ComplexityFacts, RawCall } from "@untangle-code/domain";
import { isUntangleError, sha256Hex } from "@untangle-code/domain";
import { createTypeScriptAdapter } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { aggregate } from "./aggregator.js";
import { computeCognitive } from "./cognitive.js";
import { buildSymbolIR } from "./ir/build-ir.js";
import {
  aggregateScopeTree,
  assertScopeTreeInvariants,
  checkScopeTreeInvariants,
  selectScopeEntries,
  type ScopeMetricNodeV1,
} from "./scope-aggregate.js";
import { selectSymbolFacts } from "./scope.js";

const ALGORITHM = "untangle-cognitive-v1";

function node(
  metricsScopeId: string,
  inclusiveValue: number,
  selfValue: number,
  executionUnit: boolean,
  parentScopeId?: string,
): ScopeMetricNodeV1 {
  return parentScopeId === undefined
    ? { metricsScopeId, inclusiveValue, selfValue, executionUnit }
    : { metricsScopeId, inclusiveValue, selfValue, executionUnit, parentScopeId };
}

/**
 * Referenzbaum, von Hand gerechnet.
 *
 *   file (kein Ausfuehrungsscope)  inclusive 27, self 3
 *   +- outer (Funktion)            inclusive 18, self 6
 *   |   +- inner (Closure)         inclusive  9, self 9
 *   +- helper (Funktion)           inclusive  4, self 4
 *
 * Pruefung der Kerninvariante am file-Scope: 3 + 18 + 4 = 25 <= 27. Am
 * outer-Scope: 6 + 9 = 15 <= 18.
 *
 * Erwartete Summen:
 *   top_level      = 27                (nur der file-Scope)
 *   execution_unit = 18 + 4 + 3 = 25   (aeusserste Funktionen + Eigenanteil file)
 *   self           = 3 + 6 + 9 + 4 = 22
 *   naiv           = 27 + 18 + 9 + 4 = 58
 */
const REFERENCE_TREE: ScopeMetricNodeV1[] = [
  node("file", 27, 3, false),
  node("outer", 18, 6, true, "file"),
  node("inner", 9, 9, true, "outer"),
  node("helper", 4, 4, true, "file"),
];

describe("checkScopeTreeInvariants", () => {
  it("akzeptiert einen stimmigen Baum ohne Befund", () => {
    expect(checkScopeTreeInvariants(REFERENCE_TREE)).toEqual([]);
  });

  it("meldet, wenn die Summe der Kinder den Elternwert uebersteigt", () => {
    const broken = [
      node("file", 10, 1, false),
      node("a", 6, 6, true, "file"),
      node("b", 6, 6, true, "file"),
    ];
    const violations = checkScopeTreeInvariants(broken);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("children_exceed_parent");
    expect(violations[0]?.metricsScopeId).toBe("file");
    expect(violations[0]?.observed).toBe(13);
    expect(violations[0]?.limit).toBe(10);
    expect(violations[0]?.detail).not.toBe("");
  });

  it("rechnet die Kerninvariante gegen perScopeBase, damit Cyclomatic keine Scheinverstoesse meldet", () => {
    // Cyclomatic classic: jeder Scope traegt den Sockel 1. Datei mit zwei
    // entscheidungsfreien Funktionen: file = 1, a = 1, b = 1.
    // Ohne Sockelabzug waere 1 + 1 + 1 = 3 > 1 ein Scheinverstoss.
    const cyclomatic = [
      node("file", 1, 1, false),
      node("a", 1, 1, true, "file"),
      node("b", 1, 1, true, "file"),
    ];
    expect(checkScopeTreeInvariants(cyclomatic).map((v) => v.code)).toEqual([
      "children_exceed_parent",
    ]);
    expect(checkScopeTreeInvariants(cyclomatic, { perScopeBase: 1 })).toEqual([]);
  });

  it("meldet einen Eigenanteil groesser als der Gesamtwert", () => {
    const violations = checkScopeTreeInvariants([
      node("file", 5, 9, false),
      node("a", 1, 1, true, "file"),
    ]);
    expect(violations.map((v) => v.code)).toContain("self_exceeds_inclusive");
  });

  it("meldet negative Werte", () => {
    const violations = checkScopeTreeInvariants([node("file", -1, -1, false)]);
    expect(violations.map((v) => v.code)).toContain("negative_value");
  });

  it("behandelt einen unbekannten Eltern-Scope als Fehler, nicht als Wurzel", () => {
    const violations = checkScopeTreeInvariants([node("a", 3, 3, true, "does-not-exist")]);
    expect(violations.map((v) => v.code)).toEqual(["unknown_parent"]);
  });

  it("meldet einen Zyklus in der Elternkette", () => {
    const violations = checkScopeTreeInvariants([
      node("a", 3, 3, true, "b"),
      node("b", 3, 3, true, "a"),
    ]);
    expect(
      violations.every((v) => v.code === "parent_cycle" || v.code === "children_exceed_parent"),
    ).toBe(true);
    expect(violations.some((v) => v.code === "parent_cycle")).toBe(true);
  });

  it("meldet ein Blatt, dessen Eigenanteil vom Gesamtwert abweicht", () => {
    const violations = checkScopeTreeInvariants([node("a", 7, 3, true)]);
    expect(violations.map((v) => v.code)).toEqual(["leaf_self_differs_from_inclusive"]);
  });

  it("meldet dieselbe metricsScopeId mit abweichenden Werten", () => {
    const violations = checkScopeTreeInvariants([node("a", 3, 3, true), node("a", 4, 4, true)]);
    expect(violations.map((v) => v.code)).toEqual(["duplicate_scope_id"]);
  });

  it("dedupliziert identische Wiederholungen still (spec.md §16.10) und meldet sie nur als Zaehler", () => {
    const result = aggregateScopeTree([node("a", 3, 3, true), node("a", 3, 3, true)]);
    expect(result.duplicatesDropped).toBe(1);
    expect(result.scopeCount).toBe(1);
    expect(result.selfSum).toBe(3);
  });

  it("liefert Verstoesse deterministisch nach Codepoints sortiert", () => {
    const violations = checkScopeTreeInvariants([
      node("zz", 7, 3, true),
      node("aa", 7, 3, true),
      node("mm", 7, 3, true),
    ]);
    expect(violations.map((v) => v.metricsScopeId)).toEqual(["aa", "mm", "zz"]);
  });
});

describe("assertScopeTreeInvariants", () => {
  it("wirft einen UntangleError mit ANALYSIS_INCOMPLETE und der vollen Liste", () => {
    let caught: unknown;
    try {
      assertScopeTreeInvariants([node("file", 1, 1, false), node("a", 9, 9, true, "file")]);
    } catch (error) {
      caught = error;
    }
    expect(isUntangleError(caught)).toBe(true);
    if (!isUntangleError(caught)) throw new Error("unreachable");
    expect(caught.code).toBe("ANALYSIS_INCOMPLETE");
    expect(Array.isArray(caught.context["violations"])).toBe(true);
  });

  it("ist still bei einem stimmigen Baum", () => {
    expect(() => {
      assertScopeTreeInvariants(REFERENCE_TREE);
    }).not.toThrow();
  });
});

describe("aggregateScopeTree — die drei Lesarten", () => {
  it("rechnet alle drei Summen wie von Hand gerechnet", () => {
    const result = aggregateScopeTree(REFERENCE_TREE);
    expect(result.scopeCount).toBe(4);
    expect(result.rootCount).toBe(1);
    expect(result.executionUnitRootCount).toBe(2); // outer, helper
    expect(result.leafCount).toBe(2); // inner, helper
    expect(result.topLevelSum).toBe(27);
    expect(result.executionUnitSum).toBe(25);
    expect(result.selfSum).toBe(22);
  });

  it("weist die naive Summe und den doppelt gezaehlten Betrag getrennt aus", () => {
    const result = aggregateScopeTree(REFERENCE_TREE);
    expect(result.naiveSum).toBe(58);
    expect(result.doubleCountedAmount).toBe(58 - 27);
  });

  it("weist die Blatt-Lesart nur mit dem Betrag aus, den sie verschluckt", () => {
    const result = aggregateScopeTree(REFERENCE_TREE);
    expect(result.leafOnlySum).toBe(13); // inner 9 + helper 4
    expect(result.leafOnlyDroppedAmount).toBe(22 - 13); // Eigenanteil von file und outer
  });

  it("haelt die Ordnung self <= execution_unit <= top_level", () => {
    const result = aggregateScopeTree(REFERENCE_TREE);
    expect(result.selfSum).toBeLessThanOrEqual(result.executionUnitSum);
    expect(result.executionUnitSum).toBeLessThanOrEqual(result.topLevelSum);
  });

  it("wirft statt eine Summe ueber einen widerspruechlichen Baum zu liefern", () => {
    expect(() =>
      aggregateScopeTree([node("file", 1, 1, false), node("a", 9, 9, true, "file")]),
    ).toThrow(/scope tree invariants violated/);
  });
});

describe("selectScopeEntries", () => {
  it("zaehlt jeden Scope hoechstens einmal je Lesart", () => {
    for (const reading of ["top_level", "execution_unit", "self"] as const) {
      const entries = selectScopeEntries(REFERENCE_TREE, reading);
      const ids = entries.map((e) => e.metricsScopeId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("waehlt fuer execution_unit die aeussersten Funktionen plus die Nicht-Funktionsscopes darueber", () => {
    const entries = selectScopeEntries(REFERENCE_TREE, "execution_unit");
    expect(entries.map((e) => e.metricsScopeId).sort()).toEqual(["file", "helper", "outer"]);
    expect(entries.find((e) => e.metricsScopeId === "file")?.value).toBe(3); // Eigenanteil
    expect(entries.find((e) => e.metricsScopeId === "outer")?.value).toBe(18); // inklusive Closure
  });

  it("laesst sich unveraendert in aggregate() fuellen (spec.md §16.10)", () => {
    const stats = aggregate(selectScopeEntries(REFERENCE_TREE, "execution_unit"), [10]);
    expect(stats.count).toBe(3);
    expect(stats.sum).toBe(25);
    expect(stats.max).toBe(18);
    expect(stats.thresholdCounts["10"]).toBe(1);
  });

  it("reicht sloc durch, damit der SLOC-gewichtete Mittelwert entsteht", () => {
    const withSloc: ScopeMetricNodeV1[] = [
      { metricsScopeId: "file", inclusiveValue: 4, selfValue: 4, executionUnit: false, sloc: 20 },
    ];
    const stats = aggregate(selectScopeEntries(withSloc, "self"));
    expect(stats.slocWeightedMean).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Gegen ECHTEN Quelltext: innerer Kontrollfluss zaehlt genau einmal.
// ---------------------------------------------------------------------------

const NESTED_SOURCE = `export class Router {
  route(kind: string, retries: number): string {
    if (kind === "a") {
      for (let i = 0; i < retries; i++) {
        if (i % 2 === 0) {
          return "even";
        }
      }
    }
    const pick = (value: number): string => {
      if (value > 10) {
        return value > 20 ? "big" : "medium";
      }
      return "small";
    };
    return pick(retries);
  }

  plain(flag: boolean): number {
    return flag ? 1 : 0;
  }
}
`;

interface Analyzed {
  facts: ComplexityFacts;
  calls: RawCall[];
}

function analyze(content: string): Analyzed {
  const adapter = createTypeScriptAdapter();
  const parseResult = adapter.parse({
    fileId: "file-scope-aggregate",
    repoId: "repo-scope-aggregate",
    refId: "repo-scope-aggregate:main",
    path: "src/router.ts",
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

function toScopeNodes(analyzed: Analyzed): ScopeMetricNodeV1[] {
  return analyzed.facts.symbolScopes.map((scope) => {
    const inclusiveRoot = buildSymbolIR(analyzed.facts, scope.symbolScopeId, {
      calls: analyzed.calls,
    });
    const ownRoot = buildSymbolIR(
      selectSymbolFacts(analyzed.facts, scope.symbolScopeId),
      scope.symbolScopeId,
      { calls: analyzed.calls },
    );
    const base: ScopeMetricNodeV1 = {
      metricsScopeId: scope.symbolScopeId,
      inclusiveValue:
        inclusiveRoot === undefined ? 0 : computeCognitive(inclusiveRoot, ALGORITHM).value,
      selfValue: ownRoot === undefined ? 0 : computeCognitive(ownRoot, ALGORITHM).value,
      executionUnit: FUNCTION_LIKE.has(scope.kind),
    };
    return scope.parentScopeId === undefined
      ? base
      : { ...base, parentScopeId: scope.parentScopeId };
  });
}

describe("Scope-Baum aus echtem, echt geparstem Quelltext", () => {
  const analyzed = analyze(NESTED_SOURCE);
  const nodes = toScopeNodes(analyzed);

  it("erzeugt einen Baum mit genau einer Wurzel und echten Verschachtelungen", () => {
    expect(nodes.length).toBeGreaterThanOrEqual(4); // file, class, route, pick, plain
    expect(nodes.filter((n) => n.parentScopeId === undefined)).toHaveLength(1);
    expect(nodes.some((n) => n.executionUnit)).toBe(true);
  });

  it("verletzt keine Invariante — der innere Kontrollfluss steckt im Elternwert genau einmal", () => {
    expect(checkScopeTreeInvariants(nodes)).toEqual([]);
  });

  it("zaehlt naiv deutlich mehr als jede der drei Lesarten", () => {
    const result = aggregateScopeTree(nodes);
    expect(result.naiveSum).toBeGreaterThan(result.topLevelSum);
    expect(result.doubleCountedAmount).toBeGreaterThan(0);
    expect(result.selfSum).toBeLessThanOrEqual(result.executionUnitSum);
    expect(result.executionUnitSum).toBeLessThanOrEqual(result.topLevelSum);
  });

  it("zaehlt den Kontrollfluss der Closure genau einmal, egal in welcher Lesart", () => {
    // Die Closure `pick` traegt if + ternary. In der Funktions-Lesart steckt
    // sie in `route`; sie darf NICHT zusaetzlich als eigener Eintrag stehen.
    const entries = selectScopeEntries(nodes, "execution_unit");
    const pickScope = analyzed.facts.symbolScopes.find((s) => s.name === "pick");
    expect(pickScope).toBeDefined();
    expect(entries.some((e) => e.metricsScopeId === pickScope?.symbolScopeId)).toBe(false);
  });

  it("die Eigenanteile aller Scopes summieren sich zur self-Lesart, ohne Rest", () => {
    const result = aggregateScopeTree(nodes);
    const handSum = nodes.reduce((sum, n) => sum + n.selfValue, 0);
    expect(result.selfSum).toBe(handSum);
  });
});
