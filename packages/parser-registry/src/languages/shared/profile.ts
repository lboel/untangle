/**
 * Das SPRACHPROFIL: alles, was der vereinheitlichte Walk (`engine.ts`) ueber
 * eine konkrete Sprache wissen muss — als Tabelle plus eine Handvoll Haken,
 * nicht als verdrahtete Zeichenketten im Motor.
 *
 * WARUM (WP-220): bis Welle 6 stand die JS/TS-Familie fest im Motor. `engine.ts`
 * nannte 48 verschiedene Knotenarten woertlich, `fingerprint.ts` kannte
 * `"comment"` als Konstante, `chunks.ts` kannte `export_statement`. Solange es
 * genau ein Backend und genau eine Sprachfamilie gab, war das billig und
 * ehrlich. Mit dem zweiten Backend (`languages/astgrep-backend/`) waere daraus ein
 * ZWEITER Motor neben dem ersten geworden — und damit das Gegenteil der These
 * aus vision.md §1b, die wir belegen wollen: gleiche Leistung mit WENIGER
 * Komplexitaet. Deshalb erst die Verallgemeinerung, dann das Backend.
 *
 * ZWEI ARTEN, EIN PROFIL ZU BAUEN:
 *
 *  1. `js-family-profile.ts` — die handgeschriebene Fassung fuer
 *     TypeScript/JavaScript/TSX/JSX. Sie reicht die vorhandenen Detektoren
 *     (`decisions.ts`, `import-detection.ts`, `call-detection.ts`,
 *     `scope-naming.ts`, `scope-signature.ts`, `doc-binding.ts`) unveraendert
 *     durch. Ihr Verhalten ist Zeile fuer Zeile das von vorher; die
 *     Golden-Tests dieses Pakets sind der Beleg.
 *
 *  2. `table-profile.ts` — die tabellengetriebene Fassung fuer jede weitere
 *     Sprache. Sie kennt keine Sprache, nur Rollen: welche Knotenart ist ein
 *     Kommentar, welche oeffnet einen Scope, welche traegt eine Entscheidung.
 *     Eine neue Sprache kostet damit eine Tabelle, keinen Motor.
 *
 * WAS HIER NICHT HINEINGEHOERT: alles Backendspezifische. Ein Profil sagt,
 * WAS eine Knotenart bedeutet, nie, WIE der Baum entsteht. Das Backend steht
 * in `create-adapter.ts` (tree-sitter) bzw. `languages/astgrep-backend/create-adapter.ts`.
 */
import type {
  LiteralFact,
  RawCall,
  RawImport,
  SourceRange,
  SupportLevel,
} from "@untangle-code/domain";

import type { DecisionDetectionResult } from "./decisions.js";
import type { FileTextContext } from "./node-utils.js";
import type { ScopeNode } from "./scope-model.js";
import type { SyntaxNode } from "./syntax.js";

/** Die Fakten, die ein Knoten ausserhalb von Entscheidungen beitragen kann. */
export interface ModuleFactSink {
  imports: RawImport[];
  calls: RawCall[];
}

/** Roh- und Normalform der Kopfzeile eines Symbols (siehe `signature.ts`). */
export interface ScopeSignature {
  raw?: string;
  normalized: string;
}

/**
 * Ein Sprachprofil. Jede Eigenschaft wird vom Walk GENAU EINMAL je Knoten
 * gelesen; die Mengen sind deshalb `Set`s und keine Arrays.
 */
export interface LanguageProfile {
  readonly languageId: string;
  readonly extensions: readonly string[];
  readonly supportLevel: SupportLevel;

  // -- Knotenrollen ---------------------------------------------------------

  /** Kommentarknoten: nie Operator, nie Operand, nie Teil eines Fingerabdrucks. */
  readonly commentKinds: ReadonlySet<string>;
  /**
   * Knoten, deren ganzer Teilbaum als EIN Operand/Literal zaehlt (der Walk
   * steigt nicht hinein). In der JS/TS-Familie `string` und `regex`.
   */
  readonly literalContainerKinds: ReadonlySet<string>;
  /** Blattknoten, die ein Bezeichnervorkommen sind. */
  readonly identifierLeafKinds: ReadonlySet<string>;
  /** Blattknoten, die ein einfaches Literal sind. */
  readonly simpleLiteralLeafKinds: ReadonlySet<string>;
  /** Statische Textteile in einer Zeichenkettenschablone. */
  readonly templateTextLeafKinds: ReadonlySet<string>;
  /** Satzzeichenblaetter, die weder Operator noch Operand sind. */
  readonly ignoredPunctuationKinds: ReadonlySet<string>;
  /**
   * Elternknotenarten, deren Blaetter reine Typsyntax sind (TS
   * `predefined_type`): gezaehlt in `nodeKinds`, aber nie als Token.
   */
  readonly typeKeywordParentKinds: ReadonlySet<string>;
  /** Funktionsartige Knoten — sie erzeugen zusaetzlich ein Lambda-Nesting. */
  readonly functionLikeKinds: ReadonlySet<string>;

  /** Literalart eines Container-Literals (`literalContainerKinds`). */
  containerLiteralKind(kind: string): LiteralFact["literalKind"];
  /** Literalart eines einfachen Literalblatts (`simpleLiteralLeafKinds`). */
  simpleLiteralKind(kind: string): LiteralFact["literalKind"];
  /** Deklaration oder Verweis? `fieldName` ist der Feldname im Elternknoten. */
  identifierRole(fieldName: string | undefined, parentKind: string): "declaration" | "reference";

  // -- Vorsieb --------------------------------------------------------------

  /**
   * Braucht ein innerer Knoten dieser Art ueberhaupt einen Knotenwrapper?
   *
   * Das ist das Vorsieb aus WP-95: fuer die grosse Mehrheit der inneren Knoten
   * (Ausdruecke, Bloecke, Anweisungslisten) faellt die Grenzueberquerung
   * vollstaendig weg. Wer hier `true` zurueckgibt, bezahlt je Knoten — beim
   * ast-grep-Backend deutlich mehr als bei tree-sitter.
   */
  needsNode(kind: string): boolean;

  // -- Scopes ---------------------------------------------------------------

  /** Welche Art von Scope oeffnet dieser Knoten — oder keinen (`null`)? */
  scopeKindOf(node: SyntaxNode): ScopeNode["kind"] | null;
  /**
   * Unterdrueckt einen sonst geoeffneten Scope (JS: ein Feld, dessen Wert
   * selbst eine Funktion ist — die Funktion bekommt den Scope, nicht das Feld).
   */
  suppressesScope(node: SyntaxNode): boolean;
  scopeName(node: SyntaxNode): string;
  /**
   * Ein Namensteil, der VOR den Scope-Namen gehoert, aber nicht aus einem
   * Elternscope stammt (WP-237).
   *
   * Gos Methoden haengen nicht in ihrem Typ, sondern tragen ihn als Feld:
   * `func (a *A) Run()` ist ein Geschwister von `type A struct{}`, kein Kind.
   * Ohne diesen Zusatz heissen `(*A).Run` und `(*B).Run` beide `Run`, und der
   * Symbolgraph haelt zwei verschiedene Methoden fuer dieselbe — eine
   * Impact-Analyse auf einer Go-Codebasis waere damit schlicht falsch.
   *
   * Rueckgabe `undefined` heisst: dieser Knoten braucht keinen Zusatz.
   */
  scopeQualifier?(node: SyntaxNode): string | undefined;
  scopeSignature(node: SyntaxNode, kind: ScopeNode["kind"], name: string): ScopeSignature;
  docRange(node: SyntaxNode, ctx: FileTextContext): SourceRange | undefined;
  visibility(node: SyntaxNode, name: string): string | undefined;
  exportedNames(node: SyntaxNode, name: string): string[];

  // -- Fakten ---------------------------------------------------------------

  detectDecisionAndNesting(node: SyntaxNode): DecisionDetectionResult;
  /**
   * Importe und Aufrufe dieses Knotens. Schreibt DIREKT in `sink`, statt ein
   * Ergebnisobjekt zu bauen: der Haken laeuft im Walk, und ein Objekt je
   * Aufrufknoten waere reiner Muell fuer den Sammler.
   */
  collectModuleFacts(
    node: SyntaxNode,
    kind: string,
    callerScopeId: string,
    ctx: FileTextContext,
    sink: ModuleFactSink,
  ): void;

  // -- Regionen (`chunks.ts`) -----------------------------------------------

  /**
   * Huellknoten, deren Bytes zum Symbol gehoeren (JS/TS: `export_statement`).
   * Leer, wenn die Sprache keine solche Huelle kennt.
   */
  readonly exportWrapperKinds: ReadonlySet<string>;
  /**
   * Zusaetzliche Kindregionen eines Klassen-artigen Scopes, die selbst keinen
   * Scope oeffnen, aber Inhalt tragen (JS/TS: `static { ... }`). Ohne sie
   * fielen ihre Bytes durch den Mitgliederlauf — spec.md §8.4 verbietet das.
   */
  memberRegions(node: SyntaxNode, parentScopeId: string, ctx: FileTextContext): MemberRegion[];
}

/** Eine Region ohne Symbol, wie sie `memberRegions` liefert. */
export interface MemberRegion {
  range: SourceRange;
  scopeId: string;
  headerText: string;
}

/**
 * Ausfuehrungseinheiten (spec.md §16.1) — bei jeder Sprache dieselben drei
 * Arten. Der Dateirahmen ist gesondert ausfuehrbar (`engine.ts`); er kommt hier
 * nie an, weil `scopeKindOf` niemals `"file"` liefert.
 */
export function isExecutableScopeKind(kind: ScopeNode["kind"]): boolean {
  return kind === "function" || kind === "method" || kind === "constructor";
}
