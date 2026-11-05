/**
 * Der backend-neutrale Baumvertrag (`shared/syntax.ts`), nachgebaut ueber
 * `SgNode`.
 *
 * WARUM DAS HIER TEURER IST ALS DER ANDERE WEG, und warum wir es trotzdem so
 * bauen: ast-grep hat KEINE Cursor-API. Es gibt kein Gegenstueck zu
 * `gotoFirstChild`/`gotoNextSibling`/`gotoParent`; jeder Abstieg geht ueber
 * `children()`, und jedes `children()` baut ein frisches JS-Array aus
 * Knotenwrappern. Gemessen an diesem Repositorium (721 Dateien, 1.143.212
 * Knoten): tree-sitter-Cursor 1.703.642 Knoten/s gegen ast-grep 455.329
 * Knoten/s — Faktor 3,74, Mehrkosten 1,61 us je Knoten. Das ist das Niveau des
 * `.children`-Weges, den WP-95 abgeschafft hat.
 *
 * Deshalb: die JS/TS-Familie bleibt bei tree-sitter, und dieser Cursor ist der
 * Weg fuer Sprachen, die es sonst GAR NICHT gaebe. Fuer sie ist der Aufpreis
 * kein Rueckschritt — er ist der Eintrittspreis.
 *
 * WAS DIESER CURSOR TROTZDEM RICHTIG MACHT:
 *   - Er ist ITERATIV. Ein Baum kann zehntausende Ebenen tief sein (eine lange
 *     `a || b || c`-Kette genuegt); ein rekursiver Walk zerbricht daran mit
 *     `RangeError: Maximum call stack size exceeded`, nachgemessen an 50.000
 *     Gliedern.
 *   - Er materialisiert die Kindliste je Ebene EINMAL, nicht je Zugriff.
 *   - Er merkt sich den Bereich (`range()`) des aktuellen Knotens, weil
 *     `rangeOfCursor` vier Werte daraus liest und ast-grep bei jedem Aufruf ein
 *     verschachteltes Objekt neu baut.
 *
 * WAS ER NICHT KANN — und was der Adapter deshalb ehrlich sagen muss:
 *   - `nodeIsMissing` gibt es bei ast-grep nicht. Hier steht eine HEURISTIK:
 *     ein Blatt der Breite null. An diesem Repositorium war sie exakt (3 von 3
 *     MISSING-Knoten), sie bleibt aber eine Heuristik. `create-adapter.ts`
 *     schreibt das in JEDE davon erzeugte Diagnose.
 *   - `currentFieldName` gibt es nicht als Rueckrichtung. Wir fragen die
 *     Felder ab, die das Sprachprofil nennt, und vergleichen ueber `id()` —
 *     prozesslokal gueltig, nie in Ergebnisdaten (siehe `napi.ts`).
 */
import type { SyntaxCursor, SyntaxNode, SyntaxPoint } from "../shared/syntax.js";

import type { SgNode, SgPos } from "./napi.js";

function pointOf(pos: SgPos): SyntaxPoint {
  return { row: pos.line, column: pos.column };
}

/** Ein `SgNode` in der Form, die `shared/` erwartet. */
export class AstGrepSyntaxNode implements SyntaxNode {
  constructor(
    /** Der rohe ast-grep-Knoten. Nur `syntax.ts` fasst ihn an. */
    readonly sg: SgNode,
    private readonly fieldNames: readonly string[],
  ) {}

  get type(): string {
    return this.sg.kind();
  }

  get text(): string {
    return this.sg.text();
  }

  get isNamed(): boolean {
    return this.sg.isNamed();
  }

  get startIndex(): number {
    return this.sg.range().start.index;
  }

  get endIndex(): number {
    return this.sg.range().end.index;
  }

  get startPosition(): SyntaxPoint {
    return pointOf(this.sg.range().start);
  }

  get endPosition(): SyntaxPoint {
    return pointOf(this.sg.range().end);
  }

  get parent(): SyntaxNode | null {
    const parent = this.sg.parent();
    return parent === null ? null : new AstGrepSyntaxNode(parent, this.fieldNames);
  }

  get previousSibling(): SyntaxNode | null {
    // Geprueft: ast-grep `prev()` liefert auch ANONYME Geschwister (das
    // vorangehende `{` einer Blockklammer ebenso wie einen Kommentar). Waere
    // es nur das vorherige benannte Geschwister, verschoebe sich die
    // Doc-Bindung stillschweigend.
    const previous = this.sg.prev();
    return previous === null ? null : new AstGrepSyntaxNode(previous, this.fieldNames);
  }

  get children(): readonly SyntaxNode[] {
    return this.sg.children().map((child) => new AstGrepSyntaxNode(child, this.fieldNames));
  }

  get namedChildCount(): number {
    return this.sg.namedChildren().length;
  }

  namedChild(index: number): SyntaxNode | null {
    const child = this.sg.namedChildren()[index];
    return child === undefined ? null : new AstGrepSyntaxNode(child, this.fieldNames);
  }

  childForFieldName(fieldName: string): SyntaxNode | null {
    // Ein unbekannter Feldname liefert bei ast-grep `null` (geprueft), wirft
    // also nicht — ein Profil darf nach Feldern fragen, die es in dieser
    // Grammatik nicht gibt.
    const field = this.sg.field(fieldName);
    return field === null ? null : new AstGrepSyntaxNode(field, this.fieldNames);
  }

  walk(): SyntaxCursor {
    return new AstGrepCursor(this.sg, this.fieldNames);
  }
}

/** Eine Ebene des Abstiegs: die Geschwisterliste und die Stelle darin. */
interface CursorLevel {
  siblings: SgNode[];
  index: number;
}

export class AstGrepCursor implements SyntaxCursor {
  private readonly levels: CursorLevel[] = [];
  private rangeCacheNode: SgNode | null = null;
  private rangeCacheValue: { start: SgPos; end: SgPos } | null = null;

  constructor(
    private readonly rootNode: SgNode,
    private readonly fieldNames: readonly string[],
  ) {}

  private get node(): SgNode {
    const level = this.levels[this.levels.length - 1];
    if (level === undefined) return this.rootNode;
    return level.siblings[level.index] as SgNode;
  }

  private get range(): { start: SgPos; end: SgPos } {
    const node = this.node;
    if (this.rangeCacheNode === node && this.rangeCacheValue !== null) return this.rangeCacheValue;
    const value = node.range();
    this.rangeCacheNode = node;
    this.rangeCacheValue = value;
    return value;
  }

  get nodeType(): string {
    return this.node.kind();
  }

  get nodeText(): string {
    return this.node.text();
  }

  get nodeIsMissing(): boolean {
    // HEURISTIK, kein Messwert: ast-grep kennt `ts_node_is_missing` nicht.
    // Ein von der Fehlerkorrektur eingefuegter Knoten hat die Breite null und
    // keine Kinder; die Wurzel ist ausgenommen (eine leere Datei ist kein
    // fehlender Knoten).
    if (this.levels.length === 0) return false;
    const range = this.range;
    return range.start.index === range.end.index && this.node.isLeaf();
  }

  get currentFieldName(): string | undefined {
    const parent = this.parentNode();
    if (parent === null) return undefined;
    const nodeId = this.node.id();
    for (const fieldName of this.fieldNames) {
      const field = parent.field(fieldName);
      if (field !== null && field.id() === nodeId) return fieldName;
    }
    return undefined;
  }

  /** Der Elternknoten der aktuellen Position, oder `null` auf der Wurzel. */
  private parentNode(): SgNode | null {
    if (this.levels.length === 0) return null;
    if (this.levels.length === 1) return this.rootNode;
    const level = this.levels[this.levels.length - 2] as CursorLevel;
    return level.siblings[level.index] as SgNode;
  }

  get currentNode(): SyntaxNode {
    return new AstGrepSyntaxNode(this.node, this.fieldNames);
  }

  get startPosition(): SyntaxPoint {
    return pointOf(this.range.start);
  }

  get endPosition(): SyntaxPoint {
    return pointOf(this.range.end);
  }

  get startIndex(): number {
    return this.range.start.index;
  }

  get endIndex(): number {
    return this.range.end.index;
  }

  gotoParent(): boolean {
    if (this.levels.length === 0) return false;
    this.levels.pop();
    return true;
  }

  gotoFirstChild(): boolean {
    const children = this.node.children();
    if (children.length === 0) return false;
    this.levels.push({ siblings: children, index: 0 });
    return true;
  }

  gotoLastChild(): boolean {
    const children = this.node.children();
    if (children.length === 0) return false;
    this.levels.push({ siblings: children, index: children.length - 1 });
    return true;
  }

  gotoNextSibling(): boolean {
    const level = this.levels[this.levels.length - 1];
    if (level === undefined || level.index + 1 >= level.siblings.length) return false;
    level.index += 1;
    return true;
  }

  gotoPreviousSibling(): boolean {
    const level = this.levels[this.levels.length - 1];
    if (level === undefined || level.index === 0) return false;
    level.index -= 1;
    return true;
  }
}
