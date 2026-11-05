/**
 * Die zwei Traegerformen, in denen Kennzahlwerkzeuge tatsaechlich schreiben.
 *
 * `generic-metrics` las bisher nur Eintragslisten: JSON Lines, ein Array, oder
 * ein Objekt mit einem Array unter `metrics`. Zwei sehr gewoehnliche Formen
 * fielen dadurch heraus, beide ohne Messwert und mit genau einem Hinweis:
 *
 * 1. **Flaches Objekt** — `{"quality_signal":0.45,"cycle_count":3}`. Ein
 *    Werkzeug, das eine Handvoll repo-weiter Zahlen ausgibt, schreibt sie so
 *    und nicht als Liste von `{key,value}`-Paaren.
 * 2. **Verschachtelte Liste** — `{"component":{"measures":[…]}}`. Wer die
 *    Zahlen ueber eine Web-API holt, bekommt sie unter einem Pfad, nicht auf
 *    oberster Ebene.
 *
 * Beides wird DEKLARIERT, nicht geraten: ob ein Objekt eine flache Kennzahl-
 * Tabelle oder ein einzelner Eintrag ist, kann der Parser nicht wissen, und
 * eine Vermutung waere genau die stille Umdeutung, die E4 verbietet.
 */
import { describe, expect, it } from "vitest";

import { parseGenericMetrics } from "./generic-metrics.js";

const SENTRUX_SHAPED = JSON.stringify({
  timestamp: 1788794829.434848,
  quality_signal: 0.4514569553927475,
  cycle_count: 3,
  god_file_count: 2,
  complex_fn_count: 88,
  max_depth: 28,
});

const NESTED = JSON.stringify({
  component: {
    key: "untangle",
    measures: [
      { metric: "cognitive_complexity", value: "4284" },
      { metric: "complexity", value: "5570" },
    ],
  },
});

describe("generic-metrics: flaches Objekt", () => {
  it("liest ohne Deklaration KEINE Kennzahl aus einem flachen Objekt", () => {
    const result = parseGenericMetrics(SENTRUX_SHAPED);
    expect(result.measurements).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });

  it("liest jeden Zahlenschluessel, sobald die Form deklariert ist", () => {
    const result = parseGenericMetrics(SENTRUX_SHAPED, { shape: "flat-object" });

    const byKey = new Map(result.measurements.map((m) => [m.key, m.value]));
    expect(byKey.get("quality_signal")).toBeCloseTo(0.4514569553927475, 12);
    expect(byKey.get("cycle_count")).toBe(3);
    expect(byKey.get("max_depth")).toBe(28);
    expect(result.measurements).toHaveLength(6);
  });

  it("nennt jeden nicht-numerischen Schluessel, statt ihn zu verschlucken (E4)", () => {
    const result = parseGenericMetrics(
      JSON.stringify({ ok: 1, label: "high", nested: { a: 1 }, empty: "" }),
      { shape: "flat-object" },
    );

    expect(result.measurements.map((m) => m.key)).toEqual(["ok"]);
    expect(result.issues.map((i) => i.rawLocation).sort()).toEqual(["/empty", "/label", "/nested"]);
  });

  it("behaelt die Reihenfolge des Werkzeugs nicht als Zufall, sondern sortiert deterministisch", () => {
    const first = parseGenericMetrics(JSON.stringify({ b: 2, a: 1 }), { shape: "flat-object" });
    const second = parseGenericMetrics(JSON.stringify({ a: 1, b: 2 }), { shape: "flat-object" });
    expect(first.measurements.map((m) => m.key)).toEqual(second.measurements.map((m) => m.key));
  });
});

describe("generic-metrics: verschachtelte Eintragsliste", () => {
  it("findet die Liste unter einem deklarierten Pfad", () => {
    const result = parseGenericMetrics(NESTED, {
      container: "component.measures",
      key: "metric",
    });

    expect(result.measurements.map((m) => [m.key, m.value])).toEqual([
      ["cognitive_complexity", 4284],
      ["complexity", 5570],
    ]);
  });

  it("meldet einen Pfad, der ins Leere zeigt, statt still nichts zu finden", () => {
    const result = parseGenericMetrics(NESTED, { container: "component.absent", key: "metric" });
    expect(result.measurements).toEqual([]);
    expect(result.issues.some((i) => i.detail.includes("component.absent"))).toBe(true);
  });
});
