/**
 * Der lange Schwanz aus BUILD_PLAN §25 fuer die Aggregation: WP-186, WP-200.
 *
 * Beide betreffen `duplicate_scope_id` — den Verstoss, der sagt, dass eine
 * `metricsScopeId` nicht genau einen Scope bezeichnet. WP-186: die
 * Begruendung nannte immer `inclusive`/`self` und druckte dabei identische
 * Zahlen, wenn der Unterschied woanders lag. WP-200: `sloc` ging gar nicht in
 * den Vergleich ein, obwohl es das GEWICHT im SLOC-gewichteten Mittel stellt.
 */
import type { ComplexityFacts, ParseDiagnostic } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { aggregateScopeTree, checkScopeTreeInvariants } from "./scope-aggregate.js";
import type { ScopeMetricNodeV1 } from "./scope-aggregate.js";
import { computeSyntactic } from "./syntactic.js";

const BASE: ScopeMetricNodeV1 = {
  metricsScopeId: "a",
  inclusiveValue: 3,
  selfValue: 3,
  executionUnit: true,
};

describe("WP-186 — die Begruendung nennt das Feld, das wirklich abweicht", () => {
  it("nennt parentScopeId und druckt keine identischen Zahlen als 'abweichende Werte'", () => {
    const violations = checkScopeTreeInvariants([
      { ...BASE, parentScopeId: "p1" },
      { ...BASE, parentScopeId: "p2" },
    ]);
    const duplicate = violations.find((violation) => violation.code === "duplicate_scope_id");
    expect(duplicate).toBeDefined();
    expect(duplicate?.detail).toContain("parentScopeId");
    // Der eigentliche Befund: der Text darf nicht ueber inclusive/self reden,
    // wo beide gleich sind.
    expect(duplicate?.detail).not.toContain("inclusive 3 vs. 3");
    expect(duplicate?.detail).not.toContain("self 3 vs. 3");
  });

  it("nennt executionUnit, wenn nur die Ausfuehrungseinheit abweicht", () => {
    const violations = checkScopeTreeInvariants([
      { ...BASE, executionUnit: true },
      { ...BASE, executionUnit: false },
    ]);
    const duplicate = violations.find((violation) => violation.code === "duplicate_scope_id");
    expect(duplicate?.detail).toContain("executionUnit");
  });

  it("nennt weiterhin inclusive und self, wenn die Zahlen wirklich abweichen", () => {
    const violations = checkScopeTreeInvariants([
      { ...BASE, inclusiveValue: 3, selfValue: 3 },
      { ...BASE, inclusiveValue: 4, selfValue: 4 },
    ]);
    const duplicate = violations.find((violation) => violation.code === "duplicate_scope_id");
    expect(duplicate?.detail).toContain("inclusive 4 vs. 3");
    expect(duplicate?.detail).toContain("self 4 vs. 3");
    expect(duplicate?.detail).not.toContain("parentScopeId");
  });
});

describe("WP-200 — abweichendes sloc ist eine Abweichung", () => {
  it("meldet zwei Eintraege derselben Id mit verschiedenem sloc als Verstoss", () => {
    const violations = checkScopeTreeInvariants([
      { ...BASE, sloc: 10 },
      { ...BASE, sloc: 40 },
    ]);
    const duplicate = violations.find((violation) => violation.code === "duplicate_scope_id");
    expect(duplicate, "das verworfene Gewicht des SLOC-Mittels blieb unbemerkt").toBeDefined();
    expect(duplicate?.detail).toContain("sloc 40 vs. 10");
  });

  it("laesst eine wirklich identische Wiederholung weiterhin still durchgehen", () => {
    const violations = checkScopeTreeInvariants([
      { ...BASE, sloc: 10 },
      { ...BASE, sloc: 10 },
    ]);
    expect(violations.some((violation) => violation.code === "duplicate_scope_id")).toBe(false);
    const result = aggregateScopeTree([
      { ...BASE, sloc: 10 },
      { ...BASE, sloc: 10 },
    ]);
    expect(result.duplicatesDropped).toBe(1);
    expect(result.scopeCount).toBe(1);
  });
});

describe("WP-185 — ein Parse-Fehler verschwindet nicht unter einer 0", () => {
  const diagnostic = (kind: ParseDiagnostic["kind"]): ParseDiagnostic => ({
    severity: "error",
    kind,
    message: `Expected ")" (${kind})`,
    range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 },
  });

  const facts = (diagnostics: readonly ParseDiagnostic[]): ComplexityFacts => ({
    symbolScopes: [],
    decisions: [],
    nestingEvents: [],
    operators: [],
    operands: [],
    nodeKinds: [],
    comments: [],
    identifiers: [],
    literals: [],
    parseDiagnostics: [...diagnostics],
  });

  it("weist Diagnosen der Art 'other' aus, statt 0 Fehlerknoten zu melden und zu schweigen", () => {
    // Genau die Form, die der handgeschriebene Python-Parser erzeugt: er kennt
    // keine tree-sitter-Fehlerknoten und meldet seine Syntaxfehler als
    // `"other"`. `parse_error_node_count` blieb dabei auf 0 — und 0 liest
    // sich wie „heiler Baum".
    const result = computeSyntactic(facts([diagnostic("other"), diagnostic("other")]), 10);
    expect(result.metrics["parse_error_node_count"]).toBe(0);
    expect(result.metrics["parse_diagnostic_count"]).toBe(2);
    expect(
      result.metrics["unclassified_parse_error_count"],
      "die Fehler des Parsers verschwinden unter einer 0",
    ).toBe(2);
  });

  it("laesst die beiden bestehenden Kennzahlen unveraendert bedeuten, was ihr Name sagt", () => {
    const result = computeSyntactic(
      facts([diagnostic("error_node"), diagnostic("missing_node"), diagnostic("other")]),
      10,
    );
    expect(result.metrics["parse_error_node_count"]).toBe(1);
    expect(result.metrics["missing_node_count"]).toBe(1);
    expect(result.metrics["unclassified_parse_error_count"]).toBe(1);
    expect(result.metrics["parse_diagnostic_count"]).toBe(3);
  });

  it("meldet fuer einen heilen Baum ueberall 0 — es wird nichts erfunden", () => {
    const result = computeSyntactic(facts([]), 10);
    expect(result.metrics["parse_diagnostic_count"]).toBe(0);
    expect(result.metrics["unclassified_parse_error_count"]).toBe(0);
  });
});
