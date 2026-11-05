/**
 * Kotlin (WP-86).
 *
 * DIE BESONDERHEIT, und der Grund fuer jede Eigenart dieser Tabelle: die
 * Kotlin-Grammatik VERGIBT KEINE FELDNAMEN. Kein `name`, kein `body`, kein
 * `condition` — nachgesehen an einer echten Datei mit Klasse, Objekt,
 * Companion, `when`, `try` und Lambda: `node.field(...)` liefert durchweg
 * `null`. Alles laeuft deshalb ueber `nameKinds`, also ueber die ART des
 * ersten passenden Kindes.
 *
 * ZWEI FOLGEN, die in der Ausgabe sichtbar sind und deshalb hier stehen:
 *
 *  1. `normalizedSignature` ist die ERSTE ZEILE des Knotens, nicht der Kopf
 *     bis zum Rumpf: ohne `body`-Feld gibt es keinen Punkt, an dem der Rumpf
 *     beginnt (`table-profile.ts#scopeSignature` faellt genau darauf zurueck).
 *  2. `IdentifierFact.role` ist IMMER `reference`. Die Rolle haengt am
 *     Feldnamen `name` (`identifierRole`), und den gibt es hier nicht. Eine
 *     Deklaration von einem Verweis zu unterscheiden waere also geraten —
 *     lieber eine ehrlich schwaechere Angabe als eine erfundene.
 *
 * ABBILDUNGEN: `class_declaration` traegt in Kotlin AUCH `interface`,
 * `enum class` und `data class`; unterschieden wird ueber das
 * Schluesselwortkind (`refine`). `object` und `companion object` ->
 * `namespace` (benannte Singletons, keine Typen).
 *
 * ENTSCHEIDUNGSPUNKTE (spec.md §16.2/§16.3):
 *   - `if_expression` ist Verzweigung UND Ausdruck (Kotlin hat keinen
 *     Ternaeroperator). Gezaehlt als `if` — dieselbe Zahl unabhaengiger Pfade.
 *   - `when_entry` ist ein `case`; der `else`-Arm zaehlt nicht
 *     (`caseExcludeChildKinds: ["else"]`).
 *   - `catch_block` zaehlt, `finally_block` nicht.
 *   - `conjunction_expression`/`disjunction_expression` tragen den Operator
 *     als anonymes Kind statt in einem Feld — `anonymousOperatorKinds`.
 *   - `elvis_expression` (`a ?: b`) zaehlt als `short_circuit`, nur erweitert.
 *   - `else if` liegt unter einem `control_structure_body`. Dessen unmittelbar
 *     vorangehendes anonymes `else`-Geschwister unterscheidet die Fortsetzung
 *     von einem ungekammerten `if` im Dann-Rumpf (WP-243). Damit bekommt eine
 *     Kotlin-Kette dieselbe kognitive Verschachtelung wie Java.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const KOTLIN_SOURCE: AstGrepLanguageSource = {
  languageName: "kotlin",
  moduleName: "@ast-grep/lang-kotlin",
};

export const KOTLIN_TABLE: LanguageKindTable = {
  languageId: "kotlin",
  extensions: [".kt", ".kts"],
  supportLevel: "deep",
  commentKinds: ["line_comment", "multiline_comment"],
  stringContainerKinds: ["string_literal", "character_literal"],
  identifierLeafKinds: ["simple_identifier", "type_identifier", "this", "super"],
  numberLeafKinds: [
    "integer_literal",
    "real_literal",
    "hex_literal",
    "bin_literal",
    "long_literal",
  ],
  booleanLeafKinds: ["boolean_literal"],
  nullLeafKinds: ["null"],
  scopes: [
    {
      kinds: ["class_declaration"],
      scopeKind: "class",
      nameKinds: ["type_identifier", "simple_identifier"],
      refine: [
        // Reihenfolge zaehlt: `enum class` traegt BEIDE Schluesselwoerter.
        { childKinds: ["enum"], scopeKind: "enum" },
        { childKinds: ["interface"], scopeKind: "interface" },
      ],
    },
    {
      kinds: ["object_declaration"],
      scopeKind: "namespace",
      nameKinds: ["type_identifier", "simple_identifier"],
    },
    {
      kinds: ["function_declaration"],
      scopeKind: "function",
      nameKinds: ["simple_identifier"],
    },
    {
      kinds: ["property_declaration"],
      scopeKind: "property",
      // `property_declaration > variable_declaration > simple_identifier`;
      // ohne den letzten Schritt stuende `name: String` (mit Typangabe) im
      // Namen.
      nameKindPath: ["variable_declaration"],
      nameKinds: ["simple_identifier"],
      // NUR auf Klassen-/Dateiebene: `var i = 0` in einem Funktionsrumpf ist
      // eine lokale Variable und kein Symbol.
      parentKinds: ["class_body", "enum_class_body", "source_file"],
    },
  ],
  decisions: {
    ifKinds: ["if_expression"],
    elseIfWrapperKinds: ["control_structure_body"],
    // kotlin-tree-sitter 0.0.7 zerlegt ausgerechnet
    // `else /* Blockkommentar */ if` in Geschwister und verliert das anonyme
    // `else` aus dem Baum. Der Detektor prueft dafuer den exakt begrenzten
    // Token-Spalt zwischen diesen Geschwistern; andere Sprachen bleiben aus.
    recoverDetachedElseIfAfterComments: true,
    loopKinds: ["for_statement", "while_statement", "do_while_statement"],
    catchKinds: ["catch_block"],
    switchKinds: ["when_expression"],
    caseKinds: ["when_entry"],
    caseExcludeChildKinds: ["else"],
    anonymousOperatorKinds: [
      "conjunction_expression",
      "disjunction_expression",
      "elvis_expression",
    ],
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    shortCircuitOperators: ["?:"],
    jumpKinds: ["jump_expression"],
    blockKinds: ["control_structure_body", "statements"],
  },
  // Kotlin: `import kotlin.math.max` / `import a.b.C as D`. Der Pfad ist das
  // `identifier`-Kind; der Alias steht in einem `import_alias` daneben.
  imports: {
    kinds: ["import_header"],
    pathKinds: ["identifier"],
  },
  calls: {
    kinds: ["call_expression"],
    memberKinds: ["navigation_expression"],
  },
  declarationParentKinds: [],
  visibilityKinds: ["modifiers"],
  visibilityWords: ["public", "internal", "protected", "private"],
  fieldNames: ["name"],
};
