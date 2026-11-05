/**
 * WP-95: die Cursor-Traversierung — und der Defekt, den sie nebenbei behebt.
 *
 * `tree-sitter@0.21.1` meldet ueber `node.children` (und ueber einen auf einen
 * Teilbaum zurueckgesetzten Cursor) fuer manche Kommentarknoten einen FALSCHEN
 * Typ. In diesem Repository traf das 1.411 Kommentarknoten in 207 Dateien; sie
 * hiessen dort `interface_body`. Der frueher rekursive Walk hat sie deshalb
 * nicht als Kommentar erkannt: sie fehlten in `ComplexityFacts.comments`,
 * zaehlten als Halstead-OPERATOR und flossen in `astHash` und
 * `tokenFingerprint` ein — entgegen der ausdruecklichen Zusage in
 * `fingerprint.ts`, dass Fingerabdruecke Kommentare ausschliessen.
 *
 * Nur ein von der WURZEL her abgestiegener Cursor meldet den Typ richtig.
 */
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "../typescript/index.js";

const SOURCE = [
  "export interface FlagSpec {",
  "  readonly kind: string;",
  "  /** Einbuchstabige Kurzform. */",
  "  readonly alias?: string;",
  "}",
  "",
].join("\n");

const adapter = createTypeScriptAdapter();

/**
 * Baut ein vollstaendiges `SourceFile`. Die Pflichtfelder jenseits von Pfad und
 * Inhalt spielen fuer den Walk keine Rolle, muessen aber gesetzt sein — der Typ
 * laesst kein Teilstueck zu, und das ist richtig so: ein halbes `SourceFile`
 * waere anderswo eine stille Fehlerquelle.
 */
function sourceFile(path: string, content: string) {
  return {
    fileId: path,
    repoId: "cursor-walk-test",
    refId: "cursor-walk-test:main",
    path,
    languageId: "typescript",
    content,
    contentHash: `sha256:${path}:${content.length}`,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function analyze() {
  const result = adapter.parse(sourceFile("f.ts", SOURCE));
  if (result.ast === null) throw new Error("Parse fehlgeschlagen");
  return result.ast;
}

describe("Cursor-Walk — Kommentare in einem interface-Rumpf", () => {
  it("meldet den Kommentar als Kommentarbereich", () => {
    const facts = adapter.computeComplexity(analyze());
    const commentTexts = facts.comments.map((range) =>
      SOURCE.slice(range.startByte, range.endByte),
    );
    expect(commentTexts).toContain("/** Einbuchstabige Kurzform. */");
  });

  it("zaehlt den Kommentar NICHT als Halstead-Operator oder -Operand", () => {
    const { operators, operands } = adapter.tokenizeForHalstead(analyze());
    for (const token of [...operators, ...operands]) {
      expect(token.text.startsWith("/*")).toBe(false);
      expect(token.text.startsWith("//")).toBe(false);
    }
  });

  it("fuehrt den Kommentar als Knotenart `comment`, nicht als `interface_body`", () => {
    const facts = adapter.computeComplexity(analyze());
    const kinds = facts.nodeKinds.map((n) => n.kind);
    expect(kinds.filter((k) => k === "comment").length).toBe(1);
    expect(kinds.filter((k) => k === "interface_body").length).toBe(1);
  });

  it("laesst den Kommentar aus beiden Fingerabdruecken heraus", () => {
    const withComment = adapter.extractSymbols(analyze());
    const withoutComment = (() => {
      const stripped = SOURCE.split("\n")
        .filter((line) => !line.trim().startsWith("/**"))
        .join("\n");
      const result = adapter.parse(sourceFile("f.ts", stripped));
      if (result.ast === null) throw new Error("Parse fehlgeschlagen");
      return adapter.extractSymbols(result.ast);
    })();

    const a = withComment.find((s) => s.name === "FlagSpec");
    const b = withoutComment.find((s) => s.name === "FlagSpec");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Ein reiner Kommentar-Edit darf weder Struktur- noch Token-Fingerabdruck
    // bewegen (spec.md §17.3) — genau das war vorher verletzt.
    expect(a?.astHash).toBe(b?.astHash);
    expect(a?.tokenFingerprint).toBe(b?.tokenFingerprint);
  });
});

describe("Cursor-Walk — Ordnung und Vollstaendigkeit", () => {
  it("besucht genau die Knoten des Baums, in Vorordnung", () => {
    // `nodeKinds` ist die Besuchsliste des Walks: gleiche Laenge und gleiche
    // Reihenfolge wie ein unabhaengiger Cursor-Durchlauf ueber denselben Baum,
    // die Wurzel ausgenommen (der Walk beginnt bei ihren Kindern, Tiefe 1).
    const source = [
      "export class C {",
      "  #x = 1;",
      "  method(a: string): void {",
      "    if (a) { for (const c of a) { console.log(c); } }",
      "  }",
      "}",
    ].join("\n");
    const result = adapter.parse(sourceFile("g.ts", source));
    if (result.ast === null) throw new Error("Parse fehlgeschlagen");
    const facts = adapter.computeComplexity(result.ast);

    const root = (result.ast.root as { tree: { rootNode: { walk: () => unknown } } }).tree.rootNode;
    const cursor = (root as { walk: () => Record<string, never> }).walk() as unknown as {
      nodeType: string;
      gotoFirstChild: () => boolean;
      gotoNextSibling: () => boolean;
      gotoParent: () => boolean;
    };
    const expected: { kind: string; depth: number }[] = [];
    const rec = (depth: number): void => {
      if (depth > 0) expected.push({ kind: cursor.nodeType, depth });
      if (cursor.gotoFirstChild()) {
        do {
          rec(depth + 1);
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    rec(0);

    expect(facts.nodeKinds.map((n) => ({ kind: n.kind, depth: n.depth }))).toEqual(expected);
  });
});
