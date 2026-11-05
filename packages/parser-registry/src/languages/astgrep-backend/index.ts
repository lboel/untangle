/**
 * Oeffentliche Einstiegspunkte des ast-grep-Backends.
 *
 * WELCHE SPRACHE UEBER WELCHEN WEG LAEUFT, steht in `README.md` neben dieser
 * Datei — mit der Messung, auf der die Aufteilung beruht.
 */
import type { LanguageAdapter } from "@untangle-code/domain";

import { createAstGrepAdapter } from "./adapter.js";
import { AST_GREP_LANGUAGES } from "./lang/index.js";
import { GO_SOURCE, GO_TABLE, RUST_SOURCE, RUST_TABLE } from "./languages.js";

export { createAstGrepAdapter, MAX_ASTGREP_SOURCE_BYTES } from "./adapter.js";
export type { AstGrepAdapterHooks, AstGrepLanguageSource } from "./adapter.js";
export { GO_SOURCE, GO_TABLE, RUST_SOURCE, RUST_TABLE } from "./languages.js";
export { AST_GREP_LANGUAGES } from "./lang/index.js";
export type { AstGrepLanguage } from "./lang/index.js";
export { astGrepLanguageStates, astGrepLanguageStatus } from "./napi.js";
export type { AstGrepLanguageStatus } from "./napi.js";

/** Go-Adapter ueber ast-grep (`@ast-grep/lang-go`). */
export function createGoAdapter(): LanguageAdapter {
  return createAstGrepAdapter(GO_TABLE, GO_SOURCE);
}

/** Rust-Adapter ueber ast-grep (`@ast-grep/lang-rust`). */
export function createRustAdapter(): LanguageAdapter {
  return createAstGrepAdapter(RUST_TABLE, RUST_SOURCE);
}

/**
 * Die WEITEREN Sprachen aus WP-86 (Java, C#, Ruby, PHP, Kotlin, C, C++, Swift,
 * Bash) — je eine Tabelle unter `lang/`, kein Motor.
 *
 * Sie kommen als LISTE und nicht als neun einzelne Fabriken, damit
 * `languages/index.ts` mit EINER Schleife auskommt: wer die zehnte Sprache
 * aufnimmt, schreibt eine Tabelle und eine Zeile in `lang/index.ts` — und
 * faesst weder diese Datei noch die Registrierung an.
 */
export function createBreadthAdapters(): LanguageAdapter[] {
  return AST_GREP_LANGUAGES.map((language) =>
    createAstGrepAdapter(language.table, language.source),
  );
}
