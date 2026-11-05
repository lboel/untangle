/**
 * REGRESSION (Welle-3-Befund 1, Wurzelursache): `ComplexityFacts.parseDiagnostics`
 * war der einzige Kanal, ueber den nachgelagerte Rechnungen von einem
 * beschaedigten Syntaxbaum erfahren koennen — und er war TOT. Beide Engines
 * legten das Feld hart als `[]` an, `computeComplexity()` reichte es
 * unveraendert durch. Folge: `computeSyntactic()` meldete fuer JEDE Datei
 * `parse_error_node_count: 0` und `missing_node_count: 0`, auch fuer eine mit
 * `parseQuality: "partial"` und 25 Fehlerknoten. Ein stilles Verschlucken
 * genau der Information, die E4 sichtbar verlangt.
 *
 * Die Pruefung laeuft gegen ECHTE Quelltexte durch die echten Adapter, nicht
 * gegen handgebaute Facts: der Defekt sass in der Verdrahtung zwischen
 * `parse()` und `computeComplexity()`, und nur die zeigt er.
 */
import type { SourceFile } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createPythonAdapter } from "./python/index.js";
import { createTypeScriptAdapter } from "./typescript/index.js";

function sourceFile(path: string, languageId: string, content: string): SourceFile {
  return {
    fileId: path,
    repoId: "repo-1",
    refId: "repo-1:main",
    path,
    languageId,
    content,
    contentHash: "hash",
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * Ueberwiegend gueltiges TypeScript mit EINER kaputten Anweisung: genug
 * Fehlerknoten fuer `partial`, zu wenige fuer `failed` (die Schwelle liegt
 * bei der Haelfte aller Knoten, siehe `shared/parse-diagnostics.ts`).
 */
const PARTIAL_TS = [
  "export function alpha(a: number, b: number): number {",
  "  if (a > b) return a;",
  "  return b;",
  "}",
  "",
  "export const broken = ;",
  "",
  "export function beta(values: number[]): number {",
  "  let total = 0;",
  "  for (const value of values) total += value;",
  "  return total;",
  "}",
].join("\n");

const CLEAN_TS = ["export function gamma(a: number): number {", "  return a + 1;", "}"].join("\n");

describe("Parse-Diagnosen erreichen ComplexityFacts (tree-sitter-Adapter)", () => {
  const adapter = createTypeScriptAdapter();

  it("reicht die Diagnosen aus parse() bis in die Facts durch", () => {
    const result = adapter.parse(sourceFile("partial.ts", "typescript", PARTIAL_TS));
    expect(result.parseQuality).toBe("partial");
    expect(result.ast).not.toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);

    const facts = adapter.computeComplexity(result.ast as NonNullable<typeof result.ast>);
    // DAS ist der reparierte Kanal: ohne die Reparatur ist diese Liste leer,
    // obwohl `result.diagnostics` denselben Baum als beschaedigt ausweist.
    expect(facts.parseDiagnostics).toEqual(result.diagnostics);
    expect(facts.parseDiagnostics.length).toBe(result.diagnostics.length);
  });

  it("laesst die Facts einer sauberen Datei leer — die Reparatur erfindet nichts", () => {
    const result = adapter.parse(sourceFile("clean.ts", "typescript", CLEAN_TS));
    expect(result.parseQuality).toBe("complete");
    const facts = adapter.computeComplexity(result.ast as NonNullable<typeof result.ast>);
    expect(facts.parseDiagnostics).toEqual([]);
  });

  it("liefert bei wiederholtem Aufruf dasselbe Ergebnis (memoisierte Analyse)", () => {
    const result = adapter.parse(sourceFile("partial.ts", "typescript", PARTIAL_TS));
    const ast = result.ast as NonNullable<typeof result.ast>;
    expect(adapter.computeComplexity(ast).parseDiagnostics).toEqual(
      adapter.computeComplexity(ast).parseDiagnostics,
    );
  });
});

describe("Parse-Diagnosen erreichen ComplexityFacts (Python-Adapter)", () => {
  const adapter = createPythonAdapter();

  it("reicht die Diagnosen aus parse() bis in die Facts durch", () => {
    // Reichlich gueltige Zeilen: der Python-Adapter stuft nach dem
    // Verhaeltnis Diagnosen/nicht-leere Zeilen ein, ab 30 % gilt der Baum als
    // `failed` (dann gibt es gar keinen AST mehr und der Kanal waere nicht
    // pruefbar). Diese Datei bleibt bewusst deutlich darunter.
    const valid = Array.from(
      { length: 40 },
      (_unused, index) =>
        `def helper_${String(index)}(value):\n    return value + ${String(index)}\n`,
    ).join("");
    const content = `${valid}\nbroken = = 3\n${valid}`;
    const result = adapter.parse(sourceFile("partial.py", "python", content));
    expect(result.parseQuality).toBe("partial");
    expect(result.ast).not.toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);

    const facts = adapter.computeComplexity(result.ast as NonNullable<typeof result.ast>);
    expect(facts.parseDiagnostics).toEqual(result.diagnostics);
  });
});
