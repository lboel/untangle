/**
 * Swift (WP-86).
 *
 * WIE KOTLIN OHNE FELDNAMEN — mit denselben zwei Folgen (Signatur = erste
 * Zeile, `IdentifierFact.role` immer `reference`); die Begruendung steht im
 * Kopf von `kotlin.ts` und wird hier nicht wiederholt.
 *
 * ABBILDUNGEN: `class_declaration` traegt in Swift AUCH `struct`, `enum`,
 * `actor` und `extension` — unterschieden ueber das Schluesselwortkind.
 * `extension` -> `namespace`: eine Erweiterung ist kein neuer Typ, sondern ein
 * benannter Ort fuer weitere Mitglieder eines bestehenden.
 * `protocol_declaration` -> `interface`.
 *
 * ENTSCHEIDUNGSPUNKTE (spec.md §16.2/§16.3):
 *   - `guard_statement` zaehlt als `guard` — es IST die vorzeitige Rueckkehr,
 *     fuer die die Art gedacht ist (`guardKinds`).
 *   - `switch_entry` ist ein `case`; der `default`-Arm zaehlt nicht
 *     (`caseExcludeChildKinds: ["default_keyword"]`).
 *   - `catch_block` zaehlt als `catch`.
 *   - `??` zaehlt als `short_circuit`, nur erweitert.
 *   - `try?`/`try!` zaehlen NICHT: anders als Rusts `?` kehren sie nicht
 *     zurueck, sondern liefern `nil` beziehungsweise brechen ab. Der Zweig
 *     entsteht am `catch_block`, und der wird gezaehlt.
 *
 * EINE MESSGRENZE, AUSDRUECKLICH: `@ast-grep/lang-swift` steht bei Version
 * 0.0.8. Geprueft ist die Grammatik an der Golden-Datei dieses Pakets
 * (0 Fehlerknoten); an grossen echten Swift-Projekten ist sie hier NICHT
 * erprobt.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const SWIFT_SOURCE: AstGrepLanguageSource = {
  languageName: "swift",
  moduleName: "@ast-grep/lang-swift",
};

export const SWIFT_TABLE: LanguageKindTable = {
  languageId: "swift",
  extensions: [".swift"],
  supportLevel: "deep",
  commentKinds: ["comment", "multiline_comment"],
  stringContainerKinds: ["line_string_literal", "multi_line_string_literal", "raw_string_literal"],
  identifierLeafKinds: ["simple_identifier", "type_identifier", "self_expression"],
  numberLeafKinds: ["integer_literal", "hex_literal", "oct_literal", "bin_literal", "real_literal"],
  booleanLeafKinds: ["boolean_literal"],
  nullLeafKinds: ["nil"],
  scopes: [
    {
      kinds: ["class_declaration"],
      scopeKind: "class",
      nameKinds: ["type_identifier", "user_type"],
      refine: [
        { childKinds: ["enum"], scopeKind: "enum" },
        { childKinds: ["extension"], scopeKind: "namespace" },
      ],
    },
    {
      kinds: ["protocol_declaration"],
      scopeKind: "interface",
      nameKinds: ["type_identifier"],
    },
    {
      kinds: ["function_declaration", "protocol_function_declaration"],
      scopeKind: "function",
      nameKinds: ["simple_identifier"],
    },
    { kinds: ["init_declaration"], scopeKind: "constructor", nameKinds: ["init"] },
    {
      kinds: ["property_declaration"],
      scopeKind: "property",
      nameKindPath: ["pattern"],
      nameKinds: ["simple_identifier"],
      // Wie in Kotlin: `var i = 0` in einem Funktionsrumpf ist kein Symbol.
      parentKinds: ["class_body", "protocol_body", "enum_class_body", "source_file"],
    },
  ],
  decisions: {
    ifKinds: ["if_statement"],
    elseIfParentKinds: ["if_statement"],
    guardKinds: ["guard_statement"],
    loopKinds: ["for_statement", "while_statement", "repeat_while_statement"],
    catchKinds: ["catch_block"],
    ternaryKinds: ["ternary_expression"],
    switchKinds: ["switch_statement"],
    caseKinds: ["switch_entry"],
    caseExcludeChildKinds: ["default_keyword"],
    anonymousOperatorKinds: [
      "conjunction_expression",
      "disjunction_expression",
      "nil_coalescing_expression",
    ],
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    shortCircuitOperators: ["??"],
    jumpKinds: ["control_transfer_statement"],
    blockKinds: ["statements"],
  },
  imports: {
    kinds: ["import_declaration"],
    pathKinds: ["identifier"],
  },
  calls: {
    kinds: ["call_expression"],
    memberKinds: ["navigation_expression"],
    // Swift benutzt `call_expression` AUCH fuer Indexzugriffe: `items["a"]`
    // waere sonst ein Aufruf von `items`. Nur ein Anhang, der mit `(` beginnt,
    // ist ein Aufruf.
    acceptCall: (node) => {
      const last = node.children[node.children.length - 1];
      return last !== undefined && last.text.trimStart().startsWith("(");
    },
  },
  declarationParentKinds: [],
  visibilityKinds: ["modifiers"],
  visibilityWords: ["public", "internal", "fileprivate", "private", "open"],
  fieldNames: ["name"],
};
