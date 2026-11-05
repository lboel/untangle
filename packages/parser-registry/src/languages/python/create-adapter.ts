/**
 * Der Python-`LanguageAdapter`: die Tabelle aus `table.ts` und die
 * Verfeinerung aus `profile.ts` durch das gemeinsame ast-grep-Backend.
 *
 * WAS HIER FRUEHER STAND (WP-239): dieselbe Datei verdrahtete einen eigenen
 * Tokenizer, einen eigenen rekursiven Abstiegsparser, einen eigenen AST und
 * einen eigenen Motor — 5.604 Zeilen, die es nur gab, weil eine Auftragsgrenze
 * das Aufnehmen einer Grammatik verbot. Sie sind ersatzlos entfallen; was
 * bleibt, ist `signature.ts` (reine Textnormalisierung, ohne AST) und die
 * Tabelle daneben.
 *
 * DIE PARSERVERSION HAT SICH GEAENDERT, und das steht in domain
 * `versions.ts`: Python laeuft ab jetzt unter `ASTGREP_PARSER_VERSION`. Ohne
 * diesen Wechsel lieferten die inhaltsadressierten Caches aus WP-100 nach dem
 * Backendwechsel stillschweigend Chunk-IDs und Fingerabdruecke der alten
 * AST-Form (E4).
 */
import type { LanguageAdapter } from "@untangle-code/domain";

import { createAstGrepAdapter } from "../astgrep-backend/index.js";

import { createPythonProfile } from "./profile.js";
import { PYTHON_SOURCE, PYTHON_TABLE } from "./table.js";

export function createPythonAdapter(): LanguageAdapter {
  return createAstGrepAdapter(PYTHON_TABLE, PYTHON_SOURCE, {
    profileForFile: createPythonProfile,
  });
}
