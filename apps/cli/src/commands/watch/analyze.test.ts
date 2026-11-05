/**
 * Tests der Messung — gegen die ECHTEN Adapter (`createParserRegistry`), den
 * ECHTEN Chunker und die ECHTEN Calculator, nie gegen handgebaute Facts.
 * Eine Messung, die nur gegen Attrappen stimmt, sagt nichts ueber den
 * Waechter.
 */
import { createParserRegistry } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { createFileAnalyzer, type FileReadingV1 } from "./analyze.js";
import { metricDeltas, scopeDeltas, verdictOf } from "./delta.js";

const analyze = createFileAnalyzer({
  registry: createParserRegistry(),
  repoId: "test-repo",
  refId: "test-repo:main",
  workspaceId: "ws-test",
  refName: "main",
  repoLabel: "test",
});

function measure(path: string, content: string): FileReadingV1 {
  const outcome = analyze(path, content);
  if (!outcome.ok)
    throw new Error(`erwartete Messung, bekam Ledger-Eintrag: ${outcome.entry.detail}`);
  return outcome.reading;
}

const SIMPLE = `export function classify(value: number): string {
  if (value < 0) {
    return "negative";
  }
  return "positive";
}
`;

/** Dieselbe Funktion, aber mit tief verschachtelten Verzweigungen. */
const TANGLED = `export function classify(value: number): string {
  if (value < 0) {
    if (value < -100) {
      for (let index = 0; index < 3; index++) {
        if (index % 2 === 0 && value !== -1) {
          return "deep";
        }
      }
    }
    return "negative";
  }
  return "positive";
}
`;

describe("createFileAnalyzer", () => {
  it("misst alle vier Metriken und weist ihre Lesart aus", () => {
    const reading = measure("demo.ts", SIMPLE);

    expect(reading.languageId).toBe("typescript");
    expect(reading.parseQuality).toBe("complete");
    expect(reading.totals.cognitive).toBeGreaterThan(0);
    expect(reading.totals.cyclomatic).toBeGreaterThan(0);
    expect(reading.totals.structural).toBeGreaterThan(0);
    // Semantische Ladung kommt aus dem Chunker, nicht aus den Scopes.
    expect(reading.chunkUnits).toBeGreaterThan(0);
    expect(reading.totals.semantic).toBeGreaterThan(0);
  });

  it("meldet steigende Komplexitaet als aufgebaut", () => {
    const before = measure("demo.ts", SIMPLE);
    const after = measure("demo.ts", TANGLED);
    const deltas = metricDeltas(before, after);

    const cognitive = deltas.find((delta) => delta.metric === "cognitive");
    expect(cognitive?.direction).toBe("aufgebaut");
    expect(cognitive?.delta).toBeGreaterThan(0);
    expect(verdictOf(deltas)).toBe("aufgebaut");
  });

  it("meldet fallende Komplexitaet als abgebaut", () => {
    const before = measure("demo.ts", TANGLED);
    const after = measure("demo.ts", SIMPLE);
    const deltas = metricDeltas(before, after);

    const cognitive = deltas.find((delta) => delta.metric === "cognitive");
    expect(cognitive?.direction).toBe("abgebaut");
    expect(cognitive?.delta).toBeLessThan(0);
    expect(verdictOf(deltas)).toBe("abgebaut");
  });

  it("benennt die Beitragsstelle, auch wenn sich alle Byte-Ranges verschoben haben", () => {
    // Der eingefuegte Kommentarblock verschiebt JEDE Byte-Range der Datei.
    // Wuerde der Vergleich an `metrics_scope_id` haengen, saehe er hier "alle
    // Scopes weg, alle Scopes neu" statt eines Deltas an derselben Funktion.
    const before = measure("demo.ts", `// Kopfzeile\n${SIMPLE}`);
    const after = measure(
      "demo.ts",
      `// Kopfzeile\n// noch eine Zeile\n// und noch eine\n${TANGLED}`,
    );

    const scopes = scopeDeltas(before, after, 5);
    expect(scopes.length).toBeGreaterThan(0);
    const cognitive = scopes.find((scope) => scope.metric === "cognitive");
    expect(cognitive).toBeDefined();
    expect(cognitive?.label).toContain("classify");
    expect(cognitive?.direction).toBe("aufgebaut");
    expect(cognitive?.previous).not.toBeNull();
    expect(cognitive?.current).not.toBeNull();
  });

  it("aggregiert ohne Doppelzaehlung: eine Closure zaehlt nicht zweimal", () => {
    const withClosure = measure(
      "closure.ts",
      `export function outer(values: number[]): number[] {
  return values.map((value) => {
    if (value > 0) {
      return value;
    }
    return 0;
  });
}
`,
    );

    // Die Datei hat drei Scopes: den Datei-Scope, `outer` und die Closure
    // darin. In der Lesart "execution_unit" ist die CLOSURE kein eigener
    // Summand — ihr Beitrag steckt bereits im Wert von `outer`. Wuerde sie
    // mitgezaehlt, staende derselbe Quelltext zweimal in der Summe.
    const byLabel = new Map(withClosure.scopes.map((entry) => [entry.label, entry]));
    const closure = [...byLabel.keys()].find((label) => label.includes("<anonymous>"));
    expect(closure).toBeDefined();
    expect(byLabel.get(closure as string)?.selected).toBe(false);
    expect(byLabel.get("outer")?.selected).toBe(true);

    // Und die Gesamtsumme ist exakt die Summe der ausgewaehlten Scopes.
    const selected = withClosure.scopes.filter((entry) => entry.selected);
    for (const metric of ["structural", "cyclomatic", "cognitive"] as const) {
      const sum = selected.reduce((total, entry) => total + entry.values[metric], 0);
      expect(withClosure.totals[metric]).toBe(sum);
    }
  });

  it("liefert fuer eine Datei ohne Sprachadapter einen Ledger-Eintrag mit Grund (E4)", () => {
    // WP-86: `script.rb` taugt hier nicht mehr — Ruby IST seit der
    // Sprachbreite unterstuetzt. Erlang ist es nicht.
    const outcome = analyze("script.erl", "-module(script).\n");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.entry.reason).toBe("unsupported_language");
    expect(outcome.entry.detail.length).toBeGreaterThan(0);
    expect(outcome.entry.path).toBe("script.erl");
  });

  // WP-217: Prosa ist unterstuetzt (Stufe "text"), hat aber keine Scopes. Vier
  // Nullen auszugeben waere schlimmer als ein benannter Vermerk.
  it("gibt fuer Prosa keine vier Nullen aus, sondern einen benannten Vermerk", () => {
    const outcome = analyze("README.md", "# nur Prosa\n");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.entry.reason).toBe("no_metric_defined");
    // Der Vermerk MUSS sagen, wo die Prosa-Metriken stattdessen zu holen sind.
    expect(outcome.entry.detail).toContain("--prose");
  });

  it("nennt eine Lockdatei maschinell erzeugt, nicht 'unsupported_language'", () => {
    const outcome = analyze("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.entry.reason).toBe("generated_content");
  });

  it("faelscht keine Zahlen fuer einen beschaedigten Syntaxbaum", () => {
    const outcome = analyze("broken.ts", "export function broken( {\n  return\n");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.entry.reason).toBe("parse_failed");
    expect(outcome.entry.detail).toContain("parseQuality");
    // E4: nicht nur ein Grund, sondern ein nachvollziehbarer Detailtext.
    expect(outcome.entry.detail.length).toBeGreaterThan(40);
  });

  it("ist deterministisch: zweimal derselbe Inhalt, zweimal dieselben Zahlen", () => {
    const first = measure("demo.ts", TANGLED);
    const second = measure("demo.ts", TANGLED);
    expect(second.totals).toStrictEqual(first.totals);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.scopes.map((scope) => scope.matchKey)).toStrictEqual(
      first.scopes.map((scope) => scope.matchKey),
    );
  });
});
