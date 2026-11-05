/**
 * Die vier Python-Defekte, die uns in den Wellen 2 bis 7 begegnet sind — als
 * VERHALTENSTESTS gegen die Adapter-Oberflaeche.
 *
 * WARUM ES DIESE DATEI GIBT. Der handgeschriebene Python-Parser (5.604 Zeilen)
 * wurde in Welle 7b durch eine fertige Grammatik abgeloest. Seine Tests fielen
 * dabei mit weg, und das war zur Haelfte richtig: `tokenizer.test.ts` und
 * `parser.test.ts` pruefen interne Formen, die es nicht mehr gibt. Was NICHT
 * verschwinden durfte, sind die VERHALTENSFAELLE — jeder von ihnen steht fuer
 * einen Defekt, den ein Pruefer an einer echten Reproduktion gefunden hat.
 *
 * Deshalb sind sie hier gegen `parse`, `extractSymbols` und `computeComplexity`
 * formuliert: diese Oberflaeche ueberlebt einen Backendwechsel, die Interna
 * nicht. Faellt einer dieser Tests, ist eine bekannte Fehlerklasse
 * zurueckgekehrt — nicht bloss eine Umbenennung.
 */
import { describe, expect, it } from "vitest";

import { createPythonAdapter } from "./index.js";

const adapter = createPythonAdapter();

function parse(name: string, content: string) {
  return adapter.parse({
    fileId: `file-${name}`,
    repoId: "repo-regressions",
    refId: "repo-regressions:main",
    path: `regressions/${name}.py`,
    languageId: "python",
    content,
    contentHash: `sha256:${name}:${content.length}`,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  });
}

/**
 * `parse` liefert `ast: ParsedAst | null` — null bedeutet, dass gar kein Baum
 * entstand. Fuer diese Tests ist das immer ein Fehlschlag: sie pruefen, dass
 * Inhalt ANKOMMT, und ohne Baum ist die Frage schon beantwortet. Deshalb wird
 * hier laut abgebrochen statt still `undefined` weiterzureichen.
 */
function astOf(result: ReturnType<typeof parse>) {
  const { ast } = result;
  if (ast === null) {
    throw new Error(`kein AST entstanden (parseQuality="${result.parseQuality}")`);
  }
  return ast;
}

function decisionCount(result: ReturnType<typeof parse>): number {
  const facts = adapter.computeComplexity(astOf(result)) as unknown as {
    decisions?: unknown[];
    decisionFacts?: unknown[];
  };
  return (facts.decisions ?? facts.decisionFacts ?? []).length;
}

describe("WP-76 — lange elif-Ketten gehen nicht verloren", () => {
  /**
   * Der urspruengliche Defekt: der handgeschriebene Parser lief bei langen
   * elif-Ketten in seine Tiefengrenze, verwarf den Rest und meldete trotzdem
   * `complete` mit 0 Entscheidungen. Der Pruefer belegte es an 20.000 Klauseln.
   */
  it.each([10, 500, 2000])("zaehlt jede der %i Klauseln", (n) => {
    let source = "def f(x):\n    if x == 0:\n        pass\n";
    for (let i = 1; i < n; i += 1) {
      source += `    elif x == ${String(i)}:\n        pass\n`;
    }
    const result = parse(`elif-${String(n)}`, source);
    expect(result.parseQuality).toBe("complete");
    expect(decisionCount(result)).toBe(n);
  });
});

describe("WP-115 — tiefe Verschachtelung im f-String behaelt ihren Inhalt", () => {
  /**
   * Die Invariante lautet NICHT "tiefe Verschachtelung muss ein Diagnostic
   * erzeugen", sondern "Inhalt darf nicht still verlorengehen". Beim alten
   * Parser war ein Diagnostic der einzige Weg, sie zu erfuellen; die Grammatik
   * dahinter verliert den Inhalt gar nicht erst. Die Bedingung mitten in den
   * Klammern ist genau ein Entscheidungspunkt — wird sie gezaehlt, ist nichts
   * verlorengegangen, und nur dann darf "complete" behauptet werden.
   */
  it.each([1, 100, 1000, 5000])("zaehlt die Bedingung in Tiefe %i", (depth) => {
    const source = `y = f"{${"(".repeat(depth)}1 if x else 2${")".repeat(depth)}}"\n`;
    const result = parse(`deep-${String(depth)}`, source);
    expect(result.parseQuality).toBe("complete");
    expect(result.diagnostics).toHaveLength(0);
    expect(decisionCount(result)).toBe(1);
  });

  it.each([
    ['y = f"{1 +}"\n', "abgebrochener Ausdruck"],
    ['y = f"{foo(bar"\n', "nicht geschlossene Klammer"],
    ['y = f"{a b}"\n', "Rest hinter dem Ausdruck"],
  ])("meldet kaputte Eingabe (%s) statt sie zu verschweigen", (source) => {
    const result = parse("broken", source);
    expect(result.parseQuality).not.toBe("complete");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it.each([
    'y = f"{x}"\n',
    'y = f"{x!r}"\n',
    'y = f"{x:>{width}}"\n',
    'y = f"{x=}"\n',
    'y = f"{ {k: v for k, v in d.items()} }"\n',
    'y = f"{n:0{width}d}"\n',
  ])("laesst gueltige Form %s unangetastet", (source) => {
    const result = parse("valid", source);
    expect(result.parseQuality).toBe("complete");
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe("WP-226 — nachgestellter Kommentar beendet die Zeile nicht", () => {
  /**
   * Der alte Tokenizer prueete nur, ob das LETZTE Token ein Kommentar war,
   * statt ob seit dem letzten NEWLINE nur Kommentare kamen. Folge: das NEWLINE
   * ging verloren und die naechste Zeile verschmolz mit der vorigen.
   */
  it("erkennt die Funktion trotz Kommentar hinter dem Doppelpunkt", () => {
    const result = parse("trailing-comment", "def f():  # ein Kommentar\n    return 1\n");
    expect(result.parseQuality).toBe("complete");
    expect(adapter.extractSymbols(astOf(result)).map((s) => s.name)).toContain("f");
  });

  it("verliert die Folgezeile nicht", () => {
    const source = "x = 1  # eins\ny = 2  # zwei\ndef g():  # drei\n    return x + y\n";
    const result = parse("trailing-comment-multi", source);
    expect(result.parseQuality).toBe("complete");
    expect(adapter.extractSymbols(astOf(result)).map((s) => s.name)).toContain("g");
  });
});

describe("WP-238 — mehrere Kontextmanager in einer with-Anweisung", () => {
  /**
   * Der alte Parser liess `with a() as x, b() as y:` die GANZE Datei mit
   * parseQuality "failed" durchfallen — gefunden von einem Gutachter in
   * Welle 7, behoben durch die Abloesung.
   */
  it("parst die Form vollstaendig", () => {
    const result = parse(
      "with-multi",
      "def f():\n    with a() as x, b() as y:\n        return x\n",
    );
    expect(result.parseQuality).toBe("complete");
    expect(result.diagnostics).toHaveLength(0);
    expect(adapter.extractSymbols(astOf(result)).map((s) => s.name)).toContain("f");
  });

  it("parst auch die geklammerte und die async-Form", () => {
    for (const source of [
      "def f():\n    with (a() as x, b() as y):\n        return x\n",
      "async def f():\n    async with a() as x, b() as y:\n        return x\n",
    ]) {
      const result = parse("with-variant", source);
      expect(result.parseQuality).toBe("complete");
      expect(adapter.extractSymbols(astOf(result)).map((s) => s.name)).toContain("f");
    }
  });
});
