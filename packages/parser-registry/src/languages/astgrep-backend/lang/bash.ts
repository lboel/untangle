/**
 * Bash (WP-86).
 *
 * WAS EINE SHELL AN SYMBOLEN HAT: Funktionen. Mehr nicht — keine Klassen,
 * keine Typen, keine Namensraeume. Das ist kein Mangel des Adapters, sondern
 * der Sprache, und deshalb steht hier eine kurze Tabelle statt einer
 * erfundenen Struktur.
 *
 * VARIABLENZUWEISUNGEN AUF OBERSTER EBENE SIND KEINE SYMBOLE. In einer Shell
 * ist jede Zuweisung eine Anweisung; die Grenze zwischen "Konstante" und
 * "Zwischenwert" steht nicht im Syntaxbaum. `MAX_RETRIES=3` und
 * `attempt=$((attempt + 1))` als gleichrangige Symbole zu fuehren waere eine
 * falsche Aussage ueber die Datei.
 *
 * ENTSCHEIDUNGSPUNKTE (spec.md §16.2/§16.3):
 *   - `while_statement` deckt AUCH `until` ab — dieselbe Knotenart mit anderem
 *     Schluesselwort.
 *   - `elif_clause` ist eine eigene Knotenart und damit direkt ein `else_if`.
 *   - `case_item` zaehlt als `case`. Der Auffangzweig `*)` zaehlt NICHT: sein
 *     Muster ist genau `*` (`caseExcludeFirstChildText`).
 *   - `&&`/`||` zwischen Kommandos stehen in einem `list`-Knoten und tragen
 *     den Operator als anonymes Kind (`anonymousOperatorKinds`). Sie zaehlen
 *     nur ERWEITERT. In der Shell ist `cmd || exit 1` idiomatisch ein
 *     Fehlerpfad und kein reiner Kurzschluss; die konservative Auslegung haelt
 *     die Zahl mit den anderen zehn Sprachen vergleichbar.
 *   - PIPES (`|`) zaehlen NICHT: sie verketten, sie verzweigen nicht.
 *
 * IMPORTE: `source datei` und `. datei` sind gewoehnliche Kommandos, keine
 * eigene Knotenart. Die Tabelle koennte sie nicht von einer selbstgeschriebenen
 * Funktion gleichen Namens unterscheiden — dieser Adapter meldet deshalb KEINE
 * Importe. Wer sie braucht, sieht sie in `extractCalls` als Aufruf von
 * `source`.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

export const BASH_SOURCE: AstGrepLanguageSource = {
  languageName: "bash",
  moduleName: "@ast-grep/lang-bash",
};

export const BASH_TABLE: LanguageKindTable = {
  languageId: "shell",
  extensions: [".sh", ".bash", ".zsh", ".ksh"],
  supportLevel: "deep",
  commentKinds: ["comment"],
  stringContainerKinds: ["string", "raw_string", "ansi_c_string", "heredoc_body"],
  identifierLeafKinds: [
    "variable_name",
    "special_variable_name",
    "word",
    "extglob_pattern",
    "simple_expansion",
  ],
  numberLeafKinds: ["number"],
  scopes: [{ kinds: ["function_definition"], scopeKind: "function", nameKinds: ["word"] }],
  decisions: {
    ifKinds: ["if_statement"],
    elseIfKinds: ["elif_clause"],
    loopKinds: ["while_statement", "for_statement", "c_style_for_statement"],
    switchKinds: ["case_statement"],
    caseKinds: ["case_item"],
    caseExcludeFirstChildText: "*",
    anonymousOperatorKinds: ["list"],
    logicalAndOperators: ["&&"],
    logicalOrOperators: ["||"],
    jumpKinds: [],
    blockKinds: ["compound_statement", "do_group"],
  },
  // Siehe Modulkopf: die Shell hat keine Importanweisung.
  imports: { kinds: [] },
  calls: {
    kinds: ["command"],
    functionField: "name",
  },
  declarationParentKinds: [],
  fieldNames: ["name"],
};
