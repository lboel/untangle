/**
 * Thin type-only surface over the `tree-sitter` native binding.
 *
 * We import only types here (`import type`) — the actual native module is
 * loaded lazily and dynamically at runtime via `grammar-loader.ts` using
 * `createRequire`, never through a static `import` statement. That is what
 * makes grammar loading lazy: requiring this file costs nothing at the
 * native-addon level, only `loadGrammar()` does, and only for languages
 * actually used.
 */
import type Parser from "tree-sitter";

import type { SyntaxCursor, SyntaxNode } from "./syntax.js";

export type TsSyntaxNode = Parser.SyntaxNode;
/** Eine Parserinstanz mit gesetzter Grammatik (siehe `parse-limits.ts#parseWithBuffer`). */
export type TsParser = Parser;
export type TsTree = Parser.Tree;
/**
 * Der native Baumcursor (`tree.walk()` / `node.walk()`). Er haelt die
 * Position IN der nativen Bibliothek; `gotoFirstChild`/`gotoNextSibling`/
 * `gotoParent` verschieben sie, ohne je einen JS-Knotenwrapper zu bauen.
 * Genau darum ist er der Traversierungsweg dieses Pakets (WP-95) — `.children`
 * materialisiert je Knoten ein Array aus Wrappern.
 */
export type TsTreeCursor = Parser.TreeCursor;
export type TsPoint = Parser.Point;
export type TsParserCtor = typeof Parser;

/** Opaque tree-sitter `Language` handle, as accepted by `Parser#setLanguage`. */
export type TsLanguage = unknown;

/**
 * Die Zusage aus `syntax.ts`, hier festgenagelt: die NATIVEN tree-sitter-Formen
 * erfuellen den backend-neutralen Baumvertrag STRUKTURELL. Kein Wrapper, kein
 * Adapterobjekt, keine zusaetzliche Grenzueberquerung je Knoten — der Weg, den
 * WP-95 saniert hat, bleibt genau so teuer wie vorher.
 *
 * Diese beiden Zuweisungen sind reine Typaussagen (`never` zur Laufzeit
 * unbenutzt). Bricht eine kuenftige Aenderung an `syntax.ts` die Vertraglichkeit,
 * scheitert der Typcheck HIER — und nicht erst an der Aufrufstelle, an der
 * jemand versucht waere, sie mit einer Umtypung zu erschlagen.
 */
type AssertAssignable<Target, Source extends Target> = [Target, Source];
export type TreeSitterSatisfiesSyntaxNode = AssertAssignable<SyntaxNode, TsSyntaxNode>;
export type TreeSitterSatisfiesSyntaxCursor = AssertAssignable<SyntaxCursor, TsTreeCursor>;
