/**
 * Die Sprachtabelle fuer Python — die zwoelfte Sprache des ast-grep-Backends.
 *
 * WAS HIER GESCHAH (WP-239): bis Welle 7 stand an dieser Stelle ein
 * HANDGESCHRIEBENER Tokenizer, Parser und AST-Motor ueber 5.604 Zeilen. Sie
 * entstanden nicht aus einer fachlichen Notwendigkeit, sondern weil eine zu
 * enge Auftragsgrenze einem Agenten verbot, `package.json` anzufassen
 * (dokumentiert in `docs/PARITY.md`). Die Grammatik, die es dafuer braucht,
 * gibt es fertig und MIT-lizenziert: `@ast-grep/lang-python`.
 *
 * WAS DIE ABLOESUNG NEBENBEI BEHOBEN HAT — nicht durch eine Korrektur,
 * sondern weil die Klasse von Fehlern verschwindet:
 *
 *   - WP-238: `with a() as x, b() as y:` liess im handgeschriebenen Parser die
 *     GANZE Datei mit `parseQuality: "failed"` durchfallen. Die Grammatik legt
 *     dafuer `with_clause > with_item*` an; es gibt nichts zu erkennen.
 *   - WP-115: verschachtelte Ausdruecke in f-String-Formatangaben
 *     (`f"{x:{w}.{p}}"`) gingen im Teil-Parse verloren. Hier sind sie
 *     gewoehnliche `interpolation`/`format_expression`-Knoten im Baum —
 *     deshalb steht `string` NICHT unter `stringContainerKinds` (siehe dort).
 *   - WP-226: ein nachgestellter Kommentar vor dem Zeilenende verschluckte im
 *     Tokenizer das NEWLINE. Ein `comment` ist hier ein Geschwister wie jedes
 *     andere.
 *
 * WAS DIE TABELLE NICHT LEISTET, steht in `profile.ts` daneben: Docstrings,
 * Sichtbarkeit aus der Namenskonvention, `__all__`, die Unterscheidung
 * Funktion/Methode/Konstruktor und die Importformen sind Python-Regeln, die
 * KEINE Tabelle ausdrueckt. Sie stehen als Verfeinerung ueber diesem Profil,
 * nicht als Sonderfaelle im gemeinsamen Motor.
 *
 * DIE KNOTENARTEN SIND NACHGESEHEN, NICHT GERATEN: jede Zeichenkette hier
 * stammt aus einem echten Baum, den `adapters.test.ts` mit demselben
 * Quelltext wieder erzeugt.
 */
import type { AstGrepLanguageSource } from "../astgrep-backend/index.js";
import type { LanguageKindTable } from "../shared/table-profile.js";
import { DEFAULT_PUNCTUATION } from "../shared/table-profile.js";

/** Woher die Grammatik kommt. MIT-lizenziert, siehe `THIRD_PARTY_LICENSES.md`. */
export const PYTHON_SOURCE: AstGrepLanguageSource = {
  languageName: "python",
  moduleName: "@ast-grep/lang-python",
};

/**
 * Zeichenkettenblaetter. Sie stehen NICHT unter `numberLeafKinds` und
 * Verwandten, weil `simpleLiteralKind` daraus "number"/"boolean"/"null"
 * ableitet; `profile.ts` haengt sie an und beantwortet sie mit "string".
 */
export const PYTHON_STRING_LEAF_KINDS: readonly string[] = ["string_content", "escape_sequence"];

export const PYTHON_TABLE: LanguageKindTable = {
  languageId: "python",
  extensions: [".py", ".pyi"],
  supportLevel: "deep",
  commentKinds: ["comment"],

  /**
   * ABSICHTLICH LEER. Ein `string` waere in jeder anderen Sprache ein
   * Container, dessen Teilbaum EIN Operand ist. In Python ist er das nicht:
   * ein f-String traegt `interpolation`-Knoten mit vollwertigen Ausdruecken,
   * und ein Aufruf darin ist ein Aufruf. Wer `string` hier eintraegt, macht
   * WP-115 zum zweiten Mal — nur diesmal ohne Diagnose, weil der Walk gar
   * nicht erst hineinsieht.
   */
  stringContainerKinds: [],

  identifierLeafKinds: ["identifier"],
  numberLeafKinds: ["integer", "float"],
  booleanLeafKinds: ["true", "false"],
  nullLeafKinds: ["none"],

  // `string_start`/`string_end` tragen das Praefix und die Anfuehrungszeichen;
  // sie sind Struktur, kein Operator. Ohne sie stuende `f"` als "Operator" in
  // jeder Halstead-Rechnung.
  punctuationKinds: [...DEFAULT_PUNCTUATION, "string_start", "string_end"],

  scopes: [
    { kinds: ["function_definition"], scopeKind: "function" },
    { kinds: ["class_definition"], scopeKind: "class" },
    // Ein `lambda` ist eine Ausfuehrungseinheit wie eine `def`: spec.md §16.1
    // zaehlt Lambdas mit, und §16.4 verlangt fuer sie ein eigenes
    // Nesting-Ereignis im umgebenden Scope. Beides haengt daran, dass es hier
    // steht.
    { kinds: ["lambda"], scopeKind: "function" },
  ],

  decisions: {
    // `if_clause` ist BEIDES: der Filter einer Komprehension
    // (`[x for x in a if p(x)]`) und der Waechter eines `case`. Beide sind
    // eine echte Verzweigung, beide zaehlen — und beide heissen so.
    ifKinds: ["if_statement", "if_clause"],
    elseIfKinds: ["elif_clause"],
    // `for_in_clause` ist die `for`-Klausel einer Komprehension. Sie ist eine
    // Schleife, auch wenn sie keine Anweisung ist.
    loopKinds: ["for_statement", "while_statement", "for_in_clause"],
    catchKinds: ["except_clause", "except_group_clause"],
    ternaryKinds: ["conditional_expression"],
    switchKinds: ["match_statement"],
    caseKinds: ["case_clause"],
    // `case _:` zaehlt in Python MIT: anders als ein C-`default` ist `_` ein
    // gewoehnliches Muster in der Reihenfolge, und ein `match` bricht ohne
    // Treffer einfach ab. Deshalb steht hier KEIN `caseExcludeChildKinds`.
    patternAlternativeKinds: ["union_pattern"],
    binaryKinds: ["boolean_operator"],
    operatorField: "operator",
    logicalAndOperators: ["and"],
    logicalOrOperators: ["or"],
    jumpKinds: ["return_statement", "raise_statement", "break_statement", "continue_statement"],
    blockKinds: ["block"],
    consequenceField: "consequence",
    // `elif_clause` UND `else_clause` stehen beide im Feld `alternative`.
    // Genau deshalb ist ein `if` mit `elif` kein Waechter (`guard`), sondern
    // ein `if` — was `adapters.test.ts` festhaelt.
    alternativeField: "alternative",
  },

  // Die Importe wertet `profile.ts` aus: Python fuehrt in EINER Anweisung
  // mehrere Ziele mit je eigenem Alias, und das druecken `ImportRules` nicht
  // aus. Die Arten stehen hier, damit das Vorsieb (`needsNode`) sie kennt.
  imports: {
    kinds: ["import_statement", "import_from_statement", "future_import_statement"],
  },

  calls: {
    kinds: ["call"],
    functionField: "function",
    argumentsField: "arguments",
    memberKinds: ["attribute"],
  },

  declarationParentKinds: ["function_definition", "class_definition"],

  bodyField: "body",
};
