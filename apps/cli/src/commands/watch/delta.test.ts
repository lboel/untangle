/**
 * Tests der Delta-Logik. Sie arbeiten auf handgeschriebenen Messwerten, weil
 * hier NUR die Richtungs- und Zuordnungslogik geprueft wird; dass die Zahlen
 * selbst stimmen, prueft `analyze.test.ts` gegen die echten Calculator.
 */
import { describe, expect, it } from "vitest";

import type { FileReadingV1, ScopeReadingV1 } from "./analyze.js";
import {
  addMetricValues,
  directionOf,
  metricDeltas,
  netDirectionOf,
  readingOf,
  scopeDeltas,
  verdictOf,
} from "./delta.js";
import { zeroMetricValues, type MetricValues } from "./events.js";

function scope(partial: Partial<ScopeReadingV1> & { matchKey: string }): ScopeReadingV1 {
  return {
    metricsScopeId: `id-${partial.matchKey}`,
    label: "demo",
    kind: "function",
    line: 1,
    values: zeroMetricValues(),
    selected: true,
    ...partial,
  };
}

function reading(totals: Partial<MetricValues>, scopes: ScopeReadingV1[] = []): FileReadingV1 {
  return {
    path: "demo.ts",
    languageId: "typescript",
    contentHash: "hash",
    parseQuality: "complete",
    totals: { ...zeroMetricValues(), ...totals },
    scopes,
    chunkUnits: 1,
    chunkFragments: 0,
    scopeCount: scopes.length,
    scopeIdCollisions: 0,
    nodeKindFallbacks: 0,
    notes: [],
  };
}

function cognitive(value: number): MetricValues {
  return { ...zeroMetricValues(), cognitive: value };
}

describe("directionOf", () => {
  it("liest kleiner als einfacher", () => {
    expect(directionOf(-1)).toBe("abgebaut");
    expect(directionOf(1)).toBe("aufgebaut");
    expect(directionOf(0)).toBe("unveraendert");
  });
});

describe("readingOf", () => {
  it("weist die semantische Ladung als Datei-Lesart aus, die uebrigen als Scope-Lesart", () => {
    expect(readingOf("semantic")).toBe("file_chunks");
    expect(readingOf("cognitive")).toBe("execution_unit");
    expect(readingOf("cyclomatic")).toBe("execution_unit");
    expect(readingOf("structural")).toBe("execution_unit");
  });
});

describe("metricDeltas", () => {
  it("liefert immer alle vier Metriken, in fester Reihenfolge", () => {
    const deltas = metricDeltas(reading({ cognitive: 3 }), reading({ cognitive: 1 }));
    expect(deltas.map((delta) => delta.metric)).toStrictEqual([
      "structural",
      "semantic",
      "cyclomatic",
      "cognitive",
    ]);
  });

  it("liest eine neue Datei als previous=null und eine geloeschte als current=null", () => {
    const added = metricDeltas(undefined, reading({ cognitive: 5 }));
    expect(added[3]?.previous).toBeNull();
    expect(added[3]?.delta).toBe(5);
    expect(added[3]?.direction).toBe("aufgebaut");

    const deleted = metricDeltas(reading({ cognitive: 5 }), undefined);
    expect(deleted[3]?.current).toBeNull();
    expect(deleted[3]?.delta).toBe(-5);
    expect(deleted[3]?.direction).toBe("abgebaut");
  });
});

describe("scopeDeltas", () => {
  it("ordnet Scopes ueber den stabilen Schluessel zu, nicht ueber die metrics_scope_id", () => {
    const before = reading({ cognitive: 10 }, [
      scope({
        matchKey: "a#0",
        metricsScopeId: "demo.ts:scope:0:100",
        values: cognitive(10),
      }),
    ]);
    const after = reading({ cognitive: 4 }, [
      // Dieselbe Funktion, um 40 Bytes verschoben: neue metrics_scope_id.
      scope({
        matchKey: "a#0",
        metricsScopeId: "demo.ts:scope:40:140",
        values: cognitive(4),
      }),
    ]);

    const deltas = scopeDeltas(before, after, 5);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.delta).toBe(-6);
    expect(deltas[0]?.direction).toBe("abgebaut");
    expect(deltas[0]?.metricsScopeId).toBe("demo.ts:scope:40:140");
  });

  it("zaehlt nicht ausgewaehlte Scopes nicht mit (keine Doppelzaehlung)", () => {
    const before = reading({}, [
      scope({ matchKey: "a#0", values: cognitive(8) }),
      scope({ matchKey: "a#0.inner", selected: false, values: cognitive(5) }),
    ]);
    const after = reading({}, [
      scope({ matchKey: "a#0", values: cognitive(3) }),
      scope({ matchKey: "a#0.inner", selected: false, values: cognitive(0) }),
    ]);
    const deltas = scopeDeltas(before, after, 5);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.metric).toBe("cognitive");
  });

  it("sortiert nach Betrag absteigend und kuerzt auf das Limit", () => {
    const before = reading({}, [
      scope({ matchKey: "a#0", values: cognitive(1) }),
      scope({ matchKey: "b#0", values: cognitive(20) }),
    ]);
    const after = reading({}, [
      scope({ matchKey: "a#0", values: cognitive(2) }),
      scope({ matchKey: "b#0", values: cognitive(0) }),
    ]);
    const deltas = scopeDeltas(before, after, 1);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.delta).toBe(-20);
  });
});

describe("verdictOf / netDirectionOf", () => {
  it("zaehlt Metriken statt Betraege und bleibt bei Gleichstand ehrlich unentschieden", () => {
    const mixed = metricDeltas(
      reading({ cognitive: 10, cyclomatic: 1, structural: 1, semantic: 1 }),
      reading({ cognitive: 1, cyclomatic: 5, structural: 5, semantic: 1 }),
    );
    // Eine Metrik faellt, zwei steigen, eine bleibt: die Mehrheit entscheidet.
    expect(verdictOf(mixed)).toBe("aufgebaut");

    const tie = metricDeltas(
      reading({ cognitive: 10, cyclomatic: 1 }),
      reading({ cognitive: 1, cyclomatic: 10 }),
    );
    expect(verdictOf(tie)).toBe("unveraendert");
  });

  it("bildet die Netto-Bilanz aus aufaddierten Deltas", () => {
    let net: MetricValues = zeroMetricValues();
    net = addMetricValues(net, metricDeltas(reading({ cognitive: 10 }), reading({ cognitive: 4 })));
    net = addMetricValues(net, metricDeltas(reading({ cognitive: 4 }), reading({ cognitive: 2 })));
    expect(net.cognitive).toBe(-8);
    expect(netDirectionOf(net)).toBe("abgebaut");
  });
});
