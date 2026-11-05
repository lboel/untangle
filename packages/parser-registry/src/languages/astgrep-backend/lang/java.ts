/**
 * Java (WP-86).
 *
 * ABBILDUNGEN auf die Symbolarten aus `shared/scope-model.ts`:
 * `record` -> `class` (ein benannter Verbund mit Feldern; `ChunkKind` kennt
 * kein "record"), `@interface` -> `interface`.
 *
 * ENTSCHEIDUNGSPUNKTE — die Auslegung, ausdruecklich (spec.md §16.2/§16.3):
 *   - `switch_label` traegt in DERSELBEN Knotenart sowohl `case X:` als auch
 *     `default:`. Nur die `case`-Form zaehlt (`caseExcludeChildKinds`). Ein
 *     `switch` mit drei `case` und einem `default` hat DREI Entscheidungen —
 *     der Auffangzweig eroeffnet keinen zusaetzlichen unabhaengigen Pfad.
 *   - `catch_clause` zaehlt als `catch`. `finally_clause` NICHT: es laeuft
 *     immer und verzweigt nichts.
 *   - `&&`/`||` zaehlen nur ERWEITERT (§16.3), nie klassisch.
 *   - `else if` ist in Java ein `if_statement` DIREKT unter einem
 *     `if_statement` (kein `else_clause`) — `elseIfParentKinds` sagt das.
 *
 * NACHGESEHEN, NICHT GERATEN: jede Knotenart hier stammt aus dem Baum von
 * `__golden__/java-basic.java`, und `golden.test.ts` erzeugt ihn wieder.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const JAVA_SOURCE: AstGrepLanguageSource = {
  languageName: "java",
  moduleName: "@ast-grep/lang-java",
};

const VISIBILITY_WORDS = ["public", "protected", "private"] as const;

export const JAVA_TABLE: LanguageKindTable = {
  languageId: "java",
  extensions: [".java"],
  supportLevel: "deep",
  commentKinds: ["line_comment", "block_comment"],
  stringContainerKinds: ["string_literal", "character_literal", "text_block"],
  identifierLeafKinds: ["identifier", "type_identifier", "this", "super"],
  numberLeafKinds: [
    "decimal_integer_literal",
    "hex_integer_literal",
    "octal_integer_literal",
    "binary_integer_literal",
    "decimal_floating_point_literal",
    "hex_floating_point_literal",
  ],
  booleanLeafKinds: ["true", "false"],
  nullLeafKinds: ["null_literal"],
  scopes: [
    { kinds: ["class_declaration", "record_declaration"], scopeKind: "class" },
    {
      kinds: ["interface_declaration", "annotation_type_declaration"],
      scopeKind: "interface",
    },
    { kinds: ["enum_declaration"], scopeKind: "enum" },
    { kinds: ["method_declaration"], scopeKind: "method" },
    { kinds: ["constructor_declaration"], scopeKind: "constructor" },
    // Der Name eines Feldes steht zwei Ebenen tief:
    // `field_declaration.declarator` -> `variable_declarator.name`.
    { kinds: ["field_declaration"], scopeKind: "property", nameField: "declarator.name" },
  ],
  decisions: {
    ifKinds: ["if_statement"],
    elseIfParentKinds: ["if_statement"],
    loopKinds: ["for_statement", "enhanced_for_statement", "while_statement", "do_statement"],
    catchKinds: ["catch_clause"],
    ternaryKinds: ["ternary_expression"],
    switchKinds: ["switch_statement", "switch_expression"],
    caseKinds: ["switch_label"],
    caseExcludeChildKinds: ["default"],
    binaryKinds: ["binary_expression"],
    operatorField: "operator",
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    jumpKinds: ["return_statement", "throw_statement", "break_statement", "continue_statement"],
    blockKinds: ["block"],
    consequenceField: "consequence",
    alternativeField: "alternative",
  },
  imports: {
    kinds: ["import_declaration"],
    // `import_declaration` vergibt keine Feldnamen; der Pfad ist der
    // `scoped_identifier` darin (bei `import a.*` ein `asterisk` daneben).
    pathKinds: ["scoped_identifier", "identifier"],
  },
  calls: {
    kinds: ["method_invocation"],
    functionField: "name",
    receiverField: "object",
    argumentsField: "arguments",
    constructionKinds: ["object_creation_expression"],
    constructedTypeField: "type",
  },
  declarationParentKinds: [
    "class_declaration",
    "record_declaration",
    "interface_declaration",
    "annotation_type_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
    "variable_declarator",
    "formal_parameter",
    "catch_formal_parameter",
    "type_parameter",
    "enum_constant",
  ],
  visibilityKinds: ["modifiers"],
  visibilityWords: [...VISIBILITY_WORDS],
  bodyField: "body",
  // Java sagt es mit einem Schluesselwort: `public` in den Modifikatoren.
  isExported: (_name, node) =>
    node.children.some((child) => child.type === "modifiers" && /\bpublic\b/.test(child.text)),
  fieldNames: ["name", "declarator"],
};
