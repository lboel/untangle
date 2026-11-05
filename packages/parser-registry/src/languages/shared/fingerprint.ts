/**
 * Symbol fingerprints for change matching (spec.md §17.3).
 *
 * `astHash` — a structural fingerprint: the SHA-256 of a parenthesized
 * `kind(child,child,...)` shape string built from node TYPES only (never
 * identifier/literal text, never whitespace/positions). Two symbols with the
 * same shape but renamed identifiers or reformatted whitespace hash
 * identically — this is `spec.md §17.3` step 3 ("identischer
 * AST-Fingerprint").
 *
 * `tokenFingerprint` — a lexical fingerprint: the SHA-256 of every leaf
 * token's literal TEXT, in source order, joined by U+001F. Unlike
 * `astHash`, a rename DOES change this fingerprint, but formatting
 * (whitespace-only changes) does not, matching `spec.md §17.3` step 4's
 * "Token-/MinHash-Ähnlichkeit" input.
 *
 * Both exclude comments (a doc-comment edit must not look like a structural
 * or lexical change to the symbol it documents).
 *
 * TRAVERSIERUNG (WP-95): beide Funktionen bekommen den CURSOR des laufenden
 * Walks und laufen den Teilbaum ab der aktuellen Position ab; sie geben ihn
 * an genau dieser Position zurueck. Zwei Gruende, keiner davon Geschmack:
 *
 *  1) Tempo. Sie laufen nicht einmal je Datei, sondern einmal je Scope UND
 *     einmal je Wurzel — der Teilbaum eines verschachtelten Symbols wird also
 *     so oft durchlaufen, wie er Scopes ueber sich hat. Ueber `.children`
 *     hiesse das ein Wrapper-Array je Knoten und Durchlauf.
 *
 *  2) RICHTIGKEIT, und das wiegt schwerer. `tree-sitter@0.21.1` meldet den
 *     Typ eines Knotens NUR dann verlaesslich, wenn der Cursor von der Wurzel
 *     her abgestiegen ist. Weder `node.children` noch ein auf einen Teilbaum
 *     zurueckgesetzter Cursor (`node.walk()`) haben den Alias-Zusammenhang
 *     des Elternknotens; in diesem Repository meldeten beide 1.411
 *     Kommentarknoten in 207 Dateien als `interface_body`. Genau diese
 *     Knoten hat der frueher hier stehende `.children`-Lauf NICHT als
 *     Kommentar erkannt und ihren Text in beide Fingerabdruecke geschrieben —
 *     entgegen der Zusage zwei Absaetze weiter oben. Wer diese Funktionen
 *     wieder auf `node.walk()` umstellt, baut den Defekt neu ein.
 */
import { sha256Hex } from "@untangle-code/domain";

import type { LanguageProfile } from "./profile.js";
import type { SyntaxCursor } from "./syntax.js";

/**
 * Baut die Formzeichenkette fuer den Knoten, auf dem der Cursor steht, und
 * laesst den Cursor GENAU DORT zurueck: jede `gotoFirstChild`-Bewegung wird
 * von einem `gotoParent` aufgewogen. Wer das verletzt, verschiebt die
 * Traversierung des Aufrufers.
 */
function structuralShapeAt(cursor: SyntaxCursor, profile: LanguageProfile): string {
  const type = cursor.nodeType;
  if (profile.commentKinds.has(type)) return "";
  if (profile.literalContainerKinds.has(type)) return type;
  if (!cursor.gotoFirstChild()) return type; // entspricht node.childCount === 0

  const childShapes: string[] = [];
  do {
    // Kommentarkinder werden AUSGELASSEN, nicht als "" aufgenommen — genau
    // das tat das frueher vorgeschaltete
    // `.filter((child) => child.type !== "comment")`.
    if (!profile.commentKinds.has(cursor.nodeType)) {
      childShapes.push(structuralShapeAt(cursor, profile));
    }
  } while (cursor.gotoNextSibling());
  cursor.gotoParent();

  return `${type}(${childShapes.join(",")})`;
}

/** Cursor MUSS auf dem Knoten stehen; er steht danach wieder dort. */
export function computeAstHash(cursor: SyntaxCursor, profile: LanguageProfile): string {
  return sha256Hex(structuralShapeAt(cursor, profile));
}

/** Sammelt die Blatttexte; laesst den Cursor auf dem Ausgangsknoten zurueck. */
function collectLeafTextsAt(cursor: SyntaxCursor, profile: LanguageProfile, out: string[]): void {
  const type = cursor.nodeType;
  if (profile.commentKinds.has(type)) return;
  if (profile.literalContainerKinds.has(type)) {
    out.push(cursor.nodeText);
    return;
  }
  if (!cursor.gotoFirstChild()) {
    out.push(cursor.nodeText); // entspricht node.childCount === 0
    return;
  }
  do {
    collectLeafTextsAt(cursor, profile, out);
  } while (cursor.gotoNextSibling());
  cursor.gotoParent();
}

/** Cursor MUSS auf dem Knoten stehen; er steht danach wieder dort. */
export function computeTokenFingerprint(cursor: SyntaxCursor, profile: LanguageProfile): string {
  const tokens: string[] = [];
  collectLeafTextsAt(cursor, profile, tokens);
  return sha256Hex(tokens.join("\u001f"));
}
