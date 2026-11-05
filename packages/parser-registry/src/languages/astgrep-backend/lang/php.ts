/**
 * PHP (WP-86).
 *
 * ABBILDUNGEN: `trait` -> `interface` (ein benannter, wiederverwendbarer Satz
 * von Methoden ohne eigene Instanz — naeher an einer Schnittstelle als an
 * einer Klasse), `namespace` -> `namespace`.
 *
 * ENTSCHEIDUNGSPUNKTE (spec.md §16.2/§16.3):
 *   - `else_if_clause` (`elseif`) ist eine EIGENE Knotenart und damit direkt
 *     ein `else_if`.
 *   - `case_statement` zaehlt; `default_statement` ist eine eigene Knotenart
 *     und steht nicht in `caseKinds`.
 *   - `match_conditional_expression` (PHP 8 `match`) zaehlt als `case`;
 *     `match_default_expression` nicht.
 *   - `catch_clause` zaehlt, `finally_clause` nicht.
 *   - `??` zaehlt als `short_circuit`, nur erweitert. `and`/`or` (die
 *     niedrigpriorisierten Wortformen) zaehlen wie `&&`/`||`.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const PHP_SOURCE: AstGrepLanguageSource = {
  languageName: "php",
  moduleName: "@ast-grep/lang-php",
};

export const PHP_TABLE: LanguageKindTable = {
  languageId: "php",
  extensions: [".php", ".phtml"],
  supportLevel: "deep",
  commentKinds: ["comment"],
  stringContainerKinds: ["string", "encapsed_string", "heredoc", "nowdoc"],
  identifierLeafKinds: ["name", "variable_name", "qualified_name", "self", "parent"],
  numberLeafKinds: ["integer", "float"],
  booleanLeafKinds: ["boolean"],
  nullLeafKinds: ["null"],
  scopes: [
    { kinds: ["namespace_definition"], scopeKind: "namespace" },
    { kinds: ["class_declaration"], scopeKind: "class" },
    { kinds: ["interface_declaration", "trait_declaration"], scopeKind: "interface" },
    { kinds: ["enum_declaration"], scopeKind: "enum" },
    {
      kinds: ["method_declaration"],
      scopeKind: "method",
      constructorNames: ["__construct"],
    },
    { kinds: ["function_definition"], scopeKind: "function" },
    {
      kinds: ["property_declaration"],
      scopeKind: "property",
      // `property_declaration > property_element.name`
      nameKindPath: ["property_element"],
    },
  ],
  decisions: {
    ifKinds: ["if_statement"],
    elseIfKinds: ["else_if_clause"],
    loopKinds: ["for_statement", "foreach_statement", "while_statement", "do_statement"],
    catchKinds: ["catch_clause"],
    ternaryKinds: ["conditional_expression"],
    switchKinds: ["switch_statement", "match_expression"],
    caseKinds: ["case_statement", "match_conditional_expression"],
    binaryKinds: ["binary_expression"],
    operatorField: "operator",
    logicalAndOperators: ["&&", "and"],
    logicalOrOperators: ["||", "or"],
    shortCircuitOperators: ["??"],
    jumpKinds: ["return_statement", "break_statement", "continue_statement", "throw_expression"],
    blockKinds: ["compound_statement"],
    consequenceField: "body",
    alternativeField: "alternative",
  },
  imports: {
    kinds: ["namespace_use_declaration"],
    specKinds: ["namespace_use_clause"],
    pathKinds: ["qualified_name", "name"],
  },
  calls: {
    kinds: ["function_call_expression", "member_call_expression", "scoped_call_expression"],
    functionField: "name",
    receiverField: "object",
    argumentsField: "arguments",
    constructionKinds: ["object_creation_expression"],
  },
  declarationParentKinds: [
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "enum_declaration",
    "method_declaration",
    "function_definition",
    "simple_parameter",
    "property_element",
    "const_element",
  ],
  visibilityKinds: ["visibility_modifier"],
  bodyField: "body",
  isExported: (_name, node) =>
    !node.children.some(
      (child) =>
        child.type === "visibility_modifier" &&
        (child.text === "private" || child.text === "protected"),
    ),
  fieldNames: ["name"],
};
