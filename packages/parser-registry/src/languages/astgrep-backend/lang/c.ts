/**
 * C (WP-86).
 *
 * DER EINE BESONDERE PUNKT: C schreibt den Namen einer Funktion nicht in ein
 * `name`-Feld, sondern in eine Kette von Deklaratoren.
 * `ring_t *ring_new(size_t cap)` ergibt
 * `function_definition.declarator` -> `pointer_declarator.declarator`
 * -> `function_declarator.declarator` -> `identifier`. Dafuer gibt es
 * `nameDescend`: demselben Feld folgen, solange es weiterfuehrt. Ohne das
 * hiesse jede zeigerwertige Funktion `*ring_new(size_t cap)`.
 *
 * ABBILDUNGEN: `struct`/`union` -> `class`, `typedef` -> `type`.
 *
 * ENTSCHEIDUNGSPUNKTE (spec.md §16.2/§16.3):
 *   - `case_statement` traegt `case X:` UND `default:` — nur die `case`-Form
 *     zaehlt (`caseExcludeChildKinds`).
 *   - C hat kein `try`/`catch`; die Art `catch` entsteht in C-Dateien nie.
 *   - PRAEPROZESSORZWEIGE (`#ifdef`, `#if`) zaehlen NICHT. Sie sind
 *     Uebersetzungs-, nicht Laufzeitverzweigungen: die uebersetzte Datei
 *     enthaelt genau EINEN der Zweige. Beide zu zaehlen ergaebe eine Zahl, die
 *     kein ausgefuehrter Pfad je erreicht. Das ist die konservative Auslegung;
 *     sie UNTERSCHAETZT Dateien, die schwer per `#ifdef` verzweigen, und das
 *     steht hier, damit niemand es aus der Zahl erraten muss.
 *   - Es gibt keine Sichtbarkeit im Baum: `static` ist eine Speicherklasse,
 *     kein Zugriffsmodifikator. `exportedNames` bleibt deshalb leer, ausser
 *     bei einer Funktion OHNE `static` — die ist aus der Uebersetzungseinheit
 *     heraus sichtbar, und das ist die einzige Aussage, die der Baum hergibt.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const C_SOURCE: AstGrepLanguageSource = {
  languageName: "c",
  moduleName: "@ast-grep/lang-c",
};

export const C_TABLE: LanguageKindTable = {
  languageId: "c",
  extensions: [".c", ".h"],
  supportLevel: "deep",
  commentKinds: ["comment"],
  stringContainerKinds: ["string_literal", "char_literal", "system_lib_string"],
  identifierLeafKinds: [
    "identifier",
    "field_identifier",
    "type_identifier",
    "primitive_type",
    "statement_identifier",
  ],
  numberLeafKinds: ["number_literal"],
  booleanLeafKinds: ["true", "false"],
  nullLeafKinds: ["null"],
  scopes: [
    {
      kinds: ["function_definition"],
      scopeKind: "function",
      nameField: "declarator",
      nameDescend: true,
    },
    { kinds: ["struct_specifier", "union_specifier"], scopeKind: "class" },
    { kinds: ["enum_specifier"], scopeKind: "enum" },
    {
      kinds: ["type_definition"],
      scopeKind: "type",
      nameField: "declarator",
      nameDescend: true,
    },
    {
      kinds: ["field_declaration"],
      scopeKind: "property",
      nameField: "declarator",
      nameDescend: true,
    },
  ],
  decisions: {
    ifKinds: ["if_statement"],
    elseIfParentKinds: ["else_clause"],
    loopKinds: ["for_statement", "while_statement", "do_statement"],
    ternaryKinds: ["conditional_expression"],
    switchKinds: ["switch_statement"],
    caseKinds: ["case_statement"],
    caseExcludeChildKinds: ["default"],
    binaryKinds: ["binary_expression"],
    operatorField: "operator",
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    jumpKinds: ["return_statement", "break_statement", "continue_statement", "goto_statement"],
    blockKinds: ["compound_statement"],
    consequenceField: "consequence",
    alternativeField: "alternative",
  },
  imports: {
    kinds: ["preproc_include"],
    // Der Spezifizierer behaelt seine SPITZEN KLAMMERN: `<stdlib.h>` ist eine
    // Systemeinbindung, `"ring.h"` eine im Projekt. Die Klammern hier zu
    // entfernen wuerde die beiden Faelle ununterscheidbar machen — und die
    // Aufloesung im `file-graph` haengt genau daran.
    pathField: "path",
  },
  calls: {
    kinds: ["call_expression"],
    functionField: "function",
    argumentsField: "arguments",
    memberKinds: ["field_expression"],
  },
  declarationParentKinds: [
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
    "enumerator",
    "function_declarator",
  ],
  bodyField: "body",
  isExported: (_name, node) =>
    !node.children.some(
      (child) => child.type === "storage_class_specifier" && child.text === "static",
    ),
  fieldNames: ["name", "declarator"],
};
