/**
 * Die Sprachtabellen des ast-grep-Backends.
 *
 * Jede Sprache ist EINE Tabelle (`shared/table-profile.ts`) plus die Angabe,
 * aus welchem npm-Paket ihre Grammatik kommt. Kein Motor, keine
 * Fallunterscheidung, keine zweite Traversierung. Wer eine Sprache
 * hinzufuegt, schreibt eine Tabelle wie die beiden hier und eine
 * Registrierungszeile in `languages/index.ts` — sonst nichts.
 *
 * DIE KNOTENARTEN SIND NACHGESEHEN, NICHT GERATEN: jede Zeichenkette hier
 * stammt aus einem echten Baum, den `adapter.test.ts` mit demselben Quelltext
 * wieder erzeugt. Wer eine Art aendert, ohne den Test zu bewegen, sieht es
 * sofort.
 *
 * SPRACHPAKETE WERDEN EINZELN AUFGENOMMEN. Die 22 Sprachpakete von ast-grep
 * belegen zusammen 450 MB; eine Sammelabhaengigkeit waere respektlos gegen
 * jeden, der nur Go analysieren will.
 */
import type { LanguageKindTable } from "../shared/table-profile.js";

import type { AstGrepLanguageSource } from "./adapter.js";

/** Sprachpakete, wie ast-grep sie kennt (Name) und npm sie liefert (Paket). */
export const GO_SOURCE: AstGrepLanguageSource = {
  languageName: "go",
  moduleName: "@ast-grep/lang-go",
};

export const RUST_SOURCE: AstGrepLanguageSource = {
  languageName: "rust",
  moduleName: "@ast-grep/lang-rust",
};

/**
 * Go.
 *
 * Zwei Eigenheiten stehen in der Tabelle statt in einer Sonderbehandlung:
 *  - `else if` ist in Go ein `if_statement` DIREKT unter einem `if_statement`
 *    (kein `else_clause` wie in JS/Rust) — `elseIfParentKinds` sagt das.
 *  - Ein Rumpf ist `block > statement_list`; die Guard-Clause-Erkennung muss
 *    durch BEIDE Huellen hindurch (`blockKinds`).
 *  - Sichtbarkeit steht nicht im Baum, sondern im Namen: Go exportiert, was
 *    mit einem Grossbuchstaben beginnt.
 */
export const GO_TABLE: LanguageKindTable = {
  languageId: "go",
  extensions: [".go"],
  supportLevel: "deep",
  commentKinds: ["comment"],
  stringContainerKinds: ["interpreted_string_literal", "raw_string_literal", "rune_literal"],
  identifierLeafKinds: [
    "identifier",
    "field_identifier",
    "package_identifier",
    "type_identifier",
    "label_name",
  ],
  numberLeafKinds: ["int_literal", "float_literal", "imaginary_literal"],
  booleanLeafKinds: ["true", "false"],
  nullLeafKinds: ["nil"],
  scopes: [
    { kinds: ["function_declaration"], scopeKind: "function" },
    {
      kinds: ["method_declaration"],
      scopeKind: "method",
      qualifierField: "receiver",
      qualifierNameKinds: ["type_identifier"],
    },
    { kinds: ["method_elem"], scopeKind: "method" },
    {
      kinds: ["type_spec"],
      scopeKind: "type",
      refine: [
        { childKinds: ["struct_type"], scopeKind: "class" },
        { childKinds: ["interface_type"], scopeKind: "interface" },
      ],
    },
  ],
  decisions: {
    ifKinds: ["if_statement"],
    elseIfParentKinds: ["if_statement"],
    loopKinds: ["for_statement"],
    switchKinds: ["expression_switch_statement", "type_switch_statement", "select_statement"],
    // WP-86: `default_case` steht hier NICHT mehr. Gos `select` ist zwar kein
    // C-`switch` — jeder `communication_case` ist ein echter, zur Laufzeit
    // gewaehlter Zweig und zaehlt deshalb —, aber der `default`-Zweig ist in
    // beiden Formen der Fall, der uebrig bleibt. Er eroeffnet keinen
    // zusaetzlichen unabhaengigen Pfad: ein `switch` mit drei `case` und einem
    // `default` hat DREI Entscheidungen, nicht vier. Vorher zaehlte er mit und
    // jede Go-Datei mit `default` bekam eine zyklomatische Zahl zu viel.
    caseKinds: ["expression_case", "type_case", "communication_case"],
    binaryKinds: ["binary_expression"],
    operatorField: "operator",
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    jumpKinds: ["return_statement", "break_statement", "continue_statement", "goto_statement"],
    blockKinds: ["block", "statement_list"],
    consequenceField: "consequence",
    alternativeField: "alternative",
  },
  imports: {
    kinds: ["import_declaration"],
    specKinds: ["import_spec"],
    pathField: "path",
    aliasField: "name",
  },
  calls: {
    kinds: ["call_expression"],
    functionField: "function",
    argumentsField: "arguments",
    memberKinds: ["selector_expression"],
  },
  declarationParentKinds: [
    "function_declaration",
    "method_declaration",
    "method_elem",
    "type_spec",
    "const_spec",
    "var_spec",
    "import_spec",
    "field_declaration",
  ],
  bodyField: "body",
  isExported: (name) => /^\p{Lu}/u.test(name),
  fieldNames: ["name"],
};

/**
 * Rust.
 *
 * Auch hier stehen die Eigenheiten in der Tabelle:
 *  - Sichtbarkeit ist ein Knoten (`visibility_modifier`), kein Namensmuster.
 *  - `use a::b as c` und `use a::{b, c}` werden ausgepackt, sonst stuende der
 *    ganze Ausdruck als "Pfad" im Ergebnis.
 *  - `impl Counter { ... }` oeffnet einen Scope der Art `class`, damit
 *    Methoden `Counter.bump` heissen statt bloss `bump`. Dass eine Datei
 *    dadurch `Counter` zweimal fuehren kann (einmal `struct_item`, einmal
 *    `impl_item`), ist gewollt: es sind zwei Quelltextstellen, und die
 *    Scope-Kennungen unterscheiden sich ueber die Ordnungszahl.
 *
 * BEKANNTE GRENZE: eine `fn` in einem `impl`-Block wird als `function`
 * gefuehrt, nicht als `method` — die Knotenart ist in beiden Faellen
 * `function_item`, und die Tabelle entscheidet nach Knotenart. Das ist eine
 * Ungenauigkeit in der Symbolart, keine im Bereich oder in der Metrik.
 */
export const RUST_TABLE: LanguageKindTable = {
  languageId: "rust",
  extensions: [".rs"],
  supportLevel: "deep",
  commentKinds: ["line_comment", "block_comment"],
  stringContainerKinds: ["string_literal", "raw_string_literal", "char_literal"],
  identifierLeafKinds: [
    "identifier",
    "type_identifier",
    "field_identifier",
    "primitive_type",
    "self",
    "shorthand_field_identifier",
  ],
  numberLeafKinds: ["integer_literal", "float_literal"],
  booleanLeafKinds: ["true", "false"],
  scopes: [
    { kinds: ["function_item"], scopeKind: "function" },
    {
      kinds: ["function_signature_item"],
      scopeKind: "method",
      ancestorKinds: ["trait_item"],
    },
    { kinds: ["struct_item", "union_item"], scopeKind: "class" },
    { kinds: ["impl_item"], scopeKind: "class", nameField: "type" },
    { kinds: ["trait_item"], scopeKind: "interface" },
    { kinds: ["enum_item"], scopeKind: "enum" },
    { kinds: ["type_item"], scopeKind: "type" },
    { kinds: ["mod_item"], scopeKind: "namespace" },
  ],
  decisions: {
    ifKinds: ["if_expression"],
    elseIfParentKinds: ["else_clause"],
    loopKinds: ["for_expression", "while_expression", "loop_expression"],
    switchKinds: ["match_expression"],
    // WP-86: gezaehlt wird das MUSTER, nicht der Arm — nur so ist der
    // Auffangarm `_ => ...` zu erkennen (sein `match_pattern` besteht genau
    // aus dem `_`). Er ist Rusts `default` und zaehlt nicht;
    // `Some(_) => ...` zaehlt dagegen, weil es wirklich nur EINEN Fall abdeckt.
    caseKinds: ["match_pattern"],
    caseExcludeFirstChildText: "_",
    // `Some(1) | Some(2)` ist eine Musteralternative — `DecisionKind`
    // `pattern_alternative` existiert genau dafuer.
    patternAlternativeKinds: ["or_pattern"],
    // WP-86: der `?`-OPERATOR IST KONTROLLFLUSS — er kehrt bei `Err` sofort
    // zurueck. Gezaehlt wird er KONSERVATIV als `short_circuit`, also nur
    // ERWEITERT (spec.md §16.3), nicht klassisch (§16.2): `?` ist in
    // idiomatischem Rust so haeufig wie ein Semikolon, und klassisch
    // mitgezaehlt bekaeme jede Funktion, die drei Aufrufe weiterreicht,
    // dieselbe Zahl wie eine mit drei `if`. Verschwiegen wird er nicht — die
    // erweiterte Zahl zeigt ihn.
    shortCircuitKinds: ["try_expression"],
    binaryKinds: ["binary_expression"],
    operatorField: "operator",
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    jumpKinds: ["return_expression", "break_expression", "continue_expression"],
    blockKinds: ["block"],
    consequenceField: "consequence",
    alternativeField: "alternative",
  },
  imports: {
    kinds: ["use_declaration"],
    pathField: "argument",
    unwrap: [
      { kinds: ["use_as_clause"], pathField: "path", aliasField: "alias" },
      { kinds: ["scoped_use_list"], pathField: "path", namesField: "list" },
    ],
  },
  calls: {
    kinds: ["call_expression", "macro_invocation"],
    functionField: "function",
    argumentsField: "arguments",
    memberKinds: ["field_expression", "scoped_identifier"],
  },
  declarationParentKinds: [
    "function_item",
    "function_signature_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "mod_item",
    "type_item",
    "const_item",
    "static_item",
    "field_declaration",
    "parameter",
  ],
  visibilityKinds: ["visibility_modifier"],
  bodyField: "body",
  isExported: (_name, node) => node.children.some((child) => child.type === "visibility_modifier"),
  fieldNames: ["name", "type"],
};
