/**
 * C# (WP-86).
 *
 * ABBILDUNGEN: `struct` und `record` -> `class`, `namespace` -> `namespace`.
 * Eine `property_declaration` (`public string Name { get; set; }`) ist eine
 * `property`, keine Methode — die Zugriffsmethoden gehoeren zu ihr.
 *
 * ENTSCHEIDUNGSPUNKTE (spec.md §16.2/§16.3):
 *   - `case_switch_label` zaehlt; `default_switch_label` ist eine EIGENE
 *     Knotenart und steht deshalb gar nicht erst in `caseKinds`.
 *   - `switch_expression_arm` (C# 8, `x switch { ... }`) zaehlt ebenfalls als
 *     `case`.
 *   - `catch_clause` zaehlt, `finally_clause` nicht.
 *   - `??` zaehlt als `short_circuit`, also NUR erweitert.
 *   - `?.` (`conditional_access_expression`) zaehlt NICHT. Es verzweigt zwar,
 *     ist aber in idiomatischem C# die normale Null-Absicherung; klassisch
 *     mitgezaehlt bekaeme jede defensive Kette dieselbe Zahl wie eine echte
 *     Fallunterscheidung. Konservative Auslegung, hier benannt.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const CSHARP_SOURCE: AstGrepLanguageSource = {
  languageName: "csharp",
  moduleName: "@ast-grep/lang-csharp",
};

export const CSHARP_TABLE: LanguageKindTable = {
  languageId: "csharp",
  extensions: [".cs"],
  supportLevel: "deep",
  commentKinds: ["comment"],
  stringContainerKinds: [
    "string_literal",
    "verbatim_string_literal",
    "raw_string_literal",
    "character_literal",
    "interpolated_string_expression",
  ],
  identifierLeafKinds: ["identifier", "predefined_type", "this", "base"],
  numberLeafKinds: ["integer_literal", "real_literal"],
  booleanLeafKinds: ["boolean_literal"],
  nullLeafKinds: ["null_literal"],
  scopes: [
    {
      kinds: ["namespace_declaration", "file_scoped_namespace_declaration"],
      scopeKind: "namespace",
    },
    {
      kinds: ["class_declaration", "struct_declaration", "record_declaration"],
      scopeKind: "class",
    },
    { kinds: ["interface_declaration"], scopeKind: "interface" },
    { kinds: ["enum_declaration"], scopeKind: "enum" },
    { kinds: ["method_declaration"], scopeKind: "method" },
    { kinds: ["constructor_declaration"], scopeKind: "constructor" },
    { kinds: ["property_declaration"], scopeKind: "property" },
    // `field_declaration` hat kein Namensfeld: der Name steht unter
    // `variable_declaration` -> `variable_declarator`.
    {
      kinds: ["field_declaration"],
      scopeKind: "property",
      // `field_declaration > variable_declaration > variable_declarator.name`
      nameKindPath: ["variable_declaration", "variable_declarator"],
    },
  ],
  decisions: {
    ifKinds: ["if_statement"],
    elseIfParentKinds: ["if_statement"],
    loopKinds: ["for_statement", "foreach_statement", "while_statement", "do_statement"],
    catchKinds: ["catch_clause"],
    ternaryKinds: ["conditional_expression"],
    switchKinds: ["switch_statement", "switch_expression"],
    // Die C#-Grammatik gibt der Marke KEINE eigene Knotenart: `case "a":` und
    // `default:` sind beide ein `switch_section`, unterschieden nur durch das
    // Schluesselwortkind. Nachgesehen am Baum von `__golden__/csharp-basic.cs`.
    caseKinds: ["switch_section", "switch_expression_arm"],
    caseExcludeChildKinds: ["default"],
    binaryKinds: ["binary_expression"],
    operatorField: "operator",
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    shortCircuitOperators: ["??"],
    jumpKinds: ["return_statement", "throw_statement", "break_statement", "continue_statement"],
    blockKinds: ["block"],
    consequenceField: "consequence",
    alternativeField: "alternative",
  },
  imports: {
    kinds: ["using_directive"],
    // NICHT `name_equals`: bei `using Sys = System.Text;` steht dort der
    // ALIAS, nicht der Pfad — der Pfad ist der `qualified_name` daneben.
    pathKinds: ["qualified_name", "identifier"],
    aliasField: "name",
  },
  calls: {
    kinds: ["invocation_expression"],
    functionField: "function",
    argumentsField: "arguments",
    memberKinds: ["member_access_expression", "qualified_name"],
    constructionKinds: ["object_creation_expression"],
    constructedTypeField: "type",
  },
  declarationParentKinds: [
    "class_declaration",
    "struct_declaration",
    "record_declaration",
    "interface_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
    "property_declaration",
    "variable_declarator",
    "parameter",
    "type_parameter",
    "catch_declaration",
    "enum_member_declaration",
  ],
  visibilityKinds: ["modifier"],
  visibilityWords: ["public", "protected", "private", "internal"],
  bodyField: "body",
  isExported: (_name, node) =>
    node.children.some((child) => child.type === "modifier" && child.text === "public"),
  fieldNames: ["name"],
};
