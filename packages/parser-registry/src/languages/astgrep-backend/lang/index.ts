/**
 * Die Sprachen aus WP-86: je EINE Tabelle, kein Motor (vision.md §1b).
 *
 * WIE VIEL EINE SPRACHE GEKOSTET HAT, steht in `README.md` neben diesem
 * Verzeichnis — Zeile fuer Zeile nachgezaehlt. Das ist die Gegenprobe zur
 * Ratsche: eine Sprache, die 800 Zeilen kostet, waere kein Gewinn gewesen.
 *
 * REIHENFOLGE = VERBREITUNG. Sie ist zugleich die Reihenfolge, in der die
 * Grammatiken registriert werden (`napi.ts`: EIN Aufruf fuer alle).
 */
import type { LanguageKindTable } from "../../shared/table-profile.js";
import type { AstGrepLanguageSource } from "../adapter.js";

import { BASH_SOURCE, BASH_TABLE } from "./bash.js";
import { C_SOURCE, C_TABLE } from "./c.js";
import { CPP_SOURCE, CPP_TABLE } from "./cpp.js";
import { CSHARP_SOURCE, CSHARP_TABLE } from "./csharp.js";
import { JAVA_SOURCE, JAVA_TABLE } from "./java.js";
import { KOTLIN_SOURCE, KOTLIN_TABLE } from "./kotlin.js";
import { PHP_SOURCE, PHP_TABLE } from "./php.js";
import { RUBY_SOURCE, RUBY_TABLE } from "./ruby.js";
import { SWIFT_SOURCE, SWIFT_TABLE } from "./swift.js";

/** Eine Sprache: ihre Tabelle und das Paket, aus dem ihre Grammatik kommt. */
export interface AstGrepLanguage {
  table: LanguageKindTable;
  source: AstGrepLanguageSource;
}

export const AST_GREP_LANGUAGES: readonly AstGrepLanguage[] = [
  { table: JAVA_TABLE, source: JAVA_SOURCE },
  { table: CSHARP_TABLE, source: CSHARP_SOURCE },
  { table: RUBY_TABLE, source: RUBY_SOURCE },
  { table: PHP_TABLE, source: PHP_SOURCE },
  { table: KOTLIN_TABLE, source: KOTLIN_SOURCE },
  { table: C_TABLE, source: C_SOURCE },
  { table: CPP_TABLE, source: CPP_SOURCE },
  { table: SWIFT_TABLE, source: SWIFT_SOURCE },
  { table: BASH_TABLE, source: BASH_SOURCE },
];

export {
  BASH_SOURCE,
  BASH_TABLE,
  CPP_SOURCE,
  CPP_TABLE,
  CSHARP_SOURCE,
  CSHARP_TABLE,
  C_SOURCE,
  C_TABLE,
  JAVA_SOURCE,
  JAVA_TABLE,
  KOTLIN_SOURCE,
  KOTLIN_TABLE,
  PHP_SOURCE,
  PHP_TABLE,
  RUBY_SOURCE,
  RUBY_TABLE,
  SWIFT_SOURCE,
  SWIFT_TABLE,
};
