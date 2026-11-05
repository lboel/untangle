/**
 * Was der Prosa-Adapter zusagt — und wo er bewusst schweigt (WP-110/WP-217).
 *
 * Der wichtigste Test ist der letzte: `computeComplexity` MUSS leer bleiben.
 * Ein einziger `symbolScope` je Ueberschrift wuerde jede Code-Metrik-Pipeline
 * dazu bringen, `cyclomatic = 1` pro Abschnitt zu rechnen und das zur
 * Repository-Summe zu addieren — eine Zahl, die nichts misst, aber ueberall
 * mitwandert.
 */
import { sha256Hex } from "@untangle-code/domain";
import type { SourceFile } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createProseAdapter } from "./index.js";

const CONTENT = [
  "Vorspann.",
  "",
  "# Titel",
  "",
  "## Teil A",
  "Siehe [spec](./spec.md), [extern](https://example.invalid) und [Anker](#titel).",
  "",
  "## Teil A",
  "Gleicher Breadcrumb, absichtlich.",
  "",
].join("\n");

function parse(content = CONTENT, path = "docs/note.md") {
  const adapter = createProseAdapter();
  const source: SourceFile = {
    fileId: `file:${path}`,
    repoId: "repo",
    refId: "repo:main",
    path,
    languageId: "markdown",
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const result = adapter.parse(source);
  if (result.ast === null) throw new Error("prose parse must never return a null ast");
  return { adapter, ast: result.ast, result, content };
}

describe("Prosa-Adapter", () => {
  it("ist Stufe text und beansprucht die Prosa-Endungen", () => {
    const adapter = createProseAdapter();
    expect(adapter.supportLevel).toBe("text");
    expect(adapter.extensions).toContain(".md");
    expect(adapter.languageId).toBe("markdown");
  });

  it("scheitert nie: Markdown hat keine Syntaxfehler", () => {
    const { result } = parse("### ) } unbalanciert ( {\n\n```\nnicht geschlossen\n");
    expect(result.parseQuality).toBe("complete");
    expect(result.errorNodeCount).toBe(0);
    expect(result.ast).not.toBeNull();
  });

  it("liefert genau EINEN Wurzelbereich, der die ganze Datei spannt", () => {
    const { adapter, ast, content } = parse();
    const regions = adapter.extractChunks(ast);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.chunkKind).toBe("module");
    expect(regions[0]?.range.startByte).toBe(0);
    expect(regions[0]?.range.endByte).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("gliedert in Vorspann plus Prosa-Abschnitte, lueckenlos", () => {
    const { adapter, ast } = parse();
    const children = adapter.extractChunks(ast)[0]?.children ?? [];
    expect(children.map((c) => c.chunkKind)).toEqual([
      "file_preamble",
      "prose_section",
      "prose_section",
      "prose_section",
    ]);
    let cursor = 0;
    for (const child of children) {
      expect(child.range.startByte).toBe(cursor);
      cursor = child.range.endByte;
    }
  });

  it("vereindeutigt gleiche Breadcrumbs, statt ein Symbol zu ueberschreiben", () => {
    const { adapter, ast } = parse();
    const names = adapter.extractSymbols(ast).map((s) => s.qualifiedName);
    expect(names).toEqual(["(Vorspann)", "Titel", "Titel › Teil A", "Titel › Teil A (2)"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("meldet relative Dateiverweise als Importe — und nur diese", () => {
    const { adapter, ast } = parse();
    const imports = adapter.extractImports(ast);
    expect(imports.map((i) => i.specifier)).toEqual(["./spec.md"]);
  });

  it("liefert KEINE Aufrufe, KEINE Halstead-Token und KEINE Scopes (WP-217)", () => {
    const { adapter, ast } = parse();
    expect(adapter.extractCalls(ast)).toEqual([]);
    expect(adapter.tokenizeForHalstead(ast)).toEqual({ operators: [], operands: [] });

    const facts = adapter.computeComplexity(ast);
    expect(facts.symbolScopes).toEqual([]);
    expect(facts.decisions).toEqual([]);
    expect(facts.nestingEvents).toEqual([]);
    expect(facts.nodeKinds).toEqual([]);
  });

  it("ist deterministisch: gleicher Text, gleiche Symbole", () => {
    const first = parse();
    const second = parse();
    expect(JSON.stringify(first.adapter.extractSymbols(first.ast))).toBe(
      JSON.stringify(second.adapter.extractSymbols(second.ast)),
    );
  });
});
