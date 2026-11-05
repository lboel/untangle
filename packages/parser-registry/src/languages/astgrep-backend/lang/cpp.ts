/**
 * C++ (WP-86) — DER BELEG FUER DIE RATSCHE.
 *
 * Die C++-Grammatik ist eine ERWEITERUNG der C-Grammatik: jede Knotenart aus
 * `c.ts` kommt in C++ genauso vor. Deshalb steht hier keine zweite Tabelle,
 * sondern die DIFFERENZ — Klassen, Namensraeume, `try`/`catch`, Lambdas,
 * bereichsbasierte `for`-Schleifen. Elf Sprachen ergaenzen heisst nicht elfmal
 * dieselbe Arbeit; wo zwei Sprachen verwandt sind, muss die zweite billiger
 * sein als die erste, sonst haben wir nichts gewonnen.
 *
 * ABBILDUNGEN ZUSAETZLICH ZU C: `class` -> `class`, `namespace` ->
 * `namespace`. `template_declaration` ist KEIN eigenes Symbol: es umhuellt
 * die Funktion oder Klasse, die es parametrisiert, und die ist der Scope.
 *
 * ENTSCHEIDUNGSPUNKTE ZUSAETZLICH ZU C: `catch_clause` zaehlt als `catch`,
 * `for_range_loop` als Schleife. `co_await`/`co_yield` zaehlen NICHT — sie
 * unterbrechen den Ablauf, verzweigen ihn aber nicht.
 *
 * SICHTBARKEIT: C++ fuehrt sie als ABSCHNITTSMARKE (`access_specifier`
 * `public:`), nicht am Mitglied. Sie ist damit ohne Positionsvergleich nicht
 * am Symbol ablesbar — der Adapter meldet deshalb keine, statt eine zu raten.
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

import { C_TABLE } from "./c.js";

export const CPP_SOURCE: AstGrepLanguageSource = {
  languageName: "cpp",
  moduleName: "@ast-grep/lang-cpp",
};

const { isExported: _cIsExported, ...C_TABLE_WITHOUT_EXPORT } = C_TABLE;

export const CPP_TABLE: LanguageKindTable = {
  ...C_TABLE_WITHOUT_EXPORT,
  languageId: "cpp",
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  identifierLeafKinds: [
    ...C_TABLE.identifierLeafKinds,
    "namespace_identifier",
    "qualified_identifier",
    "this",
    "destructor_name",
    "operator_name",
  ],
  nullLeafKinds: [...(C_TABLE.nullLeafKinds ?? []), "nullptr"],
  scopes: [
    ...C_TABLE.scopes,
    { kinds: ["class_specifier"], scopeKind: "class" },
    { kinds: ["namespace_definition"], scopeKind: "namespace" },
  ],
  decisions: {
    ...C_TABLE.decisions,
    catchKinds: ["catch_clause"],
    loopKinds: [...C_TABLE.decisions.loopKinds, "for_range_loop"],
    jumpKinds: [...(C_TABLE.decisions.jumpKinds ?? []), "throw_statement"],
  },
  declarationParentKinds: [
    ...C_TABLE.declarationParentKinds,
    "class_specifier",
    "namespace_definition",
    "type_parameter_declaration",
  ],
};
