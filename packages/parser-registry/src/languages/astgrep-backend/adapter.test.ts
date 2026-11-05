/**
 * Das ast-grep-Backend an echtem Quelltext — Go und Rust.
 *
 * Gepruefft wird der GANZE Adaptervertrag, nicht nur "es parst": Symbole,
 * Regionen, Importe, Aufrufe, Entscheidungen, Kommentare, Diagnosen und
 * Determinismus. Und ausdruecklich die zwei Stellen, an denen sich dieses
 * Backend vom tree-sitter-Weg unterscheidet:
 *
 *   - die HEURISTIK hinter `missingNodeCount` muss in der Diagnose stehen,
 *   - die Besuchsreihenfolge des Cursors muss dieselbe sein wie die eines
 *     unabhaengigen Kindlaufs (sonst weichen Fakten- und Fingerabdrucklisten
 *     zwischen den Backends ab, ohne dass es jemand merkt).
 */
import { readFileSync } from "node:fs";

import type { SourceFile } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createGoAdapter, createRustAdapter, MAX_ASTGREP_SOURCE_BYTES } from "./index.js";

const go = createGoAdapter();
const rust = createRustAdapter();

const GO_SOURCE = `package main

import (
	"fmt"
	env "os"
)

// Greeter greets people.
type Greeter struct {
	Name string
}

// Greet returns a greeting.
func (g *Greeter) Greet(loud bool) string {
	if loud && g.Name != "" {
		for i := 0; i < 3; i++ {
			fmt.Println("HI")
		}
		return "HI"
	} else if g.Name == "" {
		return ""
	}
	switch g.Name {
	case "x":
		return "x"
	default:
		return env.Getenv("NAME")
	}
}

func main() {
	g := &Greeter{Name: "a"}
	fmt.Println(g.Greet(true))
}
`;

const RUST_SOURCE = `use std::collections::HashMap as Map;
use std::fmt::{Debug, Display};

/// A counter.
pub struct Counter {
    n: u32,
}

impl Counter {
    pub fn bump(&mut self, by: u32) -> u32 {
        if by > 0 && self.n < 10 {
            for _ in 0..by {
                self.n += 1;
            }
        }
        match self.n {
            0 => 0,
            _ => self.n,
        }
    }
}
`;

function sourceFile(path: string, content: string, languageId: string): SourceFile {
  return {
    fileId: `astgrep:${path}`,
    repoId: "astgrep-test",
    refId: "astgrep-test:main",
    path,
    languageId,
    content,
    contentHash: `sha256:${path}:${String(content.length)}`,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function parseGo(content = GO_SOURCE) {
  const result = go.parse(sourceFile("main.go", content, "go"));
  if (result.ast === null) throw new Error("Go-Parse fehlgeschlagen");
  return { result, ast: result.ast };
}

function parseRust(content = RUST_SOURCE) {
  const result = rust.parse(sourceFile("lib.rs", content, "rust"));
  if (result.ast === null) throw new Error("Rust-Parse fehlgeschlagen");
  return { result, ast: result.ast };
}

describe("ast-grep-Backend — Go", () => {
  it("meldet einen vollstaendigen Parse ohne Diagnosen", () => {
    const { result } = parseGo();
    expect(result.parseQuality).toBe("complete");
    expect(result.diagnostics).toEqual([]);
    expect(result.errorNodeCount).toBe(0);
    expect(result.missingNodeCount).toBe(0);
  });

  it("findet Typ, Methode und Funktion mit qualifizierten Namen", () => {
    const { ast } = parseGo();
    const symbols = go.extractSymbols(ast);
    const byName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));

    expect(byName.get("Greeter")?.kind).toBe("class");
    // WP-237: der qualifizierte Name traegt den Empfaengertyp. Der SYMBOLNAME
    // bleibt `Greet` — nur so bleiben zwei gleichnamige Methoden auf
    // verschiedenen Typen unterscheidbar.
    expect(byName.get("Greeter.Greet")?.kind).toBe("method");
    expect(byName.get("Greeter.Greet")?.name).toBe("Greet");
    expect(byName.get("main")?.kind).toBe("function");
    // Go exportiert ueber den Grossbuchstaben — das steht in der Tabelle,
    // nicht im Baum.
    expect(byName.get("Greeter.Greet")?.exportedNames).toEqual(["Greet"]);
    expect(byName.get("main")?.exportedNames).toEqual([]);
  });

  it("bindet den vorangehenden Kommentar als Dokumentation an das Symbol", () => {
    const { ast } = parseGo();
    const greeter = go.extractSymbols(ast).find((symbol) => symbol.name === "Greeter");
    expect(greeter?.docRange).toBeDefined();
    const doc = GO_SOURCE.slice(greeter?.docRange?.startByte ?? 0, greeter?.docRange?.endByte ?? 0);
    expect(doc).toBe("// Greeter greets people.");
  });

  it("liest beide Importe samt Alias", () => {
    const { ast } = parseGo();
    const imports = go.extractImports(ast);
    expect(imports.map((entry) => entry.specifier)).toEqual(["fmt", "os"]);
    expect(imports[1]?.importedNames).toEqual(["env"]);
    // Ohne Aliasknoten KEIN erfundener Name.
    expect(imports[0]?.importedNames).toBeUndefined();
  });

  it("liest Aufrufe mit Qualifizierer und Argumentzahl", () => {
    const { ast } = parseGo();
    const calls = go.extractCalls(ast);
    const println = calls.find((call) => call.calleeName === "Println");
    expect(println?.qualifier).toBe("fmt");
    expect(println?.argumentCount).toBe(1);
    expect(calls.some((call) => call.calleeName === "Greet")).toBe(true);
  });

  it("zaehlt Entscheidungen inklusive else-if, case und logischem Und", () => {
    const { ast } = parseGo();
    const kinds = go.computeComplexity(ast).decisions.map((decision) => decision.kind);
    expect(kinds).toContain("if");
    expect(kinds).toContain("else_if");
    expect(kinds).toContain("loop");
    expect(kinds).toContain("case");
    expect(kinds).toContain("logical_and");
  });

  it("erkennt eine Guard-Clause durch beide Rumpfhuellen hindurch", () => {
    const guardSource = `package main

func f(a int) int {
	if a < 0 {
		return 0
	}
	return a
}
`;
    const { ast } = parseGo(guardSource);
    const kinds = go.computeComplexity(ast).decisions.map((decision) => decision.kind);
    expect(kinds).toContain("guard");
  });

  it("fuehrt Kommentare als Kommentare und nie als Halstead-Token", () => {
    const { ast } = parseGo();
    const facts = go.computeComplexity(ast);
    expect(facts.comments.length).toBe(2);
    for (const token of [...facts.operators, ...facts.operands]) {
      expect(token.text.startsWith("//")).toBe(false);
    }
  });

  it("liefert genau eine Modul-Wurzelregion, die die ganze Datei ueberspannt", () => {
    const { ast } = parseGo();
    const regions = go.extractChunks(ast);
    expect(regions.length).toBe(1);
    expect(regions[0]?.chunkKind).toBe("module");
    expect(regions[0]?.range.startByte).toBe(0);
    expect(regions[0]?.range.endByte).toBe(Buffer.byteLength(GO_SOURCE, "utf8"));
  });

  it("rechnet Byte-Bereiche ueber Nicht-ASCII hinweg richtig", () => {
    const source = `package main

// Gruesse: äöü 😀
func f() string {
	return "äöü"
}
`;
    const { ast } = parseGo(source);
    const symbol = go.extractSymbols(ast).find((entry) => entry.name === "f");
    const sliced = Buffer.from(source, "utf8")
      .subarray(symbol?.range.startByte ?? 0, symbol?.range.endByte ?? 0)
      .toString("utf8");
    expect(sliced.startsWith("func f() string {")).toBe(true);
  });

  it("ist deterministisch: zwei Laeufe liefern identische Fakten", () => {
    // Der Beweis, dass keine Laufzeit-Knotenkennung (`SgNode#id()`, adress-
    // abgeleitet) in Ergebnisdaten gelangt ist.
    const first = JSON.stringify(go.computeComplexity(parseGo().ast));
    const second = JSON.stringify(go.computeComplexity(parseGo().ast));
    expect(first).toBe(second);
    expect(JSON.stringify(go.extractSymbols(parseGo().ast))).toBe(
      JSON.stringify(go.extractSymbols(parseGo().ast)),
    );
  });

  it("besucht genau die Knoten des Baums, in Vorordnung", () => {
    const { ast } = parseGo();
    const facts = go.computeComplexity(ast);
    const root = (ast.root as { root: { children: readonly { type: string }[] } }).root;

    const expected: { kind: string; depth: number }[] = [];
    const stack: { node: { type: string; children: readonly unknown[] }; depth: number }[] = [
      { node: root as never, depth: 0 },
    ];
    while (stack.length > 0) {
      const current = stack.pop() as {
        node: { type: string; children: readonly unknown[] };
        depth: number;
      };
      if (current.depth > 0) expected.push({ kind: current.node.type, depth: current.depth });
      const children = current.node.children;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({
          node: children[index] as { type: string; children: readonly unknown[] },
          depth: current.depth + 1,
        });
      }
    }

    // Kommentarknoten haben in Go keine Kinder; Zeichenkettenliterale schon,
    // werden vom Walk aber als EIN Operand behandelt. Beide Faelle muessen
    // beim Vergleich beruecksichtigt werden — sonst prueft der Test die
    // falsche Erwartung.
    const walked = facts.nodeKinds.map((node) => ({ kind: node.kind, depth: node.depth }));
    const stopKinds = new Set(["interpreted_string_literal", "raw_string_literal", "rune_literal"]);
    const expectedWithoutLiteralInnards: { kind: string; depth: number }[] = [];
    let skipBelowDepth: number | null = null;
    for (const entry of expected) {
      if (skipBelowDepth !== null && entry.depth > skipBelowDepth) continue;
      skipBelowDepth = null;
      expectedWithoutLiteralInnards.push(entry);
      if (stopKinds.has(entry.kind)) skipBelowDepth = entry.depth;
    }
    expect(walked).toEqual(expectedWithoutLiteralInnards);
  });
});

describe("ast-grep-Backend — Ehrlichkeit bei kaputtem Quelltext", () => {
  const BROKEN = `package main

func g( {
	return
`;

  it("meldet den Schaden statt ihn zu verschlucken", () => {
    const result = go.parse(sourceFile("broken.go", BROKEN, "go"));
    expect(result.parseQuality).not.toBe("complete");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("sagt in JEDER missing_node-Diagnose, dass sie geschaetzt ist", () => {
    const result = go.parse(sourceFile("broken.go", BROKEN, "go"));
    const missing = result.diagnostics.filter((entry) => entry.kind === "missing_node");
    expect(missing.length).toBe(result.missingNodeCount);
    expect(missing.length).toBeGreaterThan(0);
    for (const diagnostic of missing) {
      // ast-grep hat kein `nodeIsMissing`. Wer die Zahl liest, muss sehen,
      // dass sie aus einer Heuristik stammt (E4).
      expect(diagnostic.message).toContain("heuristically");
      expect(diagnostic.message).toContain("nodeIsMissing");
    }
  });

  it("weist eine zu grosse Datei mit benanntem Grund ab statt sie zu verschweigen", () => {
    const huge = `package main\n// ${"x".repeat(7 * 1024 * 1024)}\n`;
    let thrown: unknown;
    try {
      go.parse(sourceFile("huge.go", huge, "go"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { kind?: string }).kind).toBe("file_too_large");
  });

  it("nennt in der Backend-Dokumentation dieselbe Groessengrenze wie der Code (WP-244, E4)", () => {
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    const documentedRow = readme.split("\n").find((line) => line.includes("| Size limit"));
    const limitMiB = MAX_ASTGREP_SOURCE_BYTES / (1024 * 1024);

    expect(documentedRow).toBeDefined();
    expect(documentedRow).toContain(`**${String(limitMiB)} MiB**`);
  });
});

describe("ast-grep-Backend — Rust", () => {
  it("findet Struktur, Impl-Block und Funktion", () => {
    const { ast, result } = parseRust();
    expect(result.parseQuality).toBe("complete");
    const symbols = rust.extractSymbols(ast);
    const names = symbols.map((symbol) => symbol.qualifiedName);
    expect(names).toContain("Counter");
    expect(names).toContain("Counter.bump");
  });

  it("packt Alias- und Listenimporte aus", () => {
    const { ast } = parseRust();
    const imports = rust.extractImports(ast);
    expect(imports[0]?.specifier).toBe("std::collections::HashMap");
    expect(imports[0]?.importedNames).toEqual(["Map"]);
    expect(imports[1]?.specifier).toBe("std::fmt");
    expect(imports[1]?.importedNames).toEqual(["Debug", "Display"]);
  });

  it("zaehlt match-Arme als Faelle, den Auffangarm aber nicht", () => {
    const { ast } = parseRust();
    const kinds = rust.computeComplexity(ast).decisions.map((decision) => decision.kind);
    // WP-86 hat diese Erwartung von 2 auf 1 GESENKT, und zwar mit Absicht:
    // `match self.n { 0 => 0, _ => self.n }` hat ZWEI Arme, aber nur EINEN
    // zusaetzlichen unabhaengigen Pfad. Der Arm `_` ist Rusts `default` — er
    // faengt, was uebrig bleibt. Vorher zaehlte er mit, und jede Rust-Datei
    // mit Auffangarm bekam eine zyklomatische Zahl zu viel.
    expect(kinds.filter((kind) => kind === "case").length).toBe(1);
    expect(kinds).toContain("logical_and");
    expect(kinds).toContain("loop");
  });

  it("liest die Sichtbarkeit aus dem Baum", () => {
    const { ast } = parseRust();
    const counter = rust.extractSymbols(ast).find((symbol) => symbol.name === "Counter");
    expect(counter?.visibility).toBe("pub");
  });

  it("bindet den Doc-Kommentar an die Struktur", () => {
    const { ast } = parseRust();
    const counter = rust.extractSymbols(ast).find((symbol) => symbol.name === "Counter");
    expect(counter?.docRange).toBeDefined();
  });

  it("begrenzt Rust-Dokumentationskommentare auf ihre eigene Zeile (WP-236, E4)", () => {
    const source = [
      "//! Dokumentation der Größe.",
      "fn first() {}",
      "/// Dokumentation der Funktion 😀.",
      "fn second() {}",
      "",
    ].join("\r\n");
    const { ast } = parseRust(source);
    const facts = rust.computeComplexity(ast);

    // Mutationsschranke: Ohne die Normalisierung endet jeder Rust-Doccomment
    // am ANFANG der Folgezeile. Weil SourceRange-Zeilen inklusive sind, wuerde
    // diese Zeile dann als Kommentar gelten und aus SLOC herausfallen.
    expect(facts.comments.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    const sourceBytes = Buffer.from(source, "utf8");
    expect(
      facts.comments.map((range) =>
        sourceBytes.subarray(range.startByte, range.endByte).toString("utf8"),
      ),
    ).toEqual(["//! Dokumentation der Größe.", "/// Dokumentation der Funktion 😀."]);

    const second = rust.extractSymbols(ast).find((symbol) => symbol.name === "second");
    expect(second?.docRange?.endLine).toBe(3);
    expect(second?.docRange?.endByte).toBe(
      Buffer.byteLength(source.slice(0, source.indexOf("\r\nfn second")), "utf8"),
    );
  });

  it("meldet Trait-Signaturen, aber keine Funktionen aus `extern`-Bloecken (WP-242)", () => {
    const source = [
      'extern "C" {',
      "  fn foreign_add(a: i32, b: i32) -> i32;",
      "}",
      "trait Math {",
      "  fn add(&self, a: i32, b: i32) -> i32;",
      "}",
      "",
    ].join("\n");
    const { ast } = parseRust(source);
    const symbols = rust.extractSymbols(ast);

    expect(symbols.find((symbol) => symbol.name === "foreign_add")).toBeUndefined();
    expect(symbols.find((symbol) => symbol.qualifiedName === "Math.add")?.kind).toBe("method");
    expect(
      rust.computeComplexity(ast).nestingEvents.some((event) => event.construct === "lambda"),
    ).toBe(false);
  });
});

describe("WP-237 — Gos Methodenempfaenger unterscheidet gleichnamige Methoden", () => {
  /**
   * Go haengt eine Methode nicht in ihren Typ, sondern fuehrt ihn als Feld:
   * `func (a *A) Run()` ist ein GESCHWISTER von `type A struct{}`. Ohne den
   * Empfaenger heissen `(*A).Run` und `(*B).Run` beide `Run`, und der
   * Symbolgraph haelt zwei verschiedene Methoden fuer dieselbe — eine
   * Impact-Analyse auf einer Go-Codebasis waere damit schlicht falsch.
   *
   * Der SYMBOLNAME bleibt `Run`; nur der qualifizierte Name traegt den Traeger.
   */
  const source = [
    "package main",
    "type A struct{}",
    "type B struct{}",
    "type Pair[A, B any] struct{}",
    "func (a *A) Run() int { return 1 }",
    "func (b *B) Run() int { return 2 }",
    "func (A) Bare() int { return 3 }",
    "func Free() int { return 4 }",
    "func (p Pair[A, B]) Swap() int { return 5 }",
    "",
  ].join("\n");

  function symbolsOf() {
    const adapter = createGoAdapter();
    const content = source;
    const file: SourceFile = {
      fileId: "file-wp237",
      repoId: "repo-wp237",
      refId: "repo-wp237:main",
      path: "wp237/main.go",
      languageId: "go",
      content,
      contentHash: `sha256:wp237:${String(content.length)}`,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
    const result = adapter.parse(file);
    expect(result.parseQuality).toBe("complete");
    const { ast } = result;
    if (ast === null) throw new Error("kein AST entstanden");
    return adapter.extractSymbols(ast);
  }

  it("gibt gleichnamigen Methoden verschiedene qualifizierte Namen", () => {
    const runs = symbolsOf().filter((s) => s.name === "Run");
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((s) => s.qualifiedName)).size).toBe(2);
    expect(runs.map((s) => s.qualifiedName).sort()).toEqual(["A.Run", "B.Run"]);
  });

  it("laesst den Symbolnamen unangetastet", () => {
    const runs = symbolsOf().filter((s) => s.qualifiedName.endsWith(".Run"));
    expect(runs.every((s) => s.name === "Run")).toBe(true);
  });

  it("kommt ohne Empfaengernamen aus — `func (A) Bare()` ist gueltiges Go", () => {
    const bare = symbolsOf().find((s) => s.name === "Bare");
    expect(bare?.qualifiedName).toBe("A.Bare");
  });

  it("liest den Traeger generischer Methoden strukturell statt am Leerzeichen", () => {
    const swap = symbolsOf().find((s) => s.name === "Swap");
    expect(swap?.qualifiedName).toBe("Pair.Swap");
  });

  it("laesst eine freie Funktion ohne Traeger", () => {
    const free = symbolsOf().find((s) => s.name === "Free");
    expect(free?.qualifiedName).toBe("Free");
  });
});
