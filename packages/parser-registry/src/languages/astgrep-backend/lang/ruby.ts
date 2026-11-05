/**
 * Ruby (WP-86).
 *
 * ABBILDUNGEN: `module` -> `namespace`, `class` -> `class`, `def` und
 * `def self.x` -> `method`.
 *
 * KEINE SICHTBARKEIT. Rubys `private`/`public` sind AUFRUFE, die den Rest des
 * Klassenrumpfes umschalten — sie stehen nicht am Symbol. Ohne Datenflussblick
 * ist die Sichtbarkeit eines `def` aus dem Syntaxbaum nicht ablesbar, also
 * meldet dieser Adapter KEINE statt einer geratenen. Dasselbe gilt fuer
 * `exportedNames`.
 *
 * ENTSCHEIDUNGSPUNKTE (spec.md §16.2/§16.3):
 *   - Die NACHSTELLFORMEN zaehlen mit: `return x if y` (`if_modifier`) hat
 *     genau die zwei Pfade, die `if y then return x end` auch haette. Ebenso
 *     `unless_modifier`, `while_modifier`, `until_modifier`.
 *   - `elsif` ist eine EIGENE Knotenart und damit direkt ein `else_if`
 *     (Fortsetzung, kein voller Nesting-Zuwachs).
 *   - `when` und `in_clause` (Ruby 3 `case/in`) sind `case`-Zweige. Der
 *     `else`-Zweig eines `case` ist die Knotenart `else` und steht nicht in
 *     `caseKinds` — er zaehlt also nicht.
 *   - `rescue` zaehlt als `catch`; `ensure` nicht (laeuft immer).
 *   - `and`/`or` sind Rubys Wortformen und zaehlen wie `&&`/`||`.
 *   - `&.` zaehlt NICHT: es ist das `operator`-Feld eines gewoehnlichen
 *     `call`, und jede Kette wuerde sonst zur Verzweigung.
 *
 * IMPORTE: Ruby hat keine. `require`/`require_relative` sind gewoehnliche
 * Methodenaufrufe — hier NICHT als Import gemeldet, weil die Tabelle sie nicht
 * vom gleichnamigen Aufruf einer eigenen Methode unterscheiden koennte. Die
 * Datei meldet also KEINE Importe statt moeglicherweise falscher. Wer sie
 * braucht, sieht sie in `extractCalls` als Aufrufe von `require`.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const RUBY_SOURCE: AstGrepLanguageSource = {
  languageName: "ruby",
  moduleName: "@ast-grep/lang-ruby",
};

export const RUBY_TABLE: LanguageKindTable = {
  languageId: "ruby",
  extensions: [".rb", ".rake", ".gemspec"],
  supportLevel: "deep",
  commentKinds: ["comment"],
  stringContainerKinds: ["string", "string_array", "symbol_array", "regex", "heredoc_body"],
  identifierLeafKinds: [
    "identifier",
    "constant",
    "instance_variable",
    "class_variable",
    "global_variable",
    "simple_symbol",
    "hash_key_symbol",
    "self",
  ],
  numberLeafKinds: ["integer", "float"],
  booleanLeafKinds: ["true", "false"],
  nullLeafKinds: ["nil"],
  scopes: [
    { kinds: ["module"], scopeKind: "namespace" },
    { kinds: ["class", "singleton_class"], scopeKind: "class" },
    {
      kinds: ["method", "singleton_method"],
      scopeKind: "method",
      constructorNames: ["initialize"],
    },
  ],
  decisions: {
    ifKinds: ["if", "unless", "if_modifier", "unless_modifier"],
    elseIfKinds: ["elsif"],
    loopKinds: ["while", "until", "while_modifier", "until_modifier", "for"],
    catchKinds: ["rescue", "rescue_modifier"],
    ternaryKinds: ["ternary"],
    switchKinds: ["case", "case_match"],
    caseKinds: ["when", "in_clause"],
    binaryKinds: ["binary"],
    operatorField: "operator",
    logicalAndOperators: ["&&", "and"],
    logicalOrOperators: ["||", "or"],
    jumpKinds: ["return", "break", "next", "redo", "retry"],
    blockKinds: ["then", "body_statement"],
    consequenceField: "consequence",
    alternativeField: "alternative",
  },
  // Ruby hat keine Importanweisung — siehe Modulkopf.
  imports: { kinds: [] },
  calls: {
    kinds: ["call"],
    functionField: "method",
    receiverField: "receiver",
    argumentsField: "arguments",
  },
  declarationParentKinds: [
    "method",
    "singleton_method",
    "class",
    "module",
    "optional_parameter",
    "keyword_parameter",
    "block_parameter",
  ],
  bodyField: "body",
  fieldNames: ["name"],
};
