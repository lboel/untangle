/**
 * Der backend-neutrale Baumvertrag dieses Pakets.
 *
 * WARUM ES IHN GIBT: seit WP-220 laufen ZWEI Parser-Backends unter demselben
 * `LanguageAdapter` (domain `analysis.ts`) — `tree-sitter` fuer die
 * JS/TS-Familie und `@ast-grep/napi` fuer die Sprachen, fuer die wir keine
 * eigene Grammatik pflegen wollen. Der vereinheitlichte Walk (`engine.ts`),
 * die Parse-Diagnosen (`parse-diagnostics.ts`), die Fingerabdruecke
 * (`fingerprint.ts`) und der Regionenbaum (`chunks.ts`) sind fuer BEIDE
 * dieselben Zeilen. Sie sprechen deshalb nicht mehr ueber
 * `Parser.SyntaxNode`/`Parser.TreeCursor`, sondern ueber die zwei Formen hier.
 *
 * DIE FORMEN SIND ABSICHTLICH DIE VON TREE-SITTER. `Parser.SyntaxNode` und
 * `Parser.TreeCursor` erfuellen sie STRUKTURELL, ohne einen einzigen Wrapper:
 * der tree-sitter-Weg zahlt fuer diese Abstraktion nichts, kein Objekt, kein
 * Aufruf mehr als vorher (`languages/shared/tree-sitter-types.ts` haelt die
 * Zusage mit einer Zuweisungspruefung fest). Die Kosten traegt der neue Weg:
 * `languages/astgrep-backend/syntax.ts` baut die Form ueber `SgNode` nach, weil
 * ast-grep KEINE Cursor-API hat (gemessen: Faktor 3,74 auf dem Walk). Diese
 * Richtung ist gewollt — der gemessen schnellere Weg bleibt der billige.
 *
 * ZWEI EIGENSCHAFTEN, DIE JEDES BACKEND EINHALTEN MUSS:
 *
 *  1. `startIndex`/`endIndex` und `startPosition.column` sind UTF-16-Offsets,
 *     NICHT Bytes — bei tree-sitter ebenso wie bei ast-grep, dessen
 *     Typdefinition `Pos.index` faelschlich als "byte offset" beschreibt
 *     (nachgemessen an Umlauten und Emoji). Bytes entstehen ausschliesslich
 *     in `node-utils.ts#rangeOf`/`rangeOfCursor` ueber die `ByteOffsetTable`.
 *
 *  2. Ein Cursor wird IMMER an der Ausgangsposition zurueckgegeben. Jede
 *     Hilfsfunktion, die ihn bewegt, bewegt ihn zurueck.
 */
/** Zeile/Spalte eines Knotens; `row` und `column` sind 0-basiert. */
export interface SyntaxPoint {
  readonly row: number;
  readonly column: number;
}

/**
 * Ein Knoten des Syntaxbaums — die Teilmenge der tree-sitter-Knotenform, die
 * dieses Paket wirklich benutzt. Wer hier etwas hinzufuegt, verpflichtet
 * BEIDE Backends dazu; `languages/astgrep-backend/syntax.ts` muss es dann nachbauen.
 */
export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  /**
   * Benannter Knoten der Grammatik (kein reines Satzzeichen-/Schluesselwort-
   * Token). Beide Backends liefern das ohne Umweg (tree-sitter `isNamed`,
   * ast-grep `isNamed()`); gebraucht wird es dort, wo ein Operator KEIN
   * eigenes Feld hat und nur ueber "das anonyme Kind" zu finden ist.
   */
  readonly isNamed: boolean;
  /** UTF-16-Offset des ersten Zeichens (siehe Modulkopf, Punkt 1). */
  readonly startIndex: number;
  /** UTF-16-Offset hinter dem letzten Zeichen. */
  readonly endIndex: number;
  readonly startPosition: SyntaxPoint;
  readonly endPosition: SyntaxPoint;
  readonly parent: SyntaxNode | null;
  /**
   * Vorheriges Geschwister — auch ein anonymes. `doc-binding.ts` laeuft
   * darueber rueckwaerts zu Dekoratoren und Doc-Kommentaren; wuerde ein
   * Backend hier nur BENANNTE Geschwister liefern, veraenderte das die
   * Doc-Bindung stillschweigend (ast-grep `prev()` ist deshalb geprueft).
   */
  readonly previousSibling: SyntaxNode | null;
  readonly children: readonly SyntaxNode[];
  readonly namedChildCount: number;
  namedChild(index: number): SyntaxNode | null;
  childForFieldName(fieldName: string): SyntaxNode | null;
  /** Ein Cursor, der auf DIESEM Knoten steht. */
  walk(): SyntaxCursor;
}

/**
 * Der Traversierungszeiger. Bei tree-sitter haelt er die Position nativ und
 * baut je Knoten KEINEN Wrapper (WP-95); bei ast-grep bildet ihn ein
 * expliziter Stapel nach. Der Vertrag ist in beiden Faellen derselbe, und die
 * Besuchsreihenfolge ebenfalls: Vorordnung ueber `gotoFirstChild` /
 * `gotoNextSibling` / `gotoParent`, Rueckordnung ueber `gotoLastChild` /
 * `gotoPreviousSibling` (die Parse-Diagnosen laufen rueckwaerts, siehe
 * `parse-diagnostics.ts`).
 */
export interface SyntaxCursor {
  readonly nodeType: string;
  readonly nodeText: string;
  /**
   * Fehlender Knoten der Fehlerkorrektur (tree-sitter `ts_node_is_missing`).
   *
   * ast-grep hat dazu KEIN Gegenstueck. Sein Cursor liefert an dieser Stelle
   * eine HEURISTIK (Knoten der Breite null), und der Adapter sagt das in der
   * Diagnose auch — `languages/astgrep-backend/syntax.ts` und
   * `languages/astgrep-backend/create-adapter.ts`. Wer den Wert liest, muss wissen,
   * dass er je nach Backend gemessen oder geschaetzt ist.
   */
  readonly nodeIsMissing: boolean;
  /**
   * Feldname, unter dem der aktuelle Knoten in seinem Elternknoten steht,
   * oder `undefined`. tree-sitter liefert ihn ohne Zusatzkosten; der
   * ast-grep-Cursor muss ihn ueber die Felder des Elternknotens suchen und
   * kennt deshalb nur die Feldnamen, die das Sprachprofil nennt
   * (`profile.ts#LanguageProfile.fieldNames`).
   */
  readonly currentFieldName: string | undefined;
  readonly currentNode: SyntaxNode;
  readonly startPosition: SyntaxPoint;
  readonly endPosition: SyntaxPoint;
  readonly startIndex: number;
  readonly endIndex: number;
  gotoParent(): boolean;
  gotoFirstChild(): boolean;
  gotoLastChild(): boolean;
  gotoNextSibling(): boolean;
  gotoPreviousSibling(): boolean;
}
